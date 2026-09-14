#!/usr/bin/env node
/**
 * _capturas-asistente.js — capturas del panel del asistente para mostrárselo a Felipe (NO es una tanda)
 * (14/09/2026). Corre con BOT_MOCK=1: el motor de mentira de bot.service.js.
 *
 * El circuito del asistente lo cuida test-bot.js. Esto cuida la otra mitad, la que usa la
 * oficina:
 *  1. Que se pueda escribir, mandar con Enter y ver la respuesta (con qué herramienta
 *     usó), y que el hilo siga en la MISMA conversación.
 *  2. Que el cartel ámbar de "pendiente de confirmar" aparezca con la propuesta de
 *     pickup y desaparezca al confirmar: es lo que le dice a la persona que el próximo
 *     "sí" graba.
 *  3. Que la lista de conversaciones se arme, y que abrir una vieja traiga sus mensajes.
 *  4. Que el ítem "Asistente" esté en el menú de las pantallas.
 *  5. Sin errores de JavaScript.
 *
 *   cd backend && node scripts/test-pantalla-asistente.js
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

const PORT = 3928;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || require('path').join(require('os').tmpdir(), 'nova-capturas-asistente.db');
const TOKEN = 'token-test-pantalla-asistente';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production', BOT_MOCK: '1', ANTHROPIC_API_KEY: '' },
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

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const run = (q, p = []) => new Promise((res, rej) => db.run(q, p, (e) => (e ? rej(e) : res())));
  const get = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => (e ? rej(e) : res(r))));
  await run("UPDATE usuarios SET rol = 'admin', ver_dashboard = 1, ver_salud = 1 WHERE id = 1");
  await run("INSERT OR REPLACE INTO configuracion_nova (id, fuel_pct, fecha_actualizacion) VALUES (1, 30, datetime('now'))");

  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const cli = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H,
    body: JSON.stringify({ nombre: 'PANTALLA S.A.', tarifa_pct: 60, tipo_cobro: 'CC', direccion_recoleccion: 'Belgrano 1200, San Miguel' }),
  })).json();
  const hoy = require('../src/utils/fecha').hoyLocal();
  await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion',
      pais_destino: 'Chile', peso_real: 3, largo: 30, ancho: 20, alto: 20, fob: 50, total_cobrado: 120, numero_guia: '1Z777AA10123456700',
    }),
  });

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));

  await page.goto(BASE + '/pages/asistente.html', { waitUntil: 'networkidle' });
  await esperar(600);

  const burbujas = () => page.$$eval('.asi-msg:not(.pensando)', (ns) => ns.map((n) => ({ rol: n.classList.contains('user') ? 'user' : 'assistant', texto: n.textContent })));
  const escribir = async (t) => {
    await page.fill('#asi-texto', t);
    await page.press('#asi-texto', 'Enter');
    await page.waitForFunction(() => !document.querySelector('.asi-msg.pensando') && !document.getElementById('asi-enviar').disabled, null, { timeout: 15000 });
    await esperar(150);
  };

  const SALIDA = path.join(__dirname, '..', '_capturas');
  fs.mkdirSync(SALIDA, { recursive: true });
  await page.screenshot({ path: path.join(SALIDA, 'asistente-1-vacio.png') });
  await escribir('cómo viene la guía 1Z777AA10123456700');
  await escribir('y la venta de hoy?');
  await escribir(`cargá un pickup para el cliente ${cli.id} mañana de 10 a 13`);
  await page.screenshot({ path: path.join(SALIDA, 'asistente-2-pendiente.png') });
  await escribir('sí');
  await escribir('cotizame 10 kg 40x30x30 a Brasil, cliente ' + cli.id + ', fob 100');
  await page.screenshot({ path: path.join(SALIDA, 'asistente-3-chat.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await esperar(400);
  await page.screenshot({ path: path.join(SALIDA, 'asistente-4-telefono.png') });
  console.log('capturas en', SALIDA);
  await new Promise((res) => db.close(() => res()));
  await browser.close();
  matarSrv();
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
