#!/usr/bin/env node
// Capturas de las pantallas con la marca aplicada (para mostrarle a Felipe). No es una tanda.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = 3976; const BASE = `http://localhost:${PORT}`;
const DB = '/tmp/demo_marca.db'; const TOKEN = 'token-demo-marca';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
const OUT = '/tmp/marca-shots'; fs.mkdirSync(OUT, { recursive: true });
function sql(q, p = []) { return new Promise((res, rej) => { const d = new sqlite3.Database(DB); d.all(q, p, (e, r) => { d.close(() => (e ? rej(e) : res(r || []))); }); }); }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logOut = ''; let logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; }); srv.stderr.on('data', (d) => { logErr += d; });
  process.on('exit', () => { try { srv.kill(); } catch { /* */ } });
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  const uid = await abrirSesion(DB, TOKEN);
  await sql('UPDATE usuarios SET ver_dashboard = 1 WHERE id = ?', [uid]);
  const cli = await (await fetch(`${BASE}/api/clientes`, { method: 'POST', headers: H, body: JSON.stringify({ nombre: 'Laboratorio Andes', tarifa_pct: 80 }) })).json();
  const hoy = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < 6; i++) await fetch(`${BASE}/api/envios`, { method: 'POST', headers: H, body: JSON.stringify({ fecha: hoy, courier: i % 2 ? 'DHL' : 'UPS', tipo_envio: 'exportacion', pais_destino: 'Estados Unidos', peso_real: 3 + i, largo: 30, ancho: 20, alto: 20, cliente_id: cli.id, numero_guia: `1Z0000000${i}`, total_cobrado: 200 + i * 40 }) });
  const rl = await fetch(`${BASE}/api/cotizador-links`, { method: 'POST', headers: H, body: JSON.stringify({ cliente_id: cli.id, couriers: 'ambos', dias: 30 }) });
  const LINK = await rl.json();

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 1.5 });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const shot = async (url, name, wait = 1500, full = false) => {
    await page.goto(`${BASE}/${url}`, { waitUntil: 'networkidle' }).catch(() => {});
    await esperar(wait);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
    console.log('✓', name);
  };
  await shot('index.html', 'dashboard', 2000);
  await shot('pages/cotizador.html', 'cotizador', 1500);
  await shot('pages/salidas.html', 'salidas', 1500);
  await shot(`pages/clientes-perfil.html?id=${cli.id}`, 'perfil', 1500);
  await shot(`pages/tarifario.html?cliente=${cli.id}&servicios=DHL,UPS_EXP&tipo=exportacion&desde=0.5&hasta=10&paso=0.5&marca=nova`, 'tarifario', 2000, true);
  // público (sin sesión)
  const pub = await (await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1.5 })).newPage();
  await pub.goto(`${BASE}/pages/login.html`); await esperar(800); await pub.screenshot({ path: `${OUT}/login.png` }); console.log('✓ login');
  await pub.goto(`${BASE}/cotizar/${LINK.codigo}`, { waitUntil: 'networkidle' }); await esperar(800); await pub.screenshot({ path: `${OUT}/link-publico.png`, fullPage: true }); console.log('✓ link');
  await browser.close();
  srv.kill();
}
main().catch((e) => { console.error(e); process.exit(1); });
