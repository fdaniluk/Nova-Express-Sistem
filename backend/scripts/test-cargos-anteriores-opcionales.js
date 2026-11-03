#!/usr/bin/env node
// Cargos de envíos anteriores OPCIONALES en la liquidación (03/11/2026, pedido de Felipe):
// cada cargo pendiente trae su tilde en Crear (marcado por defecto). Lo destildado no entra
// y queda pendiente para la próxima. API: preview/crear aceptan cargos_anteriores_ids; sin
// el parámetro entran todos (como antes). Al retomar un borrador se ven tildados los suyos.
let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3985;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_cargos_anteriores_opcionales.db';
const TOKEN = 'token-test-cargos-opc';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const J = (m, u, b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  const cli = (await J('POST', '/api/clientes', { nombre: 'GIANNA OPC', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  // Envío de julio ya liquidado con dos cargos posteriores, un cargo suelto (guía que no está
  // en el sistema) y un envío de octubre pendiente de liquidar.
  const viejo = (await J('POST', '/api/envios', { cliente_id: cli.id, fecha: '2026-07-10', courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion', numero_guia: '1Z000OPC000000001', pais_destino: 'Reino Unido', peso_real: 5, largo: 30, ancho: 20, alto: 15, fob: 100, total_cobrado: 180 })).body;
  const liq0 = (await J('POST', '/api/liquidaciones', { cliente_id: cli.id, periodo_desde: '2026-07-01', periodo_hasta: '2026-07-31', envio_ids: [viejo.id], confirmar: true })).body;
  const cA = (await J('POST', `/api/salidas/${viejo.id}/cargos`, { tipo: 'sobrepeso', monto: 12.5, fecha: '2026-08-15' })).body;
  const cB = (await J('POST', `/api/salidas/${viejo.id}/cargos`, { tipo: 'otro', label: 'Reempaque', monto: 7, fecha: '2026-08-20' })).body;
  const cC = (await J('POST', `/api/clientes/${cli.id}/cargos`, { tipo: 'otro', label: 'Area remota mayo', monto: 30, fecha: '2026-10-05', guia_texto: '1Z000MAYO00000001' })).body;
  const nuevo = (await J('POST', '/api/envios', { cliente_id: cli.id, fecha: '2026-10-20', courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion', numero_guia: '1Z000OPC000000002', pais_destino: 'Reino Unido', peso_real: 5, largo: 30, ancho: 20, alto: 15, fob: 100, total_cobrado: 200 })).body;
  check('fixture: liquidación de julio confirmada, 3 cargos pendientes, envío de octubre', liq0.estado === 'confirmada' && cA.id && cB.id && cC.id && nuevo.id, JSON.stringify([liq0.estado, cA.id, cB.id, cC.id, nuevo.id]));

  console.log('\n1. API: preview / crear con cargos_anteriores_ids\n');
  const base = { cliente_id: cli.id, envio_ids: [nuevo.id] };
  const todos = (await J('POST', '/api/liquidaciones/preview', base)).body;
  check('sin el parámetro entran los 3 (como antes): total 200 + 49,50', todos.cargos_anteriores.length === 3 && Math.abs(todos.total - 249.5) < 0.011 && todos.cargos_anteriores_pendientes === 3, JSON.stringify([todos.cargos_anteriores.length, todos.total]));
  const uno = (await J('POST', '/api/liquidaciones/preview', { ...base, cargos_anteriores_ids: [cA.id] })).body;
  check('con [A] entra solo el sobrepeso: total 212,50 y avisa que hay 3 pendientes', uno.cargos_anteriores.length === 1 && uno.cargos_anteriores[0].id === cA.id && Math.abs(uno.total - 212.5) < 0.011 && uno.cargos_anteriores_pendientes === 3, JSON.stringify([uno.cargos_anteriores.map((c) => c.id), uno.total]));
  const ninguno = (await J('POST', '/api/liquidaciones/preview', { ...base, cargos_anteriores_ids: [] })).body;
  check('con [] no entra ninguno: total 200', ninguno.cargos_anteriores.length === 0 && Math.abs(ninguno.total - 200) < 0.011);
  const vacio = await J('POST', '/api/liquidaciones/preview', { cliente_id: cli.id, envio_ids: [], cargos_anteriores_ids: [] });
  check('sin envíos y sin cargos tildados: 400 que lo explica', vacio.status === 400 && /tildados/.test(vacio.body.error), JSON.stringify(vacio.body));
  const borr = (await J('POST', '/api/liquidaciones', { ...base, periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', cargos_anteriores_ids: [cA.id, cC.id], confirmar: false })).body;
  check('borrador con [A, C]: trae esos 2 y total 242,50', borr.id && borr.cargos_anteriores.length === 2 && Math.abs(borr.total - 242.5) < 0.011, JSON.stringify([borr.cargos_anteriores && borr.cargos_anteriores.map((c) => c.id), borr.total]));
  const pend = (await J('GET', `/api/liquidaciones/pendientes?cliente_id=${cli.id}`)).body;
  const grupo = Array.isArray(pend) ? pend.find((g) => g.cliente_id === cli.id) : null;
  check('   B (Reempaque) sigue pendiente para la próxima', grupo && grupo.cargos_anteriores.length === 1 && grupo.cargos_anteriores[0].id === cB.id, JSON.stringify(grupo && grupo.cargos_anteriores.map((c) => c.id)));
  // Un cargo que ENTRA después de armar el borrador sigue frenando la confirmación (es lo
  // que la oficina no vio); B, que ya existía y quedó destildado, no.
  await esperar(1100);
  const cE = (await J('POST', `/api/salidas/${viejo.id}/cargos`, { tipo: 'otro', label: 'Llegó después', monto: 3, fecha: '2026-11-03' })).body;
  const bloq = await J('PATCH', `/api/liquidaciones/${borr.id}/confirmar`, { envio_ids: [nuevo.id] });
  check('   un cargo que llegó DESPUÉS del borrador frena la confirmación (409) y nombra ese, no a B', bloq.status === 409 && /Llegó después/.test(bloq.body.error) && !/Reempaque/.test(bloq.body.error), JSON.stringify(bloq.body));
  await J('DELETE', `/api/salidas/${viejo.id}/cargos/${cE.id}`);
  const confR = await J('PATCH', `/api/liquidaciones/${borr.id}/confirmar`, { envio_ids: [nuevo.id] });
  const conf = (await J('GET', `/api/liquidaciones/${borr.id}`)).body;
  check('   confirmada con A y C adentro', confR.status === 200 && conf.estado === 'confirmada' && conf.cargos_anteriores.length === 2, JSON.stringify([confR.status, confR.body && confR.body.error, conf.estado, conf.cargos_anteriores && conf.cargos_anteriores.length]));
  const pend2 = (await J('GET', `/api/liquidaciones/pendientes?cliente_id=${cli.id}`)).body;
  const g2 = Array.isArray(pend2) ? pend2.find((g) => g.cliente_id === cli.id) : null;
  check('   y B queda pendiente (el cliente aparece solo con ese cargo)', g2 && g2.cargos_anteriores.length === 1 && g2.cargos_anteriores[0].id === cB.id);

  if (!chromium) { console.log('\n⚠ playwright no está instalado — se saltea la pantalla.'); }
  else {
    console.log('\n2. Pantalla: tildes en Crear y retomar borrador\n');
    // Otro cargo suelto más, para que haya dos pendientes (B y D).
    const cD = (await J('POST', `/api/clientes/${cli.id}/cargos`, { tipo: 'otro', label: 'Manejo junio', monto: 9, fecha: '2026-10-06', guia_texto: '1Z000MAYO00000002' })).body;
    const env3 = (await J('POST', '/api/envios', { cliente_id: cli.id, fecha: '2026-10-25', courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion', numero_guia: '1Z000OPC000000003', pais_destino: 'Reino Unido', peso_real: 5, largo: 30, ancho: 20, alto: 15, fob: 100, total_cobrado: 150 })).body;
    const exe = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => fs.existsSync(p));
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', (e) => errores.push(String(e)));
    page.on('dialog', (d) => d.accept());
    await page.goto(`${BASE}/pages/liquidaciones.html`); await esperar(2000);
    await page.click(`[data-liq-cliente="${cli.id}"]`); await esperar(1800);
    const chks = () => page.$$eval('#liq-cargos-pend-crear .liq-cargo-ant-chk', (cs) => cs.map((c) => ({ id: Number(c.value), on: c.checked })));
    let c = await chks();
    check('Crear lista los 2 cargos pendientes con tilde, marcados', c.length === 2 && c.every((x) => x.on), JSON.stringify(c));
    check('   la leyenda explica que lo destildado queda para la próxima', /queda pendiente para la próxima/.test(await page.textContent('#liq-cargos-pend-crear')));
    await page.click(`#liq-cargos-pend-crear .liq-cargo-ant-chk[value="${cD.id}"]`); await esperar(200);
    await page.click('#btn-preview'); await esperar(1800);
    const prev = await page.textContent('#liq-preview');
    check('destildado D y Calcular: la vista previa trae solo Reempaque (7,00) y total 157,00', /Reempaque/.test(prev) && !/Manejo junio/.test(prev) && /157,00/.test(prev), prev.replace(/\s+/g, ' ').slice(0, 300));
    await page.click('#btn-export-borrador').catch(() => {});
    await esperar(1500);
    const borradores = (await J('GET', '/api/liquidaciones?estado=borrador')).body;
    const b = (Array.isArray(borradores) ? borradores : []).find((l) => l.cliente_id === cli.id && l.estado === 'borrador');
    check('el Excel creó un borrador con 1 cargo anterior', b && b.cantidad_cargos_anteriores === 1, JSON.stringify(b && [b.id, b.cantidad_cargos_anteriores]));
    if (b) {
      await page.goto(`${BASE}/pages/liquidaciones.html`); await esperar(2000);
      await page.click('.tab[data-tab="historial"]'); await esperar(1200);
      const retomar = await page.$(`[data-retomar="${b.id}"], button[data-liq-retomar="${b.id}"], tr[data-id="${b.id}"] button`);
      if (retomar) {
        await retomar.click(); await esperar(2500);
        c = await chks();
        check('retomar el borrador: Reempaque tildado y Manejo junio destildado', c.length === 2 && c.find((x) => x.id === cB.id)?.on === true && c.find((x) => x.id === cD.id)?.on === false, JSON.stringify(c));
      } else check('(no encontré el botón de retomar en Historial; se saltea)', true);
    }
    check('sin errores de JS', errores.length === 0, errores.join(' | '));
    await browser.close();
  }

  matar();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
