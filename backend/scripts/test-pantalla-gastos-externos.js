#!/usr/bin/env node
// Gastos externos del envío (16/11/2026, pedido de Felipe): Vía Cargo, flete interno, etc.
// Ya se podían poner en la cotización; ahora también:
//   · en la CARGA del envío: lista "Gastos externos" (concepto + USD). Al guardar quedan
//     como cargos al costo del envío, con su nombre, APARTE del precio;
//   · en SALIDAS: botón "+ Agregar gasto externo" en la ventana de edición del envío;
//   · un renglón a medias (importe sin concepto) no deja guardar: es plata;
//   · al editar un envío ya cargado, la carga manda a Salidas (no se duplican).
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3996;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_gastos_externos.db';
const TOKEN = 'token-test-gastos-ext';
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const cerca = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

(async () => {
  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production', SALUD_AUTO: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  process.on('exit', () => { try { srv.kill(); } catch {} });
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const cli = (await J('POST', '/clientes', { nombre: 'GASTOS EXTERNOS SA', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
  const salidas = async () => { const r = (await J('GET', `/salidas?desde=${hoy.slice(0, 8)}01`)).body; return (r.envios || r.data || r).filter((e) => e.cliente_id === cli.id); };

  const exe = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = []; page.on('pageerror', (e) => errores.push(e.message));
  page.on('dialog', (d) => d.accept());

  console.log('\n1. Carga del envío\n');
  await page.goto(`${BASE}/pages/envios.html`);
  await page.waitForSelector('#cliente_id option[value="' + cli.id + '"]', { state: 'attached' });
  check('la carga muestra "Gastos externos" con su botón', await page.isVisible('#env-gastos') && await page.isVisible('#btn-gasto-externo'));
  const llenar = async (guia, total) => {
    await page.selectOption('#cliente_id', String(cli.id));
    await page.selectOption('#courier', 'UPS');
    await page.selectOption('#tipo_envio', 'exportacion');
    await page.fill('#numero_guia', guia);
    await page.selectOption('#pais_destino', { label: 'Estados Unidos' }).catch(() => page.selectOption('#pais_destino', 'Estados Unidos'));
    await page.fill('#peso_real', '10');
    await page.fill('#largo', '20'); await page.fill('#ancho', '20'); await page.fill('#alto', '20');
    await page.fill('#fob', '300');
    await esperar(1200);                      // el cotizador automático puede escribir el total
    await page.fill('#total_cobrado', String(total));
  };
  await llenar('1Z327W096792000011', 400);
  await page.click('#btn-gasto-externo');
  await page.fill('#gastos-lista .env-gasto-row:nth-child(1) .g-concepto', 'Vía Cargo');
  await page.fill('#gastos-lista .env-gasto-row:nth-child(1) .g-monto', '35.5');
  await page.click('#btn-gasto-externo');
  await page.fill('#gastos-lista .env-gasto-row:nth-child(2) .g-monto', '12');          // sin concepto
  check('el resumen muestra los gastos aparte del precio', (await page.textContent('#env-resumen [data-r="gastos"]')).includes('35,5') || (await page.textContent('#env-resumen [data-r="gastos"]')).includes('35.5'), await page.textContent('#env-resumen [data-r="gastos"]'));
  await page.click('#btn-guardar-envio'); await esperar(900);
  check('renglón a medias (importe sin concepto): NO guarda y avisa', (await salidas()).length === 0 && /incompleto/i.test(await page.textContent('#alert-box')), await page.textContent('#alert-box'));
  await page.fill('#gastos-lista .env-gasto-row:nth-child(2) .g-concepto', 'Flete interno');
  await page.click('#btn-gasto-externo');                                                  // renglón vacío: se ignora
  await page.click('#btn-guardar-envio');
  await page.waitForFunction(() => /registrado/i.test(document.getElementById('alert-box').textContent), null, { timeout: 8000 }).catch(() => {});
  const aviso = await page.textContent('#alert-box');
  check('guarda y avisa que cargó los 2 gastos externos', /2 gastos externos/.test(aviso), aviso);
  let s = await salidas();
  const e1 = s[0];
  const cargos1 = e1 ? (e1.cargos || []).filter((c) => c.estado !== 'anulado') : [];
  check('el envío quedó con 2 cargos: Vía Cargo 35,50 y Flete interno 12', cargos1.length === 2 && cargos1.some((c) => c.label === 'Vía Cargo' && cerca(c.monto, 35.5)) && cargos1.some((c) => c.label === 'Flete interno' && cerca(c.monto, 12)), JSON.stringify(cargos1.map((c) => [c.label, c.monto])));
  check('el precio del envío no se toca (400) y la venta total suma los gastos (447,50)', e1 && cerca(e1.total_cobrado ?? e1.total, 400) && cerca(e1.venta_total, 447.5), e1 && `total ${e1.total_cobrado ?? e1.total} venta_total ${e1.venta_total}`);
  check('después de guardar la lista queda vacía', (await page.locator('#gastos-lista .env-gasto-row').count()) === 0);

  await llenar('1Z327W096792000022', 250);
  await page.click('#btn-guardar-envio');
  await page.waitForFunction(() => /registrado/i.test(document.getElementById('alert-box').textContent), null, { timeout: 8000 }).catch(() => {});
  s = await salidas();
  const e2 = s.find((e) => e.numero_guia === '1Z327W096792000022');
  check('un envío sin gastos externos se carga igual que siempre (sin cargos)', e2 && !(e2.cargos || []).length && cerca(e2.venta_total, 250), e2 && JSON.stringify(e2.cargos));

  console.log('\n2. Salidas\n');
  await page.goto(`${BASE}/pages/salidas.html`);
  await page.waitForSelector(`tr[data-envio-id="${e2.id}"]`);
  await page.click(`tr[data-envio-id="${e2.id}"] td[data-col="cliente"]`).catch(() => page.click(`tr[data-envio-id="${e2.id}"] td[data-col="courier"]`));
  await page.waitForSelector('#saled-gasto-btn');
  check('la ventana del envío tiene "+ Agregar gasto externo"', await page.isVisible('#saled-gasto-btn') && /gastos externos/i.test(await page.textContent('#saled-cargos-block')));
  await page.click('#saled-gasto-btn');
  check('abre directo el concepto (sin elegir tipo)', await page.isVisible('#saled-cargo-label') && !(await page.isVisible('#saled-cargo-tipo')));
  await page.fill('#saled-cargo-monto', '40');
  await page.click('#saled-cargo-form button[type=submit]'); await esperar(500);
  check('sin concepto no guarda', /concepto/i.test(await page.textContent('#saled-cargo-status')) && !((await salidas()).find((e) => e.id === e2.id).cargos || []).length);
  await page.fill('#saled-cargo-label', 'Vía Cargo');
  await page.click('#saled-cargo-form button[type=submit]');
  await page.waitForFunction(() => /Vía Cargo/.test(document.getElementById('saled-cargos-block').textContent) && !document.getElementById('saled-cargo-status').textContent, null, { timeout: 8000 }).catch(() => {});
  s = await salidas();
  const e2b = s.find((e) => e.id === e2.id);
  check('queda como cargo "Vía Cargo" de 40 y la venta total pasa a 290', (e2b.cargos || []).length === 1 && e2b.cargos[0].label === 'Vía Cargo' && cerca(e2b.cargos[0].monto, 40) && cerca(e2b.venta_total, 290), JSON.stringify(e2b.cargos) + ' ' + e2b.venta_total);
  check('la utilidad del envío no cambia (va al costo)', cerca(e2b.profit ?? 0, e2.profit ?? 0) || cerca(e2b.utilidad ?? 0, e2.utilidad ?? 0), `${e2.profit} → ${e2b.profit}`);
  check('"+ Agregar cargo" sigue ofreciendo los tipos de siempre', await page.isVisible('#saled-cargo-btn') && await (async () => { await page.click('#saled-cargo-btn'); return page.isVisible('#saled-cargo-tipo'); })());

  console.log('\n3. Editar un envío ya cargado\n');
  await page.goto(`${BASE}/pages/envios.html`);
  await page.waitForSelector('#cliente_id option[value="' + cli.id + '"]', { state: 'attached' });
  await page.click('#btn-gasto-externo');
  await page.click('.tab[data-tab="listado"]');
  await page.waitForSelector(`[data-edit="${e2.id}"]`);
  await page.click(`[data-edit="${e2.id}"]`);
  await page.waitForFunction(() => document.getElementById('form-title').textContent === 'Editar envío');
  await esperar(400);
  check('al editar: no deja agregar acá, vacía la lista y manda a Salidas', !(await page.isVisible('#btn-gasto-externo')) && await page.isVisible('#gastos-edicion') && (await page.locator('#gastos-lista .env-gasto-row').count()) === 0);
  await page.click('#btn-cancelar-edit'); await esperar(300);
  check('al cancelar la edición vuelve el botón para un envío nuevo', await page.isVisible('#btn-gasto-externo') && !(await page.isVisible('#gastos-edicion')));
  check('sin errores de JavaScript en las pantallas', errores.length === 0, errores.join(' | '));

  await browser.close();
  console.log(`\n${ok} pasaron · ${fail} fallaron\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
