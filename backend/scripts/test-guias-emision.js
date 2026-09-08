#!/usr/bin/env node
/**
 * test-guias-emision.js — Guías, ETAPA 2: emisión, precarga y confirmación (08/09/2026).
 *
 * LA REGLA (GUIAS-UPS.md 3-bis): el módulo Guías pide la guía a UPS y entrega guía +
 * proforma; el envío queda como PRECARGA en Cargar envío hasta que administración lo
 * revisa, corrige y confirma envío por envío a Salidas. Hasta entonces no existe en
 * Salidas, liquidaciones ni en ningún total.
 *
 * Corre con UPS_SHIPPING_MOCK=1: no llama a UPS, el servicio devuelve una respuesta con
 * la forma real. El pedido que se armaría se revisa igual (request_json).
 *
 *   cd backend && node scripts/test-guias-emision.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3933;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_guias_emision.db';
const TOKEN = 'token-test-guias-emision';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  prepararDb(DB);
  const envSrv = {
    ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production',
    UPS_SHIPPING_MOCK: '1', UPS_SHIPPING_ENTORNO: 'test', UPS_CUENTA_EXPO: '327W09',
    UPS_SHIPPER_NOMBRE: 'NOVA EXPRESS', UPS_SHIPPER_TELEFONO: '5411 4000 0000',
    UPS_SHIPPER_DIRECCION: 'Av. Nova 100', UPS_SHIPPER_CIUDAD: 'Bella Vista', UPS_SHIPPER_CP: '1661',
  };
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: envSrv, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
  const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: H, body: JSON.stringify(b) });
  const put = (u, b) => fetch(BASE + u, { method: 'PUT', headers: H, body: JSON.stringify(b) });
  const get = (u) => fetch(BASE + u, { headers: H });

  console.log('\n1. Configuración del módulo\n');
  const conf = await j(await get('/api/guias/configuracion'));
  check('GET /guias/configuracion → entorno test, mock, cuenta', conf.entorno === 'test' && conf.mock === true && conf.cuenta === '327W09', JSON.stringify(conf));
  check('  no filtra el secreto', !JSON.stringify(conf).includes('SECRET') && !('shipper' in conf));

  console.log('\n2. Faltan datos → 400 con la lista, sin llamar a UPS\n');
  const cli = await j(await post('/api/clientes', {
    nombre: 'CUEROS TEST SA', tarifa_pct: 70, cuit: '30-22222222-3', direccion_recoleccion: 'Calle Falsa 123',
    codigo_postal: '1661', localidad: 'Bella Vista', provincia: 'Buenos Aires', telefono: '11 4000 1111', contacto: 'Pedro',
  }));
  const cliPelado = await j(await post('/api/clientes', { nombre: 'SIN DATOS SRL', tarifa_pct: 70 }));
  let r = await post('/api/guias', { cliente_id: cli.id, servicio: 'UPS_SAV', bultos: [{ peso_real: 2 }] });
  let e = await j(r);
  check('sin destinatario ni contenido → 400', r.status === 400 && Array.isArray(e.errores), `${r.status} ${JSON.stringify(e)}`);
  check('  dice qué falta', e.errores.some((x) => /destinatario/i.test(x)) && e.errores.some((x) => /contenido/i.test(x)), JSON.stringify(e.errores));

  const dUS = await j(await post(`/api/clientes/${cli.id}/destinatarios`, { nombre: 'ACME CORP', direccion1: '1000 NW 57th Ct', ciudad: 'Miami', pais: 'Estados Unidos', telefono: '305 555 0100' }));
  r = await post('/api/guias', { cliente_id: cli.id, destinatario_id: dUS.id, servicio: 'UPS_SAV', contenido: 'Cueros', bultos: [{ peso_real: 2 }], items: [{ cantidad: 1, descripcion: 'Hides', valor_unitario: 100 }] });
  e = await j(r);
  check('EE.UU. sin estado ni CP → 400 y lo dice', r.status === 400 && e.errores.some((x) => /estado/i.test(x)) && e.errores.some((x) => /postal/i.test(x)), JSON.stringify(e.errores));
  await put(`/api/clientes/${cli.id}/destinatarios/${dUS.id}`, { estado: 'FL', codigo_postal: '33126' });

  r = await post('/api/guias', { cliente_id: cliPelado.id, destinatario_id: dUS.id, servicio: 'UPS_SAV', contenido: 'Cueros', bultos: [{ peso_real: 2 }] });
  e = await j(r);
  check('cliente sin dirección / destinatario ajeno → 400', r.status === 400 && e.errores.some((x) => /El cliente no tiene dirección/i.test(x)) && e.errores.some((x) => /no es de ese cliente/i.test(x)), JSON.stringify(e.errores));

  const dXX = await j(await post(`/api/clientes/${cli.id}/destinatarios`, { nombre: 'RARO', direccion1: 'x', ciudad: 'y', pais: 'Atlántida', telefono: '123' }));
  r = await post('/api/guias', { cliente_id: cli.id, destinatario_id: dXX.id, servicio: 'UPS_SAV', contenido: 'Cueros', bultos: [{ peso_real: 2 }] });
  e = await j(r);
  check('país desconocido → 400 pidiendo el código de 2 letras', r.status === 400 && e.errores.some((x) => /2 letras/i.test(x)), JSON.stringify(e.errores));
  r = await post('/api/guias', { cliente_id: cli.id, destinatario_id: dUS.id, servicio: 'UPS_07', contenido: 'Cueros', bultos: [{ peso_real: 2 }] });
  e = await j(r);
  check('servicio inválido → 400', r.status === 400 && e.errores.some((x) => /Saver o Expedited/i.test(x)), JSON.stringify(e.errores));
  const nGuias = await j(await get('/api/guias'));
  check('nada de eso creó guías', Array.isArray(nGuias) && nGuias.length === 0, String(nGuias.length));

  console.log('\n3. Emisión: guía + etiqueta + proforma, y queda como precarga\n');
  const dGB = await j(await post(`/api/clientes/${cli.id}/destinatarios`, {
    nombre: 'LONDON LEATHER LTD', contacto: 'Jane', direccion1: '10 Downing St', codigo_postal: 'SW1A 2AA', ciudad: 'London',
    pais: 'Reino Unido', telefono: '+44 20 7000 0000', email: 'jane@ll.test', tax_id: 'GB123456789',
  }));
  r = await post('/api/guias', {
    cliente_id: cli.id, destinatario_id: dGB.id, fecha: '2026-09-08', servicio: 'UPS_EXP', ddp: 1,
    contenido: 'Cueros curtidos para tapicería y marroquinería de alta gama', proforma_numero: '79122211',
    items: [{ cantidad: 2, descripcion: 'Leather hides', valor_unitario: 150 }, { cantidad: 4, descripcion: 'Leather samples', valor_unitario: 25 }],
    bultos: [{ peso_real: 12.4, largo: 60, ancho: 40, alto: 30 }, { peso_real: 3 }],
    observaciones: 'Llamar antes de entregar',
  });
  const g = await j(r);
  check('POST /guias → 201', r.status === 201, `${r.status} ${JSON.stringify(g).slice(0, 300)}`);
  check('  con número de guía 1Z…', /^1Z/.test(g.numero_guia || ''), g.numero_guia);
  check('  estado emitida (precarga), entorno test, cuenta 327W09', g.estado === 'emitida' && g.entorno === 'test' && g.cuenta === '327W09');
  check('  FOB = total de los renglones (2×150 + 4×25 = 400)', Number(g.fob) === 400, String(g.fob));
  check('  2 bultos, 15.4 kg, DDP', g.bultos.length === 2 && Math.abs(g.peso_real - 15.4) < 0.001 && g.ddp === true);
  check('  cliente y destinatario resueltos', g.cliente_nombre === 'CUEROS TEST SA' && g.destinatario_nombre === 'LONDON LEATHER LTD' && g.destinatario_pais === 'Reino Unido');
  check('  tiene etiqueta y cargo de UPS', g.tiene_etiqueta === true && g.cargo_ups === 123.45);

  // Lo que se le mandó a UPS: se lee de la base porque la API no devuelve el blob.
  const sqlite3 = require('sqlite3');
  const dbRaw = new sqlite3.Database(DB);
  const one = (q, p = []) => new Promise((res, rej) => dbRaw.get(q, p, (e2, row) => (e2 ? rej(e2) : res(row))));
  const fila = await one('SELECT request_json, response_json, etiqueta_gif FROM guias WHERE id = ?', [g.id]);
  const req = JSON.parse(fila.request_json).ShipmentRequest;
  check('pedido: servicio 08 (Expedited), Description ≤ 50', req.Shipment.Service.Code === '08' && req.Shipment.Description.length <= 50, `${req.Shipment.Service.Code} "${req.Shipment.Description}"`);
  check('  ShipTo con GB, dirección, teléfono solo dígitos, tax id', req.Shipment.ShipTo.Address.CountryCode === 'GB' && req.Shipment.ShipTo.Phone.Number === '442070000000' && req.Shipment.ShipTo.TaxIdentificationNumber === 'GB123456789', JSON.stringify(req.Shipment.ShipTo));
  check('  Shipper = Nova con la cuenta; ShipFrom = el cliente', req.Shipment.Shipper.ShipperNumber === '327W09' && req.Shipment.Shipper.Name === 'NOVA EXPRESS' && req.Shipment.ShipFrom.Name === 'CUEROS TEST SA' && req.Shipment.ShipFrom.Address.PostalCode === '1661', JSON.stringify(req.Shipment.ShipFrom));
  const cargos = req.Shipment.PaymentInformation.ShipmentCharge;
  check('  DDP → cargo 01 flete + cargo 02 impuestos, los dos a la cuenta de Nova', cargos.length === 2 && cargos[1].Type === '02' && cargos[1].BillShipper.AccountNumber === '327W09', JSON.stringify(cargos));
  check('  2 paquetes: uno con medidas en CM, el otro sin Dimensions', req.Shipment.Package.length === 2 && req.Shipment.Package[0].Dimensions?.UnitOfMeasurement.Code === 'CM' && !req.Shipment.Package[1].Dimensions, JSON.stringify(req.Shipment.Package));
  check('  InvoiceLineTotal 400 USD', req.Shipment.InvoiceLineTotal.MonetaryValue === '400' && req.Shipment.InvoiceLineTotal.CurrencyCode === 'USD');
  check('  etiqueta GIF por bulto guardada', JSON.parse(fila.etiqueta_gif).length === 2);

  r = await get(`/api/guias/${g.id}/etiqueta.gif`);
  check('GET etiqueta.gif → image/gif', r.status === 200 && /image\/gif/.test(r.headers.get('content-type')), r.headers.get('content-type'));
  let html = await (await get(`/api/guias/${g.id}/etiqueta.html?formato=termica`)).text();
  check('etiqueta.html térmica: página 4×6 y aviso de prueba', /size: 4in 6in/.test(html) && /PRUEBA/.test(html) && (html.match(/data:image\/gif;base64/g) || []).length === 2);
  html = await (await get(`/api/guias/${g.id}/etiqueta.html?formato=a4`)).text();
  check('etiqueta.html A4: una etiqueta por hoja A4', /size: A4/.test(html) && /page-break-after: always/.test(html));
  const p = await j(await get(`/api/guias/${g.id}/proforma`));
  check('proforma de la guía: shipper = cliente, consignee = destinatario, Nº, total 400', p.shipper.cuit === '30-22222222-3' && p.consignee.nombre === 'LONDON LEATHER LTD' && p.numero === '79122211' && p.total === 400 && p.guia_id === g.id, JSON.stringify(p).slice(0, 300));
  html = await (await get(`/api/guias/${g.id}/proforma.html`)).text();
  check('proforma.html con COMMERCIAL INVOICE y la guía', /COMMERCIAL INVOICE/.test(html) && html.includes(g.numero_guia));

  console.log('\n4. La precarga NO es un envío hasta que se confirma\n');
  let envios = await j(await get('/api/envios'));
  check('GET /envios no la trae', !envios.some((x) => x.numero_guia === g.numero_guia), String(envios.length));
  const pend = await j(await get('/api/guias/pendientes'));
  check('GET /guias/pendientes la trae con el cuerpo para el alta', pend.length === 1 && pend[0].envio && pend[0].envio.guia_id === g.id && pend[0].envio.courier === 'UPS' && pend[0].envio.servicio_ups === 'UPS_EXP', JSON.stringify(pend[0]?.envio));
  check('  con bultos, país, FOB, DDP, contenido, destinatario, items', pend[0].envio.bultos.length === 2 && pend[0].envio.pais_destino === 'Reino Unido' && pend[0].envio.fob === 400 && pend[0].envio.ddp === 1 && pend[0].envio.destinatario_id === dGB.id && pend[0].envio.items.length === 2, JSON.stringify(pend[0].envio));

  const g2 = await j(await put(`/api/guias/${g.id}`, { proforma_numero: '79122212', items: [{ cantidad: 1, descripcion: 'Leather hides', valor_unitario: 400 }], fob: 400 }));
  check('PUT /guias/:id corrige proforma y renglones mientras es precarga', g2.proforma_numero === '79122212' && g2.items.length === 1, JSON.stringify(g2.items));

  console.log('\n5. Confirmar: POST /envios con guia_id crea el envío y marca la guía\n');
  const cuerpo = { ...pend[0].envio, proforma_numero: '79122212', items: g2.items, total_cobrado: 250, fuel_pct: 39 };
  r = await post('/api/envios', cuerpo);
  const env = await j(r);
  check('POST /envios (el mismo cuerpo, con precio) → 201', r.status === 201, `${r.status} ${JSON.stringify(env).slice(0, 200)}`);
  check('  el envío tiene la guía UPS, el destinatario, el contenido, los renglones y guia_id', env.numero_guia === g.numero_guia && env.destinatario?.id === dGB.id && env.contenido && env.items.length === 1 && env.guia_id === g.id, JSON.stringify({ n: env.numero_guia, d: env.destinatario_id, c: env.contenido, i: env.items?.length, g: env.guia_id }));
  check('  con costo calculado por el motor (UPS Expedited, 2 bultos)', Number(env.flete) > 0 && Number(env.peso_facturable) >= 15.4, `flete ${env.flete} pf ${env.peso_facturable}`);
  const g3 = await j(await get(`/api/guias/${g.id}`));
  check('la guía pasó a confirmada y apunta al envío', g3.estado === 'confirmada' && g3.envio_id === env.id, JSON.stringify({ e: g3.estado, id: g3.envio_id }));
  check('ya no está en pendientes', (await j(await get('/api/guias/pendientes'))).length === 0);
  r = await post('/api/envios', { ...cuerpo, numero_guia: cuerpo.numero_guia + 'X' });
  e = await j(r);
  check('confirmarla dos veces → 400', r.status === 400 && /ya está confirmada/.test(e.error), `${r.status} ${JSON.stringify(e)}`);
  r = await put(`/api/guias/${g.id}`, { contenido: 'otra cosa' });
  check('editar la guía confirmada → 400 (se edita desde el envío)', r.status === 400);
  r = await post(`/api/guias/${g.id}/anular`, {});
  check('anular la guía confirmada → 400', r.status === 400);
  r = await post('/api/envios', { ...cuerpo, guia_id: 999999, numero_guia: 'OTRA' });
  check('guia_id inexistente → 400', r.status === 400);

  console.log('\n6. Anular una precarga\n');
  r = await post('/api/guias', {
    cliente_id: cli.id, destinatario_id: dGB.id, servicio: 'UPS_SAV', contenido: 'Muestras', fecha: '2026-09-07',
    items: [{ cantidad: 1, descripcion: 'Samples', valor_unitario: 30 }], bultos: [{ peso_real: 1 }],
  });
  const gA = await j(r);
  check('segunda guía emitida (Saver, sin DDP)', r.status === 201 && gA.servicio === 'UPS_SAV' && gA.ddp === false);
  const filaA = await one('SELECT request_json FROM guias WHERE id = ?', [gA.id]);
  const reqA = JSON.parse(filaA.request_json).ShipmentRequest;
  check('  sin DDP: solo el cargo 01 (impuestos al destinatario), servicio 65', reqA.Shipment.PaymentInformation.ShipmentCharge.length === 1 && reqA.Shipment.Service.Code === '65');
  r = await post(`/api/guias/${gA.id}/anular`, { nota: 'se equivocó el peso' });
  const gAn = await j(r);
  check('POST /guias/:id/anular → anulada con nota', r.status === 200 && gAn.estado === 'anulada' && gAn.nota === 'se equivocó el peso' && gAn.anulada_at, JSON.stringify(gAn).slice(0, 200));
  check('  desaparece de pendientes', (await j(await get('/api/guias/pendientes'))).length === 0);
  r = await post('/api/envios', { ...cuerpo, guia_id: gA.id, numero_guia: gA.numero_guia });
  check('  no se puede confirmar una anulada → 400', r.status === 400);
  const lista = await j(await get('/api/guias?estado=anulada'));
  check('GET /guias?estado=anulada la lista', lista.length === 1 && lista[0].id === gA.id);
  const listaFecha = await j(await get('/api/guias?fecha=2026-09-08'));
  check('GET /guias?fecha= filtra por fecha', listaFecha.length === 1 && listaFecha[0].id === g.id, String(listaFecha.length));
  await new Promise((res) => dbRaw.close(() => res()));

  console.log('\n6-bis. Perfiles de remitente por cliente (pedido de Felipe, 08/09)\n');
  let rems = await j(await get(`/api/clientes/${cli.id}/remitentes`));
  check('GET /clientes/:id/remitentes → la ficha del cliente primero (id null, principal)', rems.length === 1 && rems[0].principal === true && rems[0].id === null && rems[0].nombre === 'CUEROS TEST SA' && rems[0].direccion === 'Calle Falsa 123' && rems[0].ciudad === 'Bella Vista', JSON.stringify(rems));
  r = await post(`/api/clientes/${cli.id}/remitentes`, { nombre: '' });
  check('sin nombre → 400', r.status === 400);
  r = await post(`/api/clientes/${cli.id}/remitentes`, {
    nombre: 'CUEROS DEL SUR SRL', cuit: '30-33333333-1', direccion: 'Ruta 8 km 40', codigo_postal: '1663',
    ciudad: 'Muñiz', provincia: 'Buenos Aires', telefono: '11 4222 3333', contacto: 'Laura', email: 'laura@sur.test',
  });
  const rem = await j(r);
  check('POST crea un perfil completo → 201', r.status === 201 && rem.id > 0 && rem.principal === false && rem.cuit === '30-33333333-1', JSON.stringify(rem));
  rems = await j(await get(`/api/clientes/${cli.id}/remitentes`));
  check('  la lista trae la ficha + el perfil', rems.length === 2 && rems[1].id === rem.id);
  const rem2 = await j(await put(`/api/clientes/${cli.id}/remitentes/${rem.id}`, { telefono: '11 4999 0000' }));
  check('PUT parcial conserva el resto', rem2.telefono === '11 4999 0000' && rem2.direccion === 'Ruta 8 km 40');
  r = await put(`/api/clientes/${cliPelado.id}/remitentes/${rem.id}`, { nombre: 'HACK' });
  check('otro cliente no puede editarlo → 404', r.status === 404, String(r.status));

  // Guía con el perfil: ShipFrom y proforma salen con el perfil, no con la ficha.
  r = await post('/api/guias', {
    cliente_id: cli.id, destinatario_id: dGB.id, remitente_id: rem.id, servicio: 'UPS_SAV', contenido: 'Cueros', fecha: '2026-09-06',
    items: [{ cantidad: 1, descripcion: 'Hides', valor_unitario: 90 }], bultos: [{ peso_real: 2 }],
  });
  const gR = await j(r);
  check('guía con remitente_id → 201 y lo devuelve', r.status === 201 && gR.remitente_id === rem.id && gR.remitente_nombre === 'CUEROS DEL SUR SRL', JSON.stringify(gR).slice(0, 200));
  const filaR = await new Promise((res, rej) => { const d2 = new sqlite3.Database(DB); d2.get('SELECT request_json FROM guias WHERE id = ?', [gR.id], (e2, row) => { d2.close(); e2 ? rej(e2) : res(row); }); });
  const reqR = JSON.parse(filaR.request_json).ShipmentRequest;
  check('  ShipFrom = el perfil (nombre, dirección, CP, teléfono)', reqR.Shipment.ShipFrom.Name === 'CUEROS DEL SUR SRL' && reqR.Shipment.ShipFrom.Address.AddressLine[0] === 'Ruta 8 km 40' && reqR.Shipment.ShipFrom.Address.PostalCode === '1663' && reqR.Shipment.ShipFrom.Phone.Number === '1149990000', JSON.stringify(reqR.Shipment.ShipFrom));
  const pR = await j(await get(`/api/guias/${gR.id}/proforma`));
  check('  la proforma sale con el perfil como Shipper y Manufacturer', pR.shipper.nombre === 'CUEROS DEL SUR SRL' && pR.shipper.cuit === '30-33333333-1' && pR.shipper.ciudad === 'Muñiz' && pR.manufacturer.cuit === '30-33333333-1', JSON.stringify(pR.shipper));
  const pendR = await j(await get('/api/guias/pendientes'));
  check('  la precarga lleva remitente_id al alta', pendR.length === 1 && pendR[0].envio.remitente_id === rem.id);
  r = await post('/api/envios', { ...pendR[0].envio, total_cobrado: 100, fuel_pct: 39 });
  const envR = await j(r);
  check('  confirmada: el envío guarda el remitente y lo devuelve', r.status === 201 && envR.remitente_id === rem.id && envR.remitente?.nombre === 'CUEROS DEL SUR SRL', JSON.stringify({ s: r.status, r: envR.remitente_id }));
  const pE = await j(await get(`/api/envios/${envR.id}/proforma`));
  check('  la proforma del envío también', pE.shipper.nombre === 'CUEROS DEL SUR SRL');
  r = await post('/api/guias', { cliente_id: cli.id, destinatario_id: dGB.id, remitente_id: 999999, servicio: 'UPS_SAV', contenido: 'Cueros', bultos: [{ peso_real: 2 }] });
  e = await j(r);
  check('remitente ajeno/inexistente → 400', r.status === 400 && e.errores.some((x) => /remitente elegido no es/i.test(x)), JSON.stringify(e.errores));
  r = await post(`/api/clientes/${cli.id}/remitentes`, { nombre: 'SIN DIRECCION SA' });
  const remVacio = await j(r);
  r = await post('/api/guias', { cliente_id: cli.id, destinatario_id: dGB.id, remitente_id: remVacio.id, servicio: 'UPS_SAV', contenido: 'Cueros', bultos: [{ peso_real: 2 }] });
  e = await j(r);
  check('perfil sin dirección → 400 y nombra al remitente', r.status === 400 && e.errores.some((x) => /SIN DIRECCION SA.*dirección/i.test(x)), JSON.stringify(e.errores));
  r = await fetch(BASE + `/api/clientes/${cli.id}/remitentes/${remVacio.id}`, { method: 'DELETE', headers: H });
  rems = await j(await get(`/api/clientes/${cli.id}/remitentes`));
  check('DELETE lo saca en blando (sigue con ?todos=1)', r.status === 200 && rems.length === 2 && (await j(await get(`/api/clientes/${cli.id}/remitentes?todos=1`))).length === 3);
  const envMix = await j(await put(`/api/envios/${envR.id}`, { remitente_id: null }));
  check('PUT /envios con remitente_id null vuelve a la ficha del cliente', envMix.remitente_id === null && envMix.remitente === null);

  console.log('\n7. Pantallas: Guías (emitir) y Cargar envío (precarga → confirmar)\n');
  let chromium = null;
  try { ({ chromium } = require('playwright')); } catch { chromium = null; }
  if (!chromium) {
    console.log('  ⚠ playwright no está instalado — se saltea la parte de pantalla.');
  } else {
    const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
      '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
    const exe = cand.find((pth) => fs.existsSync(pth));
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', (err) => errores.push(err.message));
    page.on('dialog', (d) => d.accept('prueba'));

    await page.goto(BASE + '/pages/guias.html', { waitUntil: 'networkidle' });
    await esperar(600);
    check('Guías: el chip dice que es simulado/prueba', await page.evaluate(() => /SIMULADO|PRUEBA/i.test(document.getElementById('gui-entorno').textContent)));
    check('  el menú tiene "Guías" activo', await page.evaluate(() => document.querySelector('.nav-item.active span:last-child')?.textContent.trim() === 'Guías'));
    await page.selectOption('#g-cliente', String(cli.id));
    await esperar(500);
    check('  al elegir cliente muestra el remitente y la libreta', await page.evaluate(() => /CUEROS TEST SA/.test(document.getElementById('g-remitente').textContent) && document.querySelectorAll('#g-destinatario option').length >= 3));
    check('  el selector de remitente tiene la ficha + el perfil', await page.evaluate(() => {
      const o = [...document.querySelectorAll('#g-remitente-sel option')].map((x) => x.textContent);
      return o.length === 2 && /ficha del cliente/.test(o[0]) && /CUEROS DEL SUR/.test(o[1]);
    }), await page.evaluate(() => [...document.querySelectorAll('#g-remitente-sel option')].map((x) => x.textContent).join(' | ')));
    await page.click('#g-rem-nuevo');
    await page.fill('#r-nombre', 'TERCER PERFIL SA');
    await page.fill('#r-direccion', 'Av. Siempreviva 742');
    await page.fill('#r-cp', '1661');
    await page.fill('#r-ciudad', 'Bella Vista');
    await page.click('#modal-rem-guardar');
    await esperar(600);
    check('  el modal crea un perfil de remitente y lo deja elegido', await page.evaluate(() => document.getElementById('modal-rem').classList.contains('hidden') && /TERCER PERFIL SA/.test(document.getElementById('g-remitente').textContent) && !document.getElementById('g-rem-editar').classList.contains('hidden')), await page.evaluate(() => document.getElementById('g-remitente').textContent));
    await page.selectOption('#g-remitente-sel', '');
    await esperar(100);
    check('  volver a la ficha esconde Editar', await page.evaluate(() => /CUEROS TEST SA/.test(document.getElementById('g-remitente').textContent) && document.getElementById('g-rem-editar').classList.contains('hidden')));
    await page.selectOption('#g-destinatario', String(dGB.id));
    await esperar(200);
    check('  la ficha del destinatario se ve', await page.evaluate(() => /LONDON LEATHER/.test(document.getElementById('g-dest-ficha').textContent)));
    // Nuevo destinatario desde el modal
    await page.click('#g-dest-nuevo');
    await page.fill('#d-nombre', 'BERLIN GMBH');
    await page.fill('#d-direccion1', 'Unter den Linden 1');
    await page.fill('#d-ciudad', 'Berlin');
    await page.fill('#d-cp', '10117');
    await page.selectOption('#d-pais', 'Alemania');
    await page.fill('#d-telefono', '+49 30 1234');
    await page.click('#modal-dest-guardar');
    await esperar(600);
    check('  el modal crea un destinatario y lo deja elegido', await page.evaluate(() => document.getElementById('modal-dest').classList.contains('hidden') && /BERLIN GMBH/.test(document.getElementById('g-dest-ficha').textContent)), await page.evaluate(() => document.getElementById('g-dest-ficha').textContent));
    await page.fill('#g-contenido', 'Cueros');
    await page.fill('#g-items [data-f="descripcion"]', 'Leather hides');
    await page.fill('#g-items [data-f="cantidad"]', '3');
    await page.fill('#g-items [data-f="valor_unitario"]', '50');
    await esperar(100);
    check('  el total de la proforma se calcula solo (150.00)', await page.evaluate(() => document.getElementById('g-items-total').textContent === '150.00'), await page.evaluate(() => document.getElementById('g-items-total').textContent));
    await page.click('#g-emitir');
    await esperar(400);
    check('  sin peso → avisa antes de llamar', await page.evaluate(() => !document.getElementById('g-errores').classList.contains('hidden') && /peso/i.test(document.getElementById('g-errores').textContent)));
    await page.fill('#g-bultos [data-f="peso_real"]', '2.5');
    await page.click('#g-emitir');
    await esperar(1200);
    check('  emite y muestra el número, los 3 documentos y el aviso de prueba', await page.evaluate(() => {
      const r2 = document.getElementById('gui-resultado');
      return !document.getElementById('panel-resultado').classList.contains('hidden')
        && /^1Z/.test(r2.querySelector('.numero')?.textContent || '')
        && r2.querySelectorAll('.docs a').length === 3
        && /PRUEBA/.test(r2.textContent);
    }), await page.evaluate(() => document.getElementById('gui-resultado').textContent.slice(0, 200)));
    const numeroUI = await page.evaluate(() => document.querySelector('#gui-resultado .numero').textContent.trim());
    await page.click('.tab[data-tab="listado"]');
    await esperar(800);
    check('  "Guías del día" la lista como Para confirmar', await page.evaluate((n) => [...document.querySelectorAll('#gui-tabla tbody tr')].some((tr) => tr.textContent.includes(n) && /Para confirmar/.test(tr.textContent)), numeroUI));

    // Cargar envío: la precarga aparece y se confirma con el mismo formulario.
    await page.goto(BASE + '/pages/envios.html', { waitUntil: 'networkidle' });
    await esperar(1000);
    check('Cargar envío: el panel "Guías para confirmar" muestra la precarga', await page.evaluate((n) => !document.getElementById('precargas-panel').classList.contains('hidden') && document.getElementById('precargas-lista').textContent.includes(n), numeroUI), await page.evaluate(() => document.getElementById('precargas-lista').textContent.slice(0, 200)));
    await page.click('#precargas-lista [data-cargar]');
    await esperar(1500);
    const form = await page.evaluate(() => ({
      titulo: document.getElementById('form-title').textContent,
      guiaId: document.getElementById('guia-id').value,
      cliente: document.getElementById('cliente_id').value,
      courier: document.getElementById('courier').value,
      variante: document.getElementById('cot-ups-variante').value,
      guia: document.getElementById('numero_guia').value,
      pais: document.getElementById('pais_destino').value,
      peso: document.getElementById('peso_real').value,
      fob: document.getElementById('fob').value,
    }));
    check('  "Cargar" llena el formulario con la guía', /Confirmar guía/.test(form.titulo) && form.guiaId && form.cliente === String(cli.id) && form.courier === 'UPS' && form.variante === 'UPS_SAV' && form.guia === numeroUI && form.pais === 'Alemania' && form.peso === '2.5' && form.fob === '150', JSON.stringify(form));
    await page.fill('#total_cobrado', '120');
    await page.click('#form-envio button[type="submit"]');
    await esperar(1500);
    check('  guardar confirma: aviso y el panel se vacía', await page.evaluate(() => /confirmada/i.test(document.getElementById('alert-box').textContent) && document.getElementById('precargas-panel').classList.contains('hidden')), await page.evaluate(() => document.getElementById('alert-box').textContent));
    envios = await j(await get('/api/envios'));
    const confirmado = envios.find((x) => x.numero_guia === numeroUI);
    check('  el envío existe con precio 120 y guía', confirmado && Number(confirmado.total_cobrado) === 120, JSON.stringify(confirmado && { t: confirmado.total_cobrado }));
    check('  otras pantallas tienen "Guías" en el menú', await page.evaluate(() => Boolean(document.querySelector('.nav-item[href="guias.html"]'))));
    check('ningún error de JavaScript', errores.length === 0, errores.slice(0, 3).join(' | '));
    await browser.close();
  }

  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
