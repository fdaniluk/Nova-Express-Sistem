#!/usr/bin/env node
/**
 * test-proteccion-doc.js — Protección de Documentos de DHL, USD 7,50 por envío.
 *
 * EL CARGO
 * Está en el tarifario de DHL Express Argentina, hoja "Servicios y cargos públicos":
 * "PROTECCIÓN DE DOCUMENTOS — 7.50 USD — precio por envío — todos los productos". Es un
 * servicio OPCIONAL ("si va a enviar documentos valiosos, pasaportes, solicitudes para visas
 * o certificados legales"), por eso se pide con una tilde y no sale solo.
 *
 * Felipe, 04/08: "hay unos seguros para los documentos de DHL, que son siete dólares y
 * piquito, que eso tampoco sale por defecto en las liquidaciones".
 *
 * Lo que hay que probar, en orden de riesgo:
 *
 *  1. Que NO se haya roto nada: sin la tilde, todo cotiza exactamente igual que antes.
 *  2. Que sume 7,50 exactos, ni un centavo más — sin fuel y sin margen encima, como el DDP.
 *  3. Que sea SOLO de DHL: en UPS la tilde no cobra nada.
 *  4. Que se guarde en el envío y sobreviva a una edición (el bug clásico de esta pantalla:
 *     el primer "Recalcular" borra el cargo en silencio).
 *  5. Que llegue a la liquidación, que es de donde Felipe dijo que faltaba.
 *
 *   cd backend && npm run test-proteccion-doc
 */

const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3993;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_proteccion_doc.db';
const TOKEN = 'token-test-proteccion-doc';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const H = () => ({ 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` });
const cerca = (a, b, tol = 0.005) => Math.abs(Number(a) - Number(b)) <= tol;

const core = require('../../shared/cotizador/cotizador-core.js');
const { cotizarServicio, DHL_PROTECCION_DOC } = core;

async function main() {
  console.log('\n1. Sin la tilde no cambia nada, y el precio es el del tarifario\n');

  check('el cargo del tarifario es USD 7,50', DHL_PROTECCION_DOC === 7.50, String(DHL_PROTECCION_DOC));

  const base = {
    pais: 'Estados Unidos', tipo: 'export', pf: 1, fob: 500,
    fuelPct: 35.25, profitPct: 100,
    bultosProc: [{ dims: [20, 15, 2], pr: 1, pf: 1 }],
    contenido: 'documento',
  };
  const sin = cotizarServicio('DHL', base);
  const conFalse = cotizarServicio('DHL', { ...base, proteccionDoc: false });
  check('sin el parámetro y con el parámetro en false da lo mismo',
    cerca(sin.total, conFalse.total));
  check('no aparece en el desglose', !sin.extras.some((e) => /Protección de documentos/.test(e[0])));

  console.log('\n2. Con la tilde suma 7,50 exactos\n');

  const con = cotizarServicio('DHL', { ...base, proteccionDoc: true });
  check('la diferencia es exactamente 7,50', cerca(con.total - sin.total, 7.50),
    `dif ${(con.total - sin.total).toFixed(4)}`);
  check('aparece en el desglose con su nombre',
    con.extras.some((e) => e[0] === 'Protección de documentos (DHL)' && e[1] === 7.50),
    JSON.stringify(con.extras));
  check('el flete no se mueve', cerca(sin.flete, con.flete));
  check('el fuel NO se cobra sobre los 7,50', cerca(sin.fuelMonto, con.fuelMonto),
    `sin ${sin.fuelMonto} con ${con.fuelMonto}`);
  check('el margen NO se cobra sobre los 7,50', cerca(sin.conGan, con.conGan));

  // Con 100% de ganancia y 35,25% de fuel, si entrara antes del margen el cliente pagaría
  // 7,50 × 2 × 1,3525 = 20,29. Tiene que pagar 7,50 y nada más.
  check('el cliente paga 7,50, no 20,29 (no entra antes del margen ni del fuel)',
    cerca(con.total - sin.total, 7.50));

  console.log('\n3. Es solo de DHL\n');

  const upsSin = cotizarServicio('UPS_EXP', base);
  const upsCon = cotizarServicio('UPS_EXP', { ...base, proteccionDoc: true });
  check('en UPS la tilde no cobra nada', cerca(upsSin.total, upsCon.total),
    `sin ${upsSin.total} con ${upsCon.total}`);
  check('y no aparece en el desglose de UPS',
    !upsCon.extras.some((e) => /Protección de documentos/.test(e[0])));

  console.log('\n4. Se guarda en el envío y sobrevive a las ediciones\n');

  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
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
  await abrirSesion(DB, TOKEN);

  const post = async (u, b) => (await fetch(BASE + u, { method: 'POST', headers: H(), body: JSON.stringify(b) })).json();
  const put = async (u, b) => (await fetch(BASE + u, { method: 'PUT', headers: H(), body: JSON.stringify(b) })).json();

  const cli = await post('/api/clientes', { nombre: 'DOCS TEST', tarifa_pct: 80 });
  const envBase = {
    cliente_id: cli.id, fecha: '2026-08-04', courier: 'DHL', tipo_envio: 'exportacion',
    pais_destino: 'Estados Unidos', tipo_paquete: 'd', peso_real: 1,
    largo: 20, ancho: 15, alto: 2,
  };
  const eSin = await post('/api/envios', { ...envBase, numero_guia: '9900000011' });
  const eCon = await post('/api/envios', { ...envBase, numero_guia: '9900000029', proteccion_doc: 1 });

  check('el envío guarda la tilde', Number(eCon.proteccion_doc) === 1, String(eCon.proteccion_doc));
  check('el envío sin la tilde queda en 0', !Number(eSin.proteccion_doc));
  check('el costo congelado del envío incluye los 7,50',
    cerca(Number(eCon.adicionales) - Number(eSin.adicionales), 7.50),
    `con ${eCon.adicionales} sin ${eSin.adicionales}`);
  check('aparece en el desglose guardado del envío',
    /Protecci/.test(String(eCon.extras_json || '')), String(eCon.extras_json || '').slice(0, 120));

  // El bug clásico de esta pantalla: editar algo que recalcula y perder el cargo.
  const editado = await put(`/api/envios/${eCon.id}`, { peso_real: 1.5 });
  check('editar el peso NO borra la protección', Number(editado.proteccion_doc) === 1);
  check('y el cargo sigue en el costo recalculado',
    /Protecci/.test(String(editado.extras_json || '')), String(editado.extras_json || '').slice(0, 120));

  // Y el recálculo desde Salidas, que arma su propio body.
  const recalc = await (await fetch(`${BASE}/api/salidas/${eCon.id}/recalcular`, {
    method: 'POST', headers: H(), body: JSON.stringify({ peso_real: 1.5, largo: 20, ancho: 15, alto: 2 }),
  })).json();
  check('el "Recalcular" de Salidas tampoco lo borra',
    (recalc.extras || []).some((x) => /Protecci/.test(x.label || '')),
    JSON.stringify(recalc.extras).slice(0, 160));

  // Se puede sacar a mano.
  const sacado = await put(`/api/envios/${eCon.id}`, { proteccion_doc: 0 });
  check('se puede destildar', !Number(sacado.proteccion_doc));
  check('y el cargo desaparece del costo',
    !/Protecci/.test(String(sacado.extras_json || '')));

  console.log('\n5. Llega a la liquidación\n');

  const cot = await post('/api/liquidaciones/cotizar', {
    pais: 'Estados Unidos', tipo: 'export', servicio: 'DHL',
    pesoFacturable: 1, fob: 500, fuelPct: 35.25, profitPct: 80,
    bultos: [{ peso_real: 1, largo: 20, ancho: 15, alto: 2 }],
    contenido: 'documento', proteccionDoc: true, profitManual: true,
  });
  const cotSin = await post('/api/liquidaciones/cotizar', {
    pais: 'Estados Unidos', tipo: 'export', servicio: 'DHL',
    pesoFacturable: 1, fob: 500, fuelPct: 35.25, profitPct: 80,
    bultos: [{ peso_real: 1, largo: 20, ancho: 15, alto: 2 }],
    contenido: 'documento', profitManual: true,
  });
  check('el endpoint que usan las tres pantallas lo cobra',
    cerca(Number(cot.precioFinal) - Number(cotSin.precioFinal), 7.50),
    `dif ${(Number(cot.precioFinal) - Number(cotSin.precioFinal)).toFixed(4)}`);
  check('la utilidad NO sube: el cargo pasa a costo, sin margen',
    cerca(cot.utilidad, cotSin.utilidad), `con ${cot.utilidad} sin ${cotSin.utilidad}`);

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  matarSrv();
  await esperarSrvMuerto();
  // Ni siquiera acá se llama process.exit(): matar el proceso a mano es lo que venía
  // reventando en Windows. Se deja el código de salida y Node termina solo cuando no le
  // queda nada pendiente, que es cuando ya no hay ningún handle a medio cerrar.
  // El timer es la red de seguridad por si algo quedara vivo (sockets keep-alive de
  // fetch, por ejemplo): va con .unref(), así NO sostiene el proceso —si no hay nada
  // más, Node sale igual al instante— y solo actúa si a los 3 s todavía sigue en pie.
  process.exitCode = (fail > 0 ? 1 : 0);
  setTimeout(() => process.exit((fail > 0 ? 1 : 0)), 3000).unref();
}

main().catch((e) => { console.error(e); process.exit(1); });
