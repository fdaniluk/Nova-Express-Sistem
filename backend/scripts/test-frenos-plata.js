#!/usr/bin/env node
/**
 * test-frenos-plata.js — los tres frenos que protegen la plata cargada (01/09/2026).
 *
 * Los tres salieron del listado de riesgos y son defectos, no decisiones:
 *
 *  A1 · BORRAR UN ENVÍO LIQUIDADO SE LLEVABA LA LIQUIDACIÓN CONFIRMADA. El botón Borrar
 *       de Salidas no miraba `liquidado`: restaba el importe del total, borraba el ítem
 *       y, si era el único, borraba la liquidación entera. Sin confirmación, sin rol de
 *       admin y sin papelera, al alcance de los 9 usuarios. El PATCH ya estaba tapado
 *       desde el 13/08; esta era la otra puerta.
 *
 *  A5 · UN NÚMERO MAL TIPEADO BORRABA EL DATO. En el modal los campos son
 *       <input type="number">: si alguien escribe "1250,50" con coma, el navegador
 *       devuelve cadena vacía y viajaba `null`. El flete (o la venta) se guardaba
 *       BORRADO y nadie se enteraba salvo por el profit, que saltaba solo.
 *
 *  E6 · Un tipo_envio o un courier inválido devolvía 500 con el error crudo de SQLite.
 *
 * Lo que esta tanda cuida es que los frenos frenen SIN frenar lo legítimo: un borrador
 * se tiene que poder borrar, y un número bien escrito se tiene que poder guardar.
 *
 *   cd backend && node scripts/test-frenos-plata.js
 */

const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3940;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_frenos_plata.db';
const TOKEN = 'token-test-frenos';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);
  const esperarSrvMuerto = () => new Promise((res) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return res();
    srv.once('exit', res);
    setTimeout(res, 2000);
  });

  // Espera la línea de "listo" que imprime NUESTRO servidor (no un /api/health que puede
  // contestar otro node vivo en el puerto), hasta 60 s: en Windows el primer arranque de
  // node del día tarda y con 12 s el test reventaba con un ECONNREFUSED que parecía del
  // cortafuegos. Ver scripts/_base-test.js.
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const hoy = new Date().toISOString().slice(0, 10);

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const run = (q, p = []) => new Promise((res, rej) => db.run(q, p, function (e) { e ? rej(e) : res(this); }));
  const get = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => (e ? rej(e) : res(r))));

  const cli = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H,
    body: JSON.stringify({ nombre: 'FRENOS PLATA', tarifa_pct: 75 }),
  })).json();

  const alta = async (guia, extra = {}) => (await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion',
      numero_guia: guia, pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
      peso_real: 5, largo: 30, ancho: 20, alto: 15, fob: 0, total_cobrado: 200, ...extra,
    }),
  })).json());

  // ── A1 ─────────────────────────────────────────────────────────────────────
  console.log('\n1. A1 · borrar un envío que está en una liquidación CONFIRMADA\n');

  const eConf = await alta('1Z000FRENO00000001');
  const liqConf = await run(
    "INSERT INTO liquidaciones (cliente_id, periodo_desde, periodo_hasta, total, estado) VALUES (?, ?, ?, 200, 'confirmada')",
    [cli.id, hoy, hoy]);
  await run('INSERT INTO liquidacion_items (liquidacion_id, envio_id, total_usd, fuel_pct_usado) VALUES (?, ?, 200, 37)',
    [liqConf.lastID, eConf.id]);
  await run('UPDATE envios SET liquidado = 1, liquidacion_id = ? WHERE id = ?', [liqConf.lastID, eConf.id]);

  const delConf = await fetch(`${BASE}/api/salidas/${eConf.id}`, { method: 'DELETE', headers: H });
  const bodyConf = await delConf.json();
  check('lo rechaza con 409', delConf.status === 409, `status ${delConf.status}`);
  check('y explica por qué (liquidación confirmada)',
    /liquidad|confirmada/i.test(bodyConf.error || ''), bodyConf.error);

  check('el envío sigue existiendo', !!(await get('SELECT id FROM envios WHERE id = ?', [eConf.id])));
  check('la liquidación confirmada sigue entera',
    !!(await get('SELECT id FROM liquidaciones WHERE id = ?', [liqConf.lastID])));
  const itemsVivos = await get('SELECT COUNT(*) n FROM liquidacion_items WHERE liquidacion_id = ?', [liqConf.lastID]);
  check('con su ítem adentro', itemsVivos.n === 1, `${itemsVivos.n} ítems`);
  const totalVivo = await get('SELECT total FROM liquidaciones WHERE id = ?', [liqConf.lastID]);
  check('y el total sin tocar (200)', Number(totalVivo.total) === 200, String(totalVivo.total));

  console.log('\n2. A1 · pero un BORRADOR sí se puede borrar (no romper lo que servía)\n');
  const eBorr = await alta('1Z000FRENO00000002');
  const liqBorr = await run(
    "INSERT INTO liquidaciones (cliente_id, periodo_desde, periodo_hasta, total, estado) VALUES (?, ?, ?, 200, 'borrador')",
    [cli.id, hoy, hoy]);
  await run('INSERT INTO liquidacion_items (liquidacion_id, envio_id, total_usd, fuel_pct_usado) VALUES (?, ?, 200, 37)',
    [liqBorr.lastID, eBorr.id]);

  const delBorr = await fetch(`${BASE}/api/salidas/${eBorr.id}`, { method: 'DELETE', headers: H });
  check('el envío de un borrador se borra', delBorr.status === 200, `status ${delBorr.status}`);
  check('y el borrador que quedó vacío se limpia solo',
    !(await get('SELECT id FROM liquidaciones WHERE id = ?', [liqBorr.lastID])));

  console.log('\n3. A1 · un envío suelto se sigue borrando normal\n');
  const eSuelto = await alta('1Z000FRENO00000003');
  const delSuelto = await fetch(`${BASE}/api/salidas/${eSuelto.id}`, { method: 'DELETE', headers: H });
  check('se borra sin drama', delSuelto.status === 200, `status ${delSuelto.status}`);

  // ── A5 ─────────────────────────────────────────────────────────────────────
  console.log('\n4. A5 · un número mal tipeado NO borra el dato\n');
  const eNum = await alta('1Z000FRENO00000004');
  const anterior = await get('SELECT flete, total_cobrado FROM envios WHERE id = ?', [eNum.id]);

  const patch = (cuerpo) => fetch(`${BASE}/api/salidas/${eNum.id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify(cuerpo),
  });

  const conComa = await patch({ flete: '1250,50' });
  const bodyComa = await conComa.json();
  check('"1250,50" con coma se rechaza con 400', conComa.status === 400, `status ${conComa.status}`);
  check('y el mensaje dice que los decimales van con punto',
    /punto/i.test(bodyComa.error || ''), bodyComa.error);
  const trasComa = await get('SELECT flete FROM envios WHERE id = ?', [eNum.id]);
  check('el flete anterior quedó INTACTO (antes se borraba)',
    Number(trasComa.flete) === Number(anterior.flete), `${trasComa.flete} vs ${anterior.flete}`);

  const conLetras = await patch({ total_cobrado: 'doscientos' });
  check('un texto cualquiera también se rechaza', conLetras.status === 400, `status ${conLetras.status}`);
  const trasLetras = await get('SELECT total_cobrado FROM envios WHERE id = ?', [eNum.id]);
  check('y la venta sigue en su valor', Number(trasLetras.total_cobrado) === Number(anterior.total_cobrado),
    `${trasLetras.total_cobrado} vs ${anterior.total_cobrado}`);

  const negativo = await patch({ peso_real: -5 });
  check('un peso negativo se rechaza', negativo.status === 400, `status ${negativo.status}`);

  console.log('\n5. A5 · lo legítimo sigue entrando\n');
  const bienEscrito = await patch({ flete: 1250.5 });
  check('un número con punto se guarda', bienEscrito.status === 200, `status ${bienEscrito.status}`);
  const trasBien = await get('SELECT flete FROM envios WHERE id = ?', [eNum.id]);
  check('y queda exactamente 1250.5', Number(trasBien.flete) === 1250.5, String(trasBien.flete));

  const vaciar = await patch({ otros: null });
  check('vaciar un campo con null sigue permitido', vaciar.status === 200, `status ${vaciar.status}`);

  const perdida = await patch({ profit: -80 });
  check('un profit NEGATIVO se acepta: un envío puede dar pérdida y hay que verlo',
    perdida.status === 200, `status ${perdida.status}`);

  // ── E6 ─────────────────────────────────────────────────────────────────────
  console.log('\n6. E6 · valores de lista inválidos: 400 entendible, no 500 crudo\n');
  const tipoMal = await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportación',
      numero_guia: '1Z000FRENO00000009', pais_destino: 'Estados Unidos', peso_real: 3,
    }),
  });
  const tipoMalBody = await tipoMal.json();
  check('un tipo_envio inválido da 400 (antes 500)', tipoMal.status === 400, `status ${tipoMal.status}`);
  check('y el mensaje dice qué se esperaba y qué llegó',
    /exportacion.*importacion/i.test(tipoMalBody.error || '') && /exportación/.test(tipoMalBody.error || ''),
    tipoMalBody.error);
  check('no filtra el error crudo de SQLite', !/SQLITE|CHECK constraint/i.test(tipoMalBody.error || ''),
    tipoMalBody.error);

  const courierMal = await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'FEDEX', tipo_envio: 'exportacion',
      numero_guia: '1Z000FRENO00000010', pais_destino: 'Estados Unidos', peso_real: 3,
    }),
  });
  check('un courier inválido también da 400', courierMal.status === 400, `status ${courierMal.status}`);

  const bueno = await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'DHL', tipo_envio: 'importacion',
      numero_guia: '1Z000FRENO00000011', pais_destino: 'China', peso_real: 3,
    }),
  });
  check('y un envío bien formado se sigue creando', bueno.status === 201, `status ${bueno.status}`);

  await new Promise((res) => db.close(() => res()));
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
