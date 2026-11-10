#!/usr/bin/env node
// Anular una liquidación CONFIRMADA (10/11/2026, pedido de Felipe: "para casos en los que
// haya errores"; cualquiera con acceso, sin límite de tiempo).
//   · Pide motivo. Queda en el historial como "anulada" (no se borra, no se confirma de nuevo).
//   · Los envíos vuelven a pendientes y se pueden corregir y liquidar otra vez.
//   · Los cargos posteriores que había tomado vuelven a pendientes.
//   · Cuenta corriente: nota de crédito contra la LQ; el saldo del cliente vuelve a 0.
//   · Deja de contar en la utilidad (Salidas/Dashboard filtran 'confirmada').
//   · Freno: con pagos o NC aplicados a la LQ no se anula.
let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3998;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_anular_liquidacion.db';
const TOKEN = 'token-test-anular-liq';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const cerca = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production', SALUD_AUTO: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  const cli = (await J('POST', '/clientes', { nombre: 'ANULAR SA', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  let n = 0;
  const mk = (total) => J('POST', '/envios', { cliente_id: cli.id, fecha: '2026-10-05', courier: 'DHL', tipo_envio: 'exportacion', numero_guia: `98765432${String(++n).padStart(2, '0')}`, pais_destino: 'Estados Unidos', peso_real: 5, largo: 30, ancho: 20, alto: 20, fob: 50, total_cobrado: total }).then((r) => r.body);
  const liquidar = (ids) => J('POST', '/liquidaciones', { cliente_id: cli.id, periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', envio_ids: ids, confirmar: true }).then((r) => r.body);
  const hist = async () => (await J('GET', `/cobranzas/clientes/${cli.id}/historial`)).body;
  const filas = (h) => (Array.isArray(h) ? h : (h.movimientos || h.historial || h.comprobantes || []));
  const salida = async (id) => (await J('GET', '/salidas?desde=2026-10-01&hasta=2026-10-31')).body.find((x) => x.id === id);

  console.log('\n1. Anular una confirmada\n');
  const e1 = await mk(200), e2 = await mk(300);
  const A = await liquidar([e1.id, e2.id]);
  check('fixture: liquidación confirmada de USD 500 con 2 envíos', A.estado === 'confirmada' && cerca(A.total, 500), JSON.stringify([A.estado, A.total]));
  const h0 = filas(await hist());
  check('   débito LQ de 500 en la cuenta corriente', h0.length === 1 && h0[0].tipo === 'LQ' && cerca(h0[0].saldo, 500), JSON.stringify(h0.map((x) => [x.tipo, x.importe, x.saldo])));
  const utilAntes = (await salida(e1.id));
  const sinMotivo = await J('POST', `/liquidaciones/${A.id}/anular`, {});
  check('sin motivo: 400 y no anula', sinMotivo.status === 400 && /motivo/i.test(sinMotivo.body.error) && (await J('GET', `/liquidaciones/${A.id}`)).body.estado === 'confirmada', JSON.stringify(sinMotivo.body));
  const an = await J('POST', `/liquidaciones/${A.id}/anular`, { motivo: 'Precio mal cargado en la guía 01' });
  check('con motivo: 200, estado "anulada", avisa 2 envíos liberados', an.status === 200 && an.body.estado === 'anulada' && an.body.envios_liberados === 2, JSON.stringify([an.status, an.body && an.body.estado, an.body && an.body.envios_liberados, an.body && an.body.error]));
  check('   guarda quién, cuándo y por qué', !!an.body.anulada_at && !!an.body.anulada_por && an.body.anulada_motivo === 'Precio mal cargado en la guía 01', JSON.stringify([an.body.anulada_at, an.body.anulada_por, an.body.anulada_motivo]));
  const ev1 = (await J('GET', `/envios/${e1.id}`)).body, ev2 = (await J('GET', `/envios/${e2.id}`)).body;
  check('los dos envíos vuelven a "sin liquidar"', !ev1.liquidado && !ev2.liquidado && ev1.liquidacion_id == null && ev2.liquidacion_id == null, JSON.stringify([ev1.liquidado, ev1.liquidacion_id, ev2.liquidado]));
  const pend = (await J('GET', `/liquidaciones/pendientes?cliente_id=${cli.id}`)).body;
  check('   y aparecen otra vez en Pendientes de liquidar', JSON.stringify(pend).includes(ev1.numero_guia) && JSON.stringify(pend).includes(ev2.numero_guia));
  const s1 = await salida(e1.id);
  check('   en Salidas no figuran ni liquidados ni "en borrador"', s1 && !s1.liquidado && s1.borrador_id == null, JSON.stringify(s1 && [s1.liquidado, s1.borrador_id]));
  const h1 = filas(await hist());
  const nc = h1.find((x) => x.tipo === 'NC');
  check('cuenta corriente: queda la LQ (saldo 0) + una NC de 500 que la referencia; acumulado 0', h1.length === 2 && cerca(h1.find((x) => x.tipo === 'LQ').saldo, 0) && nc && cerca(nc.importe, 500) && /Anulación de la liquidación/.test(nc.descripcion) && cerca(h1[h1.length - 1].acumulado, 0), JSON.stringify(h1.map((x) => [x.tipo, x.importe, x.saldo, x.acumulado])));
  const pendCC = (await J('GET', `/cobranzas/clientes/${cli.id}/pendientes`)).body;
  check('   el cliente no debe nada', JSON.stringify(pendCC).indexOf('"saldo":500') === -1 && !(Array.isArray(pendCC) ? pendCC : (pendCC.comprobantes || [])).some((c) => Number(c.saldo) > 0.005), JSON.stringify(pendCC).slice(0, 200));

  console.log('\n2. La anulada queda de registro y no se puede tocar\n');
  const lista = (await J('GET', `/liquidaciones?cliente_id=${cli.id}`)).body;
  const fA = lista.find((l) => l.id === A.id);
  check('sigue en el historial como "anulada", con su total y su motivo', fA && fA.estado === 'anulada' && cerca(fA.total, 500) && !!fA.anulada_motivo, JSON.stringify(fA && [fA.estado, fA.total, fA.anulada_motivo]));
  check('   filtro estado=borrador NO la trae; estado=anulada sí', !(await J('GET', `/liquidaciones?cliente_id=${cli.id}&estado=borrador`)).body.some((l) => l.id === A.id) && (await J('GET', `/liquidaciones?cliente_id=${cli.id}&estado=anulada`)).body.some((l) => l.id === A.id));
  check('anularla de nuevo: 409', (await J('POST', `/liquidaciones/${A.id}/anular`, { motivo: 'otra vez' })).status === 409);
  check('borrarla: 409 (queda de registro)', (await J('DELETE', `/liquidaciones/${A.id}`)).status === 409);
  check('confirmarla: 409', (await J('PATCH', `/liquidaciones/${A.id}/confirmar`, {})).status === 409);
  const xl = await fetch(`${BASE}/api/liquidaciones/${A.id}/export`, { headers: { Cookie: H.Cookie } });
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await xl.arrayBuffer()));
  let dice = false; wb.worksheets[0].eachRow((row) => row.eachCell((c) => { if (/ANULADA/.test(String(c.value))) dice = true; }));
  check('el Excel de una anulada dice ANULADA en el título', dice);

  console.log('\n3. Corregir y liquidar de nuevo\n');
  const pt = await J('PATCH', `/salidas/${e1.id}`, { total_cobrado: 250 });
  check('el envío ya se puede corregir (no está liquidado): 200 → 250', pt.status === 200, JSON.stringify(pt.body));
  const B = await liquidar([e1.id, e2.id]);
  check('se liquida de nuevo: confirmada nueva de USD 550 (sin aviso de "ya están en un borrador")', B.estado === 'confirmada' && cerca(B.total, 550) && B.id !== A.id, JSON.stringify([B.estado, B.total, B.error]));
  const h2 = filas(await hist());
  check('cuenta corriente: el cliente debe solo los 550 nuevos', cerca(h2[h2.length - 1].acumulado, 550) && h2.filter((x) => x.tipo === 'LQ').length === 2, JSON.stringify(h2.map((x) => [x.tipo, x.importe, x.saldo, x.acumulado])));
  const s1b = await salida(e1.id);
  check('la venta del envío en Salidas es la nueva (250), no suma la anulada', s1b && cerca(s1b.venta_total, 250), JSON.stringify(s1b && s1b.venta_total));
  const salud = (await J('GET', '/salud')).body;
  const dup = salud.chequeos.find((c) => c.id === 'envio_en_varias_liquidaciones');
  check('Salud no lo marca como "envío en más de una liquidación"', dup && dup.severidad === 'ok', JSON.stringify(dup && [dup.id, dup.severidad, dup.resumen]));
  const viejos = salud.chequeos.find((c) => /borrador/i.test(c.id));
  check('   ni cuenta la anulada como borrador viejo', !viejos || !JSON.stringify(viejos.detalle || []).includes(`"id":${A.id},`), JSON.stringify(viejos && viejos.resumen));

  console.log('\n4. Cargos posteriores: vuelven a pendientes\n');
  const cg = await J('POST', `/salidas/${e2.id}/cargos`, { tipo: 'otro', label: 'Corrección de dirección', monto: 22.1 });
  check('cargo posterior sobre un envío ya liquidado', cg.status === 201 || cg.status === 200, JSON.stringify(cg.body));
  const e3 = await mk(100);
  const C = await liquidar([e3.id]);
  check('la liquidación siguiente lo toma como cargo de envío anterior (100 + 22,10)', C.estado === 'confirmada' && cerca(C.total, 122.1) && C.cargos_anteriores.length === 1, JSON.stringify([C.total, C.cargos_anteriores && C.cargos_anteriores.length, C.error]));
  const anC = await J('POST', `/liquidaciones/${C.id}/anular`, { motivo: 'no correspondía cobrar el cargo todavía' });
  const cargos = (await J('GET', `/salidas/${e2.id}/cargos`)).body;
  const elCargo = (Array.isArray(cargos) ? cargos : cargos.cargos || []).find((c) => cerca(c.monto, 22.1));
  check('al anularla, el cargo vuelve a pendiente (sin liquidación)', anC.status === 200 && elCargo && elCargo.liquidacion_id == null, JSON.stringify(elCargo));

  console.log('\n5. Freno: con algo aplicado en la cuenta corriente no se anula\n');
  const h3 = filas(await hist());
  const lqB = h3.find((x) => x.tipo === 'LQ' && Number(x.liquidacion_id) === B.id);
  const ncm = await J('POST', '/cobranzas/comprobantes', { cliente_id: cli.id, libro: lqB.libro, tipo: 'NC', fecha: '2026-11-10', importe: 50, moneda: lqB.moneda, referencia_id: lqB.id, descripcion: 'bonificación' });
  check('fixture: NC de 50 aplicada a la LQ de la liquidación B', ncm.status === 201 || ncm.status === 200, JSON.stringify(ncm.body));
  const anB = await J('POST', `/liquidaciones/${B.id}/anular`, { motivo: 'probando el freno' });
  check('anular B: 409, dice que hay USD 50 aplicados y manda a Cobranzas', anB.status === 409 && /50\.00/.test(anB.body.error) && /Cobranzas/.test(anB.body.error), JSON.stringify(anB.body));
  check('   y B sigue confirmada con sus envíos liquidados', (await J('GET', `/liquidaciones/${B.id}`)).body.estado === 'confirmada' && !!(await J('GET', `/envios/${e1.id}`)).body.liquidado);

  if (!chromium) { console.log('\n⚠ playwright no está instalado — se saltea la pantalla.'); }
  else {
    console.log('\n6. Pantalla: botón Anular en el historial\n');
    const e4 = await mk(80);
    const D = await liquidar([e4.id]);
    const exe = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => fs.existsSync(p));
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
    const page = await ctx.newPage();
    const errores = []; page.on('pageerror', (e) => errores.push(String(e)));
    let textoDialogo = '', respuesta = 'Envío duplicado';
    page.on('dialog', (d) => { textoDialogo = d.message(); if (d.type() === 'prompt') d.accept(respuesta); else d.accept(); });
    await page.goto(`${BASE}/pages/liquidaciones.html`); await esperar(2000);
    await page.click('.tab[data-tab="historial"]'); await esperar(1200);
    const fila = (id) => page.$(`#hist-body tr:has([data-export="${id}"])`);
    check('la confirmada tiene botón "Anular"; la anulada no, y no tiene Retomar ni Borrar', !!(await page.$(`#hist-body [data-anular="${D.id}"]`)) && !(await page.$(`#hist-body [data-anular="${A.id}"]`)) && !(await page.$(`#hist-body [data-retomar="${A.id}"]`)) && !(await page.$(`#hist-body [data-borrar="${A.id}"]`)));
    check('la anulada se ve "anulada" con su motivo', /anulada/.test(await (await fila(A.id)).textContent()) && /Precio mal cargado/.test(await (await fila(A.id)).textContent()));
    respuesta = '  ';
    await page.click(`#hist-body [data-anular="${D.id}"]`); await esperar(800);
    check('el cartel explica qué pasa y pide el motivo; sin motivo no anula', /envíos y cargos vuelven a pendientes/.test(textoDialogo) && /Motivo/.test(textoDialogo) && (await J('GET', `/liquidaciones/${D.id}`)).body.estado === 'confirmada', textoDialogo.slice(0, 120));
    respuesta = 'Envío duplicado';
    await page.click(`#hist-body [data-anular="${D.id}"]`); await esperar(1500);
    const alerta = await page.textContent('#alert-box').catch(() => '');
    check('con motivo: avisa "anulada, 1 envío volvió a pendientes" y la fila pasa a anulada', /anulada/.test(alerta) && /1 envío volvió a pendientes/.test(alerta) && /anulada/.test(await (await fila(D.id)).textContent()) && !(await page.$(`#hist-body [data-anular="${D.id}"]`)), alerta);
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
    check('sin errores de JavaScript', errores.length === 0, errores.slice(0, 2).join(' | '));
    await browser.close();
  }

  matar();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 2500).unref();
})().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
