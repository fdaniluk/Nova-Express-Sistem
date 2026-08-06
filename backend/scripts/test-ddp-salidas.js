#!/usr/bin/env node
/**
 * test-ddp-salidas.js — el checkbox DDP del modal de edición de Salidas.
 *
 * Prueba las dos puntas y, sobre todo, la trampa: `ddp` existía en la tabla pero la consulta
 * de Salidas no lo devolvía. Con el checkbox agregado y sin ese campo, el modal lo mostraba
 * siempre destildado y al guardar BORRABA el DDP de los envíos que sí lo tenían.
 *
 *   cd backend && npm run test-ddp-salidas
 */

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
// Arranque común: base de test fresca (copia de producción) y sesión válida.
// Ver scripts/_base-test.js para por qué hace falta.
const { prepararDb, abrirSesion } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3993;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_ddp_salidas.db';
const TOKEN = 'token-test-ddp-salidas';

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

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await esperar(300);
  }

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await abrirSesion(DB, TOKEN);
  const [cli] = await q('SELECT id FROM clientes ORDER BY id LIMIT 1');

  const marca = 'TDDP' + String(process.pid).slice(-5);
  const base = {
    cliente_id: cli.id, fecha: '2026-07-29', tipo_envio: 'exportacion',
    pais_destino: 'ESTADOS UNIDOS', peso_real: 3, courier: 'UPS', tipo_paquete: 'm',
    largo: 30, ancho: 20, alto: 20,
  };

  console.log('\n1. Alta con DDP y lectura desde Salidas\n');

  let r = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
    body: JSON.stringify({ ...base, numero_guia: marca + 'A', ddp: 1 }) });
  const conDdp = await r.json();
  check('se puede dar de alta un envío con DDP', r.status === 201, JSON.stringify(conDdp).slice(0, 120));

  const salidas = async () => (await (await fetch(BASE + '/api/salidas', { headers: H() })).json());
  const buscar = (lista, id) => (Array.isArray(lista) ? lista : lista.envios || lista.data || []).find((e) => e.id === id);

  let fila = buscar(await salidas(), conDdp.id);
  check('Salidas devuelve el campo ddp', fila && fila.ddp !== undefined,
    fila ? `ddp=${JSON.stringify(fila.ddp)}` : 'no se encontró el envío');
  check('y viene en true para el envío que se cargó con DDP', fila && fila.ddp === true,
    fila ? String(fila.ddp) : '-');

  console.log('\n2. La trampa: guardar sin tocar el DDP no lo tiene que borrar\n');

  // Esto es lo que manda el modal al guardar: incluye ddp con el valor del checkbox.
  // Como ahora el checkbox se precarga con el valor real, mandar 1 lo conserva.
  r = await fetch(`${BASE}/api/salidas/${conDdp.id}`, { method: 'PATCH', headers: H(),
    body: JSON.stringify({ observaciones: 'edicion sin tocar el ddp', ddp: 1 }) });
  check('el PATCH acepta ddp', r.ok, `${r.status}`);
  fila = buscar(await salidas(), conDdp.id);
  check('el DDP sigue en true después de guardar', fila && fila.ddp === true,
    fila ? String(fila.ddp) : '-');

  console.log('\n3. Se puede sacar y volver a poner\n');

  r = await fetch(`${BASE}/api/salidas/${conDdp.id}`, { method: 'PATCH', headers: H(),
    body: JSON.stringify({ ddp: 0 }) });
  fila = buscar(await salidas(), conDdp.id);
  check('destildarlo lo pasa a false', r.ok && fila && fila.ddp === false, fila ? String(fila.ddp) : '-');

  r = await fetch(`${BASE}/api/salidas/${conDdp.id}`, { method: 'PATCH', headers: H(),
    body: JSON.stringify({ ddp: 1 }) });
  fila = buscar(await salidas(), conDdp.id);
  check('volver a tildarlo lo pasa a true', r.ok && fila && fila.ddp === true, fila ? String(fila.ddp) : '-');

  console.log('\n4. El recálculo cobra el DDP\n');

  // Para esta parte va un envío DHL: recalcular uno de UPS exige tener guardado el servicio
  // (Expedited o Saver), y el alta por API no lo pide.
  r = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
    body: JSON.stringify({ ...base, numero_guia: marca + 'B', courier: 'DHL', ddp: 1 }) });
  const envioDHL = await r.json();
  check('alta del envío DHL para el recálculo', r.status === 201, JSON.stringify(envioDHL).slice(0, 120));

  const recalc = async (id, body) => {
    const res = await fetch(`${BASE}/api/salidas/${id}/recalcular`, { method: 'POST', headers: H(),
      body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const conDDP = await recalc(envioDHL.id, { ddp: 1, remota: 0, asegurado: 0 });
  const sinDDP = await recalc(envioDHL.id, { ddp: 0, remota: 0, asegurado: 0 });
  const tot = (x) => Number(x.json?.total ?? x.json?.desglose?.total ?? NaN);
  check('recalcular con DDP cuesta 24.05 más que sin DDP',
    Number.isFinite(tot(conDDP)) && Number.isFinite(tot(sinDDP))
      && Math.abs((tot(conDDP) - tot(sinDDP)) - 24.05) < 0.02,
    `con ${tot(conDDP)} · sin ${tot(sinDDP)} · dif ${(tot(conDDP) - tot(sinDDP)).toFixed(2)}`);

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
