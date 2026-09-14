#!/usr/bin/env node
/**
 * _capturas-cotizador.js — capturas de la pantalla Cotizador para mostrarle el rediseño
 * a Felipe (14/09/2026). NO es una tanda: no verifica nada, solo saca fotos.
 *
 *   cd backend && node scripts/_capturas-cotizador.js
 *
 * Deja los PNG en backend/_capturas/.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('playwright no esta instalado'); process.exit(0); }

const PORT = 3932;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(require('os').tmpdir(), 'nova-capturas-cotizador.db');
const TOKEN = 'tok-capturas-cotizador';
const SALIDA = path.join(__dirname, '..', '_capturas');

(async () => {
  fs.mkdirSync(SALIDA, { recursive: true });
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; });
  process.on('exit', () => { try { srv.kill(); } catch {} });

  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

  await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H,
    body: JSON.stringify({ nombre: 'ASAPLAST S.R.L.', tarifa_pct: 75, tipo_cobro: 'CC' }),
  });

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();

  await page.goto(BASE + '/pages/cotizador.html');
  await page.waitForTimeout(900);

  // Paso 1 y 2
  await page.selectOption('#pais', { label: 'Brasil' }).catch(async () => {
    const v = await page.$eval('#pais', (s) => s.options[1].value); await page.selectOption('#pais', v);
  });
  const b1 = await page.$$('.bulto-row');
  await b1[0].$eval('.b-peso', (e) => { e.value = '12.5'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await b1[0].$eval('.b-largo', (e) => { e.value = '45'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await b1[0].$eval('.b-ancho', (e) => { e.value = '45'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await b1[0].$eval('.b-alto', (e) => { e.value = '35'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('.btn-add');
  const b2 = await page.$$('.bulto-row');
  await b2[1].$eval('.b-peso', (e) => { e.value = '8.2'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await b2[1].$eval('.b-largo', (e) => { e.value = '40'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await b2[1].$eval('.b-ancho', (e) => { e.value = '30'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await b2[1].$eval('.b-alto', (e) => { e.value = '30'; e.dispatchEvent(new Event('input', { bubbles: true })); });

  // Paso 3 y 4
  await page.$eval('#valor', (e) => { e.value = '250'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.check('#ex_ddp');
  await page.selectOption('#cliente', { label: 'ASAPLAST S.R.L.' }).catch(() => {});
  await page.selectOption('#fuel_fuente', 'manual');
  await page.$eval('#fuel', (e) => { e.value = '30.5'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(400);

  await page.screenshot({ path: path.join(SALIDA, 'cotizador-1-carga.png'), fullPage: true });

  await page.click('.btn-calc');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(SALIDA, 'cotizador-2-resultado.png'), fullPage: true });

  // Como lo ve alguien con la pantalla angosta (la notebook de la oficina)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SALIDA, 'cotizador-3-angosto.png'), fullPage: true });

  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  console.log('capturas en', SALIDA, errores.length ? ('ERRORES JS: ' + errores.join(' | ')) : '· sin errores de JS');
  await browser.close();
  try { srv.kill(); } catch {}
  process.exit(0);
})();
