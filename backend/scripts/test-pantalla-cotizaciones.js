#!/usr/bin/env node
/**
 * test-pantalla-cotizaciones.js — el guardado directo del cotizador y la lista del
 * perfil del cliente, en un navegador de verdad (24/08/2026, rehecho el 26/08).
 *
 * El backend ya tiene su prueba (`test-cotizaciones.js`). Esto cuida la otra mitad: que
 * la oficina pueda hacerlo desde las pantallas que usa, y sobre todo que lo que se
 * guarda sea LO MISMO que se le mostró al cliente.
 *
 * POR QUÉ SE REHÍZO EL 26/08
 * Guardar eran dos pasos: marcar la opción y apretar un botón aparte de "Guardar
 * cotización". Felipe probó el circuito y cayó justo en la trampa — marcó, el paso dos
 * no ocurrió y el panel de Cargar envío quedó vacío "sin motivo". Ahora el botón
 * "Guardar este precio" de cada opción ES el guardado, y la lista (con su botón Aceptar)
 * se mudó del cotizador al perfil del cliente, que era donde molestaba menos y donde
 * Felipe creía que ya estaba.
 *
 * QUÉ SE PRUEBA, en orden de riesgo:
 *
 *  1. QUE UN SOLO CLICK GUARDE. Es el arreglo de la trampa: si esto se rompe, la
 *     oficina marca opciones que nunca llegan a la base y el panel queda vacío.
 *  2. QUE LOS TOTALES GUARDADOS SEAN LOS DE LAS TARJETAS. Si la pantalla mostrara un
 *     número y guardara otro, el precio acordado sería prueba de algo que nunca se
 *     cotizó — justamente el problema que el módulo viene a resolver.
 *  3. Que marcar OTRA opción edite las marcas de la MISMA cotización (no una CTZ nueva
 *     por cada dedo), y que recotizar sí abra una nueva.
 *  4. Que el cotizador ya no tenga ni el botón verde ni la lista (pedido del 26/08).
 *  5. Que la lista viva en el PERFIL del cliente, con el botón Aceptar por opción, el
 *     desglose que se le envió, y el precio acordado saliendo de la opción aceptada.
 *
 *   cd backend && node scripts/test-pantalla-cotizaciones.js
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

const PORT = process.env.PORT_TEST || 3961;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_cotizaciones.db';
const TOKEN = 'token-test-pantalla-cotizaciones';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const sql = (q, p = []) => new Promise((res, rej) => db.all(q, p, (e, r) => (e ? rej(e) : res(r))));
  // El cotizador se niega a cotizar sin fuel cargado, y con razón.
  await sql("INSERT INTO configuracion_nova (id, fuel_pct) VALUES (1, 36) "
    + "ON CONFLICT(id) DO UPDATE SET fuel_pct = 36");

  const cli = await (await fetch(`${BASE}/api/clientes`, {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'PANTALLA CTZ', tarifa_pct: 80 }),
  })).json();

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));

  await page.goto(BASE + '/pages/cotizador.html', { waitUntil: 'networkidle' });
  await esperar(900);

  console.log('\n1. El cotizador quedó limpio: sin botón verde y sin lista\n');

  check('no existe más el botón general de "Guardar cotización"', !(await page.$('.btn-guardar-ctz')));
  check('ni la barra verde', !(await page.$('#barra-guardar')));
  check('ni la lista de cotizaciones guardadas al pie', !(await page.$('#ctz-lista')));

  console.log('\n2. Un solo click guarda\n');

  // El caso Asaplast tal cual: una caja de 4 kg reales que da 14 de volumen.
  await page.selectOption('#pais', 'Brasil');
  await page.selectOption('#couriers', 'ambos');
  await page.selectOption('#cliente', String(cli.id));
  await page.fill('#valor', '500');
  await page.fill('.bulto-row .b-peso', '4');
  await page.fill('.bulto-row .b-largo', '40');
  await page.fill('.bulto-row .b-ancho', '35');
  await page.fill('.bulto-row .b-alto', '50');
  await page.click('.btn-calc');
  await page.waitForSelector('.result-card', { timeout: 8000 });
  await esperar(600);

  const enPantalla = await page.evaluate(() =>
    [...document.querySelectorAll('.result-card')].map((c) => ({
      courier: c.querySelector('.result-courier').childNodes[0].textContent.trim(),
      total: c.querySelector('.result-total').textContent.trim(),
    })));
  check('hay tarjetas para cotizar', enPantalla.length >= 2, `${enPantalla.length}`);

  await page.click('.btn-viaja');   // el primero (DHL)
  const guardo = await esperarQue(async () =>
    /CTZ-\d+/.test(await page.textContent('.bv-estado')));
  check('🔴 apretar "Guardar este precio" GUARDA — sin ningún segundo paso', guardo,
    await page.textContent('.bv-estado'));

  let filas = await sql('SELECT id, numero, opciones, viaja_al_cliente FROM cotizaciones');
  check('la cotización quedó en la base', filas.length === 1, `hay ${filas.length}`);
  const guardada = filas[0];
  const ops = JSON.parse(guardada.opciones);
  check('con una opción por cada tarjeta (entera: es el respaldo)',
    ops.length === enPantalla.length, `${ops.length} vs ${enPantalla.length}`);
  check('y solo la marcada viaja', ops.filter((o) => o.viaja).length === 1
    && Boolean(ops[0].viaja), JSON.stringify(ops.map((o) => [o.servicio, o.viaja])));

  /* ⚠️ EL CONTROL QUE IMPORTA: lo guardado = lo que dice la tarjeta, pasado por los
     MISMOS ayudantes que dibujan la pantalla. Los nombres difieren a propósito (la
     tarjeta abrevia); los NÚMEROS no pueden separarse. */
  const comoSeVerian = await page.evaluate((opciones) =>
    opciones.map((o) => ({ courier: nombreCorto(o.servicio), total: fmt(o.total) })), ops);
  const desalineadas = enPantalla.filter((t) =>
    !comoSeVerian.some((g) => g.courier === t.courier && g.total === t.total));
  check('🔴 cada total guardado es EL MISMO que muestra su tarjeta', desalineadas.length === 0,
    `pantalla ${JSON.stringify(enPantalla)} · guardadas ${JSON.stringify(comoSeVerian)}`);
  check('se congeló el fuel que se usó', ops.every((o) => Number.isFinite(Number(o.fuel_pct))));

  // Y el panel de Cargar envío lo VE: el circuito completo que probó Felipe.
  const rec = await (await fetch(`${BASE}/api/cotizaciones/cliente/${cli.id}/recientes`, { headers: H })).json();
  check('🔴 el circuito cierra: la cotización aparece en el panel del cliente',
    rec.length === 1 && rec[0].opciones_resumen.length === 1,
    JSON.stringify(rec.map((x) => x.opciones_resumen)));

  console.log('\n3. Marcar otra opción edita la MISMA cotización\n');

  const botones = await page.$$('.btn-viaja');
  await botones[1].click();
  await esperar(1200);
  filas = await sql('SELECT id, numero, opciones FROM cotizaciones');
  check('sigue habiendo UNA cotización (no una por cada dedo)', filas.length === 1, `hay ${filas.length}`);
  check('con las dos opciones marcadas',
    JSON.parse(filas[0].opciones).filter((o) => o.viaja).length === 2);

  await botones[1].click();   // desmarcar
  await esperar(1200);
  check('desmarcar también edita la misma',
    JSON.parse((await sql('SELECT opciones FROM cotizaciones'))[0].opciones)
      .filter((o) => o.viaja).length === 1);

  await page.click('.btn-calc');
  await page.waitForSelector('.result-card');
  await esperar(600);
  await page.click('.btn-viaja');
  await esperarQue(async () => (await sql('SELECT COUNT(*) n FROM cotizaciones'))[0].n === 2);
  check('recotizar corta: la próxima marca abre una CTZ nueva',
    (await sql('SELECT COUNT(*) n FROM cotizaciones'))[0].n === 2);

  console.log('\n4. La lista vive en el perfil del cliente, con el Aceptar\n');

  await page.goto(`${BASE}/pages/clientes-perfil.html?id=${cli.id}`, { waitUntil: 'networkidle' });
  await esperar(1500);
  const nFilas = await page.$$eval('#ctz-lista .ctz-tabla tbody tr', (n) => n.length).catch(() => 0);
  check('las cotizaciones del cliente aparecen en su perfil', nFilas >= 2, `${nFilas} filas`);
  check('nacen mostrándose como emitidas',
    (await page.textContent('#ctz-lista .ctz-chip')).trim() === 'emitida');

  const etiqueta = await page.textContent('#ctz-lista .ctz-acciones button');
  check('ofrece aceptar por servicio', /^Aceptar /.test((etiqueta || '').trim()), etiqueta);
  await page.click('#ctz-lista .ctz-acciones button');
  const acepto = await esperarQue(async () =>
    (await page.textContent('#ctz-lista .ctz-chip')).trim() === 'aceptada');
  check('aceptar desde el perfil la marca aceptada', acepto);

  const tras = (await sql('SELECT servicio_aceptado, total_acordado, aceptada_por FROM cotizaciones ORDER BY id DESC LIMIT 1'))[0];
  const elegida = JSON.parse((await sql('SELECT opciones FROM cotizaciones ORDER BY id DESC LIMIT 1'))[0].opciones)
    .find((o) => o.servicio === tras.servicio_aceptado);
  check('🔴 el precio acordado es el de la opción aceptada',
    elegida && Math.abs(tras.total_acordado - elegida.total) < 0.001,
    `${tras.total_acordado} vs ${elegida && elegida.total}`);
  check('y guarda quién la aceptó', !!tras.aceptada_por, String(tras.aceptada_por));

  // El desplegable: la tabla que se le envió, para reenviarla.
  await page.click('#ctz-lista button[data-accion="desglose"]');
  const desglose = await esperarQue(async () => (await page.$$('.ctz-desglose-op')).length > 0);
  check('el ▸ abre la tabla que se le envió', desglose);
  const txtDesglose = await page.textContent('.ctz-desglose-caja').catch(() => '');
  check('con el flete y el total de cada servicio',
    /Flete internacional/.test(txtDesglose) && /Total/.test(txtDesglose), txtDesglose.slice(0, 80));

  console.log('\n5. Filtrar en el perfil\n');

  await page.selectOption('#ctz-filtro-estado', 'rechazada');
  await esperar(1000);
  check('filtrando por "rechazadas" no aparece nada',
    /no tiene cotizaciones/i.test(await page.textContent('#ctz-lista')));
  await page.selectOption('#ctz-filtro-estado', 'aceptada');
  await esperar(1000);
  check('y filtrando por "aceptadas" vuelve la aceptada',
    (await page.$$eval('#ctz-lista .ctz-tabla tbody tr', (n) => n.length)) >= 1);

  console.log('\n6. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|net::ERR/i.test(x));
  check('ningún error en las dos pantallas', rel.length === 0, rel.slice(0, 2).join(' | '));

  await new Promise((res) => db.close(() => res()));
  await browser.close();
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  // El formato lo lee verificar.js para sumar las tandas: no cambiarlo.
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
