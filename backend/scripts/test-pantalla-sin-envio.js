#!/usr/bin/env node
/**
 * test-pantalla-sin-envio.js — la pestaña "Sin envío" en un navegador de verdad.
 *
 * El endpoint lo cubre test-guias-sin-envio.js. Esto controla lo otro: que la pestaña
 * exista, que se pueda abrir y que pinte las filas.
 * Un endpoint perfecto con una pestaña que no abre no le sirve a nadie.
 *
 *   cd backend && node scripts/test-pantalla-sin-envio.js
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.log('⚠ playwright no está instalado — se saltea (necesita navegador de verdad).');
  process.exit(0);
}

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
// Arranque común: base de test fresca (copia de producción) y sesión válida.
// Ver scripts/_base-test.js para por qué hace falta.
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3990;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_sin_envio.db';
const TOKEN = 'token-test-pantalla-sin-envio';
const PDF = path.join(__dirname, '..', '..', 'facturas-ejemplo', 'factura_test_ups.pdf');

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Base de test: copia FRESCA de la de producción en cada corrida.
  prepararDb(DB);

  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  // Si el test se corta por un error, el servidor tiene que morir igual: si queda vivo se
  // queda con el puerto y la corrida siguiente le habla al servidor VIEJO, con la base
  // vieja, y falla con 401 sin motivo aparente.
  // Windows: llamar srv.kill() DOS VECES sobre el mismo handle revienta libuv con
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
  // Pasaba porque el cierre explícito mata el server y, acto seguido, process.exit() dispara
  // este mismo handler, que lo vuelve a matar cuando el handle ya se está cerrando. En Linux
  // no se notaba; en Windows cortaba el `npm test` entero a mitad de la cadena, sin que
  // ningún test hubiera fallado. El guard hace que solo la primera llamada tenga efecto.
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);
  // Matar al server NO es instantaneo: kill() manda la senal y el proceso hijo tarda en
  // morir. Si se llama process.exit() antes de que muera, Node se cae en Windows con
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src/win/async.c, line 94
  // porque el handle del hijo se esta cerrando cuando el proceso ya arranco a salir. No
  // falla ningun test: se muere Node y corta la cadena del `npm test` a la mitad. Esta
  // funcion espera al 'exit' del hijo (con tope de 2 s por si quedara colgado) para que el
  // handle este cerrado ANTES de salir.
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

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await abrirSesion(DB, TOKEN);

  // Se deja la factura de ejemplo cargada con casi todas sus guías sin envío.
  await q('DELETE FROM factura_guias');
  await q('DELETE FROM facturas_cargadas');
  const { extraerFacturaUPS } = require('../src/services/factura-ups.service.js');
  const factura = await extraerFacturaUPS(fs.readFileSync(PDF));
  for (const g of factura.guias) {
    await q('DELETE FROM envio_bultos WHERE envio_id IN (SELECT id FROM envios WHERE numero_guia = ?)', [g.numero_guia]);
    await q('DELETE FROM envios WHERE numero_guia = ?', [g.numero_guia]);
  }
  const fd = new FormData();
  fd.append('pdf', new Blob([fs.readFileSync(PDF)], { type: 'application/pdf' }), 'factura.pdf');
  fd.append('sobreescribir', 'false');
  await fetch(BASE + '/api/facturas/cargar', {
    method: 'POST', headers: { Cookie: `nova_session=${TOKEN}` }, body: fd });
  // `db.close()` de sqlite3 NO es sincronico: encola el cierre en un hilo del pool y avisa
  // por un handle async de libuv. Si el proceso arranca a salir antes de que ese aviso
  // llegue, el hilo termina llamando uv_async_send sobre un handle que YA se esta cerrando
  // y en Windows eso revienta con:
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
  // No falla ningun test: se muere Node y corta la cadena del `npm test` a la mitad. En
  // Linux la carrera casi siempre sale bien y por eso no se veia. Esperar el callback del
  // close es la sincronizacion que faltaba.
  await new Promise((res) => db.close(() => res()));

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errores.push('console: ' + m.text()); });
  const faltantes = [];
  page.on('response', (r) => { if (r.status() === 404) faltantes.push(r.url()); });

  console.log('\n1. La pestaña existe y avisa cuántas hay\n');
  await page.goto(BASE + '/pages/facturas.html', { waitUntil: 'networkidle' });
  await esperar(1200);

  check('está la pestaña "Sin envío"',
    await page.evaluate(() => !!document.querySelector('[data-tab="sinenvio"]')));

  const badge = await page.evaluate(() => {
    const b = document.getElementById('sinenvio-badge');
    return b ? { texto: b.textContent, visible: !b.classList.contains('hidden') } : null;
  });
  check('el contador de la pestaña se ve sin tener que abrirla', badge && badge.visible,
    JSON.stringify(badge));
  check('y dice cuántas guías quedaron sin envío', badge && Number(badge.texto) >= 9,
    badge ? badge.texto : '-');

  console.log('\n2. Al abrirla, muestra las filas\n');
  await page.click('[data-tab="sinenvio"]');
  await esperar(1200);

  check('la pestaña se abre', await page.evaluate(() =>
    !document.getElementById('tab-sinenvio').classList.contains('hidden')));

  const filas = await page.evaluate(() =>
    document.querySelectorAll('#fac-sinenvio-body tr').length);
  check('pinta una fila por guía', filas >= 9, `${filas} filas`);

  const counter = await page.evaluate(() => {
    const c = document.getElementById('fac-sinenvio-counter');
    return c ? c.textContent.trim() : null;
  });
  check('muestra el total de plata facturada', /USD|\$/.test(counter || ''), counter);
  console.log(`\n   ${counter}\n`);

  const texto = await page.evaluate(() =>
    document.getElementById('fac-sinenvio-body').textContent);
  check('las filas muestran los números de guía', /1Z327W/.test(texto), texto.slice(0, 80));

  // No se sugiere ningún envío parecido (ver el comentario en facturas.routes.js).
  check('no aparece ninguna sugerencia de guía parecida',
    !/quisiste|diferencia/i.test(texto), texto.slice(0, 100));

  console.log('3. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|net::ERR/i.test(x));
  const falt = faltantes.filter((u) => !/favicon/i.test(u));
  if (falt.length) console.log('    404: ' + falt.join('\n    404: '));
  // el 404 del favicon no es un problema de la pantalla; cualquier otro sí
  const soloFavicon = falt.length === 0 && rel.every((x) => /Failed to load resource/.test(x));
  check('ningún error en la pantalla', rel.length === 0 || soloFavicon,
    rel.slice(0, 2).join(' | '));

  await browser.close();
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  // Ni siquiera acá se llama process.exit(): matar el proceso a mano es lo que venía
  // reventando en Windows. Se deja el código de salida y Node termina solo cuando no le
  // queda nada pendiente, que es cuando ya no hay ningún handle a medio cerrar.
  // El timer es la red de seguridad por si algo quedara vivo (sockets keep-alive de
  // fetch, por ejemplo): va con .unref(), así NO sostiene el proceso —si no hay nada
  // más, Node sale igual al instante— y solo actúa si a los 3 s todavía sigue en pie.
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
