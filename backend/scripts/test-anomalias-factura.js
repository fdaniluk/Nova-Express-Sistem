// Anomalías de la factura del courier (05/10/2026) + IIBB fuera de los envíos.
//   1. detectarAnomalias(): recargos no previstos, más caros, peso distinto, cubiertos.
//   2. Migración una-vez: la percepción repartida sale de factura_guias.costo_total y de
//      envios.costo_facturado; el chequeo de salud sigue cuadrando.
//   3. /api/facturas/guias y /api/salidas devuelven las anomalías; /api/facturas/percepciones lista IIBB.
// Corre sobre una COPIA de la base.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const { detectarAnomalias } = require('../src/utils/anomalias-factura');

const PORT = process.env.PORT_TEST || 3966;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_anomalias_factura.db';
const TOKEN = 'token-test-anom';

let ok = 0, fail = 0;
function check(nombre, cond, det) {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fail++; console.log(`  ✗ ${nombre}${det ? '  → ' + det : ''}`); }
}

(async () => {
  console.log('\n1. detectarAnomalias()\n');
  const envio = {
    extras_json: JSON.stringify([{ tipo: 'surge', label: 'Recargo por demanda (surge)', monto: 20 }, { tipo: 'manejo', label: 'Manejo adicional (1 bulto)', monto: 27.65 }, { tipo: 'ipf', monto: 2.5 }]),
    seguro: 15, derechos: 0, peso_facturable: 8, entrega: 'normal', remota: 0, ddp: 0,
  };
  let a = detectarAnomalias(envio, { cargos: [
    { nombre: 'Declared Value', monto: 15 }, { nombre: 'Additional Handling', monto: 27.65 },
    { nombre: 'SURGE FEE - COM', monto: 21 }, { nombre: 'INTERNATIONAL PROCESSING FEE', monto: 2.5 },
    { nombre: 'PAPER COMMERCIAL INVOICE SURCHARGE', monto: 4 }, { nombre: 'PAPER COMMERCIAL INVOICE SURCHARGE', monto: -4 },
  ], peso_facturado: 8 });
  check('todo previsto (seguro, manejo, surge ~igual, IPF, papel neteado) → sin anomalías', a.length === 0, JSON.stringify(a));

  a = detectarAnomalias(envio, { cargos: [{ nombre: 'Residential', monto: 6 }, { nombre: 'Extended Area Surcharge Destination', monto: 32 }], peso_facturado: 8 });
  check('residencial y área extendida no previstas → 2 anomalías "no_previsto"', a.length === 2 && a.every((x) => x.clase === 'no_previsto') && a.some((x) => x.tipo === 'residencial' && x.facturado === 6) && a.some((x) => x.tipo === 'remota' && x.facturado === 32), JSON.stringify(a));
  check('el texto dice qué y cuánto', a.some((x) => /Área remota \/ extendida: USD 32\.00 no previsto/.test(x.texto)), a.map((x) => x.texto).join(' | '));

  a = detectarAnomalias(envio, { cargos: [{ nombre: 'Additional Handling', monto: 82.95 }], peso_facturado: 8 });
  check('manejo previsto 27.65 pero facturado 82.95 (3 bultos) → "mas_caro" +55.30', a.length === 1 && a[0].clase === 'mas_caro' && a[0].dif === 55.3, JSON.stringify(a));

  a = detectarAnomalias(envio, { cargos: [{ nombre: 'Additional Handling', monto: 29 }], peso_facturado: 8 });
  check('diferencia chica (+1.35, 5 %) no es anomalía', a.length === 0, JSON.stringify(a));

  a = detectarAnomalias(envio, { cargos: [], peso_facturado: 9.5 });
  check('peso facturado 9.5 vs cargado 8 → anomalía de peso +1.5', a.length === 1 && a[0].clase === 'peso' && a[0].dif === 1.5, JSON.stringify(a));
  a = detectarAnomalias(envio, { cargos: [], peso_facturado: 8.3 });
  check('0.3 kg de diferencia no avisa', a.length === 0);
  a = detectarAnomalias(envio, { cargos: [], peso_facturado: 6 });
  check('UPS cobró MENOS kilos (6 vs 8): a favor nuestro, no avisa', a.length === 0, JSON.stringify(a));

  const envioFuel = { ...envio, fuel: 20 };
  a = detectarAnomalias(envioFuel, { cargos: [], peso_facturado: 8, fuel_facturado: 26 });
  check('fuel facturado 26 vs calculado 20 (+6, 30 %) → anomalía de fuel', a.length === 1 && a[0].tipo === 'fuel' && a[0].dif === 6 && /Fuel: facturado USD 26\.00, calculado USD 20\.00/.test(a[0].texto), JSON.stringify(a));
  a = detectarAnomalias(envioFuel, { cargos: [], peso_facturado: 8, fuel_facturado: 21 });
  check('fuel +1 no avisa', a.length === 0);
  a = detectarAnomalias(envioFuel, { cargos: [], peso_facturado: 8, fuel_facturado: 15 });
  check('fuel facturado menor: a favor nuestro, no avisa', a.length === 0);
  a = detectarAnomalias(envioFuel, { cargos: [], peso_facturado: 8, fuel_facturado: null });
  check('factura vieja sin fuel discriminado: no compara', a.length === 0);

  a = detectarAnomalias({ ...envio, entrega: 'extendida' }, { cargos: [{ nombre: 'Extended Area Surcharge Destination', monto: 32 }], peso_facturado: 8 });
  check('zona de entrega marcada "extendida" en el envío cubre el recargo aunque no tenga monto', a.length === 0, JSON.stringify(a));

  a = detectarAnomalias({ ...envio, cargos_posteriores: [{ tipo: 'remota', monto: 32, estado: 'pendiente' }] }, { cargos: [{ nombre: 'Extended Area Surcharge Destination', monto: 32 }], peso_facturado: 8 });
  check('un cargo posterior "área remota" ya cargado cubre la línea de la factura', a.length === 0, JSON.stringify(a));
  a = detectarAnomalias({ ...envio, cargos_posteriores: [{ tipo: 'sobrepeso', monto: 10, estado: 'pendiente' }] }, { cargos: [], peso_facturado: 9.5 });
  check('un cargo "sobrepeso" cubre la diferencia de peso', a.length === 0);

  // (06/10) Un cargo "otro" con el nombre de la familia cubre la anomalía — es lo que crea
  // "Cobrar al cliente". Sin esto el aviso seguía y la oficina cargaba el cargo dos veces.
  a = detectarAnomalias({ ...envio, cargos_posteriores: [{ tipo: 'otro', label: 'Corrección de dirección', monto: 22.1, estado: 'pendiente' }] }, { cargos: [{ nombre: 'Address Correction', monto: 22.1 }], peso_facturado: 8 });
  check('cargo "otro: Corrección de dirección" cubre el Address Correction de la factura', a.length === 0, JSON.stringify(a));
  a = detectarAnomalias({ ...envio, cargos_posteriores: [{ tipo: 'otro', label: 'area remota', monto: 42.15, estado: 'pendiente' }] }, { cargos: [{ nombre: 'Extended Area Surcharge Destination', monto: 42.15 }], peso_facturado: 8 });
  check('cargo "otro: area remota" (escrito a mano) cubre el área extendida', a.length === 0, JSON.stringify(a));
  a = detectarAnomalias({ ...envio, cargos_posteriores: [{ tipo: 'otro', label: 'Recargo por demanda', monto: 6.6, estado: 'pendiente' }] }, { cargos: [{ nombre: 'SURGE FEE - COM', monto: 26.6 }], peso_facturado: 8 });
  check('cargo "otro: Recargo por demanda" cubre la diferencia de surge', a.length === 0, JSON.stringify(a));
  a = detectarAnomalias({ ...envio, cargos_posteriores: [{ tipo: 'otro', label: 'Corrección de dirección', monto: 22.1, estado: 'anulado' }] }, { cargos: [{ nombre: 'Address Correction', monto: 22.1 }], peso_facturado: 8 });
  check('un cargo anulado no cubre nada', a.length === 1);
  a = detectarAnomalias(envio, { cargos: [{ nombre: 'Address Correction', monto: 18 }, { nombre: 'Duty and Tax Forwarding Surcharge', monto: 12 }], peso_facturado: 8 });
  check('corrección de dirección y DDP forwarding sin DDP → no previstos', a.length === 2 && a.every((x) => x.clase === 'no_previsto'));
  a = detectarAnomalias({ ...envio, ddp: 1 }, { cargos: [{ nombre: 'Duty and Tax Forwarding Surcharge', monto: 12 }], peso_facturado: 8 });
  check('con DDP tildado, el forwarding está previsto', a.length === 0);
  a = detectarAnomalias({ ...envio, seguro: 0 }, { cargos: [{ nombre: 'Declared Value', monto: 21.5 }], peso_facturado: 8 });
  check('seguro facturado sin seguro en el envío → no previsto', a.length === 1 && a[0].tipo === 'seguro');
  check('sin factura → []', detectarAnomalias(envio, null).length === 0);

  console.log('\n2. Migración IIBB fuera de los envíos + endpoints\n');
  prepararDb(DB);
  // Antes de levantar el servidor: una factura "vieja" con percepción repartida.
  const sqlite3 = require('sqlite3');
  const raw = new sqlite3.Database(DB);
  const run = (sql, p = []) => new Promise((res, rej) => raw.run(sql, p, function (e) { e ? rej(e) : res(this); }));
  const get = (sql, p = []) => new Promise((res, rej) => raw.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await run("DELETE FROM migraciones_una_vez WHERE clave = 'iibb_fuera_de_envios'").catch(() => {});
  const cli = await run("INSERT INTO clientes (nombre, tipo_cobro, tarifa_pct, activo) VALUES ('ANOM SA', 'CC', 50, 1)");
  const env1 = await run(`INSERT INTO envios (cliente_id, fecha, courier, servicio_ups, tipo_envio, numero_guia, pais_destino, peso_real, peso_facturable, fob, total_cobrado, flete, seguro, fuel, adicionales, extras_json, costo_facturado, peso_facturado, courier_facturado, fecha_facturado, estado_revision, entrega)
    VALUES (?, '2026-09-10', 'UPS', 'UPS_EXP', 'exportacion', '1Z000ANOM00000001', 'Estados Unidos', 8, 8, 100, 200, 60, 15, 20, 5, '[{"tipo":"surge","monto":5}]', 103.00, 9.5, 'UPS', '2026-09-20', 'pendiente', 'normal')`, [cli.lastID]);
  const fac = await run(`INSERT INTO facturas_cargadas (numero_factura, fecha_factura, fecha_carga, courier, total_declarado, subtotal_factura, percepciones, tipo) VALUES ('F-ANOM-1', '2026-09-20', '2026-09-21', 'UPS', 106.00, 100.00, 6.00, 'flete')`);
  await run(`INSERT INTO factura_guias (factura_id, envio_id, numero_guia, pais, peso_facturado, neto, total_recargos, percepcion, costo_total, cargos_json, encontrada)
    VALUES (?, ?, '1Z000ANOM00000001', 'Estados Unidos', 9.5, 60, 40, 3.00, 103.00, '[{"nombre":"Residential","monto":6},{"nombre":"SURGE FEE - COM","monto":5}]', 1)`, [fac.lastID, env1.lastID]);
  await new Promise((r) => raw.close(r));

  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; }); srv.stderr.on('data', (d) => { logErr += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const J = (m, u, b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());

  const raw2 = new sqlite3.Database(DB);
  const get2 = (sql, p = []) => new Promise((res, rej) => raw2.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const fg = await get2('SELECT costo_total, percepcion FROM factura_guias WHERE envio_id = ?', [env1.lastID]);
  const ev = await get2('SELECT costo_facturado FROM envios WHERE id = ?', [env1.lastID]);
  check('migración: la percepción (3.00) salió del costo de la guía (103 → 100)', Math.abs(fg.costo_total - 100) < 0.005 && fg.percepcion === 3, JSON.stringify(fg));
  check('y del costo facturado del envío (103 → 100)', Math.abs(ev.costo_facturado - 100) < 0.005, JSON.stringify(ev));
  check('queda marcada como hecha', !!(await get2("SELECT 1 AS x FROM migraciones_una_vez WHERE clave = 'iibb_fuera_de_envios'")));
  await new Promise((r) => raw2.close(r));

  const sal = await J('GET', `/api/salidas?desde=2026-09-10&hasta=2026-09-10`);
  const fila = (Array.isArray(sal) ? sal : sal.items || []).find((e) => e.id === env1.lastID);
  check('Salidas: costo_facturado 100 y anomalias_factura (residencial no previsto + peso 9.5 vs 8)', fila && Math.abs(fila.costo_facturado - 100) < 0.005 && fila.anomalias_factura.length === 2 && fila.anomalias_factura.some((x) => x.tipo === 'residencial') && fila.anomalias_factura.some((x) => x.clase === 'peso'), JSON.stringify(fila && fila.anomalias_factura));

  await J('PATCH', `/api/facturas/guias/${env1.lastID}/estado`, { estado_revision: 'a_revisar' });
  const rev = await J('GET', '/api/facturas/guias?todo=1');
  const g = (rev.guias || []).find((x) => x.id === env1.lastID);
  check('Revisión: la guía trae sus anomalías', g && Array.isArray(g.anomalias) && g.anomalias.length === 2, JSON.stringify(g && g.anomalias));

  const salud = await J('GET', '/api/salud');
  const chk = (salud.chequeos || salud.checks || []).find((c) => /factura/i.test(c.nombre || c.titulo || c.id || ''));
  check('Salud: la factura cuadra (100 guías + 6 percepción = 106)', !chk || !(chk.detalle || []).some((d) => /F-ANOM-1/.test(JSON.stringify(d))), chk && JSON.stringify(chk).slice(0, 300));

  const per = await J('GET', '/api/facturas/percepciones');
  check('Ingresos Brutos: la factura figura con 6.00 y el mes 2026-09 suma', per.facturas.some((f) => f.numero_factura === 'F-ANOM-1' && f.percepciones === 6) && per.por_mes['2026-09'] >= 6, JSON.stringify(per).slice(0, 200));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  matar();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1500).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
