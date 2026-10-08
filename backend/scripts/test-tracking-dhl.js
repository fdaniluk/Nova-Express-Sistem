#!/usr/bin/env node
// Semáforo DHL (08/10/2026): dhl.service.js (lectura de la respuesta de MyDHL API y el
// mapeo a rojo/amarillo/verde) y la pasada de tracking-auto con envíos DHL. Todo sin red:
// DHL se reemplaza por un doble (obtenerTrackingDHL inyectado), igual que el test de UPS.
//
//   cd backend && node scripts/test-tracking-dhl.js
const path = require('path');
const { prepararDb } = require('./_base-test');
process.env.DB_PATH = process.env.DB_PATH_TEST || '/tmp/test_tracking_dhl.db';
delete process.env.UPS_CLIENT_ID;
delete process.env.DHL_API_KEY;
prepararDb(process.env.DB_PATH, { desdeProduccion: false });

const { initDb } = require('../src/db');
const { refrescarSemaforo } = require('../src/services/tracking-auto.service');
const dhl = require('../src/services/dhl.service');

let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }

// Respuesta de MyDHL API tal como la documenta DHL (GET /shipments/{n}/tracking).
const respuestaEntregada = {
  shipments: [{
    shipmentTrackingNumber: '5751412866',
    status: 'Success',
    shipmentTimestamp: '2026-09-04T16:10:00',
    productCode: 'P',
    description: 'EXPRESS WORLDWIDE',
    shipperDetails: { name: 'NOVA EXPRESS', postalAddress: { cityName: 'BUENOS AIRES', countryCode: 'AR' } },
    receiverDetails: { name: 'IQ FORMATION GMBH', postalAddress: { cityName: 'HAMBURG', countryCode: 'DE' } },
    totalWeight: 90, unitOfMeasurements: 'metric',
    events: [
      { date: '2026-09-04', time: '16:10:00', typeCode: 'PU', description: 'Shipment picked up', serviceArea: [{ code: 'BUE', description: 'BUENOS AIRES - ARGENTINA' }] },
      { date: '2026-09-05', time: '03:20:00', typeCode: 'PL', description: 'Processed at DHL facility', serviceArea: [{ code: 'BUE', description: 'BUENOS AIRES - ARGENTINA' }] },
      { date: '2026-09-07', time: '09:45:00', typeCode: 'AF', description: 'Arrived at DHL Sort Facility', serviceArea: [{ code: 'LEJ', description: 'LEIPZIG - GERMANY' }] },
      { date: '2026-09-08', time: '11:02:00', typeCode: 'OK', description: 'Delivered', serviceArea: [{ code: 'HAM', description: 'HAMBURG - GERMANY' }], signedBy: 'MUELLER' },
    ],
    numberOfPieces: 2,
    pieces: [
      { number: 1, trackingNumber: 'JD014600009876543210', events: [{ date: '2026-09-08', time: '11:02:00', typeCode: 'OK', description: 'Delivered', serviceArea: [{ code: 'HAM', description: 'HAMBURG - GERMANY' }] }] },
      { number: 2, trackingNumber: 'JD014600009876543227', events: [{ date: '2026-09-07', time: '09:45:00', typeCode: 'AF', description: 'Arrived at DHL Sort Facility', serviceArea: [{ code: 'LEJ', description: 'LEIPZIG - GERMANY' }] }] },
    ],
  }],
};

(async () => {
  console.log('\n1. Lectura de la respuesta de MyDHL\n');
  const t = dhl.normalizarTrackingDHL('5751412866', respuestaEntregada);
  check('estado = último evento ("Delivered", OK) y ubicación del área de servicio', t.estado === 'Delivered' && t.tipo === 'OK' && t.ubicacion === 'HAMBURG - GERMANY', JSON.stringify({ e: t.estado, t: t.tipo, u: t.ubicacion }));
  check('fecha/hora del último evento y firmado por', t.fecha === '2026-09-08' && t.hora === '11:02' && t.firmadoPor === 'MUELLER' && t.fechaEntrega === '2026-09-08');
  check('servicio y peso', /EXPRESS WORLDWIDE/.test(t.servicio) && /90/.test(t.peso), `${t.servicio} ${t.peso}`);
  check('movimientos del más nuevo al más viejo (4)', t.movimientos.length === 4 && t.movimientos[0].tipo === 'OK' && t.movimientos[3].tipo === 'PU');
  check('piezas con su guía y su semáforo: caja 1 verde, caja 2 amarilla', t.paquetes.length === 2 && t.paquetes[0].guia === 'JD014600009876543210' && t.paquetes[0].semaforo === 'verde' && t.paquetes[1].semaforo === 'amarillo', JSON.stringify(t.paquetes));

  console.log('\n2. El mapeo a colores\n');
  check('OK → verde', dhl.semaforoDeEstadoDHL('OK', 'Delivered') === 'verde');
  check('"Entregado" en castellano también → verde', dhl.semaforoDeEstadoDHL('XX', 'Envío entregado') === 'verde');
  check('PU / PL / AF / WC → amarillo', ['PU', 'PL', 'AF', 'WC', 'DF', 'CR'].every((c) => dhl.semaforoDeEstadoDHL(c, 'x') === 'amarillo'));
  check('SD (datos del envío recibidos, nadie lo tocó) → rojo', dhl.semaforoDeEstadoDHL('SD', 'Shipment information received') === 'rojo');
  check('sin nada → null (no tocar)', dhl.semaforoDeEstadoDHL(null, null) === null);
  check('guías DHL: 10 dígitos', dhl.DHL_GUIA_REGEX.test('5751412866') && !dhl.DHL_GUIA_REGEX.test('1Z327W096790199567') && !dhl.DHL_GUIA_REGEX.test('57514128'));
  check('sin credenciales no hay DHL (y el test corre sin red)', dhl.hayCredenciales() === false);
  check('entorno test por defecto', /\/mydhlapi\/test$/.test(dhl.baseUrl()), dhl.baseUrl());
  let err = null;
  try { await dhl.getTrackingDHL('5751412866'); } catch (e) { err = e; }
  check('getTrackingDHL sin .env avisa qué falta, sin tocar la red', err && /DHL_API_KEY/.test(err.message), err && err.message);

  console.log('\n3. La pasada del semáforo con envíos DHL\n');
  const db = await initDb();
  const cli = await db.prepare("INSERT INTO clientes (nombre, tipo_cobro) VALUES ('DHL TRACK TEST', 'D')").run();
  const hoy = new Date().toISOString().slice(0, 10);
  const alta = async (guia, courier = 'DHL', campos = {}) => (await db.prepare(`
    INSERT INTO envios (cliente_id, courier, tipo_envio, fecha, numero_guia, pais_destino, peso_real, no_volo, tracking_estado)
    VALUES (?, ?, 'exportacion', ?, ?, 'Alemania', 5, ?, ?)`).run(cli.lastInsertRowid, courier, campos.fecha ?? hoy, guia, campos.no_volo ?? 0, campos.tracking_estado ?? null)).lastInsertRowid;
  const idEntregada = await alta('5751412866');
  const idTransito = await alta('5534904185');
  const idSinEscanear = await alta('2773265460');
  const idFalla = await alta('9999999999');
  const idMala = await alta('DHL-MAL');
  const idYaVerde = await alta('8729631341', 'DHL', { tracking_estado: 'verde' });
  const idUps = await alta('1Z327W096790199567', 'UPS');
  await db.prepare(`INSERT INTO envio_bultos (envio_id, numero_bulto, largo, ancho, alto, peso_volumetrico, estado_caja, numero_guia)
                    VALUES (?, 1, 10, 10, 10, 0.2, 'rojo', 'JD014600009876543210'), (?, 2, 10, 10, 10, 0.2, NULL, 'JD014600009876543227')`).run(idEntregada, idEntregada);

  const consultadas = [];
  const dhlFalso = async (guia) => {
    consultadas.push(guia);
    if (guia === '5751412866') return dhl.normalizarTrackingDHL(guia, respuestaEntregada);
    if (guia === '5534904185') return { guia, tipo: 'AF', estado: 'Arrived at DHL Sort Facility', ubicacion: 'KUALA LUMPUR - MALAYSIA', paquetes: [] };
    if (guia === '2773265460') return { guia, tipo: 'SD', estado: 'Shipment information received', ubicacion: null, paquetes: [] };
    throw new Error('DHL tracking falló (404): No data found');
  };
  const r = await refrescarSemaforo(db, { obtenerTrackingDHL: dhlFalso, pausaMs: 0 });
  check('consultó las 4 guías DHL con formato (no la mal tipeada, no la ya verde, no la UPS)', r.consultados === 4 && !consultadas.includes('DHL-MAL') && !consultadas.includes('8729631341') && !consultadas.includes('1Z327W096790199567'), JSON.stringify({ r, consultadas }));
  const est = async (id) => db.prepare('SELECT tracking_estado, tracking_detalle, tracking_fecha FROM envios WHERE id = ?').get(id);
  const e1 = await est(idEntregada);
  check('entregada → verde con "Delivered — HAMBURG - GERMANY"', e1.tracking_estado === 'verde' && /Delivered — HAMBURG/.test(e1.tracking_detalle), JSON.stringify(e1));
  const cajas = await db.prepare('SELECT numero_bulto, estado_caja FROM envio_bultos WHERE envio_id = ? ORDER BY numero_bulto').all(idEntregada);
  check('por caja: la 1 verde (pisa el rojo manual) y la 2 amarilla', cajas[0].estado_caja === 'verde' && cajas[1].estado_caja === 'amarillo', JSON.stringify(cajas));
  check('en tránsito → amarillo', (await est(idTransito)).tracking_estado === 'amarillo');
  check('solo datos recibidos → rojo', (await est(idSinEscanear)).tracking_estado === 'rojo');
  const ef = await est(idFalla);
  check('la que falla queda anotada ("Error al rastrear…") sin tocar el estado', ef.tracking_estado == null && /Error al rastrear/.test(ef.tracking_detalle), JSON.stringify(ef));
  const em = await est(idMala);
  check('guía sin formato DHL: omitida y anotada', r.omitidos === 1 && /sin formato DHL/.test(em.tracking_detalle), JSON.stringify(em));
  check('el UPS no se tocó (sin credenciales UPS en este test)', (await est(idUps)).tracking_estado == null);

  // Segunda pasada: la verde es terminal, no se vuelve a preguntar.
  consultadas.length = 0;
  await refrescarSemaforo(db, { obtenerTrackingDHL: dhlFalso, pausaMs: 0 });
  check('segunda pasada: la entregada ya no se consulta (verde es terminal)', !consultadas.includes('5751412866') && consultadas.includes('5534904185'), JSON.stringify(consultadas));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 500).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
