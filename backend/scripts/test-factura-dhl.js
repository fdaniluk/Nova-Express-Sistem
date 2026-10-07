#!/usr/bin/env node
// Facturas de DHL Express (07/10/2026): el lector (factura-dhl.service.js) contra las dos
// facturas reales de facturas-ejemplo/dhl/, y de punta a punta por /api/facturas/chequear y
// /cargar: envíos DHL con costo real, flete/fuel por guía, IVA y percepción fuera de los envíos,
// anomalías con los nombres de DHL, sobreescribir, Salud y la pestaña Ingresos Brutos.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const { extraerFacturaDHL, esFacturaDHL } = require('../src/services/factura-dhl.service');
const { detectarAnomalias } = require('../src/utils/anomalias-factura');

const PORT = process.env.PORT_TEST || 3971;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_factura_dhl.db';
const TOKEN = 'token-test-factura-dhl';
const DIR = path.join(__dirname, '..', '..', 'facturas-ejemplo', 'dhl');
const F1 = path.join(DIR, 'DHL-1700A00033061_02102026.pdf');
const F2 = path.join(DIR, 'DHL-1700A00033064_02102026.pdf');

let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const cerca = (a, b, tol = 0.011) => a != null && Math.abs(Number(a) - b) < tol;

(async () => {
  if (!fs.existsSync(F1) || !fs.existsSync(F2)) {
    console.log(`⚠ No están las facturas de ejemplo de DHL en ${DIR} — se saltea.`);
    process.exit(0);
  }

  console.log('\n1. El lector\n');
  const r1 = await extraerFacturaDHL(fs.readFileSync(F1));
  check('es DHL y tipo flete', r1.courier === 'DHL' && r1.tipo === 'flete');
  check('número 1700A00033061 y fecha 30/09/2026', r1.numero_factura === '1700A00033061' && r1.fecha_factura === '30/09/2026', `${r1.numero_factura} ${r1.fecha_factura}`);
  check('6 guías', r1.guias.length === 6, String(r1.guias.length));
  check('subtotal 764.44 = suma de las guías, cuadra', cerca(r1.subtotal_factura, 764.44) && cerca(r1.suma_guias, 764.44) && r1.cuadra === true, JSON.stringify({ s: r1.subtotal_factura, g: r1.suma_guias, c: r1.cuadra }));
  check('total a pagar 802.08 = subtotal + IVA 14.70 + percepción 22.94', cerca(r1.total_declarado, 802.08) && cerca(r1.iva, 14.7) && cerca(r1.percepciones, 22.94), JSON.stringify({ t: r1.total_declarado, iva: r1.iva, p: r1.percepciones }));
  check('tipo de cambio 1545', r1.tipo_cambio === 1545);
  check('conceptos: transporte 466.30 / combustible 159.61 / otros 68.53 + 70 gravado', cerca(r1.conceptos.transporte.exento, 466.3) && cerca(r1.conceptos.combustible.exento, 159.61) && cerca(r1.conceptos.otros.exento, 68.53) && cerca(r1.conceptos.otros.gravado, 70), JSON.stringify(r1.conceptos));
  check('sin avisos de descuadre (solo el de IVA/percepción aparte)', r1.advertencias.every((a) => a.tipo === 'percepcion_aparte'), JSON.stringify(r1.advertencias));
  const g1 = r1.guias.find((g) => g.numero_guia === '2761179293');
  check('guía 2761179293: Alemania, 6.5 kg (W = volumétrico DHL), producto Y', g1 && g1.pais === 'GERMANY' && g1.peso === 6.5 && g1.tipo_peso === 'W' && g1.producto === 'Y', JSON.stringify(g1));
  check('   flete 91.71 + fuel 32.57 = neto 124.28', g1 && cerca(g1.flete_neto, 91.71) && cerca(g1.fuel, 32.57) && cerca(g1.neto, 124.28));
  check('   recargos: 12:00 PREMIUM 7, GoGreen Plus 6.37, VALUE PROTECTION 17.50 → total 155.15', g1 && cerca(g1.costo_total, 155.15) && g1.cargos.length === 3 && g1.cargos.some((c) => c.nombre === 'VALUE PROTECTION' && c.monto === 17.5) && g1.cargos.some((c) => c.nombre === '12:00 PREMIUM' && c.monto === 7), JSON.stringify(g1 && g1.cargos));
  check('   el seguro está marcado como gravado (IVA): 17.50', g1 && cerca(g1.gravado, 17.5));
  const g2 = r1.guias.find((g) => g.numero_guia === '2773265460');
  check('guía 2773265460: referencia en dos líneas "X-11045-46-68-BO", doc 0.5 kg a Bolivia', g2 && g2.referencia === 'X-11045-46-68-BO' && g2.producto === 'D' && g2.pais === 'BOLIVIA' && cerca(g2.costo_total, 21.64), JSON.stringify(g2));
  const sumaFlete = r1.guias.reduce((s, g) => s + g.flete_neto, 0);
  check('los fletes suman "Servicio transporte" (466.30)', cerca(sumaFlete, 466.3), String(sumaFlete));

  const r2 = await extraerFacturaDHL(fs.readFileSync(F2));
  check('factura 2: 4 guías, cuadra, IVA 28.78, percepción 99.10, total 3430.90', r2.guias.length === 4 && r2.cuadra === true && cerca(r2.iva, 28.78) && cerca(r2.percepciones, 99.1) && cerca(r2.total_declarado, 3430.9), JSON.stringify({ n: r2.guias.length, c: r2.cuadra, iva: r2.iva, p: r2.percepciones, t: r2.total_declarado }));
  const g3 = r2.guias.find((g) => g.numero_guia === '5534904185');
  check('nombre en 3 líneas: "Non-conveyable Surcharge (NCP)- Weight" 23 + VALUE PROTECTION 47.50', g3 && g3.cargos.length === 2 && g3.cargos[0].nombre === 'Non-conveyable Surcharge (NCP)- Weight' && g3.cargos[0].monto === 23 && g3.cargos[1].nombre === 'VALUE PROTECTION' && g3.cargos[1].monto === 47.5, JSON.stringify(g3 && g3.cargos));
  const g4 = r2.guias.find((g) => g.numero_guia === '5751412866');
  check('"Over Sized Piece (OSP)" 69 en 2 líneas; 90 kg a Alemania; total 904.17', g4 && g4.cargos[0].nombre === 'Over Sized Piece (OSP)' && g4.cargos[0].monto === 69 && g4.peso === 90 && cerca(g4.costo_total, 904.17), JSON.stringify(g4));
  check('esFacturaDHL no se dispara con texto de UPS', !esFacturaDHL('UPS ARGENTINA S.R.L. Factura 0020-00075895'));

  console.log('\n2. Anomalías con los nombres de DHL\n');
  const an1 = detectarAnomalias({ extras_json: '[]', seguro: 17.5, fuel: 32, peso_facturable: 6.5 }, { cargos: g1.cargos, peso_facturado: 6.5, fuel_facturado: 32.57 });
  check('seguro previsto 17.50 cubre VALUE PROTECTION; GoGreen no es anomalía; queda solo "12:00 PREMIUM"', an1.length === 1 && an1[0].label === '12:00 PREMIUM' && an1[0].clase === 'no_previsto', JSON.stringify(an1));
  const an2 = detectarAnomalias({ extras_json: '[{"tipo":"manejo","monto":23}]', seguro: 0, fuel: 150, peso_facturable: 57.5 }, { cargos: g3.cargos, peso_facturado: 57.5, fuel_facturado: 150 });
  check('NCP cubierto por el manejo previsto; VALUE PROTECTION sin seguro → anomalía', an2.length === 1 && an2[0].tipo === 'seguro', JSON.stringify(an2));

  console.log('\n3. De punta a punta: /chequear y /cargar\n');
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const subir = async (ruta, archivo, sobreescribir = false) => {
    const form = new FormData();
    form.append('pdf', new Blob([fs.readFileSync(archivo)], { type: 'application/pdf' }), path.basename(archivo));
    form.append('sobreescribir', sobreescribir ? 'true' : 'false');
    const r = await fetch(`${BASE}/api/facturas/${ruta}`, { method: 'POST', headers: { Cookie: `nova_session=${TOKEN}` }, body: form });
    return { status: r.status, body: await r.json() };
  };
  const sqlite3 = require('sqlite3');
  const raw = new sqlite3.Database(DB);
  const get = (q, p = []) => new Promise((res, rej) => raw.get(q, p, (e, r) => (e ? rej(e) : res(r))));

  const cli = (await J('POST', '/clientes', { nombre: 'KASDORF TEST', tarifa_pct: 75, tipo_cobro: 'CC' })).body;
  const alta = (guia, extra = {}) => J('POST', '/envios', { cliente_id: cli.id, fecha: '2026-09-08', courier: 'DHL', tipo_envio: 'exportacion', numero_guia: guia, pais_destino: 'Alemania', peso_real: 6.5, largo: 30, ancho: 20, alto: 15, fob: 100, total_cobrado: 300, ...extra });
  const eA = (await alta('2761179293', { asegurado: 1 })).body;   // con seguro: VALUE PROTECTION previsto
  const eB = (await alta('2773265460', { pais_destino: 'Bolivia', peso_real: 0.5, tipo_paquete: 'documento' })).body;
  check('fixture: dos envíos DHL creados', eA.id && eB.id, JSON.stringify({ eA, eB }).slice(0, 200));

  const chk = await subir('chequear', F1);
  check('/chequear reconoce DHL, 6 guías, cuadra, IVA y percepción en el cuadre', chk.status === 200 && chk.body.courier === 'DHL' && chk.body.guias_total === 6 && chk.body.reconciliacion.cuadra === true && cerca(chk.body.reconciliacion.iva, 14.7) && cerca(chk.body.reconciliacion.percepciones, 22.94), JSON.stringify(chk.body).slice(0, 300));

  const car = await subir('cargar', F1);
  check('/cargar: 2 guardadas, 4 no encontradas, courier DHL', car.status === 200 && car.body.guardadas === 2 && car.body.no_encontradas === 4 && car.body.courier === 'DHL', JSON.stringify(car.body).slice(0, 300));
  const a = await get('SELECT costo_facturado, peso_facturado, courier_facturado, fecha_facturado, estado_revision FROM envios WHERE id = ?', [eA.id]);
  check('envío A: costo 155.15, 6.5 kg, courier_facturado DHL, fecha de la factura', a && cerca(a.costo_facturado, 155.15) && a.peso_facturado === 6.5 && a.courier_facturado === 'DHL' && a.fecha_facturado === '2026-09-30', JSON.stringify(a));
  const fg = await get('SELECT * FROM factura_guias WHERE numero_guia = ?', ['2761179293']);
  check('detalle: flete 91.71 / fuel 32.57 / neto 124.28 / recargos 30.87, cargos_json con los 3 recargos', fg && cerca(fg.flete_facturado, 91.71) && cerca(fg.fuel_facturado, 32.57) && cerca(fg.neto, 124.28) && cerca(fg.total_recargos, 30.87) && JSON.parse(fg.cargos_json).length === 3 && fg.percepcion == null, JSON.stringify(fg));
  const fc = await get('SELECT * FROM facturas_cargadas WHERE numero_factura = ?', ['1700A00033061']);
  check('cabecera: courier DHL, subtotal 764.44, IVA 14.70, percepción 22.94, total 802.08, 6 guías', fc && fc.courier === 'DHL' && cerca(fc.subtotal_factura, 764.44) && cerca(fc.iva, 14.7) && cerca(fc.percepciones, 22.94) && cerca(fc.total_declarado, 802.08) && fc.cantidad_guias === 6, JSON.stringify(fc));
  const anomA = (car.body.anomalias_lista || []).find((x) => x.envio_id === eA.id);
  check('anomalías de A: el seguro previsto cubre VALUE PROTECTION, queda "12:00 PREMIUM" (a_revisar)', anomA && anomA.anomalias.length === 1 && anomA.anomalias[0].label === '12:00 PREMIUM' && a.estado_revision === 'a_revisar', JSON.stringify(anomA));

  const sal = (await J('GET', '/salidas?desde=2026-09-08&hasta=2026-09-08')).body;
  const fila = (Array.isArray(sal) ? sal : sal.rows || []).find((r) => r.id === eA.id);
  check('Salidas: Flete+Fuel UPS (neto) 124.28, costo 155.15, anomalía visible', fila && cerca(fila.flete_fuel_ups, 124.28) && cerca(fila.costo_facturado, 155.15) && (fila.anomalias_factura || []).length === 1, JSON.stringify(fila && { ffu: fila.flete_fuel_ups, cf: fila.costo_facturado, an: fila.anomalias_factura }));

  const salud = (await J('GET', '/salud')).body;
  const chq = (salud.chequeos || []).find((c) => c.id === 'facturas_no_cuadran');
  check('Salud: la factura DHL cuadra (total = guías + IVA + percepción)', chq && chq.severidad === 'ok', JSON.stringify(chq && chq.resumen));
  const perc = (await J('GET', '/facturas/percepciones')).body;
  check('Ingresos Brutos: la factura lista con percepción 22.94 e IVA 14.70', perc.facturas.some((f) => f.numero_factura === '1700A00033061' && cerca(f.percepciones, 22.94) && cerca(f.iva, 14.7)) && cerca(perc.iva, 14.7), JSON.stringify(perc).slice(0, 300));

  const dup = await subir('cargar', F1);
  check('la misma factura otra vez sin sobreescribir → 409', dup.status === 409);
  await J('PATCH', `/facturas/guias/${eA.id}/estado`, { estado_revision: 'revisado_ok' });
  const re = await subir('cargar', F1, true);
  const a2 = await get('SELECT estado_revision FROM envios WHERE id = ?', [eA.id]);
  check('con sobreescribir entra, y la guía aprobada sigue revisado_ok (mismo costo)', re.status === 200 && a2.estado_revision === 'revisado_ok' && re.body.revision_conservada === 1, JSON.stringify({ s: re.status, e: a2, rc: re.body.revision_conservada }));
  const cab = await get('SELECT COUNT(*) n FROM facturas_cargadas WHERE numero_factura = ?', ['1700A00033061']);
  check('queda UNA sola cabecera', cab.n === 1);

  const car2 = await subir('cargar', F2);
  check('la segunda factura entra (4 guías sin envío → Sin envío)', car2.status === 200 && car2.body.no_encontradas === 4 && car2.body.courier === 'DHL', JSON.stringify(car2.body).slice(0, 200));
  const sinEnvio = (await J('GET', '/facturas/sin-envio?todo=1')).body;
  check('Sin envío lista 8 guías DHL con su courier', (sinEnvio.guias || []).filter((g) => g.courier === 'DHL').length === 8, JSON.stringify((sinEnvio.guias || []).map((g) => [g.numero_guia, g.courier])));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  await new Promise((r) => raw.close(r));
  matar();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1000).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
