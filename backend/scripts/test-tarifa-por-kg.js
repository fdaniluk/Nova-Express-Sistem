#!/usr/bin/env node
/**
 * test-tarifa-por-kg.js — clientes que cobran un precio fijo en USD por kilo en vez de un
 * porcentaje de ganancia, y clientes con fuel propio.
 *
 * Lo que hay que probar, en orden de riesgo:
 *
 *  1. Que NO se haya roto nada. Todos los clientes que ya existen quedan en modo
 *     'porcentaje' y tienen que cotizar EXACTAMENTE lo mismo que antes. Esto se mide
 *     contra la copia de la base de producción, no de palabra.
 *  2. Que el precio por kilo reemplace SOLO el flete: 6 kg a 5 USD el kilo = 30 USD de
 *     flete, y el fuel, el seguro y los recargos del courier se sigan cobrando igual.
 *  3. Que la precedencia sea la misma que la de la matriz de profit: celda > rango >
 *     zona > tabla.
 *  4. Que si el cliente está en modo por kilo pero le falta el rango para ese peso, NO
 *     cotice cero: cae al porcentaje y avisa.
 *  5. Que el fuel propio del cliente pise al de Configuración.
 *
 *   cd backend && npm run test-tarifa-kg
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DB_PROD = path.join(ROOT, 'database', 'nova.db');
const DB_TEST = '/tmp/test_tarifa_kg.db';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const cerca = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// La base de test es una copia de la de producción. Los -wal/-shm tienen que morir con
// ella: si sobreviven de una corrida anterior, SQLite los reproduce sobre la copia nueva
// y aparecen filas fantasma (ya nos pasó).
for (const f of [DB_TEST, DB_TEST + '-wal', DB_TEST + '-shm']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
fs.copyFileSync(DB_PROD, DB_TEST);
process.env.DB_PATH = DB_TEST;

const core = require('../../shared/cotizador/cotizador-core.js');

(async () => {
  const { initDb, getDb } = require('../src/db');
  await initDb();
  const db = getDb();
  const profitService = require('../src/services/profit.service');
  const { cotizarEnvio } = require('../src/services/calculos.service');

  // ── 1. La migración no toca a nadie ────────────────────────────────────────
  console.log('\n1. La migración deja a todos los clientes como estaban\n');

  const cols = (await db.prepare('PRAGMA table_info(clientes)').all()).map((c) => c.name);
  check('la columna modo_tarifa existe', cols.includes('modo_tarifa'));
  check('la columna fuel_pct_propio existe', cols.includes('fuel_pct_propio'));

  const tablas = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())
    .map((t) => t.name);
  check('la tabla tarifa_kg_overrides existe', tablas.includes('tarifa_kg_overrides'));

  const modos = await db
    .prepare("SELECT modo_tarifa AS m, COUNT(*) AS n FROM clientes GROUP BY modo_tarifa")
    .all();
  const todosPorcentaje = modos.length === 1 && modos[0].m === 'porcentaje';
  check('TODOS los clientes de producción quedaron en modo porcentaje', todosPorcentaje,
    JSON.stringify(modos));
  console.log(`      ${modos.map((m) => `${m.n} en "${m.m}"`).join(' · ')}`);

  const conFuelPropio = await db
    .prepare('SELECT COUNT(*) AS n FROM clientes WHERE fuel_pct_propio IS NOT NULL')
    .get();
  check('ningún cliente quedó con fuel propio por accidente', conFuelPropio.n === 0,
    `${conFuelPropio.n}`);

  // ── 2. Nada cambia de precio para los clientes de siempre ──────────────────
  console.log('\n2. Un cliente en modo porcentaje cotiza igual que antes\n');

  const clienteNormal = await db
    .prepare('SELECT id, nombre, tarifa_pct FROM clientes WHERE activo = 1 ORDER BY id LIMIT 1')
    .get();
  check('hay un cliente de producción para probar', !!clienteNormal,
    clienteNormal ? clienteNormal.nombre : '-');

  const paramsBase = {
    pais: 'Estados Unidos', tipo: 'export', servicio: 'UPS_EXP',
    pesoFacturable: 6, fob: 0, fuelPct: 39.5,
    bultos: [{ pesoReal: 6, largo: 30, ancho: 20, alto: 10 }],
  };

  // El resolvedor nuevo tiene que devolver lo mismo que el viejo para estos clientes.
  const viejo = await profitService.resolverProfit({
    clienteId: clienteNormal.id, servicio: 'UPS_EXP', tipo: 'export', zona: 1, pesoFacturable: 6,
  });
  const nuevo = await profitService.resolverTarifaVenta({
    clienteId: clienteNormal.id, servicio: 'UPS_EXP', tipo: 'export', zona: 1, pesoFacturable: 6,
  });
  check('resolverTarifaVenta devuelve el mismo profit que resolverProfit',
    nuevo.profitPct === viejo.profitPct && nuevo.origen === viejo.origen,
    `viejo=${JSON.stringify(viejo)} nuevo=${JSON.stringify(nuevo)}`);
  check('y lo marca como modo porcentaje, sin precio por kilo',
    nuevo.modo === 'porcentaje' && nuevo.precioKg === null, JSON.stringify(nuevo));

  // Sin precioKgVenta el motor tiene que dar EXACTAMENTE lo mismo que sin el parámetro.
  const sinParam = cotizarEnvio({ ...paramsBase, profitPct: 25 });
  const conNull  = cotizarEnvio({ ...paramsBase, profitPct: 25, precioKgVenta: null });
  const conCero  = cotizarEnvio({ ...paramsBase, profitPct: 25, precioKgVenta: 0 });
  check('pasar precioKgVenta null no cambia el total',
    sinParam.precioFinal === conNull.precioFinal, `${sinParam.precioFinal} vs ${conNull.precioFinal}`);
  check('pasar precioKgVenta 0 tampoco (0 no es una tarifa, es "no tiene")',
    sinParam.precioFinal === conCero.precioFinal, `${sinParam.precioFinal} vs ${conCero.precioFinal}`);
  console.log(`      total de referencia: USD ${sinParam.precioFinal}`);

  // ── 3. El precio por kilo reemplaza SOLO el flete ──────────────────────────
  console.log('\n3. El precio por kilo reemplaza el flete y nada más\n');

  const comun = {
    pais: 'Estados Unidos', tipo: 'export', pf: 6, fob: 0, fuelPct: 39.5,
    bultosProc: [{ dims: [30, 20, 10], pr: 6, pf: 6 }],
  };
  const alCosto = core.cotizarServicio('UPS_EXP', { ...comun, profitPct: 0 });
  const porKg   = core.cotizarServicio('UPS_EXP', { ...comun, profitPct: 0, precioKgVenta: 5 });

  check('el flete de venta es peso × precio por kilo (6 × 5 = 30)',
    cerca(porKg.conGan, 30), `conGan=${porKg.conGan}`);
  check('el porcentaje de ganancia se ignora', (() => {
    const conProfit = core.cotizarServicio('UPS_EXP', { ...comun, profitPct: 120, precioKgVenta: 5 });
    return cerca(conProfit.total, porKg.total);
  })(), 'un profit de 120% no debería mover nada');
  check('el surge del courier se sigue cobrando igual',
    porKg.surge === alCosto.surge, `${porKg.surge} vs ${alCosto.surge}`);
  check('los extras (manejo, seguro, zona) se siguen cobrando igual',
    cerca(porKg.extrasTotal, alCosto.extrasTotal), `${porKg.extrasTotal} vs ${alCosto.extrasTotal}`);
  check('el fuel se calcula sobre el flete vendido más el surge',
    cerca(porKg.fuelMonto, (porKg.conGan + porKg.surge) * 0.395),
    `fuel=${porKg.fuelMonto}`);
  check('el total cierra: flete + surge + fuel + extras',
    cerca(porKg.total, porKg.conGan + porKg.surge + porKg.fuelMonto + porKg.extrasTotal),
    `${porKg.total}`);
  check('el resultado se marca como modo por_kg', porKg.modoVenta === 'por_kg', porKg.modoVenta);
  console.log(`      al costo USD ${alCosto.total.toFixed(2)} · por kilo USD ${porKg.total.toFixed(2)}`);

  // DHL usa el peso facturable crudo; UPS el que factura (redondeado a 0,5).
  const dhlKg = core.cotizarServicio('DHL', { ...comun, pf: 6.2, profitPct: 0, precioKgVenta: 5 });
  check('DHL cobra por el peso facturable real (6.2 × 5 = 31)',
    cerca(dhlKg.conGan, 31), `conGan=${dhlKg.conGan}`);
  const upsKg = core.cotizarServicio('UPS_EXP', { ...comun, pf: 6.2, profitPct: 0, precioKgVenta: 5 });
  check('UPS cobra por los kilos que factura el courier (6.5 × 5 = 32.5)',
    cerca(upsKg.conGan, 32.5), `conGan=${upsKg.conGan} pf=${upsKg.pf}`);

  // La utilidad que se guarda tiene que ser lo vendido menos lo que cuesta.
  const envioKg = cotizarEnvio({ ...paramsBase, profitPct: 0, precioKgVenta: 5 });
  check('la utilidad es la diferencia entre el flete vendido y el costo',
    cerca(envioKg.utilidad, (porKg.conGan - porKg.fleteBase) * 1.395),
    `utilidad=${envioKg.utilidad}`);
  check('el precio base (costo) sigue siendo el mismo que a profit 0',
    cerca(envioKg.precioFinal - envioKg.utilidad, envioKg.precioBase),
    `${envioKg.precioBase}`);

  // Una tarifa por kilo POR DEBAJO del costo tiene que dar utilidad negativa, no cero.
  const barato = cotizarEnvio({ ...paramsBase, profitPct: 0, precioKgVenta: 0.5 });
  check('si el precio por kilo no cubre el costo, la utilidad da negativa',
    barato.utilidad < 0, `utilidad=${barato.utilidad}`);

  // ── 4. Precedencia: celda > rango > zona > tabla ───────────────────────────
  console.log('\n4. Precedencia de la tarifa por kilo\n');

  const cli = clienteNormal.id;
  await db.prepare('DELETE FROM tarifa_kg_overrides WHERE cliente_id = ?').run(cli);
  await db.prepare("UPDATE clientes SET modo_tarifa = 'por_kg' WHERE id = ?").run(cli);

  const guardar = (zona, min, max, precio) =>
    profitService.upsertOverrideKg(cli, {
      servicio: 'UPS_EXP', tipo: 'export', zona, peso_min: min, peso_max: max, precio_kg: precio,
    });
  const resolver = (zona, pf) =>
    profitService.resolverTarifaKg({ clienteId: cli, servicio: 'UPS_EXP', tipo: 'export', zona, pesoFacturable: pf });

  await guardar(null, null, null, 9);
  check('sin nada más específico manda el general de la tabla',
    (await resolver(1, 6)).precioKg === 9);

  await guardar(1, null, null, 8);
  check('la zona le gana al general', (await resolver(1, 6)).precioKg === 8);
  check('y no afecta a las otras zonas', (await resolver(2, 6)).precioKg === 9);

  await guardar(null, 1, 10, 5);
  check('el rango de peso le gana a la zona', (await resolver(1, 6)).precioKg === 5);
  check('fuera del rango sigue mandando la zona', (await resolver(1, 30)).precioKg === 8);

  await guardar(1, 1, 10, 4);
  check('la celda (zona + rango) le gana a todo', (await resolver(1, 6)).precioKg === 4);
  check('otra zona en el mismo rango usa el rango general', (await resolver(3, 6)).precioKg === 5);

  // Bordes del rango: los dos límites son inclusivos.
  check('el límite de abajo entra en el rango', (await resolver(1, 1)).precioKg === 4);
  check('el límite de arriba entra en el rango', (await resolver(1, 10)).precioKg === 4);
  check('un kilo más ya sale del rango', (await resolver(1, 10.5)).precioKg === 8);

  // Rango sin tope.
  await guardar(null, 100, null, 2);
  check('un rango sin tope aplica de ahí en adelante', (await resolver(4, 5000)).precioKg === 2);

  // ── 5. Si falta el rango NO cotiza cero ────────────────────────────────────
  console.log('\n5. Un agujero en la tabla no puede cotizar cero\n');

  await db.prepare('DELETE FROM tarifa_kg_overrides WHERE cliente_id = ?').run(cli);
  await guardar(null, 1, 10, 5);   // solo de 1 a 10 kg

  const dentro = await profitService.resolverTarifaVenta({
    clienteId: cli, servicio: 'UPS_EXP', tipo: 'export', zona: 1, pesoFacturable: 6,
  });
  check('adentro del rango cotiza por kilo', dentro.modo === 'por_kg' && dentro.precioKg === 5,
    JSON.stringify(dentro));
  check('y sin advertencia', dentro.advertencia === null);

  const afuera = await profitService.resolverTarifaVenta({
    clienteId: cli, servicio: 'UPS_EXP', tipo: 'export', zona: 1, pesoFacturable: 60,
  });
  check('afuera del rango vuelve al porcentaje, no a cero', afuera.modo === 'porcentaje',
    JSON.stringify(afuera));
  check('y deja una advertencia para que se vea', !!afuera.advertencia, String(afuera.advertencia));
  console.log(`      aviso: ${afuera.advertencia}`);

  // Otra tabla del mismo cliente (DHL) que no tiene NADA cargado: mismo comportamiento.
  const otraTabla = await profitService.resolverTarifaVenta({
    clienteId: cli, servicio: 'DHL', tipo: 'export', zona: 1, pesoFacturable: 6,
  });
  check('una tabla sin cargar tampoco cotiza cero', otraTabla.modo === 'porcentaje',
    JSON.stringify(otraTabla));

  // ── 6. Fuel propio del cliente ─────────────────────────────────────────────
  console.log('\n6. Fuel propio del cliente\n');

  check('sin fuel propio devuelve null (usa el de Configuración)',
    (await profitService.resolverFuelPropio(cli)) === null);

  const clienteModel = require('../src/models/cliente.model');
  await clienteModel.actualizar(cli, { fuel_pct_propio: 25 });
  check('se guarda el fuel propio', (await profitService.resolverFuelPropio(cli)) === 25);

  const conFuelCfg  = cotizarEnvio({ ...paramsBase, profitPct: 25, fuelPct: 39.5 });
  const conFuelCli  = cotizarEnvio({ ...paramsBase, profitPct: 25, fuelPct: 25 });
  check('un fuel más bajo da un total más bajo', conFuelCli.precioFinal < conFuelCfg.precioFinal,
    `${conFuelCli.precioFinal} vs ${conFuelCfg.precioFinal}`);

  await clienteModel.actualizar(cli, { fuel_pct_propio: null });
  check('se puede borrar el fuel propio y volver al de Configuración',
    (await profitService.resolverFuelPropio(cli)) === null);

  let rechazado = false;
  try { await clienteModel.actualizar(cli, { fuel_pct_propio: -5 }); }
  catch (e) { rechazado = e.status === 400; }
  check('un fuel negativo se rechaza con 400', rechazado);

  let modoMalo = false;
  try { await clienteModel.actualizar(cli, { modo_tarifa: 'inventado' }); }
  catch (e) { modoMalo = e.status === 400; }
  check('un modo_tarifa inventado se rechaza con 400', modoMalo);

  // ── 7. Validaciones de la carga ────────────────────────────────────────────
  console.log('\n7. Validaciones al cargar una tarifa\n');

  const rechaza = async (body, motivo) => {
    try { await profitService.upsertOverrideKg(cli, body); return false; }
    catch (e) { return e.status === 400; }
  };
  check('no acepta un "hasta" menor que el "desde"',
    await rechaza({ servicio: 'UPS_EXP', tipo: 'export', zona: null, peso_min: 10, peso_max: 5, precio_kg: 3 }));
  check('no acepta un "hasta" sin "desde"',
    await rechaza({ servicio: 'UPS_EXP', tipo: 'export', zona: null, peso_min: null, peso_max: 10, precio_kg: 3 }));
  check('no acepta un precio por kilo vacío',
    await rechaza({ servicio: 'UPS_EXP', tipo: 'export', zona: null, peso_min: 1, peso_max: 10, precio_kg: '' }));
  check('no acepta un servicio inventado',
    await rechaza({ servicio: 'FEDEX', tipo: 'export', zona: null, peso_min: 1, peso_max: 10, precio_kg: 3 }));
  check('no acepta una zona fuera de 1..6',
    await rechaza({ servicio: 'UPS_EXP', tipo: 'export', zona: 9, peso_min: 1, peso_max: 10, precio_kg: 3 }));

  // Volver a guardar las mismas coordenadas PISA, no duplica.
  await profitService.upsertOverrideKg(cli, {
    servicio: 'UPS_EXP', tipo: 'export', zona: null, peso_min: 1, peso_max: 10, precio_kg: 7,
  });
  const filas = await db
    .prepare('SELECT COUNT(*) AS n FROM tarifa_kg_overrides WHERE cliente_id = ? AND peso_min = 1')
    .get(cli);
  check('volver a guardar el mismo rango lo pisa en vez de duplicarlo', filas.n === 1, `${filas.n}`);
  check('y queda el valor nuevo',
    (await profitService.resolverTarifaKg({ clienteId: cli, servicio: 'UPS_EXP', tipo: 'export', zona: 5, pesoFacturable: 6 })).precioKg === 7);

  // ── 8. La matriz que ve la pantalla ────────────────────────────────────────
  console.log('\n8. La matriz que lee la pantalla de perfil\n');

  const matriz = await profitService.obtenerMatrizKg(cli, 'UPS_EXP', 'export');
  check('devuelve los overrides cargados', matriz.overrides.length > 0, `${matriz.overrides.length}`);
  check('cada override viene con su nivel', matriz.overrides.every((o) => o.nivel), '');
  check('los valores vienen como precio_kg, no como profit_pct',
    matriz.overrides.every((o) => o.precio_kg !== undefined && o.profit_pct === undefined));

  const borro = await profitService.eliminarOverrideKg(cli, {
    servicio: 'UPS_EXP', tipo: 'export', zona: null, peso_min: 1, peso_max: 10,
  });
  check('se puede borrar un rango', borro === true);
  check('y después ya no está',
    (await profitService.obtenerMatrizKg(cli, 'UPS_EXP', 'export')).overrides
      .filter((o) => o.peso_min === 1).length === 0);

  // ── 9. La matriz de profit no se tocó ──────────────────────────────────────
  console.log('\n9. La matriz de profit de siempre sigue intacta\n');

  // Se deja una tarifa por kilo cargada y se vuelve el cliente a porcentaje: cambiar de
  // modo no puede borrar lo cargado (la oficina tiene que poder ir y volver).
  await profitService.upsertOverrideKg(cli, {
    servicio: 'UPS_EXP', tipo: 'export', zona: null, peso_min: 1, peso_max: 10, precio_kg: 6,
  });
  await db.prepare("UPDATE clientes SET modo_tarifa = 'porcentaje' WHERE id = ?").run(cli);
  const despues = await profitService.resolverTarifaVenta({
    clienteId: cli, servicio: 'UPS_EXP', tipo: 'export', zona: 1, pesoFacturable: 6,
  });
  check('al volver a modo porcentaje cotiza igual que al principio',
    despues.profitPct === viejo.profitPct && despues.origen === viejo.origen,
    `${JSON.stringify(despues)} vs ${JSON.stringify(viejo)}`);
  check('las tarifas por kilo quedaron guardadas por si vuelve al otro modo',
    (await db.prepare('SELECT COUNT(*) AS n FROM tarifa_kg_overrides WHERE cliente_id = ?').get(cli)).n > 0);

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
