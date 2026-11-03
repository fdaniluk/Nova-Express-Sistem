#!/usr/bin/env node
/**
 * test-dashboard-por-kg.js — el valor del kilo en el Dashboard (03/11/2026, pedido de Marcelo).
 *   - /api/dashboard/analitica trae por_kg: por mes + Total, en Todos / UPS / DHL, con
 *     compra_kg, venta_kg y utilidad_kg sobre los kilos de los envíos con venta.
 *   - top_clientes trae venta_kg y utilidad_kg.
 *   - /api/dashboard/detalle trae por_mes (cómo se reparte la tarjeta entre los meses).
 *   - El Excel tiene la hoja "Valor del kilo".
 *   - La pantalla: tabla "Por mes · valor del kilo" con selector, columnas nuevas en Top
 *     clientes y chips por mes en el detalle de una tarjeta.
 * Fechas fijas (agosto y septiembre 2026, rango cerrado) para que no dependa del día de hoy.
 */
let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3982;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_dashboard_por_kg.db';
const TOKEN = 'token-test-dash-kg';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const cerca = (a, b, t = 0.011) => Math.abs(Number(a) - Number(b)) <= t;
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

  const cli = (await J('POST', '/api/clientes', { nombre: 'KILO UNO', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  const cli2 = (await J('POST', '/api/clientes', { nombre: 'KILO DOS', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  const alta = (b) => J('POST', '/api/envios', { cliente_id: cli.id, courier: 'UPS', servicio_ups: 'UPS_SAV', tipo_envio: 'exportacion', pais_destino: 'Estados Unidos', largo: 30, ancho: 20, alto: 20, fob: 100, ...b });
  // Agosto: UPS 10 kg a 300 y DHL 5 kg a 200. Septiembre: UPS 20 kg a 500 (otro cliente) y un
  // UPS de 4 kg SIN precio (cuenta en envíos y kilos, no en el valor del kilo).
  const a1 = (await alta({ fecha: '2026-08-05', numero_guia: '1Z000KILO00000001', peso_real: 10, total_cobrado: 300 })).body;
  const a2 = (await alta({ fecha: '2026-08-12', numero_guia: '9900000001', courier: 'DHL', servicio_ups: null, pais_destino: 'Chile', peso_real: 5, total_cobrado: 200 })).body;
  const s1 = (await alta({ fecha: '2026-09-03', numero_guia: '1Z000KILO00000002', cliente_id: cli2.id, peso_real: 20, total_cobrado: 500 })).body;
  const s2 = (await alta({ fecha: '2026-09-10', numero_guia: '1Z000KILO00000003', peso_real: 4, total_cobrado: 0 })).body;
  check('fixture: 4 envíos (agosto 2, septiembre 2)', a1 && a1.id && a2 && a2.id && s1 && s1.id && s2 && s2.id, JSON.stringify([a1, a2, s1, s2].map((x) => x && (x.id || x.error))));
  const pesos = await sql('SELECT numero_guia, peso_facturable FROM envios ORDER BY id');
  check('   pesos facturables 10 / 5 / 20 / 4 (dims chicas, manda el real)', pesos.map((p) => Number(p.peso_facturable)).join(',') === '10,5,20,4', JSON.stringify(pesos));

  const Q = 'periodo=rango&desde=2026-08-01&hasta=2026-09-30';
  const d = (await J('GET', `/api/dashboard/analitica?${Q}`)).body;

  console.log('\n1. por_kg: por mes y total, en Todos / UPS / DHL\n');
  const pk = d.por_kg;
  check('viene por_kg con los dos meses', pk && pk.meses.join(',') === '2026-08,2026-09', JSON.stringify(pk && pk.meses));
  const ago = pk.todos.filas[0], sep = pk.todos.filas[1], tot = pk.todos.total;
  check('agosto (todos): 2 envíos, 15 kg, venta 500 → venta/kg 33,33', ago.envios === 2 && ago.kg_fact === 15 && ago.venta === 500 && cerca(ago.venta_kg, 33.33), JSON.stringify(ago));
  check('   compra/kg = compra ÷ kg y utilidad/kg = profit ÷ kg', cerca(ago.compra_kg, ago.compra / 15) && cerca(ago.utilidad_kg, ago.profit / 15), JSON.stringify({ c: ago.compra, ck: ago.compra_kg, p: ago.profit, uk: ago.utilidad_kg }));
  check('   y utilidad/kg = venta/kg − compra/kg', cerca(ago.utilidad_kg, ago.venta_kg - ago.compra_kg, 0.02), `${ago.venta_kg} − ${ago.compra_kg} vs ${ago.utilidad_kg}`);
  check('septiembre (todos): 2 envíos y 24 kg en la tarjeta, pero el kilo se mide sobre los 20 con venta → venta/kg 25', sep.envios === 2 && sep.kg_fact === 24 && sep.kg_con_venta === 20 && cerca(sep.venta_kg, 25), JSON.stringify(sep));
  check('   el envío sin precio queda contado en sin_venta', sep.sin_venta.n === 1);
  check('Total (todos) = las tarjetas: 4 envíos, 39 kg, venta 1000, venta/kg 1000 ÷ 35 = 28,57', tot.envios === d.kpis.envios && tot.envios === 4 && tot.kg_fact === 39 && tot.venta === 1000 && cerca(tot.venta_kg, 28.57), JSON.stringify(tot));
  const agoU = pk.UPS.filas[0], agoD = pk.DHL.filas[0], sepD = pk.DHL.filas[1];
  check('UPS agosto: 1 envío, 10 kg, venta/kg 30', agoU.envios === 1 && agoU.kg_fact === 10 && cerca(agoU.venta_kg, 30), JSON.stringify(agoU));
  check('DHL agosto: 1 envío, 5 kg, venta/kg 40; DHL septiembre vacío (sin valor del kilo)', agoD.envios === 1 && cerca(agoD.venta_kg, 40) && sepD.envios === 0 && sepD.venta_kg === null, JSON.stringify([agoD, sepD]));
  check('Total UPS = mix_total.UPS (mismos números que el gráfico de couriers)', pk.UPS.total.venta === d.mix_total.UPS.venta && pk.UPS.total.kg_fact === d.mix_total.UPS.kg_fact);
  check('UPS + DHL cierran con Todos (envíos, kg y venta)', pk.UPS.total.envios + pk.DHL.total.envios === tot.envios && cerca(pk.UPS.total.kg_fact + pk.DHL.total.kg_fact, tot.kg_fact, 0.11) && cerca(pk.UPS.total.venta + pk.DHL.total.venta, tot.venta));

  console.log('\n2. Top clientes con el valor del kilo\n');
  const c1 = d.top_clientes.find((c) => c.nombre === 'KILO UNO'), c2 = d.top_clientes.find((c) => c.nombre === 'KILO DOS');
  check('KILO UNO: venta 500 sobre 15 kg con venta → venta/kg 33,33 (los 4 kg sin precio no entran)', c1 && cerca(c1.venta_kg, 33.33) && c1.kg_fact === 19, JSON.stringify(c1 && { v: c1.venta, k: c1.kg_fact, kv: c1.kg_con_venta, vk: c1.venta_kg }));
  check('KILO DOS: venta/kg 25 y utilidad/kg = profit ÷ 20', c2 && cerca(c2.venta_kg, 25) && cerca(c2.utilidad_kg, c2.profit / 20), JSON.stringify(c2 && { vk: c2.venta_kg, uk: c2.utilidad_kg, p: c2.profit }));

  console.log('\n3. El detalle de una tarjeta se reparte por mes\n');
  const det = (await J('GET', `/api/dashboard/detalle?${Q}&kpi=envios`)).body;
  check('por_mes: agosto 2, septiembre 2', det.por_mes && det.por_mes.map((m) => `${m.mes}:${m.envios}`).join(' ') === '2026-08:2 2026-09:2', JSON.stringify(det.por_mes));
  const detV = (await J('GET', `/api/dashboard/detalle?${Q}&kpi=venta`)).body;
  check('   para Venta: agosto 500, septiembre 500 (el sin precio no está)', detV.por_mes.map((m) => m.venta).join(',') === '500,500' && detV.por_mes[1].envios === 1, JSON.stringify(detV.por_mes));

  console.log('\n4. Excel con la hoja "Valor del kilo"\n');
  const xr = await fetch(`${BASE}/api/dashboard/analitica.xlsx?${Q}`, { headers: H });
  const buf = Buffer.from(await xr.arrayBuffer());
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const hojaKg = wb.getWorksheet('Valor del kilo');
  check('la hoja existe', !!hojaKg);
  if (hojaKg) {
    const filas = []; hojaKg.eachRow((r) => filas.push(r.values.slice(1)));
    check('   cabecera con Compra/Venta/Utilidad USD/kg', /Compra USD\/kg/.test(filas[0].join('|')) && /Utilidad USD\/kg/.test(filas[0].join('|')), filas[0].join('|'));
    const fAgo = filas.find((f) => f[0] === 'Todos' && f[1] === '2026-08');
    check('   fila Todos / 2026-08 con venta/kg 33,33', fAgo && cerca(fAgo[8], 33.33), JSON.stringify(fAgo));
    check('   tres juegos con su Total (Todos, UPS, DHL)', filas.filter((f) => f[1] === 'Total').length === 3);
    const hojaCli = wb.getWorksheet('Clientes');
    const cab = []; hojaCli.getRow(1).eachCell((c) => cab.push(c.value));
    check('   Clientes tiene Venta USD/kg y Utilidad USD/kg', cab.includes('Venta USD/kg') && cab.includes('Utilidad USD/kg'), cab.join('|'));
  }

  if (!chromium) { console.log('\n⚠ playwright no está instalado — se saltea la pantalla.'); }
  else {
    console.log('\n5. La pantalla\n');
    const exe = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => fs.existsSync(p));
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', (e) => errores.push(String(e)));
    await page.goto(`${BASE}/index.html`);
    await esperar(1500);
    // Rango a mano: agosto → septiembre 2026.
    await page.fill('#dash-desde', '2026-08'); await page.fill('#dash-hasta', '2026-09');
    await page.click('#dash-rango-ok'); await esperar(1500);
    const filasKg = () => page.$$eval('#dash-kg-t tbody tr', (trs) => trs.map((t) => t.textContent.replace(/\s+/g, ' ').trim()));
    let fk = await filasKg();
    check('la tabla "Por mes · valor del kilo" tiene agosto, septiembre y Total', fk.length === 3 && /^Agosto 2026/.test(fk[0]) && /^Septiembre 2026/.test(fk[1]) && /^Total/.test(fk[2]), fk.join(' | '));
    check('   agosto dice venta/kg 33,33 y septiembre 25,00', /33,33/.test(fk[0]) && /25,00/.test(fk[1]), fk.slice(0, 2).join(' | '));
    check('   el pie avisa el envío sin precio', /1 envío sin precio/.test(await page.textContent('#dash-kg-pie')), await page.textContent('#dash-kg-pie'));
    await page.click('#seg-kg button[data-m="DHL"]'); await esperar(200);
    fk = await filasKg();
    check('   con DHL queda solo agosto (40,00 por kg) y sin fila Total', fk.length === 1 && /40,00/.test(fk[0]), fk.join(' | '));
    await page.click('#seg-kg button[data-m="UPS"]'); await esperar(200);
    fk = await filasKg();
    check('   con UPS: agosto 30,00, septiembre 25,00 y Total', fk.length === 3 && /30,00/.test(fk[0]) && /25,00/.test(fk[1]), fk.join(' | '));
    const cabTop = await page.$$eval('#dash-top thead th', (ths) => ths.map((t) => t.textContent.trim()));
    check('Top clientes tiene Venta/kg y Util./kg', cabTop.includes('Venta/kg') && cabTop.includes('Util./kg'), cabTop.join('|'));
    const filaUno = await page.$$eval('#dash-top tbody tr', (trs) => trs.map((t) => t.textContent.replace(/\s+/g, ' ').trim()).find((t) => /KILO UNO/.test(t)));
    check('   KILO UNO muestra 33,33 por kg', /33,33/.test(filaUno || ''), filaUno);
    await page.click('.dash-kpi[data-kpi="envios"]'); await esperar(1200);
    const chipsMes = await page.$$eval('#dash-detalle-reparto .chip.mes', (cs) => cs.map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
    check('el detalle de Envíos arranca con el reparto por mes (Ago 26: 2 · Sep 26: 2)', chipsMes.length === 2 && /Ago 26: 2/.test(chipsMes[0]) && /Sep 26: 2/.test(chipsMes[1]), chipsMes.join(' | '));
    await page.keyboard.press('Escape'); await esperar(200);
    await page.click('.dash-kpi[data-kpi="venta"]'); await esperar(1200);
    const chipsV = await page.$$eval('#dash-detalle-reparto .chip.mes', (cs) => cs.map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
    check('   y el de Venta: USD 500 cada mes con sus envíos', chipsV.length === 2 && /500/.test(chipsV[0]) && /1 env/.test(chipsV[1]), chipsV.join(' | '));
    await page.keyboard.press('Escape'); await esperar(200);
    // Un solo mes: no hay reparto por mes ni fila Total.
    await page.fill('#dash-desde', '2026-08'); await page.fill('#dash-hasta', '2026-08');
    await page.click('#dash-rango-ok'); await esperar(1500);
    await page.click('#seg-kg button[data-m="todos"]'); await esperar(200);
    fk = await filasKg();
    check('con un solo mes la tabla no repite Total', fk.length === 1 && /^Agosto 2026/.test(fk[0]), fk.join(' | '));
    await page.click('.dash-kpi[data-kpi="envios"]'); await esperar(1200);
    check('   ni el detalle muestra chips por mes', (await page.$$('#dash-detalle-reparto .chip.mes')).length === 0);
    if (process.env.SHOTS) { await page.keyboard.press('Escape'); await esperar(200); await page.screenshot({ path: process.env.SHOTS + '/dash-kg.png', fullPage: true }); }
    check('sin errores de JS', errores.length === 0, errores.join(' | '));
    await browser.close();
  }

  matar();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
