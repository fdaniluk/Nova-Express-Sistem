#!/usr/bin/env node
// Costos de la empresa en el Dashboard (entrega 2, 09/10/2026): tarjeta con costos del
// período, resultado neto (profit − costos), punto de equilibrio del mes y gráfico profit vs.
// costos. Solo la ve quien tiene permiso de costos; el empleado no la ve y nada se rompe.
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3984;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_dash_costos.db';
const ADMIN = 'token-test-dash-costos-admin';
const EMP = 'token-test-dash-costos-emp';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${ADMIN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, ADMIN);
  const sqlite3 = require('sqlite3'); const db = new sqlite3.Database(DB);
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
  const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await run('UPDATE usuarios SET ver_dashboard = 1 WHERE id = 1');
  await run("INSERT INTO usuarios (usuario, password_hash, rol, activo, ver_dashboard) VALUES ('emp_dash', 'x', 'empleado', 1, 1)");
  const emp = await get("SELECT id FROM usuarios WHERE usuario = 'emp_dash'");
  await run('INSERT INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?, ?, ?)', [crypto.createHash('sha256').update(EMP).digest('hex'), emp.id, '2099-01-01 00:00:00']);
  const J = (m, u, b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  // Fixture: un envío este mes con profit conocido y costos en el mes en curso y el anterior.
  const hoy = new Date();
  const mes = iso(hoy).slice(0, 7);
  const antD = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 15);
  const mesAnt = iso(antD).slice(0, 7);
  const cli = (await J('POST', '/api/clientes', { nombre: 'DASH COSTOS', tarifa_pct: 50, tipo_cobro: 'CC' })).body;
  const alta = (fecha, guia, total) => J('POST', '/api/envios', { cliente_id: cli.id, fecha, courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP', numero_guia: guia, pais_destino: 'Estados Unidos', peso_real: 5, largo: 30, ancho: 20, alto: 15, fob: 50, total_cobrado: total });
  const e1 = (await alta(iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), '1Z000DASHCOST00001', 1000)).body;
  const e2 = (await alta(iso(antD), '1Z000DASHCOST00002', 1000)).body;
  check('fixture: dos envíos (este mes y el anterior)', e1 && e1.id && e2 && e2.id, JSON.stringify(e1).slice(0, 120));
  const cats = (await J('GET', '/api/costos/categorias')).body;
  const cat = cats.find((c) => /Alquiler/.test(c.nombre)) || cats[0];
  const c1 = await J('POST', '/api/costos', { mes, categoria_id: cat.id, detalle: 'Alquiler', monto: 300, moneda: 'USD' });
  const c2 = await J('POST', '/api/costos', { mes: mesAnt, categoria_id: cat.id, detalle: 'Alquiler', monto: 5000, moneda: 'USD' });
  check('fixture: costos USD 300 este mes y USD 5.000 el anterior', c1.status < 300 && c2.status < 300, JSON.stringify([c1.body, c2.body]).slice(0, 160));
  const serie = (await J('GET', `/api/costos/serie?desde=${mesAnt}&hasta=${mes}`)).body;
  check('la serie trae por_confirmar por mes', Array.isArray(serie) && serie.length === 2 && serie[1].por_confirmar === 0 && serie[1].costos_usd === 300, JSON.stringify(serie));
  const dash = (await J('GET', '/api/dashboard/analitica?periodo=12m')).body;
  const i = dash.series.meses.indexOf(mes), iAnt = dash.series.meses.indexOf(mesAnt);
  const profitMes = dash.series.profit[i], profitAnt = dash.series.profit[iAnt];
  check('el Dashboard tiene profit en los dos meses', profitMes > 0 && profitAnt > 0, JSON.stringify({ profitMes, profitAnt }));

  const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const errores = [];
  async function pagina(tok) {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await ctx.addCookies([{ name: 'nova_session', value: tok, url: BASE }]);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errores.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errores.push(m.text()); });
    await page.goto(`${BASE}/`);
    await esperar(3000);
    return page;
  }

  console.log('\n1. Dirección\n');
  const A = await pagina(ADMIN);
  check('ve la tarjeta Costos de la empresa', !!(await A.$('#dash-costos:not(.hidden)')));
  const kpis = await A.textContent('#dash-costos-kpis');
  const txt = kpis.replace(/\s+/g, ' ');
  check('costos del período: USD 5.300 (5.000 + 300) en 2 meses', /5\.300|5,3k/.test(txt) && /2 meses con costos/.test(txt), txt.slice(0, 200));
  const neto = Math.round((profitMes + profitAnt - 5300) * 100) / 100;
  const netoTxt = (await A.$eval('[data-costos="neto"] .v', (e) => e.textContent)).trim();
  const clsEsperada = neto >= 0 ? 'ok' : 'neg';
  const tieneCls = await A.$eval('[data-costos="neto"] .v', (e, c) => e.classList.contains(c), clsEsperada);
  check(`resultado neto = profit − costos (${neto.toFixed(2)}, ${clsEsperada})`, /USD/.test(netoTxt) && tieneCls, `${netoTxt} vs ${neto}`);
  check('con el texto de si cubre o no', neto >= 0 ? /se llevan el .* % del profit/.test(txt) : /superan al profit/.test(txt), txt.slice(0, 300));
  const eq = await A.textContent('[data-costos="equilibrio"]');
  check('punto de equilibrio del mes en curso: USD 300 con la barra de cuánto lleva', /300/.test(eq) && /lleva USD/.test(eq) && /proyección/.test(eq) && !!(await A.$('[data-costos="equilibrio"] .dash-eq i')), eq.replace(/\s+/g, ' '));
  check(profitMes >= 300 ? 'el mes ya cubre' : 'al mes le falta', profitMes >= 300 ? /cubierto/.test(eq) : /faltan USD/.test(eq), eq.replace(/\s+/g, ' '));
  check('el gráfico profit vs. costos está dibujado', await A.evaluate(() => { const c = document.getElementById('c-costos'); return !!c && c.width > 0 && !!(window.Chart && Chart.getChart(c)); }));
  if (process.env.SHOTS) await (await A.$('#dash-costos')).screenshot({ path: process.env.SHOTS + '/dash-costos.png' });
  check('el link lleva a Costos', !!(await A.$('#dash-costos a[href="pages/costos.html"]')));
  await A.click('.dash-courier[data-courier="DHL"]');
  await esperar(2500);
  check('con un filtro de courier avisa que el neto es orientativo', /no dependen del courier/.test(await A.textContent('#dash-costos-hint')));

  console.log('\n2. Empleado\n');
  const E = await pagina(EMP);
  check('no ve la tarjeta', !(await E.$('#dash-costos:not(.hidden)')));
  check('el resto del Dashboard cargó igual', (await E.textContent('.dash-kpi[data-kpi="envios"] .v')).trim() !== '—');
  check('ningún error en las dos pantallas', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  await browser.close(); db.close(); matar();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1500).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
