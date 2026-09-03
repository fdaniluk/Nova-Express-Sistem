#!/usr/bin/env node
/**
 * test-pantalla-link-publico.js — la página que ve el CLIENTE por su link, en un
 * navegador de verdad y SIN sesión (24/08/2026).
 *
 * El backend ya tiene su prueba (test-links-cotizacion.js: la lista blanca, el precio
 * idéntico al de la oficina, la puerta que se cierra). Esto cuida la otra mitad: la
 * página en sí, que es lo único del sistema que un extraño ve.
 *
 *  1. QUE LA PÁGINA NO CARGUE EL MOTOR. cotizador-core.js lleva las tarifas DE COSTO
 *     adentro; si algún día alguien lo engancha "para no esperar al servidor", cualquier
 *     cliente ve nuestros costos con F12. Se revisan los requests de red.
 *  2. Que cotiza de punta a punta sin cookie y muestra el desglose del cliente.
 *  3. Que en el texto de la página no aparece profit/costo por ningún lado.
 *  4. Que un link dado de baja muestra el motivo y el WhatsApp, y no deja cotizar.
 *
 *   cd backend && node scripts/test-pantalla-link-publico.js
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

const PORT = process.env.PORT_TEST || 3957;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_link.db';
const TOKEN = 'token-test-pantalla-link';

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
  const q = (sql, p = []) => new Promise((res, rej) =>
    db.all(sql, p, (e, rows) => (e ? rej(e) : res(rows))));
  await abrirSesion(DB, TOKEN);
  // Un cliente con profit por porcentaje, el caso normal del link.
  const [cliPct] = await q('SELECT id, nombre FROM clientes ORDER BY id LIMIT 1');
  const H = () => ({ 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` });

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));

  // Un link real para este cliente, armado por la API con sesión.
  const rl = await fetch(`${BASE}/api/cotizador-links`, {
    method: 'POST', headers: H(),
    body: JSON.stringify({ cliente_id: cliPct.id, couriers: 'ambos', dias: 30 }),
  });
  const LINK = await rl.json();

  // ⚠️ Página PÚBLICA: contexto SIN cookie, a propósito.
  const pagePub = await (await browser.newContext({ viewport: { width: 900, height: 1100 } })).newPage();
  const pedidos = [];
  pagePub.on('request', (rq) => pedidos.push(rq.url()));
  const erroresPub = [];
  pagePub.on('pageerror', (e) => erroresPub.push(String(e)));

  console.log('\n1. La página pública, sin sesión\n');

  await pagePub.goto(`${BASE}/cotizar/${LINK.codigo}`, { waitUntil: 'networkidle' });
  await esperar(600);

  check('la página abre por la URL linda /cotizar/CODIGO',
    (await pagePub.$eval('h1', (e) => e.textContent)).includes('Cotizá'), 'no cargó');
  check('🔴 NO carga el motor (cotizador-core.js, que lleva los costos adentro)',
    !pedidos.some((u) => /cotizador-core/.test(u)), pedidos.filter((u) => /core/.test(u)).join(','));
  check('tampoco carga api.js ni módulos del sistema',
    !pedidos.some((u) => /js\/api\.js|js\/modules/.test(u)));
  check('el saludo nombra al cliente',
    (await pagePub.textContent('#saludo')).includes(cliPct.nombre.slice(0, 8)),
    await pagePub.textContent('#saludo'));

  console.log('\n2. Cotizar de punta a punta\n');

  await pagePub.selectOption('#pais', 'Brasil');
  await pagePub.fill('.bulto .pr', '4');
  await pagePub.fill('.bulto .l', '40');
  await pagePub.fill('.bulto .a', '35');
  await pagePub.fill('.bulto .al', '50');
  await pagePub.fill('#valor', '500');
  await pagePub.click('#btn');
  await pagePub.waitForSelector('.res', { timeout: 8000 });

  const nRes = await pagePub.$$eval('.res', (n) => n.length);
  check('salen las tarjetas de resultado', nRes === 3, String(nRes));
  const texto = (await pagePub.textContent('body')) || '';
  check('muestran flete, fuel y total', /Flete internacional/.test(texto) && /Fuel \(/.test(texto) && /Total/.test(texto));
  check('la línea de datos lleva el peso facturable y el FOB',
    /14\.0 kg facturable/.test(texto) && /FOB USD 500/.test(texto),
    (texto.match(/.{0,60}facturable.{0,30}/) || [''])[0]);
  check('y la validez del link', /válida hasta el/.test(texto));

  /* El cuadrito de fuel: precargado con el de hoy, editable, y editarlo CAMBIA el
     número. La página avisa que el fuel cambia semanalmente. */
  const fuelPre = await pagePub.$eval('#fuel', (e) => e.value);
  check('el fuel viene precargado con el de hoy', Number(fuelPre) > 0, fuelPre);
  /* El cartel del fuel tiene que ser IMPOSIBLE de no ver (pedido de Felipe, 24/08):
     banda ámbar propia, dice que cambia todas las semanas, la fecha de hoy y el WhatsApp
     para pedir el vigente. */
  const cartel = await pagePub.$eval('.aviso-fuel', (e) => ({
    txt: e.textContent.replace(/\s+/g, ' '),
    visible: e.offsetParent !== null && e.offsetHeight > 30,
  }));
  check('el cartel del fuel existe y es una banda visible', cartel.visible);
  check('dice que se modifica semanalmente', /se modifica semanalmente/i.test(cartel.txt), cartel.txt.slice(0, 90));
  const cartelJuntoAlFuel = await pagePub.$eval('.aviso-fuel',
    (e) => Boolean(e.closest('.card') && e.closest('.card').querySelector('#fuel')));
  check('y vive abajo del cuadrado del fuel', cartelJuntoAlFuel);
  const totalAntes = await pagePub.$eval('.res .cuanto', (e) => e.textContent);
  await pagePub.fill('#fuel', '10');
  await pagePub.click('#btn');
  await esperar(1200);
  const totalDespues = await pagePub.$eval('.res .cuanto', (e) => e.textContent);
  const textoFuel = (await pagePub.textContent('body')) || '';
  check('cambiar el fuel recotiza con el nuevo (10%)', /Fuel \(10%\)/.test(textoFuel),
    (textoFuel.match(/Fuel \([^)]*\)/) || [''])[0]);
  check('y el total se mueve', totalAntes !== totalDespues, `${totalAntes} vs ${totalDespues}`);

  console.log('\n3. Nada de la oficina en el texto\n');

  /* "El costo dado no contempla impuestos…" es la leyenda de SIEMPRE para el cliente
     (la misma de la imagen de la cotización): se descuenta antes de escanear. Lo que se
     busca es el costo NUESTRO, el profit y el margen, que jamás pueden aparecer. */
  const bajo = texto.toLowerCase().replace(/el costo dado no contempla[^.]*\./g, '');
  const feas = ['profit', 'costo', 'margen', 'ganancia', 'precio por kilo', 'utilidad']
    .filter((p) => bajo.includes(p));
  check('🔴 el texto de la página no dice profit/costo/margen/ganancia', feas.length === 0, feas.join(','));

  console.log('\n4. La puerta cerrada\n');

  await q('UPDATE cotizador_links SET activo = 0 WHERE id = ?', [LINK.id]);
  await pagePub.reload({ waitUntil: 'networkidle' });
  await esperar(600);
  const roto = (await pagePub.textContent('#roto')) || '';
  check('dado de baja, la página muestra el motivo', /dado de baja/i.test(roto), roto.slice(0, 80));
  check('y ofrece el WhatsApp', /\+54 9 11 6500-2047/.test(roto));
  check('el formulario no está', !(await pagePub.$('#pais e')) && (await pagePub.$eval('#app', (e) => e.style.display)) === 'none');

  check('sin errores de JavaScript en la página pública',
    erroresPub.filter((x) => !/favicon/i.test(x)).length === 0, erroresPub.join(' | '));

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
