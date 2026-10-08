#!/usr/bin/env node
// Entrega residencial de UPS, USD 6,00 por envío (08/10/2026).
//
// Auditoría del 07/10: UPS facturó "Residential 6.00" en 116 de 383 guías (30 %) y el alta
// del envío no tenía forma de preverlo: cada una saltaba como anomalía y la oficina la
// cargaba a mano como cargo posterior. Ahora se tilda en Cargar envío / Salidas, viaja al
// motor (que ya lo cobraba en el cotizador), se congela en el costo y la factura no lo
// marca como "no previsto".
//
//   cd backend && node scripts/test-residencial.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const { detectarAnomalias } = require('../src/utils/anomalias-factura');

const PORT = process.env.PORT_TEST || 3972;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_residencial.db';
const TOKEN = 'token-test-residencial';
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const cerca = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) <= tol;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  console.log('\n1. API: se guarda, se cobra, sobrevive a las ediciones\n');
  const cli = (await J('POST', '/clientes', { nombre: 'RESIDENCIAL SA', tarifa_pct: 75, tipo_cobro: 'CC' })).body;
  const base = { cliente_id: cli.id, fecha: '2026-10-08', courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion', pais_destino: 'Estados Unidos', peso_real: 5, largo: 30, ancho: 20, alto: 15, fob: 100, total_cobrado: 200 };
  const sin = (await J('POST', '/envios', { ...base, numero_guia: '1Z000RESID00000001' })).body;
  const con = (await J('POST', '/envios', { ...base, numero_guia: '1Z000RESID00000002', residencial: 1 })).body;
  check('el envío guarda la tilde (1) y el otro queda en 0', Number(con.residencial) === 1 && !Number(sin.residencial), JSON.stringify({ con: con.residencial, sin: sin.residencial }));
  check('el costo congelado suma exactamente 6,00 de adicionales', cerca(Number(con.adicionales) - Number(sin.adicionales), 6), `con ${con.adicionales} sin ${sin.adicionales}`);
  const extras = JSON.parse(con.extras_json || '[]');
  check('aparece en el desglose como "Entrega residencial" 6.00', extras.some((x) => /residencial/i.test(x.label) && cerca(x.monto, 6)), con.extras_json);
  const editado = (await J('PUT', `/envios/${con.id}`, { peso_real: 6 })).body;
  check('editar el peso NO borra la tilde ni el cargo', Number(editado.residencial) === 1 && /residencial/i.test(String(editado.extras_json)), String(editado.extras_json).slice(0, 120));
  const recalc = (await J('POST', `/salidas/${con.id}/recalcular`, { peso_real: 6, largo: 30, ancho: 20, alto: 15 })).body;
  check('el "Recalcular" de Salidas sin mandar la tilde la conserva', (recalc.extras || []).some((x) => /residencial/i.test(x.label)), JSON.stringify(recalc.extras));
  const recalcOff = (await J('POST', `/salidas/${con.id}/recalcular`, { peso_real: 6, largo: 30, ancho: 20, alto: 15, residencial: 0 })).body;
  check('y con residencial: 0 el cargo desaparece', !(recalcOff.extras || []).some((x) => /residencial/i.test(x.label)));
  const patch = (await J('PATCH', `/salidas/${con.id}`, { residencial: 0, adicionales: recalcOff.adicionales, extras_json: JSON.stringify(recalcOff.extras) }));
  const trasPatch = (await J('GET', `/envios/${con.id}`)).body;
  check('PATCH de Salidas destilda', patch.status === 200 && !Number(trasPatch.residencial), JSON.stringify({ s: patch.status, r: trasPatch.residencial }));
  await J('PATCH', `/salidas/${con.id}`, { residencial: 1 });
  const lst = (await J('GET', '/salidas?desde=2026-10-08&hasta=2026-10-08')).body;
  const fila = (Array.isArray(lst) ? lst : lst.rows || []).find((r) => r.id === con.id);
  check('Salidas devuelve el flag en la fila', fila && fila.residencial === true, JSON.stringify(fila && fila.residencial));

  console.log('\n2. Cotizador / Calcular venta\n');
  const cotCon = (await J('POST', '/liquidaciones/cotizar', { pais: 'Estados Unidos', tipo: 'export', servicio: 'UPS_EXP', pesoFacturable: 5, fob: 100, fuelPct: 30, profitPct: 75, bultos: [{ peso_real: 5, largo: 30, ancho: 20, alto: 15 }], residencial: true, profitManual: true })).body;
  const cotSin = (await J('POST', '/liquidaciones/cotizar', { pais: 'Estados Unidos', tipo: 'export', servicio: 'UPS_EXP', pesoFacturable: 5, fob: 100, fuelPct: 30, profitPct: 75, bultos: [{ peso_real: 5, largo: 30, ancho: 20, alto: 15 }], profitManual: true })).body;
  check('el endpoint que usan las pantallas cobra los 6,00 al cliente', cerca(Number(cotCon.precioFinal) - Number(cotSin.precioFinal), 6), `dif ${(Number(cotCon.precioFinal) - Number(cotSin.precioFinal)).toFixed(2)}`);
  check('al costo: la utilidad no cambia', cerca(cotCon.utilidad, cotSin.utilidad), `${cotCon.utilidad} vs ${cotSin.utilidad}`);
  const cotEnvio = (await J('POST', '/liquidaciones/cotizar', { envio_id: con.id, profitPct: 75, profitManual: true })).body;
  check('"Calcular venta" del envío toma la tilde guardada', (cotEnvio.extras || cotEnvio.extraRows || []).some((x) => /residencial/i.test(x.label || x[0] || '')) || cerca(Number(cotEnvio.precioFinal) - Number(cotSin.precioFinal), 6, 1), JSON.stringify(cotEnvio).slice(0, 200));

  console.log('\n3. La factura de UPS con "Residential 6.00" ya no es anomalía\n');
  const an = detectarAnomalias({ extras_json: con.extras_json, residencial: 1, seguro: 0, fuel: 10, peso_facturable: 5 }, { cargos: [{ nombre: 'Residential', monto: 6 }], peso_facturado: 5, fuel_facturado: 10 });
  check('envío residencial + Residential 6.00 → sin anomalías', an.length === 0, JSON.stringify(an));
  const an2 = detectarAnomalias({ extras_json: sin.extras_json, residencial: 0, seguro: 0, fuel: 10, peso_facturable: 5 }, { cargos: [{ nombre: 'Residential', monto: 6 }], peso_facturado: 5, fuel_facturado: 10 });
  check('envío sin la tilde → sigue avisando "Entrega residencial: USD 6.00 no previsto"', an2.length === 1 && an2[0].tipo === 'residencial', JSON.stringify(an2));

  console.log('\n4. Pantallas\n');
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { chromium = null; }
  if (chromium) {
    const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', (e) => errores.push(String(e)));
    page.on('dialog', (d) => d.accept());
    await page.goto(`${BASE}/pages/envios.html`);
    await esperar(1500);
    check('Cargar envío tiene el tilde "Entrega residencial"', !!(await page.$('#residencial')));
    await page.goto(`${BASE}/pages/envios.html?id=${sin.id}`).catch(() => {});
    await page.goto(`${BASE}/pages/salidas.html?desde=2026-10-08&hasta=2026-10-08`);
    await esperar(2500);
    await page.click('text=1Z000RESID00000001');
    await esperar(1000);
    check('el modal de Salidas tiene el tilde "Residencial", destildado en el envío sin', !!(await page.$('#saled-residencial')) && !(await page.isChecked('#saled-residencial')));
    await page.check('#saled-residencial');
    await page.click('#saled-recalcular');
    await esperar(1500);
    const extrasTxt = await page.textContent('#saled-extras-block');
    check('Recalcular con el tilde agrega "Entrega residencial 6.00" al desglose', /residencial/i.test(extrasTxt) && /6[.,]00/.test(extrasTxt), extrasTxt.replace(/\s+/g, ' ').slice(0, 200));
    await page.click('#sal-modal-save');
    await esperar(1500);
    const g = (await J('GET', `/envios/${sin.id}`)).body;
    check('Guardar persiste la tilde y el cargo', Number(g.residencial) === 1 && /residencial/i.test(String(g.extras_json)), JSON.stringify({ r: g.residencial, e: String(g.extras_json).slice(0, 80) }));
    check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));
    await browser.close();
  } else {
    console.log('  ⚠ playwright no está instalado — se saltean las pantallas.');
  }

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  matar();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1500).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
