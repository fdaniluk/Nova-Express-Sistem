#!/usr/bin/env node
/**
 * _capturas-liquidaciones.js — capturas de la pantalla Liquidaciones para mostrarle el
 * rediseño a Felipe (16/09/2026). NO es una tanda: no verifica nada, solo saca fotos.
 *
 *   cd backend && node scripts/_capturas-liquidaciones.js
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

const PORT = 3933;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(require('os').tmpdir(), 'nova-capturas-liquidaciones.db');
const TOKEN = 'tok-capturas-liq';
const SALIDA = path.join(__dirname, '..', '_capturas');
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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

  const hoy = new Date();
  const dia = (n) => iso(new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - n));
  const cliente = async (nombre, tipo) => (await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H, body: JSON.stringify({ nombre, tarifa_pct: 75, tipo_cobro: tipo }),
  })).json()).id;
  const alta = (cliente_id, guia, fecha, courier, pais, peso, total, fob) => fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id, fecha, courier, tipo_envio: 'exportacion', servicio_ups: courier === 'UPS' ? 'UPS_EXP' : undefined,
      numero_guia: guia, pais_destino: pais, peso_real: peso, largo: 40, ancho: 30, alto: 25,
      fob, total_cobrado: total,
    }),
  }).then((r) => r.json());

  const asaplast = await cliente('ASAPLAST S.R.L.', 'S');
  const cueros = await cliente('CUEROS SANTA CRUZ', 'CC');
  const numana = await cliente('NUMANA', 'D');
  await alta(asaplast, '1Z327W090491234567', dia(9), 'UPS', 'Estados Unidos', 12.5, 236.4, 500);
  await alta(asaplast, '1Z327W090491234580', dia(6), 'UPS', 'Chile', 4, 118.2, 250);
  await alta(asaplast, '4412345678', dia(2), 'DHL', 'España', 22, 402.7, 1200);
  await alta(cueros, '1Z327W090491234601', dia(12), 'UPS', 'Italia', 30, 566.1, 2000);
  await alta(cueros, '1Z327W090491234615', dia(4), 'UPS', 'Italia', 28.5, 540.8, 1800);
  await alta(numana, '1Z327W090491234700', dia(1), 'UPS', 'México', 8, 157.48, 300);

  // Una confirmada y un borrador para el historial
  const liq = await (await fetch(BASE + '/api/liquidaciones/pendientes?cliente_id=' + numana, { headers: H })).json();
  const ids = liq[0].envios.map((e) => e.id);
  await fetch(BASE + '/api/liquidaciones', { method: 'POST', headers: H, body: JSON.stringify({
    cliente_id: numana, periodo_desde: dia(30), periodo_hasta: dia(0), envio_ids: ids, cargos: [], cotizaciones: [], confirmar: true }) });

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));

  await page.goto(BASE + '/pages/liquidaciones.html');
  await page.waitForSelector('#pendientes-list .cliente-grupo');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SALIDA, 'liquidaciones-1-pendientes.png'), fullPage: true });

  await page.click('#pendientes-list .cliente-grupo button[data-liq-cliente]');
  await page.waitForSelector('#liq-envios-body tr[data-envio-id]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SALIDA, 'liquidaciones-2-crear.png'), fullPage: true });

  await page.$eval('#liq-envios-body tr:nth-child(2) .liq-adicional', (e) => { e.value = '15'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#btn-preview');
  await page.waitForSelector('#liq-preview:not(.hidden)');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SALIDA, 'liquidaciones-3-calculada.png'), fullPage: true });

  await page.click('.tab[data-tab="historial"]');
  await page.waitForSelector('#hist-body tr');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SALIDA, 'liquidaciones-4-historial.png'), fullPage: true });

  // Teléfono
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('.tab[data-tab="pendientes"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SALIDA, 'liquidaciones-5-telefono-pendientes.png'), fullPage: true });
  await page.click('.tab[data-tab="crear"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SALIDA, 'liquidaciones-6-telefono-crear.png'), fullPage: true });

  console.log(errores.length ? 'ERRORES JS: ' + errores.join(' | ') : 'sin errores de JS');
  console.log('capturas en', SALIDA);
  await browser.close();
  srv.kill();
})();
