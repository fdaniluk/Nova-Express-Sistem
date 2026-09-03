#!/usr/bin/env node
/**
 * test-facturas-impuestos.js — las facturas de IMPUESTOS DDP de UPS (03/09/2026).
 *
 * Cuando un envío sale DDP, UPS le factura a Nova los impuestos de destino en una factura
 * aparte, 1-2 meses después de la entrega, con un solo concepto ("GASTOS DE IMPORTACION EN
 * DESTINO") y una guía por factura. Nova se los liquida después al cliente en un documento
 * propio. Esta es la ENTREGA 1: leer la factura, reconocerla sola, cruzarla por guía con
 * su envío y dejarlo a la vista en Salidas — sin tocar el costo del flete ni su revisión.
 *
 * Los casos salen de seis facturas reales del 24/08/2026 (puntos de venta 0001-00926785 a
 * -94). Si están en facturas-ejemplo/impuestos/ (carpeta fuera del repo: llevan CUIT y
 * domicilio), se leen de verdad; si no, se arma un PDF mínimo con las mismas líneas.
 *
 *   cd backend && node scripts/test-facturas-impuestos.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const { extraerFacturaUPS, CONCEPTO_IMPUESTOS } = require('../src/services/factura-ups.service');

const PORT = process.env.PORT_TEST || 3951;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_facturas_impuestos.db';
const TOKEN = 'token-test-fac-imp';
const REALES = path.join(__dirname, '..', '..', 'facturas-ejemplo', 'impuestos');

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const cerca = (a, b, t = 0.011) => Math.abs(Number(a) - Number(b)) <= t;

// PDF mínimo (texto plano, Helvetica) con las líneas que pdf-parse ve en una factura real
// de impuestos. Alcanza para ejercitar el lector sin depender de archivos con datos.
function pdfMinimo(lineas) {
  const esc = (t) => t.replace(/[\\()]/g, (c) => '\\' + c);
  const contenido = 'BT /F1 10 Tf 40 750 Td 14 TL ' + lineas.map((l, i) => `${i ? 'T* ' : ''}(${esc(l)}) Tj`).join(' ') + ' ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(contenido, 'latin1')} >>\nstream\n${contenido}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
function facturaImpuestos({ numero, fecha = '24/08/2026', guias }) {
  const total = guias.reduce((s, g) => s + g.importe, 0);
  const imp = (n) => n.toFixed(2).replace('.', ',');
  return pdfMinimo([
    fecha, 'FACTURA', 'A', `N° ${numero}`, 'UPS de Argentina S.A.', 'DESCRIPCION', 'IMPORTE',
    'GASTOS DE IMPORTACION EN DESTINO',
    ...guias.map((g) => `${imp(g.importe)}     GUIA ${g.guia}`),
    imp(total), 'IMPORTE EN LETRAS con CERO CENTAVOS.-', 'SON DOLARES:', 'TOTAL U$S',
  ]);
}

async function main() {
  console.log('\n1. El lector reconoce la factura de impuestos\n');
  // El PDF sintético pesa menos de 4 KB: entra en el pool de Buffers de Node, que es
  // justo el caso en que el pdf.js de pdf-parse reventaba con "bad XRef entry" (arreglado
  // el 03/09 copiando a un Uint8Array). Pasarlo como Buffer chico es a propósito.
  const pdfChico = Buffer.from(facturaImpuestos({ numero: '0001-00999001', guias: [{ guia: '1Z327W096797194442', importe: 146.95 }] }));
  check('un PDF chico (Buffer del pool de Node) se lee igual', pdfChico.length < 4096 && !!(await extraerFacturaUPS(pdfChico).catch(() => null)), String(pdfChico.length));
  const sint = await extraerFacturaUPS(pdfChico);
  check('la reconoce por el concepto: tipo "impuestos"', sint.tipo === 'impuestos', String(sint.tipo));
  check('lee el número de factura', sint.numero_factura === '0001-00999001', String(sint.numero_factura));
  check('lee la fecha', sint.fecha_factura === '24/08/2026', String(sint.fecha_factura));
  check('una guía con su importe', sint.guias.length === 1 && sint.guias[0].numero_guia === '1Z327W096797194442' && cerca(sint.guias[0].costo_total, 146.95),
    JSON.stringify(sint.guias));
  check('el único cargo es "gastos de importación en destino"', sint.guias[0].cargos.length === 1 && sint.guias[0].cargos[0].nombre === CONCEPTO_IMPUESTOS);
  check('sin peso ni país (la factura no los trae)', sint.guias[0].peso === null && sint.guias[0].pais === null);
  check('cuadra contra el total del pie', sint.cuadra === true && cerca(sint.total_declarado, 146.95), `${sint.cuadra} / ${sint.total_declarado}`);
  const dos = await extraerFacturaUPS(facturaImpuestos({ numero: '0001-00999002', guias: [{ guia: '1Z327W096700000001', importe: 10 }, { guia: '1Z327W096700000002', importe: 20.5 }] }));
  check('si un día vienen dos guías en una factura, lee las dos', dos.guias.length === 2 && cerca(dos.suma_guias, 30.5), JSON.stringify(dos.guias.map((g) => g.costo_total)));

  if (fs.existsSync(REALES)) {
    const pdfs = fs.readdirSync(REALES).filter((f) => f.endsWith('.pdf'));
    console.log(`\n2. Las ${pdfs.length} facturas reales de facturas-ejemplo/impuestos/\n`);
    const ESPERADO = {
      '0001-00926785': ['1Z327W090490575965', 461.75], '0001-00926786': ['1Z327W096792031162', 67.13],
      '0001-00926787': ['1Z327W096795069724', 73.14], '0001-00926788': ['1Z327W096795111703', 184.49],
      '0001-00926791': ['1Z327W096796352086', 18.00], '0001-00926794': ['1Z327W096797194442', 146.95],
    };
    for (const f of pdfs) {
      const r = await extraerFacturaUPS(fs.readFileSync(path.join(REALES, f)));
      const esp = ESPERADO[r.numero_factura];
      check(`${f}: ${r.numero_factura} → ${esp ? esp[0] + ' USD ' + esp[1] : '?'}`,
        r.tipo === 'impuestos' && esp && r.guias.length === 1 && r.guias[0].numero_guia === esp[0] && cerca(r.guias[0].costo_total, esp[1]) && r.cuadra === true,
        JSON.stringify({ tipo: r.tipo, guias: r.guias.map((g) => [g.numero_guia, g.costo_total]), cuadra: r.cuadra }));
    }
  } else {
    console.log('\n2. (sin facturas reales en facturas-ejemplo/impuestos/: se saltea)\n');
  }

  // ── De punta a punta ─────────────────────────────────────────────────────────
  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  let muerto = false;
  const matar = () => { if (muerto) return; muerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const hoy = new Date().toISOString().slice(0, 10);
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const get = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => (e ? rej(e) : res(r))));

  const subir = async (ruta, pdf, sobreescribir = false) => {
    const form = new FormData();
    form.append('pdf', new Blob([pdf], { type: 'application/pdf' }), 'factura.pdf');
    form.append('sobreescribir', sobreescribir ? 'true' : 'false');
    const r = await fetch(`${BASE}/api/facturas/${ruta}`, { method: 'POST', headers: { Cookie: `nova_session=${TOKEN}` }, body: form });
    return { status: r.status, body: await r.json() };
  };

  const cli = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'DDP TEST', tarifa_pct: 75, tipo_cobro: 'CC' }),
  })).json();
  const alta = async (guia, ddp) => (await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP',
      numero_guia: guia, pais_destino: 'Estados Unidos', peso_real: 5, largo: 30, ancho: 20, alto: 15,
      fob: 100, total_cobrado: 200, ddp,
    }),
  })).json());
  const A = await alta('1Z327W096797194442', 1);   // DDP, va a recibir su factura
  const B = await alta('1Z327W096795111703', 0);   // NO DDP, pero UPS le factura impuestos igual
  const C = await alta('1Z327W096796352086', 1);   // DDP, todavía sin factura
  const envio = (id) => get('SELECT ddp, costo_facturado, estado_revision, impuestos_facturados, impuestos_factura_id, impuestos_fecha FROM envios WHERE id = ?', [id]);

  console.log('\n3. Chequear antes de cargar\n');
  const pdfA = facturaImpuestos({ numero: '0001-00926794', guias: [{ guia: '1Z327W096797194442', importe: 146.95 }] });
  const chk = await subir('chequear', pdfA);
  check('/chequear dice que es de impuestos', chk.body.tipo === 'impuestos', JSON.stringify(chk.body).slice(0, 120));
  check('ninguna guía tenía impuestos cargados', chk.body.conteo_ya_cargadas === 0);
  check('y ninguna es de un envío sin DDP', Array.isArray(chk.body.guias_no_ddp) && chk.body.guias_no_ddp.length === 0);

  console.log('\n4. Cargar: se cruza con el envío, en SUS columnas\n');
  const car = await subir('cargar', pdfA);
  check('la carga entra', car.status === 200 && car.body.guardadas === 1, `${car.status} ${JSON.stringify(car.body).slice(0, 160)}`);
  check('el resumen dice el tipo', car.body.tipo === 'impuestos');
  const a = await envio(A.id);
  check('el envío A tiene los impuestos facturados: 146,95', cerca(a.impuestos_facturados, 146.95), String(a.impuestos_facturados));
  check('con la fecha de la FACTURA (24/08/2026), no la de la carga', a.impuestos_fecha === '24/08/2026', String(a.impuestos_fecha));
  check('y apunta a la factura cargada', a.impuestos_factura_id != null);
  check('el costo del FLETE no se tocó', a.costo_facturado === null, String(a.costo_facturado));
  check('ni la revisión del flete', a.estado_revision === null, String(a.estado_revision));
  const fac = await get('SELECT tipo, cantidad_guias, guias_cruzadas, total_declarado FROM facturas_cargadas WHERE id = ?', [a.impuestos_factura_id]);
  check('la cabecera quedó marcada como impuestos', fac && fac.tipo === 'impuestos' && fac.guias_cruzadas === 1, JSON.stringify(fac));
  const fg = await get('SELECT numero_guia, costo_total, encontrada, cargos_json FROM factura_guias WHERE factura_id = ?', [a.impuestos_factura_id]);
  check('y el detalle por guía también', fg && fg.encontrada === 1 && cerca(fg.costo_total, 146.95) && /importaci/i.test(fg.cargos_json), JSON.stringify(fg));

  console.log('\n5. Factura de impuestos para un envío que NO es DDP\n');
  const pdfB = facturaImpuestos({ numero: '0001-00926788', guias: [{ guia: '1Z327W096795111703', importe: 184.49 }] });
  const chkB = await subir('chequear', pdfB);
  check('/chequear lo avisa antes de cargar', chkB.body.guias_no_ddp.length === 1 && chkB.body.guias_no_ddp[0].numero_guia === '1Z327W096795111703');
  const carB = await subir('cargar', pdfB);
  check('se carga igual (UPS lo cobró, es un hecho)', carB.status === 200 && carB.body.guardadas === 1);
  check('pero cuenta el envío sin tilde', carB.body.no_ddp === 1 && carB.body.no_ddp_lista.length === 1, JSON.stringify(carB.body.no_ddp_lista));
  check('y lo dice en las advertencias', (carB.body.advertencias || []).some((x) => x.tipo === 'envio_no_ddp'));
  const b = await envio(B.id);
  check('el envío B quedó con los impuestos y sin DDP (para que Salidas lo pinte en rojo)', cerca(b.impuestos_facturados, 184.49) && !b.ddp);

  console.log('\n6. Duplicados y sobreescribir\n');
  const dup = await subir('cargar', pdfA);
  check('la misma factura otra vez sin sobreescribir: 409', dup.status === 409, String(dup.status));
  const pdfA2 = facturaImpuestos({ numero: '0001-00926799', guias: [{ guia: '1Z327W096797194442', importe: 150 }] });
  const chkA2 = await subir('chequear', pdfA2);
  check('otra factura con la misma guía: /chequear avisa que ya tenía impuestos', chkA2.body.conteo_ya_cargadas === 1 && cerca(chkA2.body.guias_ya_cargadas[0].costo_facturado_anterior, 146.95));
  const carA2 = await subir('cargar', pdfA2, false);
  check('sin sobreescribir, se omite', carA2.body.omitidas_duplicado === 1 && cerca((await envio(A.id)).impuestos_facturados, 146.95));
  const carA3 = await subir('cargar', pdfA2, true);
  check('con sobreescribir, pisa', carA3.body.guardadas === 1 && cerca((await envio(A.id)).impuestos_facturados, 150));

  console.log('\n7. Guía sin envío\n');
  const pdfX = facturaImpuestos({ numero: '0001-00926700', guias: [{ guia: '1Z327W099999999999', importe: 33.33 }] });
  const carX = await subir('cargar', pdfX);
  check('no encontrada: 1', carX.body.no_encontradas === 1);
  const sinEnvio = await (await fetch(`${BASE}/api/facturas/sin-envio`, { headers: H })).json();
  const lista = Array.isArray(sinEnvio) ? sinEnvio : (sinEnvio.guias || sinEnvio.data || []);
  const x = lista.find((g) => g.numero_guia === '1Z327W099999999999');
  check('aparece en "Sin envío" con su tipo', x && x.tipo === 'impuestos' && cerca(x.costo_total, 33.33), JSON.stringify(x));

  console.log('\n8. Salidas lo muestra\n');
  const sal = await (await fetch(`${BASE}/api/salidas?desde=${hoy}&hasta=${hoy}`, { headers: H })).json();
  const filas = Array.isArray(sal) ? sal : (sal.envios || sal.data || []);
  const fA = filas.find((f) => f.id === A.id), fB = filas.find((f) => f.id === B.id), fC = filas.find((f) => f.id === C.id);
  check('A: DDP con impuestos facturados', fA && fA.ddp === true && cerca(fA.impuestos_facturados, 150) && fA.impuestos_fecha === '24/08/2026', JSON.stringify(fA && [fA.ddp, fA.impuestos_facturados]));
  check('B: impuestos facturados SIN DDP (el caso rojo)', fB && fB.ddp === false && cerca(fB.impuestos_facturados, 184.49));
  check('C: DDP esperando la factura', fC && fC.ddp === true && fC.impuestos_facturados === null);
  const salidasJs = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'modules', 'salidas.js'), 'utf8');
  check('la grilla dibuja el chip DDP con sus tres estados', /ddpChip\(e\)/.test(salidasJs) && /chip-ddp-espera/.test(salidasJs) && /chip-ddp-facturado/.test(salidasJs) && /chip-ddp-alerta/.test(salidasJs));
  check('y el modal muestra los impuestos facturados', /saled-impuestos-ddp/.test(salidasJs));
  const facturasJs = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'modules', 'facturas.js'), 'utf8');
  check('la pantalla de Facturas dice con todas las letras que es de impuestos', /Factura de IMPUESTOS DDP/.test(facturasJs) && /no_ddp/.test(facturasJs));

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  matar();
  await esperar(300);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
