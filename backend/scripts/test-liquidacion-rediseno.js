#!/usr/bin/env node
// Rediseño de la liquidación (04/11/2026, pedido de Felipe):
//   · Excel o PDF, mismo documento (liquidacion-documento.js).
//   · Un solo formato: sin FOB ni DERECHOS, desglose debajo de cada envío en la columna
//     "Desglose de adicional", DESTINATARIO solo si algún envío lo tiene, envío sombreado y
//     desglose en blanco, cabecera con recuadro de datos.
//   · Los cargos posteriores del propio envío van SIN "informado el…"; en "Cargos de envíos
//     anteriores" la fecha queda.
//   · La diferencia de fuel (tipo 'fuel', o "Fuel" cargado como "otro") se suma a la columna
//     FUEL del envío, no al Adicional. Si el envío ya estaba liquidado, va como cargo anterior.
//   · Liquidaciones de antes del 04/11 (fuel adentro del Adicional) se siguen leyendo bien.
const path = require('path');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3994;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_liquidacion_rediseno.db';
// La sección 5 abre la base desde este proceso: el config lee DB_PATH al cargarse.
process.env.DB_PATH = DB;
const TOKEN = 'token-test-liq-rediseno';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const cerca = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const J = (m, u, b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const excelDe = async (id) => {
    const r = await fetch(BASE + `/api/liquidaciones/${id}/export`, { headers: { Cookie: `nova_session=${TOKEN}` } });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
    const ws = wb.getWorksheet('Liquidacion');
    const cab = []; ws.getRow(7).eachCell((c) => cab.push(String(c.value)));
    const col = (k) => cab.indexOf(k) + 1;
    const filas = []; ws.eachRow((row, n) => { if (n >= 8) filas.push({ n, row, c1: row.getCell(1).value, guia: String(row.getCell(2).value ?? ''), desglose: String(row.getCell(col('DESGLOSE DE ADICIONAL')).value ?? ''), fuel: row.getCell(col('FUEL')).value, adic: row.getCell(col('ADICIONAL')).value, total: row.getCell(col('TOTAL USD')).value }); });
    const textos = []; ws.eachRow((row) => row.eachCell((c) => { if (c.value != null) textos.push(String(c.value)); }));
    return { ws, cab, col, filas, textos };
  };

  const cli = (await J('POST', '/api/clientes', { nombre: 'REDISENO LIQ SA', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  const mk = (guia, extra = {}) => J('POST', '/api/envios', { cliente_id: cli.id, fecha: '2026-10-10', courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion', numero_guia: guia, pais_destino: 'Reino Unido', peso_real: 5, largo: 30, ancho: 20, alto: 15, fob: 100, total_cobrado: 200, ...extra }).then((r) => r.body);
  const eA = await mk('1Z000RED000000001');
  const eB = await mk('1Z000RED000000002');
  const eC = await mk('1Z000RED000000003');
  check('fixture: 3 envíos', eA.id && eB.id && eC.id);

  console.log('\n1. Diferencia de fuel → columna FUEL; cargo del envío sin "informado el"\n');
  const cFuel = (await J('POST', `/api/salidas/${eA.id}/cargos`, { tipo: 'fuel', monto: 10, fecha: '2026-11-03' })).body;
  check('el tipo "fuel" existe y se rotula "Diferencia de fuel"', cFuel.id && cFuel.label === 'Diferencia de fuel', JSON.stringify(cFuel));
  const cFuelViejo = (await J('POST', `/api/salidas/${eB.id}/cargos`, { tipo: 'otro', label: 'Fuel', monto: 4.5, fecha: '2026-11-03' })).body;
  const cSobre = (await J('POST', `/api/salidas/${eB.id}/cargos`, { tipo: 'sobrepeso', monto: 12.5, fecha: '2026-11-03' })).body;
  check('fixture: "Fuel" como otro + sobrepeso en B', cFuelViejo.id && cSobre.id);
  const base = (await J('POST', '/api/liquidaciones/preview', { cliente_id: cli.id, envio_ids: [eC.id] })).body.items[0];
  const prev = (await J('POST', '/api/liquidaciones/preview', { cliente_id: cli.id, envio_ids: [eA.id, eB.id, eC.id] })).body;
  const iA = prev.items.find((i) => i.envio_id === eA.id);
  const iB = prev.items.find((i) => i.envio_id === eB.id);
  check('A: el fuel del ítem = fuel base + 10, adicional sin cambios, total + 10', cerca(iA.fuel, base.fuel + 10) && cerca(iA.adicional, base.adicional) && cerca(iA.total_usd, base.total_usd + 10) && cerca(iA.fuel_diferencia, 10), JSON.stringify([iA.fuel, base.fuel, iA.adicional, base.adicional, iA.total_usd, base.total_usd]));
  check('   y el desglose del Adicional NO tiene línea de fuel', !iA.adicional_detalle.some((d) => /fuel/i.test(d.label) && d.tipo === 'cargo'), JSON.stringify(iA.adicional_detalle));
  check('   flete + fuel + seguro + adicional = total', cerca(iA.flete + iA.fuel + iA.seguro + iA.adicional, iA.total_usd));
  check('B: el "Fuel" cargado como "otro" también va al FUEL (+4,50) y el sobrepeso al Adicional (+12,50)', cerca(iB.fuel, base.fuel + 4.5) && cerca(iB.adicional, base.adicional + 12.5) && cerca(iB.total_usd, base.total_usd + 17), JSON.stringify([iB.fuel, iB.adicional, iB.total_usd]));
  check('   el sobrepeso se rotula "Sobrepeso", sin fecha', iB.adicional_detalle.some((d) => d.label === 'Sobrepeso' && cerca(d.monto, 12.5)) && !iB.adicional_detalle.some((d) => /informado el/.test(d.label)), JSON.stringify(iB.adicional_detalle));
  check('   total de la liquidación = suma de los tres', cerca(prev.total, iA.total_usd + iB.total_usd + base.total_usd));

  const liq = (await J('POST', '/api/liquidaciones', { cliente_id: cli.id, periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', envio_ids: [eA.id, eB.id, eC.id], confirmar: true })).body;
  const gA = liq.items.find((i) => i.envio_id === eA.id);
  const gB = liq.items.find((i) => i.envio_id === eB.id);
  check('guardada y releída: A conserva el fuel con la diferencia y fuel_diferencia 10', liq.estado === 'confirmada' && cerca(gA.fuel, base.fuel + 10) && cerca(gA.fuel_diferencia, 10) && !gA.adicional_detalle.some((d) => /fuel/i.test(d.label) && d.tipo === 'cargo'), JSON.stringify([liq.estado, gA.fuel, base.fuel, gA.fuel_diferencia, gA.adicional_detalle]));
  check('   B: "Sobrepeso" sin fecha, fuel 4,50 sumado', gB.adicional_detalle.some((d) => d.label === 'Sobrepeso') && cerca(gB.fuel_diferencia, 4.5) && cerca(gB.fuel, base.fuel + 4.5), JSON.stringify([gB.fuel, gB.fuel_diferencia, gB.adicional_detalle]));

  console.log('\n2. El Excel: un solo formato\n');
  const x = await excelDe(liq.id);
  check('cabecera sin FOB ni DERECHOS, con DESGLOSE DE ADICIONAL antes de ADICIONAL, sin DESTINATARIO', !x.cab.includes('FOB') && !x.cab.includes('DERECHOS') && !x.cab.includes('DESTINATARIO') && x.col('DESGLOSE DE ADICIONAL') === x.col('ADICIONAL') - 1 && x.cab[x.cab.length - 1] === 'TOTAL USD', x.cab.join('|'));
  const fA = x.filas.find((f) => f.guia === eA.numero_guia);
  const fB = x.filas.find((f) => f.guia === eB.numero_guia);
  check('la fila de A lleva el fuel con la diferencia y ningún renglón ↳ de fuel', fA && cerca(fA.fuel, base.fuel + 10) && !x.textos.some((t) => /↳ .*fuel/i.test(t) && !/Surge/.test(t)), JSON.stringify([fA && fA.fuel, x.textos.filter((t) => /↳/.test(t))]));
  const subB = x.filas.filter((f) => f.n > fB.n && /^↳ /.test(f.desglose) && f.n < fB.n + 6);
  check('debajo de B va "↳ Sobrepeso" con 12,50 en la columna ADICIONAL', subB.some((f) => f.desglose === '↳ Sobrepeso' && cerca(f.adic, 12.5)), JSON.stringify(subB.map((f) => [f.desglose, f.adic])));
  check('el envío va sombreado y el desglose en blanco', fB.row.getCell(1).fill?.fgColor?.argb === 'FFEAF1F8' && subB[0].row.getCell(1).fill?.fgColor?.argb === 'FFFFFFFF', JSON.stringify([fB.row.getCell(1).fill?.fgColor, subB[0].row.getCell(1).fill?.fgColor]));
  check('la cabecera tiene el título en C1 y el recuadro de datos (Cliente / Período / Fecha / Liquidación)', String(x.ws.getCell('C1').value) === 'LIQUIDACIÓN CUENTA CORRIENTE' && x.textos.includes('Cliente') && x.textos.includes('Período') && x.textos.includes('Liquidación') && x.textos.some((t) => new RegExp(`^Nº ${liq.id} · Cuenta corriente$`).test(t)), x.textos.slice(0, 12).join('|'));
  const tot = x.filas.find((f) => f.c1 === 'TOTAL');
  check('TOTAL (sin secciones) cierra en la última columna con la suma', tot && cerca(tot.total, liq.total), JSON.stringify(tot && [tot.c1, tot.total, liq.total]));

  console.log('\n3. Cargos de envíos anteriores: la fecha queda; la diferencia de fuel tardía va ahí\n');
  const cTarde = (await J('POST', `/api/salidas/${eA.id}/cargos`, { tipo: 'fuel', monto: 3.3, fecha: '2026-11-04' })).body;
  const cTarde2 = (await J('POST', `/api/salidas/${eC.id}/cargos`, { tipo: 'remota', monto: 20, fecha: '2026-11-04' })).body;
  const eD = await mk('1Z000RED000000004', { fecha: '2026-11-02', destinatario_nombre: 'Tienda Norte' });
  const prev2 = (await J('POST', '/api/liquidaciones/preview', { cliente_id: cli.id, envio_ids: [eD.id] })).body;
  check('los dos cargos tardíos entran como cargos anteriores', prev2.cargos_anteriores.length === 2 && prev2.cargos_anteriores.some((c) => c.id === cTarde.id) && prev2.cargos_anteriores.some((c) => c.id === cTarde2.id), JSON.stringify(prev2.cargos_anteriores));
  check('   y el ítem de D no recibe fuel ajeno', cerca(prev2.items[0].fuel_diferencia, 0));
  const liq2 = (await J('POST', '/api/liquidaciones', { cliente_id: cli.id, periodo_desde: '2026-11-01', periodo_hasta: '2026-11-30', envio_ids: [eD.id], confirmar: true })).body;
  const x2 = await excelDe(liq2.id);
  check('con un envío con destinatario, la columna DESTINATARIO aparece como tercera', x2.cab[2] === 'DESTINATARIO' && String(x2.ws.getCell(8, 3).value) === 'Tienda Norte', x2.cab.join('|'));
  check('la sección de cargos anteriores conserva "informado el" y nombra el fuel', x2.textos.some((t) => /^Diferencia de fuel · informado el 04\/11\/2026 · envío a Reino Unido, cobrado en la liquidación #\d+$/.test(t)) && x2.textos.some((t) => /^Área remota · informado el 04\/11\/2026/.test(t)), x2.textos.filter((t) => /informado/.test(t)).join(' | '));
  check('   con TOTAL ENVÍOS y TOTAL LIQUIDACIÓN', x2.textos.includes('TOTAL ENVÍOS') && x2.textos.includes('TOTAL LIQUIDACIÓN') && cerca(liq2.total, liq2.total_envios + 23.3));

  console.log('\n4. PDF\n');
  const rp = await fetch(BASE + `/api/liquidaciones/${liq2.id}/export.pdf`, { headers: { Cookie: `nova_session=${TOKEN}` } });
  const bp = Buffer.from(await rp.arrayBuffer());
  check('export.pdf devuelve un PDF con nombre CUENTA_CORRIENTE_…pdf', rp.status === 200 && rp.headers.get('content-type') === 'application/pdf' && bp.slice(0, 5).toString('latin1') === '%PDF-' && /filename="CUENTA_CORRIENTE_REDISENOLIQSAEnvio\d{8}\.pdf"/.test(rp.headers.get('content-disposition') || ''), `${rp.status} ${rp.headers.get('content-disposition')}`);
  const rx = await fetch(BASE + `/api/liquidaciones/${liq2.id}/export`, { headers: { Cookie: `nova_session=${TOKEN}` } });
  check('   y el Excel sigue saliendo como .xlsx', rx.status === 200 && /\.xlsx"/.test(rx.headers.get('content-disposition') || ''));
  const { usd } = require('../src/services/liquidacion-pdf.service');
  check('los importes del PDF van en formato argentino', usd(1294.76) === '$1.294,76' && usd(0) === '$0,00' && usd(-3.5) === '-$3,50');

  console.log('\n5. Liquidación de antes del 04/11 (fuel adentro del Adicional) se sigue leyendo\n');
  const { initDb, getDb } = require('../src/db');
  await initDb();
  const db = getDb();
  // Se simula la forma vieja: el fuel de A pasa de la columna FUEL al Adicional.
  await db.prepare('UPDATE liquidacion_items SET fuel = fuel - 10, adicional = adicional + 10 WHERE liquidacion_id = ? AND envio_id = ?').run(liq.id, eA.id);
  const filaDb = await db.prepare('SELECT fuel, adicional FROM liquidacion_items WHERE liquidacion_id = ? AND envio_id = ?').get(liq.id, eA.id);
  check('   (fixture) la fila quedó con el fuel movido al adicional', cerca(filaDb.fuel, base.fuel) && cerca(filaDb.adicional, base.adicional + 10), JSON.stringify([filaDb, require('../src/config').dbPath]));
  const viejo = (await J('GET', `/api/liquidaciones/${liq.id}`)).body;
  const vA = viejo.items.find((i) => i.envio_id === eA.id);
  check('el fuel vuelve como línea del desglose y fuel_diferencia queda en 0', cerca(vA.fuel_diferencia, 0) && vA.adicional_detalle.some((d) => d.label === 'Diferencia de fuel' && cerca(d.monto, 10)), JSON.stringify([vA.fuel_diferencia, vA.adicional_detalle]));
  check('   y el Excel lo muestra con ↳', (await excelDe(liq.id)).textos.includes('↳ Diferencia de fuel'));

  matar();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 2500).unref();
})().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
