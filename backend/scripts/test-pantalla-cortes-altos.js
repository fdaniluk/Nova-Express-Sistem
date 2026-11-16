#!/usr/bin/env node
// Tarifas del cliente: cortes de kilos altos (16/11/2026, Felipe).
// "¿Cómo hacía para poner tarifas por arriba de los 50?" — no se podía: de 50 kg en adelante
// había un solo tramo. Ahora, en la ficha del cliente → Tarifas, "Cortes arriba de 50 kg":
// se escribe 100, 150, 200, 300 y quedan los tramos 50-100, 100-150, 150-200, 200-300, 300+.
//   · los tramos de abajo no se tocan; los nuevos cobran el % general hasta que se les cargue uno;
//   · con el % cargado, el cotizador cobra ese % en su tramo (el borde va con el de abajo);
//   · vaciar el campo vuelve a un solo tramo; si hay % cargados arriba, no deja y avisa.
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3994;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_cortes_altos.db';
const TOKEN = 'token-test-cortes-altos';
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production', SALUD_AUTO: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  process.on('exit', () => { try { srv.kill(); } catch {} });
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const cli = (await J('POST', '/clientes', { nombre: 'KILOS ALTOS SA', tarifa_pct: 75, tipo_cobro: 'CC' })).body;
  const tramos = async () => (await J('GET', `/clientes/${cli.id}/tramos`)).body.tramos.map((t) => `${t.min}-${t.max ?? '+'}`);
  const antes = await tramos();

  const exe = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = []; page.on('pageerror', (e) => errores.push(e.message));
  const dialogos = []; page.on('dialog', (d) => { dialogos.push(d.message()); d.accept(); });
  await page.goto(`${BASE}/pages/clientes-perfil.html?id=${cli.id}`);
  await page.waitForSelector('#cortes-altos', { state: 'attached' });
  // El campo vive en el panel de Tarifas: se abre con "Editar tarifas".
  await page.click('#btn-editar-tarifas');
  await page.waitForSelector('#cortes-altos', { state: 'visible' });
  await esperar(800);
  check('la ficha muestra "Cortes arriba de 50 kg", vacío', await page.isVisible('#cortes-altos') && /arriba de 50 kg/.test(await page.textContent('#cortes-altos-lbl')) && (await page.inputValue('#cortes-altos')) === '', await page.textContent('#cortes-altos-lbl'));

  await page.fill('#cortes-altos', '40, 100');
  await page.click('#btn-cortes-altos'); await esperar(500);
  check('un corte de 50 kg o menos no se acepta', /mayores a 50/.test(await page.textContent('#alert-box')) && (await tramos()).join() === antes.join(), await page.textContent('#alert-box'));

  await page.fill('#cortes-altos', '100, 150, 200, 300');
  await page.click('#btn-cortes-altos');
  await page.waitForFunction(() => /Listo/.test(document.getElementById('alert-box').textContent), null, { timeout: 8000 }).catch(() => {});
  const t1 = await tramos();
  check('pide confirmación mostrando los tramos que arma', dialogos.some((d) => /50-100/.test(d) && /300\+/.test(d)), dialogos.join(' | '));
  check('quedan 50-100, 100-150, 150-200, 200-300 y 300+', ['50-100', '100-150', '150-200', '200-300', '300-+'].every((x) => t1.includes(x)) && !t1.includes('50-+'), t1.join(' '));
  check('los tramos de abajo de 50 kg no cambian', antes.filter((x) => x !== '50-+').every((x) => t1.includes(x)));
  await esperar(900);
  const txt = await page.evaluate(() => document.body.innerText);
  check('la grilla muestra los tramos nuevos', /100-150 kg/.test(txt) && /300\+ kg/.test(txt));
  check('el campo queda con los cortes y el aviso los explica', (await page.inputValue('#cortes-altos')) === '100, 150, 200, 300' && /cortes en 100, 150, 200, 300/.test(await page.textContent('#paso-hint')), await page.textContent('#paso-hint'));

  // % por tramo → el precio
  const esc = [[100, 150, 70], [150, 200, 62], [200, 300, 55], [300, null, 50]];
  const celdas = []; for (const z of [1, 2, 3, 4, 5, 6]) for (const [a, b, p] of esc) celdas.push({ zona: z, peso_min: a, peso_max: b, profit_pct: p });
  const bulk = await J('PUT', `/clientes/${cli.id}/profit-matrix/bulk`, { servicio: 'UPS_EXP', tipo: 'export', celdas });
  check('se cargan los % de los tramos altos (UPS Expedited expo)', bulk.status === 200 && bulk.body.celdas === 24, JSON.stringify(bulk.body));
  const pct = async (peso) => { const r = await J('GET', `/clientes/${cli.id}/profit-resolve?servicio=UPS_EXP&tipo=export&zona=3&pf=${peso}`); return r.body.profitPct; };
  const p = [await pct(57.5), await pct(100), await pct(115), await pct(150), await pct(172.5), await pct(230), await pct(310)];
  check('57,5 kg → 75 · 100 → 75 · 115 → 70 · 150 → 70 · 172,5 → 62 · 230 → 55 · 310 → 50', p.join() === [75, 75, 70, 70, 62, 55, 50].join(), p.join(' '));

  await page.reload(); await page.waitForSelector('#btn-editar-tarifas'); await page.click('#btn-editar-tarifas'); await page.waitForSelector('#cortes-altos', { state: 'visible' }); await esperar(1200);
  await page.fill('#cortes-altos', '');
  await page.click('#btn-cortes-altos'); await esperar(900);
  check('con % cargados arriba, sacar los cortes no se permite y avisa', (await tramos()).includes('100-150') && /hay precios cargados/.test(await page.textContent('#alert-box')), await page.textContent('#alert-box'));
  check('sin errores de JavaScript', errores.length === 0, errores.join(' | '));
  await browser.close();
  console.log(`\n${ok} pasaron · ${fail} fallaron\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
