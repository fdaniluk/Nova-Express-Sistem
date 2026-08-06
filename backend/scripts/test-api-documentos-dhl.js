#!/usr/bin/env node
/**
 * test-api-documentos-dhl.js — prueba la regla "documentos solo por DHL" contra la API.
 *
 * La pantalla ya la bloquea, pero la pantalla se puede saltear (pestaña vieja en cache,
 * llamada directa). Esto verifica el freno del backend en los tres caminos que escriben:
 *   POST  /api/envios          (alta desde Cargar envío)
 *   PUT   /api/envios/:id      (edición desde Cargar envío)
 *   PATCH /api/salidas/:id     (edición desde Salidas)
 *
 *   cd backend && node scripts/test-api-documentos-dhl.js
 */

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
// Arranque común: base de test fresca (copia de producción) y sesión válida.
// Ver scripts/_base-test.js para por qué hace falta.
const { prepararDb, abrirSesion } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3992;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_api_doc.db';
const TOKEN = 'token-test-api-documentos';

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

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await esperar(300);
  }

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) =>
    db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await abrirSesion(DB, TOKEN);
  const [cli] = await q('SELECT id FROM clientes ORDER BY id LIMIT 1');

  const marca = 'TDOC' + String(process.pid).slice(-5);
  const base = {
    cliente_id: cli.id, fecha: '2026-07-28', tipo_envio: 'exportacion',
    pais_destino: 'ESTADOS UNIDOS', peso_real: 0.5,
  };

  console.log('\n1. POST /api/envios — alta\n');

  let r = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
    body: JSON.stringify({ ...base, numero_guia: marca + 'A', courier: 'UPS', tipo_paquete: 'd' }) });
  let j = await r.json().catch(() => ({}));
  check('rechaza documento + UPS con 400', r.status === 400, `${r.status} ${JSON.stringify(j)}`);
  check('el mensaje explica la regla', /documento/i.test(j.error || ''), j.error);

  r = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
    body: JSON.stringify({ ...base, numero_guia: marca + 'B', courier: 'DHL', tipo_paquete: 'd' }) });
  const envioDoc = await r.json().catch(() => ({}));
  check('acepta documento + DHL', r.status === 201, `${r.status} ${JSON.stringify(envioDoc)}`);

  r = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
    body: JSON.stringify({ ...base, numero_guia: marca + 'C', courier: 'UPS', tipo_paquete: 'm' }) });
  const envioMerc = await r.json().catch(() => ({}));
  check('acepta mercadería + UPS', r.status === 201, `${r.status} ${JSON.stringify(envioMerc)}`);

  console.log('\n2. PUT /api/envios/:id — edición\n');

  // el documento que ya existe en DHL: intentar pasarlo a UPS sin tocar tipo_paquete
  r = await fetch(`${BASE}/api/envios/${envioDoc.id}`, { method: 'PUT', headers: H(),
    body: JSON.stringify({ courier: 'UPS' }) });
  j = await r.json().catch(() => ({}));
  check('rechaza cambiar a UPS un envío que ya es documento', r.status === 400,
    `${r.status} ${JSON.stringify(j)}`);

  // el paquete que está en UPS: intentar marcarlo como documento sin tocar courier
  r = await fetch(`${BASE}/api/envios/${envioMerc.id}`, { method: 'PUT', headers: H(),
    body: JSON.stringify({ tipo_paquete: 'd' }) });
  j = await r.json().catch(() => ({}));
  check('rechaza marcar como documento un envío que está en UPS', r.status === 400,
    `${r.status} ${JSON.stringify(j)}`);

  // cambio válido: pasar el de UPS a DHL + documento en una sola operación
  r = await fetch(`${BASE}/api/envios/${envioMerc.id}`, { method: 'PUT', headers: H(),
    body: JSON.stringify({ tipo_paquete: 'd', courier: 'DHL' }) });
  check('acepta pasar a documento + DHL en la misma edición', r.ok,
    `${r.status} ${JSON.stringify(await r.json().catch(() => ({})))}`);

  console.log('\n3. PATCH /api/salidas/:id — edición desde Salidas\n');

  r = await fetch(`${BASE}/api/salidas/${envioDoc.id}`, { method: 'PATCH', headers: H(),
    body: JSON.stringify({ courier: 'UPS' }) });
  j = await r.json().catch(() => ({}));
  check('rechaza pasar a UPS un documento', r.status === 400, `${r.status} ${JSON.stringify(j)}`);

  r = await fetch(`${BASE}/api/salidas/${envioDoc.id}`, { method: 'PATCH', headers: H(),
    body: JSON.stringify({ observaciones: 'prueba regla documentos' }) });
  check('deja editar otros campos del documento', r.ok,
    `${r.status} ${JSON.stringify(await r.json().catch(() => ({})))}`);

  // mercadería + UPS sigue siendo editable con normalidad
  r = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
    body: JSON.stringify({ ...base, numero_guia: marca + 'D', courier: 'UPS', tipo_paquete: 'm' }) });
  const otro = await r.json().catch(() => ({}));
  r = await fetch(`${BASE}/api/salidas/${otro.id}`, { method: 'PATCH', headers: H(),
    body: JSON.stringify({ courier: 'DHL' }) });
  check('no molesta a la mercadería (UPS → DHL sigue permitido)', r.ok,
    `${r.status} ${JSON.stringify(await r.json().catch(() => ({})))}`);

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
