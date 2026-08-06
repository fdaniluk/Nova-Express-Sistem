#!/usr/bin/env node
/**
 * test-envio-sin-pesar.js — el circuito de los clientes cuyos envíos no pasan por el depósito.
 *
 * EL CASO (Kasdorf y parecidos)
 * A esos clientes se les manda la guía, ellos la imprimen, la pegan y despachan. El paquete
 * nunca pasa por la oficina, así que el lunes —cuando el envío sale— NO se sabe cuánto pesa.
 * Los pesos y medidas reales llegan el jueves, y recién ahí se completan desde Salidas.
 *
 * Lo que hay que probar, en orden de riesgo:
 *
 *  1. Que se pueda dar de alta un envío SIN peso. Antes `peso_real` era obligatorio.
 *  2. Que sin peso NO se invente un costo. Antes el motor devolvía el flete mínimo de la
 *     tabla (el renglón de 0,5 kg) y ese número quedaba guardado como costo real: entre el
 *     lunes y el jueves esa plata inventada se sumaba en Salidas, el dashboard y la utilidad.
 *  3. Que al cargar los pesos se recalcule el costo entero.
 *  4. Que la VENTA salga del profit ya cargado del cliente, que es lo que no existía: el
 *     cálculo vivía solo en la pantalla de Cargar envío.
 *  5. Que respete la tarifa por kilo y el fuel propio del cliente, porque usa el mismo
 *     resolvedor.
 *  6. Que sacarle los pesos a un envío vuelva a dejar el costo en blanco, en vez de
 *     conservar el del peso anterior.
 *  7. Que NO se haya roto el alta normal, con peso, que es la de todos los días.
 *
 *   cd backend && npm run test-envio-sin-pesar
 */

const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3994;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_envio_sin_pesar.db';
const TOKEN = 'token-test-sin-pesar';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const H = () => ({ 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` });
const cerca = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;

async function main() {
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

  const post = async (url, body) => {
    const r = await fetch(BASE + url, { method: 'POST', headers: H(), body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const put = async (url, body) => {
    const r = await fetch(BASE + url, { method: 'PUT', headers: H(), body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  const cli = (await post('/api/clientes', { nombre: 'KASDORF TEST', tarifa_pct: 75 })).body;

  console.log('\n1. El lunes: alta sin pesos ni medidas\n');

  const alta = await post('/api/envios', {
    cliente_id: cli.id, fecha: '2026-08-03', courier: 'UPS', tipo_envio: 'exportacion',
    numero_guia: '1Z000TEST000000001', pais_destino: 'Estados Unidos',
  });
  check('el alta sin peso ya no da 400', alta.status === 201, `status ${alta.status}`);
  const env = alta.body;
  check('queda con peso facturable 0 (el marcador de "sin pesar")', Number(env.peso_facturable) === 0);

  console.log('\n2. Sin peso no se inventa costo\n');

  check('el flete queda vacío, no en el mínimo de tabla', env.flete === null, `flete=${env.flete}`);
  check('el seguro queda vacío', env.seguro === null, `seguro=${env.seguro}`);
  check('el fuel queda vacío', env.fuel === null, `fuel=${env.fuel}`);
  check('los adicionales quedan vacíos', env.adicionales === null, `adic=${env.adicionales}`);
  check('el desglose de extras queda vacío', !env.extras_json, `extras=${env.extras_json}`);
  check('la venta arranca en 0', Number(env.total_cobrado) === 0);

  console.log('\n3. El jueves: llegan los pesos y se recalcula el costo\n');

  const conPeso = (await put(`/api/envios/${env.id}`, {
    peso_real: 12, bultos: [{ peso_real: 12, largo: 40, ancho: 30, alto: 30 }],
  })).body;
  check('el peso facturable ya no es 0', Number(conPeso.peso_facturable) === 12,
    `pf=${conPeso.peso_facturable}`);
  check('ahora sí hay flete', Number(conPeso.flete) > 0, `flete=${conPeso.flete}`);
  check('ahora sí hay fuel', Number(conPeso.fuel) > 0, `fuel=${conPeso.fuel}`);
  check('el costo es el de 12 kg, no el del mínimo de tabla', Number(conPeso.flete) > 50,
    `flete=${conPeso.flete}`);

  console.log('\n4. La venta sale del profit del cliente\n');

  const cot = (await post('/api/liquidaciones/cotizar', {
    pais: 'Estados Unidos', tipo: 'export', servicio: 'UPS_EXP',
    pesoFacturable: Number(conPeso.peso_facturable), fob: 0,
    fuelPct: Number(conPeso.fuel_pct), profitPct: 0,
    bultos: [{ peso_real: 12, largo: 40, ancho: 30, alto: 30 }],
    cliente_id: cli.id, profitManual: false,
  })).body;
  check('el backend resuelve el 75% del cliente, no el 0 que se mandó',
    Number(cot.profit_aplicado) === 75, `aplicado=${cot.profit_aplicado}`);
  check('dice de dónde salió el profit', !!cot.profit_origen, JSON.stringify(cot.profit_origen));
  check('el precio de venta es mayor que el costo',
    Number(cot.precioFinal) > Number(cot.precioBase),
    `venta=${cot.precioFinal} costo=${cot.precioBase}`);
  check('venta = costo + profit', cerca(cot.precioFinal, Number(cot.precioBase) + Number(cot.profitMonto)));

  // Aplicar esa venta es lo que hace el botón: escribe el total y deriva la utilidad.
  const conVenta = (await put(`/api/envios/${env.id}`, {
    total_cobrado: Number(cot.precioFinal).toFixed(2),
  })).body;
  check('la venta queda guardada en el envío',
    cerca(conVenta.total_cobrado, cot.precioFinal), `total=${conVenta.total_cobrado}`);
  check('y no movió el costo que ya estaba', cerca(conVenta.flete, conPeso.flete));

  console.log('\n5. Respeta la tarifa por kilo y el fuel propio\n');

  const cli2 = (await post('/api/clientes', { nombre: 'KASDORF POR KILO', tarifa_pct: 40 })).body;
  await put(`/api/clientes/${cli2.id}`, { ...cli2, modo_tarifa: 'por_kg', fuel_pct_propio: 20 });
  await fetch(`${BASE}/api/clientes/${cli2.id}/tarifa-kg`, {
    method: 'PUT', headers: H(),
    body: JSON.stringify({ servicio: 'UPS_EXP', tipo: 'export', zona: null, peso_min: 0, peso_max: null, precio_kg: 9 }),
  });
  const cotKg = (await post('/api/liquidaciones/cotizar', {
    pais: 'Estados Unidos', tipo: 'export', servicio: 'UPS_EXP',
    pesoFacturable: 12, fob: 0, fuelPct: 35.25, profitPct: 0,
    bultos: [{ peso_real: 12, largo: 40, ancho: 30, alto: 30 }],
    cliente_id: cli2.id, profitManual: false,
  })).body;
  check('usa el modo por kilo del cliente', cotKg.modo_venta === 'por_kg', cotKg.modo_venta);
  check('con el precio por kilo cargado', Number(cotKg.precio_kg_aplicado) === 9);
  check('y pisa el fuel con el propio del cliente',
    Number(cotKg.fuel_aplicado) === 20 && cotKg.fuel_origen === 'cliente',
    `fuel=${cotKg.fuel_aplicado} origen=${cotKg.fuel_origen}`);

  console.log('\n6. Sacarle los pesos vuelve a dejar el costo en blanco\n');

  const sinPeso = (await put(`/api/envios/${env.id}`, { peso_real: 0, bultos: [] })).body;
  check('el peso facturable vuelve a 0', Number(sinPeso.peso_facturable) === 0);
  check('el flete se vacía, no queda el del peso viejo', sinPeso.flete === null, `flete=${sinPeso.flete}`);
  check('el fuel se vacía', sinPeso.fuel === null, `fuel=${sinPeso.fuel}`);
  check('los adicionales se vacían', sinPeso.adicionales === null, `adic=${sinPeso.adicionales}`);

  console.log('\n7. El alta de siempre, con peso, no se tocó\n');

  const normal = (await post('/api/envios', {
    cliente_id: cli.id, fecha: '2026-08-03', courier: 'UPS', tipo_envio: 'exportacion',
    numero_guia: '1Z000TEST000000002', pais_destino: 'Estados Unidos',
    peso_real: 12, bultos: [{ peso_real: 12, largo: 40, ancho: 30, alto: 30 }],
  })).body;
  check('sigue calculando el costo al alta', Number(normal.flete) > 0, `flete=${normal.flete}`);
  check('da exactamente el mismo costo que el que se pesó después',
    cerca(normal.flete, conPeso.flete) && cerca(normal.fuel, conPeso.fuel),
    `alta=${normal.flete}/${normal.fuel} editado=${conPeso.flete}/${conPeso.fuel}`);

  const faltante = await post('/api/envios', {
    cliente_id: cli.id, fecha: '2026-08-03', courier: 'UPS', tipo_envio: 'exportacion',
    pais_destino: 'Estados Unidos', peso_real: 5,
  });
  check('los campos que SÍ son obligatorios siguen siéndolo (guía)',
    faltante.status === 400 && /numero_guia/.test(faltante.body.error || ''),
    JSON.stringify(faltante.body).slice(0, 80));

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
