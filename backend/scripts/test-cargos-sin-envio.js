#!/usr/bin/env node
/**
 * test-cargos-sin-envio.js — Cargo de una guía que NO está en el sistema (oficina 30/10/2026).
 *
 * LA REGLA: llega un extracargo del courier de un envío que no existe en el sistema (de
 * antes de arrancar, o cargado por afuera). Se carga a mano al CLIENTE desde Liquidaciones
 * (fecha, nº de guía opcional, concepto, USD, PDF opcional) y queda PENDIENTE: entra solo
 * en la próxima liquidación del cliente, en "Cargos de envíos anteriores", al costo, en
 * pantalla y en el Excel. Se puede anular mientras está pendiente; en un borrador o en una
 * confirmada, no. Si se borra el borrador, vuelve a pendiente.
 *
 * Corre con el servidor levantado sobre una base vacía y abre la pantalla en Chromium.
 *
 *   cd backend && node scripts/test-cargos-sin-envio.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3997;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_cargos_sin_envio.db';
const TOKEN = 'token-test-cargos-sin-envio';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  prepararDb(DB);
  const envSrv = { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' };
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: envSrv, stdio: ['ignore', 'pipe', 'pipe'] });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
  const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: H, body: JSON.stringify(b) });
  const del = (u) => fetch(BASE + u, { method: 'DELETE', headers: H });
  const get = (u) => fetch(BASE + u, { headers: H });
  const postForm = (u, fd) => fetch(BASE + u, { method: 'POST', headers: { Cookie: `nova_session=${TOKEN}` }, body: fd });

  console.log('\n1. Alta al cliente, con y sin PDF; validaciones\n');
  const cli = await j(await post('/api/clientes', { nombre: 'SUELTOS SA', tarifa_pct: 70, tipo_cobro: 'CC' }));
  const otro = await j(await post('/api/clientes', { nombre: 'OTRO SRL', tarifa_pct: 70 }));
  let r = await post(`/api/clientes/${cli.id}/cargos`, { tipo: 'otro', label: 'Sobrepeso informado por UPS', monto: 37.5, fecha: '2026-10-20', guia_texto: '1Z327W090412345678' });
  const c1 = await j(r);
  check('POST /clientes/:id/cargos (JSON) → 201 pendiente, sin envío', r.status === 201 && c1.estado === 'pendiente' && c1.sin_envio === true && c1.envio_id === null && c1.cliente_id === cli.id, `${r.status} ${JSON.stringify(c1)}`);
  check('  guarda guía, fecha, concepto e importe', c1.guia_texto === '1Z327W090412345678' && c1.fecha === '2026-10-20' && c1.label === 'Sobrepeso informado por UPS' && c1.monto === 37.5);

  const pdfBuf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
  let fd = new FormData();
  fd.append('tipo', 'otro'); fd.append('label', 'Impuestos de destino'); fd.append('monto', '120'); fd.append('fecha', '2026-10-22'); fd.append('guia_texto', '');
  fd.append('pdf', new Blob([pdfBuf], { type: 'application/pdf' }), 'factura UPS mayo.pdf');
  r = await postForm(`/api/clientes/${cli.id}/cargos`, fd);
  const c2 = await j(r);
  check('POST multipart con PDF → 201 con el nombre del adjunto', r.status === 201 && c2.adjunto_nombre === 'factura UPS mayo.pdf' && c2.guia_texto === null, `${r.status} ${JSON.stringify(c2)}`);
  r = await get(`/api/clientes/${cli.id}/cargos/${c2.id}/adjunto`);
  const pdfBack = Buffer.from(await r.arrayBuffer());
  check('  GET …/adjunto devuelve el mismo PDF', r.status === 200 && (r.headers.get('content-type') || '').includes('pdf') && pdfBack.equals(pdfBuf), `${r.status} ${r.headers.get('content-type')}`);
  r = await get(`/api/clientes/${cli.id}/cargos/${c1.id}/adjunto`);
  check('  el cargo sin PDF → 404', r.status === 404);
  r = await get(`/api/clientes/${otro.id}/cargos/${c2.id}/adjunto`);
  check('  el PDF no se ve desde otro cliente → 404', r.status === 404);

  fd = new FormData();
  fd.append('tipo', 'otro'); fd.append('label', 'x'); fd.append('monto', '5');
  fd.append('pdf', new Blob([Buffer.from('hola')], { type: 'text/plain' }), 'nota.txt');
  r = await postForm(`/api/clientes/${cli.id}/cargos`, fd);
  check('adjunto que no es PDF → 400', r.status === 400 && /PDF/.test((await j(r)).error || ''), String(r.status));
  r = await post(`/api/clientes/${cli.id}/cargos`, { tipo: 'otro', label: '', monto: 10 });
  check('sin concepto → 400', r.status === 400);
  r = await post(`/api/clientes/${cli.id}/cargos`, { tipo: 'otro', label: 'Algo', monto: 0 });
  check('importe 0 → 400', r.status === 400);
  r = await post(`/api/clientes/99999/cargos`, { tipo: 'otro', label: 'Algo', monto: 10 });
  check('cliente inexistente → 404', r.status === 404);
  const lista = await j(await get(`/api/clientes/${cli.id}/cargos`));
  check('GET /clientes/:id/cargos lista los dos (sin el blob)', lista.length === 2 && lista.every((c) => !('adjunto' in c)) && lista[0].id === c2.id, JSON.stringify(lista).slice(0, 200));

  console.log('\n2. Entran en Pendientes y en la próxima liquidación como "cargos de envíos anteriores"\n');
  let pend = await j(await get(`/api/liquidaciones/pendientes?cliente_id=${cli.id}`));
  check('Pendientes muestra al cliente solo con cargos (sin envíos)', pend.length === 1 && pend[0].solo_cargos === true && pend[0].cargos_anteriores_n === 2 && pend[0].cargos_anteriores_total === 157.5, JSON.stringify(pend).slice(0, 300));
  const ca = pend[0].cargos_anteriores;
  check('  cada uno viene marcado sin_envio, con la guía tipeada y la fecha del cargo como fecha de envío', ca.every((c) => c.sin_envio === true) && ca[0].numero_guia === '1Z327W090412345678' && ca[0].envio_fecha === '2026-10-20' && ca[1].numero_guia === null && ca[1].adjunto_nombre === 'factura UPS mayo.pdf', JSON.stringify(ca));
  pend = await j(await get(`/api/liquidaciones/pendientes?cliente_id=${cli.id}&courier=UPS`));
  check('  el filtro por courier no los esconde (no tienen courier)', pend.length === 1 && pend[0].cargos_anteriores_n === 2);

  r = await post('/api/liquidaciones/preview', { cliente_id: cli.id, envio_ids: [] });
  const pv = await j(r);
  check('preview sin envíos → total = los dos cargos (157,50)', r.status === 200 && pv.total === 157.5 && pv.cargos_anteriores.length === 2 && pv.total_cargos_anteriores === 157.5, `${r.status} ${JSON.stringify(pv).slice(0, 200)}`);

  console.log('\n3. Anular: solo mientras está pendiente\n');
  const c3 = await j(await post(`/api/clientes/${cli.id}/cargos`, { tipo: 'otro', label: 'Cargo equivocado', monto: 9, fecha: '2026-10-23' }));
  r = await del(`/api/clientes/${otro.id}/cargos/${c3.id}`);
  check('anular desde otro cliente → 404', r.status === 404);
  r = await del(`/api/clientes/${cli.id}/cargos/${c3.id}`);
  const anulado = await j(r);
  check('DELETE /clientes/:id/cargos/:cargoId → anulado', r.status === 200 && anulado.estado === 'anulado', `${r.status} ${JSON.stringify(anulado)}`);
  pend = await j(await get(`/api/liquidaciones/pendientes?cliente_id=${cli.id}`));
  check('  el anulado ya no cuenta', pend[0].cargos_anteriores_n === 2);

  console.log('\n4. Borrador: quedan atados; borrarlo los suelta; confirmada: no se anulan\n');
  r = await post('/api/liquidaciones', { cliente_id: cli.id, envio_ids: [], periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31' });
  const b = await j(r);
  check('borrador solo con los cargos → 201, total 157,50', r.status === 201 && b.total === 157.5 && b.cargos_anteriores.length === 2, `${r.status} ${JSON.stringify(b).slice(0, 200)}`);
  check('  los dos vienen como sin_envio en el detalle', b.cargos_anteriores.every((c) => c.sin_envio === true));
  r = await del(`/api/clientes/${cli.id}/cargos/${c1.id}`);
  check('anular uno que está en el borrador → 409 que lo dice', r.status === 409 && /borrador/.test((await j(r)).error), String(r.status));
  const listado = await j(await get('/api/liquidaciones?cliente_id=' + cli.id));
  check('el listado de liquidaciones cuenta +2 cargos', listado.length === 1 && listado[0].cantidad_cargos_anteriores === 2 && listado[0].cantidad_envios === 0, JSON.stringify(listado).slice(0, 200));

  r = await get(`/api/liquidaciones/${b.id}/export`);
  const buf = Buffer.from(await r.arrayBuffer());
  check('el Excel sale', r.status === 200 && buf.length > 1000, String(r.status));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const textos = [];
  wb.worksheets[0].eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === 'string') textos.push(cell.value); }));
  check('  sección "CARGOS DE ENVÍOS ANTERIORES" con la guía tipeada', textos.includes('CARGOS DE ENVÍOS ANTERIORES') && textos.includes('1Z327W090412345678'), textos.filter((x) => /CARGOS|1Z/.test(x)).join(' | '));
  check('  el concepto dice que el envío no está cargado en el sistema', textos.some((x) => x === 'Sobrepeso informado por UPS · informado el 20/10/2026 · envío no cargado en el sistema'), textos.filter((x) => /Sobrepeso/.test(x)).join(' | '));

  r = await del(`/api/liquidaciones/${b.id}`);
  check('borrar el borrador → 200', r.status === 200, String(r.status));
  pend = await j(await get(`/api/liquidaciones/pendientes?cliente_id=${cli.id}`));
  check('  los cargos vuelven a pendientes', pend.length === 1 && pend[0].cargos_anteriores_n === 2, JSON.stringify(pend).slice(0, 200));

  r = await post('/api/liquidaciones', { cliente_id: cli.id, envio_ids: [], periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', confirmar: true });
  const conf = await j(r);
  check('confirmada directa con los cargos → 201', r.status === 201 && conf.estado === 'confirmada' && conf.total === 157.5, `${r.status} ${JSON.stringify(conf).slice(0, 200)}`);
  r = await del(`/api/clientes/${cli.id}/cargos/${c1.id}`);
  check('anular uno ya cobrado → 409', r.status === 409 && /confirmada/.test((await j(r)).error), String(r.status));
  pend = await j(await get(`/api/liquidaciones/pendientes?cliente_id=${cli.id}`));
  check('  y el cliente ya no tiene nada pendiente', pend.length === 0, JSON.stringify(pend));
  check('  el cargo quedó liquidado', (await j(await get(`/api/clientes/${cli.id}/cargos`))).find((c) => c.id === c1.id).estado === 'liquidado');

  console.log('\n5. La pantalla de Liquidaciones: cargar uno, verlo en la lista y anularlo\n');
  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e2) => errores.push(String(e2)));
  page.on('console', (m) => { if (m.type() === 'error') errores.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE + '/pages/liquidaciones.html', { waitUntil: 'networkidle' });
  await esperar(800);
  await page.click('[data-tab="crear"]');
  await esperar(300);
  check('está el bloque "Cargo de una guía que no está en el sistema"', await page.evaluate(() => /no está en el sistema/.test(document.getElementById('liq-sueltos')?.textContent || '')));
  await page.selectOption('#liq-cliente', String(cli.id));
  await page.fill('#liq-suelto-guia', '1Z999');
  await page.fill('#liq-suelto-concepto', 'Área remota (guía de mayo)');
  await page.fill('#liq-suelto-monto', '22.4');
  const tmpPdf = path.join(require('os').tmpdir(), 'cargo-test.pdf');
  fs.writeFileSync(tmpPdf, pdfBuf);
  await page.setInputFiles('#liq-suelto-pdf', tmpPdf);
  await page.click('#btn-suelto-add');
  await esperar(1200);
  const estado = await page.evaluate(() => document.getElementById('liq-suelto-estado').textContent);
  check('Guardar → avisa que quedó pendiente', /quedó pendiente|queda pendiente/.test(estado), estado);
  const tabla = await page.evaluate(() => document.getElementById('liq-cargos-pend-crear')?.textContent || '');
  check('  aparece en la lista de cargos pendientes con el chip "sin envío en el sistema"', /1Z999/.test(tabla) && /sin envío en el sistema/.test(tabla) && /Área remota/.test(tabla) && /22,40/.test(tabla), tabla.slice(0, 200));
  check('  con el link al PDF', await page.evaluate(() => !!document.querySelector('#liq-cargos-pend-crear a.liq-cargo-pdf')));
  const nuevo = (await j(await get(`/api/clientes/${cli.id}/cargos`)))[0];
  check('  en la base: pendiente, con PDF', nuevo.estado === 'pendiente' && nuevo.adjunto_nombre === 'cargo-test.pdf' && nuevo.monto === 22.4, JSON.stringify(nuevo));

  await page.click('#btn-preview');
  await esperar(1200);
  const prev = await page.evaluate(() => document.getElementById('liq-cargos-ant')?.textContent || '');
  check('Calcular → la vista previa lo muestra en "Cargos de envíos anteriores" con total 22,40', /sin envío en el sistema/.test(prev) && /22,40/.test(prev), prev.slice(0, 200));

  // Calcular es solo vista previa (no ata el cargo): el ✕ lo anula, con confirmación.
  await page.click('#liq-cargos-pend-crear [data-anular-suelto]');
  await esperar(1200);
  check('✕ anula (con confirmación) y desaparece de la lista', await page.evaluate(() => document.getElementById('liq-cargos-pend-crear').hidden === true), String(await page.evaluate(() => document.getElementById('liq-cargos-pend-crear').textContent)).slice(0, 120));
  check('  en la base quedó anulado', (await j(await get(`/api/clientes/${cli.id}/cargos`)))[0].estado === 'anulado');

  console.log('\n6. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|net::ERR|Failed to load resource/i.test(x));
  check('ningún error en la pantalla', rel.length === 0, rel.join(' | ').slice(0, 300));

  await browser.close();
  matarSrv();
  console.log(`\n${ok} pasaron · ${fail} fallaron\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
