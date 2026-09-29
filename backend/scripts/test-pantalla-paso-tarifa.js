#!/usr/bin/env node
/**
 * test-pantalla-paso-tarifa.js — el selector "Paso de la tarifa" en la ficha del cliente
 * (29/09/2026) en un navegador de verdad: 5 → 0,5 kg con confirmación, grilla larga con
 * scroll propio y buscador de peso, y vuelta a 5 kg.
 */
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3962; const BASE = `http://localhost:${PORT}`;
const DB = path.join(os.tmpdir(), 'test_pantalla_paso.db'); const TOKEN = 'token-test-paso';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0; let fail = 0;
const check = (n, c, d = '') => { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let o = ''; let e = ''; srv.stdout.on('data', (d) => { o += d; }); srv.stderr.on('data', (d) => { e += d; });
  const matar = () => { try { srv.kill(); } catch { /* ya */ } }; process.on('exit', matar);
  try {
    await esperarServidor(srv, BASE, () => e, () => o); await abrirSesion(DB, TOKEN);
    const J = async (m, u, b) => { const r = await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const cli = (await J('POST', '/api/clientes', { nombre: 'PASO PANTALLA', tarifa_pct: 60, tipo_cobro: 'D' })).body;
    const B = [[0, 5], [5, 10], [10, 15], [15, 20], [20, 25], [25, 30], [30, 40], [40, 50], [50, null]];
    const celdas = []; B.forEach(([a, b], i) => { for (let z = 1; z <= 6; z++) celdas.push({ zona: z, peso_min: a, peso_max: b, profit_pct: 100 + i * 5 + z }); });
    const bulk = await J('PUT', `/api/clientes/${cli.id}/profit-matrix/bulk`, { servicio: 'UPS_EXP', tipo: 'export', celdas });
    check('API bulk: 54 celdas de una', bulk.status === 200 && bulk.body.celdas === 54, JSON.stringify(bulk.body));
    const antes = (await J('GET', `/api/clientes/${cli.id}/profit-resolve?servicio=UPS_EXP&tipo=export&zona=3&pf=37`)).body;

    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome', process.env.CHROME_PATH].filter((p) => p && fs.existsSync(p))[0];
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
    const page = await ctx.newPage(); const errores = []; const dialogos = [];
    page.on('pageerror', (x) => errores.push(String(x)));
    page.on('dialog', (d) => { dialogos.push(d.message()); d.accept(); });
    await page.goto(`${BASE}/pages/clientes-perfil.html?id=${cli.id}`);
    await page.waitForSelector('#btn-editar-tarifas', { timeout: 15000 }); await esperar(800);
    await page.click('#btn-editar-tarifas'); await esperar(1500);

    console.log('\n1. Selector\n');
    check('el selector de paso está, con 5 kg marcado', await page.$eval('#paso-seg button.on', (b) => b.dataset.paso) === '5');
    check('con 5 kg no se muestra el tope', await page.$eval('#paso-hasta', (i) => i.classList.contains('hidden')));
    const filas5 = await page.$$eval('#sec-UPS_EXP table.tarifas-grid tbody tr', (t) => t.length);
    check('la grilla UPS Expedited tiene 9 filas', filas5 === 9, String(filas5));

    console.log('\n2. Pasar a 0,5 kg\n');
    await page.click('#paso-seg button[data-paso="0.5"]'); await esperar(2500);
    check('pidió confirmación y dijo que no mueve precios', dialogos.length === 1 && /No se mueve ningún precio/.test(dialogos[0]), dialogos.join(' | '));
    check('0,5 kg queda marcado y aparece el tope en 70', await page.$eval('#paso-seg button.on', (b) => b.dataset.paso) === '0.5' && await page.$eval('#paso-hasta', (i) => i.value) === '70');
    const filas05 = await page.$$eval('#sec-UPS_EXP table.tarifas-grid tbody tr', (t) => t.length);
    check('la grilla tiene 141 filas', filas05 === 141, String(filas05));
    check('la tabla larga tiene scroll propio', !!(await page.$('#sec-UPS_EXP .tarifas-grid-wrap.largo')));
    check('y el buscador de peso arriba', !!(await page.$('#sec-UPS_EXP .grid-buscar-input')));
    const despues = (await J('GET', `/api/clientes/${cli.id}/profit-resolve?servicio=UPS_EXP&tipo=export&zona=3&pf=37`)).body;
    check('37 kg zona 3 resuelve el mismo % que antes', JSON.stringify(antes && antes.profitPct) === JSON.stringify(despues && despues.profitPct), `${JSON.stringify(antes)} vs ${JSON.stringify(despues)}`);
    const alertaTxt = await page.$eval('#alert-box', (a) => a.textContent);
    check('el aviso dice 141 tramos y que no cambió ningún precio', /141 tramos/.test(alertaTxt) && /sin cambiar ningún precio/.test(alertaTxt), alertaTxt.slice(0, 160));

    console.log('\n3. Buscador de peso\n');
    await page.fill('#sec-UPS_EXP .grid-buscar-input', '30.5'); await esperar(700);
    const filasB = await page.$$eval('#sec-UPS_EXP table.tarifas-grid tbody tr td.banda-label', (t) => t.map((x) => x.textContent.trim()));
    check('muestra los tramos alrededor de 30,5 kg', filasB.includes('30-30.5 kg') && filasB.length < 15, filasB.join(','));
    await page.click('#sec-UPS_EXP .grid-buscar-todo'); await esperar(600);
    check('"Ver todos" vuelve a las 141', (await page.$$eval('#sec-UPS_EXP table.tarifas-grid tbody tr', (t) => t.length)) === 141);

    console.log('\n4. Volver a 5 kg\n');
    await page.click('#paso-seg button[data-paso="5"]'); await esperar(2500);
    check('avisó que al agrandar se promedia', /PROMEDIO/.test(dialogos[dialogos.length - 1] || ''));
    check('vuelve a 9 filas y 5 kg marcado', (await page.$$eval('#sec-UPS_EXP table.tarifas-grid tbody tr', (t) => t.length)) === 9 && await page.$eval('#paso-seg button.on', (b) => b.dataset.paso) === '5');
    const fin = (await J('GET', `/api/clientes/${cli.id}/profit-resolve?servicio=UPS_EXP&tipo=export&zona=3&pf=37`)).body;
    check('37 kg zona 3 sigue igual (todas las medias valían lo mismo)', JSON.stringify(fin && fin.profitPct) === JSON.stringify(antes && antes.profitPct));
    if (process.env.SHOTS_DIR) { await page.click('#paso-seg button[data-paso="0.5"]'); await esperar(2500); await page.screenshot({ path: path.join(process.env.SHOTS_DIR, 'paso-tarifa.png') }); }
    check('sin errores de JavaScript', errores.length === 0, errores.join(' | ').slice(0, 200));
    await browser.close();
  } finally { matar(); }
  console.log(`\n${ok} pasaron · ${fail} fallaron`); process.exitCode = fail ? 1 : 0; setTimeout(() => {}, 200).unref();
}
main().catch((x) => { console.error(x); process.exitCode = 1; });
