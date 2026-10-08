#!/usr/bin/env node
/**
 * test-matriz-planilla-vieja.js — la matriz cargada desde los liquidadores viejos tiene que
 * dar EL MISMO flete que la planilla de la oficina, al centavo, en los pesos que la oficina
 * usa de verdad (08/10/2026).
 *
 * Nace de la comparación "sistema vs planillas" de Felipe (05–08/10): liquidaciones de
 * Acuña, Lascano, Casablanca, Fagliano y Zappala con filas en amarillo. Las diferencias
 * reales de FLETE eran dos:
 *   · envíos cargados antes de la corrección del 01/10 (zona del motor → columna de la
 *     región del liquidador) que conservaban el precio viejo → se recalculan desde Salidas;
 *   · pesos por encima de 70 kg: la carga cortaba en 70 y el tramo abierto heredaba ese %,
 *     pero el liquidador sigue con `tarif 0808` hasta 300 kg (Acuña → Ghana 87,5 kg:
 *     736,83 en vez de 718,33). Ahora la planilla se carga completa hasta 300 kg.
 *
 * Corre el cargador contra una base limpia con esos cinco clientes y le pregunta al motor
 * el flete de venta en cada fila de las planillas (peso y región tal como los tipea la
 * oficina), más una muestra por encima de 70 kg.
 *
 *   cd backend && npm run test-matriz-vieja
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_TEST = '/tmp/test_matriz_planilla_vieja.db';
for (const f of [DB_TEST, DB_TEST + '-wal', DB_TEST + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
process.env.DB_PATH = DB_TEST;

let ok = 0, fail = 0;
function check(n, c, d = '') { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const r2 = (n) => Math.round(n * 100) / 100;

(async () => {
  const { initDb, getDb, closeDb } = require('../src/db');
  await initDb();
  const db = getDb();
  // Los clientes con el id que figura en el JSON (cliente_ids).
  const clientes = [[11, 'MIGUEL ACUÑA'], [46, 'Lascano'], [7, 'CASABLANCA'], [10, 'FAGLIANO'], [52, 'Zappala']];
  for (const [id, nombre] of clientes) {
    await db.prepare('INSERT INTO clientes (id, nombre, activo, tipo_cobro) VALUES (?, ?, 1, "D")').run(id, nombre);
  }
  await closeDb();

  console.log('\n1. Carga de las cinco planillas\n');
  const salida = execFileSync('node', [path.join(__dirname, 'cargar-tarifarios-viejos.js'), '--solo=ACUA,LASCANO,CASABLANCA_UPS,CASABLANCA_DHL,FAGLIANO,ZAPPALA'], {
    env: { ...process.env, DB_PATH: DB_TEST }, encoding: 'utf8',
  });
  const lineas = salida.trim().split('\n').filter((l) => /desvío máx/.test(l));
  check('el cargador terminó con las 6 cargas', lineas.length === 6, salida.slice(-600));
  for (const l of lineas) {
    const m = l.match(/desvío máx\. USD ([\d.]+)/);
    check(`desvío ≤ 0,02 en ${l.split(/\s+/)[0]}`, m && Number(m[1]) <= 0.02, l);
  }
  check('la matriz llega hasta 300 kg', lineas.every((l) => /hasta 300 kg/.test(l)), lineas[0]);

  await initDb();
  const P = require('../src/services/profit.service');
  const core = require('../../shared/cotizador/cotizador-core.js');
  const costoUps = (pf, zona) => core.getUPS(core.UPS_E_LIQD, core.UPS_E_PK, core.UPS_E_MN, zona, pf);
  const PAIS_DHL = {}; for (const [p, z] of Object.entries(core.ZONAS_DHL)) if (!PAIS_DHL[z]) PAIS_DHL[z] = p;
  const costoDhl = (pf, zona) => core.cotizarServicio('DHL', { pais: PAIS_DHL[zona], tipo: 'export', pf, fob: 0, fuelPct: 0, profitPct: 0, bultosProc: [{ dims: [10, 10, 10], pr: pf, pf }], contenido: 'paquete' }).fleteBase;

  async function flete(clienteId, servicio, zona, pf) {
    const res = await P.resolverProfit({ clienteId, servicio, tipo: 'export', zona, pesoFacturable: pf });
    const costo = servicio === 'DHL' ? costoDhl(pf, zona) : costoUps(pf, zona);
    return { flete: r2(costo * (1 + res.profitPct / 100)), origen: res.origen };
  }

  console.log('\n2. Las filas de las planillas de la oficina (zona del MOTOR, precio de la planilla)\n');
  // [cliente, servicio, zona del motor, peso, flete de la planilla, descripción]
  const filas = [
    // Acuña (planilla ×1,05)
    [11, 'UPS_EXP', 5, 39, 358.92, 'Acuña Malasia 39 kg'],
    [11, 'UPS_EXP', 4, 41.5, 321.47, 'Acuña España 41,5 kg'],
    [11, 'UPS_EXP', 2, 16.5, 136.39, 'Acuña EE.UU. 16,5 kg'],
    [11, 'UPS_EXP', 6, 87.5, 718.33, 'Acuña Ghana 87,5 kg (más de 70 kg)'],
    // Fagliano (×1,05)
    [10, 'UPS_EXP', 4, 10.5, 108.55, 'Fagliano Reino Unido 10,5 kg'],
    [10, 'UPS_EXP', 4, 3.5, 57.77, 'Fagliano Reino Unido 3,5 kg'],
    [10, 'UPS_EXP', 2, 8.5, 72.30, 'Fagliano EE.UU. 8,5 kg'],
    [10, 'UPS_EXP', 2, 9, 74.72, 'Fagliano EE.UU. 9 kg'],
    [10, 'UPS_EXP', 2, 4, 49.35, 'Fagliano EE.UU. 4 kg'],
    [10, 'UPS_EXP', 5, 7.5, 100.90, 'Fagliano Singapur 7,5 kg'],
    [10, 'UPS_EXP', 5, 8, 105.11, 'Fagliano Singapur 8 kg'],
    [10, 'UPS_EXP', 5, 12.5, 142.60, 'Fagliano Australia 12,5 kg'],
    // Lascano (×1,05)
    [46, 'UPS_EXP', 6, 5.5, 105.04, 'Lascano Emiratos 5,5 kg'],
    [46, 'UPS_EXP', 4, 4.5, 77.78, 'Lascano Inglaterra 4,5 kg'],
    [46, 'UPS_EXP', 4, 9, 119.50, 'Lascano Italia 9 kg (la planilla de agosto dice 121,80: × otro K8)'],
    // Zappala (×1)
    [52, 'UPS_EXP', 4, 29.5, 243.28, 'Zappala Francia 29,5 kg'],
    [52, 'UPS_EXP', 4, 30.5, 248.62, 'Zappala España 30,5 kg'],
    [52, 'UPS_EXP', 2, 20, 149.66, 'Zappala EE.UU. 20 kg'],
    [52, 'UPS_EXP', 5, 20, 336.74, 'Zappala Malasia 20 kg'],
    // Casablanca UPS (febrero, ×1)
    [7, 'UPS_EXP', 5, 7.5, 109.71, 'Casablanca Australia 7,5 kg'],
    [7, 'UPS_EXP', 4, 29.5, 198.20, 'Casablanca Reino Unido 29,5 kg'],
    [7, 'UPS_EXP', 2, 41, 187.08, 'Casablanca EE.UU. 41 kg'],
    [7, 'UPS_EXP', 5, 4, 77.26, 'Casablanca Australia 4 kg'],
    // Casablanca DHL
    [7, 'DHL', 4, 6, 122.84, 'Casablanca DHL Reino Unido 6 kg'],
    [7, 'DHL', 4, 1, 58.70, 'Casablanca DHL Reino Unido 1 kg'],
    [7, 'DHL', 6, 21, 319.54, 'Casablanca DHL Azerbaiyán 21 kg'],
    [7, 'DHL', 4, 33, 382.54, 'Casablanca DHL Reino Unido 33 kg'],
  ];
  for (const [cid, serv, zona, pf, esperado, desc] of filas) {
    const r = await flete(cid, serv, zona, pf);
    check(`${desc} → ${esperado}`, Math.abs(r.flete - esperado) <= 0.02 && r.origen === 'celda', `dio ${r.flete} (${r.origen})`);
  }

  console.log('\n3. Por encima de 70 kg la matriz sigue a la planilla (tarif 0808) y no al % de los 70 kg\n');
  const datos = JSON.parse(fs.readFileSync(path.join(__dirname, 'datos', 'planillas_precios_viejos.json'), 'utf8'));
  const precioJson = (key, w, col) => { const f = datos[key].precios.find(([a, b]) => a === w && b === col); return f ? f[2] : null; };
  const COL_UPS = { 1: 1, 2: 3, 3: 2, 4: 4, 5: 6, 6: 6 };
  for (const [key, cid, pf, zona] of [['ACUA', 11, 100, 4], ['ACUA', 11, 150.5, 6], ['ZAPPALA', 52, 299.5, 2], ['FAGLIANO', 10, 70.5, 1], ['LASCANO', 46, 300, 5]]) {
    const esperado = precioJson(key, pf, COL_UPS[zona]);
    const r = await flete(cid, 'UPS_EXP', zona, pf);
    check(`${key} zona ${zona} ${pf} kg → ${esperado}`, esperado != null && Math.abs(r.flete - esperado) <= 0.02, `dio ${r.flete} (${r.origen})`);
  }
  const abierto = await P.resolverProfit({ clienteId: 11, servicio: 'UPS_EXP', tipo: 'export', zona: 6, pesoFacturable: 350 });
  const en300 = await P.resolverProfit({ clienteId: 11, servicio: 'UPS_EXP', tipo: 'export', zona: 6, pesoFacturable: 300 });
  check('más de 300 kg: el tramo abierto hereda el % de los 300 kg', abierto.origen === 'celda' && abirtoIgual(abierto, en300), JSON.stringify([abierto, en300]));
  function abirtoIgual(a, b) { return Math.abs(a.profitPct - b.profitPct) < 0.01; }
  const t = await P.obtenerTramos(11);
  check('el cliente queda con 600 tramos de 0,5 kg + el abierto', t.length === 601 && t[t.length - 1].min === 300 && t[t.length - 1].max === null, `tramos: ${t.length}`);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM profit_overrides WHERE cliente_id = 11 AND servicio = 'UPS_EXP' AND peso_min IS NOT NULL").get();
  check('3.606 celdas UPS Expedited para Acuña (601 tramos × 6 zonas)', n.n === 3606, `celdas: ${n.n}`);

  console.log('\n4. El motor expone el flete de venta (lo que la oficina compara con la columna FLETE)\n');
  const { cotizarEnvio } = require('../src/services/calculos.service');
  const ghana = await P.resolverProfit({ clienteId: 11, servicio: 'UPS_EXP', tipo: 'export', zona: 6, pesoFacturable: 87.5 });
  const cot = cotizarEnvio({ pais: 'Ghana', tipo: 'export', servicio: 'UPS_EXP', pesoFacturable: 87.5, fob: 2141, fuelPct: 40.75, profitPct: ghana.profitPct, bultos: [], contenido: 'paquete' });
  check('cotizar Acuña → Ghana 87,5 kg trae flete_venta 718.33 y flete_costo', cot && Math.abs(cot.flete_venta - 718.33) <= 0.02 && cot.flete_costo > 0 && cot.flete_costo < cot.flete_venta, JSON.stringify(cot && { flete_costo: cot.flete_costo, flete_venta: cot.flete_venta }));

  await closeDb();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('✗', e); process.exit(1); });
