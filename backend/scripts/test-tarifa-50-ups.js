#!/usr/bin/env node
/**
 * test-tarifa-50-ups.js — la tarifa +50 es de DHL y de nadie más.
 *
 * Caso de administración (07/09/2026): "desde Salidas, a la hora de recalcular no las
 * dejaba y les saltaba la leyenda del +50 de DHL en un envío de UPS". Reproducido: un envío
 * DHL de +50 kg (marca tarifa_50 = 1 congelada) al que le cambiaban el courier a UPS desde
 * el modal. El PATCH guardaba el courier pero la marca quedaba pegada (solo la actualizaba
 * un Recalcular), y el Recalcular fallaba con 400 porque el envío no tenía servicio UPS y el
 * modal no tenía dónde elegirlo.
 *
 * Lo que se cuida acá:
 *   1. El PATCH con courier=UPS borra la marca +50 en el MISMO guardado y exige servicio.
 *   2. El PATCH acepta servicio_ups (UPS_SAV / UPS_EXP) y lo valida.
 *   3. El Recalcular acepta servicio_ups del modal y ya no muere con 400.
 *   4. La fila de Salidas no dibuja el chip +50 en un envío UPS.
 *   5. La migración limpia las marcas viejas (UPS con tarifa_50 = 1) al arrancar.
 *   6. Pantalla: el modal muestra el selector de servicio solo con UPS, apaga el aviso +50
 *      al cambiar a UPS, y el Recalcular funciona.
 *
 *   cd backend && node scripts/test-tarifa-50-ups.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3938;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_tarifa_50_ups.db';
const TOKEN = 'token-test-tarifa-50-ups';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function lanzarServidor() {
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = { out: '', err: '' };
  srv.stdout.on('data', (d) => { logs.out += d; });
  srv.stderr.on('data', (d) => { logs.err += d; process.stderr.write('[server] ' + d); });
  return { srv, logs };
}
function esperarMuerto(srv) {
  return new Promise((res) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return res();
    srv.once('exit', res);
    setTimeout(res, 2000);
  });
}

async function main() {
  prepararDb(DB);
  let { srv, logs } = lanzarServidor();
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', () => { try { srv.kill(); } catch {} });

  await esperarServidor(srv, BASE, () => logs.err, () => logs.out);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
  const hoy = new Date().toISOString().slice(0, 10);
  const mes = hoy.slice(0, 7);

  const cli = await j(await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'TARIFA 50 UPS', tarifa_pct: 75 }),
  }));

  const altaDHL = async (guia) => j(await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'DHL', tipo_envio: 'exportacion', numero_guia: guia,
      pais_destino: 'Estados Unidos', fob: 500, total_cobrado: 1000,
      bultos: [{ peso_real: 70, largo: 50, ancho: 50, alto: 50 }],
    }),
  }));
  const filaSalidas = async (id) => {
    const s = await j(await fetch(BASE + `/api/salidas?desde=${mes}-01&hasta=${mes}-31`, { headers: H }));
    const lista = Array.isArray(s) ? s : (s.envios || s.rows || []);
    return lista.find((x) => x.id === id);
  };

  console.log('\n1. El caso de administración: DHL +50 kg → cambian el courier a UPS\n');
  const e1 = await altaDHL('DHL50UPS0000001');
  check('alta DHL de 70 kg queda con la marca +50', e1.tarifa_50 === 1, JSON.stringify({ t50: e1.tarifa_50 }));

  let r = await fetch(BASE + `/api/salidas/${e1.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ courier: 'UPS' }) });
  let b = await j(r);
  check('PATCH courier=UPS SIN servicio → 400 con mensaje claro', r.status === 400 && /Saver|Expedited/.test(b.error || ''), `${r.status} ${JSON.stringify(b).slice(0, 120)}`);

  r = await fetch(BASE + `/api/salidas/${e1.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ courier: 'UPS', servicio_ups: 'UPS_EXP' }) });
  b = await j(r);
  check('PATCH courier=UPS + servicio Expedited → 200', r.status === 200, `${r.status} ${JSON.stringify(b).slice(0, 120)}`);
  let fila = await filaSalidas(e1.id);
  check('la fila quedó en UPS', fila && fila.courier === 'UPS', JSON.stringify(fila && { c: fila.courier }));
  check('la marca +50 se borró en el MISMO guardado', fila && Number(fila.tarifa_50) === 0, JSON.stringify(fila && { t50: fila.tarifa_50 }));
  check('el servicio quedó guardado', fila && fila.servicio_ups === 'UPS_EXP', JSON.stringify(fila && { s: fila.servicio_ups }));

  r = await fetch(BASE + `/api/salidas/${e1.id}/recalcular`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ courier: 'UPS', servicio_ups: 'UPS_EXP', bultos: [{ peso_real: 70, largo: 50, ancho: 50, alto: 50 }] }),
  });
  b = await j(r);
  check('Recalcular en UPS ya no muere con 400', r.status === 200, `${r.status} ${JSON.stringify(b).slice(0, 120)}`);
  check('el recálculo UPS viene sin marca +50', r.status === 200 && Number(b.tarifa_50) === 0, JSON.stringify({ t50: b.tarifa_50 }));
  check('y con flete UPS (> 0)', r.status === 200 && Number(b.flete) > 0, JSON.stringify({ flete: b.flete }));

  console.log('\n2. Validaciones del servicio\n');
  r = await fetch(BASE + `/api/salidas/${e1.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ servicio_ups: 'CUALQUIERA' }) });
  check('servicio inválido → 400', r.status === 400, `${r.status}`);
  r = await fetch(BASE + `/api/salidas/${e1.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ servicio_ups: 'UPS_SAV' }) });
  fila = await filaSalidas(e1.id);
  check('cambiar a Saver → 200 y se guarda', r.status === 200 && fila.servicio_ups === 'UPS_SAV', `${r.status} ${fila && fila.servicio_ups}`);
  r = await fetch(BASE + `/api/salidas/${e1.id}/recalcular`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ courier: 'UPS', servicio_ups: 'ZZZ', bultos: [{ peso_real: 70, largo: 50, ancho: 50, alto: 50 }] }),
  });
  check('Recalcular con servicio inválido → 400', r.status === 400, `${r.status}`);

  console.log('\n3. La vuelta: UPS → DHL\n');
  r = await fetch(BASE + `/api/salidas/${e1.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ courier: 'DHL' }) });
  fila = await filaSalidas(e1.id);
  check('volver a DHL → 200 y el servicio UPS queda en null', r.status === 200 && fila.servicio_ups == null, `${r.status} ${JSON.stringify(fila && { s: fila.servicio_ups })}`);
  check('la marca sigue en 0 hasta que alguien recalcule (no se inventa)', Number(fila.tarifa_50) === 0, JSON.stringify({ t50: fila.tarifa_50 }));
  r = await fetch(BASE + `/api/salidas/${e1.id}/recalcular`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ courier: 'DHL', bultos: [{ peso_real: 70, largo: 50, ancho: 50, alto: 50 }] }),
  });
  b = await j(r);
  check('Recalcular en DHL de 70 kg vuelve a marcar +50', r.status === 200 && Number(b.tarifa_50) === 1, `${r.status} ${JSON.stringify({ t50: b.tarifa_50 })}`);

  console.log('\n4. La migración limpia las marcas viejas al arrancar\n');
  // Se fabrica el estado roto de antes del 07/09 directo en la base: UPS con tarifa_50 = 1.
  const e2 = await altaDHL('DHL50UPS0000002');
  const sqlite3 = require('sqlite3');
  const dbRaw = new sqlite3.Database(DB);
  const sql = (q, p = []) => new Promise((res, rej) => dbRaw.run(q, p, (e) => (e ? rej(e) : res())));
  const get = (q, p = []) => new Promise((res, rej) => dbRaw.get(q, p, (e, row) => (e ? rej(e) : res(row))));
  await sql("UPDATE envios SET courier = 'UPS', servicio_ups = 'UPS_EXP' WHERE id = ?", [e2.id]);
  let row = await get('SELECT courier, tarifa_50 FROM envios WHERE id = ?', [e2.id]);
  check('estado roto fabricado: UPS con tarifa_50 = 1', row.courier === 'UPS' && row.tarifa_50 === 1, JSON.stringify(row));
  await new Promise((res) => dbRaw.close(() => res()));

  matarSrv();
  await esperarMuerto(srv);
  ({ srv, logs } = lanzarServidor());
  srvMuerto = false;
  await esperarServidor(srv, BASE, () => logs.err, () => logs.out);
  const dbRaw2 = new sqlite3.Database(DB);
  row = await new Promise((res, rej) => dbRaw2.get('SELECT courier, tarifa_50 FROM envios WHERE id = ?', [e2.id], (e, r2) => (e ? rej(e) : res(r2))));
  await new Promise((res) => dbRaw2.close(() => res()));
  check('al reiniciar, la marca del envío UPS quedó en 0', row.tarifa_50 === 0, JSON.stringify(row));
  check('y el arranque lo dijo en el log', /tarifa_50: se sacó la marca \+50/.test(logs.out), logs.out.split('\n').filter((l) => /tarifa_50/.test(l)).join(' | ').slice(0, 160));
  const rowDHL = await (async () => {
    const d = new sqlite3.Database(DB);
    const r3 = await new Promise((res, rej) => d.get('SELECT courier, tarifa_50 FROM envios WHERE id = ?', [e1.id], (e, x) => (e ? rej(e) : res(x))));
    await new Promise((res) => d.close(() => res()));
    return r3;
  })();
  check('el envío DHL no se tocó', rowDHL.courier === 'DHL', JSON.stringify(rowDHL));

  console.log('\n5. Pantalla: el modal de Salidas\n');
  let chromium = null;
  try { ({ chromium } = require('playwright')); } catch { chromium = null; }
  if (!chromium) {
    console.log('  ⚠ playwright no está instalado — se saltea la parte de pantalla.');
  } else {
    // Un envío DHL +50 nuevo para abrir en el modal.
    const e3 = await altaDHL('DHL50UPS0000003');
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

    await page.goto(BASE + '/pages/salidas.html', { waitUntil: 'networkidle' });
    await esperar(1200);
    const chipDe = (id) => page.evaluate((i) => !!document.querySelector(`#salidas-body tr[data-envio-id="${i}"] .chip-tarifa50`), id);
    check('la fila DHL de 70 kg muestra el chip +50', await chipDe(e3.id));
    check('la fila que pasó a UPS (con marca vieja limpiada) NO muestra el chip', !(await chipDe(e2.id)));

    // Abrir el modal del DHL: el grupo de servicio UPS está oculto y el aviso +50 visible.
    await page.click(`#salidas-body tr[data-envio-id="${e3.id}"] td[data-col="fecha"]`);
    await esperar(600);
    const visibleGrp = () => page.evaluate(() => getComputedStyle(document.getElementById('saled-servicio-ups-group')).display !== 'none');
    const avisoVisible = () => page.evaluate(() => { const c = document.getElementById('saled-tarifa50-aviso'); return !!c && !c.classList.contains('hidden'); });
    check('con courier DHL el selector de servicio UPS está oculto', !(await visibleGrp()));
    check('y el aviso +50 se ve', await avisoVisible());

    await page.selectOption('#saled-courier', 'UPS');
    await esperar(200);
    check('al pasar a UPS aparece el selector de servicio', await visibleGrp());
    check('y el aviso +50 se apaga en el acto', !(await avisoVisible()));

    await page.click('#saled-recalcular');
    await esperar(400);
    const st1 = await page.evaluate(() => document.getElementById('saled-recalc-status').textContent);
    check('Recalcular sin servicio avisa (no manda nada)', /Saver|Expedited/.test(st1), st1);

    await page.selectOption('#saled-servicio-ups', 'UPS_EXP');
    await page.click('#saled-recalcular');
    await esperar(1500);
    const st2 = await page.evaluate(() => document.getElementById('saled-recalc-status').textContent);
    check('Recalcular con Expedited funciona', /actualizado/i.test(st2), st2);
    check('el aviso +50 sigue apagado después de recalcular en UPS', !(await avisoVisible()));

    // El cambio de costo deja la venta desfasada y el guardado pide confirmación (window.confirm):
    // acá se acepta, que es lo que haría la oficina si el precio ya estaba acordado.
    let hubieronDialogos = 0;
    page.on('dialog', (d) => { hubieronDialogos++; d.accept(); });
    await page.click('#sal-modal-save');
    await esperar(1500);
    check('el guardado avisó de la venta desfasada (costo cambió de DHL a UPS)', hubieronDialogos >= 1, `${hubieronDialogos}`);
    const filaE3 = await filaSalidas(e3.id);
    check('guardado: UPS Expedited, sin marca +50', filaE3 && filaE3.courier === 'UPS' && filaE3.servicio_ups === 'UPS_EXP' && Number(filaE3.tarifa_50) === 0,
      JSON.stringify(filaE3 && { c: filaE3.courier, s: filaE3.servicio_ups, t50: filaE3.tarifa_50 }));
    check('la fila ya no muestra el chip +50', !(await chipDe(e3.id)));
    check('ningún error de JavaScript', errores.length === 0, errores.slice(0, 2).join(' | '));
    await browser.close();
  }

  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarMuerto(srv);
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
