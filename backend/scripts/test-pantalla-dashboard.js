#!/usr/bin/env node
/**
 * test-pantalla-dashboard.js — el dashboard nuevo (10/09/2026, DASHBOARD-REDISENO.md) en
 * un navegador de verdad. Los números los cuida test-dashboard-analitica.js; acá se mira
 * que la pantalla los pinte: KPIs, los gráficos (Chart.js vendorizado), la tabla de
 * clientes con sus selectores, los filtros que recargan, el Excel y el permiso.
 *
 *   cd backend && node scripts/test-pantalla-dashboard.js
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3968;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_dashboard.db';
const TOKEN = 'token-test-pantalla-dashboard';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0; let fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else { fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarQue(fn, ms = 8000) {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) { if (await fn().catch(() => false)) return true; await esperar(200); }
  return false;
}
function sql(q, p = []) { return new Promise((res, rej) => { const d = new sqlite3.Database(DB); d.all(q, p, (e, r) => { d.close(() => (e ? rej(e) : res(r || []))); }); }); }

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logOut = ''; let logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; }); srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  let muerto = false; const matar = () => { if (!muerto) { muerto = true; try { srv.kill(); } catch { /* ya */ } } };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  const uid = await abrirSesion(DB, TOKEN);
  await sql('UPDATE usuarios SET ver_dashboard = 1 WHERE id = ?', [uid]);
  await sql('INSERT INTO configuracion_nova (id, fuel_pct, margen_objetivo_pct) VALUES (1, 36, 50) ON CONFLICT(id) DO UPDATE SET fuel_pct = 36, margen_objetivo_pct = 50');

  const hoy = new Date().toISOString().slice(0, 10);
  const cli = await (await fetch(`${BASE}/api/clientes`, { method: 'POST', headers: H, body: JSON.stringify({ nombre: 'DASH CLIENTE', tarifa_pct: 80 }) })).json();
  const cli2 = await (await fetch(`${BASE}/api/clientes`, { method: 'POST', headers: H, body: JSON.stringify({ nombre: 'OTRO CLIENTE', tarifa_pct: 80 }) })).json();
  const nuevo = (b) => fetch(`${BASE}/api/envios`, { method: 'POST', headers: H, body: JSON.stringify({ fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion', pais_destino: 'Estados Unidos', peso_real: 5, largo: 30, ancho: 20, alto: 20, ...b }) }).then((r) => r.json());
  await nuevo({ cliente_id: cli.id, numero_guia: '9960000010', total_cobrado: 300 });
  await nuevo({ cliente_id: cli.id, numero_guia: '9960000028', total_cobrado: 200, courier: 'DHL', pais_destino: 'Chile' });
  await nuevo({ cliente_id: cli2.id, numero_guia: '9960000036', total_cobrado: 150 });
  const e4 = await nuevo({ cliente_id: cli2.id, numero_guia: '9960000044', total_cobrado: 999 });
  await sql('UPDATE envios SET no_volo = 1 WHERE id = ?', [e4.id]);
  await sql("UPDATE envios SET costo_facturado = 120, peso_facturado = 5.5, estado_revision = 'revisado_ok', fecha_facturado = ? WHERE numero_guia = '9960000010'", [hoy]);

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errores.push(m.text()); });

  console.log('\n1. La pantalla carga con los números\n');
  await page.goto(`${BASE}/index.html`);
  const cargo = await esperarQue(async () => /→/.test(await page.textContent('#dash-hint')));
  check('carga y el hint muestra el período y la comparación', cargo, await page.textContent('#dash-hint'));
  check('Chart.js está cargado (vendorizado, sin CDN)', await page.evaluate(() => typeof window.Chart === 'function'));
  const kpi = async (k) => (await page.textContent(`.dash-kpi[data-kpi="${k}"] .v`)).replace(/\s+/g, ' ').trim();
  check('KPI Envíos = 3 (el NO VOLÓ no cuenta)', (await kpi('envios')) === '3', await kpi('envios'));
  check('KPI Venta = USD 650', /USD 650/.test(await kpi('venta')), await kpi('venta'));
  check('KPI Sin liquidar = 3 envíos', /^3 envíos/.test(await kpi('sin_liquidar')), await kpi('sin_liquidar'));
  check('los cuadros de KPI tienen su mini-línea dibujada', await page.evaluate(() => document.querySelectorAll('.dash-kpi canvas.sp').length >= 5));
  const conGrafico = await page.evaluate(() => ['c-mes', 'c-mix', 'c-pais', 'c-compra', 'c-profit', 'c-peso', 'c-margen'].filter((id) => { const c = document.getElementById(id); return c && c.width > 0 && window.Chart.getChart(c); }));
  check('los 7 gráficos están dibujados', conGrafico.length === 7, conGrafico.join(','));
  check('la línea de objetivo dice 50% (Configuración)', /objetivo 50%/.test(await page.textContent('#dash-margen-obj')), await page.textContent('#dash-margen-obj'));

  console.log('\n2. Top clientes y selectores\n');
  const filas = () => page.$$eval('#dash-top tbody tr', (trs) => trs.map((t) => t.textContent.replace(/\s+/g, ' ').trim()));
  let f = await filas();
  check('2 clientes, DASH CLIENTE primero por venta (500)', f.length === 2 && /DASH CLIENTE/.test(f[0]) && /500/.test(f[0]), f.join(' | '));
  check('el nombre del cliente es un link a su perfil', await page.$eval('#dash-top tbody a', (a) => /clientes-perfil\.html\?id=/.test(a.getAttribute('href'))));
  check('el pie cuenta los clientes con envíos', /2 clientes con envíos/.test(await page.textContent('#dash-top-pie')), await page.textContent('#dash-top-pie'));
  await page.click('#seg-top button[data-m="envios"]');
  await esperar(200);
  f = await filas();
  check('ordenar por Envíos mantiene a DASH CLIENTE primero (2 envíos)', /DASH CLIENTE/.test(f[0]));
  await page.selectOption('#dash-top-n', '5');
  await esperar(200);
  check('"Ver 5" sigue mostrando los 2', (await filas()).length === 2);
  await page.click('#seg-mes button[data-m="venta"]');
  await esperar(200);
  check('el selector del gráfico por mes cambia el subtítulo', /venta en USD/.test(await page.textContent('#dash-mes-sub')), await page.textContent('#dash-mes-sub'));
  await page.click('#seg-pais button[data-m="kg"]');
  await esperar(200);
  check('el de destinos también', /por kg/.test(await page.textContent('#dash-pais-sub')));

  console.log('\n3. Estimado vs real, plata, ritmo\n');
  check('hay guías cruzadas → se ve el bloque estimado vs real', await page.$eval('#dash-real', (el) => !el.classList.contains('hidden')));
  check('la cobertura del mes está pintada (1 de 3 → 33%)', /33% cruzado/.test(await page.textContent('#cob-compra')), await page.textContent('#cob-compra'));
  check('avisa que el mes está parcial', await page.$eval('#dash-real-aviso', (el) => !el.classList.contains('hidden') && /parciales/.test(el.textContent)));
  const plata = await page.textContent('#dash-plata');
  check('plata en la calle: 3 envíos sin liquidar', /Envíos sin liquidar\s*3/.test(plata.replace(/\s+/g, ' ')), plata.replace(/\s+/g, ' ').slice(0, 80));
  check('los renglones de plata abren pantallas', await page.$$eval('#dash-plata a', (as) => as.length === 4 && as.every((a) => /pages\//.test(a.getAttribute('href')))));
  check('ritmo: kg por envío 5,0', /Kg por envío\s*5,0/.test((await page.textContent('#dash-ritmo')).replace(/\s+/g, ' ')));

  console.log('\n4. Filtros recargan\n');
  await page.click('.dash-courier[data-courier="DHL"]');
  const dhl = await esperarQue(async () => (await kpi('envios')) === '1');
  check('courier DHL → 1 envío', dhl, await kpi('envios'));
  check('el botón DHL queda marcado', await page.$eval('.dash-courier[data-courier="DHL"]', (b) => b.classList.contains('active')));
  await page.click('.dash-courier[data-courier=""]');
  await esperarQue(async () => (await kpi('envios')) === '3');
  await page.selectOption('#dash-comparar', 'anio');
  const anio = await esperarQue(async () => /comparado con/.test(await page.textContent('#dash-hint')) && /vs\. año pasado|sin datos/.test(await page.textContent('.dash-kpi[data-kpi="venta"] .d')));
  check('comparar con el año pasado recarga', anio);
  await page.click('.dash-per[data-periodo="mes"]');
  await esperar(600);
  check('"Este mes" deja un solo mes en el gráfico', await page.evaluate(() => window.Chart.getChart(document.getElementById('c-mes')).data.labels.length === 1));
  const excel = await page.$eval('#dash-excel', (a) => a.href);
  check('el botón Excel apunta al xlsx con los mismos filtros', /analitica\.xlsx\?periodo=mes/.test(excel) && /comparar=anio/.test(excel), excel);
  const r = await fetch(excel, { headers: H });
  check('y el xlsx baja (200)', r.status === 200 && /spreadsheetml/.test(r.headers.get('content-type')));

  console.log('\n5. Sin permiso no se ve\n');
  await sql('UPDATE usuarios SET ver_dashboard = 0 WHERE id = ?', [uid]);
  await page.goto(`${BASE}/index.html`);
  await esperar(1500);
  const url = page.url();
  check('sin ver_dashboard el auth-guard saca de la pantalla', !/index\.html$/.test(url) || !(await page.$('#dash-kpis')) || (await page.textContent('#dash-hint')) === 'Sin datos', url);

  console.log('\n6. Sin errores de JavaScript\n');
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  await browser.close(); matar();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('✗ error inesperado:', e); process.exit(1); });
