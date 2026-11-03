#!/usr/bin/env node
// La flecha "atrás" del navegador vuelve un paso dentro del sistema (03/11/2026, main.js):
// cierra el panel del detalle del Dashboard, cierra el modal de Salidas, vuelve a la pestaña
// anterior en Liquidaciones; y si la capa se cerró a mano, "atrás" sí cambia de módulo
// (no queda un paso fantasma).
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3983;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_atras.db';
const TOKEN = 'token-test-atras';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
function sql(q, p = []) { return new Promise((res, rej) => { const d = new sqlite3.Database(DB); d.all(q, p, (e, r) => { d.close(() => (e ? rej(e) : res(r || []))); }); }); }

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  const uid = await abrirSesion(DB, TOKEN);
  await sql('UPDATE usuarios SET ver_dashboard = 1 WHERE id = ?', [uid]);
  const J = (m, u, b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const hoy = require('../src/utils/fecha').hoyLocal();
  const cli = (await J('POST', '/api/clientes', { nombre: 'ATRAS SA', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  const env = (await J('POST', '/api/envios', { cliente_id: cli.id, fecha: hoy, courier: 'UPS', servicio_ups: 'UPS_SAV', tipo_envio: 'exportacion', numero_guia: '1Z000ATRAS0000001', pais_destino: 'Estados Unidos', peso_real: 5, largo: 30, ancho: 20, alto: 20, fob: 100, total_cobrado: 200 })).body;
  check('fixture: un envío de hoy', env && env.id, JSON.stringify(env));

  const exe = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  const pagina = () => page.url().split('/').pop().split('?')[0];

  console.log('\n1. Dashboard: tocar una tarjeta y volver con la flecha\n');
  await page.goto(`${BASE}/pages/envios.html`); await esperar(1200);
  await page.click('.sidebar-nav a[href="../index.html"]'); await page.waitForURL(/index\.html/); await esperar(1500);
  await page.click('.dash-kpi[data-kpi="kg_fact"]'); await esperar(1200);
  check('el panel del detalle está abierto', await page.isVisible('#dash-detalle'));
  await page.goBack(); await esperar(500);
  check('"atrás" cierra el panel y sigue en el Dashboard', !(await page.isVisible('#dash-detalle')) && pagina() === 'index.html', pagina());
  await page.goBack(); await esperar(800);
  check('otro "atrás" recién ahí vuelve a Envíos', pagina() === 'envios.html', pagina());

  console.log('\n2. Si la capa se cerró a mano, no queda un paso fantasma\n');
  await page.goto(`${BASE}/index.html`); await esperar(1500);
  await page.click('.dash-kpi[data-kpi="envios"]'); await esperar(1000);
  await page.click('#dash-detalle-cerrar'); await esperar(500);
  check('cerrado con el botón del sistema', !(await page.isVisible('#dash-detalle')));
  await page.goBack(); await esperar(800);
  check('"atrás" va directo a la pantalla anterior (Envíos)', pagina() === 'envios.html', pagina());

  console.log('\n3. Liquidaciones: las pestañas también\n');
  await page.goto(`${BASE}/pages/liquidaciones.html`); await esperar(1200);
  await page.click('button[data-tab="crear"]'); await esperar(300);
  await page.click('button[data-tab="cargos"]'); await esperar(300);
  const activa = () => page.$eval('button[data-tab].active', (b) => b.dataset.tab);
  check('estamos en Cargos pendientes', (await activa()) === 'cargos');
  await page.goBack(); await esperar(400);
  check('"atrás" vuelve a Crear', (await activa()) === 'crear' && pagina() === 'liquidaciones.html', await activa());
  await page.goBack(); await esperar(400);
  check('   y después a Pendientes', (await activa()) === 'pendientes', await activa());
  await page.goForward(); await esperar(400);
  check('   "adelante" vuelve a Crear', (await activa()) === 'crear', await activa());

  console.log('\n4. Salidas: el modal del envío\n');
  await page.goto(`${BASE}/pages/salidas.html`); await esperar(2000);
  await page.click('text=1Z000ATRAS0000001'); await esperar(800);
  check('el modal está abierto', await page.isVisible('#sal-edit-overlay'));
  await page.goBack(); await esperar(600);
  check('"atrás" lo cierra y sigue en Salidas', !(await page.isVisible('#sal-edit-overlay')) && pagina() === 'salidas.html', pagina());
  await page.click('text=1Z000ATRAS0000001'); await esperar(800);
  await page.click('#sal-modal-cancel'); await esperar(500);
  await page.click('text=1Z000ATRAS0000001'); await esperar(800);
  check('abrir, cancelar y abrir de nuevo: sigue abierto', await page.isVisible('#sal-edit-overlay'));
  await page.goBack(); await esperar(600);
  check('   y un solo "atrás" lo cierra sin salir de Salidas', !(await page.isVisible('#sal-edit-overlay')) && pagina() === 'salidas.html', pagina());

  check('sin errores de JS', errores.length === 0, errores.join(' | '));
  await browser.close();
  matar();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
