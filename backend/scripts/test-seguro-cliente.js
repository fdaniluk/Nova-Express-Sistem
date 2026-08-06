#!/usr/bin/env node
/**
 * test-seguro-cliente.js — clientes con un seguro negociado propio.
 *
 * Contexto: la escala de seguro estaba hardcodeada en el motor y era la misma para todos
 * (UPS 0 / USD 15 fijo / 1,5% · DHL el mayor entre 17,50 y 1,5%). Hay clientes que tienen
 * otro porcentaje negociado —1% en Gianastasio y Cueros— y el piso tampoco es el mismo
 * para todos, así que ahora van los dos por cliente: seguro_pct_propio y seguro_min_propio.
 *
 * Lo que hay que probar, en orden de riesgo:
 *
 *  1. Que NO se haya roto nada: sin seguro propio, los dos couriers cobran exactamente lo
 *     mismo que antes. Es lo único que toca a los 91 clientes.
 *  2. Que el seguro propio reemplace la escala ENTERA en DHL y en UPS por igual: sin el
 *     escalón de USD 15 y sin el mínimo de 17,50.
 *  3. Que el mínimo propio funcione y que se pueda no tener mínimo.
 *  4. Que el seguro propio NO toque nada más del envío: flete, fuel, surge y recargos
 *     quedan iguales. El seguro es un extra, no entra en el margen.
 *  5. Que un mínimo sin porcentaje se ignore (no define ninguna regla).
 *  6. Que el resolvedor lea bien la base y que se pueda borrar para volver al courier.
 *
 *   cd backend && npm run test-seguro-cliente
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DB_PROD = path.join(ROOT, 'database', 'nova.db');
const DB_TEST = '/tmp/test_seguro_cliente.db';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const cerca = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

for (const f of [DB_TEST, DB_TEST + '-wal', DB_TEST + '-shm']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
fs.copyFileSync(DB_PROD, DB_TEST);
process.env.DB_PATH = DB_TEST;

const core = require('../../shared/cotizador/cotizador-core.js');
const { calcSeguroUPS, calcSeguroDHL, cotizarServicio } = core;
const db = require('../src/db');
const profitService = require('../src/services/profit.service');
const clienteModel = require('../src/models/cliente.model');

async function main() {
  console.log('\n1. Sin seguro propio no cambia NADA (los 91 clientes de hoy)\n');

  // Los valores de referencia son los que tenía el motor antes de esta migración.
  const antesUPS = [[0, 0], [50, 0], [99.99, 0], [100, 15], [1000, 15], [2000, 30]];
  for (const [valor, esperado] of antesUPS) {
    check(`UPS con valor ${valor} sigue cobrando ${esperado}`,
      cerca(calcSeguroUPS(valor).monto, esperado),
      `dio ${calcSeguroUPS(valor).monto}`);
  }
  const antesDHL = [[0, 0], [100, 17.5], [1000, 17.5], [1166.67, 17.5], [2000, 30]];
  for (const [valor, esperado] of antesDHL) {
    check(`DHL con valor ${valor} sigue cobrando ${esperado}`,
      cerca(calcSeguroDHL(valor).monto, esperado),
      `dio ${calcSeguroDHL(valor).monto}`);
  }
  check('pasar null como seguro propio es lo mismo que no pasar nada',
    calcSeguroUPS(500, null).monto === calcSeguroUPS(500).monto &&
    calcSeguroDHL(500, null).monto === calcSeguroDHL(500).monto);

  console.log('\n2. Con seguro propio manda el del cliente, en los dos couriers\n');

  const unoPorCiento = { pct: 1, min: 10 };
  // 1% de 2.000 = 20, arriba del mínimo de 10.
  check('UPS: 1% de USD 2.000 = USD 20 (antes cobraba 30)',
    cerca(calcSeguroUPS(2000, unoPorCiento).monto, 20));
  check('DHL: 1% de USD 2.000 = USD 20 (antes cobraba 30)',
    cerca(calcSeguroDHL(2000, unoPorCiento).monto, 20));
  check('los dos couriers dan el MISMO seguro con seguro propio',
    calcSeguroUPS(2000, unoPorCiento).monto === calcSeguroDHL(2000, unoPorCiento).monto);

  check('UPS: se cae el escalón de USD 15 (valor 500 → 10, no 15)',
    cerca(calcSeguroUPS(500, unoPorCiento).monto, 10),
    `dio ${calcSeguroUPS(500, unoPorCiento).monto}`);
  check('DHL: se cae el mínimo de 17,50 (valor 500 → 10, no 17,50)',
    cerca(calcSeguroDHL(500, unoPorCiento).monto, 10),
    `dio ${calcSeguroDHL(500, unoPorCiento).monto}`);
  check('UPS: abajo de USD 100 ahora sí paga el mínimo (valor 50 → 10, antes 0)',
    cerca(calcSeguroUPS(50, unoPorCiento).monto, 10));

  console.log('\n3. El mínimo\n');

  check('el mínimo pisa cuando el porcentaje da menos (1% de 300 = 3 → 10)',
    cerca(calcSeguroDHL(300, unoPorCiento).monto, 10));
  check('el porcentaje manda cuando supera el mínimo (1% de 5.000 = 50)',
    cerca(calcSeguroDHL(5000, unoPorCiento).monto, 50));
  check('sin mínimo se cobra el porcentaje puro (1% de 300 = 3)',
    cerca(calcSeguroDHL(300, { pct: 1, min: null }).monto, 3));
  check('mínimo 0 es lo mismo que sin mínimo',
    cerca(calcSeguroDHL(300, { pct: 1, min: 0 }).monto, 3));
  check('valor declarado 0 no paga seguro aunque haya mínimo',
    calcSeguroDHL(0, unoPorCiento).monto === 0 && calcSeguroUPS(0, unoPorCiento).monto === 0);
  check('el texto del desglose dice que es del cliente',
    /Seguro del cliente/.test(calcSeguroDHL(5000, unoPorCiento).desc));

  console.log('\n4. No toca nada más del envío\n');

  const params = {
    pais: 'Estados Unidos', tipo: 'export', pf: 10, fob: 2000,
    fuelPct: 35.25, profitPct: 90,
    bultosProc: [{ dims: [30, 30, 30], pr: 10, pf: 10 }],
  };
  const sinPropio = cotizarServicio('UPS_EXP', params);
  const conPropio = cotizarServicio('UPS_EXP', { ...params, seguroPropio: unoPorCiento });
  check('el flete no se mueve', cerca(sinPropio.flete, conPropio.flete));
  check('el flete con ganancia no se mueve', cerca(sinPropio.conGan, conPropio.conGan));
  check('el fuel no se mueve', cerca(sinPropio.fuelMonto, conPropio.fuelMonto));
  check('el surge no se mueve', cerca(sinPropio.surge, conPropio.surge));
  check('el seguro baja de 30 a 20', cerca(sinPropio.seguro, 30) && cerca(conPropio.seguro, 20));
  check('el total baja exactamente esos 10 dólares',
    cerca(sinPropio.total - conPropio.total, 10),
    `diferencia ${(sinPropio.total - conPropio.total).toFixed(2)}`);

  const dhlSin = cotizarServicio('DHL', params);
  const dhlCon = cotizarServicio('DHL', { ...params, seguroPropio: unoPorCiento });
  check('en DHL tampoco se mueve el flete', cerca(dhlSin.flete, dhlCon.flete));
  check('en DHL el seguro baja de 30 a 20', cerca(dhlSin.seguro, 30) && cerca(dhlCon.seguro, 20));

  console.log('\n5. Un seguro propio mal cargado no rompe nada\n');

  check('un mínimo sin porcentaje se ignora (vuelve al courier)',
    cerca(calcSeguroDHL(500, { pct: null, min: 10 }).monto, 17.5));
  check('un porcentaje no numérico se ignora',
    cerca(calcSeguroUPS(500, { pct: 'ocho', min: 10 }).monto, 15));
  check('un objeto vacío se ignora', cerca(calcSeguroUPS(500, {}).monto, 15));
  check('porcentaje 0 con mínimo cobra el mínimo',
    cerca(calcSeguroDHL(5000, { pct: 0, min: 10 }).monto, 10));

  console.log('\n6. El resolvedor contra la base\n');

  await db.initDb();
  const cli = await clienteModel.crear({ nombre: 'TEST SEGURO PROPIO', tarifa_pct: 50 });

  check('un cliente recién creado no tiene seguro propio',
    (await profitService.resolverSeguroPropio(cli.id)) === null);

  await clienteModel.actualizar(cli.id, { seguro_pct_propio: 1, seguro_min_propio: 10 });
  const res1 = await profitService.resolverSeguroPropio(cli.id);
  check('se guarda y se lee el porcentaje', res1 && res1.pct === 1, JSON.stringify(res1));
  check('se guarda y se lee el mínimo', res1 && res1.min === 10, JSON.stringify(res1));

  await clienteModel.actualizar(cli.id, { seguro_min_propio: null });
  const res2 = await profitService.resolverSeguroPropio(cli.id);
  check('se puede borrar solo el mínimo y queda el porcentaje',
    res2 && res2.pct === 1 && res2.min === null, JSON.stringify(res2));

  await clienteModel.actualizar(cli.id, { seguro_pct_propio: null, seguro_min_propio: null });
  check('se puede borrar y el cliente vuelve al seguro del courier',
    (await profitService.resolverSeguroPropio(cli.id)) === null);

  let rechazo = false;
  try {
    await clienteModel.actualizar(cli.id, { seguro_pct_propio: -1 });
  } catch (e) { rechazo = e.status === 400; }
  check('no acepta un porcentaje negativo', rechazo);

  rechazo = false;
  try {
    await clienteModel.actualizar(cli.id, { seguro_pct_propio: 'mucho' });
  } catch (e) { rechazo = e.status === 400; }
  check('no acepta un porcentaje que no es número', rechazo);

  // Que tocar el seguro no pise el fuel propio ni el modo, que se guardan en el mismo UPDATE.
  await clienteModel.actualizar(cli.id, { fuel_pct_propio: 31, modo_tarifa: 'por_kg' });
  await clienteModel.actualizar(cli.id, { seguro_pct_propio: 1 });
  const info = await clienteModel.buscarPorId(cli.id);
  check('guardar el seguro no borra el fuel propio', Number(info.fuel_pct_propio) === 31);
  check('guardar el seguro no cambia el modo de tarifa', info.modo_tarifa === 'por_kg');

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  // No se llama process.exit(): matar el proceso a mano mientras sqlite3 todavía tiene
  // cosas pendientes es lo que venía reventando en Windows. Se deja el código de salida y
  // Node termina solo cuando no le queda nada a medio cerrar. El timer con .unref() es la
  // red de seguridad: no sostiene el proceso, solo actúa si a los 3 s sigue en pie.
  process.exitCode = (fail > 0 ? 1 : 0);
  setTimeout(() => process.exit((fail > 0 ? 1 : 0)), 3000).unref();
}

main().catch((e) => { console.error(e); process.exit(1); });
