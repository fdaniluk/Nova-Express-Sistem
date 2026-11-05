#!/usr/bin/env node
// Auditoría 05/11/2026 — los dos defectos encontrados en producción:
//   A1 · Un borrador confirmado con números viejos (liq #239): el envío se editó después de
//        armar el borrador y confirmar lo tomó tal cual. Ahora confirmar recalcula y frena
//        (409 borrador_desactualizado); la pantalla descarta el borrador y vuelve a calcular.
//   A2 · El desglose del Adicional se armaba en vivo e ignoraba la venta a mano (liq #235:
//        columna 138,70 y renglones 161,84). Ahora se congela al crear y siempre cierra
//        contra la columna (renglón "Ajuste" si hace falta); los ítems viejos sin desglose
//        guardado se derivan CON la venta a mano.
//   A3 · extras_json congelado en envíos liquidados.
let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3996;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_auditoria_05_11.db';
process.env.DB_PATH = DB;
const TOKEN = 'token-test-aud-0511';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const cerca = (a, b) => Math.abs(r2(a) - r2(b)) < 0.011;
const suma = (det) => r2((det || []).reduce((s, d) => s + r2(d.monto), 0));

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production', SALUD_AUTO: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const J = (m, u, b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  const cli = (await J('POST', '/api/clientes', { nombre: 'AUDITORIA 0511', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  const mk = (guia, extra = {}) => J('POST', '/api/envios', { cliente_id: cli.id, fecha: '2026-10-02', courier: 'DHL', tipo_envio: 'exportacion', numero_guia: guia, pais_destino: 'Estados Unidos', peso_real: 10.5, largo: 48, ancho: 41, alto: 41, fob: 232, total_cobrado: 200, ...extra }).then((r) => r.body);

  console.log('\n1. A1 · Borrador armado, envío corregido después, confirmar frena\n');
  const eA = await mk('6857643590');
  check('fixture: envío con venta USD 200', eA.id && cerca(eA.total_cobrado, 200), JSON.stringify([eA.id, eA.total_cobrado]));
  const borr = (await J('POST', '/api/liquidaciones', { cliente_id: cli.id, periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', envio_ids: [eA.id], confirmar: false })).body;
  const itemViejo = borr.items[0];
  check('borrador creado con la venta de 200', borr.estado === 'borrador' && cerca(itemViejo.total_usd, 200), JSON.stringify([borr.estado, itemViejo.total_usd]));
  // La oficina corrige el precio del envío después (no está liquidado: se puede). Es lo
  // que pasó con la liq #239 en producción.
  const pt = await J('PATCH', `/api/salidas/${eA.id}`, { total_cobrado: 216.61 });
  check('el envío cambió a USD 216,61 (no está liquidado: se puede)', pt.status === 200, `${pt.status} ${JSON.stringify(pt.body)}`);
  const conf = await J('PATCH', `/api/liquidaciones/${borr.id}/confirmar`, { envio_ids: [eA.id] });
  check('confirmar el borrador viejo: 409 borrador_desactualizado, nombra la guía y los dos totales', conf.status === 409 && conf.body.codigo === 'borrador_desactualizado' && /6857643590/.test(conf.body.error) && /200\.00 → 216\.61/.test(conf.body.error) && /Calcular de nuevo/.test(conf.body.error), JSON.stringify(conf.body));
  check('   trae la lista de desactualizados para la pantalla', Array.isArray(conf.body.desactualizados) && conf.body.desactualizados.length === 1 && conf.body.desactualizados[0].envio_id === eA.id, JSON.stringify(conf.body.desactualizados));
  const sigue = (await J('GET', `/api/liquidaciones/${borr.id}`)).body;
  check('   y el borrador sigue en borrador, el envío sin liquidar', sigue.estado === 'borrador' && !(await J('GET', `/api/envios/${eA.id}`)).body.liquidado);
  // Lo que hace la pantalla: descarta el borrador y arma uno nuevo con los valores de hoy.
  await J('DELETE', `/api/liquidaciones/${borr.id}`);
  const nuevo = (await J('POST', '/api/liquidaciones', { cliente_id: cli.id, periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', envio_ids: [eA.id], confirmar: true })).body;
  check('vuelto a calcular y confirmado: sale con el precio nuevo', nuevo.estado === 'confirmada' && cerca(nuevo.items[0].total_usd, 216.61), JSON.stringify([nuevo.estado, nuevo.items && nuevo.items[0].total_usd]));
  // Un borrador cuyo envío NO cambió en plata se confirma como siempre (sin falsos positivos).
  const eB = await mk('1706829224');
  const borrB = (await J('POST', '/api/liquidaciones', { cliente_id: cli.id, periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', envio_ids: [eB.id], confirmar: false })).body;
  await J('PATCH', `/api/salidas/${eB.id}`, { observaciones: 'cambio que no es plata' });
  const confB = await J('PATCH', `/api/liquidaciones/${borrB.id}/confirmar`, { envio_ids: [eB.id] });
  check('un borrador cuyo envío solo cambió en algo que no es plata se confirma normal', confB.status === 200 && confB.body.estado === 'confirmada', JSON.stringify(confB.body && (confB.body.error || confB.body.estado)));
  // El borrador que cambió de PESO (y por eso de flete): también frena.
  const eB2 = await mk('1706829225', { total_cobrado: 300 });
  const borrB2 = (await J('POST', '/api/liquidaciones', { cliente_id: cli.id, periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', envio_ids: [eB2.id], confirmar: false })).body;
  await J('PATCH', `/api/salidas/${eB2.id}`, { venta_desglose: { flete: 250, fuel: 30, seguro: 10, adicional: 10 } });
  const confB2 = await J('PATCH', `/api/liquidaciones/${borrB2.id}/confirmar`, { envio_ids: [eB2.id] });
  check('si cambió el reparto de la venta (mismo total, otro flete/fuel) también frena', confB2.status === 409 && confB2.body.codigo === 'borrador_desactualizado', JSON.stringify(confB2.body && confB2.body.error));
  await J('DELETE', `/api/liquidaciones/${borrB2.id}`);
  await J('POST', '/api/liquidaciones', { cliente_id: cli.id, periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', envio_ids: [eB2.id], confirmar: true });

  console.log('\n2. A2 · Desglose congelado y que cierra con la columna\n');
  // Venta ajustada a mano con el adicional "sin fuel del surge" (lo que hizo la oficina en #235).
  const eC = await mk('8719712385', { courier: 'UPS', servicio_ups: 'UPS_EXP', pais_destino: 'Emiratos Árabes Unidos', peso_real: 30, largo: 60, ancho: 50, alto: 50, total_cobrado: 400 });
  await J('PATCH', `/api/salidas/${eC.id}`, { adicionales: 40, extras_json: [{ tipo: 'surge', label: 'Surge fee', monto: 40 }] });
  const salC = (await J('GET', `/api/salidas?desde=2026-10-01&hasta=2026-10-31`)).body.find((x) => x.id === eC.id);
  const vd = salC.venta_desglose;
  check('fixture: UPS con surge (desglose con fuel del surge en Adicional)', vd && vd.adicional > 40 && (salC.extras || []).some((x) => x.tipo === 'surge'), JSON.stringify(vd));
  const manual = { flete: r2(vd.flete + 10), fuel: vd.fuel, seguro: vd.seguro, adicional: r2(vd.adicional - 10) };
  const ptC = await J('PATCH', `/api/salidas/${eC.id}`, { venta_desglose: manual });
  check('la oficina ajusta la venta a mano: 10 del Adicional al flete', ptC.status === 200, JSON.stringify(ptC.body));
  const prevC = (await J('POST', '/api/liquidaciones/preview', { cliente_id: cli.id, envio_ids: [eC.id] })).body;
  const itC = prevC.items[0];
  check('vista previa: Adicional = el ajustado y los renglones cierran con él (con "Ajuste")', cerca(itC.adicional, manual.adicional) && cerca(suma(itC.adicional_detalle), itC.adicional) && itC.adicional_detalle.some((d) => d.tipo === 'ajuste'), JSON.stringify([itC.adicional, itC.adicional_detalle]));
  const liqC = (await J('POST', '/api/liquidaciones', { cliente_id: cli.id, periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', envio_ids: [eC.id], confirmar: true })).body;
  const gC = liqC.items[0];
  check('guardada y releída: mismo desglose, cierra con la columna', cerca(gC.adicional, manual.adicional) && cerca(suma(gC.adicional_detalle), gC.adicional) && gC.adicional_detalle.some((d) => d.tipo === 'ajuste'), JSON.stringify([gC.adicional, gC.adicional_detalle]));
  // El Excel: los ↳ suman la columna.
  const ExcelJS = require('exceljs');
  const rx = await fetch(BASE + `/api/liquidaciones/${liqC.id}/export`, { headers: { Cookie: `nova_session=${TOKEN}` } });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await rx.arrayBuffer())); const ws = wb.getWorksheet('Liquidacion');
  const cab = []; ws.getRow(7).eachCell((c) => cab.push(String(c.value))); const cAd = cab.indexOf('ADICIONAL') + 1, cDes = cab.indexOf('DESGLOSE DE ADICIONAL') + 1;
  let colAdic = null, sumSub = 0; ws.eachRow((row, n) => { if (n < 8) return; const d = String(row.getCell(cDes).value ?? ''); if (/^↳/.test(d)) sumSub += Number(row.getCell(cAd).value) || 0; else if (String(row.getCell(2).value) === '8719712385') colAdic = Number(row.getCell(cAd).value); });
  check('en el Excel los renglones ↳ (incluido "↳ Ajuste") suman la columna ADICIONAL', colAdic != null && cerca(sumSub, colAdic), `${sumSub} vs ${colAdic}`);

  console.log('\n3. A2 bis · El envío liquidado cambia después: el desglose congelado no se mueve\n');
  // Simula una edición posterior directo en la base (el PATCH ya congela la plata del liquidado).
  const { initDb, getDb } = require('../src/db');
  await initDb(); const db = getDb();
  const extrasOrig = (await db.prepare('SELECT extras_json, adicionales FROM envios WHERE id = ?').get(eC.id));
  await db.prepare("UPDATE envios SET extras_json = '[]', adicionales = 0 WHERE id = ?").run(eC.id);
  const despues = (await J('GET', `/api/liquidaciones/${liqC.id}`)).body.items[0];
  check('el ítem sigue mostrando el desglose de cuando se liquidó (surge + ajuste)', cerca(despues.adicional, manual.adicional) && cerca(suma(despues.adicional_detalle), despues.adicional) && despues.adicional_detalle.some((d) => d.tipo === 'surge'), JSON.stringify(despues.adicional_detalle));
  await db.prepare('UPDATE envios SET extras_json = ?, adicionales = ? WHERE id = ?').run(extrasOrig.extras_json, extrasOrig.adicionales, eC.id);
  // Ítem viejo (liquidado antes de este parche, sin desglose guardado): se deriva, pero ahora
  // CON la venta a mano → cierra contra la columna.
  await db.prepare('UPDATE liquidacion_items SET adicional_detalle_json = NULL WHERE liquidacion_id = ?').run(liqC.id);
  const viejo = (await J('GET', `/api/liquidaciones/${liqC.id}`)).body.items[0];
  check('ítem viejo sin desglose guardado: se deriva con la venta a mano y cierra igual', cerca(suma(viejo.adicional_detalle), viejo.adicional) && viejo.adicional_detalle.some((d) => d.tipo === 'ajuste') && viejo.adicional_detalle.some((d) => d.tipo === 'surge'), JSON.stringify([viejo.adicional, viejo.adicional_detalle]));

  console.log('\n4. A3 · extras_json congelado en un envío liquidado\n');
  const ptX = await J('PATCH', `/api/salidas/${eC.id}`, { extras_json: [{ tipo: 'gogreen', label: 'x', monto: 1 }] });
  check('cambiar el desglose de recargos de un envío liquidado: 409', ptX.status === 409 && /desglose de recargos/.test(ptX.body.error), JSON.stringify(ptX.body));

  if (!chromium) { console.log('\n⚠ playwright no está instalado — se saltea la pantalla.'); }
  else {
    console.log('\n5. Pantalla: confirmar un borrador desactualizado lo descarta y recalcula\n');
    const eD = await mk('2664846822', { total_cobrado: 250 });
    const exe = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => fs.existsSync(p));
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
    const page = await ctx.newPage();
    const errores = []; page.on('pageerror', (e) => errores.push(String(e)));
    page.on('dialog', (d) => d.accept());
    await page.goto(`${BASE}/pages/liquidaciones.html`); await esperar(2500);
    await page.click('.tab[data-tab="crear"]'); await esperar(300);
    await page.selectOption('#liq-cliente', String(cli.id));
    await page.fill('#liq-desde', '2026-10-01'); await page.fill('#liq-hasta', '2026-10-31');
    await page.click('#btn-cargar-envios'); await esperar(1200);
    await page.click('#btn-preview'); await esperar(1500);
    // Bajar el Excel arma el borrador (es lo que hizo la oficina con #239).
    await page.click('#btn-export-borrador'); await esperar(1500);
    for (const pg of ctx.pages()) if (pg !== page) await pg.close().catch(() => {});
    const borradores = (await J('GET', `/api/liquidaciones?cliente_id=${cli.id}`)).body.filter((l) => l.estado === 'borrador');
    check('bajar el Excel dejó un borrador con el envío', borradores.length === 1, JSON.stringify(borradores.map((b) => b.id)));
    const viejoId = borradores[0] && borradores[0].id;
    // Mientras tanto, alguien corrige el precio del envío.
    await J('PATCH', `/api/salidas/${eD.id}`, { total_cobrado: 300 });
    await page.click('#btn-confirmar-liq'); await esperar(3000);
    const alerta = await page.textContent('#alert-box').catch(() => '');
    check('Confirmar avisa que el envío cambió y que la vista previa ya está actualizada', /cambi/.test(alerta) && /250\.00 → 300\.00/.test(alerta) && /ya está actualizada/.test(alerta), alerta.slice(0, 250));
    const lista2 = (await J('GET', `/api/liquidaciones?cliente_id=${cli.id}`)).body;
    check('   el borrador viejo se descartó', !lista2.some((l) => l.id === viejoId), JSON.stringify(lista2.map((l) => [l.id, l.estado])));
    const totalPrev = await page.$eval('#liq-total', (e) => e.textContent.trim());
    check('   la vista previa muestra el precio nuevo (300,00)', /300,00/.test(totalPrev), totalPrev);
    await page.click('#btn-confirmar-liq'); await esperar(3000);
    const envD = (await J('GET', `/api/envios/${eD.id}`)).body;
    const liqD = envD.liquidacion_id ? (await J('GET', `/api/liquidaciones/${envD.liquidacion_id}`)).body : null;
    check('   confirmar de nuevo: el envío queda liquidado a 300 en una confirmada', !!envD.liquidado && liqD && liqD.estado === 'confirmada' && cerca(liqD.total, 300), JSON.stringify([envD.liquidado, envD.liquidacion_id, liqD && liqD.total]));
    check('sin errores de JavaScript', errores.length === 0, errores.slice(0, 2).join(' | '));
    await browser.close();
  }

  matar();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 2500).unref();
})().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
