#!/usr/bin/env node
/**
 * test-bultos-duplicar.js — copiar una caja igual, para envíos de muchos bultos iguales
 * (21/08/2026).
 *
 * POR QUÉ EXISTE
 * La oficina cotiza envíos de 20 cajas idénticas. Antes había que apretar "Agregar bulto"
 * 20 veces y escribir las mismas cuatro medidas 20 veces: además de lento, cada tipeo es
 * una chance de equivocarse en UNA caja y que el peso facturable salga mal sin que nadie
 * lo note.
 *
 * Ahora hay dos botones: el ⧉ de cada fila (una caja igual a esa, justo abajo) y
 * "Duplicar el último" con un campo de cantidad (N cajas iguales de un saque).
 *
 * QUÉ SE PRUEBA, en orden de riesgo:
 *
 *  1. QUE LA COPIA SEA EXACTA. Si duplicar cambiara aunque sea un milímetro, la oficina
 *     estaría cotizando otra cosa distinta de la que ve. Se compara medida por medida.
 *  2. Que el precio de 20 cajas duplicadas sea IDÉNTICO al de 20 cajas tipeadas a mano.
 *     Es el control que de verdad importa: el botón es comodidad, no puede mover plata.
 *  3. Que el ⧉ de una fila del medio inserte la copia ahí y no al final, y que la
 *     numeración quede corrida.
 *  4. Que no se pueda duplicar una fila vacía (no tendría sentido y confunde).
 *  5. Que el tope de 50 copias por click aguante y que la pantalla no tire errores.
 *
 *   cd backend && npm run test-bultos-duplicar
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

const PORT = process.env.PORT_TEST || 3970;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_bultos_duplicar.db';
const TOKEN = 'token-test-bultos-duplicar';

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

  const MED = { pr: '6.2', l: '60', a: '35', al: '35' };
  const leerFilas = () => page.evaluate(() => [...document.querySelectorAll('.bulto-row')].map((r) => ({
    num: r.querySelector('.bulto-num').textContent,
    pr: r.querySelector('.b-peso').value,
    l: r.querySelector('.b-largo').value,
    a: r.querySelector('.b-ancho').value,
    al: r.querySelector('.b-alto').value,
  })));
  const escribirPrimera = (m) => page.evaluate((mm) => {
    const r = document.querySelector('.bulto-row');
    r.querySelector('.b-peso').value = mm.pr;
    r.querySelector('.b-largo').value = mm.l;
    r.querySelector('.b-ancho').value = mm.a;
    r.querySelector('.b-alto').value = mm.al;
    r.querySelector('.b-peso').dispatchEvent(new Event('input', { bubbles: true }));
  }, m);

  // ── 1. la copia tiene que ser exacta ───────────────────────────────────────
  console.log('\n1. Duplicar copia las medidas tal cual\n');

  await escribirPrimera(MED);
  await esperar(200);
  await page.fill('#dup-cant', '19');
  await page.click('.btn-dup-n');
  await esperar(600);

  let filas = await leerFilas();
  check('de 1 caja y "duplicar ×19" salen 20 bultos', filas.length === 20, `${filas.length}`);
  const igualitas = filas.every((f) => f.pr === MED.pr && f.l === MED.l && f.a === MED.a && f.al === MED.al);
  check('las 20 tienen exactamente las mismas medidas', igualitas,
    JSON.stringify(filas.find((f) => f.l !== MED.l) || {}));
  check('y están numeradas #1 … #20',
    filas.map((f) => f.num).join(',') === Array.from({ length: 20 }, (_, i) => `#${i + 1}`).join(','),
    filas.map((f) => f.num).join(','));

  // ── 2. el botón no puede mover plata ───────────────────────────────────────
  console.log('\n2. Duplicar da el MISMO precio que tipear las 20 a mano\n');

  await page.evaluate(() => {
    document.getElementById('pais').value = 'China';
    document.getElementById('tipo').value = 'import';
    document.getElementById('ganancia').value = '0';
    document.getElementById('fuel_fuente').value = 'manual';
    document.getElementById('fuel').value = '35.25';
    document.getElementById('couriers').value = 'dhl';
    document.getElementById('valor').value = '100';
  });
  await page.click('.btn-calc');
  await esperar(2500);
  const totalDuplicado = await page.evaluate(() => {
    const el = document.querySelector('.result-total');
    return el ? el.textContent.trim() : null;
  });
  const metaDuplicado = await page.evaluate(() => {
    const el = document.querySelector('.result-meta');
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  });
  check('la cotización de las 20 duplicadas salió', !!totalDuplicado, 'no salió el total');
  console.log(`\n   ${metaDuplicado}\n`);

  // ahora las mismas 20, pero cargadas de la forma vieja: 20 clicks en "Agregar bulto"
  await page.reload({ waitUntil: 'networkidle' });
  await esperar(800);
  for (let i = 1; i < 20; i++) await page.click('.btn-add');
  await esperar(500);
  await page.evaluate((mm) => {
    document.querySelectorAll('.bulto-row').forEach((row) => {
      row.querySelector('.b-peso').value = mm.pr;
      row.querySelector('.b-largo').value = mm.l;
      row.querySelector('.b-ancho').value = mm.a;
      row.querySelector('.b-alto').value = mm.al;
      row.querySelector('.b-peso').dispatchEvent(new Event('input', { bubbles: true }));
    });
    document.getElementById('pais').value = 'China';
    document.getElementById('tipo').value = 'import';
    document.getElementById('ganancia').value = '0';
    document.getElementById('fuel_fuente').value = 'manual';
    document.getElementById('fuel').value = '35.25';
    document.getElementById('couriers').value = 'dhl';
    document.getElementById('valor').value = '100';
  }, MED);
  await esperar(400);
  await page.click('.btn-calc');
  await esperar(2500);
  const totalAMano = await page.evaluate(() => {
    const el = document.querySelector('.result-total');
    return el ? el.textContent.trim() : null;
  });
  const metaAMano = await page.evaluate(() => {
    const el = document.querySelector('.result-meta');
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  });
  check('duplicando o tipeando a mano, el TOTAL es el mismo',
    totalDuplicado && totalDuplicado === totalAMano, `${totalDuplicado} vs ${totalAMano}`);
  check('y el peso facturable también', metaDuplicado === metaAMano,
    `${metaDuplicado} vs ${metaAMano}`);

  // ── 3. el ⧉ de una fila del medio inserta ahí ──────────────────────────────
  console.log('\n3. El ⧉ de cada fila inserta la copia justo abajo\n');

  await page.reload({ waitUntil: 'networkidle' });
  await esperar(800);
  await escribirPrimera({ pr: '1', l: '10', a: '10', al: '10' });
  await page.click('.btn-add');
  await esperar(300);
  await page.evaluate(() => {
    const r = document.querySelectorAll('.bulto-row')[1];
    r.querySelector('.b-peso').value = '2';
    r.querySelector('.b-largo').value = '20';
    r.querySelector('.b-ancho').value = '20';
    r.querySelector('.b-alto').value = '20';
    r.querySelector('.b-peso').dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('.btn-add');
  await esperar(300);
  await page.evaluate(() => {
    const r = document.querySelectorAll('.bulto-row')[2];
    r.querySelector('.b-peso').value = '3';
    r.querySelector('.b-largo').value = '30';
    r.querySelector('.b-ancho').value = '30';
    r.querySelector('.b-alto').value = '30';
    r.querySelector('.b-peso').dispatchEvent(new Event('input', { bubbles: true }));
  });
  await esperar(300);
  // duplicar la del MEDIO (la de 20 cm)
  await page.evaluate(() => document.querySelectorAll('.bulto-row')[1].querySelector('.btn-dup').click());
  await esperar(400);
  filas = await leerFilas();
  check('la copia queda en el lugar 3, no al final',
    filas.length === 4 && filas[2].l === '20' && filas[3].l === '30',
    filas.map((f) => f.l).join(','));
  check('la numeración se corre: #1 #2 #3 #4',
    filas.map((f) => f.num).join(',') === '#1,#2,#3,#4', filas.map((f) => f.num).join(','));

  // ── 4. una fila vacía no se duplica ────────────────────────────────────────
  console.log('\n4. Una fila vacía no se duplica\n');

  await page.reload({ waitUntil: 'networkidle' });
  await esperar(800);
  await page.evaluate(() => document.querySelector('.btn-dup').click());
  await esperar(300);
  filas = await leerFilas();
  check('el ⧉ sobre una fila vacía no agrega nada', filas.length === 1, `${filas.length}`);
  // el de abajo, en cambio, agrega una vacía: es lo mismo que "Agregar bulto"
  await page.fill('#dup-cant', '5');
  await page.click('.btn-dup-n');
  await esperar(300);
  filas = await leerFilas();
  check('"Duplicar el último" con todo vacío agrega UNA sola, no 5', filas.length === 2, `${filas.length}`);

  // ── 5. el tope ─────────────────────────────────────────────────────────────
  console.log('\n5. El tope de 50 copias por click\n');

  await page.reload({ waitUntil: 'networkidle' });
  await esperar(800);
  await escribirPrimera(MED);
  await esperar(200);
  await page.evaluate(() => { document.getElementById('dup-cant').value = '999'; });
  await page.click('.btn-dup-n');
  await esperar(1500);
  filas = await leerFilas();
  check('pidiendo 999 copias agrega 50 (1 + 50 = 51)', filas.length === 51, `${filas.length}`);
  check('y las 51 siguen teniendo las mismas medidas',
    filas.every((f) => f.l === MED.l && f.a === MED.a && f.al === MED.al && f.pr === MED.pr));

  console.log('\n6. Sin errores de JavaScript\n');
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
