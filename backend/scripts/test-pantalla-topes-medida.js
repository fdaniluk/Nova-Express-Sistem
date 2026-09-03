#!/usr/bin/env node
/**
 * test-pantalla-topes-medida.js — los topes de medida EN LA PANTALLA del cotizador.
 *
 * La matemática (y sobre todo la regla de que el tope NO mueve el precio) la clava
 * test-topes-medida.js. Esto controla lo otro: que la oficina VEA el aviso antes de pasar
 * el precio — abajo del bulto mientras lo tipea, y arriba de los resultados al cotizar —
 * y que la cotización igual salga, porque son avisos y no bloqueos.
 *
 * Reproduce el caso que le dio origen: la alfombra de 2,80 m a Australia (27/08/2026).
 *
 *   cd backend && node scripts/test-pantalla-topes-medida.js
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

const PORT = process.env.PORT_TEST || 3942;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_topes.db';
const TOKEN = 'token-test-topes';

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

  // Sin fuel cargado la pantalla no cotiza (regla del cotizador).
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));
  await q("INSERT OR REPLACE INTO configuracion_nova (id, fuel_pct, fecha_actualizacion) VALUES (1, 37, datetime('now'))");
  await new Promise((res) => db.close(() => res()));

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));

  await page.goto(BASE + '/pages/cotizador.html', { waitUntil: 'networkidle' });
  await esperar(800);

  const llenarBulto = async (pr, l, a, al) => {
    await page.fill('.bulto-row .b-peso', String(pr));
    await page.fill('.bulto-row .b-largo', String(l));
    await page.fill('.bulto-row .b-ancho', String(a));
    await page.fill('.bulto-row .b-alto', String(al));
    await page.dispatchEvent('.bulto-row .b-alto', 'input');
    await esperar(300);
  };
  const infoBulto = () => page.evaluate(() => {
    const el = document.querySelector('[id^="info-bulto-"]');
    return el ? el.textContent : '';
  });

  console.log('\n1. La alfombra de 2,80 m: el aviso aparece mientras se tipea\n');
  await page.selectOption('#tipo', 'export');
  await page.selectOption('#pais', { label: 'Australia' }).catch(() => page.selectOption('#pais', 'Australia'));
  await page.selectOption('#couriers', 'ambos');
  await page.fill('#valor', '400');
  const conCliente = await page.evaluate(() => {
    const g = document.getElementById('ganancia');
    return g && g.disabled;
  });
  if (!conCliente) await page.fill('#ganancia', '50');
  await llenarBulto(30, 280, 60, 20);

  let info = await infoBulto();
  check('el textito del bulto avisa el lado de 274', /lado >274cm/.test(info), info);
  check('y dice NO APTO para UPS', /NO APTO para UPS/.test(info), info);
  check('también avisa que pasa la pieza de DHL', /pieza de DHL/.test(info), info);
  check('el renglón queda pintado de aviso',
    await page.evaluate(() => document.querySelector('[id^="info-bulto-"]').className === 'bulto-warn'));

  console.log('\n2. Al cotizar, el aviso sube arriba de los resultados\n');
  await page.click('.btn-calc');
  await esperar(1500);
  const err = await page.evaluate(() => {
    const el = document.getElementById('error-msg');
    return el && el.style.display !== 'none' ? el.textContent : '';
  });
  check('avisa por el lado de más de 274 cm', /274 cm/.test(err), err.slice(0, 160));
  check('dice cuánto mide el bulto (280 cm)', /280 cm/.test(err), err.slice(0, 160));
  check('avisa que UPS no acepta piezas así', /UPS no acepta/.test(err), err.slice(0, 160));
  check('y el aviso de DHL viene rotulado como de DHL', /DHL: ⚠/.test(err), err.slice(0, 200));

  console.log('\n3. AVISA, NO FRENA: la cotización igual sale\n');
  const res = await page.evaluate(() => document.getElementById('results').textContent);
  check('la tarjeta de UPS igual se muestra', /UPS/.test(res), res.slice(0, 120));
  check('la de DHL también', /DHL/.test(res), res.slice(0, 120));
  check('y hay un precio a la vista', /USD/.test(res), res.slice(0, 120));

  console.log('\n4. Un bulto dentro de los topes no ensucia la pantalla\n');
  await llenarBulto(15, 60, 40, 30);
  info = await infoBulto();
  check('el textito no avisa nada', !/NO APTO|pieza de DHL/.test(info), info);
  check('y vuelve al color normal',
    await page.evaluate(() => document.querySelector('[id^="info-bulto-"]').className === 'bulto-info'));
  await page.click('.btn-calc');
  await esperar(1500);
  const err2 = await page.evaluate(() => {
    const el = document.getElementById('error-msg');
    return el && el.style.display !== 'none' ? el.textContent : '';
  });
  check('arriba de los resultados no queda ningún tope', !/274|no acepta|pieza estándar/.test(err2), err2.slice(0, 160));

  console.log('\n5. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|Failed to load resource/i.test(x));
  check('ningún error en la pantalla', rel.length === 0, rel.slice(0, 2).join(' | '));

  await browser.close();
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
