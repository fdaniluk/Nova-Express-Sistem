#!/usr/bin/env node
/**
 * test-tramos-cliente.js — tramos de peso propios por cliente.
 *
 * Contexto (12/08/2026). Toda la tarifa de un cliente —la de porcentaje y la de precio por
 * kilo— se apoya en un juego de tramos de peso. Hasta ahora ese juego era global y fijo.
 * La oficina confirmó que la tarifa de PIO ALVAREZ corta en los 32 kg y que NO se puede
 * cambiar, así que el juego pasó a ser por cliente.
 *
 * Lo que hay que probar, en orden de riesgo:
 *
 *  1. Que NO se haya roto nada. El cliente que no tiene tramos propios hereda los por
 *     defecto y cotiza exactamente igual que antes.
 *  2. Que la garantía siga en pie: un juego con huecos, con tramos pisados, sin arrancar
 *     en 0 o sin el último abierto tiene que ser RECHAZADO. Esa validación es lo único que
 *     impide que un peso quede sin precio o caiga en dos tramos a la vez.
 *  3. Que el juego propio se use de verdad al resolver el precio, tanto en porcentaje como
 *     en precio por kilo.
 *  4. Que no se pueda cambiar el juego dejando precios huérfanos: si hay filas cargadas en
 *     un "desde" que el juego nuevo no contempla, se rechaza y se dice cuáles. Un precio
 *     que se cobra y no se ve es lo que estamos evitando.
 *  5. Que el caso real de PIO ALVAREZ funcione, incluido el hueco de 32 a 32,5 que hoy
 *     tiene y que los tramos continuos tapan.
 *
 *   cd backend && npm run test-tramos
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DB_PROD = path.join(ROOT, 'database', 'nova.db');
const DB_TEST = '/tmp/test_tramos_cliente.db';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}

// Los -wal/-shm tienen que morir con la base: si sobreviven de una corrida anterior,
// SQLite los reproduce sobre la copia nueva y aparecen filas fantasma (ya nos pasó).
for (const f of [DB_TEST, DB_TEST + '-wal', DB_TEST + '-shm']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
fs.copyFileSync(DB_PROD, DB_TEST);
process.env.DB_PATH = DB_TEST;

// Devuelve el mensaje de error de una llamada que TIENE que fallar, o null si no falló.
async function elError(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

(async () => {
  const { initDb, getDb, closeDb } = require('../src/db');
  await initDb();
  const db = getDb();
  const P = require('../src/services/profit.service');

  // ── 1. La migración no toca a nadie ────────────────────────────────────────
  console.log('\n1. La migración no le cambia el precio a nadie\n');

  const cols = (await db.prepare('PRAGMA table_info(cliente_tramos)').all()).map((c) => c.name);
  check('la tabla cliente_tramos existe', cols.length > 0, JSON.stringify(cols));
  check('tiene cliente_id, peso_min y peso_max',
    ['cliente_id', 'peso_min', 'peso_max'].every((c) => cols.includes(c)), JSON.stringify(cols));

  const sinPropios = await db.prepare('SELECT COUNT(*) AS n FROM cliente_tramos').get();
  check('ningún cliente arranca con tramos propios: todos heredan', sinPropios.n === 0,
    `hay ${sinPropios.n} filas`);

  const cli = (await db.prepare('SELECT id FROM clientes ORDER BY id LIMIT 1').get()).id;
  const heredados = await P.obtenerTramosCliente(cli);
  check('un cliente sin tramos propios los hereda', heredados.propios === false);
  // ⚠️ Hereda los NUEVE de siempre, no los finos. El 12/08/2026 este bloque decía "once" y
  // pasaba en verde mientras el despliegue le cambiaba el precio a uno de cada diez envíos:
  // las filas cargadas están apoyadas en los nueve cortes viejos, y mover el juego heredado
  // las deja sin encontrar. Los finos se aplican por cliente, con `migrar-tramos.js`.
  // Ver `test-datos-viejos.js`.
  check('hereda los nueve tramos de siempre', heredados.tramos.length === 9,
    `son ${heredados.tramos.length}`);
  check('el último tramo queda abierto', heredados.tramos[8].max === null);
  check('el juego por defecto arranca en 0 y corta cada 5 hasta 30',
    heredados.tramos[0].min === 0 && heredados.tramos[1].min === 5 && heredados.tramos[6].min === 30);
  check('y arriba de 30 va de a diez, como están cargados los datos',
    heredados.tramos[6].max === 40 && heredados.tramos[7].min === 40 && heredados.tramos[7].max === 50);

  check('35 kg cae en el tramo 30-40 heredado',
    P.derivarBanda(35).min === 30 && P.derivarBanda(35).max === 40);
  check('37 kg también, que es el peso que rompió el 12/08',
    P.derivarBanda(37).min === 30 && P.derivarBanda(37).max === 40);
  check('50 kg todavía es el último cerrado', P.derivarBanda(50).min === 40 && P.derivarBanda(50).max === 50);
  check('50,01 kg cae en el abierto', P.derivarBanda(50.01).max === null);

  // Los finos existen como sugerencia: es lo que ofrece la pantalla y lo que arma la
  // migración, pero no se hereda solo.
  check('los tramos sugeridos son once, de 5 en 5 hasta 50', P.TRAMOS_SUGERIDOS.length === 11,
    `son ${P.TRAMOS_SUGERIDOS.length}`);
  check('en los sugeridos 37 kg sí cae en 35-40',
    P.derivarTramo(P.TRAMOS_SUGERIDOS, 37).min === 35 && P.derivarTramo(P.TRAMOS_SUGERIDOS, 37).max === 40);

  // ── 2. La garantía: qué juegos se rechazan ─────────────────────────────────
  console.log('\n2. Un juego que rompe la garantía se rechaza\n');

  const hueco = await elError(async () =>
    P.validarJuegoDeTramos([{ min: 0, max: 20 }, { min: 25, max: null }]));
  check('rechaza un juego con un hueco', hueco !== null && hueco.status === 400);
  check('y dice entre qué pesos está el hueco',
    hueco && /hueco entre 20 y 25/.test(hueco.message), hueco && hueco.message);

  const pisado = await elError(async () =>
    P.validarJuegoDeTramos([{ min: 0, max: 20 }, { min: 15, max: null }]));
  check('rechaza dos tramos que se pisan', pisado !== null && /se pisan/.test(pisado.message));

  const sinCero = await elError(async () =>
    P.validarJuegoDeTramos([{ min: 5, max: 20 }, { min: 20, max: null }]));
  check('rechaza un juego que no arranca en 0', sinCero !== null && /arrancar en 0/.test(sinCero.message));

  const sinAbierto = await elError(async () =>
    P.validarJuegoDeTramos([{ min: 0, max: 20 }, { min: 20, max: 32 }]));
  check('rechaza un juego sin tramo abierto al final',
    sinAbierto !== null && /abierto/.test(sinAbierto.message));

  const abiertoAlMedio = await elError(async () =>
    P.validarJuegoDeTramos([{ min: 0, max: null }, { min: 20, max: null }]));
  check('rechaza un tramo abierto que no es el último', abiertoAlMedio !== null);

  const vacio = await elError(async () => P.validarJuegoDeTramos([]));
  check('rechaza un juego vacío', vacio !== null);

  const alReves = await elError(async () =>
    P.validarJuegoDeTramos([{ min: 0, max: 20 }, { min: 20, max: 10 }]));
  check('rechaza un tramo cuyo "hasta" es menor que su "desde"', alReves !== null);

  const bueno = P.validarJuegoDeTramos([{ min: 20, max: 32 }, { min: 0, max: 20 }, { min: 32, max: null }]);
  check('acepta un juego válido y lo devuelve ordenado',
    bueno[0].min === 0 && bueno[1].min === 20 && bueno[2].min === 32);

  // ── 3. El juego propio se usa de verdad ────────────────────────────────────
  console.log('\n3. El juego propio manda al resolver el precio\n');

  const pio = (await db.prepare('SELECT id FROM clientes ORDER BY id LIMIT 1 OFFSET 1').get()).id;
  await P.guardarTramosCliente(pio, [{ min: 0, max: 20 }, { min: 20, max: 32 }, { min: 32, max: null }]);

  const suyos = await P.obtenerTramosCliente(pio);
  check('quedan guardados como propios', suyos.propios === true && suyos.tramos.length === 3);
  check('el cliente de al lado sigue heredando',
    (await P.obtenerTramosCliente(cli)).propios === false);

  const juego = (await P.obtenerTramos(pio));
  check('25 kg cae en su tramo 20-32, no en el 20-25 general',
    P.derivarTramo(juego, 25).min === 20 && P.derivarTramo(juego, 25).max === 32);
  check('32 kg todavía es del tramo 20-32', P.derivarTramo(juego, 32).max === 32);
  check('32,4 kg ya es del tramo abierto', P.derivarTramo(juego, 32.4).min === 32);

  // Este es el hueco real que hoy tiene PIO: 20-32 y 32,5+ dejan 32 a 32,5 sin cubrir, y
  // ese envío se cobra por porcentaje sin que nadie se entere. Con tramos continuos no
  // puede pasar: todo peso cae en exactamente un tramo.
  let sinTramo = 0;
  for (let kg = 0; kg <= 60; kg += 0.1) {
    const t = P.derivarTramo(juego, Number(kg.toFixed(2)));
    if (!t) sinTramo += 1;
  }
  check('ningún peso de 0 a 60 kg se queda sin tramo', sinTramo === 0, `${sinTramo} pesos sin tramo`);

  // Cargar un precio en un "desde" que NO es tramo del cliente tiene que fallar.
  const fueraDeTramo = await elError(async () =>
    P.upsertOverrideKg(pio, { servicio: 'UPS_EXP', tipo: 'export', zona: null, peso_min: 25, peso_max: 30, precio_kg: 7 }));
  check('rechaza cargar un precio en un tramo que este cliente no tiene',
    fueraDeTramo !== null && fueraDeTramo.status === 400, fueraDeTramo && fueraDeTramo.message);
  check('y le dice cuáles son los suyos',
    fueraDeTramo && /20/.test(fueraDeTramo.message), fueraDeTramo && fueraDeTramo.message);

  // Y cargarlo en uno que sí es suyo tiene que funcionar y resolver.
  await db.prepare("UPDATE clientes SET modo_tarifa = 'por_kg' WHERE id = ?").run(pio);
  await P.upsertOverrideKg(pio, {
    servicio: 'UPS_EXP', tipo: 'export', zona: null, peso_min: 20, peso_max: 32, precio_kg: 7.02,
  });
  await P.upsertOverrideKg(pio, {
    servicio: 'UPS_EXP', tipo: 'export', zona: null, peso_min: 32, peso_max: null, precio_kg: 4.86,
  });

  const a25 = await P.resolverTarifaVenta({ clienteId: pio, servicio: 'UPS_EXP', tipo: 'export', zona: 2, pesoFacturable: 25 });
  check('un envío de 25 kg cobra 7,02 el kilo', a25.modo === 'por_kg' && a25.precioKg === 7.02,
    JSON.stringify(a25));
  const a35 = await P.resolverTarifaVenta({ clienteId: pio, servicio: 'UPS_EXP', tipo: 'export', zona: 2, pesoFacturable: 35 });
  check('un envío de 35 kg cobra 4,86 el kilo', a35.precioKg === 4.86, JSON.stringify(a35));

  // El hueco tapado: 32,2 kg antes caía al porcentaje, ahora cobra el precio del tramo.
  const enElHueco = await P.resolverTarifaVenta({ clienteId: pio, servicio: 'UPS_EXP', tipo: 'export', zona: 2, pesoFacturable: 32.2 });
  check('un envío de 32,2 kg ya no cae al porcentaje: cobra 4,86',
    enElHueco.modo === 'por_kg' && enElHueco.precioKg === 4.86, JSON.stringify(enElHueco));

  // ── 4. No se puede dejar un precio huérfano ────────────────────────────────
  console.log('\n4. Cambiar los tramos no puede dejar precios cobrándose a escondidas\n');

  const huerfano = await elError(async () => P.guardarTramosCliente(pio, [
    { min: 0, max: 25 }, { min: 25, max: null },
  ]));
  check('rechaza el cambio si deja precios sin tramo', huerfano !== null && huerfano.status === 409,
    huerfano && huerfano.message);
  // Nombra el TRAMO ENTERO, no solo el "desde". Mirar únicamente el "desde" es lo que dejó
  // pasar el 12/08 una fila de 30 a 40 hacia un juego que solo llegaba hasta 35: el 30
  // coincidía, y los envíos de 35 a 40 kg se quedaban sin precio en silencio.
  check('y dice exactamente qué tramos quedan sin lugar, con sus dos puntas',
    huerfano && Array.isArray(huerfano.huerfanos) && huerfano.huerfanos.includes('20-32'),
    huerfano && JSON.stringify(huerfano.huerfanos));

  const siguenLosDeAntes = await P.obtenerTramosCliente(pio);
  check('y no toca nada: el juego queda como estaba', siguenLosDeAntes.tramos.length === 3);

  const igual = await P.resolverTarifaVenta({ clienteId: pio, servicio: 'UPS_EXP', tipo: 'export', zona: 2, pesoFacturable: 25 });
  check('el precio sigue siendo el mismo después del rechazo', igual.precioKg === 7.02);

  // Borrando los precios primero, el cambio pasa.
  await P.eliminarOverrideKg(pio, { servicio: 'UPS_EXP', tipo: 'export', zona: null, peso_min: 20, peso_max: 32 });
  await P.eliminarOverrideKg(pio, { servicio: 'UPS_EXP', tipo: 'export', zona: null, peso_min: 32, peso_max: null });
  const ahoraSi = await P.guardarTramosCliente(pio, [{ min: 0, max: 25 }, { min: 25, max: null }]);
  check('borrando los precios primero, el cambio se acepta', ahoraSi.tramos.length === 2);

  // ── 5. Volver al juego por defecto ─────────────────────────────────────────
  console.log('\n5. Volver atrás\n');

  const vuelta = await P.guardarTramosCliente(pio, []);
  check('mandar una lista vacía devuelve al cliente a los tramos generales',
    vuelta.propios === false && vuelta.tramos.length === 9);
  const quedan = await db.prepare('SELECT COUNT(*) AS n FROM cliente_tramos WHERE cliente_id = ?').get(pio);
  check('y no deja filas colgadas en la tabla', quedan.n === 0, `quedan ${quedan.n}`);

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await closeDb();
  // No se llama process.exit(): matar el proceso a mano mientras sqlite3 todavía tiene
  // cosas pendientes es lo que venía reventando en Windows. El timer con .unref() es la
  // red de seguridad: no sostiene el proceso, solo actúa si a los 3 s sigue en pie.
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
})().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
