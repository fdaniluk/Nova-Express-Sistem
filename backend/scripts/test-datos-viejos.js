#!/usr/bin/env node
/**
 * test-datos-viejos.js — DATOS VIEJOS CON CÓDIGO NUEVO.
 *
 * POR QUÉ EXISTE
 * El 12/08/2026 se desplegó un cambio que movió los tramos de peso por defecto de nueve a
 * once: 30-40 se partió en 30-35 y 35-40, y 40-50 en 40-45 y 45-50. Los 791 controles
 * estaban en verde. Igual cambió el precio de uno de cada diez envíos.
 *
 * El motivo: todos los tests cargan sus tarifas sobre los tramos que el código tiene HOY.
 * Los datos de producción están cargados sobre los tramos que el código tenía AYER. Hay
 * filas con peso_min 30 y 40, y ninguna con 35 ni con 45. Un envío de 37 kg pasó a derivar
 * el tramo 35-40, no encontró fila, y se cayó al porcentaje general del cliente: donde
 * decía 70% empezó a decir 50%. El número que sale sigue siendo creíble, que es lo peor.
 *
 * Ningún test podía verlo, porque ninguno probaba la combinación que rompe:
 * DATOS CARGADOS ANTES + CÓDIGO DE AHORA.
 *
 * QUÉ PRUEBA
 * Se carga la matriz tal como está en producción —apoyada en los nueve cortes de siempre—
 * y se le pregunta el precio al motor de hoy, peso por peso. Si alguno pierde su celda, o
 * cambia de valor, este test falla.
 *
 * QUÉ HACER SI FALLA
 * NO cambiar el test para que pase. Que falle significa que un despliegue le va a cambiar
 * el precio a clientes reales sin que nadie corra una migración. El juego de tramos POR
 * DEFECTO tiene que seguir siendo el que usan los datos; los tramos finos se le ponen a
 * cada cliente con `node scripts/migrar-tramos.js --aplicar`, que informa antes de tocar.
 *
 *   cd backend && npm run test-datos-viejos
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DB_PROD = path.join(ROOT, 'database', 'nova.db');
const DB_TEST = '/tmp/test_datos_viejos.db';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}

for (const f of [DB_TEST, DB_TEST + '-wal', DB_TEST + '-shm']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
fs.copyFileSync(DB_PROD, DB_TEST);
process.env.DB_PATH = DB_TEST;

// ⚠️ ESTA LISTA NO SE TOCA.
// Son los cortes sobre los que están cargadas las 317 filas de producción, congelados a
// propósito. No se importan de profit.service: si se importaran, el test seguiría a
// cualquier cambio del código y dejaría de proteger nada. La gracia es justamente que
// sean dos fuentes distintas y que tengan que coincidir.
const CORTES_DE_LOS_DATOS = [0, 5, 10, 15, 20, 25, 30, 40, 50];

// Un porcentaje distinto por banda, para poder distinguir de cuál salió cada respuesta.
const MATRIZ_VIEJA = [
  { min: 0, max: 5, pct: 100, kg: 12.5 },
  { min: 5, max: 10, pct: 95, kg: 11 },
  { min: 10, max: 15, pct: 90, kg: 9.75 },
  { min: 15, max: 20, pct: 85, kg: 8.4 },
  { min: 20, max: 25, pct: 80, kg: 7.02 },
  { min: 25, max: 30, pct: 75, kg: 6.3 },
  { min: 30, max: 40, pct: 70, kg: 5.55 },
  { min: 40, max: 50, pct: 65, kg: 4.86 },
  { min: 50, max: null, pct: 60, kg: 4.32 },
];

// La banda de la matriz vieja que le toca a un peso, con el criterio de siempre:
// límite de abajo exclusivo, de arriba inclusivo, salvo el primero que incluye el 0.
function bandaVieja(pf) {
  return MATRIZ_VIEJA.find((b) => (b.max === null
    ? pf > b.min
    : (b.min === 0 ? pf >= 0 && pf <= b.max : pf > b.min && pf <= b.max)));
}

(async () => {
  const { initDb, getDb, closeDb } = require('../src/db');
  await initDb();
  const db = getDb();
  const P = require('../src/services/profit.service');

  // ── 1. El juego por defecto es el que usan los datos ───────────────────────
  console.log('\n1. El juego por defecto tiene que ser el que usan los datos cargados\n');

  const porDefecto = P.TRAMOS_POR_DEFECTO.map((t) => t.min);
  check('los cortes por defecto son exactamente los de la matriz cargada',
    JSON.stringify(porDefecto) === JSON.stringify(CORTES_DE_LOS_DATOS),
    `por defecto ${JSON.stringify(porDefecto)} · datos ${JSON.stringify(CORTES_DE_LOS_DATOS)}`);
  check('el último tramo por defecto queda abierto',
    P.TRAMOS_POR_DEFECTO[P.TRAMOS_POR_DEFECTO.length - 1].max === null);

  // Los tramos finos existen, pero como SUGERENCIA: no se aplican solos.
  check('los tramos sugeridos son los de 5 en 5 hasta 50', P.TRAMOS_SUGERIDOS.length === 11,
    `son ${P.TRAMOS_SUGERIDOS.length}`);
  check('los sugeridos NO son los que se heredan',
    P.TRAMOS_SUGERIDOS.length !== P.TRAMOS_POR_DEFECTO.length);

  const conTramos = await db.prepare('SELECT COUNT(*) AS n FROM cliente_tramos').get();
  check('ningún cliente tiene tramos propios todavía: todos heredan', conTramos.n === 0,
    `hay ${conTramos.n} filas`);

  // ── 2. Cliente cargado como en producción: el porcentaje ───────────────────
  console.log('\n2. Matriz de porcentaje cargada sobre los cortes viejos\n');

  await db.prepare(
    "INSERT INTO clientes (nombre, tarifa_pct, tipo_cobro, modo_tarifa) VALUES (?, ?, 'CC', 'porcentaje')"
  ).run('DATOS VIEJOS PCT', 50);
  const cliPct = (await db.prepare('SELECT id FROM clientes WHERE nombre = ?').get('DATOS VIEJOS PCT')).id;

  for (const b of MATRIZ_VIEJA) {
    await db.prepare(
      `INSERT INTO profit_overrides (cliente_id, servicio, tipo, zona, peso_min, peso_max, profit_pct)
       VALUES (?, 'UPS_EXP', 'export', 2, ?, ?, ?)`
    ).run(cliPct, b.min, b.max, b.pct);
  }

  // Se barre de 0,1 en 0,1 hasta 60. Es barato y no deja rendijas.
  const perdidosPct = [];
  const distintosPct = [];
  for (let k = 1; k <= 600; k += 1) {
    const pf = Number((k / 10).toFixed(1));
    const r = await P.resolverProfit({
      clienteId: cliPct, servicio: 'UPS_EXP', tipo: 'export', zona: 2, pesoFacturable: pf,
    });
    if (r.origen !== 'celda') perdidosPct.push(pf);
    else if (r.profitPct !== bandaVieja(pf).pct) distintosPct.push({ pf, dio: r.profitPct, esperaba: bandaVieja(pf).pct });
  }

  check('ningún peso pierde su celda cargada', perdidosPct.length === 0,
    perdidosPct.length ? `${perdidosPct.length} pesos caen al general, el primero ${perdidosPct[0]} kg` : '');
  check('ningún peso cambia de porcentaje', distintosPct.length === 0,
    distintosPct.length ? `${distintosPct.length} pesos, p.ej. ${distintosPct[0].pf} kg dio ${distintosPct[0].dio}% y la fila dice ${distintosPct[0].esperaba}%` : '');

  // Los cuatro pesos que rompió el despliegue del 12/08, nombrados uno por uno para que el
  // día que vuelvan a fallar se lea en el renglón cuál es.
  for (const pf of [32, 37, 42, 47]) {
    const r = await P.resolverProfit({
      clienteId: cliPct, servicio: 'UPS_EXP', tipo: 'export', zona: 2, pesoFacturable: pf,
    });
    check(`${pf} kg sigue saliendo de su celda (${bandaVieja(pf).pct}%)`,
      r.origen === 'celda' && r.profitPct === bandaVieja(pf).pct,
      `dio ${r.profitPct}% desde "${r.origen}"`);
  }

  // ── 3. Lo mismo con la tarifa por kilo ─────────────────────────────────────
  console.log('\n3. Matriz de precio por kilo cargada sobre los cortes viejos\n');

  await db.prepare(
    "INSERT INTO clientes (nombre, tarifa_pct, tipo_cobro, modo_tarifa) VALUES (?, ?, 'CC', 'por_kg')"
  ).run('DATOS VIEJOS KG', 50);
  const cliKg = (await db.prepare('SELECT id FROM clientes WHERE nombre = ?').get('DATOS VIEJOS KG')).id;

  for (const b of MATRIZ_VIEJA) {
    await db.prepare(
      `INSERT INTO tarifa_kg_overrides (cliente_id, servicio, tipo, zona, peso_min, peso_max, precio_kg)
       VALUES (?, 'UPS_EXP', 'export', 2, ?, ?, ?)`
    ).run(cliKg, b.min, b.max, b.kg);
  }

  const perdidosKg = [];
  const distintosKg = [];
  for (let k = 1; k <= 600; k += 1) {
    const pf = Number((k / 10).toFixed(1));
    const r = await P.resolverTarifaKg({
      clienteId: cliKg, servicio: 'UPS_EXP', tipo: 'export', zona: 2, pesoFacturable: pf,
    });
    if (!r) perdidosKg.push(pf);
    else if (r.precioKg !== bandaVieja(pf).kg) distintosKg.push({ pf, dio: r.precioKg, esperaba: bandaVieja(pf).kg });
  }

  check('ningún peso se queda sin precio por kilo', perdidosKg.length === 0,
    perdidosKg.length ? `${perdidosKg.length} pesos, el primero ${perdidosKg[0]} kg` : '');
  check('ningún peso cambia de precio por kilo', distintosKg.length === 0,
    distintosKg.length ? `${distintosKg.length} pesos, p.ej. ${distintosKg[0].pf} kg dio USD ${distintosKg[0].dio} y la fila dice USD ${distintosKg[0].esperaba}` : '');

  for (const pf of [32, 37, 42, 47]) {
    const r = await P.resolverTarifaKg({
      clienteId: cliKg, servicio: 'UPS_EXP', tipo: 'export', zona: 2, pesoFacturable: pf,
    });
    check(`${pf} kg sigue costando USD ${bandaVieja(pf).kg} el kilo`,
      !!r && r.precioKg === bandaVieja(pf).kg,
      r ? `dio USD ${r.precioKg}` : 'no encontró precio');
  }

  // ── 4. Un cliente con tramos propios sí puede tener los finos ──────────────
  console.log('\n4. Los tramos finos se aplican por cliente, no por despliegue\n');

  await P.guardarTramosCliente(cliPct, P.TRAMOS_SUGERIDOS.map((t) => ({ min: t.min, max: t.max })))
    .then(() => check('un cliente con precios cargados en 30 y 40 NO puede pasar a los finos sin migrar', false,
      'lo aceptó, y deja los precios de 30-40 y 40-50 sin tramo'))
    .catch((e) => check('un cliente con precios cargados en 30 y 40 NO puede pasar a los finos sin migrar',
      e.status === 409, `dio ${e.status}: ${e.message}`));

  // Sin precios cargados, cambiar el juego es libre.
  await db.prepare('DELETE FROM profit_overrides WHERE cliente_id = ?').run(cliPct);
  const finos = await P.guardarTramosCliente(cliPct, P.TRAMOS_SUGERIDOS.map((t) => ({ min: t.min, max: t.max })));
  check('sin precios cargados, el cliente pasa a los once tramos finos',
    finos.propios === true && finos.tramos.length === 11, `son ${finos.tramos.length}`);
  check('y ahora 37 kg sí cae en 35-40 para ESE cliente',
    P.derivarTramo(finos.tramos, 37).min === 35 && P.derivarTramo(finos.tramos, 37).max === 40);

  const otro = await P.obtenerTramosCliente(cliKg);
  check('mientras que el otro cliente sigue con los nueve de siempre',
    otro.propios === false && otro.tramos.length === 9, `son ${otro.tramos.length}`);

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await closeDb();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
})().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
