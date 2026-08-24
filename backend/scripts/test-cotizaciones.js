#!/usr/bin/env node
/**
 * test-cotizaciones.js — las cotizaciones guardadas y EL PRECIO ACORDADO, contra la API.
 *
 * POR QUÉ EXISTE (caso Asaplast, 30/07/2026)
 * Se cotizó una caja por 14 kg facturables, el cliente aceptó y pagó ESE precio, la caja
 * llegó y midió 10, y el cotizador automático de Salidas recalculó y guardó el precio de
 * 10 kg. El envío quedó bien cargado —las medidas reales son las que factura el courier—
 * pero la plata registrada dejó de ser la plata cobrada. Hasta ahora el cotizador no
 * persistía una sola cotización: el precio que el cliente ACEPTÓ no existía en ningún lado.
 *
 * LA REGLA QUE CUIDA ESTE TEST, y es la que sostiene todo el módulo:
 * EL PRECIO ACORDADO NO SE TIPEA. Sale de la opción que se guardó cuando se emitió la
 * cotización. Si el total pudiera viajar en el body al aceptar, cualquiera podría fijar
 * un precio distinto del que se le mandó al cliente, que es justo lo que esto viene a
 * evitar. Si el control 2.2 se pone rojo, el módulo entero perdió el sentido.
 *
 * Lo demás, en orden de riesgo:
 *  - una cotización sin opciones válidas no se guarda (el error tiene que salir al
 *    emitirla, no el día que llega la caja);
 *  - no se puede aceptar un servicio que la cotización no tenía;
 *  - las EMITIDAS se vencen solas al pasarse de fecha, pero las ACEPTADAS NO: el cliente
 *    ya pagó ese precio, vencerla sería borrar el acuerdo;
 *  - todo cambio queda en el historial con quién lo hizo;
 *  - una cotización atada a un envío no se puede borrar: es el respaldo de su precio.
 *
 *   cd backend && node scripts/test-cotizaciones.js
 */

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
// Arranque común: base de test fresca (copia de producción) y sesión válida.
// Ver scripts/_base-test.js para por qué hace falta.
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3960;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_cotizaciones.db';
const TOKEN = 'token-test-cotizaciones';

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

  const CTZ = BASE + '/api/cotizaciones';
  const post = (url, body) => fetch(url, { method: 'POST', headers: H(), body: JSON.stringify(body) });
  const patch = (url, body) => fetch(url, { method: 'PATCH', headers: H(), body: JSON.stringify(body) });
  const get = (url) => fetch(url, { headers: H() });

  // Una cotización como la que emite el cotizador: dos opciones, DHL y UPS.
  const base = () => ({
    cliente_id: cli.id,
    cliente_nombre: 'Asaplast',
    pais: 'Brasil',
    tipo_envio: 'exportacion',
    contenido: 'paquete',
    zona: '1',
    peso_facturable: 14,
    cantidad_bultos: 1,
    valor_declarado: 500,
    entrada: { bultos: [{ pr: 4, l: 40, a: 35, al: 25, pv: 14, pf: 14 }], ganancia_pct: 40, fuel_fuente: 'manual' },
    opciones: [
      { servicio: 'DHL', total: 201.04, fuel_pct: 30, costo: 150 },
      { servicio: 'UPS_EXP', total: 188.5, fuel_pct: 28, costo: 140 },
    ],
  });

  console.log('\n1. Guardar la cotización\n');

  let r = await post(CTZ, base());
  let j = await r.json().catch(() => ({}));
  check('se guarda y devuelve 201', r.status === 201, `${r.status} ${JSON.stringify(j)}`);
  check('le pone número propio', Number.isInteger(j.numero) && j.numero >= 1, String(j.numero));
  check('nace en estado "emitida"', j.estado === 'emitida', j.estado);
  check('todavía no tiene precio acordado', j.total_acordado == null, String(j.total_acordado));
  // 15 días, los mismos que muestra la imagen que se le manda al cliente. Si el papel y el
  // sistema dijeran cosas distintas, se contradicen justo el día que el cliente reclama.
  const dias = Math.round((new Date(j.vence_en + 'T00:00:00') - new Date(new Date().toDateString())) / 86400000);
  check('vence por defecto a los 15 días', dias === 15, `${j.vence_en} → ${dias} días`);
  const ctz1 = j.id;

  r = await post(CTZ, { ...base(), opciones: [] });
  check('rechaza una cotización sin opciones', r.status === 400, String(r.status));

  r = await post(CTZ, { ...base(), opciones: [{ servicio: 'DHL', total: 0 }] });
  check('rechaza una opción con total 0', r.status === 400, String(r.status));

  r = await post(CTZ, { ...base(), opciones: [{ servicio: 'DHL', total: 10 }, { servicio: 'DHL', total: 20 }] });
  check('rechaza dos opciones para el mismo servicio', r.status === 400, String(r.status));

  r = await post(CTZ, { ...base(), cliente_id: null, cliente_nombre: '' });
  check('rechaza una cotización sin cliente ni nombre', r.status === 400, String(r.status));

  r = await post(CTZ, { ...base(), cliente_id: null, cliente_nombre: 'Alguien que no es cliente todavía' });
  check('pero SÍ deja cotizar a alguien que no es cliente', r.status === 201, String(r.status));

  console.log('\n2. Aceptarla — EL PRECIO ACORDADO\n');

  r = await post(`${CTZ}/${ctz1}/aceptar`, { servicio: 'NO_EXISTE' });
  check('no se puede aceptar un servicio que la cotización no tenía', r.status === 400, String(r.status));

  /* ⚠️ EL CONTROL QUE SOSTIENE EL MÓDULO. Se manda un total inventado junto al servicio.
     El servidor tiene que ignorarlo por completo y usar el de la opción guardada. Si esto
     se pone rojo, el precio acordado se puede tipear y deja de ser prueba de nada. */
  r = await post(`${CTZ}/${ctz1}/aceptar`, { servicio: 'DHL', total_acordado: 9999, total: 9999 });
  j = await r.json().catch(() => ({}));
  check('acepta la opción DHL', r.ok && j.estado === 'aceptada', `${r.status} ${j.estado}`);
  check('2.2 el total acordado sale de la opción guardada, NO del body',
    j.total_acordado === 201.04, `${j.total_acordado} (se mandó 9999)`);
  check('guarda qué servicio eligió el cliente', j.servicio_aceptado === 'DHL', j.servicio_aceptado);
  check('guarda quién la aceptó', !!j.aceptada_por, String(j.aceptada_por));
  check('y cuándo', !!j.aceptada_en, String(j.aceptada_en));

  r = await get(`${CTZ}/${ctz1}`);
  j = await r.json();
  const acciones = (j.historial || []).map((h) => h.accion);
  check('el historial guarda la emisión y la aceptación',
    acciones.includes('emitida') && acciones.includes('aceptada'), acciones.join(','));

  console.log('\n3. Editar una aceptada (el cliente negoció)\n');

  r = await patch(`${CTZ}/${ctz1}`, { total_acordado: 190 });
  j = await r.json().catch(() => ({}));
  check('se puede corregir el precio acordado', r.ok && j.total_acordado === 190, String(j.total_acordado));
  r = await get(`${CTZ}/${ctz1}`);
  j = await r.json();
  const edicion = (j.historial || []).find((h) => h.accion === 'editada');
  check('el cambio NO pasa en silencio: queda en el historial', !!edicion);
  check('y guarda cuánto decía antes',
    edicion && JSON.parse(edicion.antes).total_acordado === 201.04,
    edicion ? edicion.antes : 'sin registro');

  r = await patch(`${CTZ}/${ctz1}`, { total_acordado: -5 });
  check('no acepta un precio acordado negativo', r.status === 400, String(r.status));

  console.log('\n4. Vencimiento\n');

  // Una EMITIDA que se pasó de fecha tiene que vencerse sola al leerla.
  r = await post(CTZ, base());
  const ctzVieja = (await r.json()).id;
  await q("UPDATE cotizaciones SET vence_en = date('now','localtime','-1 day') WHERE id = ?", [ctzVieja]);
  r = await get(`${CTZ}/${ctzVieja}`);
  j = await r.json();
  check('una cotización emitida y pasada de fecha queda "vencida"', j.estado === 'vencida', j.estado);

  /* Una ACEPTADA no se vence sola aunque pase la fecha: el cliente ya aceptó y pagó ESE
     precio. Vencerla sería borrar el acuerdo, que es el problema que el módulo resuelve. */
  await q("UPDATE cotizaciones SET vence_en = date('now','localtime','-30 day') WHERE id = ?", [ctz1]);
  r = await get(`${CTZ}/${ctz1}`);
  j = await r.json();
  check('una ACEPTADA no se vence sola aunque pase la fecha', j.estado === 'aceptada', j.estado);

  console.log('\n5. Lo que Salidas va a preguntar\n');

  r = await get(`${CTZ}/cliente/${cli.id}/aceptadas`);
  j = await r.json();
  check('lista las aceptadas del cliente que todavía no se usaron',
    Array.isArray(j) && j.some((x) => x.id === ctz1), JSON.stringify((j || []).map((x) => x.id)));

  await q('UPDATE cotizaciones SET envio_id = 1 WHERE id = ?', [ctz1]);
  r = await get(`${CTZ}/cliente/${cli.id}/aceptadas`);
  j = await r.json();
  check('una vez atada a un envío deja de ofrecerse',
    Array.isArray(j) && !j.some((x) => x.id === ctz1), JSON.stringify((j || []).map((x) => x.id)));

  r = await fetch(`${CTZ}/${ctz1}`, { method: 'DELETE', headers: H() });
  check('y ya no se puede borrar: es el respaldo del precio de ese envío',
    r.status === 409, String(r.status));

  console.log('\n6. La lista\n');

  r = await get(`${CTZ}?estado=inventado`);
  check('un estado que no existe da 400 y no una lista vacía', r.status === 400, String(r.status));

  r = await get(`${CTZ}?estado=aceptada`);
  j = await r.json();
  check('filtra por estado', Array.isArray(j) && j.every((x) => x.estado === 'aceptada'),
    JSON.stringify((j || []).map((x) => x.estado)));
  /* La lista no puede llevar el desglose entero: adentro va NUESTRO COSTO y el profit
     aplicado. Se manda solo el resumen de servicios y totales. */
  check('la lista NO devuelve el desglose con nuestro costo',
    Array.isArray(j) && j.every((x) => x.opciones === undefined && x.entrada === undefined));
  check('pero sí un resumen de las opciones',
    Array.isArray(j) && j.every((x) => Array.isArray(x.opciones_resumen)));

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
