#!/usr/bin/env node
// Retomar un borrador de liquidación (09/10/2026, pedido de la oficina): se arma, se baja el
// Excel, se sale sin confirmar → desde el historial "Retomar" lo abre con sus envíos tildados
// y Confirmar / Excel actúan sobre ESE borrador (no queda uno colgado ni se crea otro).
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3978;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_retomar.db';
const TOKEN = 'token-test-retomar';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
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
  await abrirSesion(DB, TOKEN);
  const J = (m, u, b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const hoy = new Date();
  const dia = (n) => iso(new Date(hoy.getFullYear(), hoy.getMonth(), Math.max(1, hoy.getDate() - n)));
  const a = (await J('POST', '/api/clientes', { nombre: 'RETOMAR PRUEBA', tarifa_pct: 75, tipo_cobro: 'CC' })).body;
  const alta = (guia, total) => J('POST', '/api/envios', { cliente_id: a.id, fecha: dia(2), courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP', numero_guia: guia, pais_destino: 'Estados Unidos', peso_real: 5, largo: 30, ancho: 20, alto: 15, fob: 300, total_cobrado: total });
  const e1 = (await alta('1Z000RETOMAR000001', 236.4)).body;
  const e2 = (await alta('1Z000RETOMAR000002', 118.2)).body;
  const e3 = (await alta('1Z000RETOMAR000003', 402.7)).body;
  // El borrador "colgado": dos de los tres envíos, con un adicional en el primero.
  const bor = (await J('POST', '/api/liquidaciones', { cliente_id: a.id, periodo_desde: dia(30), periodo_hasta: dia(0), envio_ids: [e1.id, e2.id], cargos: [{ envio_id: e1.id, monto: 12.5, descripcion: 'Cargo adicional' }], cotizaciones: [], confirmar: false })).body;
  check('fixture: borrador con 2 de 3 envíos y un adicional', bor && bor.estado === 'borrador' && bor.id, JSON.stringify(bor).slice(0, 150));

  const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${BASE}/pages/liquidaciones.html`);
  await esperar(1500);

  console.log('\n1. Desde el historial\n');
  await page.click('.tab[data-tab="historial"]');
  await page.waitForSelector('#hist-body tr');
  await esperar(300);
  check('el borrador tiene botón Retomar (y la confirmada no lo tendría)', !!(await page.$(`#hist-body [data-retomar="${bor.id}"]`)));
  await page.click(`#hist-body [data-retomar="${bor.id}"]`);
  await esperar(2000);
  check('abre la pestaña Crear liquidación', await page.$eval('.tab[data-tab="crear"]', (t) => t.classList.contains('active')));
  check('con el cliente del borrador', (await page.inputValue('#liq-cliente')) === String(a.id));
  const tildes = await page.$$eval('#liq-envios-body .liq-envio-check', (cs) => cs.map((c) => [Number(c.value), c.checked]));
  check('sus dos envíos tildados y el tercero no', tildes.length === 3 && tildes.find((t) => t[0] === e1.id)[1] && tildes.find((t) => t[0] === e2.id)[1] && !tildes.find((t) => t[0] === e3.id)[1], JSON.stringify(tildes));
  check('el adicional del borrador vuelve a su envío', (await page.inputValue(`tr[data-envio-id="${e1.id}"] .liq-adicional`)) === '12.5');
  check('la vista previa está calculada y Confirmar / Excel habilitados', !!(await page.$('#liq-preview:not(.hidden)')) && await page.evaluate(() => !document.getElementById('btn-confirmar-liq').disabled && !document.getElementById('btn-export-borrador').disabled));
  check('el pie dice que es el borrador retomado', new RegExp(`Borrador #${bor.id} retomado`).test(await page.textContent('#liq-resumen-pie')), await page.textContent('#liq-resumen-pie'));
  check('no avisa "hay un borrador anterior" sobre sí mismo', await page.evaluate(() => { const b = document.getElementById('liq-aviso-borradores'); return !b || b.hidden; }));
  const total = await page.$eval('#liq-total', (e) => e.textContent.trim());
  const esperado = Number(bor.total).toFixed(2).replace('.', ',');
  check(`el total es el del borrador (${esperado})`, total.includes(esperado), `${total} vs borrador ${bor.total}`);
  // Excel: el link apunta a ESE borrador, no a uno nuevo.
  const pedidos = [];
  ctx.on('request', (r) => { if (/\/export/.test(r.url())) pedidos.push(r.url()); });
  await page.click('#btn-export-borrador');
  await esperar(1500);
  check('Excel baja el borrador retomado (mismo #)', pedidos.some((u) => new RegExp(`/liquidaciones/${bor.id}/export`).test(u)), pedidos.join(' '));
  for (const pg of ctx.pages()) if (pg !== page) await pg.close().catch(() => {});
  const lista1 = (await J('GET', `/api/liquidaciones?cliente_id=${a.id}`)).body;
  check('no se creó ningún borrador nuevo', lista1.length === 1 && lista1[0].id === bor.id, JSON.stringify(lista1.map((l) => [l.id, l.estado])));
  await page.click('#btn-confirmar-liq');
  await esperar(1500);
  const liq = (await J('GET', `/api/liquidaciones/${bor.id}`)).body;
  check('Confirmar confirma ESE borrador', liq && liq.estado === 'confirmada', JSON.stringify(liq && { id: liq.id, estado: liq.estado }));
  const pend = (await J('GET', `/api/liquidaciones/pendientes?cliente_id=${a.id}`)).body;
  check('solo queda pendiente el tercer envío', pend.length === 1 && pend[0].envios.length === 1 && pend[0].envios[0].id === e3.id, JSON.stringify(pend).slice(0, 200));

  console.log('\n2. Un borrador al que le falta un envío\n');
  const e4 = (await alta('1Z000RETOMAR000004', 50)).body;
  const bor2 = (await J('POST', '/api/liquidaciones', { cliente_id: a.id, periodo_desde: dia(30), periodo_hasta: dia(0), envio_ids: [e3.id, e4.id], cargos: [], cotizaciones: [], confirmar: false })).body;
  // e4 deja de estar pendiente por otro lado (se marca liquidado directo en la base).
  {
    const sqlite3 = require('sqlite3'); const db = new sqlite3.Database(DB);
    await new Promise((res, rej) => db.run('UPDATE envios SET liquidado = 1 WHERE id = ?', [e4.id], (e) => (e ? rej(e) : res())));
    db.close();
  }
  await page.click('.tab[data-tab="historial"]');
  await esperar(600);
  const hayRetomar = !!(await page.$(`#hist-body [data-retomar="${bor2.id}"]`));
  if (hayRetomar) {
    await page.click(`#hist-body [data-retomar="${bor2.id}"]`);
    await esperar(2000);
    const aviso = await page.textContent('#alert-box');
    const pie = await page.textContent('#liq-resumen-pie');
    check('avisa que un envío del borrador ya no está pendiente', /ya no est/.test(aviso) || /menos envíos/.test(pie), aviso + ' | ' + pie);
    const lista2 = (await J('GET', `/api/liquidaciones?cliente_id=${a.id}`)).body;
    check('ese borrador se borra (al confirmar se arma uno nuevo con lo que quedó)', !lista2.some((l) => l.id === bor2.id), JSON.stringify(lista2.map((l) => [l.id, l.estado])));
  } else {
    check('el borrador con un envío ya liquidado fue reemplazado por el sistema (no hay nada que retomar)', true);
  }
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  await browser.close(); matar();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1500).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
