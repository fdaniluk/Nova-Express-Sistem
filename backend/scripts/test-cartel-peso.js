#!/usr/bin/env node
/**
 * test-cartel-peso.js — el cartel del cotizador tiene que decir lo mismo que se cobra.
 *
 * El problema que reportó la oficina: una cotización de 22 bultos de 60×35×35 mostraba
 * "330.0 kg vol" en el encabezado pero cobraba sobre 323.4 kg. Los 330 salían de redondear
 * el volumen de CADA bulto a 0.5 (14.7 → 15) y sumar; el precio se calcula sobre la suma
 * cruda y el redondeo va sobre el TOTAL, que es el criterio de Nova.
 *
 * El cálculo estaba bien. El cartel mentía. Esta prueba fija que no se vuelvan a separar.
 *
 *   cd backend && npm run test-cartel-peso
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.log('⚠ playwright no está instalado — se saltea (necesita navegador de verdad).');
  process.exit(0);
}

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
// Arranque común: base de test fresca (copia de producción) y sesión válida.
// Ver scripts/_base-test.js para por qué hace falta.
const { prepararDb, abrirSesion } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3998;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_cartel_peso.db';
const TOKEN = 'token-test-cartel-peso';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Base de test: copia FRESCA de la de producción en cada corrida.
  prepararDb(DB);

  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  // Si el test se corta por un error, el servidor tiene que morir igual: si queda vivo se
  // queda con el puerto y la corrida siguiente le habla al servidor VIEJO, con la base
  // vieja, y falla con 401 sin motivo aparente.
  // Windows: llamar srv.kill() DOS VECES sobre el mismo handle revienta libuv con
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
  // Pasaba porque el cierre explícito mata el server y, acto seguido, process.exit() dispara
  // este mismo handler, que lo vuelve a matar cuando el handle ya se está cerrando. En Linux
  // no se notaba; en Windows cortaba el `npm test` entero a mitad de la cadena, sin que
  // ningún test hubiera fallado. El guard hace que solo la primera llamada tenga efecto.
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);
  // Matar al server NO es instantaneo: kill() manda la senal y el proceso hijo tarda en
  // morir. Si se llama process.exit() antes de que muera, Node se cae en Windows con
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src/win/async.c, line 94
  // porque el handle del hijo se esta cerrando cuando el proceso ya arranco a salir. No
  // falla ningun test: se muere Node y corta la cadena del `npm test` a la mitad. Esta
  // funcion espera al 'exit' del hijo (con tope de 2 s por si quedara colgado) para que el
  // handle este cerrado ANTES de salir.
  const esperarSrvMuerto = () => new Promise((res) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return res();
    srv.once('exit', res);
    setTimeout(res, 2000);
  });

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await esperar(300);
  }

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  await abrirSesion(DB, TOKEN);

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));

  await page.goto(BASE + '/pages/cotizador.html', { waitUntil: 'networkidle' });
  await esperar(800);

  // ── el caso de la oficina: 22 bultos de 60×35×35 ────────────────────────────
  console.log('\n1. El caso que reportó la oficina (22 bultos de 60×35×35)\n');

  // 60×35×35 / 5000 = 14.7 kg por bulto. Crudo: 22 × 14.7 = 323.4.
  // Redondeado por bulto (lo que mostraba antes): 22 × 15 = 330.
  await page.evaluate(() => {
    document.getElementById('pais').value = 'China';
    document.getElementById('tipo').value = 'import';
    document.getElementById('ganancia').value = '0';
    document.getElementById('fuel').value = '35.25';
    document.getElementById('couriers').value = 'dhl';
    // con valor declarado > 0 entra el seguro DHL (mínimo 17.50) y el total queda
    // igual al del screenshot de la oficina.
    document.getElementById('valor').value = '100';
  });
  // un bulto ya existe; se agregan los otros 21
  for (let i = 1; i < 22; i++) await page.click('.btn-add');
  await esperar(400);
  await page.evaluate(() => {
    document.querySelectorAll('.bulto-row').forEach((row) => {
      row.querySelector('.b-peso').value = '6.2';
      row.querySelector('.b-largo').value = '60';
      row.querySelector('.b-ancho').value = '35';
      row.querySelector('.b-alto').value = '35';
      row.querySelector('.b-peso').dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
  await esperar(400);

  const filas = await page.evaluate(() => document.querySelectorAll('.bulto-row').length);
  check('se cargaron los 22 bultos', filas === 22, `${filas}`);

  // el cartel de cada bulto no puede redondear a 15
  const cartel = await page.evaluate(() => {
    const el = document.querySelector('.bulto-info, .bulto-warn');
    return el ? el.textContent : null;
  });
  check('el cartel por bulto dice 14.7 y no 15', /14\.7/.test(cartel || ''), cartel);

  await page.click('.btn-calc');
  await esperar(2500);

  const meta = await page.evaluate(() => {
    const el = document.querySelector('.result-meta');
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  });
  check('la cotización salió', !!meta, 'no se encontró el encabezado');
  console.log(`\n   ${meta}\n`);

  const vol = meta && meta.match(/([\d.]+) kg vol/);
  const fact = meta && meta.match(/([\d.]+) kg facturable/);
  check('el encabezado muestra 323.4 kg de volumen (antes decía 330.0)',
    vol && Math.abs(Number(vol[1]) - 323.4) < 0.05, vol ? vol[1] : 'no se encontró');
  check('el facturable sigue siendo 323.4',
    fact && Math.abs(Number(fact[1]) - 323.4) < 0.05, fact ? fact[1] : 'no se encontró');
  check('volumen y facturable coinciden (no se contradicen más)',
    vol && fact && Math.abs(Number(vol[1]) - Number(fact[1])) < 0.05,
    `${vol && vol[1]} vs ${fact && fact[1]}`);

  // ── el precio NO cambió ─────────────────────────────────────────────────────
  console.log('2. El precio no se movió\n');

  const total = await page.evaluate(() => {
    const el = document.querySelector('.result-total');
    return el ? el.textContent.replace(/[^\d.]/g, '') : null;
  });
  // con ganancia 0 y fuel 35.25 el total es el mismo que reportó la oficina
  check('el total sigue dando 4373.99', total && Math.abs(Number(total) - 4373.99) < 0.02, total);

  console.log('\n3. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|net::ERR/i.test(x));
  check('ningún error en la pantalla', rel.length === 0, rel.slice(0, 2).join(' | '));

  await browser.close();
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  // Ni siquiera acá se llama process.exit(): matar el proceso a mano es lo que venía
  // reventando en Windows. Se deja el código de salida y Node termina solo cuando no le
  // queda nada pendiente, que es cuando ya no hay ningún handle a medio cerrar.
  // El timer es la red de seguridad por si algo quedara vivo (sockets keep-alive de
  // fetch, por ejemplo): va con .unref(), así NO sostiene el proceso —si no hay nada
  // más, Node sale igual al instante— y solo actúa si a los 3 s todavía sigue en pie.
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
