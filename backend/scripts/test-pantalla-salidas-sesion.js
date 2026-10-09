#!/usr/bin/env node
// Salidas, dos pedidos de la oficina (09/10/2026):
//   1. Las leyendas de un Recalcular / Calcular venta de un envío no pueden quedar a la
//      vista al abrir OTRO envío sin haber guardado.
//   2. El surge de UPS se lee CON su fuel en Salidas (chips del desglose y modal), como lo
//      desglosa la liquidación. Los números guardados no cambian.
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3977;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_salidas_sesion.db';
const TOKEN = 'token-test-sal-sesion';
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
  await J('PUT', '/api/configuracion/fuel/UPS', { fuel_pct: 40 });
  const hoy = new Date();
  const fecha = iso(new Date(hoy.getFullYear(), hoy.getMonth(), Math.max(1, hoy.getDate() - 1)));
  const cli = (await J('POST', '/api/clientes', { nombre: 'SESION PRUEBA', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  const alta = (guia, total) => J('POST', '/api/envios', { cliente_id: cli.id, fecha, courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP', numero_guia: guia, pais_destino: 'Estados Unidos', peso_real: 10, largo: 30, ancho: 20, alto: 15, fob: 300, total_cobrado: total });
  const e1 = (await alta('1Z000SESION0000001', 100)).body;
  const e2 = (await alta('1Z000SESION0000002', 100)).body;
  const filas = (await J('GET', `/api/salidas?desde=${fecha}&hasta=${fecha}`)).body;
  const f1 = filas.find((r) => r.id === e1.id);
  const surge = ((f1 && f1.extras) || []).find((x) => x.tipo === 'surge');
  check('fixture: dos envíos UPS con surge y fuel 40 %', e1 && e1.id && e2 && e2.id && surge && f1.fuel_pct === 40, JSON.stringify(f1 && { extras: f1.extras, fuel_pct: f1.fuel_pct }));

  const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(2500);

  console.log('\n1. Las leyendas no se arrastran de un envío al otro\n');
  await page.click('text=1Z000SESION0000001');
  await esperar(800);
  await page.click('#saled-calcular-venta');
  await esperar(1500);
  check('Calcular venta muestra el panel del precio sugerido', !!(await page.$('#saled-venta-panel:not(.hidden)')));
  await page.click('#saled-venta-aplicar');
  await esperar(300);
  check('al aplicar queda la leyenda "Venta aplicada…"', /Venta aplicada/.test(await page.textContent('#saled-venta-status')));
  await page.click('#saled-recalcular');
  await esperar(1500);
  const rec = await page.textContent('#saled-recalc-status');
  check('Recalcular deja su leyenda', rec.trim().length > 0, rec);
  // Se va SIN guardar y abre el otro envío.
  await page.click('#sal-modal-cancel');
  await esperar(500);
  await page.click('text=1Z000SESION0000002');
  await esperar(800);
  check('el otro envío abre sin la leyenda de venta del anterior', (await page.textContent('#saled-venta-status')).trim() === '', await page.textContent('#saled-venta-status'));
  check('ni la de recalcular', (await page.textContent('#saled-recalc-status')).trim() === '');
  check('ni el panel del precio sugerido', !(await page.$('#saled-venta-panel:not(.hidden)')));
  check('y con SU total, no el aplicado al anterior', Number(await page.inputValue('#saled-total')) === 100, await page.inputValue('#saled-total'));

  console.log('\n2. El surge se lee con fuel, como en la liquidación\n');
  const modal = await page.textContent('#saled-extras-block');
  const conFuel = Math.round(surge.monto * 1.4 * 100) / 100;
  check(`el desglose del modal dice "Surge fee … (con fuel)" ${conFuel.toFixed(2)} (surge ${surge.monto} × 1,40)`, /\(con fuel\)/.test(modal) && modal.includes(conFuel.toFixed(2)), modal.replace(/\s+/g, ' ').slice(0, 200));
  check('y aclara que el total del desglose no lleva el fuel del surge', /sin el fuel del surge/.test(modal));
  await page.click('#sal-modal-cancel');
  await esperar(400);
  await page.click(`tr[data-envio-id="${e2.id}"] .adic-cell .extras-toggle`);
  await esperar(500);
  const chips = await page.textContent(`tr.extras-detail-row[data-extras-for="${e2.id}"]`);
  check('el chip del surge en la grilla también va con fuel', /\(con fuel\)/.test(chips) && chips.includes(conFuel.toFixed(2)), chips.replace(/\s+/g, ' ').slice(0, 200));
  const fila = (await J('GET', `/api/salidas?desde=${fecha}&hasta=${fecha}`)).body.find((r) => r.id === e2.id);
  check('los números guardados no cambiaron (Fuel sigue con el fuel del surge adentro)', Math.abs(fila.fuel - Math.round((fila.flete + surge.monto) * 0.4 * 100) / 100) < 0.02 && fila.fuel_pct === 40, JSON.stringify({ flete: fila.flete, fuel: fila.fuel, adic: fila.adicionales, fuel_pct: fila.fuel_pct }));
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  await browser.close(); matar();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1500).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
