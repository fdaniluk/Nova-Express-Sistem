#!/usr/bin/env node
/**
 * test-links-cotizacion.js — la PRIMERA puerta sin contraseña del sistema, contra la API.
 *
 * El link de cotización deja que un cliente cotice solo, sin sesión. Eso lo convierte en
 * el lugar más delicado del sistema: del otro lado no está la oficina, está cualquiera
 * que tenga la URL. Este test cuida las dos cosas que no pueden fallar, en este orden:
 *
 *  1. QUE NO FUGUE NADA. La respuesta pública se escanea ENTERA contra una lista de
 *     palabras prohibidas (profit, costo, fleteBase, precioKg, modoVenta…). Si esto se
 *     pone rojo, la fuga del margen que se cerró el 20/08 se reabrió por la puerta
 *     pública.
 *  2. QUE EL PRECIO SEA EL DE LA OFICINA, CENTAVO POR CENTAVO. El link cotiza por
 *     cotizacion.service y el mismo motor. Se cotiza lo mismo por el link y por la API
 *     interna y los totales tienen que ser idénticos: un link que da otro precio es un
 *     link que promete lo que la oficina no va a cobrar.
 *
 * Después, la puerta en sí: código inventado → 404 · dado de baja → 410 · vencido → 410 ·
 * tope diario → 429 · la gestión requiere sesión · el link sin cliente usa su profit.
 *
 *   cd backend && node scripts/test-links-cotizacion.js
 */

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
// Arranque común: base de test fresca (copia de producción) y sesión válida.
// Ver scripts/_base-test.js para por qué hace falta.
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3962;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_links_cotizacion.db';
const TOKEN = 'token-test-links';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const H = () => ({ 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` });

async function main() {
  // Base de test: copia FRESCA de la de producción en cada corrida.
  prepararDb(DB);

  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Se guarda lo que el servidor escribe: es el unico lugar donde esta el motivo si no
  // arranca. La linea de 'listo' sale por stdout y es lo que espera esperarServidor().
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
  const cerrar = async (code) => {
    matarSrv();
    await esperarSrvMuerto();
    // Ni siquiera acá se llama process.exit(): matar el proceso a mano es lo que venía
    // reventando en Windows. Se deja el código de salida y Node termina solo cuando no le
    // queda nada pendiente, que es cuando ya no hay ningún handle a medio cerrar.
    // El timer es la red de seguridad por si algo quedara vivo (sockets keep-alive de
    // fetch, por ejemplo): va con .unref(), así NO sostiene el proceso —si no hay nada
    // más, Node sale igual al instante— y solo actúa si a los 3 s todavía sigue en pie.
    process.exitCode = code;
    setTimeout(() => process.exit(code), 3000).unref();
  };

  // Antes habia un bucle de 40 intentos contra /api/health que seguia de largo pasara lo
  // que pasara: si el servidor tardaba mas de 12 segundos en arrancar —en Windows, con la
  // base creandose y el antivirus mirando, pasa— el test continuaba igual y reventaba mas
  // adelante con un ECONNREFUSED o un 'no such table' que no tenian nada que ver.
  // Ver scripts/_base-test.js.
  await esperarServidor(srv, BASE, () => logErr, () => logOut);

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) =>
    db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await abrirSesion(DB, TOKEN);
  const [cli] = await q('SELECT id FROM clientes ORDER BY id LIMIT 1');

  const PUB = (cod) => `${BASE}/api/publico/cotizador/${cod}`;
  const ADM = `${BASE}/api/cotizador-links`;
  const post = (url, body, conAuth = true) => fetch(url, {
    method: 'POST',
    headers: conAuth ? H() : { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  const CAJAS = [{ pr: 4, l: 40, a: 35, al: 50 }, { pr: 4, l: 40, a: 35, al: 50 }];

  console.log('\n1. Armar el link (con sesión) y abrirlo (sin sesión)\n');

  let r = await post(ADM, { cliente_id: cli.id, couriers: 'ambos', dias: 30 });
  let j = await r.json().catch(() => ({}));
  check('la oficina arma un link para el cliente', r.status === 201, `${r.status} ${JSON.stringify(j)}`);
  check('el código es largo y aleatorio (32 hex)', /^[a-f0-9]{32}$/.test(j.codigo || ''), j.codigo);
  const LINK = j;

  r = await fetch(ADM, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('armar links SIN sesión da 401', r.status === 401, String(r.status));

  r = await fetch(PUB(LINK.codigo));
  j = await r.json();
  check('el cliente abre el link sin ninguna sesión', r.ok, String(r.status));
  check('la apertura trae la lista de países', Array.isArray(j.paises) && j.paises.length > 100,
    String((j.paises || []).length));
  check('y los servicios del link', Array.isArray(j.servicios) && j.servicios.length === 3,
    JSON.stringify(j.servicios));

  r = await fetch(PUB('0'.repeat(32)));
  check('un código inventado da 404', r.status === 404, String(r.status));

  console.log('\n2. La cotización pública: NADA fuga y el precio es EL de la oficina\n');

  r = await post(PUB(LINK.codigo) + '/cotizar',
    { pais: 'Brasil', tipo: 'export', valor: 500, bultos: CAJAS }, false);
  const publica = await r.json();
  check('la cotización pública sale', r.ok && Array.isArray(publica.opciones), JSON.stringify(publica).slice(0, 120));
  check('trae una opción por servicio', publica.opciones.length === 3, String(publica.opciones.length));
  // 40×35×50/5000 = 14 kg de volumen justos por caja; max(4,14)=14, que ya está en el
  // medio kilo. Dos cajas: 28. (El redondeo POR BULTO se nota con medidas que no dan
  // redondo: se agrega una caja de 30×30×30 → 5.4 → 5.5.)
  check('el peso facturable usa el redondeo por bulto (14+14 = 28)',
    Math.abs(publica.peso_facturable - 28) < 0.001, String(publica.peso_facturable));

  const rImpar = await post(PUB(LINK.codigo) + '/cotizar',
    { pais: 'Brasil', tipo: 'export', bultos: [{ pr: 1, l: 30, a: 30, al: 30 }] }, false);
  const jImpar = await rImpar.json();
  check('y redondea al medio kilo para arriba (5.4 → 5.5)',
    rImpar.ok && Math.abs(jImpar.peso_facturable - 5.5) < 0.001, String(jImpar.peso_facturable));

  /* ⚠️ 2.1 EL ESCÁNER DE FUGAS. El JSON entero, claves y valores, contra la lista de lo
     que JAMÁS puede viajar a un navegador sin sesión. */
  const crudo = JSON.stringify(publica).toLowerCase();
  const PROHIBIDAS = ['profit', 'costo', 'fletebase', 'preciokg', 'precio_kg', 'modoventa',
    'modo_venta', 'utilidad', 'margen', 'ganancia', 'kg_venta', 'pfventa'];
  const fugadas = PROHIBIDAS.filter((p) => crudo.includes(p));
  check('🔴 2.1 la respuesta pública no fuga NADA (profit/costo/precio por kilo)',
    fugadas.length === 0, `fugó: ${fugadas.join(', ')}`);

  /* ⚠️ 2.2 EL MISMO NÚMERO QUE LA OFICINA. Cada servicio del link contra la API interna
     con el mismo cliente y los mismos bultos. */
  const MAPA = { 'DHL Express Worldwide': 'DHL', 'UPS Worldwide Expedited': 'UPS_EXP', 'UPS Worldwide Saver': 'UPS_SAV' };
  for (const op of publica.opciones) {
    const servicio = MAPA[op.servicio];
    const ri = await post(`${BASE}/api/liquidaciones/cotizar`, {
      cliente_id: cli.id,
      servicio,
      tipo: 'export',
      pais: 'Brasil',
      pesoFacturable: publica.peso_facturable,
      fob: 500,
      bultos: CAJAS.map((c) => ({ peso_real: c.pr, largo: c.l, ancho: c.a, alto: c.al })),
      contenido: 'paquete',
    });
    const interna = await ri.json();
    check(`2.2 ${op.corto}: el link y la oficina dan el MISMO total`,
      ri.ok && Math.abs(interna.precioFinal - op.total) < 0.01,
      `link ${op.total} vs oficina ${interna.precioFinal}`);
  }

  console.log('\n2-bis. El fuel editable\n');

  /* La apertura precarga el fuel de HOY, y el cliente puede pisarlo (el fuel cambia
     semanalmente y la página se lo dice). El servidor lo acota a [0, 100]: es un
     porcentaje de combustible, no un campo libre. */
  r = await fetch(PUB(LINK.codigo));
  j = await r.json();
  check('la apertura trae el fuel de hoy precargado', Number.isFinite(j.fuel) && j.fuel > 0, String(j.fuel));

  r = await post(PUB(LINK.codigo) + '/cotizar',
    { pais: 'Brasil', tipo: 'export', fuel: 10, bultos: CAJAS }, false);
  j = await r.json();
  const conFuel10 = j.opciones[0];
  check('el fuel que carga el cliente se usa', conFuel10.fuel_pct === 10, String(conFuel10.fuel_pct));
  check('y el monto de fuel lo refleja (10% del subtotal)',
    Math.abs(conFuel10.fuel_monto - conFuel10.subtotal * 0.10) < 0.02,
    `${conFuel10.fuel_monto} vs ${(conFuel10.subtotal * 0.10).toFixed(2)}`);
  const totalFuel10 = conFuel10.total;

  r = await post(PUB(LINK.codigo) + '/cotizar',
    { pais: 'Brasil', tipo: 'export', fuel: 999, bultos: CAJAS }, false);
  j = await r.json();
  check('un fuel de 999 se acota a 100', j.opciones[0].fuel_pct === 100, String(j.opciones[0].fuel_pct));
  check('y cambiar el fuel cambia el total (no es decorativo)',
    Math.abs(j.opciones[0].total - totalFuel10) > 1,
    `${j.opciones[0].total} vs ${totalFuel10}`);

  console.log('\n2-ter. El link "a secas" (sin nombrar el servicio)\n');

  /* Como el tarifario sin nombrar: Felipe a veces manda una tarifa y despacha por el
     courier que le conviene. La regla es LA MISMA del tarifario: si el título no nombra
     el servicio, ningún renglón puede nombrarlo — "Seguro DHL" abajo de "Opción 1" es
     nombrarlo igual. */
  r = await post(ADM, { cliente_id: cli.id, couriers: 'ambos', dias: 30, nombrar: false });
  const ANON = await r.json();
  check('se arma un link sin nombrar', r.status === 201 && ANON.nombrar === 0, JSON.stringify(ANON).slice(0, 80));

  r = await fetch(PUB(ANON.codigo));
  j = await r.json();
  check('la apertura no manda los servicios', Array.isArray(j.servicios) && j.servicios.length === 0,
    JSON.stringify(j.servicios));

  r = await post(PUB(ANON.codigo) + '/cotizar',
    { pais: 'Brasil', tipo: 'export', valor: 500, bultos: CAJAS }, false);
  j = await r.json();
  check('cotiza igual, con una opción por servicio', r.ok && j.opciones.length === 3, String((j.opciones || []).length));
  check('las opciones se llaman "Opción 1/2/3"',
    j.opciones.every((o, idx) => o.servicio === `Opción ${idx + 1}` && o.corto === `Opción ${idx + 1}`),
    JSON.stringify(j.opciones.map((o) => o.servicio)));
  const crudoAnon = JSON.stringify(j);
  check('🔴 y NINGÚN renglón nombra al courier (ni DHL ni UPS ni GoGreen)',
    !/DHL|UPS|GoGreen/i.test(crudoAnon),
    (crudoAnon.match(/.{0,40}(DHL|UPS|GoGreen).{0,40}/i) || [''])[0]);
  /* Los totales son los mismos con o sin nombre: es presentación, no precio. */
  check('los totales del link a secas son los MISMOS que con nombre',
    Math.abs(j.opciones[0].total - publica.opciones[0].total) < 0.01,
    `${j.opciones[0].total} vs ${publica.opciones[0].total}`);

  console.log('\n3. Entradas rotas\n');

  r = await post(PUB(LINK.codigo) + '/cotizar', { pais: '', bultos: CAJAS }, false);
  check('sin país da 400', r.status === 400, String(r.status));
  r = await post(PUB(LINK.codigo) + '/cotizar', { pais: 'Brasil', bultos: [] }, false);
  check('sin bultos da 400', r.status === 400, String(r.status));
  r = await post(PUB(LINK.codigo) + '/cotizar', { pais: 'Brasil', bultos: [{ pr: 5, l: 0, a: 10, al: 10 }] }, false);
  check('un bulto sin las tres medidas da 400', r.status === 400, String(r.status));
  r = await post(PUB(LINK.codigo) + '/cotizar', { pais: 'Un pais inventado', bultos: CAJAS }, false);
  check('un país que no existe da 404 con mensaje claro', r.status === 404, String(r.status));

  console.log('\n4. La puerta se cierra: baja, vencimiento y tope\n');

  // Tope diario: se planta el contador en el tope y la próxima tiene que rebotar.
  await q('UPDATE cotizador_links SET consultas_hoy = 100, dia_consultas = date("now","localtime") WHERE id = ?', [LINK.id]);
  r = await post(PUB(LINK.codigo) + '/cotizar', { pais: 'Brasil', bultos: CAJAS }, false);
  check('al tope diario responde 429', r.status === 429, String(r.status));
  await q('UPDATE cotizador_links SET consultas_hoy = 0 WHERE id = ?', [LINK.id]);

  // Vencimiento
  await q('UPDATE cotizador_links SET vence_en = date("now","localtime","-1 day") WHERE id = ?', [LINK.id]);
  r = await fetch(PUB(LINK.codigo));
  j = await r.json();
  check('vencido: 410 y el mensaje ofrece el WhatsApp', r.status === 410 && /whatsapp/i.test(j.error || ''),
    `${r.status} ${j.error}`);
  await q('UPDATE cotizador_links SET vence_en = date("now","localtime","+30 day") WHERE id = ?', [LINK.id]);

  // Baja
  r = await post(`${ADM}/${LINK.id}/baja`);
  check('la oficina lo da de baja', r.ok, String(r.status));
  r = await fetch(PUB(LINK.codigo));
  check('dado de baja: 410', r.status === 410, String(r.status));
  r = await post(`${ADM}/${LINK.id}/baja`);
  check('darlo de baja dos veces no explota (404)', r.status === 404, String(r.status));

  console.log('\n5. El link sin cliente (gente que todavía no es cliente)\n');

  r = await post(ADM, { nombre: 'Consulta de la feria', couriers: 'dhl', profit_pct: 80, dias: 15 });
  j = await r.json();
  check('se arma con nombre y profit propio', r.status === 201, `${r.status} ${JSON.stringify(j)}`);
  const SIN = j;
  r = await post(ADM, { nombre: 'Sin margen' });
  check('sin cliente y sin profit_pct da 400', r.status === 400, String(r.status));

  r = await post(PUB(SIN.codigo) + '/cotizar', { pais: 'Brasil', tipo: 'export', bultos: CAJAS }, false);
  j = await r.json();
  check('cotiza con el profit del link', r.ok && j.opciones.length === 1, JSON.stringify(j).slice(0, 100));
  const riSin = await post(`${BASE}/api/liquidaciones/cotizar`, {
    servicio: 'DHL', tipo: 'export', pais: 'Brasil',
    pesoFacturable: j.peso_facturable, fob: 0, profitPct: 80, profitManual: true,
    bultos: CAJAS.map((c) => ({ peso_real: c.pr, largo: c.l, ancho: c.a, alto: c.al })),
    contenido: 'paquete',
  });
  const internaSin = await riSin.json();
  check('y da el mismo número que la oficina cotizando al 80%',
    riSin.ok && Math.abs(internaSin.precioFinal - j.opciones[0].total) < 0.01,
    `link ${j.opciones[0].total} vs oficina ${internaSin.precioFinal}`);

  // La lista de la oficina
  r = await fetch(`${ADM}/cliente/${cli.id}`, { headers: H() });
  j = await r.json();
  // Dos: el original y el "a secas" de la sección 2-ter (el sin cliente no aparece acá).
  check('la lista del cliente muestra sus links', Array.isArray(j) && j.length === 2, String((j || []).length));
  check('y el contador de consultas quedó registrado', j[0].consultas >= 1, String(j[0].consultas));

  // `db.close()` de sqlite3 NO es sincronico: encola el cierre en un hilo del pool y avisa
  // por un handle async de libuv. Si el proceso arranca a salir antes de que ese aviso
  // llegue, el hilo termina llamando uv_async_send sobre un handle que YA se esta cerrando
  // y en Windows eso revienta con:
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
  // No falla ningun test: se muere Node y corta la cadena del `npm test` a la mitad. En
  // Linux la carrera casi siempre sale bien y por eso no se veia. Esperar el callback del
  // close es la sincronizacion que faltaba.
  await new Promise((res) => db.close(() => res()));
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await cerrar(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
