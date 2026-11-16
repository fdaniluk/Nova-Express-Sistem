#!/usr/bin/env node
// Gastos externos: ¿se le cobran al cliente o son solo costo? (16/11/2026, Felipe)
// "Hay casos en los que se hacen y se tienen que contemplar en los costos del envío, pero
//  no siempre se le cobran al cliente: quizá los absorbe la empresa."
//   · SE COBRA APARTE  → sube la venta y la compra lo mismo; el profit no cambia; va a la
//                        liquidación con su nombre (como cualquier cargo posterior).
//   · SOLO COSTO       → la venta NO cambia; sube la compra; el profit BAJA ese importe; NO
//                        aparece en ninguna liquidación ni queda "pendiente de cobrar".
//   · Baja la utilidad en todos lados igual (Salidas, Comisiones = Dashboard), esté el envío
//     sin liquidar, liquidado, o con la factura del courier ya aprobada.
//   · Caso real: envío cargado en 995,73 que ya contemplaba un Vía Cargo de 85.
const DB = process.env.DB_PATH_TEST || '/tmp/test_gastos_solo_costo.db';
process.env.DB_PATH = DB;
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = Number(process.env.PORT_TEST || 3995);
const BASE = `http://localhost:${PORT}`;
const TOKEN = 'token-test-solo-costo';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const cerca = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;
const sql = (q, p = []) => new Promise((res, rej) => { const sqlite3 = require('sqlite3'); const db = new sqlite3.Database(DB); db.run(q, p, (e) => { db.close(); e ? rej(e) : res(); }); });

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production', SALUD_AUTO: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  process.on('exit', () => { try { srv.kill(); } catch {} });
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const cli = (await J('POST', '/clientes', { nombre: 'SOLO COSTO SA', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  let n = 0;
  const mk = async (total) => (await J('POST', '/envios', { cliente_id: cli.id, fecha: '2026-10-16', courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion', numero_guia: `1Z327W09679300${String(++n).padStart(4, '0')}`, pais_destino: 'Estados Unidos', peso_real: 30, largo: 40, ancho: 40, alto: 40, fob: 300, total_cobrado: total })).body;
  const sal = async (id) => { const r = (await J('GET', '/salidas?desde=2026-10-01&hasta=2026-10-31')).body; return (r.envios || r.data || r).find((e) => e.id === id); };
  const util = async (id) => { const e = (await J('GET', '/comisiones/detalle?mes=2026-10')).body.envios.find((x) => x.id === id); return e; };
  const cargo = (id, b) => J('POST', `/salidas/${id}/cargos`, b);
  const preview = (ids) => J('POST', '/liquidaciones/preview', { cliente_id: cli.id, periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', envio_ids: ids });
  const liquidar = (ids) => J('POST', '/liquidaciones', { cliente_id: cli.id, periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', envio_ids: ids, confirmar: true });

  console.log('\n1. Se cobra aparte (lo de siempre)\n');
  const A = await mk(995.73);
  const a0 = await sal(A.id); const ua0 = await util(A.id);
  check('fixture: el envío tiene compra y profit estimados', a0 && a0.compra_estimada > 0 && cerca(a0.profit_estimado, 995.73 - a0.compra_estimada), a0 && `compra ${a0.compra_estimada} profit ${a0.profit_estimado}`);
  const c1 = await cargo(A.id, { tipo: 'otro', label: 'Vía Cargo', monto: 85, externo: true, solo_costo: false });
  const a1 = await sal(A.id);
  check('queda como cargo externo, pendiente de cobrar', c1.status === 201 && c1.body.externo === true && c1.body.solo_costo === false && c1.body.estado === 'pendiente', JSON.stringify(c1.body));
  check('venta total +85 y compra +85: el profit no cambia', cerca(a1.venta_total, 995.73 + 85) && cerca(a1.compra_estimada, a0.compra_estimada + 85) && cerca(a1.profit_estimado, a0.profit_estimado), `venta ${a1.venta_total} compra ${a1.compra_estimada} profit ${a1.profit_estimado}`);
  check('utilidad para comisiones / dashboard: igual que antes', cerca((await util(A.id)).utilidad, ua0.utilidad));
  await J('DELETE', `/salidas/${A.id}/cargos/${c1.body.id}`);
  check('se anula y todo vuelve a como estaba', cerca((await sal(A.id)).venta_total, 995.73) && cerca((await sal(A.id)).compra_estimada, a0.compra_estimada));

  console.log('\n2. Solo costo (el caso real: 995,73 ya contemplaba el Vía Cargo de 85)\n');
  const c2 = await cargo(A.id, { tipo: 'otro', label: 'Vía Cargo', monto: 85, solo_costo: true });
  const a2 = await sal(A.id);
  check('queda como gasto "costo": externo, no pendiente de cobrar', c2.status === 201 && c2.body.solo_costo === true && c2.body.externo === true && c2.body.estado === 'costo', JSON.stringify(c2.body));
  check('la venta NO cambia: 995,73 (no aparecen los 1.080,73)', cerca(a2.venta_total, 995.73) && cerca(a2.cargos_total, 0) && cerca(a2.total, 995.73), `venta_total ${a2.venta_total} cargos_total ${a2.cargos_total}`);
  check('la compra sube 85 y el profit baja 85', cerca(a2.compra_estimada, a0.compra_estimada + 85) && cerca(a2.profit_estimado, a0.profit_estimado - 85), `compra ${a2.compra_estimada} profit ${a2.profit_estimado} (antes ${a0.profit_estimado})`);
  check('el % de profit se calcula sobre la compra con el gasto', cerca(a2.porcentaje_estimado, Math.round((a2.profit_estimado / a2.compra_estimada) * 10000) / 100), String(a2.porcentaje_estimado));
  check('no queda nada "pendiente de cobrar" y Salidas informa el gasto aparte', cerca(a2.cargos_pendientes, 0) && cerca(a2.cargos_costo, 85) && cerca(a2.cargos_externos, 85));
  check('el desglose de venta que ve el cliente no lo incluye', !a2.venta_desglose || cerca(a2.venta_desglose.total, 995.73), a2.venta_desglose && String(a2.venta_desglose.total));
  const ua2 = await util(A.id);
  check('comisiones / dashboard: la utilidad baja 85 y la venta no cambia', cerca(ua2.utilidad, ua0.utilidad - 85) && cerca(ua2.venta, 995.73), `${ua0.utilidad} → ${ua2.utilidad}`);
  check('"solo costo" es solo para gastos externos (un cargo del courier no)', (await cargo(A.id, { tipo: 'manejo', monto: 10, solo_costo: true })).status === 400);
  check('sin nombre no se carga', (await cargo(A.id, { tipo: 'otro', label: '', monto: 10, solo_costo: true })).status === 400);

  console.log('\n3. Liquidación: el gasto solo costo no se le cobra al cliente\n');
  const B = await mk(500);
  const cB1 = await cargo(B.id, { tipo: 'otro', label: 'Flete interno', monto: 40, externo: true, solo_costo: false });
  const cB2 = await cargo(B.id, { tipo: 'otro', label: 'Vía Cargo absorbido', monto: 25, solo_costo: true });
  const uB0 = await util(B.id);
  const pv = (await preview([A.id, B.id])).body;
  const txt = JSON.stringify(pv);
  const totalPv = pv.total_usd ?? pv.total ?? (pv.items || []).reduce((s, i) => s + i.total_usd, 0);
  check('vista previa: total = 995,73 + 500 + 40 (sin los 85 ni los 25)', cerca(totalPv, 995.73 + 500 + 40), String(totalPv));
  check('vista previa: nombra el que se cobra y NO nombra los que absorbe Nova', /Flete interno/.test(txt) && !/Vía Cargo/.test(txt));
  const L = await liquidar([A.id, B.id]);
  check('se confirma la liquidación', L.status < 300 && L.body && L.body.id, JSON.stringify(L.body).slice(0, 200));
  const liq = (await J('GET', `/liquidaciones/${L.body.id}`)).body;
  check('liquidación confirmada: total 1.535,73 y sin los gastos absorbidos', cerca(liq.total_usd ?? liq.total, 1535.73) && !/Vía Cargo/.test(JSON.stringify(liq)), String(liq.total_usd ?? liq.total));
  const cs = (await J('GET', `/salidas/${B.id}/cargos`)).body;
  check('el cobrado quedó liquidado; el solo costo sigue como "costo" (sin liquidación)', cs.find((c) => c.id === cB1.body.id).estado === 'liquidado' && cs.find((c) => c.id === cB2.body.id).estado === 'costo' && !cs.find((c) => c.id === cB2.body.id).liquidacion_id);
  const a3 = await sal(A.id); const b3 = await sal(B.id);
  check('liquidado: la venta sigue en 995,73 y 540', cerca(a3.venta_total, 995.73) && cerca(b3.venta_total, 540), `${a3.venta_total} / ${b3.venta_total}`);
  check('liquidado: la utilidad sigue con el gasto descontado', cerca((await util(A.id)).utilidad, ua0.utilidad - 85) && cerca((await util(B.id)).utilidad, uB0.utilidad), `${(await util(A.id)).utilidad} / ${(await util(B.id)).utilidad} (antes ${uB0.utilidad})`);
  // Gasto que aparece DESPUÉS de liquidar
  const cB3 = await cargo(B.id, { tipo: 'otro', label: 'Depósito fiscal absorbido', monto: 15, solo_costo: true });
  const pend = (await J('GET', `/liquidaciones/pendientes?cliente_id=${cli.id}`)).body;
  check('gasto solo costo sobre un envío ya liquidado: no queda nada para cobrar en la próxima liquidación', cB3.status === 201 && !/Depósito fiscal/.test(JSON.stringify(pend)) && cerca((await sal(B.id)).cargos_pendientes, 0));
  check('   y la utilidad del envío baja otros 15', cerca((await util(B.id)).utilidad, uB0.utilidad - 15), String((await util(B.id)).utilidad));
  const pv2 = await preview([]);
  check('   una liquidación nueva del cliente no lo levanta', pv2.status >= 400 || !/Depósito fiscal/.test(JSON.stringify(pv2.body)));

  console.log('\n4. Con la factura del courier aprobada (costo real)\n');
  const C = await mk(600);
  await cargo(C.id, { tipo: 'otro', label: 'Vía Cargo', monto: 50, solo_costo: true });
  await cargo(C.id, { tipo: 'otro', label: 'Flete interno', monto: 30, externo: true, solo_costo: false });
  await cargo(C.id, { tipo: 'manejo', monto: 20 });
  await sql("UPDATE envios SET costo_facturado = 400, estado_revision = 'revisado_ok' WHERE id = ?", [C.id]);
  const c4 = await sal(C.id);
  // venta = 600 + 30 + 20 = 650; compra real = 400 (courier, ya trae el manejo) + 50 + 30 externos = 480
  check('venta total 650 (600 + los dos que se cobran)', cerca(c4.venta_total, 650), String(c4.venta_total));
  check('profit real = 650 − (400 del courier + 80 externos) = 170', cerca(c4.profit_real_monto, 170), String(c4.profit_real_monto));
  check('comisiones / dashboard usan ese mismo número', cerca((await util(C.id)).utilidad, 170), String((await util(C.id)).utilidad));
  check('lo externo se informa aparte para no compararlo contra la factura del courier', cerca(c4.cargos_externos, 80) && cerca(c4.cargos_costo, 50));

  console.log('\n5. Lo que ya existía no cambia\n');
  const D = await mk(300);
  const d0 = await sal(D.id);
  const cD = await cargo(D.id, { tipo: 'sobrepeso', monto: 22 });
  const d1 = await sal(D.id);
  check('un cargo del courier sin marcar nada: se cobra, no es externo', cD.body.externo === false && cD.body.solo_costo === false && cD.body.estado === 'pendiente');
  check('   venta y compra +22, profit igual', cerca(d1.venta_total, 322) && cerca(d1.compra_estimada, d0.compra_estimada + 22) && cerca(d1.profit_estimado, d0.profit_estimado) && cerca(d1.cargos_costo, 0) && cerca(d1.cargos_externos, 0));

  console.log(`\n${ok} pasaron · ${fail} fallaron\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
