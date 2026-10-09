#!/usr/bin/env node
// Seguro opcional (09/10/2026, pedido de Felipe): DHL arranca en USD 100 como UPS, y el
// tilde "Asegurado" manda — se prende solo desde 100 pero se puede sacar o poner a mano.
//   1. Motor: DHL < 100 sin seguro; asegurado=false lo saca; asegurado=true lo pone (mínimo).
//   2. Alta de envío: el seguro congelado sigue al tilde; sin tilde explícita, el flag
//      guardado dice lo que se cobró.
//   3. Cotizar (envio_id / body) y Recalcular de Salidas respetan el tilde.
//   4. Migración una vez: envíos viejos con seguro cobrado y sin tilde quedan asegurados.
//   5. Pantalla Envíos: el tilde se prende solo desde 100 y al sacarlo el precio baja.
let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const core = require('../../shared/cotizador/cotizador-core.js');
const PORT = process.env.PORT_TEST || 3983;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_seguro_opcional.db';
const TOKEN = 'token-test-seguro-opc';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n1. Motor\n');
  const q = (serv, fob, asegurado) => core.cotizarServicio(serv, { pais: 'España', tipo: 'export', pf: 5, fob, fuelPct: 0, profitPct: 0, bultosProc: [{ dims: [30, 20, 15], pr: 5, pf: 5 }], contenido: 'paquete', asegurado });
  check('DHL con valor 50: sin seguro (antes cobraba 17,50)', q('DHL', 50).seguro === 0 && core.calcSeguroDHL(50).monto === 0);
  check('DHL con valor 100: 17,50 (mínimo)', q('DHL', 100).seguro === 17.5);
  check('DHL con valor 2.000: 1,5 % = 30', q('DHL', 2000).seguro === 30);
  check('UPS sigue igual: 50 → 0, 100 → 15', q('UPS_EXP', 50).seguro === 0 && q('UPS_EXP', 100).seguro === 15);
  check('asegurado = false saca el seguro aunque valga 2.000 (DHL y UPS)', q('DHL', 2000, false).seguro === 0 && q('UPS_EXP', 2000, false).seguro === 0);
  check('asegurado = true con valor 50 pone el mínimo (DHL 17,50 · UPS 15)', q('DHL', 50, true).seguro === 17.5 && q('UPS_EXP', 50, true).seguro === 15);
  check('asegurado = true con valor 2.000 no cambia la escala (30)', q('DHL', 2000, true).seguro === 30);
  check('asegurado = true con valor 0: nada que asegurar', q('DHL', 0, true).seguro === 0);
  check('seguro propio del cliente + asegurado = true con valor 50: su cuenta (mínimo 10)', q('DHL', 50, true) && core.calcSeguro('DHL', 50, { pct: 1, min: 10 }, true).monto === 10);

  console.log('\n2. API: alta, cotizar y recalcular\n');
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const J = (m, u, b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  await J('PUT', '/api/configuracion/fuel/DHL', { fuel_pct: 30 });
  await J('PUT', '/api/configuracion/fuel/UPS', { fuel_pct: 30 });
  const cli = (await J('POST', '/api/clientes', { nombre: 'SEGURO OPC', tarifa_pct: 50, tipo_cobro: 'CC' })).body;
  const base = { cliente_id: cli.id, fecha: '2026-10-08', courier: 'DHL', tipo_envio: 'exportacion', pais_destino: 'España', peso_real: 5, largo: 30, ancho: 20, alto: 15 };
  const e1 = (await J('POST', '/api/envios', { ...base, numero_guia: '1100000001', fob: 50 })).body;
  check('alta DHL valor 50 sin tilde: seguro 0 y asegurado 0', e1.seguro === 0 && Number(e1.asegurado) === 0, JSON.stringify({ s: e1.seguro, a: e1.asegurado }));
  const e2 = (await J('POST', '/api/envios', { ...base, numero_guia: '1100000002', fob: 500 })).body;
  check('alta DHL valor 500 sin tilde explícita: seguro 17,50 y el flag queda en 1', e2.seguro === 17.5 && Number(e2.asegurado) === 1, JSON.stringify({ s: e2.seguro, a: e2.asegurado }));
  const e3 = (await J('POST', '/api/envios', { ...base, numero_guia: '1100000003', fob: 500, asegurado: 0 })).body;
  check('alta valor 500 con tilde apagado a mano: seguro 0', e3.seguro === 0 && Number(e3.asegurado) === 0, JSON.stringify({ s: e3.seguro, a: e3.asegurado }));
  const e4 = (await J('POST', '/api/envios', { ...base, numero_guia: '1100000004', fob: 50, asegurado: 1 })).body;
  check('alta valor 50 con tilde prendido a mano: 17,50', e4.seguro === 17.5 && Number(e4.asegurado) === 1, JSON.stringify({ s: e4.seguro, a: e4.asegurado }));
  const cot3 = (await J('POST', '/api/liquidaciones/cotizar', { envio_id: e3.id })).body;
  const cot2 = (await J('POST', '/api/liquidaciones/cotizar', { envio_id: e2.id })).body;
  check('cotizar con envio_id respeta el tilde (e3 sin seguro, e2 con)', !(cot3.extras || []).some((x) => /Seguro/.test(x[0])) && (cot2.extras || []).some((x) => /Seguro/.test(x[0])), JSON.stringify([cot3.extras, cot2.extras]));
  const cotBody = (await J('POST', '/api/liquidaciones/cotizar', { envio_id: e2.id, asegurado: false })).body;
  check('el body pisa al envío (e2 con asegurado:false → sin seguro)', !(cotBody.extras || []).some((x) => /Seguro/.test(x[0])) && cotBody.precioFinal < cot2.precioFinal);
  const rec = (await J('POST', `/api/salidas/${e2.id}/recalcular`, { asegurado: 0 })).body;
  check('Recalcular con el tilde apagado saca el seguro del costo', rec && Number(rec.seguro) === 0, JSON.stringify(rec).slice(0, 160));
  const rec2 = (await J('POST', `/api/salidas/${e2.id}/recalcular`, {})).body;
  check('Recalcular sin mandar el tilde usa el del envío (sigue en 1 → 17,50)', rec2 && Number(rec2.seguro) === 17.5, JSON.stringify(rec2).slice(0, 160));
  const rec3 = (await J('POST', `/api/salidas/${e1.id}/recalcular`, { fob: 500 })).body;
  check('Recalcular con OTRO valor declarado y sin decir nada del tilde vuelve al automático (50 → 500: 17,50)', rec3 && Number(rec3.seguro) === 17.5, JSON.stringify(rec3).slice(0, 160));
  const rec4 = (await J('POST', `/api/salidas/${e1.id}/recalcular`, { fob: 500, asegurado: 0 })).body;
  check('pero si el tilde viene apagado, manda el tilde (0)', rec4 && Number(rec4.seguro) === 0, JSON.stringify(rec4).slice(0, 160));

  console.log('\n3. Migración una vez\n');
  const sqlite3 = require('sqlite3'); const db = new sqlite3.Database(DB);
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));
  const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await run('UPDATE envios SET asegurado = 0 WHERE id = ?', [e2.id]);
  await run("DELETE FROM migraciones_una_vez WHERE clave = 'asegurado_segun_seguro'");
  db.close();
  matar(); await esperar(800);
  const srv2 = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo2 = '', le2 = ''; srv2.stdout.on('data', (d) => { lo2 += d; }); srv2.stderr.on('data', (d) => { le2 += d; });
  const matar2 = () => { try { srv2.kill(); } catch {} };
  process.on('exit', matar2);
  await esperarServidor(srv2, BASE, () => le2, () => lo2);
  const db2 = new sqlite3.Database(DB);
  const fila = await new Promise((res, rej) => db2.get('SELECT asegurado, seguro FROM envios WHERE id = ?', [e2.id], (e, r) => (e ? rej(e) : res(r))));
  const fila1 = await new Promise((res, rej) => db2.get('SELECT asegurado, seguro FROM envios WHERE id = ?', [e1.id], (e, r) => (e ? rej(e) : res(r))));
  db2.close();
  check('un envío viejo con seguro cobrado y sin tilde queda asegurado al arrancar', Number(fila.asegurado) === 1, JSON.stringify(fila));
  check('y uno sin seguro sigue sin tilde', Number(fila1.asegurado) === 0, JSON.stringify(fila1));

  if (chromium) {
    console.log('\n4. Pantalla Cargar envío\n');
    const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', (e) => errores.push(String(e)));
    await page.goto(`${BASE}/pages/envios.html`);
    await esperar(2000);
    await page.selectOption('#cliente_id', String(cli.id));
    await page.selectOption('#courier', 'DHL');
    await page.selectOption('#pais_destino', 'España');
    await page.fill('#peso_real', '5'); await page.fill('#largo', '30'); await page.fill('#ancho', '20'); await page.fill('#alto', '15');
    await page.fill('#fob', '500');
    await esperar(1200);
    check('con FOB 500 el tilde se prende solo', await page.isChecked('#asegurado'));
    const t1 = Number(await page.inputValue('#cot-precio-editable'));
    await page.click('label[for="asegurado"]');
    await esperar(1200);
    const t2 = Number(await page.inputValue('#cot-precio-editable'));
    check(`sacar el tilde recotiza sin seguro (${t1} → ${t2})`, !(await page.isChecked('#asegurado')) && t2 > 0 && t2 < t1 && Math.abs((t1 - t2) - 17.5) < 0.02, `${t1} → ${t2}`);
    await page.fill('#fob', '50');
    await esperar(1200);
    check('FOB 50: el tilde ya tocado a mano no se vuelve a mover', !(await page.isChecked('#asegurado')));
    check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

    console.log('\n5. Modal de Salidas\n');
    await page.goto(`${BASE}/pages/salidas.html?desde=2026-10-08&hasta=2026-10-08`);
    await esperar(2500);
    await page.click('text=1100000001');
    await esperar(800);
    check('el envío de valor 50 abre sin tilde', !(await page.isChecked('#saled-asegurado')));
    await page.fill('#saled-fob', '500');
    await esperar(200);
    check('al subir el valor declarado a 500 el tilde se prende solo', await page.isChecked('#saled-asegurado'));
    await page.click('label.sal-chk:has(#saled-asegurado)');
    await page.fill('#saled-fob', '800');
    await esperar(200);
    check('sacado a mano, no se vuelve a prender aunque cambie el valor', !(await page.isChecked('#saled-asegurado')));
    await page.click('#saled-recalcular');
    await esperar(1500);
    check('Recalcular con el tilde apagado deja el seguro en 0', Number(await page.inputValue('#saled-seguro')) === 0, await page.inputValue('#saled-seguro'));
    await page.click('label.sal-chk:has(#saled-asegurado)');
    await page.click('#saled-recalcular');
    await esperar(1500);
    check('y prendido a mano, Recalcular lo pone (800 × 1,5 % = 12 → mínimo 17,50)', Number(await page.inputValue('#saled-seguro')) === 17.5, await page.inputValue('#saled-seguro'));
    check('ningún error en Salidas', errores.length === 0, errores.slice(0, 3).join(' | '));
    await browser.close();
  }

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  matar2();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1500).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
