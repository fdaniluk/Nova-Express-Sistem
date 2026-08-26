#!/usr/bin/env node
/**
 * test-pantalla-cotizaciones-recientes.js — el panel del cliente, en un navegador de verdad.
 *
 * El endpoint lo cubre test-cotizaciones-recientes.js. Esto controla lo otro, que es lo
 * que pidió Felipe con estas palabras:
 *
 *   · que la tilde viva EN CADA TARJETA y arranque apagada — se cotizan tres servicios y
 *     al cliente se le manda uno solo: *"si yo lo pongo en el general, me va a guardar
 *     tres cotizaciones innecesariamente"*,
 *   · que en CARGAR ENVÍO el panel aparezca al elegir el cliente y el precio se escriba
 *     como SUGERIDO — *"se debería de poder modificar sin problemas"*,
 *   · que en SALIDAS **no moleste**: *"que solo aparezca en el caso que estén editando el
 *     precio de venta, parándose en ese cuadrante desde el detalle"*.
 *
 *   cd backend && node scripts/test-pantalla-cotizaciones-recientes.js
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
const sqlite3 = require('sqlite3');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3954;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_ctz_recientes.db';
const TOKEN = 'token-test-pantalla-ctzr';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); }
  else { fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera A QUE PASE la cosa, no a que pase el reloj. */
async function esperarQue(fn, ms = 8000) {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn().catch(() => false)) return true;
    // eslint-disable-next-line no-await-in-loop
    await esperar(200);
  }
  return false;
}

function sql(query, params = []) {
  return new Promise((res, rej) => {
    const d = new sqlite3.Database(DB);
    d.all(query, params, (e, r) => { d.close(() => (e ? rej(e) : res(r || []))); });
  });
}

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = ''; let logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch { /* ya estaba */ } };
  process.on('exit', matarSrv);

  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  // El cotizador se niega a cotizar sin fuel cargado, y con razón: sin fuel el precio
  // sale por debajo del costo.
  await sql('INSERT INTO configuracion_nova (id, fuel_pct) VALUES (1, 36) '
    + 'ON CONFLICT(id) DO UPDATE SET fuel_pct = 36');

  const cli = await (await fetch(`${BASE}/api/clientes`, {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'CTZR PANTALLA', tarifa_pct: 80 }),
  })).json();

  const nuevaCtz = (total) => fetch(`${BASE}/api/cotizaciones`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, pais: 'Estados Unidos', tipo_envio: 'exportacion',
      zona: '2', peso_facturable: 8, cantidad_bultos: 1, valor_declarado: 1000,
      viaja_al_cliente: 1,
      entrada: { bultos: [{ pr: 4, l: 40, a: 30, al: 32, pv: 7.7, pf: 8 }], ganancia_pct: 137 },
      opciones: [{ servicio: 'UPS Worldwide Expedited', total, pf: 8, zona: 2, costo: 83.11 }],
    }),
  }).then((r) => r.json());

  const ctz = await nuevaCtz(198.44);

  const envio = await (await fetch(`${BASE}/api/envios`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: new Date().toISOString().slice(0, 10),
      courier: 'DHL', tipo_envio: 'exportacion', numero_guia: '9920000015',
      pais_destino: 'Estados Unidos', peso_real: 4, largo: 40, ancho: 30, alto: 32,
      total_cobrado: 100,
    }),
  })).json();

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) {
      errores.push(m.text());
    }
  });
  const visible = (sel) => page.$eval(sel, (e) => {
    const s = getComputedStyle(e);
    return s.display !== 'none' && s.visibility !== 'hidden' && !e.classList.contains('hidden');
  }).catch(() => false);

  // ── 1. La tilde del cotizador ───────────────────────────────────────────────────────
  console.log('\n1. La tilde vive en cada tarjeta y arranca apagada\n');

  await page.goto(`${BASE}/pages/cotizador.html`);
  await esperar(2500);

  await page.selectOption('#pais', 'Estados Unidos');
  await page.selectOption('#couriers', 'ambos');   // los tres servicios, que es el caso real
  await page.fill('#ganancia', '60');
  await page.fill('.bulto-row .b-peso', '4');
  await page.fill('.bulto-row .b-largo', '40');
  await page.fill('.bulto-row .b-ancho', '30');
  await page.fill('.bulto-row .b-alto', '32');
  await page.click('.btn-calc');
  await page.waitForSelector('.result-card', { timeout: 8000 });
  await esperar(800);

  const tildes = await page.$$('.chk-viaja');
  const tarjetas = await page.$$('.result-card');
  check('hay una tilde "Guardar" por tarjeta y no una sola general',
    tildes.length === tarjetas.length && tildes.length > 1,
    `${tildes.length} tildes · ${tarjetas.length} tarjetas`);
  check('no quedó la tilde general vieja', !(await page.$('#ctz-viaja')));
  const algunaPrendida = await page.$$eval('.chk-viaja', (e) => e.some((x) => x.checked));
  check('todas arrancan APAGADAS', !algunaPrendida);

  await page.check('.chk-viaja');
  await page.click('.btn-calc');
  await esperar(1500);
  check('al volver a cotizar arrancan apagadas de nuevo (si no, "solo lo marcado" sería "todo")',
    !(await page.$$eval('.chk-viaja', (e) => e.some((x) => x.checked))));

  // ── 2. Cargar envío: el panel y el precio sugerido ──────────────────────────────────
  console.log('\n2. Cargar envío: el panel aparece con el cliente y el precio es un sugerido\n');

  await page.goto(`${BASE}/pages/envios.html`);
  await esperar(2500);
  /* El select de cliente NO tiene opción vacía: siempre hay uno elegido, así que el panel
     arranca trabajando con ese. Lo que no puede pasar es que se quede colgado en
     "Buscando…" o en blanco. */
  const alAbrir = await page.textContent('#ctzr-panel');
  check('al abrir la pantalla el panel ya trabaja con el cliente elegido',
    alAbrir.trim().length > 0 && !/Buscando/.test(alAbrir), alAbrir.trim().slice(0, 70));

  await page.selectOption('#cliente_id', String(cli.id));
  const aparecio = await esperarQue(async () => (await page.$$('#ctzr-panel .ctzr-fila')).length > 0);
  check('al elegir el cliente aparecen sus cotizaciones', aparecio,
    (await page.textContent('#ctzr-panel')).trim().slice(0, 80));

  const texto = await page.textContent('#ctzr-panel');
  check('la fila dice el número de cotización', new RegExp(`CTZ-${ctz.numero}`).test(texto), texto.slice(0, 120));
  check('y los datos para reconocer el envío (destino y medidas)',
    /Estados Unidos/.test(texto) && /40×30×32/.test(texto), texto.slice(0, 160));
  check('🔴 el panel NO muestra nuestro costo', !/83[.,]11/.test(texto));

  await page.click('#ctzr-panel .ctzr-precio');
  await esperar(400);
  check('apretar el precio lo escribe en Total cobrado',
    (await page.inputValue('#total_cobrado')) === '198.44',
    await page.inputValue('#total_cobrado'));
  check('y avisa que es un sugerido', await visible('#ctzr-sugerido'));

  await page.fill('#total_cobrado', '250');
  check('el precio se puede pisar a mano sin que nada se queje',
    (await page.inputValue('#total_cobrado')) === '250');

  // ── 3. Salidas: que no moleste ──────────────────────────────────────────────────────
  console.log('\n3. Salidas: el panel aparece solo al pararse en el precio de venta\n');

  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  await page.click('text=9920000015');
  await esperar(1000);
  check('se abre el modal del envío', !!(await page.$('#sal-edit-overlay:not(.hidden)')));
  check('🔴 el panel NO se ve al abrir el envío', !(await visible('#saled-ctzr')));

  await page.focus('#saled-total');
  const abrio = await esperarQue(async () => visible('#saled-ctzr'));
  check('al pararse en Total cobrado se abre', abrio);
  const llego = await esperarQue(async () => (await page.$$('#saled-ctzr .ctzr-fila')).length > 0);
  check('y trae las cotizaciones de ese cliente', llego,
    (await page.textContent('#saled-ctzr')).trim().slice(0, 80));

  const profitAntes = await page.inputValue('#saled-profit');
  await page.click('#saled-ctzr .ctzr-precio');
  await esperar(500);
  check('elegir una escribe el precio', (await page.inputValue('#saled-total')) === '198.44',
    await page.inputValue('#saled-total'));
  check('y el profit se re-deriva solo, como con cualquier edición a mano',
    (await page.inputValue('#saled-profit')) !== profitAntes,
    `antes ${profitAntes} · ahora ${await page.inputValue('#saled-profit')}`);

  // Abrir otro envío no puede arrastrar lo del anterior.
  await page.click('#sal-modal-cancel');
  await esperar(500);
  await page.click('text=9920000015');
  await esperar(900);
  check('al reabrir, el panel vuelve a estar cerrado', !(await visible('#saled-ctzr')));

  console.log('\n4. Sin errores de JavaScript\n');
  check('ningún error en las tres pantallas', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  await browser.close();
  matarSrv();
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
