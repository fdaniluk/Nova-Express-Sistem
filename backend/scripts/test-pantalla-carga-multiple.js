#!/usr/bin/env node
/**
 * test-pantalla-carga-multiple.js — cargar VARIAS facturas de una, en un navegador.
 *
 * La función nació el 28/08/2026 para recargar las 14 facturas de julio de una sola
 * vez. La prueba usa la factura de ejemplo DOS veces en la misma selección: la
 * primera carga entra limpia y la segunda choca con "ya estaba cargada", así que un
 * solo escenario ejercita el lote entero, la pregunta única de sobreescribir y la
 * regla de que sobreescribir REEMPLAZA (queda una sola cabecera en la base).
 *
 *   cd backend && node scripts/test-pantalla-carga-multiple.js
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.log('⚠ playwright no está instalado — se saltea (necesita navegador de verdad).');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3946;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_carga_multiple.db';
const TOKEN = 'token-test-carga-multiple';
const PDF = path.join(__dirname, '..', '..', 'facturas-ejemplo', 'factura_test_ups.pdf');

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
  // Guard de doble kill + espera del exit: ver el comentario largo en
  // test-pantalla-sin-envio.js — en Windows, matar dos veces o salir antes de que el
  // hijo muera revienta libuv y corta el `npm test` a la mitad sin fallar ningún test.
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

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await abrirSesion(DB, TOKEN);

  // Base limpia de facturas para que la primera carga del lote entre sin conflicto.
  await q('DELETE FROM factura_guias');
  await q('DELETE FROM facturas_cargadas');

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

  console.log('\n1. La selección acepta varios PDFs\n');
  await page.goto(BASE + '/pages/facturas.html', { waitUntil: 'networkidle' });
  await esperar(800);

  check('el selector de archivos acepta varios',
    await page.evaluate(() => document.getElementById('fac-file-input').multiple === true));

  // El mismo PDF dos veces: la segunda va a chocar con "ya estaba cargada".
  await page.setInputFiles('#fac-file-input', [PDF, PDF]);
  await esperar(300);

  check('avisa cuántas facturas se eligieron',
    /2 facturas/.test(await page.evaluate(() => document.getElementById('fac-filename').textContent)));
  check('el botón acompaña ("Cargar 2 facturas")',
    /2 facturas/i.test(await page.evaluate(() => document.getElementById('btn-cargar').textContent)));

  console.log('\n2. El lote se carga de a uno y pregunta UNA sola vez por las repetidas\n');
  await page.click('#btn-cargar');

  // La primera carga entra, la segunda es la misma factura → aparece la pregunta.
  await page.waitForFunction(
    () => !document.getElementById('fac-confirm').classList.contains('hidden'),
    { timeout: 30000 });

  const msg = await page.evaluate(() => document.getElementById('fac-confirm-msg').textContent);
  check('la pregunta dice cuántas ya estaban cargadas', /1 factura ya estaba/.test(msg), msg.slice(0, 90));

  const tabla1 = await page.evaluate(() => document.getElementById('fac-lote-body').textContent);
  check('la tabla del lote muestra la que entró', /✓ Cargada/.test(tabla1), tabla1.slice(0, 120));
  check('y la que ya estaba, sin tocar todavía', /Ya estaba cargada/.test(tabla1), tabla1.slice(0, 120));
  check('con el número de factura a la vista', /0020-00074402/.test(tabla1), tabla1.slice(0, 120));

  console.log('\n3. Sobreescribir reemplaza y el lote termina\n');
  await page.click('#btn-sobreescribir');
  await page.waitForFunction(
    () => /Sobreescrita/.test(document.getElementById('fac-lote-body').textContent),
    { timeout: 30000 });
  await esperar(500);

  const titulo = await page.evaluate(() => document.getElementById('fac-lote-titulo').textContent);
  check('el título cierra la cuenta ("2 de 2")', /2 de 2/.test(titulo), titulo);

  const cab = await q("SELECT COUNT(*) n FROM facturas_cargadas WHERE numero_factura = '0020-00074402'");
  check('en la base queda UNA sola cabecera (sobreescribir reemplazó)', cab[0].n === 1, `hay ${cab[0].n}`);
  const det = await q(`SELECT COUNT(*) n FROM factura_guias fg
    JOIN facturas_cargadas fc ON fc.id = fg.factura_id WHERE fc.numero_factura = '0020-00074402'`);
  check('y el detalle una sola vez (10 guías)', det[0].n === 10, `${det[0].n} filas`);

  console.log('\n4. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|net::ERR|Failed to load resource/i.test(x));
  check('ningún error en la pantalla', rel.length === 0, rel.slice(0, 2).join(' | '));

  await browser.close();
  await new Promise((res) => db.close(() => res()));
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
