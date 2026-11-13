#!/usr/bin/env node
// Comisiones: kilos que lleva cada vendedor (13/11/2026, Felipe).
//   · kg = peso FACTURABLE de los mismos envíos que cuentan para la venta y la utilidad;
//   · por vendedor, por cliente, por envío y en el total; también en el Excel;
//   · un envío que no voló no suma kilos (igual que no suma venta);
//   · la plata no cambia por mostrar los kilos.
const DB = process.env.DB_PATH_TEST || '/tmp/test_comisiones_kg.db';
process.env.DB_PATH = DB;
const path = require('path');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = Number(process.env.PORT_TEST || 4000);
const BASE = `http://localhost:${PORT}`;
const TOKEN = 'token-test-comisiones-kg';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const cerca = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production', SALUD_AUTO: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  process.on('exit', () => { try { srv.kill(); } catch {} });
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  const MES = '2026-10';
  const antes = (await J('GET', `/comisiones/resumen?mes=${MES}`)).body;
  const cliA = (await J('POST', '/clientes', { nombre: 'KILOS A SA', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  const cliB = (await J('POST', '/clientes', { nombre: 'KILOS B SA', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  const cliC = (await J('POST', '/clientes', { nombre: 'KILOS SIN VENDEDOR', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  const ana = (await J('POST', '/comisiones/vendedores', { nombre: 'Ana Kilos', comision_pct: 30 })).body;
  const beto = (await J('POST', '/comisiones/vendedores', { nombre: 'Beto Kilos', comision_pct: 20 })).body;
  const vA = ana.vendedor || ana, vB = beto.vendedor || beto;
  check('se crean los dos vendedores', vA.id && vB.id, JSON.stringify(ana));
  check('asignar A → Ana y B → Beto', (await J('PUT', `/comisiones/clientes/${cliA.id}`, { vendedor_id: vA.id })).status === 200 && (await J('PUT', `/comisiones/clientes/${cliB.id}`, { vendedor_id: vB.id })).status === 200);

  let n = 0;
  const mk = async (cliente_id, extra) => {
    const r = await J('POST', '/envios', { cliente_id, fecha: '2026-10-16', courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion', numero_guia: `1Z327W09679100${String(++n).padStart(4, '0')}`, pais_destino: 'Estados Unidos', peso_real: 10, largo: 20, ancho: 20, alto: 20, fob: 300, total_cobrado: 400, ...extra });
    if (r.status >= 300) throw new Error('no se pudo crear el envío: ' + JSON.stringify(r.body));
    return (await J('GET', `/envios/${r.body.id}`)).body;
  };
  const a1 = await mk(cliA.id, { peso_real: 30, largo: 40, ancho: 40, alto: 40 });           // pesa más que su volumen
  const a2 = await mk(cliA.id, { peso_real: 2, largo: 50, ancho: 50, alto: 50 });            // volumétrico: 25 kg
  const b1 = await mk(cliB.id, { peso_real: 7.5, largo: 20, ancho: 20, alto: 20 });
  const c1 = await mk(cliC.id, { peso_real: 12, largo: 20, ancho: 20, alto: 20 });
  const nv = await mk(cliA.id, { peso_real: 80, largo: 20, ancho: 20, alto: 20 });           // no voló

  console.log('\n1. Los kilos de cada vendedor\n');
  check('el envío volumétrico factura más kilos que los que pesa', a2.peso_facturable > 2, `facturable ${a2.peso_facturable}`);
  check('se marca el quinto envío como NO VOLÓ', (await J('PATCH', `/salidas/${nv.id}/no-volo`, { no_volo: true })).status === 200);

  const r = (await J('GET', `/comisiones/resumen?mes=${MES}`)).body;
  const gA = r.vendedores.find((g) => g.vendedor_id === vA.id);
  const gB = r.vendedores.find((g) => g.vendedor_id === vB.id);
  const kgA = a1.peso_facturable + a2.peso_facturable;
  check(`Ana: ${kgA} kg (facturables de sus 2 envíos)`, gA && cerca(gA.kg, kgA) && gA.envios === 2, gA && `kg ${gA.kg} envíos ${gA.envios}`);
  check(`Beto: ${b1.peso_facturable} kg`, gB && cerca(gB.kg, b1.peso_facturable) && gB.envios === 1, gB && `kg ${gB.kg}`);
  check('el que no voló no suma kilos (ni envíos)', gA && gA.kg < 80);
  check('por cliente: los kilos del cliente dentro del vendedor', gA && gA.clientes.length === 1 && cerca(gA.clientes[0].kg, kgA));
  check('cliente sin vendedor: sus kilos van a "Sin asignar"', cerca(r.sin_asignar.kg - (antes.sin_asignar.kg || 0), c1.peso_facturable), `sin asignar ${r.sin_asignar.kg}`);
  const sumaGrupos = r.vendedores.reduce((a, g) => a + g.kg, 0) + r.sin_asignar.kg;
  check('total del mes = suma de todos los vendedores + sin asignar', cerca(r.total.kg, sumaGrupos), `total ${r.total.kg} · suma ${sumaGrupos}`);
  check('total del mes sube exactamente los kilos cargados', cerca(r.total.kg - (antes.total.kg || 0), kgA + b1.peso_facturable + c1.peso_facturable));
  check('un vendedor sin envíos muestra 0 kg (no vacío)', r.vendedores.every((g) => typeof g.kg === 'number'));

  console.log('\n2. La plata no se toca\n');
  check('venta de Ana = 800 y de Beto = 400', gA && cerca(gA.venta, 800) && gB && cerca(gB.venta, 400), gA && `${gA.venta} / ${gB && gB.venta}`);
  check('comisión = utilidad × %', gA && cerca(gA.comision, gA.clientes.reduce((a, c) => a + c.comision, 0)) && Math.abs(gA.comision - gA.utilidad * 0.30) < 0.02, gA && `com ${gA.comision} util ${gA.utilidad}`);

  console.log('\n3. Detalle por envío y Excel\n');
  const det = (await J('GET', `/comisiones/detalle?mes=${MES}&vendedor=${vA.id}`)).body.envios;
  check('detalle: cada envío trae sus kilos', det.length === 2 && det.every((e) => e.kg > 0) && cerca(det.reduce((a, e) => a + e.kg, 0), kgA), JSON.stringify(det.map((e) => e.kg)));
  const x = await fetch(`${BASE}/api/comisiones/resumen.xlsx?mes=${MES}`, { headers: H });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
  const ws = wb.getWorksheet('Resumen');
  const cab = ws.getRow(1).values.map(String);
  const col = cab.indexOf('Kg');
  check('Excel: la hoja Resumen tiene la columna Kg', x.status === 200 && col > 0, cab.join('|'));
  let filaAna = null; ws.eachRow((row) => { if (row.getCell(2).value === 'TOTAL Ana Kilos') filaAna = row; });
  check('Excel: los kilos de Ana coinciden con la pantalla', filaAna && cerca(filaAna.getCell(col).value, kgA), filaAna && String(filaAna.getCell(col).value));
  const hoja = wb.getWorksheet('Ana Kilos');
  const colH = hoja ? hoja.getRow(1).values.map(String).indexOf('Kg') : -1;
  check('Excel: la hoja del vendedor trae los kilos de cada envío', hoja && colH > 0 && cerca(hoja.getRow(2).getCell(colH).value + hoja.getRow(3).getCell(colH).value, kgA));

  console.log(`\n${ok} OK · ${fail} con error\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
