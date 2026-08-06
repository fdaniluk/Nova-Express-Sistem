#!/usr/bin/env node
/**
 * test-zona-entrega.js — área extendida y área remota, de punta a punta.
 *
 * UPS tiene DOS cargos de zona distintos y el sistema tenía un solo casillero:
 *   Área extendida → 42.15 o 0.92/kg, el mayor
 *   Área remota    → 5.86 por envío a EE.UU. · al resto, la de extendida
 *
 * Lo que MÁS importa acá es la compatibilidad: todo lo que ya estaba marcado "remota"
 * venía pagando la tarifa de extendida, así que ningún envío cargado puede cambiar de
 * precio al recalcularlo.
 *
 *   cd backend && npm run test-zona-entrega
 */

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
// Arranque común: base de test fresca (copia de producción) y sesión válida.
// Ver scripts/_base-test.js para por qué hace falta.
const { prepararDb, abrirSesion } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3995;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_zona_entrega.db';
const TOKEN = 'token-test-zona-entrega';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const cerca = (a, b) => Math.abs(a - b) <= 0.02;
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

  // ── 1. La columna existe ──────────────────────────────────────────────────
  console.log('\n1. La migración corrió sola\n');
  const cols = (await q('PRAGMA table_info(envios)')).map((c) => c.name);
  check('la columna `entrega` está en envios', cols.includes('entrega'), cols.join(','));

  // ── 2. Compatibilidad: lo ya cargado no cambia de precio ──────────────────
  console.log('\n2. Los envíos viejos no cambian de precio\n');

  // se simula un envío "viejo": remota = 1 y entrega en NULL, como quedaron los cargados
  const marca = 'TZE' + String(process.pid).slice(-5);
  const base = {
    cliente_id: cli.id, fecha: '2026-07-29', tipo_envio: 'exportacion',
    pais_destino: 'ESTADOS UNIDOS', peso_real: 20, courier: 'DHL', tipo_paquete: 'm',
    largo: 40, ancho: 30, alto: 30,
  };
  let r = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
    body: JSON.stringify({ ...base, numero_guia: marca + 'V', remota: 1 }) });
  const viejo = await r.json();
  check('alta de un envío "viejo" (remota=1, sin entrega)', r.status === 201,
    JSON.stringify(viejo).slice(0, 140));
  await q('UPDATE envios SET entrega = NULL WHERE id = ?', [viejo.id]);

  const salidas = async () => (await (await fetch(BASE + '/api/salidas', { headers: H() })).json());
  const buscar = (l, id) => (Array.isArray(l) ? l : l.envios || l.data || []).find((e) => e.id === id);

  let fila = buscar(await salidas(), viejo.id);
  check('Salidas lo muestra como "extendida", que es lo que venía pagando',
    fila && fila.entrega === 'extendida', fila ? String(fila.entrega) : 'no se encontró');

  const recalc = async (id, body) => {
    const res = await fetch(`${BASE}/api/salidas/${id}/recalcular`, { method: 'POST', headers: H(),
      body: JSON.stringify(body) });
    return res.json().catch(() => ({}));
  };
  // recalcular sin mandar `entrega` (lo que haría una pantalla vieja) no puede cambiar nada
  const rSinEntrega = await recalc(viejo.id, { remota: 1 });
  const extraDe = (res, re) => (res.extras || []).find((x) => re.test(x.label || x[0] || ''));
  const zonaSin = extraDe(rSinEntrega, /remota|extendida/i);
  check('recalcularlo sin mandar la zona sigue cobrando 42.15/40 y no 5.86',
    zonaSin && cerca(zonaSin.monto ?? zonaSin[1], 40),
    zonaSin ? JSON.stringify(zonaSin) : JSON.stringify(rSinEntrega).slice(0, 160));

  // ── 3. Los tres valores, de punta a punta ─────────────────────────────────
  console.log('\n3. Normal, extendida y remota\n');

  const altaCon = async (sufijo, entrega, courier = 'UPS') => {
    const res = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
      body: JSON.stringify({ ...base, courier, numero_guia: marca + sufijo, entrega,
        remota: entrega !== 'normal' ? 1 : 0, servicio_ups: courier === 'UPS' ? 'EXP' : null }) });
    return res.json();
  };

  for (const [suf, entrega] of [['N', 'normal'], ['E', 'extendida'], ['R', 'remota']]) {
    const e = await altaCon(suf, entrega, 'DHL');
    const f = buscar(await salidas(), e.id);
    check(`un envío cargado como "${entrega}" se guarda y se lee igual`,
      f && f.entrega === entrega, f ? String(f.entrega) : 'no se encontró');
  }

  // ── 4. El monto correcto en el recálculo ──────────────────────────────────
  console.log('\n4. Lo que cobra cada una\n');

  const dhl = await altaCon('D', 'normal', 'DHL');
  const casos = [
    ['normal',    null],
    ['extendida', 40],     // DHL: 40 o 0.80/kg — con 20 kg gana el mínimo
    ['remota',    40],     // DHL tiene un solo cargo de zona
  ];
  for (const [entrega, esperado] of casos) {
    const res = await recalc(dhl.id, { entrega, remota: entrega !== 'normal' ? 1 : 0 });
    const z = extraDe(res, /remota|extendida/i);
    if (esperado === null) {
      check(`DHL ${entrega}: no cobra recargo de zona`, !z, z ? JSON.stringify(z) : '');
    } else {
      check(`DHL ${entrega}: cobra ${esperado}`, z && cerca(z.monto ?? z[1], esperado),
        z ? JSON.stringify(z) : 'no cobró nada');
    }
  }

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
