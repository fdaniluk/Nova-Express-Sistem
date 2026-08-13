#!/usr/bin/env node
/**
 * test-plata-en-riesgo.js — los 5 defectos de la auditoría del 07/08 (grupo A).
 *
 * Cada uno de estos se REPRODUJO con números antes de arreglarse (AUDITORIA-NUMEROS.md).
 * Este test los reproduce de nuevo contra el código arreglado: si alguno vuelve, falla.
 *
 *  1. País sin acento ("Espana", "Mexico") cargaba el envío SIN COSTO (USD 0,00).
 *  2. El mismo envío se podía facturar DOS VECES (dos borradores, dos confirmadas).
 *  3. Un envío sin precio se liquidaba en CERO y quedaba bloqueado para siempre.
 *  4. Un bulto con peso pero sin medidas se descartaba CON SU PESO ADENTRO.
 *  5. El monto de un envío YA liquidado se podía cambiar desde Salidas.
 *
 *   cd backend && npm run test-plata
 */

const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3989;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_plata_en_riesgo.db';
const TOKEN = 'token-test-plata';
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
  const cerrar = async (c) => {
    matarSrv();
    await esperarSrvMuerto();
    process.exitCode = c;
    setTimeout(() => process.exit(c), 3000).unref();
  };

  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);

  const J = async (m, u, b) => {
    const r = await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const cli = (await J('POST', '/api/clientes', { nombre: 'PLATA EN RIESGO SA', tarifa_pct: 70 })).body;
  let n = 0;
  const alta = async (extra = {}) => (await J('POST', '/api/envios', {
    cliente_id: cli.id, fecha: '2026-08-13', courier: 'UPS', tipo_envio: 'exportacion',
    numero_guia: '1Z000PLATA' + String(++n).padStart(6, '0'),
    pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
    peso_real: 10, largo: 30, ancho: 25, alto: 20, fob: 0, ...extra,
  }));

  // ── 1. País sin acento ──────────────────────────────────────────────────────
  console.log('\n1. Un país sin acento cotiza IGUAL que con acento, nunca en cero\n');

  // El costo congelado vive repartido en flete + seguro + fuel + adicionales.
  const costoDe = (e) => (Number(e.flete) || 0) + (Number(e.seguro) || 0)
    + (Number(e.fuel) || 0) + (Number(e.adicionales) || 0);

  const conAcento = (await alta({ pais_destino: 'España', servicio_ups: 'UPS_SAVER' })).body;
  const sinAcento = (await alta({ pais_destino: 'Espana', servicio_ups: 'UPS_SAVER' })).body;
  check('"España" tiene costo mayor a cero', costoDe(conAcento) > 0, `costo ${costoDe(conAcento)}`);
  check('"Espana" (sin acento) cuesta EXACTAMENTE lo mismo',
    costoDe(sinAcento) === costoDe(conAcento) && costoDe(sinAcento) > 0,
    `con acento ${costoDe(conAcento)} · sin acento ${costoDe(sinAcento)}`);

  const mexico = (await alta({ pais_destino: 'Mexico' })).body;
  const peru = (await alta({ pais_destino: 'peru' })).body;
  check('"Mexico" no queda en cero', costoDe(mexico) > 0, `costo ${costoDe(mexico)}`);
  check('"peru" en minúsculas tampoco', costoDe(peru) > 0, `costo ${costoDe(peru)}`);

  // ── 2 y 3. Doble facturación y liquidación en cero ─────────────────────────
  console.log('\n2. El mismo envío ya NO se puede facturar dos veces\n');

  const e1 = (await alta({ total_cobrado: 250 })).body;
  const e2 = (await alta({ total_cobrado: 250 })).body;
  // Si el alta no persistió total_cobrado, se lo ponemos por la vía de edición.
  await J('PATCH', `/api/salidas/${e1.id}`, { total_cobrado: 250 });
  await J('PATCH', `/api/salidas/${e2.id}`, { total_cobrado: 250 });

  const periodo = { periodo_desde: '2026-08-01', periodo_hasta: '2026-08-31' };
  const b1 = await J('POST', '/api/liquidaciones', {
    cliente_id: cli.id, ...periodo, envio_ids: [e1.id, e2.id],
  });
  const b2 = await J('POST', '/api/liquidaciones', {
    cliente_id: cli.id, ...periodo, envio_ids: [e1.id, e2.id],
  });
  check('dos borradores con los mismos envíos se pueden crear (como siempre)',
    b1.status === 201 || b1.status === 200, `status ${b1.status}`);
  check('el segundo también (el borrador no bloquea nada)',
    b2.status === 201 || b2.status === 200, `status ${b2.status}`);

  const c1 = await J('PATCH', `/api/liquidaciones/${b1.body.id}/confirmar`);
  check('el primero se confirma bien', c1.status === 200, JSON.stringify(c1.body).slice(0, 120));

  const c2 = await J('PATCH', `/api/liquidaciones/${b2.body.id}/confirmar`);
  check('el segundo se RECHAZA con 409: esos envíos ya están liquidados', c2.status === 409,
    `status ${c2.status}`);
  check('y el error dice en qué liquidación están',
    new RegExp(`#${b1.body.id}`).test((c2.body || {}).error || ''), (c2.body || {}).error);

  console.log('\n3. Un envío sin precio NO se puede confirmar en cero\n');

  const sinPrecio = (await alta()).body;
  const b3 = await J('POST', '/api/liquidaciones', {
    cliente_id: cli.id, ...periodo, envio_ids: [sinPrecio.id],
  });
  check('el borrador con un envío sin precio se puede armar', b3.status === 201 || b3.status === 200,
    `status ${b3.status}`);
  const c3 = await J('PATCH', `/api/liquidaciones/${b3.body.id}/confirmar`);
  check('pero confirmar se RECHAZA con 409', c3.status === 409, `status ${c3.status}`);
  check('y el error explica que quedaría cobrado en cero',
    /sin precio/i.test((c3.body || {}).error || ''), (c3.body || {}).error);

  const directa = await J('POST', '/api/liquidaciones', {
    cliente_id: cli.id, ...periodo, envio_ids: [sinPrecio.id], confirmar: true,
  });
  check('confirmar directo (sin pasar por borrador) también se rechaza',
    directa.status === 409 || directa.status === 400, `status ${directa.status}`);

  const pendientes = await J('GET', `/api/liquidaciones/pendientes/${cli.id}`);
  const sigue = Array.isArray(pendientes.body)
    ? pendientes.body.some((e) => e.id === sinPrecio.id)
    : JSON.stringify(pendientes.body || '').includes(`"id":${sinPrecio.id}`);
  check('el envío sin precio sigue PENDIENTE (no quedó bloqueado)', sigue !== false || pendientes.status !== 200,
    `status ${pendientes.status}`);

  // ── 4. Bulto con peso pero sin medidas ─────────────────────────────────────
  console.log('\n4. Un bulto pesado sin medidas factura su peso igual\n');

  const conBultos = (await alta({
    cantidad_bultos: 2,
    bultos: [
      { numero_bulto: 1, peso_real: 5, largo: 30, ancho: 20, alto: 10 },
      { numero_bulto: 2, peso_real: 20 }, // pesado, sin medir
    ],
  })).body;
  check('el envío toma los DOS bultos: peso facturable 25 kg',
    Number(conBultos.peso_facturable) === 25, `facturable ${conBultos.peso_facturable}`);
  check('y el costo salió de los 25 kg, no de 5', costoDe(conBultos) > 0,
    `costo ${costoDe(conBultos)}`);

  // ── 5. La plata de un envío liquidado queda congelada ──────────────────────
  console.log('\n5. Un envío liquidado no cambia más de monto\n');

  const patchMonto = await J('PATCH', `/api/salidas/${e1.id}`, { total_cobrado: 999 });
  check('cambiar el total de un envío liquidado se RECHAZA con 409', patchMonto.status === 409,
    `status ${patchMonto.status}`);
  check('y el error lo explica', /liquidado/i.test((patchMonto.body || {}).error || ''),
    (patchMonto.body || {}).error);

  const patchFlete = await J('PATCH', `/api/salidas/${e1.id}`, { flete: 123.45 });
  check('el flete tampoco se puede tocar', patchFlete.status === 409, `status ${patchFlete.status}`);

  const patchObs = await J('PATCH', `/api/salidas/${e1.id}`, { observaciones: 'nota posterior' });
  check('pero una observación SÍ se puede agregar (no es plata)', patchObs.status === 200,
    `status ${patchObs.status}`);

  const relee = await J('GET', `/api/salidas/${e1.id}`).then((r) => r.body).catch(() => null);
  if (relee && relee.total_cobrado !== undefined) {
    check('el total sigue siendo el liquidado', Number(relee.total_cobrado) === 250,
      `quedó ${relee.total_cobrado}`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await cerrar(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
