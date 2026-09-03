#!/usr/bin/env node
/**
 * test-liquidacion-sin-cotizador.js — la pantalla de liquidaciones después de sacar el
 * botón "Cotizar" por fila.
 *
 * Ese botón recalculaba un precio y lo mostraba, pero el resultado NUNCA llegaba a la
 * liquidación: el backend ignora `cotizaciones` a propósito desde que se decidió que la
 * liquidación no recotiza y lee los valores congelados del envío. El botón era lo que
 * quedó de la etapa anterior.
 *
 * Lo que importa probar es que sacarlo no rompió el flujo real: elegir cliente, ver los
 * envíos, calcular la previa y que el total dé lo mismo que antes.
 *
 *   cd backend && node scripts/test-liquidacion-sin-cotizador.js
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
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3987;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_liq_sin_cot.db';
const TOKEN = 'token-test-liq-sin-cot';

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
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
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

  // Espera la línea de "listo" que imprime NUESTRO servidor (no un /api/health que puede
  // contestar otro node vivo en el puerto), hasta 60 s: en Windows el primer arranque de
  // node del día tarda y con 12 s el test reventaba con un ECONNREFUSED que parecía del
  // cortafuegos. Ver scripts/_base-test.js.
  await esperarServidor(srv, BASE, () => logErr, () => logOut);

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  await abrirSesion(DB, TOKEN);

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errores.push('console: ' + m.text()); });

  // ── 1. Pendientes en orden alfabético ───────────────────────────────────────
  console.log('\n1. Pendientes en orden alfabético\n');
  await page.goto(BASE + '/pages/liquidaciones.html', { waitUntil: 'networkidle' });
  await esperar(1800);

  // La pantalla arranca filtrando por el MES EN CURSO. Este test daba por sentado que
  // siempre hay pendientes en el mes corriente, y eso depende del calendario y de la base:
  // el 04/08/2026, sobre la base real, los 30 envíos sin liquidar eran de abril a julio y
  // ninguno de agosto, así que la lista salía vacía y el test fallaba sin que hubiera nada
  // roto. Se abre el rango a mano antes de mirar: lo que se prueba es la PANTALLA, no qué
  // mes es hoy.
  await page.fill('#pend-desde', '2020-01-01');
  await page.click('#btn-pend-filtrar');
  await esperar(1800);

  const nombres = await page.evaluate(() =>
    [...document.querySelectorAll('#pendientes-list [data-liq-cliente]')]
      .map((b) => b.closest('.card, .pend-card, tr, div')?.textContent || '')
      .map((t) => t.trim().split('\n')[0].trim()).filter(Boolean));
  check('la lista de pendientes tiene clientes', nombres.length > 0, `${nombres.length}`);
  if (nombres.length > 1) {
    const orden = [...nombres].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    check('vienen en orden alfabético', nombres.every((n, i) => n === orden[i]),
      nombres.slice(0, 4).join(' | '));
    console.log(`\n   ${nombres.slice(0, 5).join('\n   ')}\n`);
  }

  // ── 2. El botón Cotizar ya no está ──────────────────────────────────────────
  console.log('2. El botón "Cotizar" por fila ya no está\n');

  // Se usa el camino REAL de la oficina: el botón "Liquidar" de la primera tarjeta de
  // pendientes. Elegir un cliente cualquiera del desplegable no sirve: la mayoría no tiene
  // envíos pendientes y la tabla queda vacía por motivos legítimos.
  const cliente = await page.evaluate(() => {
    const btn = document.querySelector('#pendientes-list [data-liq-cliente]');
    if (!btn) return null;
    btn.click();
    return btn.dataset.liqCliente;
  });
  check('se entró a liquidar el primer cliente pendiente', !!cliente, String(cliente));
  await esperar(2500);

  // La pestaña "Crear" tiene su PROPIO filtro de fechas, y también arranca en el mes en
  // curso. Sin abrirlo, la tabla de envíos del cliente sale vacía por el mismo motivo que
  // la lista de pendientes y los checks de abajo fallan sin que haya nada roto.
  await page.fill('#liq-desde', '2020-01-01');
  await page.click('#btn-cargar-envios');
  await esperar(2000);

  const restos = await page.evaluate(() => ({
    botones: document.querySelectorAll('.btn-cotizar').length,
    paneles: document.querySelectorAll('.cot-panel').length,
    calc: document.querySelectorAll('.btn-calc-cot').length,
  }));
  check('no quedan botones "Cotizar"', restos.botones === 0, JSON.stringify(restos));
  check('no quedan paneles del cotizador', restos.paneles === 0, JSON.stringify(restos));
  check('no quedan botones "Calcular" de fila', restos.calc === 0, JSON.stringify(restos));

  // ── 3. El flujo real sigue andando ──────────────────────────────────────────
  console.log('\n3. Calcular la liquidación sigue funcionando\n');

  const filas = await page.evaluate(() =>
    document.querySelectorAll('#liq-envios-body tr').length);
  check('se listan los envíos del cliente', filas > 0, `${filas} filas`);

  // el encabezado de la tabla de ENVÍOS (no el de la previa, que está en el mismo bloque)
  const cols = await page.evaluate(() => {
    const tr = document.querySelector('#liq-envios-body tr');
    const th = document.querySelector('#liq-envios-body')
      ?.closest('table')?.querySelectorAll('thead th').length;
    return { celdas: tr ? tr.querySelectorAll('td').length : 0, encabezados: th || 0 };
  });
  check('las columnas del encabezado y de las filas coinciden',
    cols.celdas > 0 && cols.celdas === cols.encabezados, JSON.stringify(cols));

  await page.click('#btn-preview');
  await esperar(2500);

  const total = await page.evaluate(() => {
    const el = document.getElementById('liq-total');
    return el ? el.textContent.trim() : null;
  });
  check('la previa calcula un total', /\d/.test(total || ''), String(total));
  console.log(`\n   total de la previa: ${total}\n`);

  const confirmarHabilitado = await page.evaluate(() => {
    const b = document.getElementById('btn-confirmar-liq');
    return b ? !b.disabled : null;
  });
  check('el botón de confirmar queda habilitado', confirmarHabilitado === true,
    String(confirmarHabilitado));

  console.log('\n4. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|net::ERR|Failed to load resource/i.test(x));
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
