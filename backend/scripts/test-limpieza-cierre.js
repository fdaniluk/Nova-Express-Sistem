// Limpieza antes del cierre (28/09/2026): fechas de factura en ISO, el corte del control
// aplicado de verdad a facturas, "no cuadra" sin contar la percepción dos veces, fuel
// contra el historial y huérfanos borrados. Corre sobre una COPIA de la base.
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-limpieza-'));
fs.copyFileSync(path.join(__dirname, '..', '..', 'database', 'nova.db'), path.join(tmp, 'nova.db'));
process.env.DB_PATH = path.join(tmp, 'nova.db');
const assert = require('assert');
const sqlite3 = require('sqlite3');
const { aISO } = require('../src/utils/fecha');

(async () => {
  // ── Fixtures ANTES de que arranque el sistema (simulan la base como está en producción)
  const raw = new sqlite3.Database(process.env.DB_PATH);
  const run = (sql, p = []) => new Promise((res, rej) => raw.run(sql, p, function (e) { e ? rej(e) : res(this); }));
  const get = (sql, p = []) => new Promise((res, rej) => raw.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await run(`CREATE TABLE IF NOT EXISTS migraciones_una_vez (clave TEXT PRIMARY KEY, hecho_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))`);
  await run(`DELETE FROM migraciones_una_vez WHERE clave = 'limpieza_cierre_2809'`);
  await run(`DELETE FROM facturas_cargadas`); await run(`DELETE FROM factura_guias`);
  // Factura de agosto (anterior al corte 01/09) con fecha DD/MM, percepción repartida y una guía sin envío.
  const f1 = await run(`INSERT INTO facturas_cargadas (courier, numero_factura, fecha_factura, cantidad_guias, guias_cruzadas, guias_no_encontradas, total_declarado, subtotal_factura, percepciones, tipo)
    VALUES ('UPS', '0020-00075570', '31/08/2026', 2, 1, 1, 1030.00, 1000.00, 30.00, 'flete')`);
  await run(`INSERT INTO factura_guias (factura_id, numero_guia, pais, peso_facturado, costo_total, percepcion, encontrada) VALUES (?, '1Z000LIMP00000001', 'US', 10, 618.00, 18.00, 1)`, [f1.lastID]);
  await run(`INSERT INTO factura_guias (factura_id, numero_guia, pais, peso_facturado, costo_total, percepcion, encontrada) VALUES (?, '1Z000LIMP00000002', 'GB', 5, 412.00, 12.00, 0)`, [f1.lastID]);
  // Factura de septiembre (posterior al corte) que cuadra, con percepción.
  const f2 = await run(`INSERT INTO facturas_cargadas (courier, numero_factura, fecha_factura, cantidad_guias, guias_cruzadas, guias_no_encontradas, total_declarado, subtotal_factura, percepciones, tipo)
    VALUES ('UPS', '0020-00075900', '15/09/2026', 1, 1, 0, 515.00, 500.00, 15.00, 'flete')`);
  await run(`INSERT INTO factura_guias (factura_id, numero_guia, pais, peso_facturado, costo_total, percepcion, encontrada) VALUES (?, '1Z000LIMP00000003', 'US', 10, 515.00, 15.00, 1)`, [f2.lastID]);
  // Factura de septiembre que NO cuadra de verdad (falta una guía por 40).
  const f3 = await run(`INSERT INTO facturas_cargadas (courier, numero_factura, fecha_factura, cantidad_guias, guias_cruzadas, guias_no_encontradas, total_declarado, subtotal_factura, percepciones, tipo)
    VALUES ('UPS', '0020-00075901', '2026-09-20', 1, 1, 0, 540.00, 540.00, NULL, 'flete')`);
  await run(`INSERT INTO factura_guias (factura_id, numero_guia, pais, peso_facturado, costo_total, percepcion, encontrada) VALUES (?, '1Z000LIMP00000004', 'US', 10, 500.00, NULL, 1)`, [f3.lastID]);
  // Huérfano
  await run(`INSERT INTO envio_bultos (envio_id, numero_bulto, peso_real, largo, ancho, alto) VALUES (999999, 1, 1, 10, 10, 10)`);
  // Fuel: config UPS hoy 42; el 20/09 pasó de 41 a 42. Un envío del 18/09 con 41 es legítimo; uno del 25/09 con 37, no.
  await run(`DELETE FROM configuracion_historial WHERE courier = 'UPS'`);
  await run(`UPDATE configuracion SET fuel_pct = 42 WHERE courier = 'UPS'`);
  await run(`INSERT INTO configuracion_historial (courier, fuel_pct_anterior, fuel_pct_nuevo, fecha_cambio) VALUES ('UPS', 41, 42, '2026-09-20 10:00:00')`);
  const cli = await get('SELECT id FROM clientes LIMIT 1');
  const hoy = new Date(); const p = (n) => String(n).padStart(2, '0');
  const dia = (n) => { const d = new Date(hoy); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  // Ojo: el chequeo mira 60 días; las fechas fijas de septiembre sirven mientras se corra cerca. Se usan relativas y el historial se acomoda.
  await run(`UPDATE configuracion_historial SET fecha_cambio = ? WHERE courier = 'UPS'`, [`${dia(5)} 10:00:00`]);
  await run(`INSERT INTO envios (cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, peso_real, peso_facturable, total_cobrado, fuel_pct, created_at) VALUES (?, ?, 'UPS', 'exportacion', '1Z000LIMPFUEL0001', 'Estados Unidos', 5, 5, 100, 41, ?)`, [cli.id, dia(7), `${dia(7)} 15:00:00`]);
  await run(`INSERT INTO envios (cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, peso_real, peso_facturable, total_cobrado, fuel_pct, created_at) VALUES (?, ?, 'UPS', 'exportacion', '1Z000LIMPFUEL0002', 'Estados Unidos', 5, 5, 100, 37, ?)`, [cli.id, dia(2), `${dia(2)} 15:00:00`]);
  await new Promise((r) => raw.close(r));

  const { initDb, getDb } = require('../src/db');
  await initDb();
  const db = getDb();
  await db.prepare(`UPDATE configuracion_nova SET fecha_corte_control = '2026-09-01'`).run().catch(() => {});

  // 1) Migración: fechas en ISO y huérfano borrado
  assert.equal((await db.prepare(`SELECT fecha_factura FROM facturas_cargadas WHERE numero_factura = '0020-00075570'`).get()).fecha_factura, '2026-08-31');
  assert.equal((await db.prepare(`SELECT fecha_factura FROM facturas_cargadas WHERE numero_factura = '0020-00075900'`).get()).fecha_factura, '2026-09-15');
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM envio_bultos WHERE envio_id = 999999`).get()).n, 0, 'huérfano borrado');
  assert.equal(aISO('31/08/2026'), '2026-08-31'); assert.equal(aISO('2026-08-31'), '2026-08-31');

  // 2) Salud
  const salud = require('../src/services/salud.service');
  const r = await salud.correrChequeos();
  const by = Object.fromEntries(r.chequeos.map((c) => [c.id, c]));
  assert.equal(by.guias_sin_envio.cantidad, 0, 'la guía sin envío de agosto no se destaca');
  assert(/1 anterior/.test(by.guias_sin_envio.resumen), by.guias_sin_envio.resumen);
  const nc = by.facturas_no_cuadran;
  assert.equal(nc.cantidad, 1, 'solo la que no cuadra de verdad: ' + JSON.stringify(nc.detalle));
  assert.equal(nc.detalle[0].factura, '0020-00075901');
  assert.equal(nc.detalle[0].diferencia, 40);
  assert.equal(by.huerfanos.cantidad, 0);
  const fuel = by.fuel_desfasado;
  const guias = (fuel.detalle || []).map((d) => d.guia);
  assert(!guias.includes('1Z000LIMPFUEL0001'), 'el envío con el fuel vigente de su día no canta');
  assert(guias.includes('1Z000LIMPFUEL0002'), 'el envío con un fuel que nunca fue el de config sí canta: ' + JSON.stringify(fuel.detalle));

  // 3) La bandeja "Guías sin envío" de Facturas también respeta el corte
  const corte = '2026-09-01';
  const n = (await db.prepare(`SELECT COUNT(*) n FROM factura_guias fg JOIN facturas_cargadas f ON f.id = fg.factura_id WHERE fg.encontrada = 0 AND f.fecha_factura >= ?`).get(corte)).n;
  assert.equal(n, 0);
  console.log('TODO OK');
  process.exit(0);
})().catch((e) => { console.error('FALLÓ:', e); process.exit(1); });
