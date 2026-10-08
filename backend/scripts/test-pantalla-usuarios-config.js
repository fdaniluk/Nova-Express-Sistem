#!/usr/bin/env node
// Usuarios y Configuración con la estética del sistema (08/10/2026, ítem 6).
//   · Usuarios: alta con permisos como chips, lista con chips que se prenden/apagan, último
//     acceso, resetear contraseña en la fila, desactivar/activar.
//   · Configuración: tres pestañas, fuel/umbral/tolerancias siguen guardando, corte,
//     margen y proforma en filas de ajuste.
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3973;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_usr_cfg.db';
const TOKEN = 'token-test-usr-cfg';
const SHOTS = process.env.SHOTS_DIR || null;
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  // El tester (abrirSesion) es admin; se crea un empleado para probar los chips.
  const emp = await J('POST', '/usuarios', { usuario: 'gabriela_test', password: 'secreto123', rol: 'empleado', ver_dashboard: 1, editar_config: 0, ver_salud: 0, cerrar_mes: 0, confirmar_pagos: 0 });
  check('fixture: empleado creado por API', emp.status === 201 || emp.status === 200, JSON.stringify(emp.body).slice(0, 120));
  const lista = (await J('GET', '/usuarios')).body;
  check('el listado trae ultimo_acceso', Array.isArray(lista) && lista.some((u) => 'ultimo_acceso' in u), JSON.stringify(lista).slice(0, 200));

  const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text()); });
  page.on('dialog', (d) => d.accept());

  console.log('\n1. Usuarios\n');
  await page.goto(`${BASE}/pages/usuarios.html`);
  await esperar(1800);
  check('los dos pasos en tarjetas', (await page.$$('.usr-paso')).length === 2);
  check('los permisos del alta son chips con su checkbox adentro', (await page.$$('#usr-permisos-alta .usr-perm input[type=checkbox]')).length === 6);
  await page.click('label[for="u-ver-salud"]');
  await esperar(200);
  check('tocar el chip tilda el checkbox', await page.isChecked('#u-ver-salud'));
  const resumen = await page.textContent('#usr-resumen');
  check('la cabecera dice cuántos activos hay', /activos?/.test(resumen), resumen);
  const fila = await page.$('tr:has-text("gabriela_test")');
  check('el empleado aparece con sus chips de permiso', !!fila && (await fila.$$('.usr-mini')).length === 6);
  const dash = await fila.$('.usr-mini[data-permiso="ver_dashboard"]');
  check('Dashboard está prendido (se creó con ver_dashboard)', await dash.evaluate((b) => b.classList.contains('on')));
  await (await fila.$('.usr-mini[data-permiso="cerrar_mes"]')).click();
  await esperar(900);
  const emp2 = (await J('GET', '/usuarios')).body.find((u) => u.usuario === 'gabriela_test');
  check('un click en el chip guarda el permiso (cerrar_mes = 1)', emp2 && Number(emp2.cerrar_mes) === 1, JSON.stringify(emp2));
  const fila2 = await page.$('tr:has-text("gabriela_test")');
  check('y el chip queda prendido al refrescar', await (await fila2.$('.usr-mini[data-permiso="cerrar_mes"]')).evaluate((b) => b.classList.contains('on')));
  check('el administrador muestra "todos" en vez de chips', /todos/.test(await page.textContent('#tabla-usuarios tr:first-child')));
  check('estado como chip y botones con borde', !!(await page.$('#tabla-usuarios .usr-chip-ok')) && !!(await page.$('#tabla-usuarios .reset-pwd.btn-outline')));
  await (await fila2.$('.reset-pwd')).click();
  await esperar(300);
  check('resetear contraseña abre el campo en la fila', !!(await page.$('.pwd-inline input')));
  await page.fill('.pwd-inline input', 'nueva12345');
  await page.click('.pwd-inline .btn-coral');
  await esperar(800);
  check('y guarda sin romper', !(await page.$('.pwd-inline')));
  await (await page.$('tr:has-text("gabriela_test") .toggle-activo')).click();
  await esperar(900);
  check('Desactivar deja la fila inactiva (chip gris, sin chips de permiso clickeables)', !!(await page.$('tr.usr-inactivo:has-text("gabriela_test") .usr-chip-gris')));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'usuarios.png'), fullPage: true });

  console.log('\n2. Configuración\n');
  await page.goto(`${BASE}/pages/configuracion.html`);
  await esperar(2000);
  check('tres pestañas: Fuel · Controles · Sistema', (await page.$$('.tabs .tab[data-tab]')).length === 3);
  check('arranca en Fuel con las tres tarjetas (Nova, DHL, UPS)', (await page.$$('#tab-fuel .fuel-card')).length === 3 && !!(await page.$('.fuel-card--nova')));
  check('el historial del fuel está plegado', !(await page.$eval('#tab-fuel details', (d) => d.open)));
  const nova = await page.$('.fuel-card[data-courier="NOVA"]');
  await nova.$eval('.fuel-input', (i) => { i.value = '31,75'; });
  await (await nova.$('.btn-save-fuel')).click();
  await esperar(1200);
  const fuel = (await J('GET', '/configuracion/fuel')).body;
  check('guardar el fuel Nova con coma sigue funcionando (31.75)', Array.isArray(fuel) && fuel.some((f) => f.courier === 'NOVA' && Math.abs(Number(f.fuel_pct) - 31.75) < 0.001), JSON.stringify(fuel).slice(0, 200));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'configuracion-fuel.png'), fullPage: true });
  await page.click('.tab[data-tab="controles"]');
  await esperar(400);
  check('Controles: corte, umbral y tolerancias visibles; Fuel oculto', !!(await page.$('#tab-controles:not(.hidden) #corte-card')) && (await page.$$('#umbral-cards .fuel-card')).length === 2 && (await page.$$('#tolerancia-cards .fuel-card')).length === 2 && !!(await page.$('#tab-fuel.hidden')));
  await page.fill('#corte-input', '2026-08-01');
  await page.click('#btn-corte-guardar');
  await esperar(900);
  check('guardar la fecha de corte', (await J('GET', '/configuracion/corte')).body.fecha_corte_control === '2026-08-01');
  const tolUps = await page.$('#tolerancia-cards .fuel-card[data-courier="UPS"]');
  await tolUps.$eval('.tol-costo-usd', (i) => { i.value = '55'; });
  await (await tolUps.$('.btn-save-tol')).click();
  await esperar(1000);
  const tol = (await J('GET', '/configuracion/tolerancias')).body;
  check('guardar tolerancias UPS (costo USD 55)', Array.isArray(tol) && tol.some((t) => t.courier === 'UPS' && Number(t.tolerancia_costo_usd) === 55), JSON.stringify(tol).slice(0, 200));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'configuracion-controles.png'), fullPage: true });
  await page.click('.tab[data-tab="sistema"]');
  await esperar(400);
  await page.fill('#proforma-input', '1300');
  await page.click('#btn-proforma-guardar');
  await esperar(900);
  check('Sistema: guardar el próximo Nº de proforma', (await J('GET', '/configuracion/proforma')).body.proforma_proximo === 1300 && (await page.textContent('#proforma-actual')) === '1300');
  await page.fill('#margen-input', '45');
  await page.click('#btn-margen-guardar');
  await esperar(900);
  check('y el margen objetivo', /45/.test(await page.textContent('#margen-actual')));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'configuracion-sistema.png'), fullPage: true });
  await page.reload();
  await esperar(1500);
  check('la pestaña se recuerda en el hash al recargar', !!(await page.$('#tab-sistema:not(.hidden)')));
  check('ningún error en las pantallas', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  await browser.close(); matar();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1500).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
