#!/usr/bin/env node
/**
 * test-liquidacion-desglose.js — lo del 07/09/2026 en Liquidaciones (pedidos de Felipe):
 *
 *   1. El Adicional se DESGLOSA: surge (con su fuel), GoGreen, manejo, remota, derechos,
 *      otros, y el extra manual de la liquidación. La suma cierra exacto en la columna.
 *      "¿Dónde va el GoGreen?": en Adicional, con el surge — nunca en el flete.
 *   2. La vista previa muestra el PROFIT por envío (dato interno, solo pantalla).
 *   3. El Excel lleva logo y colores Nova, y el título/archivo dicen DIARIO / SEMANAL /
 *      QUINCENAL / CUENTA CORRIENTE según el cobro del cliente (antes: siempre "DIARIO").
 *   4. El Excel trae la tabla "Detalle de adicionales" y NO trae el profit.
 *
 *   cd backend && node scripts/test-liquidacion-desglose.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3937;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_liquidacion_desglose.db';
const TOKEN = 'token-test-liq-desglose';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (n) => Math.round(n * 100) / 100;

async function main() {
  prepararDb(DB);
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

  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
  const hoy = new Date().toISOString().slice(0, 10);

  console.log('\n1. Un cliente SEMANAL con un envío UPS (surge + manejo) y uno DHL (GoGreen)\n');
  const cli = await j(await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H,
    body: JSON.stringify({ nombre: 'DESGLOSE SEMANAL', tarifa_pct: 75, tipo_cobro: 'S' }),
  }));
  check('cliente creado con cobro semanal', !!cli.id, JSON.stringify(cli).slice(0, 100));

  const ups = await j(await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP',
      numero_guia: '1Z000DESG000000001', pais_destino: 'Estados Unidos', fob: 120, total_cobrado: 400,
      bultos: [{ peso_real: 30, largo: 60, ancho: 50, alto: 50 }],   // 30 kg reales → manejo UPS (>25)
    }),
  }));
  const dhl = await j(await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'DHL', tipo_envio: 'exportacion',
      numero_guia: 'DHLDESG000000002', pais_destino: 'Estados Unidos', fob: 120, total_cobrado: 250,
      bultos: [{ peso_real: 5, largo: 30, ancho: 20, alto: 20 }],
    }),
  }));
  check('se cargaron los dos envíos', !!ups.id && !!dhl.id, JSON.stringify({ u: ups.id, d: dhl.id }));
  const extrasUps = JSON.parse(ups.extras_json || '[]');
  const extrasDhl = JSON.parse(dhl.extras_json || '[]');
  check('el UPS congeló surge y manejo en extras_json', extrasUps.some((x) => x.tipo === 'surge') && extrasUps.some((x) => x.tipo === 'manejo'),
    JSON.stringify(extrasUps.map((x) => x.tipo)));
  check('el DHL congeló el GoGreen en extras_json', extrasDhl.some((x) => x.tipo === 'gogreen'), JSON.stringify(extrasDhl.map((x) => x.tipo)));

  console.log('\n2. La vista previa desglosa el Adicional y trae el profit\n');
  const prev = await j(await fetch(BASE + '/api/liquidaciones/preview', {
    method: 'POST', headers: H,
    body: JSON.stringify({ cliente_id: cli.id, envio_ids: [ups.id, dhl.id], cargos: [{ envio_id: ups.id, descripcion: 'Embalaje', monto: 12 }] }),
  }));
  const itUps = prev.items.find((i) => i.envio_id === ups.id);
  const itDhl = prev.items.find((i) => i.envio_id === dhl.id);
  check('cada ítem trae adicional_detalle', Array.isArray(itUps?.adicional_detalle) && Array.isArray(itDhl?.adicional_detalle));
  const labelsUps = (itUps.adicional_detalle || []).map((d) => d.label);
  check('UPS: el surge aparece CON su fuel', labelsUps.includes('Surge fee (con fuel)'), labelsUps.join(' | '));
  const surgeLinea = itUps.adicional_detalle.find((d) => d.tipo === 'surge');
  const surgeCrudo = extrasUps.find((x) => x.tipo === 'surge').monto;
  check('  y su monto es surge × (1 + fuel)', surgeLinea && Math.abs(surgeLinea.monto - r2(surgeCrudo * (1 + itUps.fuel_pct_usado / 100))) < 0.011,
    `${surgeLinea && surgeLinea.monto} vs ${surgeCrudo} × (1 + ${itUps.fuel_pct_usado}%)`);
  check('UPS: el manejo adicional aparece', labelsUps.includes('Manejo adicional'), labelsUps.join(' | '));
  check('UPS: el extra manual de la liquidación aparece con su nombre', labelsUps.includes('Embalaje'), labelsUps.join(' | '));
  const sumaUps = r2(itUps.adicional_detalle.reduce((s, d) => s + d.monto, 0));
  check('UPS: la suma del detalle es EXACTAMENTE la columna Adicional', Math.abs(sumaUps - itUps.adicional) < 0.005, `${sumaUps} vs ${itUps.adicional}`);
  const labelsDhl = (itDhl.adicional_detalle || []).map((d) => d.label);
  check('DHL: el GoGreen está en el Adicional (no en el flete)', labelsDhl.includes('GoGreen'), labelsDhl.join(' | '));
  const goGreen = itDhl.adicional_detalle.find((d) => d.tipo === 'gogreen');
  check('  con su monto (0,98 × kg facturable)', goGreen && Math.abs(goGreen.monto - r2(0.98 * dhl.peso_facturable)) < 0.011, `${goGreen && goGreen.monto} vs ${r2(0.98 * dhl.peso_facturable)}`);
  const sumaDhl = r2(itDhl.adicional_detalle.reduce((s, d) => s + d.monto, 0));
  check('DHL: la suma del detalle cierra en Adicional', Math.abs(sumaDhl - itDhl.adicional) < 0.005, `${sumaDhl} vs ${itDhl.adicional}`);
  check('el flete + fuel + seguro + adicional sigue cerrando en el total (invariante)',
    prev.items.every((i) => Math.abs((i.flete + i.fuel + i.seguro + i.adicional) - i.total_usd) < 0.011));
  check('el profit interno viaja por ítem (profit_pct y utilidad_usd)', itUps.profit_pct != null && itUps.utilidad_usd != null, JSON.stringify({ p: itUps.profit_pct, u: itUps.utilidad_usd }));

  console.log('\n3. Confirmada, el detalle sigue estando y el Excel sale con el cobro del cliente\n');
  const liq = await j(await fetch(BASE + '/api/liquidaciones', {
    method: 'POST', headers: H,
    body: JSON.stringify({ cliente_id: cli.id, periodo_desde: hoy, periodo_hasta: hoy, envio_ids: [ups.id, dhl.id],
      cargos: [{ envio_id: ups.id, descripcion: 'Embalaje', monto: 12 }], confirmar: true }),
  }));
  check('liquidación confirmada', !!liq.id && liq.estado === 'confirmada', JSON.stringify({ id: liq.id, e: liq.estado }));
  const liqGet = await j(await fetch(BASE + `/api/liquidaciones/${liq.id}`, { headers: H }));
  const itG = liqGet.items.find((i) => i.envio_id === ups.id);
  check('GET /:id trae adicional_detalle en cada ítem', Array.isArray(itG?.adicional_detalle) && itG.adicional_detalle.length >= 3, JSON.stringify(itG && itG.adicional_detalle));
  check('  con el mismo desglose que la vista previa', JSON.stringify(itG.adicional_detalle) === JSON.stringify(itUps.adicional_detalle));
  const itGD = liqGet.items.find((i) => i.envio_id === dhl.id);
  check('  el DHL sin extra manual NO duplica el GoGreen con la fila espejo "Cargo adicional"',
    itGD && itGD.adicional_detalle.length === 1 && Math.abs(itGD.adicional_detalle[0].monto - itGD.adicional) < 0.005, JSON.stringify(itGD && itGD.adicional_detalle));
  check('GET /:id trae el tipo de cobro del cliente', liqGet.tipo_cobro === 'S', liqGet.tipo_cobro);

  const rx = await fetch(BASE + `/api/liquidaciones/${liq.id}/export`, { headers: { Cookie: `nova_session=${TOKEN}` } });
  check('el export responde 200', rx.status === 200, `${rx.status}`);
  const disp = rx.headers.get('content-disposition') || '';
  check('el archivo se llama SEMANAL_… (no DIARIO_)', /filename="SEMANAL_/.test(disp) && !/DIARIO/.test(disp), disp);
  const buf = Buffer.from(await rx.arrayBuffer());
  const outPath = process.env.XLSX_OUT || path.join(require('os').tmpdir(), 'liquidacion-desglose-test.xlsx');
  fs.writeFileSync(outPath, buf);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Liquidacion');
  check('el título dice LIQUIDACIÓN SEMANAL', String(ws.getCell('D1').value) === 'LIQUIDACIÓN SEMANAL', String(ws.getCell('D1').value));
  check('el título va en azul Nova', (ws.getCell('D1').font || {}).color?.argb === 'FF2A3661', JSON.stringify(ws.getCell('D1').font));
  check('el Excel lleva el logo', (ws.getImages() || []).length === 1, `${(ws.getImages() || []).length}`);
  const textos = [];
  ws.eachRow((row) => row.eachCell((c) => { if (c.value != null) textos.push(String(c.value.richText ? c.value.richText.map((t) => t.text).join('') : c.value)); }));
  check('la cabecera de la tabla va en azul con letra blanca', ws.getCell('A7').fill?.fgColor?.argb === 'FF2A3661' && ws.getCell('A7').font?.color?.argb === 'FFFFFFFF');
  check('la fila TOTAL va en coral', textos.includes('TOTAL') && (() => { let f = null; ws.eachRow((row) => { if (row.getCell(1).value === 'TOTAL') f = row.getCell(1).fill?.fgColor?.argb; }); return f === 'FFEA6749'; })());
  check('hay una sección "DETALLE DE ADICIONALES"', textos.includes('DETALLE DE ADICIONALES'));
  check('  con la línea del GoGreen', textos.includes('GoGreen'));
  check('  con el surge con fuel', textos.includes('Surge fee (con fuel)'));
  check('  y con el extra manual', textos.includes('Embalaje'));
  check('el Excel NO muestra el profit (dato interno)', !textos.some((t) => /profit|utilidad/i.test(t)));
  console.log(`   (Excel de muestra en ${outPath})`);

  console.log('\n4. Otro cliente, cuenta corriente: el título y el archivo cambian\n');
  const cli2 = await j(await fetch(BASE + '/api/clientes', { method: 'POST', headers: H, body: JSON.stringify({ nombre: 'DESGLOSE CC', tarifa_pct: 75, tipo_cobro: 'CC' }) }));
  const e2 = await j(await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({ cliente_id: cli2.id, fecha: hoy, courier: 'DHL', tipo_envio: 'exportacion', numero_guia: 'DHLDESGCC0000003',
      pais_destino: 'Estados Unidos', fob: 50, total_cobrado: 100, bultos: [{ peso_real: 2, largo: 20, ancho: 20, alto: 20 }] }),
  }));
  const liq2 = await j(await fetch(BASE + '/api/liquidaciones', {
    method: 'POST', headers: H, body: JSON.stringify({ cliente_id: cli2.id, periodo_desde: hoy, periodo_hasta: hoy, envio_ids: [e2.id], confirmar: true }),
  }));
  const rx2 = await fetch(BASE + `/api/liquidaciones/${liq2.id}/export`, { headers: { Cookie: `nova_session=${TOKEN}` } });
  const disp2 = rx2.headers.get('content-disposition') || '';
  check('archivo CUENTA_CORRIENTE_…', /filename="CUENTA_CORRIENTE_/.test(disp2), disp2);
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(Buffer.from(await rx2.arrayBuffer()));
  check('título LIQUIDACIÓN CUENTA CORRIENTE', String(wb2.getWorksheet('Liquidacion').getCell('D1').value) === 'LIQUIDACIÓN CUENTA CORRIENTE');

  console.log('\n5. Pantalla: la vista previa muestra profit y desglose\n');
  let chromium = null;
  try { ({ chromium } = require('playwright')); } catch { chromium = null; }
  if (!chromium) {
    console.log('  ⚠ playwright no está instalado — se saltea la parte de pantalla.');
  } else {
    // Un tercer envío sin liquidar del cliente semanal, para que aparezca en Pendientes.
    const e3 = await j(await fetch(BASE + '/api/envios', {
      method: 'POST', headers: H,
      body: JSON.stringify({ cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP',
        numero_guia: '1Z000DESG000000004', pais_destino: 'Estados Unidos', fob: 120, total_cobrado: 300, bultos: [{ peso_real: 30, largo: 60, ancho: 50, alto: 50 }] }),
    }));
    const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
      '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
    const exe = cand.find((p) => fs.existsSync(p));
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', (e) => errores.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errores.push(m.text()); });

    await page.goto(BASE + '/pages/liquidaciones.html', { waitUntil: 'networkidle' });
    await esperar(1500);
    const entro = await page.evaluate((id) => {
      const btn = document.querySelector(`#pendientes-list [data-liq-cliente="${id}"]`);
      if (!btn) return false;
      btn.click();
      return true;
    }, cli.id);
    check('se entró a liquidar al cliente semanal desde Pendientes', entro);
    await esperar(1500);
    await page.click('#btn-preview');
    await esperar(1500);
    const filaPrev = await page.evaluate((guia) => {
      const tr = [...document.querySelectorAll('#liq-preview-body tr')].find((t) => t.textContent.includes(guia));
      if (!tr) return null;
      const tds = [...tr.querySelectorAll('td')];
      return {
        cols: tds.length,
        profit: tds[6]?.textContent.trim(),
        adic: tds[4]?.textContent.trim(),
        detalle: tr.querySelector('.liq-adic-detalle')?.textContent.trim() || '',
        th: [...document.querySelectorAll('#liq-preview thead th')].map((t) => t.textContent.trim()),
      };
    }, '1Z000DESG000000004');
    check('la fila del envío está en la vista previa', !!filaPrev, JSON.stringify(filaPrev));
    check('hay columna "Profit (interno)"', filaPrev && filaPrev.th.includes('Profit (interno)'), filaPrev && filaPrev.th.join(' | '));
    check('el profit del envío se muestra como % · US$', filaPrev && /\d+(\.\d+)?% · US?\$/.test(filaPrev.profit), filaPrev && filaPrev.profit);
    check('el Adicional trae el desglose debajo (surge con fuel + manejo)', filaPrev && /Surge fee \(con fuel\)/.test(filaPrev.detalle) && /Manejo adicional/.test(filaPrev.detalle), filaPrev && filaPrev.detalle);
    const totalProfit = await page.evaluate(() => document.getElementById('liq-profit-total')?.textContent.trim());
    check('el pie muestra el profit total de la liquidación', /% · US?\$/.test(totalProfit || ''), totalProfit);
    check('ningún error de JavaScript', errores.length === 0, errores.slice(0, 2).join(' | '));
    await browser.close();
    void e3;
  }

  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
