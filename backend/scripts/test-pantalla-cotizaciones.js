#!/usr/bin/env node
/**
 * test-pantalla-cotizaciones.js — guardar una cotización y marcarla aceptada, en un
 * navegador de verdad (24/08/2026).
 *
 * El backend ya tiene su prueba (`test-cotizaciones.js`). Esto cuida la otra mitad: que
 * la oficina pueda hacerlo desde la pantalla que usa todos los días, y sobre todo que lo
 * que se guarda sea LO MISMO que se le mostró al cliente.
 *
 * QUÉ SE PRUEBA, en orden de riesgo:
 *
 *  1. QUE LOS TOTALES GUARDADOS SEAN LOS DE LAS TARJETAS. Si la pantalla mostrara un
 *     número y guardara otro, el precio acordado sería prueba de algo que nunca se
 *     cotizó — y ese es justamente el problema que el módulo viene a resolver.
 *  2. Que se guarde una opción por cada tarjeta, ni más ni menos.
 *  3. Que el botón no aparezca antes de calcular (no hay nada que congelar).
 *  4. Que marcar "Aceptar DHL" desde la lista deje el estado y el precio acordado bien.
 *  5. Que la pantalla no tire errores de JavaScript.
 *
 *   cd backend && node scripts/test-pantalla-cotizaciones.js
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

const PORT = process.env.PORT_TEST || 3961;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_cotizaciones.db';
const TOKEN = 'token-test-pantalla-cotizaciones';

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
  await esperar(900);

  console.log('\n1. El botón de guardar aparece recién cuando hay resultados\n');

  const visible = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? getComputedStyle(el).display !== 'none' : false;
  }, sel);

  check('antes de calcular, la barra de guardar está oculta', !(await visible('#barra-guardar')));

  // El caso Asaplast tal cual: una caja de 4 kg reales que da 14 de volumen.
  await page.evaluate(() => {
    document.getElementById('pais').value = 'Brasil';
    document.getElementById('tipo').value = 'export';
    document.getElementById('ganancia').value = '40';
    document.getElementById('fuel_fuente').value = 'manual';
    document.getElementById('fuel').value = '30';
    document.getElementById('couriers').value = 'ambos';
    document.getElementById('valor').value = '500';
    const r = document.querySelector('.bulto-row');
    r.querySelector('.b-peso').value = '4';
    r.querySelector('.b-largo').value = '40';
    r.querySelector('.b-ancho').value = '35';
    r.querySelector('.b-alto').value = '50';
    r.querySelector('.b-peso').dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.selectOption('#cliente', { index: 1 });
  await page.click('.btn-calc');
  await esperar(2500);

  check('con resultados, la barra aparece', await visible('#barra-guardar'));

  // Lo que muestran las tarjetas, que es lo que el cliente ve.
  const enPantalla = await page.evaluate(() =>
    [...document.querySelectorAll('.result-card')].map((c) => ({
      courier: c.querySelector('.result-courier').childNodes[0].textContent.trim(),
      total: c.querySelector('.result-total').textContent.trim(),
    })));
  check('hay tarjetas para cotizar', enPantalla.length >= 2, `${enPantalla.length}`);

  console.log('\n2. Guardar: lo que se guarda es lo que se mostró\n');

  await page.click('.btn-guardar-ctz');
  await esperar(1800);

  const aviso = await page.textContent('#bg-msg');
  check('avisa el número con el que quedó guardada', /CTZ-\d+/.test(aviso || ''), aviso);

  const guardada = await page.evaluate(async () => {
    const lista = await NovaAPI.cotizaciones.listar({ limite: 1 });
    return lista.length ? NovaAPI.cotizaciones.obtener(lista[0].id) : null;
  });
  check('la cotización quedó en la base', !!guardada);

  const ops = JSON.parse(guardada.opciones);
  check('2.1 se guardó una opción por cada tarjeta', ops.length === enPantalla.length,
    `${ops.length} guardadas vs ${enPantalla.length} en pantalla`);

  /* ⚠️ EL CONTROL QUE IMPORTA. Se compara lo guardado contra lo que dice la tarjeta,
     pasándolo por los MISMOS ayudantes que dibujan la pantalla (`fmt` y `nombreCorto`).
     Ojo: la tarjeta muestra el nombre abreviado que pidió la oficina ("UPS W.E") y lo
     guardado lleva el nombre completo del servicio — eso está bien y es a propósito, lo
     que no puede pasar es que los NÚMEROS se separen. Si esto se pone rojo, el precio
     acordado deja de ser prueba de lo que se le cotizó al cliente. */
  const comoSeVerian = await page.evaluate((opciones) =>
    opciones.map((o) => ({ courier: nombreCorto(o.servicio), total: fmt(o.total) })), ops);
  const desalineadas = enPantalla.filter((t) =>
    !comoSeVerian.some((g) => g.courier === t.courier && g.total === t.total));
  check('2.2 cada total guardado es EL MISMO que muestra su tarjeta',
    desalineadas.length === 0,
    `en pantalla ${JSON.stringify(enPantalla)} · guardadas ${JSON.stringify(comoSeVerian)}`);

  check('se congeló el fuel que se usó', ops.every((o) => Number.isFinite(Number(o.fuel_pct))),
    JSON.stringify(ops.map((o) => o.fuel_pct)));
  check('y las medidas de la caja tal cual se tipearon',
    JSON.parse(guardada.entrada).bultos[0].l === 40);
  check('el peso facturable guardado es el de la cotización (14 kg)',
    Math.abs(guardada.peso_facturable - 14) < 0.01, String(guardada.peso_facturable));

  console.log('\n3. La lista y el paso a ACEPTADA\n');

  const filas = await page.$$eval('.ctz-tabla tbody tr', (n) => n.length);
  check('la cotización aparece en la lista de la pantalla', filas >= 1, `${filas}`);
  check('nace mostrándose como emitida',
    (await page.textContent('.ctz-chip')).trim() === 'emitida');

  // "Aceptar DHL": el primer botón de acciones de la primera fila.
  const etiqueta = await page.textContent('.ctz-acciones button');
  check('ofrece aceptar por servicio', /^Aceptar /.test((etiqueta || '').trim()), etiqueta);
  await page.click('.ctz-acciones button');
  await esperar(1500);

  check('queda marcada como aceptada',
    (await page.textContent('.ctz-chip')).trim() === 'aceptada');

  const tras = await page.evaluate(async () => {
    const lista = await NovaAPI.cotizaciones.listar({ limite: 1 });
    return lista[0];
  });
  const elegida = ops.find((o) => o.servicio === tras.servicio_aceptado);
  check('3.1 el precio acordado es el de la opción que se aceptó',
    elegida && Math.abs(tras.total_acordado - elegida.total) < 0.001,
    `${tras.total_acordado} vs ${elegida ? elegida.total : 'sin opción'}`);
  check('y guarda quién la aceptó', !!tras.aceptada_por, String(tras.aceptada_por));

  console.log('\n4. Filtrar la lista\n');

  await page.selectOption('#ctz-filtro-estado', 'rechazada');
  await esperar(1200);
  const vacia = await page.textContent('#ctz-lista');
  check('filtrando por "rechazadas" no aparece la aceptada', /Todavía no hay/.test(vacia), vacia.slice(0, 60));
  await page.selectOption('#ctz-filtro-estado', 'aceptada');
  await esperar(1200);
  check('y filtrando por "aceptadas" vuelve a aparecer',
    (await page.$$eval('.ctz-tabla tbody tr', (n) => n.length)) >= 1);

  console.log('\n5. Sin errores de JavaScript\n');
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
