#!/usr/bin/env node
/**
 * test-pantalla-liquidaciones-pendientes.js — Liquidaciones arranca mostrando TODO lo
 * pendiente, no solo el mes en curso (03/09/2026).
 *
 * Pedido de Felipe: "de entrada necesito que muestre todo lo que hay pendiente por perfil
 * para que no se pase nada de largo". Había DOS lugares por donde se pasaba: la pestaña
 * Pendientes arrancaba filtrada por el mes en curso, y el botón "Liquidar" de un grupo
 * saltaba a Crear con ese mismo mes, así que los envíos viejos del grupo desaparecían.
 *
 * Lo que cuida esta tanda: sin fechas se ve un envío de hace tres meses junto al de hoy;
 * el filtro por mes sigue funcionando para quien lo quiera; "Ver todo" lo limpia; y
 * "Liquidar" abre Crear con un período que abarca el envío más viejo del grupo.
 *
 *   cd backend && node scripts/test-pantalla-liquidaciones-pendientes.js
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.log('⚠ playwright no está instalado — se saltea (necesita navegador de verdad).');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3952;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_liq_pend.db';
const TOKEN = 'token-test-liq-pend';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function main() {
  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);
  const esperarSrvMuerto = () => new Promise((res) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return res();
    srv.once('exit', res);
    setTimeout(res, 2000);
  });
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

  const hoy = new Date();
  const hace3 = new Date(hoy.getFullYear(), hoy.getMonth() - 3, 15);
  const cli = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'PENDIENTES VIEJOS', tarifa_pct: 75, tipo_cobro: 'CC' }),
  })).json();
  const alta = (guia, fecha) => fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha, courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP',
      numero_guia: guia, pais_destino: 'Estados Unidos', peso_real: 5, largo: 30, ancho: 20, alto: 15,
      fob: 0, total_cobrado: 150,
    }),
  }).then((r) => r.json());
  await alta('1Z000PENDVIEJO0001', iso(hace3));
  await alta('1Z000PENDHOY000001', iso(hoy));

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text());
  });

  console.log('\n1. Al entrar se ve TODO lo pendiente\n');
  await page.goto(`${BASE}/pages/liquidaciones.html`);
  await esperar(2500);
  check('las fechas de Pendientes arrancan vacías',
    (await page.inputValue('#pend-desde')) === '' && (await page.inputValue('#pend-hasta')) === '');
  let lista = await page.textContent('#pendientes-list');
  check('el envío de hace tres meses está', /1Z000PENDVIEJO0001/.test(lista));
  check('y el de hoy también', /1Z000PENDHOY000001/.test(lista));
  check('agrupados bajo el cliente con "2 envío(s)"', /PENDIENTES VIEJOS/.test(lista) && /2 envío\(s\)/.test(lista));

  console.log('\n2. El filtro por mes sigue andando para quien lo quiera\n');
  await page.fill('#pend-desde', iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1)));
  await page.fill('#pend-hasta', iso(hoy));
  await page.click('#btn-pend-filtrar');
  await esperar(1200);
  lista = await page.textContent('#pendientes-list');
  check('filtrado por el mes en curso, el viejo desaparece', !/1Z000PENDVIEJO0001/.test(lista) && /1Z000PENDHOY000001/.test(lista));

  await page.click('#btn-pend-todo');
  await esperar(1200);
  lista = await page.textContent('#pendientes-list');
  check('"Ver todo" limpia las fechas y lo trae de vuelta',
    (await page.inputValue('#pend-desde')) === '' && /1Z000PENDVIEJO0001/.test(lista));

  console.log('\n3. "Liquidar" abre Crear con un período que abarca al viejo\n');
  await page.click(`[data-liq-cliente="${cli.id}"]`);
  await esperar(1500);
  check('cambió a la pestaña Crear', !!(await page.$('#panel-crear:not(.hidden)')));
  check('con el cliente elegido', (await page.inputValue('#liq-cliente')) === String(cli.id));
  check('el período arranca en la fecha del envío más viejo', (await page.inputValue('#liq-desde')) === iso(hace3),
    await page.inputValue('#liq-desde'));
  check('y termina hoy', (await page.inputValue('#liq-hasta')) === iso(hoy), await page.inputValue('#liq-hasta'));
  const tabla = await page.textContent('#liq-envios-body');
  check('la tabla para liquidar trae LOS DOS envíos', /1Z000PENDVIEJO0001/.test(tabla) && /1Z000PENDHOY000001/.test(tabla));
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await browser.close();
  matarSrv();
  await esperarSrvMuerto();
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
