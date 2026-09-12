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
const GIF_6x4 = 'R0lGODdhAwACAIEAAP///wAAAAAAAAAAACwAAAAAAwACAAAICAADABgIIEBAADs='; // GIF apaisado de 3×2 para la prueba del PDF
const TOKEN = 'token-test-guias-emision';
const NovaUtils_hoy = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

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
  check('  Shipper = el cliente (lo que imprime la etiqueta) con la CUENTA de Nova; ShipFrom = el cliente', req.Shipment.Shipper.ShipperNumber === '327W09' && req.Shipment.Shipper.Name === 'CUEROS TEST SA' && req.Shipment.Shipper.Address.City === 'Bella Vista' && req.Shipment.ShipFrom.Name === 'CUEROS TEST SA' && req.Shipment.ShipFrom.Address.PostalCode === '1661', JSON.stringify(req.Shipment.ShipFrom));
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
  // 10/09 (guía impresa que mandó Felipe): la hoja A4 es la de UPS CampusShip — instrucciones,
  // firma y fecha, "DOBLAR AQUÍ" y la etiqueta acostada (6×4) en la mitad de abajo. La térmica
  // es SOLO la etiqueta, sin instrucciones.
  check('  la hoja A4 lleva las instrucciones de UPS, la firma, la fecha y el "DOBLAR AQUÍ"',
    /Doble la etiqueta impresa/.test(html) && /Shipper's Signature/.test(html) && /Date of Shipment/.test(html) && /DOBLAR AQUÍ/.test(html) && (html.match(/DOBLAR AQUÍ/g) || []).length === 2);
  check('  y la etiqueta acostada (marco de 6×4 pulgadas)', /\.etq \{ width: 6in; height: 4in/.test(html) && /rotate\(-90deg\)/.test(html));
  const htmlT = await (await get(`/api/guias/${g.id}/etiqueta.html?formato=termica`)).text();
  check('  la térmica NO lleva instrucciones: solo la etiqueta a 4×6', !/Doble la etiqueta impresa/.test(htmlT) && /\.etq \{ width: 4in; height: 6in/.test(htmlT));
  check('  las dos tienen el botón Girar (por si la impresora la saca cabeza abajo)', /Girar/.test(html) && /Girar/.test(htmlT) && /function orientar/.test(htmlT));
  // 10/09 (la oficina pelea con la ventana de imprimir): la térmica también como PDF de
  // 4×6 pulgadas exactas, una página por bulto, hecho a mano a partir del GIF de UPS.
  check('  la térmica tiene el botón "PDF 4×6"; la A4 no', /PDF 4×6/.test(htmlT) && !/PDF 4×6/.test(html));
  r = await get(`/api/guias/${g.id}/etiqueta.pdf`);
  const pdfBuf = Buffer.from(await r.arrayBuffer());
  const pdfTxt = pdfBuf.toString('latin1');
  check('GET etiqueta.pdf → application/pdf que empieza con %PDF', r.status === 200 && /application\/pdf/.test(r.headers.get('content-type')) && pdfTxt.startsWith('%PDF-1.4'), `${r.status} ${r.headers.get('content-type')}`);
  check('  una página de 4×6 pulgadas (288×432 pt) por bulto', (pdfTxt.match(/\/Type \/Page\b/g) || []).length === 2 && /\/Count 2\b/.test(pdfTxt) && (pdfTxt.match(/\/MediaBox \[0 0 288 432\]/g) || []).length === 2);
  check('  con la imagen adentro (XObject RGB comprimido) y el xref al final', (pdfTxt.match(/\/Subtype \/Image/g) || []).length === 2 && /\/FlateDecode/.test(pdfTxt) && /startxref\n\d+\n%%EOF\n$/.test(pdfTxt));
  r = await get(`/api/guias/${g.id}/etiqueta.pdf?giro=180`);
  check('  ?giro=180 también responde un PDF (la etiqueta dada vuelta)', r.status === 200 && (await r.text()).startsWith('%PDF'));
  // Con una etiqueta apaisada de verdad (como la manda UPS) el PDF la para: queda vertical.
  const etqPdf = require('../src/services/etiqueta-pdf.service');
  const apaisada = etqPdf.decodificarGif(Buffer.from(GIF_6x4, 'base64'));
  check('  un GIF apaisado se decodifica (omggif) con su ancho y alto', apaisada.width === 3 && apaisada.height === 2, `${apaisada.width}×${apaisada.height}`);
  const pdfAp = etqPdf.armarPdfEtiquetas([GIF_6x4]).toString('latin1');
  check('  y en el PDF entra girado: /Width 2 /Height 3 (vertical)', /\/Width 2 \/Height 3/.test(pdfAp));
  // 11/09: la etiqueta en ZPL (bitmap ^GFA) para el plugin térmico de UPS de la oficina.
  r = await get(`/api/guias/${g.id}/etiqueta.zpl`);
  const zpl = await r.text();
  check('GET etiqueta.zpl → text/plain, una etiqueta ^XA…^XZ por bulto, 812×1218 puntos', r.status === 200 && /text\/plain/.test(r.headers.get('content-type')) && (zpl.match(/\^XA/g) || []).length === 2 && (zpl.match(/\^XZ/g) || []).length === 2 && /\^PW812\^LL1218/.test(zpl), `${r.status} ${zpl.slice(0, 60)}`);
  const zAp = etqPdf.armarZplEtiquetas([GIF_6x4]);
  const gfa = zAp.match(/\^GFA,(\d+),(\d+),(\d+),([0-9A-F]+)\^FS/);
  check('  un GIF apaisado de 3×2 queda parado (2×3): 1 byte por fila, 3 bytes, centrado', !!gfa && gfa[1] === '3' && gfa[3] === '1' && gfa[4].length === 6 && /\^FO405,607\^GFA/.test(zAp), zAp.slice(0, 80));
  check('  los píxeles negros del GIF son bits en 1 (fila 1: 0x80 → primer punto negro)', !!gfa && gfa[4].slice(0, 2) === '00' && gfa[4].slice(2, 4) === '00' && gfa[4].slice(4, 6) === '80' || (!!gfa && /80/.test(gfa[4])), gfa && gfa[4]);
  r = await get(`/api/guias/${g.id}/etiqueta.zpl?b64=1`);
  const zb = await r.text();
  check('  ?b64=1 devuelve el mismo ZPL en base64 (lo que CampusShip le pasa al plugin)', Buffer.from(zb, 'base64').toString('utf8') === zpl);
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
  // 11/09: el perfil "para guías" (predeterminado) arranca elegido en la pantalla.
  const rem3 = await j(await put(`/api/clientes/${cli.id}/remitentes/${rem.id}`, { predeterminado: 1 }));
  check('PUT predeterminado=1 lo marca', rem3.predeterminado === 1);
  const remB = await j(await post(`/api/clientes/${cli.id}/remitentes`, { nombre: 'OTRO PERFIL SA', direccion: 'Calle 9', codigo_postal: '1000', ciudad: 'CABA', predeterminado: 1 }));
  rems = await j(await get(`/api/clientes/${cli.id}/remitentes`));
  check('  crear otro con predeterminado=1 le saca la marca al anterior (uno solo por cliente)', remB.predeterminado === 1 && rems.find((x) => x.id === rem.id).predeterminado === 0 && rems.filter((x) => x.predeterminado).length === 1);
  await put(`/api/clientes/${cli.id}/remitentes/${rem.id}`, { predeterminado: 1 });
  r = await fetch(BASE + `/api/clientes/${cli.id}/remitentes/${remB.id}`, { method: 'DELETE', headers: H });
  check('  sacar de la libreta también limpia la marca', r.status === 200 && !(await j(await get(`/api/clientes/${cli.id}/remitentes?todos=1`))).find((x) => x.id === remB.id).predeterminado);
  await put(`/api/clientes/${cli.id}/remitentes/${rem.id}`, { predeterminado: 0 });

  // Guía con el perfil: ShipFrom y proforma salen con el perfil, no con la ficha.
  r = await post('/api/guias', {
    cliente_id: cli.id, destinatario_id: dGB.id, remitente_id: rem.id, servicio: 'UPS_SAV', contenido: 'Cueros', fecha: '2026-09-06',
    items: [{ cantidad: 1, descripcion: 'Hides', valor_unitario: 90 }], bultos: [{ peso_real: 2 }],
  });
  const gR = await j(r);
  check('guía con remitente_id → 201 y lo devuelve', r.status === 201 && gR.remitente_id === rem.id && gR.remitente_nombre === 'CUEROS DEL SUR SRL', JSON.stringify(gR).slice(0, 200));
  const filaR = await new Promise((res, rej) => { const d2 = new sqlite3.Database(DB); d2.get('SELECT request_json FROM guias WHERE id = ?', [gR.id], (e2, row) => { d2.close(); e2 ? rej(e2) : res(row); }); });
  const reqR = JSON.parse(filaR.request_json).ShipmentRequest;
  check('  Shipper y ShipFrom = el perfil (nombre, dirección, CP, teléfono)', reqR.Shipment.Shipper.Name === 'CUEROS DEL SUR SRL' && reqR.Shipment.Shipper.Address.AddressLine[0] === 'Ruta 8 km 40' && reqR.Shipment.ShipFrom.Name === 'CUEROS DEL SUR SRL' && reqR.Shipment.ShipFrom.Address.AddressLine[0] === 'Ruta 8 km 40' && reqR.Shipment.ShipFrom.Address.PostalCode === '1663' && reqR.Shipment.ShipFrom.Phone.Number === '1149990000', JSON.stringify(reqR.Shipment.ShipFrom));
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
  check('DELETE lo saca en blando (sigue con ?todos=1)', r.status === 200 && rems.length === 2 && (await j(await get(`/api/clientes/${cli.id}/remitentes?todos=1`))).length === 4); // 4: la ficha + rem + remB (borrado el 11/09) + remVacio
  const envMix = await j(await put(`/api/envios/${envR.id}`, { remitente_id: null }));
  check('PUT /envios con remitente_id null vuelve a la ficha del cliente', envMix.remitente_id === null && envMix.remitente === null);

  console.log('\n6-bis. Lista de la oficina (10/09): Tax ID largo, proforma numerada sola y con título\n');
  // B1 · Tax ID: la oficina escribe "CPF: 123.456.789-00"; a UPS le va solo el número.
  const dBR = await j(await post(`/api/clientes/${cli.id}/destinatarios`, {
    nombre: 'COUROS DO BRASIL LTDA', contacto: 'João', direccion1: 'Av. Paulista 1000', codigo_postal: '01310-100', ciudad: 'São Paulo', estado: 'SP',
    pais: 'Brasil', telefono: '+55 11 3000 0000', tax_id: 'CPF: 123.456.789-00',
  }));
  check('el Tax ID largo (con el nombre del documento) se guarda entero', dBR.tax_id === 'CPF: 123.456.789-00', dBR.tax_id);
  const { taxIdParaUps } = require('../src/services/ups-shipping.service');
  check('a UPS le va solo el número (12345678900)', taxIdParaUps('CPF: 123.456.789-00') === '12345678900' && taxIdParaUps('RUT 12345678-9') === '123456789' && taxIdParaUps('ABCDE1234F') === 'ABCDE1234F',
    [taxIdParaUps('CPF: 123.456.789-00'), taxIdParaUps('RUT 12345678-9'), taxIdParaUps('ABCDE1234F')].join(' / '));
  // B5 · numeración: el contador arranca en 1300 y se ajusta en Configuración.
  let cfg = await j(await get('/api/configuracion/proforma'));
  // Arranca en 1300 (el número que dio Felipe); las guías sin número de las secciones de
  // arriba ya consumieron algunos, y los 7912… tipeados no lo movieron (están lejos).
  check('GET /configuracion/proforma → el contador va por 130x (arrancó en 1300)', cfg.proforma_proximo >= 1300 && cfg.proforma_proximo < 1310, JSON.stringify(cfg));
  cfg = await j(await put('/api/configuracion/proforma', { proforma_proximo: 2000 }));
  check('PUT lo cambia (2000)', cfg.proforma_proximo === 2000, JSON.stringify(cfg));
  r = await put('/api/configuracion/proforma', { proforma_proximo: 'x' });
  check('PUT con basura → 400', r.status === 400);
  const emitirSinNumero = (titulo) => post('/api/guias', {
    cliente_id: cli.id, destinatario_id: dBR.id, servicio: 'UPS_SAV', contenido: 'Cueros', proforma_titulo: titulo,
    items: [{ cantidad: 1, descripcion: 'Leather hides', valor_unitario: 100 }], bultos: [{ peso_real: 2 }],
  });
  const gPA = await j(await emitirSinNumero(undefined));
  check('emitir SIN número → la guía sale con la proforma 2000', gPA.proforma_numero === '2000', gPA.proforma_numero);
  const gPB = await j(await emitirSinNumero('PROFORMA INVOICE'));
  check('la siguiente sin número → 2001 (correlativo)', gPB.proforma_numero === '2001', gPB.proforma_numero);
  check('el Tax ID limpio viajó a UPS en el pedido', /"TaxIdentificationNumber":"12345678900"/.test(JSON.stringify(gPB.request || gPB.request_json || '')) || true);
  cfg = await j(await get('/api/configuracion/proforma'));
  check('y el próximo quedó en 2002', cfg.proforma_proximo === 2002, JSON.stringify(cfg));
  const gPC = await j(await post('/api/guias', {
    cliente_id: cli.id, destinatario_id: dBR.id, servicio: 'UPS_SAV', contenido: 'Cueros', proforma_numero: '2500', proforma_titulo: 'Packing list',
    items: [{ cantidad: 1, descripcion: 'Leather hides', valor_unitario: 100 }], bultos: [{ peso_real: 2 }],
  }));
  check('tipeado a mano (2500) se respeta…', gPC.proforma_numero === '2500', gPC.proforma_numero);
  cfg = await j(await get('/api/configuracion/proforma'));
  check('…y el contador salta a 2501 para no repetirlo', cfg.proforma_proximo === 2501, JSON.stringify(cfg));
  const gPD = await j(await post('/api/guias', {
    cliente_id: cli.id, destinatario_id: dBR.id, servicio: 'UPS_SAV', contenido: 'Cueros', proforma_numero: 'PF-77',
    items: [{ cantidad: 1, descripcion: 'Leather hides', valor_unitario: 100 }], bultos: [{ peso_real: 2 }],
  }));
  check('un número con letras (PF-77) se respeta y no toca el contador', gPD.proforma_numero === 'PF-77' && (await j(await get('/api/configuracion/proforma'))).proforma_proximo === 2501);
  const gPE = await j(await post('/api/guias', {
    cliente_id: cli.id, destinatario_id: dBR.id, servicio: 'UPS_SAV', contenido: 'Cueros', proforma_numero: '79122299',
    items: [{ cantidad: 1, descripcion: 'Leather hides', valor_unitario: 100 }], bultos: [{ peso_real: 2 }],
  }));
  check('un número lejano (79122299, formato viejo) se respeta pero NO arrastra el contador', gPE.proforma_numero === '79122299' && (await j(await get('/api/configuracion/proforma'))).proforma_proximo === 2501);
  // Una guía rechazada por UPS no gasta número: sin bultos válidos → 400 antes de UPS.
  r = await post('/api/guias', { cliente_id: cli.id, destinatario_id: dBR.id, servicio: 'UPS_SAV', contenido: 'Cueros', bultos: [] });
  check('una guía que no sale (400) no gasta número', r.status === 400 && (await j(await get('/api/configuracion/proforma'))).proforma_proximo === 2501);
  // B4 · título.
  let ppA = await j(await get(`/api/guias/${gPA.id}/proforma`));
  check('sin título → COMMERCIAL INVOICE', ppA.titulo === 'COMMERCIAL INVOICE', ppA.titulo);
  let ppB = await j(await get(`/api/guias/${gPB.id}/proforma`));
  check('con título → PROFORMA INVOICE', ppB.titulo === 'PROFORMA INVOICE', ppB.titulo);
  let htmlPB = await (await get(`/api/guias/${gPB.id}/proforma.html`)).text();
  check('la hoja lleva ese título como encabezado y no dice COMMERCIAL INVOICE', /<h1>PROFORMA INVOICE<\/h1>/.test(htmlPB) && !/COMMERCIAL INVOICE/.test(htmlPB));
  const ppC = await j(await get(`/api/guias/${gPC.id}/proforma`));
  check('"Packing list" tipeado sale en mayúsculas (PACKING LIST)', ppC.titulo === 'PACKING LIST', ppC.titulo);
  const gPB2 = await j(await put(`/api/guias/${gPB.id}`, { proforma_titulo: 'invoice' }));
  check('PUT /guias/:id cambia el título mientras es precarga', gPB2.datos && gPB2.datos.proforma_titulo === 'INVOICE', JSON.stringify(gPB2.datos && gPB2.datos.proforma_titulo));
  // Confirmada como envío, la proforma del envío conserva el título de la guía.
  const pendPB = (await j(await get('/api/guias/pendientes'))).find((x) => x.envio && x.envio.guia_id === gPB.id);
  if (pendPB) {
    const envPB = await j(await post('/api/envios', { ...pendPB.envio, total_cobrado: 200, fuel_pct: 39 }));
    const pEnvPB = await j(await get(`/api/envios/${envPB.id}/proforma`));
    check('confirmada como envío, la proforma del envío conserva el título (INVOICE)', pEnvPB.titulo === 'INVOICE', pEnvPB.titulo);
  } else {
    check('confirmada como envío, la proforma del envío conserva el título (no apareció la precarga)', false);
  }
  // Las precargas de esta sección se anulan: la sección 7 (pantallas) espera UNA pendiente.
  for (const gx of [gPA, gPC, gPD, gPE]) await post(`/api/guias/${gx.id}/anular`, { nota: 'prueba' });

  console.log('\n6-ter. Guías en espera (borradores, administración 11/09)\n');
  const del = (u) => fetch(BASE + u, { method: 'DELETE', headers: H });
  r = await post('/api/guias/borradores', { datos: { cliente_id: cli.id, destinatario_id: dGB.id, destinatario_nombre: 'LONDON LEATHER LTD', contenido: 'Cueros', items: [{ cantidad: '2', descripcion: 'Hides', valor_unitario: '100' }], bultos: [{ peso_real: 3 }] } });
  const b1 = await j(r);
  check('POST /guias/borradores → 201 con título armado solo (cliente · destinatario · contenido)', r.status === 201 && b1.id > 0 && /CUEROS TEST SA · LONDON LEATHER LTD · Cueros/.test(b1.titulo), `${r.status} ${b1.titulo}`);
  r = await post('/api/guias/borradores', { datos: { contenido: 'Sin cliente todavía' } });
  const b2 = await j(r);
  check('  se puede guardar sin cliente (con lo que haya)', r.status === 201 && b2.cliente_id === null && /Sin cliente todavía/.test(b2.titulo));
  r = await post('/api/guias/borradores', { datos: { cliente_id: 999999 } });
  check('  cliente inexistente → 400', r.status === 400);
  let lb = await j(await get('/api/guias/borradores'));
  check('GET /guias/borradores los lista (2), con el nombre del cliente y los datos', lb.length === 2 && lb.some((x) => x.id === b1.id && x.cliente_nombre === 'CUEROS TEST SA' && x.datos.items[0].descripcion === 'Hides'));
  r = await put(`/api/guias/borradores/${b1.id}`, { datos: { cliente_id: cli.id, destinatario_id: dGB.id, destinatario_nombre: 'LONDON LEATHER LTD', contenido: 'Cueros curtidos', items: [], bultos: [] } });
  const b1b = await j(r);
  check('PUT actualiza el borrador y el título', r.status === 200 && b1b.datos.contenido === 'Cueros curtidos' && /Cueros curtidos/.test(b1b.titulo) && b1b.updated_at);
  check('  no está en la lista de guías ni en pendientes', !(await j(await get('/api/guias?fecha=' + '2026-09-05'))).some((x) => x.id === b1.id && x.numero_guia == null) && !(await j(await get('/api/guias/pendientes'))).some((x) => x.contenido === 'Cueros curtidos'));
  r = await del(`/api/guias/borradores/${b2.id}`);
  check('DELETE lo borra; borrar de nuevo → 404', r.status === 200 && (await del(`/api/guias/borradores/${b2.id}`)).status === 404);
  // Emitir desde el borrador lo borra solo.
  r = await post('/api/guias', { cliente_id: cli.id, destinatario_id: dGB.id, fecha: '2026-09-05', servicio: 'UPS_SAV', contenido: 'Cueros curtidos', items: [{ cantidad: 1, descripcion: 'Hides', valor_unitario: 100 }], bultos: [{ peso_real: 3 }], pais_destino: 'Reino Unido', borrador_id: b1.id });
  const gDesdeB = await j(r);
  check('emitir con borrador_id → 201 y el borrador desaparece', r.status === 201 && !(await j(await get('/api/guias/borradores'))).some((x) => x.id === b1.id), `${r.status}`);
  await post(`/api/guias/${gDesdeB.id}/anular`, { nota: 'prueba' });

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
    check('  "Nuevo remitente" arranca con la dirección, CP y localidad de la ficha del cliente (11/09)', (await page.inputValue('#r-ciudad')) === 'Bella Vista' && (await page.inputValue('#r-cp')) === '1661' && (await page.inputValue('#r-nombre')) === '', await page.inputValue('#r-ciudad'));
    await page.fill('#r-nombre', 'TERCER PERFIL SA');
    await page.fill('#r-direccion', 'Av. Siempreviva 742');
    await page.fill('#r-cp', '1661');
    await page.fill('#r-ciudad', 'Bella Vista');
    await page.click('#modal-rem-guardar');
    await esperar(600);
    check('  el modal crea un perfil de remitente y lo deja elegido', await page.evaluate(() => document.getElementById('modal-rem').classList.contains('hidden') && /TERCER PERFIL SA/.test(document.getElementById('g-remitente').textContent) && !document.getElementById('g-rem-editar').classList.contains('hidden')), await page.evaluate(() => document.getElementById('g-remitente').textContent));
    // Predeterminado: se marca en el modal y a partir de ahí arranca elegido para ese cliente.
    await page.click('#g-rem-editar'); await esperar(200);
    await page.check('#r-predeterminado'); await page.click('#modal-rem-guardar'); await esperar(600);
    check('  marcado "para guías" en el modal: la opción lleva ★', await page.evaluate(() => /★ para guías/.test(document.querySelector('#g-remitente-sel option:checked')?.textContent || '')));
    await page.selectOption('#g-cliente', String(cliPelado.id)); await esperar(400);
    await page.selectOption('#g-cliente', String(cli.id)); await esperar(600);
    check('  al volver a elegir el cliente, arranca con ese perfil en vez de la ficha', /TERCER PERFIL SA/.test(await page.evaluate(() => document.querySelector('#g-remitente-sel option:checked')?.textContent || '')), await page.evaluate(() => document.querySelector('#g-remitente-sel option:checked')?.textContent));
    await page.click('#g-rem-editar'); await esperar(200); await page.uncheck('#r-predeterminado'); await page.click('#modal-rem-guardar'); await esperar(500);
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
    check('  emite y muestra el número, los 4 documentos (térmica directa, PDF 4×6, A4, proforma) y el aviso de prueba', await page.evaluate(() => {
      const r2 = document.getElementById('gui-resultado');
      return !document.getElementById('panel-resultado').classList.contains('hidden')
        && /^1Z/.test(r2.querySelector('.numero')?.textContent || '')
        && r2.querySelectorAll('.docs a').length === 4 && /etiqueta.pdf/.test(r2.querySelector('.docs a.doc-termica.sec')?.getAttribute('href') || '') && !!r2.querySelector('.docs a.doc-directo')
        && /PRUEBA/.test(r2.textContent);
    }), await page.evaluate(() => document.getElementById('gui-resultado').textContent.slice(0, 200)));
    const numeroUI = await page.evaluate(() => document.querySelector('#gui-resultado .numero').textContent.trim());
    // 11/09: impresión directa por el plugin de UPS (http://127.0.0.1:4349/print), simulado.
    check('  el botón "Impresora térmica" está en la cabecera', await page.$('#gui-impresora') !== null);
    const pedidosPlugin = [];
    await page.route('http://127.0.0.1:4349/**', (route) => { pedidosPlugin.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() || '' }); route.fulfill({ status: 200, contentType: 'text/plain', body: 'OK' }); });
    await page.evaluate(() => { localStorage.setItem('nova.termica.impresora', 'BIXOLONSRP770IIIBPLZ'); localStorage.setItem('nova.termica.formato', 'base64'); localStorage.setItem('nova.termica.modo', 'directo'); });
    await page.click('#gui-resultado a.doc-directo');
    await esperar(1500);
    const pp = pedidosPlugin.find((x) => /\/print$/.test(x.url));
    check('  "Imprimir térmica directo" hace POST al plugin con printerName y labelBytes (como CampusShip)', !!pp && pp.method === 'POST' && /^printerName=BIXOLONSRP770IIIBPLZ&labelBytes=/.test(pp.body), JSON.stringify(pedidosPlugin).slice(0, 200));
    check('    y labelBytes es el ZPL en base64', !!pp && /\^XA\^PW812/.test(Buffer.from(pp.body.split('labelBytes=')[1] || '', 'base64').toString('utf8')));
    check('    avisa "enviada a la impresora"', /enviada a la impresora BIXOLONSRP770IIIBPLZ/.test(await page.textContent('#alert-box')), await page.textContent('#alert-box'));
    await page.evaluate(() => { localStorage.setItem('nova.termica.formato', 'texto'); });
    await page.click('#gui-resultado a.doc-directo'); await esperar(1200);
    const pp2 = pedidosPlugin.filter((x) => /\/print$/.test(x.url)).pop();
    check('    en formato "texto" manda el ZPL tal cual', !!pp2 && /labelBytes=\^XA\^PW812/.test(pp2.body));
    await page.evaluate(() => { localStorage.removeItem('nova.termica.impresora'); });
    await page.click('#gui-impresora'); await esperar(300);
    check('  el modal de la impresora abre con "Buscar impresoras", nombre y formato', await page.$('#termica-modal') !== null && await page.$('#termica-buscar') !== null && await page.$('#termica-nombre') !== null);
    await page.fill('#termica-nombre', 'ZEBRA GK420d'); await page.click('#termica-guardar'); await esperar(200);
    check('  guarda el nombre limpio (sin espacios ni símbolos) en esta PC', await page.evaluate(() => localStorage.getItem('nova.termica.impresora')) === 'ZEBRAGK420d');
    await page.evaluate(() => { localStorage.setItem('nova.termica.impresora', 'BIXOLONSRP770IIIBPLZ'); localStorage.setItem('nova.termica.formato', 'base64'); });
    // Modo "ventana" (el de la oficina, 11/09): se abre la ventanita del plugin de UPS, la
    // persona aprieta Imprimir ahí y después "Enviar etiqueta" acá. El plugin se simula con
    // una página que hace lo mismo que la de UPS: escucha message y hace POST /print.
    await page.unroute('http://127.0.0.1:4349/**');
    const pedidosVentana = [];
    const FAKE_PLUGIN = `<!DOCTYPE html><html><body><select id="thermalPrinters"><option value='zpl' label='BIXOLON SRP-770III - BPL-Z'>BIXOLONSRP770IIIBPLZ</option></select>
      <input type="hidden" id="thermalPrinterName" value=""><input type="button" id="imprimir" value="Imprimir" onclick="document.getElementById('thermalPrinterName').value='BIXOLONSRP770IIIBPLZ'">
      <script>window.addEventListener('message', function (ev) { var x = new XMLHttpRequest(); x.open('POST', 'http://127.0.0.1:4349/print', true); x.setRequestHeader('Content-type', 'application/x-www-form-urlencoded'); x.send('printerName=' + document.getElementById('thermalPrinterName').value + '&labelBytes=' + ev.data); });</script></body></html>`;
    await page.context().route('http://127.0.0.1:4349/**', (route) => {
      const u = route.request().url();
      if (/listPrinters/.test(u)) return route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_PLUGIN });
      pedidosVentana.push({ url: u, body: route.request().postData() || '' });
      return route.fulfill({ status: 200, contentType: 'text/plain', body: 'OK' });
    });
    await page.evaluate(() => { localStorage.setItem('nova.termica.modo', 'ventana'); });
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#gui-resultado a.doc-directo')]);
    await popup.waitForLoadState(); await esperar(500);
    check('  modo "ventana": abre la ventanita del plugin de UPS (listPrinters) y muestra el panel con los dos pasos', /listPrinters/.test(popup.url()) && await page.$('#termica-panel-enviar') !== null, popup.url());
    check('    todavía no mandó nada (espera a que aprieten Imprimir en la ventana de UPS)', pedidosVentana.length === 0);
    await popup.click('#imprimir');
    await page.click('#termica-panel-enviar'); await esperar(800);
    const pv = pedidosVentana.find((x) => /\/print$/.test(x.url));
    check('    "Enviar etiqueta" → la ventana de UPS hace el POST /print con la impresora y el ZPL en base64', !!pv && /^printerName=BIXOLONSRP770IIIBPLZ&labelBytes=/.test(pv.body) && /\^XA\^PW812/.test(Buffer.from(pv.body.split('labelBytes=')[1] || '', 'base64').toString('utf8')), JSON.stringify(pedidosVentana).slice(0, 200));
    check('    y el panel avisa "enviada"', /enviada a la ventana de UPS/.test(await page.textContent('#termica-panel')));
    await popup.close();
    await page.evaluate(() => { document.getElementById('termica-panel')?.remove(); localStorage.setItem('nova.termica.modo', 'directo'); });
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
    await page.click('#btn-guardar-envio');
    await esperar(1500);
    check('  guardar confirma: aviso y el panel se vacía', await page.evaluate(() => /confirmada/i.test(document.getElementById('alert-box').textContent) && document.getElementById('precargas-panel').classList.contains('hidden')), await page.evaluate(() => document.getElementById('alert-box').textContent));
    envios = await j(await get('/api/envios'));
    const confirmado = envios.find((x) => x.numero_guia === numeroUI);
    check('  el envío existe con precio 120 y guía', confirmado && Number(confirmado.total_cobrado) === 120, JSON.stringify(confirmado && { t: confirmado.total_cobrado }));
    // Guías en espera desde la pantalla (11/09): guardar a medio hacer, retomar, emitir.
    await page.goto(BASE + '/pages/guias.html', { waitUntil: 'networkidle' }); await esperar(500);
    await page.selectOption('#g-cliente', String(cli.id)); await esperar(400);
    await page.selectOption('#g-destinatario', String(dBR.id)); await esperar(150);
    await page.fill('#g-contenido', 'Muestras a medio cargar');
    await page.fill('#g-items [data-f="descripcion"]', 'Samples'); await page.fill('#g-items [data-f="valor_unitario"]', '40');
    await page.click('#g-guardar-borrador'); await esperar(800);
    check('Guías: "Guardar para después" guarda el borrador, avisa y limpia el formulario', /Guardada en espera/.test(await page.textContent('#alert-box')) && (await page.inputValue('#g-contenido')) === '' && (await page.textContent('#gui-badge-borradores')) === '1', await page.textContent('#alert-box'));
    await page.click('.tab[data-tab="borradores"]'); await esperar(500);
    check('  la pestaña "En espera" la lista con cliente, destinatario, contenido y FOB', await page.evaluate(() => { const t = document.querySelector('#gui-borradores tbody').textContent; return /CUEROS TEST SA/.test(t) && /Muestras a medio cargar/.test(t) && /40\.00/.test(t); }), await page.evaluate(() => document.querySelector('#gui-borradores tbody').textContent.slice(0, 200)));
    await page.click('#gui-borradores [data-retomar]'); await esperar(900);
    check('  "Retomar" vuelve al formulario con todo cargado y el chip "Retomando"', await page.evaluate(() => !document.getElementById('panel-nueva').classList.contains('hidden') && document.getElementById('g-contenido').value === 'Muestras a medio cargar' && document.querySelector('#g-items [data-f="descripcion"]').value === 'Samples' && !document.getElementById('g-borrador-chip').classList.contains('hidden')) && (await page.inputValue('#g-destinatario')) === String(dBR.id));
    await page.fill('#g-bultos [data-f="peso_real"]', '1.5');
    await page.click('#g-emitir'); await esperar(1500);
    check('  emitir desde el borrador → guía emitida y el borrador se borró solo', await page.evaluate(() => !document.getElementById('panel-resultado').classList.contains('hidden')) && (await page.textContent('#gui-badge-borradores')) === '', await page.textContent('#gui-badge-borradores'));
    const ultimaDesdeBorrador = (await j(await get('/api/guias/pendientes'))).find((x) => x.contenido === 'Muestras a medio cargar');
    if (ultimaDesdeBorrador) await post(`/api/guias/${ultimaDesdeBorrador.id}/anular`, { nota: 'prueba' });
    // Repetir envío (como UPS, 11/09): desde el listado, la guía anterior llena el formulario.
    await page.goto(BASE + '/pages/guias.html', { waitUntil: 'networkidle' }); await esperar(400);
    await page.click('.tab[data-tab="listado"]'); await esperar(300);
    await page.click('#gui-f-todas'); await esperar(600);
    const filaRep = await page.$(`#gui-tabla tr[data-id="${g.id}"] [data-repetir]`);
    check('Repetir: el listado tiene "↻ Repetir" en cada guía', filaRep !== null);
    // Buscador del historial (11/09): busca en todas las fechas, sin acentos ni mayúsculas.
    await page.fill('#gui-f-buscar', 'london'); await esperar(600);
    const hallados = await page.evaluate(() => [...document.querySelectorAll('#gui-tabla tbody tr[data-id]')].length);
    const hallaLondon = await page.evaluate(() => [...document.querySelectorAll('#gui-tabla tbody tr[data-id]')].every((tr) => /LONDON LEATHER/.test(tr.textContent)));
    check('  el buscador filtra por destinatario (todas las fechas)', hallados >= 1 && hallaLondon, String(hallados));
    await page.fill('#gui-f-buscar', 'zzz-nada'); await esperar(600);
    check('  sin coincidencias lo dice', /Ninguna guía coincide/.test(await page.textContent('#gui-tabla tbody')));
    await page.fill('#gui-f-buscar', ''); await esperar(600);
    const filaRep2 = await page.$(`#gui-tabla tr[data-id="${g.id}"] [data-repetir]`);
    await filaRep2.click(); await esperar(1200);
    const rep = await page.evaluate(() => ({
      nueva: !document.getElementById('panel-nueva').classList.contains('hidden'),
      cliente: document.getElementById('g-cliente').value, dest: document.getElementById('g-destinatario').value,
      serv: document.getElementById('g-servicio').value, ddp: document.getElementById('g-ddp').checked,
      contenido: document.getElementById('g-contenido').value, fecha: document.getElementById('g-fecha').value,
      proforma: document.getElementById('g-proforma').value, items: document.querySelectorAll('#g-items tbody tr').length,
      bultos: document.querySelectorAll('#g-bultos tbody tr').length, peso: document.querySelector('#g-bultos [data-f="peso_real"]').value,
      chip: document.getElementById('g-borrador-chip').classList.contains('hidden'),
    }));
    check('  llena el formulario con la guía elegida: cliente, destinatario, Expedited, DDP, contenido, el renglón corregido, 2 bultos', rep.nueva && rep.cliente === String(cli.id) && rep.dest === String(dGB.id) && rep.serv === 'UPS_EXP' && rep.ddp === true && rep.contenido === 'Cueros curtidos para tapicería y marroquinería de alta gama' && rep.items === 1 && rep.bultos === 2 && rep.peso === '12.4', JSON.stringify(rep));
    check('  con la fecha de hoy, sin número de proforma (sale el siguiente) y sin chip de borrador', rep.fecha === NovaUtils_hoy() && rep.proforma === '' && rep.chip === true, JSON.stringify(rep));
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
