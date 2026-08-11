#!/usr/bin/env node
/**
 * test-editar-envio.js — editar un envío tiene que recalcular su costo.
 *
 * El bug: al editar desde "Cargar envío" se actualizaban peso, país y courier, pero las
 * columnas de costo quedaban con el número del alta. Un envío que pasaba de 5 a 50 kg
 * conservaba el costo de 5 kg y su utilidad era fantasía. Además tipo_paquete, asegurado,
 * ddp y la zona de entrega ni se guardaban: tildarlos no hacía nada.
 *
 * Lo que también se prueba acá es el otro lado: una edición que NO mueve el precio
 * (una observación, el número de guía) NO puede recotizar, porque el costo quedó
 * congelado con la tarifa y el fuel del día del alta.
 *
 *   cd backend && npm run test-editar-envio
 */

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
// Arranque común: base de test fresca (copia de producción) y sesión válida.
// Ver scripts/_base-test.js para por qué hace falta.
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3996;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_editar_envio.db';
const TOKEN = 'token-test-editar-envio';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const H = () => ({ 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` });
const r2 = (n) => Math.round(Number(n) * 100) / 100;

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

  const marca = 'TED' + String(process.pid).slice(-5);
  const base = {
    cliente_id: cli.id, fecha: '2026-07-29', tipo_envio: 'exportacion',
    pais_destino: 'BRASIL', courier: 'DHL', tipo_paquete: 'm',
    largo: 30, ancho: 20, alto: 20, total_cobrado: 300,
  };
  const leer = async (id) => (await q('SELECT * FROM envios WHERE id = ?', [id]))[0];

  const alta = async (sufijo, extra = {}) => {
    const res = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
      body: JSON.stringify({ ...base, numero_guia: marca + sufijo, peso_real: 5, ...extra }) });
    return res.json();
  };
  const editar = async (id, body) => {
    const res = await fetch(`${BASE}/api/envios/${id}`, { method: 'PUT', headers: H(),
      body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  // ── 1. Cambiar el peso recalcula ────────────────────────────────────────────
  console.log('\n1. Cambiar el peso recalcula el costo\n');

  const e1 = await alta('A');
  const antes = await leer(e1.id);
  check('el alta congela un costo', antes.flete > 0, `flete=${antes.flete}`);

  const res1 = await editar(e1.id, { peso_real: 50 });
  check('la edición responde OK', res1.status === 200, `${res1.status}`);
  const desp = await leer(e1.id);
  check('el peso facturable se actualizó', desp.peso_facturable === 50,
    `${antes.peso_facturable} → ${desp.peso_facturable}`);
  check('el flete SUBIÓ (antes quedaba con el de 5 kg)', desp.flete > antes.flete,
    `${antes.flete} → ${desp.flete}`);
  console.log(`\n   5 kg → 50 kg · flete ${antes.flete} → ${desp.flete}\n`);

  // ── 2. Una edición inocua NO recotiza ───────────────────────────────────────
  console.log('2. Editar una observación NO toca el costo\n');

  const e2 = await alta('B');
  const a2 = await leer(e2.id);
  await editar(e2.id, { observaciones: 'una nota cualquiera' });
  const d2 = await leer(e2.id);
  check('el flete quedó igual', r2(d2.flete) === r2(a2.flete), `${a2.flete} → ${d2.flete}`);
  check('el fuel quedó igual', r2(d2.fuel) === r2(a2.fuel), `${a2.fuel} → ${d2.fuel}`);
  check('la observación sí se guardó', d2.observaciones === 'una nota cualquiera');

  // ── 3. Los flags que antes se perdían ───────────────────────────────────────
  console.log('\n3. Los campos que la edición ignoraba\n');

  const e3 = await alta('C');
  await editar(e3.id, { ddp: 1 });
  let d3 = await leer(e3.id);
  check('el DDP se guarda al editar', Number(d3.ddp) === 1, `ddp=${d3.ddp}`);
  const conDdp = d3.adicionales;

  await editar(e3.id, { ddp: 0 });
  d3 = await leer(e3.id);
  check('y sacarlo baja los adicionales en 24.05',
    r2(conDdp - d3.adicionales) === 24.05, `${conDdp} → ${d3.adicionales}`);

  await editar(e3.id, { asegurado: 1 });
  d3 = await leer(e3.id);
  check('el asegurado se guarda', Number(d3.asegurado) === 1, `asegurado=${d3.asegurado}`);

  await editar(e3.id, { entrega: 'extendida' });
  d3 = await leer(e3.id);
  check('la zona de entrega se guarda', d3.entrega === 'extendida', `entrega=${d3.entrega}`);
  check('y aparece el recargo de zona en los adicionales', d3.adicionales >= 40,
    `adicionales=${d3.adicionales}`);

  // ── 4. Documento: la tarifa correcta al editar ──────────────────────────────
  console.log('\n4. Pasar un envío a documento usa la tarifa de documento\n');

  // ojo: la tarifa de documento de DHL solo rige hasta 2 kg FACTURABLES. Con las medidas
  // de `base` el volumétrico da 2.4 kg y no calificaría, así que va un bulto chico.
  const e4 = await alta('D', { peso_real: 1, largo: 20, ancho: 10, alto: 10 });
  const a4 = await leer(e4.id);
  await editar(e4.id, { tipo_paquete: 'd' });
  const d4 = await leer(e4.id);
  check('el tipo de paquete se guarda', d4.tipo_paquete === 'd', `tipo=${d4.tipo_paquete}`);
  check('el flete BAJA (documento DHL es más barato que mercadería)', d4.flete < a4.flete,
    `${a4.flete} → ${d4.flete}`);

  // ── 5. El fuel congelado no se pisa con el de hoy ───────────────────────────
  console.log('\n5. El envío se recalcula con SU fuel, no con el de hoy\n');

  const e5 = await alta('E', { fuel_pct: 10 });
  const a5 = await leer(e5.id);
  check('el alta congeló fuel 10%', Number(a5.fuel_pct) === 10, `fuel_pct=${a5.fuel_pct}`);
  await editar(e5.id, { peso_real: 8 });
  const d5 = await leer(e5.id);
  check('tras recalcular sigue con el fuel del envío, no el de config',
    Number(d5.fuel_pct) === 10, `fuel_pct=${d5.fuel_pct}`);

  // ── 6. Un envío liquidado sigue trabado ─────────────────────────────────────
  console.log('\n6. Los envíos liquidados siguen protegidos\n');

  const e6 = await alta('F');
  await q('UPDATE envios SET liquidado = 1 WHERE id = ?', [e6.id]);
  const res6 = await editar(e6.id, { peso_real: 99 });
  check('no se puede editar un envío liquidado', res6.status === 400,
    `${res6.status} ${JSON.stringify(res6.json).slice(0, 80)}`);

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
