#!/usr/bin/env node
// Dos formatos de factura que el sistema no leía (10/11/2026, avisó la oficina):
//   A · UPS "FACTURA - LIQUIDACION DE GASTOS" (punto de venta 0027): flete de una importación
//       a cobrar en destino. Decía "No se detectó ninguna guía en el PDF".
//   B · DHL de DERECHOS E IMPUESTOS EN DESTINO (producto Z, "DUTIES AND TAXES PAID" +
//       "IMPORT/EXPORT DUTIES"): entraba como flete, sin importe, y no generaba el cargo.
// La parte A se prueba siempre con una factura armada por posiciones (sin datos reales); las
// facturas reales de facturas-ejemplo/ (fuera del repo) se prueban si están, de punta a punta.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const { extraerFacturaCourier } = require('../src/services/factura-dhl.service');
const { extraerFacturaUPS } = require('../src/services/factura-ups.service');
const { esLiquidacionDeGastosUPS, extraerLiquidacionGastosUPSDesdePaginas } = require('../src/services/factura-ups-gastos.service');

const PORT = process.env.PORT_TEST || 3999;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_facturas_nuevos_formatos.db';
const TOKEN = 'token-test-fact-nuevos';
const EJ = path.join(__dirname, '..', '..', 'facturas-ejemplo');
const F_DHL = path.join(EJ, 'dhl', 'DHL-1700A00045043_06112026.pdf');
const F_U1 = path.join(EJ, 'ups-gastos', '0027-00014363.pdf');
const F_U2 = path.join(EJ, 'ups-gastos', '0027-00014772.pdf');

let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const cerca = (a, b, tol = 0.011) => a != null && Math.abs(Number(a) - b) < tol;

// Una "liquidación de gastos" armada a mano con las posiciones del PDF real.
function paginaGastos({ pv = '0027', nro = '00099001', fecha = '2/11/2026', guia = '1Z3R6A450000000011', tarifario = '400,00', descuento = '-300,00', sobrecargo = '40,00', seguro = '0,00', total = '140,00', p1 = '2,10', p2 = '2,10', etiqueta = '0,55', temporada = '10,00', pie = '154,75', peso = ' 11,50' } = {}) {
  const it = (y, x, s) => ({ y, x, s });
  return [[
    it(760, 60, 'UPS de Argentina S.A.'), it(760, 330, 'FACTURA - LIQUIDACION DE GASTOS'),
    it(734, 363, pv), it(733, 394, nro), it(678, 499, fecha), it(616, 487, '2/12/2026'),
    it(573, 40, 'N° de Guía Aerea'), it(573, 117, guia),
    it(562, 40, 'País de Origen:'), it(562, 100, 'UNITED STATES'), it(562, 310, 'Cantidad de Bultos'), it(562, 429, ' 1'),
    it(550, 40, 'Nivel de Servicio:'), it(550, 110, 'EXPEDITED'), it(550, 310, 'Peso Total del Envío '), it(550, 429, peso),
    it(494, 47, 'VALOR FOB:'), it(495, 439, ' 0,00'), it(480, 47, 'SERVICIO INTERNACIONAL'),
    it(470, 174, 'VALOR TARIFARIO:'), it(470, 429, ` ${tarifario}`),
    it(460, 174, 'DESCUENTO (75,00%):'), it(460, 429, descuento),
    it(449, 174, 'SOBRECARGO:'), it(449, 429, ` ${sobrecargo}`),
    it(440, 174, 'SEGURO:'), it(440, 434, ` ${seguro}`),
    it(430, 174, 'TOTAL:'), it(429, 429, ` ${total}`), it(430, 536, ` ${total}`),
    it(420, 47, 'PERCEPCION INGRESOS BRUTOS'),
    it(409, 174, "DN 'B' 1/2004:"), it(409, 545, ` ${p1}`),
    it(399, 174, 'Res N° 421/AGIP/2016:'), it(399, 545, ` ${p2}`),
    it(386, 46, 'IMPRESIÓN DE ETIQUETA:'), it(386, 545, ` ${etiqueta}`),
    it(374, 46, 'TEMPORADA ALTA:'), it(374, 541, ` ${temporada}`),
    it(149, 528, ` ${pie}`), it(64, 476, '19/12/2026'),
  ]];
}

(async () => {
  console.log('\n1. UPS "Liquidación de gastos": el lector (factura armada)\n');
  const pag = paginaGastos();
  check('se reconoce por el título', esLiquidacionDeGastosUPS(pag[0].map((i) => i.s).join('\n')) && !esLiquidacionDeGastosUPS('UPS de Argentina S.A.\nFACTURA\nN° 0001-00012345'));
  const r = extraerLiquidacionGastosUPSDesdePaginas(pag);
  check('UPS, tipo flete, número 0027-00099001, fecha con cero adelante (02/11/2026)', r.courier === 'UPS' && r.tipo === 'flete' && r.numero_factura === '0027-00099001' && r.fecha_factura === '02/11/2026', `${r.numero_factura} ${r.fecha_factura}`);
  const g = r.guias[0];
  check('una guía: 1Z3R6A450000000011, origen UNITED STATES, 11,5 kg', r.guias.length === 1 && g.numero_guia === '1Z3R6A450000000011' && g.pais === 'UNITED STATES' && g.peso === 11.5, JSON.stringify(g));
  check('flete = tarifario − descuento (100) · fuel = sobrecargo (40) · neto 140', cerca(g.flete_neto, 100) && cerca(g.fuel, 40) && cerca(g.neto, 140), JSON.stringify([g.flete_neto, g.fuel, g.neto]));
  check('recargos: etiqueta 0,55 + temporada alta 10 (seguro en 0 no se lista) → costo 150,55', g.cargos.length === 2 && cerca(g.total_recargos, 10.55) && cerca(g.costo_total, 150.55), JSON.stringify(g.cargos));
  check('percepción IIBB 4,20 fuera del envío; total del pie 154,75; cuadra', cerca(r.percepciones, 4.2) && cerca(r.total_declarado, 154.75) && cerca(r.subtotal_factura, 150.55) && r.cuadra === true && r.percepciones_repartidas === false, JSON.stringify([r.percepciones, r.total_declarado, r.cuadra]));
  const conSeguro = extraerLiquidacionGastosUPSDesdePaginas(paginaGastos({ seguro: '19,10', total: '159,10', pie: '173,85' })).guias[0];
  check('con seguro: va como recargo "Seguro" y entra en el costo (169,65)', conSeguro.cargos.some((c) => /Seguro/.test(c.nombre) && cerca(c.monto, 19.1)) && cerca(conSeguro.costo_total, 169.65), JSON.stringify(conSeguro.cargos));
  const noCuadra = extraerLiquidacionGastosUPSDesdePaginas(paginaGastos({ pie: '200,00' }));
  check('si el pie no coincide con el desglose: avisa total_no_cuadra', noCuadra.cuadra === false && noCuadra.advertencias.some((a) => a.tipo === 'total_no_cuadra'), JSON.stringify(noCuadra.advertencias.map((a) => a.tipo)));
  const sinTarifario = extraerLiquidacionGastosUPSDesdePaginas([paginaGastos()[0].filter((i) => !/VALOR TARIFARIO/.test(i.s))]);
  check('sin VALOR TARIFARIO legible: la guía queda SIN costo (no en 0) y avisa', sinTarifario.guias[0].costo_total === null && sinTarifario.advertencias.some((a) => a.tipo === 'sin_neto'));

  const hayReales = fs.existsSync(F_DHL) && fs.existsSync(F_U1) && fs.existsSync(F_U2);
  if (!hayReales) {
    console.log(`\n⚠ No están las facturas reales en ${EJ} (dhl/DHL-1700A00045043_06112026.pdf y ups-gastos/0027-0001436{3}/1477{2}.pdf): se saltea la parte real.`);
  } else {
    console.log('\n2. Las facturas reales, leídas\n');
    const u1 = await extraerFacturaCourier(fs.readFileSync(F_U1), extraerFacturaUPS);
    check('0027-00014363 (29/10/2026): 1Z3R6A458891288906, 28,5 kg, EE.UU.', u1.numero_factura === '0027-00014363' && u1.fecha_factura === '29/10/2026' && u1.guias[0].numero_guia === '1Z3R6A458891288906' && u1.guias[0].peso === 28.5, JSON.stringify([u1.numero_factura, u1.fecha_factura, u1.guias[0]]));
    check('   flete 248,27 (993,10 − 744,83) + fuel 109,97 + seguro 19,10 + etiqueta 1,10 + temporada 19,95 = 398,39', cerca(u1.guias[0].flete_neto, 248.27) && cerca(u1.guias[0].fuel, 109.97) && cerca(u1.guias[0].costo_total, 398.39), JSON.stringify(u1.guias[0]));
    check('   percepción 11,32 aparte; total 409,71; cuadra', cerca(u1.percepciones, 11.32) && cerca(u1.total_declarado, 409.71) && u1.cuadra === true);
    const u2 = await extraerFacturaCourier(fs.readFileSync(F_U2), extraerFacturaUPS);
    check('0027-00014772 (02/11/2026): 1Z3R6A458891997720, costo 202,47, percepción 5,48, total 207,95, cuadra', u2.numero_factura === '0027-00014772' && u2.fecha_factura === '02/11/2026' && cerca(u2.guias[0].costo_total, 202.47) && cerca(u2.percepciones, 5.48) && cerca(u2.total_declarado, 207.95) && u2.cuadra === true, JSON.stringify([u2.fecha_factura, u2.guias[0].costo_total, u2.percepciones, u2.cuadra]));
    const d = await extraerFacturaCourier(fs.readFileSync(F_DHL), extraerFacturaUPS);
    check('DHL 1700A00045043: tipo IMPUESTOS (todas las filas son producto Z)', d.courier === 'DHL' && d.tipo === 'impuestos' && d.numero_factura === '1700A00045043', JSON.stringify([d.courier, d.tipo, d.numero_factura]));
    check('   guía 5451062934: DUTIES AND TAXES PAID 25 + IMPORT/EXPORT DUTIES 50,59 = 75,59', d.guias.length === 1 && d.guias[0].numero_guia === '5451062934' && cerca(d.guias[0].costo_total, 75.59) && d.guias[0].cargos.length === 2 && d.guias[0].cargos[0].nombre === 'DUTIES AND TAXES PAID' && d.guias[0].cargos[1].nombre === 'IMPORT/EXPORT DUTIES', JSON.stringify(d.guias[0]));
    check('   cuadra con "Otros Servicios" 75,59; percepción 2,26 aparte; sin aviso de cargos desparejos', d.cuadra === true && cerca(d.percepciones, 2.26) && d.advertencias.every((a) => a.tipo === 'percepcion_aparte'), JSON.stringify(d.advertencias.map((a) => a.tipo)));

    console.log('\n3. De punta a punta: se cargan y llegan al envío\n');
    prepararDb(DB, { desdeProduccion: false });
    const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production', SALUD_AUTO: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let lo = '', le = ''; srv.stdout.on('data', (x) => { lo += x; }); srv.stderr.on('data', (x) => { le += x; });
    const matar = () => { try { srv.kill(); } catch {} };
    process.on('exit', matar);
    await esperarServidor(srv, BASE, () => le, () => lo);
    await abrirSesion(DB, TOKEN);
    const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
    const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));
    const subir = async (ep, file, extra = {}) => { const fd = new FormData(); fd.append('pdf', new Blob([fs.readFileSync(file)], { type: 'application/pdf' }), path.basename(file)); for (const [k, v] of Object.entries(extra)) fd.append(k, v); const x = await fetch(`${BASE}/api/facturas/${ep}`, { method: 'POST', headers: { Cookie: H.Cookie }, body: fd }); return { status: x.status, body: await x.json().catch(() => null) }; };
    const cli = (await J('POST', '/clientes', { nombre: 'FORMATOS SA', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
    const eDhl = (await J('POST', '/envios', { cliente_id: cli.id, fecha: '2026-10-22', courier: 'DHL', tipo_envio: 'exportacion', numero_guia: '5451062934', pais_destino: 'Países Bajos', peso_real: 5, largo: 30, ancho: 20, alto: 20, fob: 500, total_cobrado: 300, ddp: 1 })).body;
    const eUps = (await J('POST', '/envios', { cliente_id: cli.id, fecha: '2026-10-20', courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'importacion', numero_guia: '1Z3R6A458891288906', pais_destino: 'Estados Unidos', peso_real: 28.5, largo: 50, ancho: 40, alto: 40, fob: 500, total_cobrado: 700 })).body;
    await J('POST', '/liquidaciones', { cliente_id: cli.id, periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', envio_ids: [eDhl.id], confirmar: true });
    const salida = async (id) => (await J('GET', '/salidas?desde=2026-10-01&hasta=2026-10-31')).body.find((x) => x.id === id);

    const chD = await subir('chequear', F_DHL);
    check('DHL: el chequeo previo la presenta como impuestos, 1 guía, cuadra', chD.status === 200 && chD.body.tipo === 'impuestos' && chD.body.guias_total === 1 && chD.body.reconciliacion.cuadra === true && chD.body.guias_sin_costo.length === 0, JSON.stringify(chD.body).slice(0, 300));
    const caD = await subir('cargar', F_DHL);
    check('DHL: se carga, 1 guardada, ninguna sin costo', caD.status === 200 && caD.body.guardadas === 1 && caD.body.sin_costo === 0 && caD.body.tipo === 'impuestos', JSON.stringify(caD.body).slice(0, 300));
    const sD = await salida(eDhl.id);
    check('   el envío queda con impuestos facturados 75,59 y SIN tocar el costo del flete', sD && cerca(sD.impuestos_facturados, 75.59) && sD.costo_facturado == null, JSON.stringify(sD && [sD.impuestos_facturados, sD.costo_facturado]));
    check('   y genera el cargo "Impuestos de destino (DDP)" de 75,59, pendiente de liquidar (el envío ya estaba liquidado)', sD && (sD.cargos || []).some((c) => c.tipo === 'ddp' && cerca(c.monto, 75.59) && c.liquidacion_id == null), JSON.stringify(sD && sD.cargos));
    const prev = (await J('POST', '/liquidaciones/preview', { cliente_id: cli.id, envio_ids: [] })).body;
    check('   la próxima liquidación del cliente lo trae como cargo de envío anterior', prev && (prev.cargos_anteriores || []).some((c) => cerca(c.monto, 75.59)), JSON.stringify(prev && prev.cargos_anteriores));

    const caU = await subir('cargar', F_U1);
    check('UPS gastos: se carga (ya no dice "No se detectó ninguna guía")', caU.status === 200 && caU.body.guardadas === 1 && caU.body.numero_factura === '0027-00014363', JSON.stringify(caU.body).slice(0, 300));
    const sU = await salida(eUps.id);
    check('   la importación queda con costo facturado 398,39 y sus recargos (seguro, etiqueta, temporada alta)', sU && cerca(sU.costo_facturado, 398.39) && (sU.recargos_facturados || []).length === 3, JSON.stringify(sU && [sU.costo_facturado, sU.recargos_facturados]));
    const caU2 = await subir('cargar', F_U2);
    check('   la otra (sin envío cargado) entra y queda en "Sin envío" con su costo 202,47', caU2.status === 200 && caU2.body.no_encontradas === 1 && (await J('GET', '/facturas/sin-envio')).body.guias.some((x) => x.numero_guia === '1Z3R6A458891997720' && cerca(x.costo_total, 202.47)), JSON.stringify(caU2.body).slice(0, 200));
    const otra = await subir('cargar', F_U1);
    check('   volver a subir la misma: 409 "ya fue cargada"', otra.status === 409 && /ya fue cargada/.test(otra.body.error), JSON.stringify(otra.body));
    matar();
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 2500).unref();
})().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
