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
 *  6. Que SIN clave de Anthropic la pantalla siga usable: cartel de aviso, pero se
 *     puede escribir, vincular un teléfono y ver el motivo cuando hace falta el modelo.
 *  7. Que en un TELÉFONO de verdad (390×844) nada se pise, la barra de escribir no
 *     quede debajo del teclado, el menú y la lista salgan como hojas, y el texto mida
 *     16px para que Safari no haga zoom.
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

  // ── 3-bis ────────────────────────────────────────────────────────────────────
  console.log('\n3-bis. Teléfonos y simulador (15/09)\n');
  await page.click('.asi-tabs button[data-tab="telefonos"]');
  await esperar(300);
  check('la pestaña Teléfonos se abre y arranca vacía',
    !(await page.$eval('.asi-tab[data-panel="telefonos"]', (e) => e.hidden))
    && /todavía no hay teléfonos/i.test(await page.$eval('#asi-vinculos', (e) => e.textContent)));
  await page.selectOption('#asi-canal', 'whatsapp');
  await page.fill('#asi-etiqueta', 'celu de prueba');
  await page.click('#asi-vincular');
  await page.waitForFunction(() => !document.getElementById('asi-codigo').hidden, null, { timeout: 5000 });
  const cartel = await page.$eval('#asi-codigo', (e) => e.textContent);
  check('"Sacar código" muestra un código de 6 dígitos y dice qué hacer con él',
    /\d{6}/.test(cartel) && /WhatsApp/i.test(cartel), cartel);
  check('   y el teléfono queda listado como pendiente',
    /esperando el código/i.test(await page.$eval('#asi-vinculos', (e) => e.textContent)));
  const codigoPanel = (cartel.match(/\d{6}/) || [])[0];
  check('   el código del cartel es el que guardó el servidor',
    codigoPanel === String((await get('SELECT codigo FROM bot_vinculos ORDER BY id DESC LIMIT 1')).codigo), codigoPanel);

  /* El simulador: escribe como si fuera un teléfono, por el camino de WhatsApp. */
  await page.click('.asi-modo button[data-modo="telefono"]');
  /* El simulador pide el código por red (GET /vinculos + POST /vincular). Esperar 600 ms
     alcanzaba acá y no en la máquina de Felipe (15/09: tres controles en rojo por eso).
     Se espera A QUE APAREZCA EL CÓDIGO, que es la señal de que terminó. */
  await page.waitForFunction(
    () => [...document.querySelectorAll('.asi-msg')].some((n) => /\d{6}/.test(n.textContent)),
    null, { timeout: 15000 },
  );
  await esperar(150);
  check('el chat se pone en modo teléfono', await page.$eval('.asi-chat', (e) => e.classList.contains('telefono')));
  const avisoSim = (await burbujas()).map((x) => x.texto).join(' ');
  check('   avisa que sin vínculo no va a contestar y da el código para vincularlo',
    /no está vinculado|no te va a contestar|no te va a contestar nada/i.test(avisoSim) && /\d{6}/.test(avisoSim), avisoSim.slice(0, 200));
  const codigoSim = (avisoSim.match(/mandá acá el código (\d{6})/) || [])[1];
  await escribir('cómo viene la venta de hoy');
  b = await burbujas();
  check('un teléfono sin vincular NO obtiene datos', /no te tengo vinculado/i.test(b[b.length - 1].texto), b[b.length - 1].texto);
  await escribir(codigoSim);
  b = await burbujas();
  check('mandando el código queda vinculado', /vinculado/i.test(b[b.length - 1].texto), b[b.length - 1].texto);
  await escribir('cómo viene la venta de hoy');
  b = await burbujas();
  check('   y ahora sí contesta, por el mismo camino que usará WhatsApp', /USD/.test(b[b.length - 1].texto), b[b.length - 1].texto);
  check('   la conversación quedó guardada con el canal de prueba',
    (await get("SELECT COUNT(*) n FROM bot_conversaciones WHERE canal = 'prueba'")).n === 1);
  await page.click('.asi-modo button[data-modo="panel"]');
  await esperar(300);
  check('volver al sistema saca el modo teléfono', !(await page.$eval('.asi-chat', (e) => e.classList.contains('telefono'))));

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

  // ── 6 ───────────────────────────────────────────────────────────────────
  /* Sin clave de Anthropic y sin mock: el modelo no puede contestar, pero la pantalla
     NO se tiene que bloquear. Vincular un teléfono (mandar el código de 6 dígitos) y el
     simulador pasan por bot-canales y no necesitan modelo; si de verdad hace falta, el
     servidor contesta 503 con el motivo y eso se ve como un mensaje de error, no como
     una pantalla muda. (15/09/2026 — lo reportó la oficina: "no me deja escribir".) */
  console.log('\n6. Sin clave, la pantalla sigue usable\n');
  const PORT2 = Number(PORT) + 40;
  const BASE2 = `http://localhost:${PORT2}`;
  const DB2 = DB.replace(/\.db$/, '_sinclave.db');
  const TOKEN2 = TOKEN + '-sinclave';
  prepararDb(DB2, { desdeProduccion: false });
  const srv2 = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB2, PORT: String(PORT2), NODE_ENV: 'production', BOT_MOCK: '', ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut2 = '', logErr2 = '';
  srv2.stdout.on('data', (d) => { logOut2 += d; });
  srv2.stderr.on('data', (d) => { logErr2 += d; });
  let srv2Muerto = false;
  const matarSrv2 = () => { if (srv2Muerto) return; srv2Muerto = true; try { srv2.kill(); } catch {} };
  process.on('exit', matarSrv2);
  await esperarServidor(srv2, BASE2, () => logErr2, () => logOut2);
  await abrirSesion(DB2, TOKEN2);

  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx2.addCookies([{ name: 'nova_session', value: TOKEN2, url: BASE2 }]);
  const page2 = await ctx2.newPage();
  const errores2 = [];
  page2.on('pageerror', (e) => errores2.push(String(e)));
  await page2.goto(BASE2 + '/pages/asistente.html', { waitUntil: 'networkidle' });
  await esperar(600);

  check('el estado de arriba dice "sin configurar"', /sin configurar/i.test(await page2.$eval('#asi-estado', (e) => e.textContent)));
  check('   y aparece el cartel rojo explicando que falta la clave',
    !(await page2.$eval('#asi-aviso', (e) => e.hidden)) && /ANTHROPIC_API_KEY/.test(await page2.$eval('#asi-aviso', (e) => e.textContent)));
  check('el cuadro de texto SIGUE habilitado', !(await page2.$eval('#asi-texto', (e) => e.disabled)));
  check('   y el botón Enviar también', !(await page2.$eval('#asi-enviar', (e) => e.disabled)));

  const escribir2 = async (t) => {
    await page2.fill('#asi-texto', t);
    await page2.press('#asi-texto', 'Enter');
    await page2.waitForFunction(() => !document.querySelector('.asi-msg.pensando') && !document.getElementById('asi-enviar').disabled, null, { timeout: 15000 });
    await esperar(150);
  };
  const burbujas2 = () => page2.$$eval('.asi-msg:not(.pensando)', (ns) => ns.map((n) => n.textContent));

  await page2.click('.asi-modo button[data-modo="telefono"]');
  /* El simulador pide el código por red (GET /vinculos + POST /vincular). Esperar 600 ms
     alcanzaba acá y no en la máquina de Felipe (15/09: tres controles en rojo por eso).
     Se espera A QUE APAREZCA EL CÓDIGO, que es la señal de que terminó. */
  await page2.waitForFunction(
    () => [...document.querySelectorAll('.asi-msg')].some((n) => /\d{6}/.test(n.textContent)),
    null, { timeout: 15000 },
  );
  await esperar(150);
  const aviso2 = (await burbujas2()).join(' ');
  const codigo2 = (aviso2.match(/mandá acá el código (\d{6})/) || [])[1];
  check('el simulador saca el código igual que con clave', !!codigo2, aviso2.slice(0, 160));
  await escribir2(codigo2 || '000000');
  let b2 = await burbujas2();
  check('   y mandando el código se vincula SIN modelo', /vinculado/i.test(b2[b2.length - 1]), b2[b2.length - 1]);
  check('   el cuadro de texto sigue habilitado después de mandar', !(await page2.$eval('#asi-texto', (e) => e.disabled)));

  await escribir2('cómo viene la venta de hoy');
  b2 = await burbujas2();
  check('una pregunta de verdad avisa que falta la clave, no queda muda',
    /clave|configurad|ANTHROPIC/i.test(b2[b2.length - 1]), b2[b2.length - 1]);
  check('   y se puede volver a escribir después del error', !(await page2.$eval('#asi-enviar', (e) => e.disabled)));
  const rel2 = errores2.filter((x) => !/favicon|Failed to load resource/i.test(x));
  check('ningún error de JavaScript sin clave', rel2.length === 0, rel2.slice(0, 2).join(' | '));

  await ctx2.close();
  matarSrv2();

  // ── 7 ───────────────────────────────────────────────────────────────────
  /* El asistente en un teléfono (15/09/2026). Se mide con un iPhone chico de verdad
     (390×844), no "a ojo con la ventana angosta": lo que rompe en el teléfono son cajas
     que se pisan, cosas que quedan debajo del teclado y el zoom de Safari al enfocar.
     Cada control de acá mide UNA caja real, no una clase de CSS. */
  console.log('\n7. El teléfono (390×844)\n');
  const ctxT = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await ctxT.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const tel = await ctxT.newPage();
  const erroresT = [];
  tel.on('pageerror', (e) => erroresT.push(String(e)));
  await tel.goto(BASE + '/pages/asistente.html', { waitUntil: 'networkidle' });
  await esperar(700);

  const caja = (sel) => tel.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });
  const alto = await tel.evaluate(() => window.innerHeight);
  const ancho = await tel.evaluate(() => window.innerWidth);

  check('la página no se va para el costado (sin scroll horizontal)',
    (await tel.evaluate(() => document.documentElement.scrollWidth)) <= ancho + 1,
    String(await tel.evaluate(() => document.documentElement.scrollWidth)));
  const entrada = await caja('.asi-entrada');
  check('la barra de escribir entra en la pantalla (no queda tapada abajo)',
    entrada.bottom <= alto + 1 && entrada.bottom > alto - 160, `bottom ${Math.round(entrada.bottom)} de ${alto}`);
  const msgs = await caja('.asi-mensajes');
  check('   y NO se pisa con los mensajes', msgs.bottom <= entrada.top + 1,
    `mensajes hasta ${Math.round(msgs.bottom)}, entrada desde ${Math.round(entrada.top)}`);
  check('el chat ocupa casi toda la pantalla', msgs.h > alto * 0.5, `${Math.round(msgs.h)} de ${alto}`);
  const letraTexto = await tel.$eval('#asi-texto', (e) => parseFloat(getComputedStyle(e).fontSize));
  check('el cuadro de texto mide 16px o más (si no, Safari hace zoom al tocarlo)', letraTexto >= 16, String(letraTexto));

  /* El menú del sistema: afuera hasta que lo pedís, y que no robe ancho al chat. */
  const menuCerrado = await caja('.sidebar');
  check('el menú arranca afuera de la pantalla', menuCerrado.right <= 1, `right ${Math.round(menuCerrado.right)}`);
  check('   así el chat tiene el ancho entero', msgs.w > ancho * 0.9, `${Math.round(msgs.w)} de ${ancho}`);
  await tel.click('#asi-menu');
  await tel.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().left > -5, null, { timeout: 4000 });
  check('el botón ☰ lo abre', (await caja('.sidebar')).left > -5);
  check('   y se leen los nombres, no solo los íconos',
    await tel.$eval('.sidebar-nav a[href$="salidas.html"] span:last-child', (e) => getComputedStyle(e).display !== 'none'));
  // A la derecha, fuera del menú: en el medio el toque cae sobre el menú mismo.
  await tel.click('#asi-fondo', { position: { x: ancho - 30, y: Math.round(alto / 2) } });
  await tel.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1, null, { timeout: 4000 });
  check('   tocando afuera se cierra', (await caja('.sidebar')).right <= 1);

  /* La hoja de Conversaciones / Teléfonos: en el teléfono el lateral no existe, y sin
     esto no habría forma de sacar un código de vinculación desde el celular. */
  check('la lista lateral arranca escondida', (await caja('#asi-lista')).top >= alto - 1);
  await tel.click('#asi-panel');
  await tel.waitForFunction(() => document.getElementById('asi-lista').getBoundingClientRect().top < window.innerHeight - 50, null, { timeout: 4000 });
  await esperar(350);   // que termine de subir antes de medirla
  const hoja = await caja('#asi-lista');
  check('el botón ▤ sube la hoja de conversaciones', hoja.top < alto - 50 && hoja.bottom <= alto + 1, `top ${Math.round(hoja.top)}`);
  await tel.click('.asi-tabs button[data-tab="telefonos"]');
  await esperar(300);
  check('   y desde el teléfono se llega a la pestaña Teléfonos',
    await tel.$eval('.asi-tab[data-panel="telefonos"]', (e) => !e.hidden));
  await tel.fill('#asi-etiqueta', 'celular de Felipe');
  await tel.click('#asi-vincular');
  await tel.waitForFunction(() => !document.getElementById('asi-codigo').hidden, null, { timeout: 5000 });
  check('   y se puede sacar un código de vinculación', /\d{6}/.test(await tel.$eval('#asi-codigo', (e) => e.textContent)));
  await tel.click('#asi-cerrar-panel');
  await tel.waitForFunction(() => document.getElementById('asi-lista').getBoundingClientRect().top >= window.innerHeight - 1, null, { timeout: 4000 });
  check('   la ✕ la baja', (await caja('#asi-lista')).top >= alto - 1);

  /* Y que el chat ande: mandar con el botón (en el teléfono el Enter baja de línea). */
  await tel.fill('#asi-texto', 'cómo viene la venta de hoy');
  await tel.click('#asi-enviar');
  await tel.waitForFunction(() => !document.querySelector('.asi-msg.pensando') && document.querySelectorAll('.asi-msg.assistant').length >= 1, null, { timeout: 15000 });
  await esperar(200);
  const burbujasT = await tel.$$eval('.asi-msg', (ns) => ns.map((n) => ({ texto: n.textContent, w: n.getBoundingClientRect().width, right: n.getBoundingClientRect().right })));
  check('manda con el botón y contesta', /USD/.test(burbujasT[burbujasT.length - 1].texto), burbujasT[burbujasT.length - 1].texto.slice(0, 120));
  check('   las burbujas no se salen de la pantalla', burbujasT.every((b) => b.right <= ancho + 1 && b.w <= ancho));
  const entrada2 = await caja('.asi-entrada');
  const msgs2 = await caja('.asi-mensajes');
  check('   y después de escribir nada se pisa', msgs2.bottom <= entrada2.top + 1 && entrada2.bottom <= alto + 1);

  /* Acostado: queda la mitad de alto y la barra de escribir tiene que seguir entrando. */
  await tel.setViewportSize({ width: 844, height: 390 });
  await esperar(400);
  const entradaH = await caja('.asi-entrada');
  check('acostado, la barra de escribir sigue entrando', entradaH.bottom <= 391, `bottom ${Math.round(entradaH.bottom)}`);
  check('   y el chat sigue teniendo lugar', (await caja('.asi-mensajes')).h > 120, String(Math.round((await caja('.asi-mensajes')).h)));

  const relT = erroresT.filter((x) => !/favicon|Failed to load resource/i.test(x));
  check('ningún error de JavaScript en el teléfono', relT.length === 0, relT.slice(0, 2).join(' | '));
  await ctxT.close();

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
