#!/usr/bin/env node
/**
 * test-pantalla-asistente.js — el panel de chat del asistente, en un navegador de verdad
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

const PORT = process.env.PORT_TEST || 3929;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_asistente.db';
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

  // ── 1 ────────────────────────────────────────────────────────────────────────
  console.log('\n1. Escribir, mandar con Enter, leer la respuesta\n');
  check('el estado de arriba dice que está en modo de prueba', /mock|prueba/i.test(await page.$eval('#asi-estado', (e) => e.textContent)));
  check('arranca con la bienvenida y sin cartel de aviso', !(await page.$eval('#asi-bienvenida', (e) => e.hidden)) && (await page.$eval('#asi-aviso', (e) => e.hidden)));
  await escribir('cómo viene la guía 1Z777AA10123456700');
  let b = await burbujas();
  check('mi mensaje queda a la derecha y la respuesta a la izquierda', b.length === 2 && b[0].rol === 'user' && b[1].rol === 'assistant', JSON.stringify(b));
  check('   la respuesta trae la guía y el cliente', /1Z777AA10123456700/.test(b[1].texto) && /PANTALLA/.test(b[1].texto), b[1].texto);
  check('   y dice qué herramienta usó', /usó: buscar_envios/.test(b[1].texto), b[1].texto);
  check('la bienvenida se escondió', await page.$eval('#asi-bienvenida', (e) => e.hidden));
  check('el cuadro de texto quedó vacío y con foco', (await page.$eval('#asi-texto', (e) => e.value)) === '' && (await page.evaluate(() => document.activeElement && document.activeElement.id === 'asi-texto')));
  await escribir('y la venta de hoy?');
  b = await burbujas();
  check('el segundo mensaje sigue en el mismo hilo (4 burbujas)', b.length === 4 && /venta/i.test(b[3].texto), JSON.stringify(b.map((x) => x.texto)));
  const convs = await get('SELECT COUNT(*) n FROM bot_conversaciones');
  check('   y en la base hay UNA sola conversación', convs.n === 1, String(convs.n));

  // ── 2 ────────────────────────────────────────────────────────────────────────
  console.log('\n2. El cartel de "pendiente de confirmar"\n');
  check('sin propuesta, no hay cartel', await page.$eval('#asi-pendiente', (e) => e.hidden));
  await escribir(`cargá un pickup para el cliente ${cli.id} mañana de 10 a 13`);
  check('con la propuesta aparece el cartel ámbar con los datos',
    !(await page.$eval('#asi-pendiente', (e) => e.hidden)) && /PANTALLA/.test(await page.$eval('#asi-pendiente', (e) => e.textContent)) && /10:00/.test(await page.$eval('#asi-pendiente', (e) => e.textContent)),
    await page.$eval('#asi-pendiente', (e) => e.textContent));
  check('   y todavía no hay pickups', (await get('SELECT COUNT(*) n FROM pickups')).n === 0);
  await escribir('sí');
  check('después del "sí" el cartel se va', await page.$eval('#asi-pendiente', (e) => e.hidden));
  check('   y el pickup quedó cargado', (await get('SELECT COUNT(*) n FROM pickups')).n === 1);
  b = await burbujas();
  check('   la respuesta dice que se cargó', /cargado/i.test(b[b.length - 1].texto), b[b.length - 1].texto);

  // ── 3 ────────────────────────────────────────────────────────────────────────
  console.log('\n3. La lista de conversaciones\n');
  const items = await page.$$('#asi-conversaciones li:not(.vacio)');
  check('la lista tiene la conversación, marcada como activa', items.length === 1 && (await items[0].evaluate((e) => e.classList.contains('activa'))));
  check('   con el primer mensaje como título', /guía 1Z777AA10123456700/.test(await items[0].evaluate((e) => e.textContent)), await items[0].evaluate((e) => e.textContent));
  await page.click('#asi-nueva');
  await esperar(200);
  check('"+ Nueva conversación" limpia el chat y vuelve la bienvenida', (await burbujas()).length === 0 && !(await page.$eval('#asi-bienvenida', (e) => e.hidden)));
  await page.click('.asi-sugerencias button[data-sug^="¿Qué pendientes"]');
  await page.waitForFunction(() => !document.querySelector('.asi-msg.pensando') && document.querySelectorAll('.asi-msg').length >= 2, null, { timeout: 15000 });
  await esperar(150);
  b = await burbujas();
  check('una sugerencia se manda sola y abre otra conversación', b.length === 2 && /pendientes/i.test(b[1].texto), JSON.stringify(b));
  check('   ahora la lista tiene dos', (await page.$$('#asi-conversaciones li:not(.vacio)')).length === 2);
  const lis = await page.$$('#asi-conversaciones li:not(.vacio)');
  let liVieja = null;
  for (const li of lis) if (/1Z777AA10123456700/.test(await li.evaluate((e) => e.textContent))) liVieja = li;
  await liVieja.click();
  await page.waitForFunction(() => document.querySelectorAll('.asi-msg').length >= 8, null, { timeout: 5000 }).catch(() => {});
  b = await burbujas();
  check('abrir la vieja trae sus mensajes (los 8 del hilo del pickup)', b.length === 8 && /1Z777AA10123456700/.test(b[0].texto) && /cargado/i.test(b[7].texto), JSON.stringify(b.map((x) => x.texto.slice(0, 40))));
  check('   sin cartel pendiente (ya se confirmó)', await page.$eval('#asi-pendiente', (e) => e.hidden));

  // ── 4 ────────────────────────────────────────────────────────────────────────
  console.log('\n4. El menú\n');
  check('la pantalla tiene "Asistente" activo en el menú', await page.$eval('.sidebar-nav a[href$="asistente.html"]', (a) => a.classList.contains('active')));
  await page.goto(BASE + '/pages/cotizador.html', { waitUntil: 'networkidle' });
  check('el cotizador también lo tiene en el menú', (await page.$$('.sidebar-nav a[href$="asistente.html"]')).length === 1);
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  check('   y el dashboard', (await page.$$('.sidebar-nav a[href$="asistente.html"]')).length === 1);

  // ── 5 ────────────────────────────────────────────────────────────────────────
  console.log('\n5. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|Failed to load resource/i.test(x));
  check('ningún error en las pantallas', rel.length === 0, rel.slice(0, 2).join(' | '));

  await new Promise((res) => db.close(() => res()));
  await browser.close();
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
