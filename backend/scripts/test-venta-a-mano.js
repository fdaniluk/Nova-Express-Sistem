#!/usr/bin/env node
/**
 * test-venta-a-mano.js — Desglose de VENTA corregido a mano desde Salidas (02/11/2026).
 *
 * LA REGLA: la venta de un envío se reparte sola en flete / fuel / seguro / adicional
 * (desgloseVenta.js). En algunos casos la oficina necesita corregir ese reparto, con el
 * mismo total o cambiándolo. Desde el modal de Salidas, bloque 3, el switch Compra/Venta
 * muestra las cuatro líneas de la venta y se editan; la suma es la Venta total. Se guarda
 * en envios.venta_json y manda en Salidas y en la liquidación (pantalla y Excel) MIENTRAS
 * cierre con total_cobrado; si el total cambia por otro lado, se vuelve al automático.
 *
 *   cd backend && node scripts/test-venta-a-mano.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3999;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_venta_a_mano.db';
const TOKEN = 'token-test-venta-a-mano';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (n) => Math.round(n * 100) / 100;

async function main() {
  console.log('\n0. El helper: el ajuste manda solo si cierra con el total\n');
  const { descomponerVenta, detallarAdicional, ventaManualDe } = require('../src/utils/desgloseVenta');
  const base = { total_cobrado: 200, seguro: 15, adicionales: 10, derechos: 0, otros: 0, fuel_pct: 25, extras: null };
  const auto = descomponerVenta(base);
  check('automático: seguro 15, adicional 10, flete+fuel balancean 175', auto.seguro === 15 && auto.adicional === 10 && r2(auto.flete + auto.fuel) === 175 && auto.flete === 140 && auto.fuel === 35, JSON.stringify(auto));
  const manual = descomponerVenta({ ...base, venta_json: JSON.stringify({ flete: 150, fuel: 20, seguro: 15, adicional: 15 }) });
  check('a mano que suma 200 → manda tal cual', manual.flete === 150 && manual.fuel === 20 && manual.seguro === 15 && manual.adicional === 15 && manual.total === 200, JSON.stringify(manual));
  const roto = descomponerVenta({ ...base, venta_json: JSON.stringify({ flete: 150, fuel: 20, seguro: 15, adicional: 30 }) });
  check('a mano que NO suma el total → se ignora (automático)', JSON.stringify(roto) === JSON.stringify(auto), JSON.stringify(roto));
  check('ventaManualDe con basura → null', ventaManualDe({ total_cobrado: 200, venta_json: '{no json' }) === null && ventaManualDe({ total_cobrado: 200, venta_json: null }) === null);
  const det = detallarAdicional({ ...base, venta_json: JSON.stringify({ flete: 150, fuel: 20, seguro: 15, adicional: 15 }) });
  check('el detalle del Adicional suma 15 con una línea "Ajuste" de +5', r2(det.reduce((s, l) => s + l.monto, 0)) === 15 && det.some((l) => l.tipo === 'ajuste' && l.monto === 5), JSON.stringify(det));

  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
  const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: H, body: JSON.stringify(b) });
  const patch = (u, b) => fetch(BASE + u, { method: 'PATCH', headers: H, body: JSON.stringify(b) });
  const get = (u) => fetch(BASE + u, { headers: H });
  const hoy = new Date().toISOString().slice(0, 10);

  const cli = await j(await post('/api/clientes', { nombre: 'VENTA A MANO SA', tarifa_pct: 75, tipo_cobro: 'CC' }));
  const env = await j(await post('/api/envios', {
    cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion', numero_guia: '1Z000VMANO00000001',
    pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP', peso_real: 5, fob: 500,
  }));
  check('envío creado con costo', !!env.id && env.flete > 0, JSON.stringify(env).slice(0, 120));
  const salidaDe = async () => (await j(await get('/api/salidas?mes=' + hoy.slice(0, 7)))).find((x) => x.id === env.id) || (await j(await get('/api/salidas'))).find((x) => x.id === env.id);

  console.log('\n1. API: guardar, validar, limpiar\n');
  let r = await patch(`/api/salidas/${env.id}`, { total_cobrado: 300 });
  check('venta total 300 → 200', r.status === 200, `${r.status} ${await r.text()}`);
  let s = await salidaDe();
  const autoVd = s.venta_desglose;
  check('  Salidas trae el reparto automático y venta_manual null', autoVd && autoVd.total === 300 && s.venta_manual === null, JSON.stringify({ autoVd, m: s.venta_manual }));
  r = await patch(`/api/salidas/${env.id}`, { venta_desglose: { flete: 200, fuel: 50, seguro: 20, adicional: 20 } });
  check('venta_desglose que NO suma 300 → 400 con las dos cifras', r.status === 400 && /290\.00/.test((await j(r)).error) && true, String(r.status));
  r = await patch(`/api/salidas/${env.id}`, { venta_desglose: { flete: 200, fuel: 60, seguro: 20, adicional: 20 } });
  check('venta_desglose que suma 300 → 200', r.status === 200, `${r.status} ${await r.text()}`);
  s = await salidaDe();
  check('  Salidas: venta_desglose = lo tipeado, venta_manual presente, y el automático aparte', s.venta_desglose.flete === 200 && s.venta_desglose.fuel === 60 && s.venta_desglose.seguro === 20 && s.venta_desglose.adicional === 20 && s.venta_manual && s.venta_manual.flete === 200 && s.venta_desglose_auto && s.venta_desglose_auto.flete === autoVd.flete, JSON.stringify({ vd: s.venta_desglose, m: s.venta_manual, a: s.venta_desglose_auto }));
  r = await patch(`/api/salidas/${env.id}`, { total_cobrado: 320, venta_desglose: { flete: 220, fuel: 60, seguro: 20, adicional: 20 } });
  check('cambiar total y desglose juntos (suman 320) → 200', r.status === 200, `${r.status} ${await r.text()}`);
  s = await salidaDe();
  check('  queda 220/60/20/20 total 320', s.venta_desglose.flete === 220 && s.venta_desglose.total === 320, JSON.stringify(s.venta_desglose));

  console.log('\n2. La liquidación usa el reparto a mano (pantalla y Excel)\n');
  r = await post('/api/liquidaciones/preview', { cliente_id: cli.id, envio_ids: [env.id] });
  let pv = await j(r);
  const it = pv.items && pv.items[0];
  check('preview: flete 220, fuel 60, seguro 20, adicional 20, total 320', it && it.flete === 220 && it.fuel === 60 && it.seguro === 20 && it.adicional === 20 && it.total_usd === 320, JSON.stringify(it && { f: it.flete, u: it.fuel, s: it.seguro, a: it.adicional, t: it.total_usd }));
  check('  el detalle del adicional cierra en 20', it && r2((it.adicional_detalle || []).reduce((a, l) => a + l.monto, 0)) === 20, JSON.stringify(it && it.adicional_detalle));

  console.log('\n3. Si la venta total cambia por otro lado, el ajuste se descarta\n');
  r = await patch(`/api/salidas/${env.id}`, { total_cobrado: 350 });
  check('PATCH total 350 sin desglose → 200', r.status === 200);
  s = await salidaDe();
  check('  vuelve al automático (venta_manual null, total 350)', s.venta_manual === null && s.venta_desglose.total === 350 && s.venta_desglose.seguro === autoVd.seguro, JSON.stringify({ m: s.venta_manual, vd: s.venta_desglose }));
  r = await patch(`/api/salidas/${env.id}`, { venta_desglose: { flete: 250, fuel: 60, seguro: 20, adicional: 20 } });
  check('se vuelve a ajustar (suma 350) → 200', r.status === 200, `${r.status} ${await r.text()}`);
  r = await patch(`/api/salidas/${env.id}`, { venta_desglose: null });
  check('venta_desglose: null → 200 y vuelve al automático', r.status === 200 && (await salidaDe()).venta_manual === null);

  console.log('\n4. Envío liquidado: el reparto de venta está congelado\n');
  r = await patch(`/api/salidas/${env.id}`, { venta_desglose: { flete: 250, fuel: 60, seguro: 20, adicional: 20 } });
  r = await post('/api/liquidaciones', { cliente_id: cli.id, envio_ids: [env.id], periodo_desde: hoy.slice(0, 8) + '01', periodo_hasta: hoy, confirmar: true });
  const liq = await j(r);
  check('liquidación confirmada con el envío, item flete 250', r.status === 201 && liq.items[0].flete === 250, `${r.status} ${JSON.stringify(liq).slice(0, 150)}`);
  r = await patch(`/api/salidas/${env.id}`, { venta_desglose: { flete: 240, fuel: 70, seguro: 20, adicional: 20 } });
  check('cambiar el reparto de un envío liquidado → 409', r.status === 409 && /desglose de venta/.test((await j(r)).error), String(r.status));
  r = await patch(`/api/salidas/${env.id}`, { observaciones: 'nota' });
  check('  pero otra cosa sí se puede guardar', r.status === 200);

  console.log('\n5. La pantalla: switch Compra/Venta en el modal\n');
  const env2 = await j(await post('/api/envios', {
    cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion', numero_guia: '1Z000VMANO00000002',
    pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP', peso_real: 5, fob: 500,
  }));
  await patch(`/api/salidas/${env2.id}`, { total_cobrado: 300 });
  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  await page.click('text=1Z000VMANO00000002');
  await esperar(800);
  check('se abre el modal en Compra, con el switch', !!(await page.$('#sal-edit-overlay:not(.hidden)')) && await page.evaluate(() => document.querySelector('#saled-modo .on')?.dataset.modo === 'compra' && document.getElementById('saled-venta-block').classList.contains('hidden')));
  await page.click('#saled-modo [data-modo="venta"]');
  await esperar(200);
  const v = await page.evaluate(() => ({
    titulo: document.getElementById('saled-modo-titulo').textContent,
    compraOculta: document.getElementById('saled-compra-block').classList.contains('hidden'),
    flete: document.getElementById('saled-v-flete').value, fuel: document.getElementById('saled-v-fuel').value,
    seguro: document.getElementById('saled-v-seguro').value, adic: document.getElementById('saled-v-adicional').value,
    estado: document.getElementById('saled-venta-estado').textContent,
  }));
  const sum = r2(['flete', 'fuel', 'seguro', 'adic'].reduce((a, k) => a + Number(v[k]), 0));
  check('Venta: esconde la compra y muestra las cuatro líneas que suman 300', /Venta/.test(v.titulo) && v.compraOculta && sum === 300 && /automático/.test(v.estado), JSON.stringify(v));
  // Corrección con el mismo total: 10 del flete pasan al adicional.
  const fleteNuevo = r2(Number(v.flete) - 10);
  const adicNuevo = r2(Number(v.adic) + 10);
  await page.fill('#saled-v-flete', String(fleteNuevo));
  await page.fill('#saled-v-adicional', String(adicNuevo));
  await esperar(200);
  check('  la Venta total sigue en 300 y el estado dice "corregido a mano"', await page.evaluate(() => Number(document.getElementById('saled-total').value) === 300 && /corregido a mano/.test(document.getElementById('saled-venta-estado').textContent)));
  await page.fill('#saled-v-fuel', String(r2(Number(v.fuel) + 5)));
  await esperar(200);
  check('  subir el fuel 5 → la Venta total pasa a 305 y el profit se re-deriva', await page.evaluate(() => Number(document.getElementById('saled-total').value) === 305 && document.getElementById('saled-profit').value !== ''));
  await page.click('#sal-modal-save');
  await esperar(1500);
  s = (await j(await get('/api/salidas'))).find((x) => x.id === env2.id);
  check('Guardar → queda el reparto a mano con total 305', s && s.venta_manual && s.venta_manual.flete === fleteNuevo && s.venta_manual.adicional === adicNuevo && s.venta_desglose.total === 305, JSON.stringify(s && { m: s.venta_manual, vd: s.venta_desglose }));
  await esperar(1500);
  check('  la grilla lo marca "ajustado a mano"', /ajustado a mano/.test(await page.textContent('body')));

  // Reabrir: arranca en Compra, Venta muestra lo guardado; "Volver al automático".
  await page.click('text=1Z000VMANO00000002');
  await esperar(800);
  await page.click('#saled-modo [data-modo="venta"]');
  await esperar(200);
  const re = await page.evaluate(() => ({ abierto: !!document.querySelector('#sal-edit-overlay:not(.hidden)'), flete: document.getElementById('saled-v-flete').value, auto: document.getElementById('saled-venta-auto').className, estado: document.getElementById('saled-venta-estado').textContent }));
  check('al reabrir, Venta muestra lo guardado y ofrece volver al automático', re.abierto && Number(re.flete) === fleteNuevo && !/hidden/.test(re.auto), JSON.stringify(re));
  await page.click('#saled-venta-auto');
  await esperar(200);
  check('  Volver al automático repone el reparto automático (total 305)', await page.evaluate(() => Number(document.getElementById('saled-total').value) === 305 && /automático/.test(document.getElementById('saled-venta-estado').textContent)));
  await page.click('#sal-modal-save');
  await esperar(1500);
  s = (await j(await get('/api/salidas'))).find((x) => x.id === env2.id);
  check('  Guardar → venta_manual null', s && s.venta_manual === null, JSON.stringify(s && s.venta_manual));

  console.log('\n6. Sin errores de JavaScript\n');
  check('ningún error en la pantalla', errores.length === 0, errores.join(' | ').slice(0, 300));

  await browser.close();
  matarSrv();
  console.log(`\n${ok} pasaron · ${fail} fallaron\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
