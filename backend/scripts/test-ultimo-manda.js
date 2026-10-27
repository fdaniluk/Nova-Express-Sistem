#!/usr/bin/env node
// "Manda lo último que se cargó" (27/10/2026, pedido de Felipe).
//
// Antes: precio por kilo > celda de % > % general, siempre. Ahora, entre los valores que
// aplican a un envío gana el que se CARGÓ último (vigente_desde / tarifa_pct_desde). Las
// filas sin fecha (cargadas antes de la regla) se resuelven como siempre: las tarifas ya
// armadas no cambian. Además: cliente nuevo sin % → 150 %.
//
// Corre contra una copia de la base (como test-tarifa-por-kg) y usa el servicio directo +
// el modelo de clientes, sin levantar el servidor.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DB_PROD = path.join(ROOT, 'database', 'nova.db');
const DB_TEST = '/tmp/test_ultimo_manda.db';
for (const f of [DB_TEST, DB_TEST + '-wal', DB_TEST + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
if (fs.existsSync(DB_PROD)) fs.copyFileSync(DB_PROD, DB_TEST);
process.env.DB_PATH = DB_TEST;

let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { initDb, getDb } = require('../src/db');
  await initDb();
  const db = getDb();
  const ps = require('../src/services/profit.service');
  const clientes = require('../src/models/cliente.model');
  const aumento = require('../src/services/aumento-tarifa.service');
  const Z = (zona, pf = 7) => ({ servicio: 'UPS_EXP', tipo: 'export', zona, pesoFacturable: pf });
  const venta = async (id, zona, pf) => ps.resolverTarifaVenta({ clienteId: id, ...Z(zona, pf) });
  const res = (r) => (r.modo === 'por_kg' ? `kg ${r.precioKg} (${r.origen})` : `${r.profitPct}% (${r.origen})`);

  console.log('\n0. La migración\n');
  for (const [t, c] of [['profit_overrides', 'vigente_desde'], ['tarifa_kg_overrides', 'vigente_desde'], ['clientes', 'tarifa_pct_desde']]) {
    const cols = (await db.prepare(`PRAGMA table_info(${t})`).all()).map((x) => x.name);
    check(`${t}.${c} existe`, cols.includes(c));
  }
  const sinFecha = await db.prepare('SELECT COUNT(*) n FROM profit_overrides WHERE vigente_desde IS NOT NULL').get();
  check('las celdas que ya estaban quedan SIN fecha (se cobran como siempre)', sinFecha.n === 0, String(sinFecha.n));

  console.log('\n1. Cliente nuevo: 150 % si no se le pone nada, lo que se ponga si se pone\n');
  const n1 = await clientes.crear({ nombre: 'ULTIMO MANDA NUEVO', tipo_cobro: 'CC' });
  check('sin tarifa_pct → 150', Number(n1.tarifa_pct) === 150, String(n1.tarifa_pct));
  const n2 = await clientes.crear({ nombre: 'ULTIMO MANDA CERO', tipo_cobro: 'CC', tarifa_pct: 0 });
  check('con tarifa_pct 0 explícito → 0 (no se pisa)', Number(n2.tarifa_pct) === 0, String(n2.tarifa_pct));
  const n3 = await clientes.crear({ nombre: 'ULTIMO MANDA 80', tipo_cobro: 'CC', tarifa_pct: 80 });
  check('con 80 → 80', Number(n3.tarifa_pct) === 80);
  check('el general de un cliente nuevo no lleva fecha (las celdas que cargue después mandan)', !n1.tarifa_pct_desde);

  console.log('\n2. Tarifas viejas (sin fecha): la regla de siempre\n');
  const c = await clientes.crear({ nombre: 'ULTIMO MANDA VIEJO', tipo_cobro: 'CC', tarifa_pct: 50 });
  const id = c.id;
  // Celda de % y precio por kilo cargados "a la vieja" (sin fecha), como las de producción.
  await db.prepare(`INSERT INTO profit_overrides (cliente_id, servicio, tipo, zona, peso_min, peso_max, profit_pct) VALUES (?, 'UPS_EXP', 'export', 1, 5, 10, 70)`).run(id);
  await db.prepare(`INSERT INTO profit_overrides (cliente_id, servicio, tipo, zona, peso_min, peso_max, profit_pct) VALUES (?, 'UPS_EXP', 'export', 2, 5, 10, 60)`).run(id);
  await db.prepare(`INSERT INTO tarifa_kg_overrides (cliente_id, servicio, tipo, zona, peso_min, peso_max, precio_kg) VALUES (?, 'UPS_EXP', 'export', 2, 5, 10, 9)`).run(id);
  let r = await venta(id, 1);
  check('zona 1: la celda de % (70) le gana al general (50)', r.modo === 'porcentaje' && r.profitPct === 70, res(r));
  r = await venta(id, 2);
  check('zona 2: el precio por kilo (9) le gana a la celda (60) y al general', r.modo === 'por_kg' && r.precioKg === 9, res(r));
  r = await venta(id, 3);
  check('zona 3: sin nada cargado, el general (50)', r.modo === 'porcentaje' && r.profitPct === 50 && r.origen === 'cliente', res(r));

  console.log('\n3. Se carga un % general nuevo: pisa TODO (sin borrar nada)\n');
  await clientes.actualizar(id, { tarifa_pct: 90 });
  const cc = await clientes.buscarPorId(id);
  check('el general quedó fechado', !!cc.tarifa_pct_desde, String(cc.tarifa_pct_desde));
  r = await venta(id, 1);
  check('zona 1: ahora manda el general 90 (la celda 70 queda pisada)', r.modo === 'porcentaje' && r.profitPct === 90 && r.origen === 'cliente', res(r));
  r = await venta(id, 2);
  check('zona 2: también pisa al precio por kilo', r.modo === 'porcentaje' && r.profitPct === 90, res(r));
  const quedan = await db.prepare('SELECT COUNT(*) n FROM profit_overrides WHERE cliente_id = ?').get(id);
  const quedanKg = await db.prepare('SELECT COUNT(*) n FROM tarifa_kg_overrides WHERE cliente_id = ?').get(id);
  check('las celdas y el precio por kilo siguen guardados', quedan.n === 2 && quedanKg.n === 1);
  // Guardar la ficha SIN cambiar el % no vuelve a fechar el general.
  const antes = cc.tarifa_pct_desde;
  await dormir(5);
  await clientes.actualizar(id, { tarifa_pct: 90, contacto: 'alguien' });
  check('guardar la ficha con el mismo % no lo vuelve a fechar', (await clientes.buscarPorId(id)).tarifa_pct_desde === antes);

  console.log('\n4. Después se carga una celda: esa celda vuelve a mandar en su lugar\n');
  await dormir(5);
  await ps.upsertOverride(id, { servicio: 'UPS_EXP', tipo: 'export', zona: 1, peso_min: 5, peso_max: 10, profit_pct: 75 });
  r = await venta(id, 1);
  check('zona 1: manda la celda nueva (75)', r.modo === 'porcentaje' && r.profitPct === 75 && r.origen === 'celda', res(r));
  r = await venta(id, 2);
  check('zona 2: sigue mandando el general (90)', r.profitPct === 90 && r.modo === 'porcentaje', res(r));
  r = await venta(id, 1, 12);
  check('zona 1 en OTRO tramo (10-15): el general (90), la celda era solo del 5-10', r.profitPct === 90, res(r));

  console.log('\n5. Precio por kilo cargado después de la celda: manda el kilo; y al revés\n');
  await dormir(5);
  await ps.upsertOverrideKg(id, { servicio: 'UPS_EXP', tipo: 'export', zona: 1, peso_min: 5, peso_max: 10, precio_kg: 11 });
  r = await venta(id, 1);
  check('zona 1: manda el precio por kilo nuevo (11)', r.modo === 'por_kg' && r.precioKg === 11, res(r));
  await dormir(5);
  await ps.upsertOverride(id, { servicio: 'UPS_EXP', tipo: 'export', zona: 1, peso_min: 5, peso_max: 10, profit_pct: 77 });
  r = await venta(id, 1);
  check('zona 1: se vuelve a cargar el % (77) y manda el % (el kilo 11 queda pisado, no borrado)', r.modo === 'porcentaje' && r.profitPct === 77, res(r));
  const kgQueda = await db.prepare('SELECT precio_kg FROM tarifa_kg_overrides WHERE cliente_id = ? AND zona = 1 AND peso_min = 5').get(id);
  check('el precio por kilo pisado sigue en la tabla', kgQueda && kgQueda.precio_kg === 11);

  console.log('\n6. La fila "Todas" cargada después de una celda manda sobre la celda\n');
  await dormir(5);
  await ps.upsertOverride(id, { servicio: 'UPS_EXP', tipo: 'export', zona: null, peso_min: 5, peso_max: 10, profit_pct: 65 });
  r = await venta(id, 1);
  check('zona 1: manda la fila Todas (65) por ser más nueva que la celda (77)', r.profitPct === 65 && r.origen === 'banda', res(r));
  r = await venta(id, 4);
  check('zona 4: también 65', r.profitPct === 65, res(r));
  await dormir(5);
  await ps.upsertOverride(id, { servicio: 'UPS_EXP', tipo: 'export', zona: 1, peso_min: 5, peso_max: 10, profit_pct: 78 });
  r = await venta(id, 1);
  check('zona 1: una celda cargada después de la fila vuelve a mandar (78)', r.profitPct === 78 && r.origen === 'celda', res(r));

  console.log('\n7. Lo que NO cambia el orden: aumento de tarifa y cambio de paso\n');
  const antesAum = await venta(id, 1);
  const u = await db.prepare('SELECT id, usuario FROM usuarios ORDER BY id LIMIT 1').get();
  await aumento.aplicar(id, { pct: 10 }, u ? { id: u.id, usuario: u.usuario } : null);
  r = await venta(id, 1);
  check('tras un aumento del 10 % sigue mandando la misma celda, con el % subido (78 → 95.8)', r.origen === 'celda' && Math.abs(r.profitPct - 95.8) < 0.01, `${res(antesAum)} → ${res(r)}`);
  r = await venta(id, 3);
  check('y en zona 3 la fila Todas subida (65 → 81.5)', r.origen === 'banda' && Math.abs(r.profitPct - 81.5) < 0.01, res(r));
  await ps.cambiarPasoTramos(id, { paso: 1, hasta: 30 });
  r = await venta(id, 1, 7);
  check('con tramos de 1 kg, el tramo 6-7 heredó la celda y SU fecha: sigue mandando la celda', r.origen === 'celda' && Math.abs(r.profitPct - 95.8) < 0.01, res(r));
  r = await venta(id, 3, 7);
  check('y en zona 3 la fila Todas heredada', r.origen === 'banda' && Math.abs(r.profitPct - 81.5) < 0.01, res(r));
  r = await venta(id, 1, 20);
  check('en un tramo sin celdas manda el general (que también subió: 90 → 109)', r.origen === 'cliente' && Math.abs(r.profitPct - 109) < 0.01, res(r));

  console.log('\n8. Lo que ve la pantalla\n');
  const m = await ps.obtenerMatriz(id, 'UPS_EXP', 'export');
  check('la matriz de % trae vigente_desde en cada celda', m.overrides.length > 0 && m.overrides.every((o) => 'vigente_desde' in o) && m.overrides.some((o) => o.vigente_desde));
  const mk = await ps.obtenerMatrizKg(id, 'UPS_EXP', 'export');
  check('la de precios por kilo también', mk.overrides.length > 0 && mk.overrides.every((o) => 'vigente_desde' in o));
  check('la ficha del cliente trae tarifa_pct_desde', 'tarifa_pct_desde' in (await clientes.buscarPorId(id)));

  console.log('\n9. Un cliente de producción con matriz vieja cobra exactamente lo mismo que antes\n');
  const viejo = await db.prepare(`SELECT c.id, c.nombre, c.tarifa_pct FROM clientes c WHERE EXISTS (SELECT 1 FROM profit_overrides p WHERE p.cliente_id = c.id AND p.vigente_desde IS NULL AND p.zona IS NOT NULL AND p.peso_min IS NOT NULL) LIMIT 1`).get();
  if (viejo) {
    const celda = await db.prepare('SELECT servicio, tipo, zona, peso_min, profit_pct FROM profit_overrides WHERE cliente_id = ? AND zona IS NOT NULL AND peso_min IS NOT NULL LIMIT 1').get(viejo.id);
    const rr = await ps.resolverTarifaVenta({ clienteId: viejo.id, servicio: celda.servicio, tipo: celda.tipo, zona: celda.zona, pesoFacturable: celda.peso_min + 0.5 });
    const kgAhi = await db.prepare('SELECT precio_kg FROM tarifa_kg_overrides WHERE cliente_id = ? AND servicio = ? AND tipo = ? AND (zona = ? OR zona IS NULL) AND (peso_min = ? OR peso_min IS NULL)').get(viejo.id, celda.servicio, celda.tipo, celda.zona, celda.peso_min);
    check(`${viejo.nombre}: ${kgAhi ? 'el precio por kilo' : `la celda (${celda.profit_pct} %)`} sigue mandando sobre el general (${viejo.tarifa_pct} %)`,
      kgAhi ? rr.modo === 'por_kg' : (rr.modo === 'porcentaje' && rr.profitPct === celda.profit_pct), res(rr));
  } else {
    check('(sin clientes con matriz vieja en la base: se saltea)', true);
  }

  await db.prepare("DELETE FROM clientes WHERE nombre LIKE 'ULTIMO MANDA%'").run();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('✗', e); process.exit(1); });
