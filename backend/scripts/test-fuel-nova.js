#!/usr/bin/env node
/**
 * test-fuel-nova.js — los TRES fuels: Nova, DHL y UPS.
 *
 * QUÉ ES
 * Hasta el 07/08/2026 el fuel salía del courier: lo que nos cobra UPS o DHL. Felipe pidió
 * un tercero, el **Fuel Nova**, que es el que le cobramos al cliente, y que quien carga el
 * envío pueda elegir cuál se aplica en un desplegable, con Nova por defecto.
 *
 * QUÉ SE PRUEBA, en orden de riesgo:
 *
 *  1. Que cada fuente devuelva SU porcentaje. Elegir "Fuel DHL" y que se aplique el de UPS
 *     es plata mal cobrada, y de la peor clase: el número se ve razonable.
 *  2. Que quede guardado de DÓNDE salió, no solo cuánto. Sin eso, dentro de un mes nadie
 *     puede explicar por qué un envío tiene 27% si Nova estaba en 30%.
 *  3. Que un envío ya cargado NO cambie de fuel al recotizarlo. Un envío de mayo se
 *     recotiza con el fuel de mayo; si no, cambiar el Fuel Nova reescribiría el pasado.
 *  4. Que lo que NO manda fuente siga funcionando igual que antes. Es lo que protege al
 *     importador de Excel y a la edición de envíos viejos.
 *  5. Que no se pueda cargar un fuel absurdo: ese número multiplica el flete de todos los
 *     envíos nuevos.
 *
 *   cd backend && npm run test-fuel-nova
 */

const { spawn } = require('child_process');
const path = require('path');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3965;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_fuel_nova.db';
const TOKEN = 'token-test-fuel-nova';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
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

  const J = async (m, u, b) => {
    const r = await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  console.log('\n1. Los tres fuels se cargan y se leen juntos\n');

  await J('PUT', '/api/configuracion/fuel/UPS', { fuel_pct: 39.5 });
  await J('PUT', '/api/configuracion/fuel/DHL', { fuel_pct: 41 });
  const guardadoNova = await J('PUT', '/api/configuracion/fuel/NOVA', { fuel_pct: 28 });
  check('el Fuel Nova se puede guardar', guardadoNova.status === 200,
    JSON.stringify(guardadoNova.body));

  const lista = (await J('GET', '/api/configuracion/fuel')).body;
  const de = (c) => (lista.find((x) => x.courier === c) || {}).fuel_pct;
  check('la pantalla recibe los TRES', lista.length === 3, JSON.stringify(lista.map((x) => x.courier)));
  check('Nova viene primero (es el predeterminado)', lista[0].courier === 'NOVA');
  check('cada uno con su porcentaje',
    Number(de('NOVA')) === 28 && Number(de('DHL')) === 41 && Number(de('UPS')) === 39.5,
    `nova ${de('NOVA')} · dhl ${de('DHL')} · ups ${de('UPS')}`);

  console.log('\n2. Cada fuente aplica SU porcentaje, y queda registrado\n');

  const cli = (await J('POST', '/api/clientes', { nombre: 'FUEL NOVA TEST', tarifa_pct: 80 })).body;
  let n = 0;
  const alta = async (origen, extra = {}) => (await J('POST', '/api/envios', {
    cliente_id: cli.id, fecha: '2026-08-07', courier: 'UPS', tipo_envio: 'exportacion',
    numero_guia: '1Z000FUELNOVA' + String(++n).padStart(5, '0'),
    pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
    peso_real: 10, largo: 30, ancho: 25, alto: 20, fob: 0, fuel_origen: origen, ...extra,
  })).body;

  const esperados = [['nova', 28], ['dhl', 41], ['ups', 39.5]];
  for (const [origen, pct] of esperados) {
    const e = await alta(origen);
    check(`eligiendo "${origen}" se aplica ${pct}%`, Number(e.fuel_pct) === pct,
      `dio ${e.fuel_pct}`);
    check(`y queda guardado que salió de "${origen}"`, e.fuel_origen === origen,
      String(e.fuel_origen));
  }
  const manual = await alta('manual', { fuel_pct: 12 });
  check('"a mano" respeta el número escrito', Number(manual.fuel_pct) === 12, String(manual.fuel_pct));
  check('y lo registra como manual', manual.fuel_origen === 'manual', String(manual.fuel_origen));

  // Que el porcentaje llegue de verdad a la plata, no solo a la columna.
  const conNova = await alta('nova');
  const conDhl = await alta('dhl');
  check('el fuel elegido cambia el costo de verdad', Number(conDhl.fuel) > Number(conNova.fuel),
    `nova ${conNova.fuel} · dhl ${conDhl.fuel}`);

  console.log('\n3. Un envío ya cargado no cambia de fuel al recotizarlo\n');

  const viejo = await alta('nova');
  await J('PUT', '/api/configuracion/fuel/NOVA', { fuel_pct: 55 });
  const recotizado = (await J('POST', '/api/liquidaciones/cotizar', {
    envio_id: viejo.id, pesoFacturable: 10, profitManual: false,
  })).body;
  check('se recotiza con el fuel que tenía, no con el nuevo de Nova',
    Number(recotizado.fuel_aplicado) === 28, `${recotizado.fuel_aplicado}%`);
  check('y dice que salió del envío', recotizado.fuel_origen === 'nova',
    String(recotizado.fuel_origen));
  await J('PUT', '/api/configuracion/fuel/NOVA', { fuel_pct: 28 });

  console.log('\n4. Lo que NO elige fuente sigue como antes\n');

  const sinFuente = await alta(undefined);
  check('sin elegir nada sigue tomando el del courier (no cambia el importador)',
    Number(sinFuente.fuel_pct) === 39.5, String(sinFuente.fuel_pct));

  const cliPropio = (await J('POST', '/api/clientes', { nombre: 'CON FUEL PROPIO', tarifa_pct: 50 })).body;
  await J('PUT', `/api/clientes/${cliPropio.id}`, { fuel_pct_propio: 12 });
  const delPropio = (await J('POST', '/api/envios', {
    cliente_id: cliPropio.id, fecha: '2026-08-07', courier: 'UPS', tipo_envio: 'exportacion',
    numero_guia: '1Z000FUELPROP0001', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
    peso_real: 10, largo: 30, ancho: 25, alto: 20, fob: 0,
  })).body;
  check('un cliente con fuel negociado lo sigue teniendo si no se elige otro',
    Number(delPropio.fuel_pct) === 12, String(delPropio.fuel_pct));
  // Y lo que pidió Felipe: elegir Nova sobre ese cliente SÍ le aplica Nova (la pantalla
  // avisa, pero la decisión de la persona manda).
  const pisado = (await J('POST', '/api/envios', {
    cliente_id: cliPropio.id, fecha: '2026-08-07', courier: 'UPS', tipo_envio: 'exportacion',
    numero_guia: '1Z000FUELPROP0002', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
    peso_real: 10, largo: 30, ancho: 25, alto: 20, fob: 0, fuel_origen: 'nova',
  })).body;
  check('pero elegir Nova a propósito le aplica Nova', Number(pisado.fuel_pct) === 28,
    String(pisado.fuel_pct));

  console.log('\n5. Un fuel absurdo se rechaza\n');

  check('no acepta negativo', (await J('PUT', '/api/configuracion/fuel/NOVA', { fuel_pct: -5 })).status === 400);
  check('no acepta 500%', (await J('PUT', '/api/configuracion/fuel/NOVA', { fuel_pct: 500 })).status === 400);
  check('no acepta texto', (await J('PUT', '/api/configuracion/fuel/NOVA', { fuel_pct: 'mucho' })).status === 400);
  check('sigue valiendo el último bueno',
    Number((await J('GET', '/api/configuracion/fuel')).body.find((x) => x.courier === 'NOVA').fuel_pct) === 28);
  check('un courier inventado se rechaza',
    (await J('PUT', '/api/configuracion/fuel/FEDEX', { fuel_pct: 10 })).status === 400);

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  matarSrv();
  await esperarSrvMuerto();
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
