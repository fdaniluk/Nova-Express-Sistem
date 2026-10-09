#!/usr/bin/env node
// Escalones al revés en la matriz (09/10/2026): un tramo con menos % que el anterior hace
// que un envío más pesado salga más barato (GIANNASTACIO, UPS zona 5: 105 % en 45–50 y 90 %
// en 50+). El motor está bien; la matriz avisa. API + pantalla del perfil del cliente.
let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3980;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_saltos.db';
const TOKEN = 'token-test-saltos';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const cli = (await J('POST', '/clientes', { nombre: 'GIANNASTACIO PRUEBA', tarifa_pct: 90, tipo_cobro: 'CC' })).body;
  const celda = (zona, peso_min, peso_max, profit_pct) => J('PUT', `/clientes/${cli.id}/profit-matrix`, { servicio: 'UPS_EXP', tipo: 'export', zona, peso_min, peso_max, profit_pct });
  check('fixture: cliente al 90 %', cli && cli.id);
  let m = (await J('GET', `/clientes/${cli.id}/profit-matrix?servicio=UPS_EXP&tipo=export`)).body;
  check('sin celdas no hay saltos', Array.isArray(m.saltos) && m.saltos.length === 0, JSON.stringify(m.saltos));
  const c1 = await celda(5, 30, 40, 105); const c2 = await celda(5, 40, 50, 105);
  check('fixture: zona 5 con 105 % en 30–40 y 40–50 (el 50+ queda en el 90 % general)', c1.status < 300 && c2.status < 300, JSON.stringify(c1.body).slice(0, 120));
  m = (await J('GET', `/clientes/${cli.id}/profit-matrix?servicio=UPS_EXP&tipo=export`)).body;
  check('detecta el salto en zona 5 a los 50 kg (105 % → 90 %)', m.saltos.length === 1 && m.saltos[0].zona === 5 && m.saltos[0].peso === 50 && m.saltos[0].desde_pct === 105 && m.saltos[0].hasta_pct === 90, JSON.stringify(m.saltos));
  check('con el precio antes y después (baja)', m.saltos[0] && m.saltos[0].precio_despues < m.saltos[0].precio_antes && m.saltos[0].precio_antes > 480, JSON.stringify(m.saltos[0]));
  check('no acusa el borde 30–40 → 40–50 (mismo %)', !m.saltos.some((x) => x.peso === 40));
  await celda(5, 50, null, 105);
  m = (await J('GET', `/clientes/${cli.id}/profit-matrix?servicio=UPS_EXP&tipo=export`)).body;
  check('corregido el 50+ al 105 %, desaparece', m.saltos.length === 0, JSON.stringify(m.saltos));
  await celda(5, 50, null, 90);

  if (!chromium) { console.log('⚠ sin playwright: se saltea la pantalla'); console.log(`\n${ok} pasaron · ${fail} fallaron`); matar(); process.exit(fail ? 1 : 0); }
  const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  await page.goto(`${BASE}/pages/clientes-perfil.html?id=${cli.id}`);
  await esperar(1500);
  await page.click('#btn-editar-tarifas');
  await esperar(2500);
  const aviso = await page.$('.tarifas-saltos[data-serv="UPS_EXP"][data-tipo="export"]');
  check('el perfil muestra el aviso rojo arriba de la grilla UPS Expedited', !!aviso);
  if (aviso) check('y nombra la zona, el peso y los dos %', /Zona 5: a los 50 kg pasa de 105 % .* a 90 %/.test(await aviso.textContent()), await aviso.textContent());
  check('las dos celdas del escalón quedan en rojo', (await page.$$('td.tarifa-cell.salto[data-serv="UPS_EXP"][data-tipo="export"][data-zona="5"]')).length === 2, String((await page.$$('td.tarifa-cell.salto')).length));
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  await browser.close(); matar();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1500).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
