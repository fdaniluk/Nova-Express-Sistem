#!/usr/bin/env node
/**
 * test-pantalla-liquidacion-solo-cargos.js — liquidación solo de cargos de envíos anteriores
 * (05/10/2026), vista desde la pantalla.
 *
 * El cliente tuvo un envío, se le liquidó, después llegó un extracargo y el cliente no tiene
 * más envíos. Pendientes lo tiene que mostrar igual ("Sin envíos pendientes" + los cargos con
 * guía, fecha del envío y concepto), "Liquidar solo los cargos" abre Crear, Calcular arma la
 * vista previa sin envíos y se confirma.
 *
 *   cd backend && node scripts/test-pantalla-liquidacion-solo-cargos.js
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3964;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_liq_solo_cargos.db';
const TOKEN = 'token-test-liq-solo-cargos';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; });
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const J = (m, u, b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());

  const cli = await J('POST', '/api/clientes', { nombre: 'SOLO CARGOS SA', tarifa_pct: 75, tipo_cobro: 'CC' });
  const env = await J('POST', '/api/envios', {
    cliente_id: cli.id, fecha: '2026-07-10', courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP',
    numero_guia: '1Z000SOLOCARGOS001', pais_destino: 'Reino Unido', peso_real: 5, largo: 30, ancho: 20, alto: 15, fob: 100, total_cobrado: 180,
  });
  const liq0 = await J('POST', '/api/liquidaciones', { cliente_id: cli.id, periodo_desde: '2026-07-01', periodo_hasta: '2026-07-31', envio_ids: [env.id], confirmar: true });
  check('setup: el envío de julio quedó liquidado', liq0.estado === 'confirmada', JSON.stringify(liq0).slice(0, 120));
  const c1 = await J('POST', `/api/salidas/${env.id}/cargos`, { tipo: 'sobrepeso', monto: 12.5, fecha: '2026-08-15' });
  const c2 = await J('POST', `/api/salidas/${env.id}/cargos`, { tipo: 'otro', label: 'Reempaque', monto: 7, fecha: '2026-08-20' });
  check('setup: dos cargos pendientes de ese envío', c1.estado === 'pendiente' && c2.estado === 'pendiente', JSON.stringify([c1, c2]).slice(0, 200));

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text()); });
  page.on('dialog', (d) => d.accept());

  console.log('\n1. Pendientes muestra al cliente aunque no tenga envíos\n');
  await page.goto(`${BASE}/pages/liquidaciones.html`);
  await esperar(2500);
  const grupo = await page.$(`.cliente-grupo:has([data-liq-cliente="${cli.id}"])`);
  check('el grupo está', !!grupo);
  const txt = grupo ? await grupo.textContent() : '';
  check('dice "Sin envíos pendientes" y el chip de 2 cargos por 19,50', /Sin envíos pendientes/.test(txt) && /2 cargos de envíos anteriores/.test(txt) && /19,50/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 300));
  check('lista los cargos con guía, fecha del envío, país, concepto y cuándo se informó',
    /1Z000SOLOCARGOS001/.test(txt) && /10\/07\/2026/.test(txt) && /Reino Unido/.test(txt) && /Sobrepeso/.test(txt) && /informado el 15\/08\/2026/.test(txt) && /Reempaque/.test(txt) && /liq\. #\d+/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 400));
  check('el botón dice "Liquidar solo los cargos"', /Liquidar solo los cargos/.test(txt));

  console.log('\n2. Crear: sin envíos, con los cargos abajo, Calcular arma la vista previa\n');
  await page.click(`[data-liq-cliente="${cli.id}"]`);
  await esperar(1800);
  check('cambió a Crear con el cliente', !!(await page.$('#panel-crear:not(.hidden)')) && (await page.inputValue('#liq-cliente')) === String(cli.id));
  const tabla = await page.textContent('#liq-envios-wrap');
  check('la tabla avisa que no hay envíos y que se puede liquidar solo con los cargos', /Sin envíos en el período/.test(tabla) && /solo con esos cargos/.test(tabla), tabla.replace(/\s+/g, ' ').slice(0, 200));
  check('los cargos se ven debajo', /1Z000SOLOCARGOS001/.test(tabla) && /Sobrepeso/.test(tabla));
  await page.click('#btn-preview');
  await esperar(1800);
  check('la vista previa se abrió', !!(await page.$('#liq-preview:not(.hidden)')));
  const prev = await page.textContent('#liq-preview');
  check('sin ítems: la tabla lo dice', /solo de cargos de envíos anteriores/.test(prev));
  check('sección de cargos con guía, fecha, país y concepto', /1Z000SOLOCARGOS001/.test(prev) && /10\/07\/2026/.test(prev) && /Reino Unido/.test(prev) && /Sobrepeso/.test(prev) && /informado el 15\/08\/2026/.test(prev), prev.replace(/\s+/g, ' ').slice(0, 400));
  check('total liquidación 19,50', /Total liquidación\s*\$?\s*19,50|19,50/.test(prev));
  check('Confirmar quedó habilitado', !(await page.$eval('#btn-confirmar-liq', (b) => b.disabled)));

  console.log('\n3. Confirmar\n');
  await page.click('#btn-confirmar-liq');
  await esperar(2500);
  const liqs = await J('GET', `/api/liquidaciones?cliente_id=${cli.id}`);
  const lista = Array.isArray(liqs) ? liqs : (liqs.items || []);
  const nueva = lista.find((l) => l.id !== liq0.id);
  check('hay una liquidación nueva confirmada por 19,50', nueva && nueva.estado === 'confirmada' && Math.abs(Number(nueva.total) - 19.5) < 0.01, JSON.stringify(lista).slice(0, 300));
  const det = nueva ? await J('GET', `/api/liquidaciones/${nueva.id}`) : null;
  check('sin ítems y con los 2 cargos', det && det.items.length === 0 && det.cargos_anteriores.length === 2, det && JSON.stringify({ i: det.items.length, c: det.cargos_anteriores.length }));
  const pend = await J('GET', `/api/liquidaciones/pendientes?cliente_id=${cli.id}`);
  check('ya no queda nada pendiente', Array.isArray(pend) && pend.length === 0, JSON.stringify(pend).slice(0, 100));
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  await browser.close();
  matarSrv();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 2000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
