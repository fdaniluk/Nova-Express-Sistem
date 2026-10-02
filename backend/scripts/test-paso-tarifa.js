// Paso de la tarifa (29/09/2026): tramos de 5 / 1 / 0,5 kg por cliente, cambio de paso
// sin mover precios y carga masiva de la matriz. Corre sobre una base nueva.
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-paso-'));
process.env.DB_PATH = path.join(tmp, 'nova.db');
const assert = require('assert');
const { initDb, getDb } = require('../src/db');
const P = require('../src/services/profit.service');
let ok = 0;
const check = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { console.log('  ✗ ' + n + (d ? '  → ' + d : '')); process.exitCode = 1; } };

(async () => {
  await initDb();
  const db = getDb();
  const cli = (await db.prepare(`INSERT INTO clientes (nombre, tipo_cobro, tarifa_pct) VALUES ('PASO PRUEBA', 'D', 50)`).run()).lastInsertRowid;
  const resolver = (pf, zona = 2) => P.resolverProfit({ clienteId: cli, servicio: 'UPS_EXP', tipo: 'export', zona, pesoFacturable: pf });

  console.log('\n1. Generación de tramos\n');
  const t05 = P.generarTramosPaso(0.5, 70);
  check('0,5 kg hasta 70: 141 tramos, el último abierto en 70', t05.length === 141 && t05[140].min === 70 && t05[140].max === null, JSON.stringify(t05.slice(-2)));
  check('el primero es 0-0,5 y el 30° es 14,5-15', t05[0].max === 0.5 && t05[29].min === 14.5 && t05[29].max === 15);
  const t1 = P.generarTramosPaso(1, 70);
  check('1 kg hasta 70: 71 tramos', t1.length === 71);
  assert.throws(() => P.generarTramosPaso(2), /paso inválido/);
  assert.throws(() => P.generarTramosPaso(1, 0.2), /hasta/);
  check('paso inválido y "hasta" inválido se rechazan', true);
  check('pasoDe detecta 0,5 / 1 / irregular', P.pasoDe(t05) === 0.5 && P.pasoDe(t1) === 1 && P.pasoDe(P.TRAMOS_POR_DEFECTO) === null);

  console.log('\n2. Carga masiva y resolución\n');
  // Matriz 5 kg (por defecto): 9 tramos × 2 zonas
  const celdas = [];
  P.TRAMOS_POR_DEFECTO.forEach((t, i) => { for (const z of [1, 2]) celdas.push({ zona: z, peso_min: t.min, peso_max: t.max, profit_pct: 100 + i * 10 + z }); });
  const r = await P.cargarMatrizMasiva(cli, { servicio: 'UPS_EXP', tipo: 'export', celdas });
  check('carga 18 celdas de una', r.celdas === 18);
  check('resuelve 3 kg zona 2 → 102 (celda)', (await resolver(3)).profitPct === 102 && (await resolver(3)).origen === 'celda');
  check('resuelve 37 kg zona 1 → 161 (tramo 30-40)', (await resolver(37, 1)).profitPct === 161);
  await assert.rejects(P.cargarMatrizMasiva(cli, { servicio: 'UPS_EXP', tipo: 'export', celdas: [{ zona: 1, peso_min: 7, peso_max: 8, profit_pct: 1 }] }), /tramo inválido/);
  check('una celda fuera de los tramos del cliente se rechaza (y no se escribe nada)', (await db.prepare('SELECT COUNT(*) n FROM profit_overrides WHERE cliente_id = ?').get(cli)).n === 18);

  console.log('\n3. Cambiar el paso: 5 → 0,5 no mueve precios\n');
  const antes = {};
  for (const pf of [0.5, 3, 5, 5.5, 12, 30, 30.5, 37, 49.5, 50, 60, 120]) antes[pf] = (await resolver(pf)).profitPct;
  const c1 = await P.cambiarPasoTramos(cli, { paso: 0.5, hasta: 70 });
  check('quedan 141 tramos propios, paso 0,5', c1.propios && c1.tramos.length === 141 && c1.paso === 0.5, JSON.stringify([c1.propios, c1.tramos.length, c1.paso]));
  check('se generaron 141 × 2 celdas', c1.celdas_pct === 282 && c1.tramos_promediados === 0, JSON.stringify(c1));
  let iguales = true;
  for (const pf of Object.keys(antes)) { const d = (await resolver(Number(pf))).profitPct; if (d !== antes[pf]) { iguales = false; console.log('   difiere', pf, antes[pf], d); } }
  check('todos los pesos resuelven el MISMO % que antes', iguales);
  check('60 kg (tramo 59,5-60) hereda del viejo 50+', (await resolver(60)).profitPct === antes[60]);
  check('120 kg (70+) hereda del viejo 50+', (await resolver(120)).profitPct === antes[120]);

  console.log('\n4. Afinar una celda fina y pasar a 1 kg\n');
  await P.upsertOverride(cli, { servicio: 'UPS_EXP', tipo: 'export', zona: 2, peso_min: 2.5, peso_max: 3, profit_pct: 77 });
  check('la celda 2,5-3 zona 2 ahora vale 77', (await resolver(3)).profitPct === 77 && (await resolver(2.5)).profitPct === 102);
  const c2 = await P.cambiarPasoTramos(cli, { paso: 1, hasta: 70 });
  check('paso 1: 71 tramos', c2.tramos.length === 71 && c2.paso === 1);
  check('el tramo 2-3 promedia 102 y 77 → 89,5 y avisa que promedió', (await resolver(3)).profitPct === 89.5 && c2.tramos_promediados > 0, String((await resolver(3)).profitPct));
  check('el tramo 4-5 sigue en 102 (los dos medios valían lo mismo)', (await resolver(5)).profitPct === 102);

  console.log('\n5. Volver a 5 kg (general)\n');
  const c3 = await P.cambiarPasoTramos(cli, { paso: 5 });
  check('vuelve al juego por defecto (sin tramos propios)', !c3.propios && c3.paso === 5 && c3.tramos.length === 9);
  check('30-40 vale el promedio de 30-31 … 39-40 (161)', (await resolver(37, 1)).profitPct === 161);
  check('no queda ninguna celda con tramos que no existan', (await db.prepare(`SELECT COUNT(*) n FROM profit_overrides WHERE cliente_id = ? AND peso_min NOT IN (0,5,10,15,20,25,30,40,50)`).get(cli)).n === 0);

  console.log('\n6. Precio por kilo también viaja con el paso\n');
  await P.upsertOverrideKg(cli, { servicio: 'UPS_EXP', tipo: 'export', zona: 3, peso_min: 10, peso_max: 15, precio_kg: 9.9 });
  const c4 = await P.cambiarPasoTramos(cli, { paso: 0.5, hasta: 70 });
  const kg = await db.prepare(`SELECT COUNT(*) n, MIN(precio_kg) mn, MAX(precio_kg) mx FROM tarifa_kg_overrides WHERE cliente_id = ? AND zona = 3`).get(cli);
  check('10 tramos de 0,5 entre 10 y 15 con 9,9 USD/kg', kg.n === 10 && kg.mn === 9.9 && kg.mx === 9.9 && c4.celdas_kg === 10, JSON.stringify(kg));

  console.log('\n7. Vaciar una matriz entera (02/10/2026)\n');
  await P.upsertOverride(cli, { servicio: 'DHL', tipo: 'export', zona: 1, peso_min: 0, peso_max: 0.5, profit_pct: 33 });
  const antesExp = (await db.prepare(`SELECT COUNT(*) n FROM profit_overrides WHERE cliente_id = ? AND servicio = 'UPS_EXP' AND tipo = 'export'`).get(cli)).n;
  const v = await P.vaciarMatriz(cli, { servicio: 'UPS_EXP', tipo: 'export' });
  check('borra todas las celdas de UPS Expedited exportación', v.borradas === antesExp && antesExp > 0 && (await db.prepare(`SELECT COUNT(*) n FROM profit_overrides WHERE cliente_id = ? AND servicio = 'UPS_EXP' AND tipo = 'export'`).get(cli)).n === 0, JSON.stringify(v));
  check('no toca DHL ni los precios por kilo ni la tarifa general del cliente', (await db.prepare(`SELECT COUNT(*) n FROM profit_overrides WHERE cliente_id = ? AND servicio = 'DHL'`).get(cli)).n === 1 && (await db.prepare(`SELECT COUNT(*) n FROM tarifa_kg_overrides WHERE cliente_id = ?`).get(cli)).n === 10 && (await db.prepare('SELECT tarifa_pct FROM clientes WHERE id = ?').get(cli)).tarifa_pct === 50);
  check('después el cliente cae a su tarifa general (50 %)', (await resolver(37, 1)).profitPct === 50 && (await resolver(37, 1)).origen === 'cliente', JSON.stringify(await resolver(37, 1)));
  const vk = await P.vaciarMatriz(cli, { servicio: 'UPS_EXP', tipo: 'export', tabla: 'kg' });
  check('tabla "kg" vacía los precios por kilo de esa matriz', vk.borradas === 10 && (await db.prepare(`SELECT COUNT(*) n FROM tarifa_kg_overrides WHERE cliente_id = ?`).get(cli)).n === 0);
  let err = null; try { await P.vaciarMatriz(cli, { servicio: 'FEDEX', tipo: 'export' }); } catch (e) { err = e; }
  check('servicio inválido → 400', err && err.status === 400);

  console.log(`\n${ok} pasaron · ${process.exitCode ? 'con fallas' : '0 fallaron'}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FALLÓ:', e); process.exit(1); });
