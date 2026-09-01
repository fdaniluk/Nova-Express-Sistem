#!/usr/bin/env node
/**
 * test-guias-sin-envio.js — la pantalla de guías facturadas sin envío.
 *
 * Cada fila de esa pantalla es una guía que el courier COBRÓ y que no tiene envío en el
 * sistema: o el envío nunca se cargó (y no se le facturó a nadie), o la guía se tipeó mal.
 *
 * La prueba carga la factura de ejemplo contra una base donde faltan envíos a propósito, y
 * verifica que aparezcan. El caso que más importa es el del error de tipeo: se carga un
 * envío con la guía mal escrita y se controla que el sistema sugiera "¿quisiste decir…?".
 *
 *   cd backend && npm run test-guias-sin-envio
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
// Arranque común: base de test fresca (copia de producción) y sesión válida.
// Ver scripts/_base-test.js para por qué hace falta.
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3941;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_sin_envio.db';
const TOKEN = 'token-test-sin-envio';
const PDF = path.join(__dirname, '..', '..', 'facturas-ejemplo', 'factura_test_ups.pdf');

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const H = () => ({ 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` });

async function main() {
  if (!fs.existsSync(PDF)) {
    console.error(`✗ No se encontró la factura de ejemplo: ${PDF}`);
    process.exit(1);
  }

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
  const cerrar = async (c) => {
    matarSrv();
    await esperarSrvMuerto();
    // Ni siquiera acá se llama process.exit(): matar el proceso a mano es lo que venía
    // reventando en Windows. Se deja el código de salida y Node termina solo cuando no le
    // queda nada pendiente, que es cuando ya no hay ningún handle a medio cerrar.
    // El timer es la red de seguridad por si algo quedara vivo (sockets keep-alive de
    // fetch, por ejemplo): va con .unref(), así NO sostiene el proceso —si no hay nada
    // más, Node sale igual al instante— y solo actúa si a los 3 s todavía sigue en pie.
    process.exitCode = c;
    setTimeout(() => process.exit(c), 3000).unref();
  };

  // Antes habia un bucle de 40 intentos contra /api/health que seguia de largo pasara lo
  // que pasara: si el servidor tardaba mas de 12 segundos en arrancar —en Windows, con la
  // base creandose y el antivirus mirando, pasa— el test continuaba igual y reventaba mas
  // adelante con un ECONNREFUSED o un 'no such table' que no tenian nada que ver.
  // Ver scripts/_base-test.js.
  await esperarServidor(srv, BASE, () => logErr, () => logOut);

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await abrirSesion(DB, TOKEN);
  const [cli] = await q('SELECT id FROM clientes ORDER BY id LIMIT 1');

  // Escenario determinista: la factura de ejemplo es REAL, así que varias de sus guías
  // ya existen como envíos en la copia de producción. Se sacan todas para armar el caso
  // desde cero (esto toca una copia en /tmp, nunca la base de verdad).
  await q('DELETE FROM factura_guias');
  await q('DELETE FROM facturas_cargadas');
  const { extraerFacturaUPS } = require('../src/services/factura-ups.service.js');
  const facturaPrevia = await extraerFacturaUPS(fs.readFileSync(PDF));
  for (const g of facturaPrevia.guias) {
    await q('DELETE FROM envio_bultos WHERE envio_id IN (SELECT id FROM envios WHERE numero_guia = ?)', [g.numero_guia]);
    await q('DELETE FROM envios WHERE numero_guia = ?', [g.numero_guia]);
  }

  // ── Escenario ──────────────────────────────────────────────────────────────
  // La factura trae 10 guías. Se cargan DOS envíos:
  //   · uno con la guía bien escrita   → tiene que cruzarse y NO aparecer
  //   · uno con la guía MAL tipeada    → la de la factura queda sin envío, y el sistema
  //     tiene que sugerir este envío como "¿quisiste decir?"
  const BIEN = '1Z327W096790199567';
  const MAL_REAL = '1Z327W096797411680';           // como viene en la factura
  const MAL_CARGADA = '1Z327W096797411689';        // como la tipeó la oficina (último dígito)

  const alta = async (guia) => {
    const res = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
      body: JSON.stringify({
        cliente_id: cli.id, fecha: '2026-05-20', tipo_envio: 'exportacion', courier: 'UPS',
        numero_guia: guia, pais_destino: 'ESTADOS UNIDOS', peso_real: 5,
        largo: 30, ancho: 20, alto: 20, total_cobrado: 200, servicio_ups: 'UPS_EXP',
      }) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const a1 = await alta(BIEN);
  const a2 = await alta(MAL_CARGADA);
  check('se cargaron los dos envíos de prueba', a1.status === 201 && a2.status === 201,
    `${a1.status} ${JSON.stringify(a1.json).slice(0,90)} / ${a2.status} ${JSON.stringify(a2.json).slice(0,90)}`);

  // ── Cargar la factura ──────────────────────────────────────────────────────
  console.log('\n1. Cargar la factura\n');

  const fd = new FormData();
  fd.append('pdf', new Blob([fs.readFileSync(PDF)], { type: 'application/pdf' }), 'factura.pdf');
  fd.append('sobreescribir', 'false');
  const rc = await fetch(BASE + '/api/facturas/cargar', {
    method: 'POST', headers: { Cookie: `nova_session=${TOKEN}` }, body: fd });
  const carga = await rc.json().catch(() => ({}));
  check('la factura se cargó', rc.ok, `${rc.status} ${JSON.stringify(carga).slice(0, 160)}`);
  // el resumen de /cargar llama `guardadas` a las guías que sí encontraron su envío
  check('cruzó el envío con la guía bien escrita', (carga.guardadas ?? 0) >= 1,
    `guardadas=${carga.guardadas} · no encontradas=${carga.no_encontradas}`);
  check('el resto quedó sin envío', (carga.no_encontradas ?? 0) >= 8,
    `no encontradas=${carga.no_encontradas}`);

  // ── La pantalla ────────────────────────────────────────────────────────────
  console.log('\n2. La pantalla las muestra DESPUÉS de cargar (que es lo que faltaba)\n');

  const r = await fetch(BASE + '/api/facturas/sin-envio', { headers: H() });
  const res = await r.json().catch(() => ({}));
  check('el endpoint responde', r.ok, `${r.status}`);
  check('devuelve las guías sin envío', (res.guias || []).length >= 8,
    `${(res.guias || []).length}`);
  check('suma cuánta plata representan', res.costo_total > 0, `${res.costo_total}`);
  console.log(`\n   ${res.total} guías sin envío · USD ${res.costo_total} facturados\n`);

  check('la guía que sí se cruzó NO aparece',
    !(res.guias || []).some((g) => g.numero_guia === BIEN));

  // ── La guía mal tipeada aparece ────────────────────────────────────────────
  console.log('3. La guía mal tipeada queda listada\n');

  const conTypo = (res.guias || []).find((g) => g.numero_guia === MAL_REAL);
  check('la guía que la oficina cargó mal aparece como sin envío', !!conTypo,
    (res.guias || []).map((g) => g.numero_guia).join(', ').slice(0, 120));

  // ── NO se sugiere ningún parecido ──────────────────────────────────────────
  //
  // Se probó y se sacó a pedido de Felipe (29/07): todas las guías de Nova comparten el
  // prefijo y solo cambian los últimos dígitos, así que dos guías LEGÍTIMAS y distintas
  // pueden diferir en un caracter. Sugerir un "parecido" llevaría a corregir un envío que
  // estaba bien. Esta prueba existe para que no vuelva a colarse.
  console.log('\n4. No se sugiere ningún envío parecido\n');

  check('ninguna fila trae una sugerencia de envío',
    (res.guias || []).every((g) => g.posible_envio === undefined),
    JSON.stringify((res.guias || []).find((g) => g.posible_envio) || {}).slice(0, 120));

  const campos = Object.keys((res.guias || [])[0] || {});
  check('la respuesta solo trae los datos de la guía facturada',
    !campos.some((c) => /posible|sugerid|parecid/i.test(c)), campos.join(', '));

  // ── Sobreescribir REEMPLAZA, no duplica ────────────────────────────────────
  //
  // El 28/08 en producción quedaron 26 cargas para 14 facturas: cada "sobreescribir"
  // agregaba una cabecera y un detalle nuevos sin borrar los viejos (L10), y la
  // pestaña Sin envío listaba cada guía una vez por carga. Esta sección fija la
  // regla: volver a cargar la MISMA factura sin sobreescribir es un 409, y con
  // sobreescribir queda UNA sola carga (la última) con su detalle completo.
  console.log('\n5. Sobreescribir reemplaza la carga anterior, no la duplica\n');

  const recargar = async (sobre) => {
    const f = new FormData();
    f.append('pdf', new Blob([fs.readFileSync(PDF)], { type: 'application/pdf' }), 'factura.pdf');
    f.append('sobreescribir', sobre);
    const rr = await fetch(BASE + '/api/facturas/cargar', {
      method: 'POST', headers: { Cookie: `nova_session=${TOKEN}` }, body: f });
    return { status: rr.status, json: await rr.json().catch(() => ({})) };
  };

  const sinPermiso = await recargar('false');
  check('recargar la misma factura sin sobreescribir es un 409', sinPermiso.status === 409,
    `${sinPermiso.status}`);

  const conPermiso = await recargar('true');
  check('con sobreescribir la recarga entra', conPermiso.status === 200,
    `${conPermiso.status} ${JSON.stringify(conPermiso.json).slice(0, 120)}`);

  const cabeceras = await q(
    'SELECT COUNT(*) n FROM facturas_cargadas WHERE numero_factura = ?', ['0020-00074402']);
  check('queda UNA sola cabecera de la factura', cabeceras[0].n === 1, `hay ${cabeceras[0].n}`);

  const detalleFilas = await q(`
    SELECT COUNT(*) n FROM factura_guias fg
    JOIN facturas_cargadas fc ON fc.id = fg.factura_id
    WHERE fc.numero_factura = ?`, ['0020-00074402']);
  check('el detalle queda una sola vez (una fila por guía)',
    detalleFilas[0].n === (conPermiso.json.total_guias ?? 10),
    `${detalleFilas[0].n} filas para ${conPermiso.json.total_guias} guías`);

  const r5 = await fetch(BASE + '/api/facturas/sin-envio', { headers: H() });
  const res5 = await r5.json().catch(() => ({}));
  check('la pestaña Sin envío no muestra duplicados tras recargar',
    res5.total === res.total, `${res5.total} vs ${res.total}`);

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
