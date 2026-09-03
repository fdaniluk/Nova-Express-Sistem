#!/usr/bin/env node
/**
 * test-agregar-bulto.js — agregar bultos a un envío ya cargado, desde Salidas (03/09/2026).
 *
 * Caso de la oficina: un envío se carga en Salidas como de UN bulto y después resultan ser
 * dos. Hasta hoy el modal editaba los bultos que existían pero no podía crear uno: había
 * que borrar el envío y volver a cargarlo.
 *
 * Lo que cuida esta tanda: el PATCH de Salidas acepta bultos sin id y los inserta con el
 * número siguiente; un envío de bulto único (que no tiene filas propias) pasa a tener sus
 * filas al sumar el segundo; cantidad_bultos se lee de las filas; el Recalcular toma los
 * bultos nuevos por peso y medidas; la grilla muestra un renglón por bulto; un bulto vacío
 * se rechaza; y un envío liquidado no puede sumar bultos (cambiaría la plata congelada).
 * Y en el navegador: el botón "+ Agregar bulto" hace todo eso de punta a punta.
 *
 *   cd backend && node scripts/test-agregar-bulto.js
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.log('⚠ playwright no está instalado — se saltea (necesita navegador de verdad).');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3950;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_agregar_bulto.db';
const TOKEN = 'token-test-agregar-bulto';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const cerca = (a, b, t = 0.011) => Math.abs(Number(a) - Number(b)) <= t;

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
  const hoy = new Date().toISOString().slice(0, 10);

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const all = (q, p = []) => new Promise((res, rej) => db.all(q, p, (e, r) => (e ? rej(e) : res(r))));
  const get = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => (e ? rej(e) : res(r))));
  const run = (q, p = []) => new Promise((res, rej) => db.run(q, p, function (e) { e ? rej(e) : res(this); }));

  const cli = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'BULTOS TEST', tarifa_pct: 75, tipo_cobro: 'CC' }),
  })).json();
  const alta = async (guia, extra = {}) => (await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP',
      numero_guia: guia, pais_destino: 'Estados Unidos',
      peso_real: 5, largo: 30, ancho: 20, alto: 15, fob: 0, total_cobrado: 100, ...extra,
    }),
  })).json());
  const filas = (id) => all('SELECT id, numero_bulto, peso_real, largo, ancho, alto FROM envio_bultos WHERE envio_id = ? ORDER BY numero_bulto', [id]);
  const patch = (id, body) => fetch(`${BASE}/api/salidas/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
  const salidasDe = async (id) => {
    const sal = await (await fetch(`${BASE}/api/salidas?desde=${hoy}&hasta=${hoy}`, { headers: H })).json();
    const lista = Array.isArray(sal) ? sal : (sal.envios || sal.data || []);
    return lista.find((x) => x.id === id);
  };

  console.log('\n1. De uno a dos bultos por la API\n');
  const e1 = await alta('1Z000BULTO00000001');
  check('el envío de un bulto no tiene filas propias', (await filas(e1.id)).length === 0);

  const rec = await (await fetch(`${BASE}/api/salidas/${e1.id}/recalcular`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ bultos: [
      { peso_real: 5, largo: 30, ancho: 20, alto: 15 },
      { peso_real: 7, largo: 40, ancho: 30, alto: 20 },
    ] }),
  })).json();
  check('Recalcular toma el bulto nuevo aunque no tenga id: facturable = suma', cerca(rec.peso_facturable, 12, 0.6),
    String(rec.peso_facturable));

  const r1 = await patch(e1.id, {
    peso_real: 12, peso_facturable: rec.peso_facturable, peso_volumetrico: rec.peso_volumetrico,
    flete: rec.flete, seguro: rec.seguro, fuel: rec.fuel, adicionales: rec.adicionales, extras_json: rec.extras,
    bultos: [
      { id: null, peso_real: 5, largo: 30, ancho: 20, alto: 15 },
      { id: null, peso_real: 7, largo: 40, ancho: 30, alto: 20 },
    ],
  });
  check('el PATCH con dos bultos sin id entra', r1.status === 200, `${r1.status} ${(await r1.text()).slice(0, 120)}`);
  const f1 = await filas(e1.id);
  check('ahora hay DOS filas, numeradas 1 y 2', f1.length === 2 && f1[0].numero_bulto === 1 && f1[1].numero_bulto === 2,
    JSON.stringify(f1.map((b) => b.numero_bulto)));
  check('la primera conserva los datos del bulto que ya estaba', f1[0].peso_real === 5 && f1[0].largo === 30);
  check('la segunda tiene los del nuevo', f1[1].peso_real === 7 && f1[1].alto === 20);
  const env1 = await get('SELECT cantidad_bultos, peso_real FROM envios WHERE id = ?', [e1.id]);
  check('cantidad_bultos se lee de las filas: 2', env1.cantidad_bultos === 2, String(env1.cantidad_bultos));
  check('el peso balanza del envío es la suma: 12', cerca(env1.peso_real, 12));
  const s1 = await salidasDe(e1.id);
  check('Salidas devuelve los dos bultos (dos renglones)', s1 && Array.isArray(s1.bultos) && s1.bultos.length === 2,
    String(s1 && s1.bultos && s1.bultos.length));
  check('y los dos con id real', s1.bultos.every((b) => b.id != null));

  console.log('\n2. De dos a tres: los que existen se editan, el nuevo se inserta\n');
  const r2 = await patch(e1.id, {
    bultos: [
      { id: f1[0].id, peso_real: 5.5, largo: 30, ancho: 20, alto: 15 },
      { id: f1[1].id, peso_real: 7, largo: 40, ancho: 30, alto: 20 },
      { id: null, peso_real: 3, largo: 20, ancho: 20, alto: 10 },
    ],
  });
  check('entra', r2.status === 200, String(r2.status));
  const f2 = await filas(e1.id);
  check('tres filas, el nuevo es el 3', f2.length === 3 && f2[2].numero_bulto === 3 && f2[2].peso_real === 3,
    JSON.stringify(f2.map((b) => [b.numero_bulto, b.peso_real])));
  check('el bulto 1 se editó a 5,5 sin perder su id', f2[0].id === f1[0].id && f2[0].peso_real === 5.5);
  check('cantidad_bultos 3', (await get('SELECT cantidad_bultos n FROM envios WHERE id = ?', [e1.id])).n === 3);

  console.log('\n3. Los frenos\n');
  const e2 = await alta('1Z000BULTO00000002');
  const vacio = await patch(e2.id, { bultos: [{ id: null, peso_real: 5, largo: 30, ancho: 20, alto: 15 }, { id: null }] });
  check('un bulto sin peso ni medidas se rechaza con 400', vacio.status === 400, String(vacio.status));
  check('y explica qué falta', /peso|medidas/i.test((await vacio.json()).error || ''));
  check('no quedó nada a medias', (await filas(e2.id)).length === 0);

  const soloPeso = await patch(e2.id, { bultos: [{ id: null, peso_real: 5, largo: 30, ancho: 20, alto: 15 }, { id: null, peso_real: 4 }] });
  check('un bulto pesado sin medir SÍ entra (medidas en 0, factura por su peso)', soloPeso.status === 200, String(soloPeso.status));
  const f3 = await filas(e2.id);
  check('con las medidas en 0 y no en NULL', f3.length === 2 && f3[1].largo === 0 && f3[1].peso_real === 4, JSON.stringify(f3[1]));

  const e3 = await alta('1Z000BULTO00000003');
  const liq = await run(
    "INSERT INTO liquidaciones (cliente_id, periodo_desde, periodo_hasta, total, estado) VALUES (?, ?, ?, 100, 'confirmada')",
    [cli.id, hoy, hoy]);
  await run('INSERT INTO liquidacion_items (liquidacion_id, envio_id, total_usd, fuel_pct_usado) VALUES (?, ?, 100, 37)', [liq.lastID, e3.id]);
  await run('UPDATE envios SET liquidado = 1, liquidacion_id = ? WHERE id = ?', [liq.lastID, e3.id]);
  const liqPatch = await patch(e3.id, { bultos: [{ id: null, peso_real: 5, largo: 30, ancho: 20, alto: 15 }, { id: null, peso_real: 2, largo: 10, ancho: 10, alto: 10 }] });
  check('a un envío liquidado no se le agregan bultos (409)', liqPatch.status === 409, String(liqPatch.status));
  check('sigue con cero filas', (await filas(e3.id)).length === 0);
  const obs = await patch(e3.id, { observaciones: 'nota' });
  check('pero editarle una nota sigue andando', obs.status === 200, String(obs.status));

  console.log('\n4. En el navegador: el botón "+ Agregar bulto"\n');
  const e4 = await alta('1Z000BULTO00000004');
  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  // Al guardar con el precio de venta calculado para otro peso, el modal pregunta si
  // guardar igual (window.confirm). Playwright cancela los diálogos por defecto y el
  // guardado se abortaría en silencio: acá se acepta, que es lo que haría la oficina
  // con un precio negociado aparte.
  page.on('dialog', (d) => d.accept());
  page.on('console', (m) => {
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text());
  });
  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  const renglonesAntes = (await page.$$('#salidas-body tr[data-envio-id="' + e4.id + '"]')).length;
  check('la grilla arranca con UN renglón para el envío', renglonesAntes === 1, String(renglonesAntes));

  await page.click('text=1Z000BULTO00000004');
  await esperar(600);
  check('se abre el modal', !!(await page.$('#sal-edit-overlay:not(.hidden)')));
  check('la sección de bultos está escondida (bulto único)', !!(await page.$('#saled-bultos-section.hidden')));
  check('pero el botón "+ Agregar bulto" está', !!(await page.$('#saled-agregar-bulto')));

  await page.click('#saled-agregar-bulto');
  await esperar(300);
  check('al tocarlo aparece la sección con DOS filas', (await page.$$('#saled-bultos-container .saled-bulto-row')).length === 2);
  const fila1Peso = await page.inputValue('#saled-bultos-container [data-bidx="0"][data-field="peso_real"]');
  check('la fila 1 heredó el peso del bulto que ya estaba (5)', fila1Peso === '5', fila1Peso);
  check('la fila 2 se puede quitar (es nueva)', !!(await page.$('.saled-bulto-quitar[data-bidx="1"]')));
  check('el peso balanza de arriba quedó bloqueado (multi-bulto)', await page.$eval('#saled-peso-real', (el) => el.readOnly));
  check('el estado de caja del bulto nuevo pide guardar primero',
    /Guardá el envío/.test(await page.textContent('#saled-estado-caja')));

  await page.fill('#saled-bultos-container [data-bidx="1"][data-field="peso_real"]', '7');
  await page.fill('#saled-bultos-container [data-bidx="1"][data-field="largo"]', '40');
  await page.fill('#saled-bultos-container [data-bidx="1"][data-field="ancho"]', '30');
  await page.fill('#saled-bultos-container [data-bidx="1"][data-field="alto"]', '20');
  await esperar(200);
  check('el peso balanza se recalcula solo: 12', (await page.inputValue('#saled-peso-real')) === '12', await page.inputValue('#saled-peso-real'));

  await page.click('#saled-recalcular');
  await esperar(1500);
  const pf = await page.inputValue('#saled-peso-facturable');
  check('Recalcular tomó los dos bultos (facturable ≥ 12)', Number(pf) >= 12, pf);

  await page.click('#sal-modal-save');
  await esperar(2500);
  const f4 = await filas(e4.id);
  check('al guardar quedaron dos filas en la base', f4.length === 2, JSON.stringify(f4.map((b) => [b.numero_bulto, b.peso_real])));
  const renglonesDespues = (await page.$$('#salidas-body tr[data-envio-id="' + e4.id + '"]')).length;
  check('y la grilla muestra DOS renglones sin recargar la página', renglonesDespues === 2, String(renglonesDespues));
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await browser.close();
  matarSrv();
  await esperarSrvMuerto();
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
