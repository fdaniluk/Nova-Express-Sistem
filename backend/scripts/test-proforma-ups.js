#!/usr/bin/env node
/**
 * test-proforma-ups.js — puntos 4 y 5 del lote de la oficina (03/11/2026):
 *   5. "Proforma de UPS": con el tilde, la guía viaja con InternationalForms (Invoice) armado
 *      con los renglones (descripción partida en 3×35, cantidad en piezas, valor, HS, origen
 *      AR), SoldTo = destinatario, incoterm y motivo; UPS devuelve el PDF, que queda en la
 *      guía (GET /guias/:id/proforma-ups.pdf) y en los documentos de la pantalla.
 *   4. Lector de la proforma Excel de la oficina: POST /guias/proforma-excel lee Nº, fecha,
 *      consignee y renglones (HS adentro de la descripción) de un Excel con el esquema de la
 *      oficina, en cualquiera de sus acomodos.
 * Corre con UPS_SHIPPING_MOCK=1 y abre la pantalla en un navegador de verdad.
 */
let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const ExcelJS = require('exceljs');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3987;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_proforma_ups.db';
const TOKEN = 'token-test-proforma-ups';
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Un Excel con el esquema de la oficina (COMMERCIAL INVOICE), con el acomodo "chini": Nº en
// E4, DATE en E5, Shipper/Consignee en filas 7-13, cabecera en inglés en la 14 y la
// subcabecera en castellano en la 15 con "USD Unitario / USD total", HS dentro de la descripción.
async function excelDeMuestra(destino) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hoja1');
  ws.getCell('A2').value = 'COMMERCIAL INVOICE ';
  ws.getCell('E4').value = 'Nº: 1101878';
  ws.getCell('E5').value = 'DATE:  23/10/2026';
  ws.getCell('A7').value = 'Shipper: '; ws.getCell('B7').value = 'Camila Test';
  ws.getCell('D7').value = 'Consignee: '; ws.getCell('E7').value = 'Arete Studio';
  ws.getCell('A8').value = 'CUIT / CUIL: '; ws.getCell('B8').value = '27 37204112 4';
  ws.getCell('D8').value = 'Address: '; ws.getCell('E8').value = '116 Suffolk St';
  ws.getCell('A9').value = 'Address: '; ws.getCell('B9').value = 'Argañaras 19';
  ws.getCell('D9').value = 'CP: '; ws.getCell('E9').value = 10002;
  ws.getCell('D10').value = 'City:'; ws.getCell('E10').value = 'New York';
  ws.getCell('A11').value = 'Country: '; ws.getCell('B11').value = 'Argentina ';
  ws.getCell('D11').value = 'Country:'; ws.getCell('E11').value = 'United States';
  ws.getCell('D12').value = 'Phone:'; ws.getCell('E12').value = '1 (847) 668-9275';
  ws.getCell('D13').value = 'Mail:'; ws.getCell('E13').value = 'info@aretestudios.com';
  ws.getCell('A14').value = 'Quantity'; ws.getCell('B14').value = 'Description of goods';
  ws.getCell('A15').value = 'Cantidades'; ws.getCell('B15').value = 'Descripción de mercadería'; ws.getCell('E15').value = 'USD Unitario'; ws.getCell('F15').value = 'USD total';
  ws.mergeCells('B16:D16'); ws.getCell('A16').value = 25; ws.getCell('B16').value = 'Dresses (100% Polyester) Knit -  For Woman 6104.43'; ws.getCell('E16').value = 6; ws.getCell('F16').value = { formula: 'A16*E16', result: 150 };
  ws.mergeCells('B17:D17'); ws.getCell('A17').value = 36; ws.getCell('B17').value = 'Pant (100% Polyester) Woven - For Woman 6204.62'; ws.getCell('E17').value = 6; ws.getCell('F17').value = { formula: 'A17*E17', result: 216 };
  ws.mergeCells('B18:D18'); ws.getCell('A18').value = 30; ws.getCell('B18').value = 'BAG ECOMMERCE (100% Plastic)'; ws.getCell('E18').value = 0.1; ws.getCell('F18').value = { formula: 'A18*E18', result: 3 };
  ws.getCell('B20').value = 'ORIGIN: ARGENTINA';
  ws.getCell('B22').value = 'Manufacturer:'; ws.getCell('B23').value = 'Camila Test';
  ws.getCell('E25').value = 'TOTAL       USD'; ws.getCell('F25').value = { formula: 'SUM(F16:F18)', result: 369 };
  await wb.xlsx.writeFile(destino);
}

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const envSrv = {
    ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production',
    UPS_SHIPPING_MOCK: '1', UPS_SHIPPING_ENTORNO: 'test', UPS_CUENTA_EXPO: '327W09',
    UPS_SHIPPER_NOMBRE: 'NOVA EXPRESS', UPS_SHIPPER_TELEFONO: '5411 4000 0000',
    UPS_SHIPPER_DIRECCION: 'Av. Nova 100', UPS_SHIPPER_CIUDAD: 'Bella Vista', UPS_SHIPPER_CP: '1661',
  };
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: envSrv, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
  const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: H, body: JSON.stringify(b) });
  const get = (u) => fetch(BASE + u, { headers: H });
  const dbRaw = new sqlite3.Database(DB);
  const one = (q, p = []) => new Promise((res, rej) => dbRaw.get(q, p, (e2, row) => (e2 ? rej(e2) : res(row))));
  const pedidoDe = async (id) => JSON.parse((await one('SELECT request_json FROM guias WHERE id = ?', [id])).request_json).ShipmentRequest;

  const cli = await j(await post('/api/clientes', {
    nombre: 'PROFORMA TEST SA', tarifa_pct: 70, cuit: '30-22222222-3', direccion_recoleccion: 'Calle Falsa 123',
    codigo_postal: '1661', localidad: 'Bella Vista', provincia: 'Buenos Aires', telefono: '11 4000 1111', contacto: 'Pedro',
  }));
  const dGB = await j(await post(`/api/clientes/${cli.id}/destinatarios`, {
    nombre: 'LONDON LEATHER LTD', contacto: 'Jane', direccion1: '10 Downing St', codigo_postal: 'SW1A 2AA', ciudad: 'London',
    pais: 'Reino Unido', telefono: '+44 20 7000 0000', email: 'jane@london.example',
  }));
  const base = {
    cliente_id: cli.id, destinatario_id: dGB.id, fecha: '2026-11-03', servicio: 'UPS_SAV', contenido: 'Cueros',
    items: [{ cantidad: 2, descripcion: 'Leather hides, vegetable tanned, full grain, for saddlery and belts', valor_unitario: 150, hs: '4107.12' }, { cantidad: 4, descripcion: 'Samples', valor_unitario: 25 }],
    bultos: [{ peso_real: 5 }],
  };

  console.log('\n1. Configuración: incoterms y motivos para la pantalla\n');
  const conf = await j(await get('/api/guias/configuracion'));
  check('GET /guias/configuracion trae incoterms (FOB, EXW…) y motivos (SALE, SAMPLE…)', Array.isArray(conf.incoterms) && conf.incoterms.includes('FOB') && conf.incoterms.includes('EXW') && conf.motivos_export.some((m) => m.codigo === 'SALE') && conf.motivos_export.some((m) => m.codigo === 'SAMPLE'), JSON.stringify([conf.incoterms, conf.motivos_export]));

  console.log('\n2. Sin el tilde: la guía sale como siempre, sin InternationalForms ni PDF\n');
  let r = await post('/api/guias', base);
  let g = await j(r);
  check('POST /guias → 201', r.status === 201, `${r.status} ${JSON.stringify(g).slice(0, 200)}`);
  let req = await pedidoDe(g.id);
  check('  el pedido no lleva InternationalForms', !(req.Shipment.ShipmentServiceOptions || {}).InternationalForms);
  check('  tiene_proforma_ups = false y el PDF da 404', g.tiene_proforma_ups === false && (await get(`/api/guias/${g.id}/proforma-ups.pdf`)).status === 404);
  check('  los renglones guardan el HS', g.items[0].hs === '4107.12' && g.items[1].hs === null, JSON.stringify(g.items));

  console.log('\n3. Con el tilde: InternationalForms armado con los renglones y el PDF guardado\n');
  r = await post('/api/guias', { ...base, proforma_numero: '79122210', proforma_ups: { activa: 1, incoterm: 'EXW', motivo: 'SAMPLE', comentario: 'Samples, no commercial value' } });
  g = await j(r);
  check('POST /guias con proforma_ups → 201', r.status === 201, `${r.status} ${JSON.stringify(g).slice(0, 300)}`);
  req = await pedidoDe(g.id);
  const f = (req.Shipment.ShipmentServiceOptions || {}).InternationalForms;
  check('  InternationalForms: FormType 01, Nº 79122210, fecha 20261103, EXW, SAMPLE, USD', f && f.FormType === '01' && f.InvoiceNumber === '79122210' && f.InvoiceDate === '20261103' && f.TermsOfShipment === 'EXW' && f.ReasonForExport === 'SAMPLE' && f.CurrencyCode === 'USD' && f.Comments === 'Samples, no commercial value', JSON.stringify(f && { ...f, Product: undefined, Contacts: undefined }));
  check('  SoldTo = el destinatario (nombre, teléfono, dirección, país GB)', f && f.Contacts && f.Contacts.SoldTo && f.Contacts.SoldTo.Name === 'LONDON LEATHER LTD' && f.Contacts.SoldTo.Address.CountryCode === 'GB' && f.Contacts.SoldTo.Address.City === 'London', JSON.stringify(f && f.Contacts));
  const p0 = f && f.Product && f.Product[0]; const p1 = f && f.Product && f.Product[1];
  check('  renglón 1: descripción partida en renglones de ≤ 35, 2 PCS a 150.00, HS 4107.12, origen AR', p0 && Array.isArray(p0.Description) && p0.Description.length >= 2 && p0.Description.every((d) => d.length <= 35) && p0.Unit.Number === '2' && p0.Unit.Value === '150.00' && p0.Unit.UnitOfMeasurement.Code === 'PCS' && p0.CommodityCode === '4107.12' && p0.OriginCountryCode === 'AR', JSON.stringify(p0));
  check('  renglón 2: sin HS, 4 PCS a 25.00', p1 && !p1.CommodityCode && p1.Unit.Number === '4' && p1.Unit.Value === '25.00', JSON.stringify(p1));
  check('  pide el PDF aunque la cuenta sea paperless (OverridePaperlessIndicator)', f && 'OverridePaperlessIndicator' in f);
  check('  el shipper lleva el CUIT como TaxIdentificationNumber', /^30222222223$/.test(String(req.Shipment.Shipper.TaxIdentificationNumber || '')), JSON.stringify(req.Shipment.Shipper.TaxIdentificationNumber));
  check('  la guía dice tiene_proforma_ups y guarda incoterm/motivo', g.tiene_proforma_ups === true && g.proforma_ups && g.proforma_ups.incoterm === 'EXW' && g.proforma_ups.motivo === 'SAMPLE' && g.proforma_ups.pdf === true, JSON.stringify(g.proforma_ups));
  const pdfR = await get(`/api/guias/${g.id}/proforma-ups.pdf`);
  const pdfBuf = Buffer.from(await pdfR.arrayBuffer());
  check('  GET /guias/:id/proforma-ups.pdf devuelve un PDF', pdfR.status === 200 && /application\/pdf/.test(pdfR.headers.get('content-type')) && pdfBuf.slice(0, 4).toString() === '%PDF', `${pdfR.status} ${pdfBuf.slice(0, 8)}`);
  check('  el Nº de proforma quedó en la guía y es el mismo que viajó', g.proforma_numero === '79122210');
  // Sin número tipeado: viaja el próximo del correlativo y después se consume.
  const prox = (await j(await get('/api/configuracion/proforma'))).proforma_proximo;
  r = await post('/api/guias', { ...base, proforma_ups: { activa: 1, incoterm: 'FOB', motivo: 'SALE' } });
  g = await j(r);
  req = await pedidoDe(g.id);
  check('sin Nº tipeado: viaja el próximo del correlativo y la guía queda con ese mismo número', r.status === 201 && req.Shipment.ShipmentServiceOptions.InternationalForms.InvoiceNumber === String(prox) && g.proforma_numero === String(prox), JSON.stringify([prox, g.proforma_numero]));

  console.log('\n4. Frenos antes de llamar a UPS\n');
  const antes = (await j(await get('/api/guias'))).length;
  r = await post('/api/guias', { ...base, items: [{ cantidad: 1.5, descripcion: 'Hides', valor_unitario: 100 }], proforma_ups: { activa: 1 } });
  let e = await j(r);
  check('cantidad con decimales → 400 que lo dice', r.status === 400 && e.errores.some((x) => /entero/.test(x)), JSON.stringify(e.errores));
  r = await post('/api/guias', { ...base, fob: 999, proforma_ups: { activa: 1 } });
  e = await j(r);
  check('renglones que no suman el FOB → 400 con los dos números', r.status === 400 && e.errores.some((x) => /400\.00/.test(x) && /999\.00/.test(x)), JSON.stringify(e.errores));
  r = await post('/api/guias', { ...base, proforma_ups: { activa: 1, incoterm: 'XYZ' } });
  e = await j(r);
  check('incoterm inválido → 400', r.status === 400 && e.errores.some((x) => /incoterm/i.test(x)), JSON.stringify(e.errores));
  r = await post('/api/guias', { ...base, items: [{ cantidad: 1, descripcion: 'Hides', valor_unitario: 400, hs: 'ABC' }], proforma_ups: { activa: 1 } });
  e = await j(r);
  check('HS con letras → 400', r.status === 400 && e.errores.some((x) => /HS/.test(x)), JSON.stringify(e.errores));
  check('  ninguna de esas creó guía', (await j(await get('/api/guias'))).length === antes);

  console.log('\n5. Lector de la proforma Excel\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-proforma-'));
  const xlsx = path.join(dir, 'chini.xlsx');
  await excelDeMuestra(xlsx);
  const fd = new FormData();
  fd.append('archivo', new Blob([fs.readFileSync(xlsx)]), 'chini.xlsx');
  const lr = await fetch(`${BASE}/api/guias/proforma-excel`, { method: 'POST', headers: { Cookie: H.Cookie }, body: fd });
  const lee = await lr.json();
  check('POST /guias/proforma-excel → 200 con Nº 1101878, fecha 2026-10-23, título COMMERCIAL INVOICE', lr.status === 200 && lee.numero === '1101878' && lee.fecha === '2026-10-23' && lee.titulo === 'COMMERCIAL INVOICE', `${lr.status} ${JSON.stringify(lee).slice(0, 300)}`);
  check('  3 renglones: 25 Dresses a 6 (HS 6104.43 sacado de la descripción), 36 Pant a 6 (6204.62), 30 bolsas a 0.10 sin HS', lee.items.length === 3 && lee.items[0].cantidad === 25 && lee.items[0].valor_unitario === 6 && lee.items[0].hs === '6104.43' && lee.items[0].descripcion === 'Dresses (100% Polyester) Knit - For Woman' && lee.items[1].hs === '6204.62' && lee.items[2].valor_unitario === 0.1 && lee.items[2].hs === null, JSON.stringify(lee.items));
  check('  total 369 y suma 369, sin avisos', lee.total === 369 && lee.suma === 369 && lee.avisos.length === 0, JSON.stringify([lee.total, lee.suma, lee.avisos]));
  check('  consignee: Arete Studio, 116 Suffolk St, 10002 New York, United States, mail y teléfono', lee.consignee && lee.consignee.nombre === 'Arete Studio' && lee.consignee.direccion === '116 Suffolk St' && lee.consignee.codigo_postal === '10002' && lee.consignee.ciudad === 'New York' && lee.consignee.pais === 'United States' && lee.consignee.email === 'info@aretestudios.com', JSON.stringify(lee.consignee));
  check('  shipper: Camila Test con CUIT', lee.shipper && lee.shipper.nombre === 'Camila Test' && lee.shipper.cuit === '27 37204112 4', JSON.stringify(lee.shipper));
  fs.writeFileSync(path.join(dir, 'malo.xlsx'), 'esto no es un excel');
  const fd2 = new FormData(); fd2.append('archivo', new Blob([fs.readFileSync(path.join(dir, 'malo.xlsx'))]), 'malo.xlsx');
  const lr2 = await fetch(`${BASE}/api/guias/proforma-excel`, { method: 'POST', headers: { Cookie: H.Cookie }, body: fd2 });
  check('un archivo que no es Excel → 422 con mensaje', lr2.status === 422 && /Excel/.test((await lr2.json()).error));

  if (!chromium) { console.log('\n⚠ playwright no está instalado — se saltea la pantalla.'); }
  else {
    console.log('\n6. La pantalla: leer el Excel, tildar Proforma de UPS, emitir, botón Proforma UPS\n');
    const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
    const exe = cand.find((p) => fs.existsSync(p));
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', (e2) => errores.push(String(e2)));
    page.on('dialog', (d) => d.accept());
    await page.goto(BASE + '/pages/guias.html', { waitUntil: 'networkidle' });
    await esperar(1000);
    check('la tabla de renglones tiene la columna HS code y está el tilde "Proforma de UPS" (apagado, campos escondidos)', await page.evaluate(() => [...document.querySelectorAll('#g-items thead th')].some((th) => /HS code/.test(th.textContent)) && !document.getElementById('g-proforma-ups').checked && document.getElementById('g-proforma-ups-campos').classList.contains('hidden')));
    await page.selectOption('#g-cliente', String(cli.id)); await esperar(800);
    await page.selectOption('#g-destinatario', String(dGB.id)).catch(() => {});
    await page.setInputFiles('#g-proforma-excel', xlsx); await esperar(1500);
    const filas = await page.$$eval('#g-items tbody tr', (trs) => trs.map((tr) => ({ c: tr.querySelector('[data-f="cantidad"]').value, d: tr.querySelector('[data-f="descripcion"]').value, hs: tr.querySelector('[data-f="hs"]').value, v: tr.querySelector('[data-f="valor_unitario"]').value })));
    check('leer el Excel llena los 3 renglones con HS y valores', filas.length === 3 && filas[0].c === '25' && filas[0].hs === '6104.43' && filas[0].v === '6' && filas[2].v === '0.1', JSON.stringify(filas));
    check('   y el Nº de proforma, el contenido y el tilde de Proforma de UPS (campos a la vista)', (await page.inputValue('#g-proforma')) === '1101878' && (await page.inputValue('#g-contenido')).length > 0 && (await page.isChecked('#g-proforma-ups')) && !(await page.$eval('#g-proforma-ups-campos', (d) => d.classList.contains('hidden'))));
    check('   el estado dice qué leyó', /3 renglones/.test(await page.textContent('#g-proforma-excel-estado')) && /Arete Studio/.test(await page.textContent('#g-proforma-excel-estado')), await page.textContent('#g-proforma-excel-estado'));
    check('   el total de renglones es 369.00', /369\.00/.test(await page.textContent('#g-items-total')));
    await page.selectOption('#g-incoterm', 'FOB'); await page.selectOption('#g-motivo', 'SALE');
    check('   el resumen lateral dice Proforma UPS (FOB · SALE)', /UPS \(FOB · SALE\)/.test(await page.textContent('#g-resumen [data-r="proforma"]')), await page.textContent('#g-resumen [data-r="proforma"]'));
    await page.fill('#g-bultos tbody tr:nth-child(1) [data-f="peso_real"]', '8');
    const antesP = (await j(await get('/api/guias'))).length;
    await page.click('#g-emitir'); await esperar(2000);
    const guias = await j(await get('/api/guias'));
    const nueva = guias.length === antesP + 1 ? guias.reduce((a, b) => (b.id > a.id ? b : a)) : null;
    check('Emitir → la guía sale con proforma de UPS, Nº 1101878 y los 3 renglones con HS', !!nueva && nueva.tiene_proforma_ups && nueva.proforma_numero === '1101878' && nueva.items.length === 3 && nueva.items[0].hs === '6104.43', JSON.stringify(nueva && { n: nueva.proforma_numero, pf: nueva.proforma_ups, items: nueva.items.length }));
    if (nueva) {
      const reqN = await pedidoDe(nueva.id);
      const fN = reqN.Shipment.ShipmentServiceOptions.InternationalForms;
      check('   lo que viajó: 3 productos, el primero con CommodityCode 6104.43 y 25 PCS a 6.00', fN.Product.length === 3 && fN.Product[0].CommodityCode === '6104.43' && fN.Product[0].Unit.Number === '25' && fN.Product[0].Unit.Value === '6.00', JSON.stringify(fN.Product[0]));
    }
    const docs = await page.evaluate(() => [...document.querySelectorAll('a')].filter((a) => /proforma-ups\.pdf/.test(a.href)).map((a) => a.textContent.replace(/\s+/g, ' ').trim()));
    check('el resultado muestra el botón "Proforma UPS · PDF"', docs.some((t) => /Proforma UPS/.test(t)), JSON.stringify(docs));
    await page.click('.tab[data-tab="listado"]').catch(() => {}); await esperar(1500);
    const docsLista = await page.evaluate(() => [...document.querySelectorAll('a')].filter((a) => /proforma-ups\.pdf/.test(a.href)).length);
    check('   y en "Guías del día" también (solo en las que la pidieron)', docsLista >= 1, String(docsLista));
    const rel = errores.filter((x) => !/favicon|net::ERR|Failed to load resource/i.test(x));
    check('sin errores de JS', rel.length === 0, rel.join(' | ').slice(0, 300));
    await browser.close();
  }

  await new Promise((res) => dbRaw.close(() => res()));
  matar();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
