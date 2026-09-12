#!/usr/bin/env node
/**
 * test-borrador-duplicado.js — pendiente 52: avisar cuando se arma un borrador con envíos
 * que ya están en OTRO borrador (12/09/2026).
 *
 * Lo que pasó: Cueros Santa Cruz (#57 y #58) y GIANNASTACIO (#44 y #64) quedaron con dos
 * borradores para los mismos envíos. Un envío sin liquidar sigue en Pendientes aunque ya
 * esté en un borrador, y crear el segundo no avisaba nada: recién el panel de salud lo
 * marcaba como "envío en más de una liquidación" y Felipe los borró a mano.
 *
 * Lo que cuida esta tanda:
 *   API  — Pendientes trae `borrador_id` en el envío que ya está en un borrador; la vista
 *          previa devuelve `en_borrador` con número, fecha y guías; crear un segundo
 *          borrador con los mismos envíos contesta 409 con la lista; con
 *          `reemplazar_borradores: [id]` borra el viejo y crea el nuevo; con
 *          `permitir_duplicado` lo crea igual; sin envíos en común no molesta.
 *   Pantalla — el chip "en borrador #N" en Pendientes y en la tabla de Crear; el aviso
 *          amarillo en la vista previa con el botón "Borrar ese borrador"; y al confirmar,
 *          la pregunta: cancelar no crea nada, aceptar borra el viejo y confirma.
 *
 *   cd backend && node scripts/test-borrador-duplicado.js
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

const PORT = process.env.PORT_TEST || 3934;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_borrador_duplicado.db';
const TOKEN = 'token-test-borrador-dup';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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
  const J = async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await r.json(); } catch { /* */ }
    return { status: r.status, body: data };
  };

  const hoy = new Date();
  const cli = (await J('POST', '/api/clientes', { nombre: 'CUEROS DUPLICADOS', tarifa_pct: 75, tipo_cobro: 'S' })).body;
  const alta = async (guia) => (await J('POST', '/api/envios', {
    cliente_id: cli.id, fecha: iso(hoy), courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP',
    numero_guia: guia, pais_destino: 'Estados Unidos', peso_real: 5, largo: 30, ancho: 20, alto: 15,
    fob: 0, total_cobrado: 150,
  })).body;
  const e1 = await alta('1Z000DUP000000001');
  const e2 = await alta('1Z000DUP000000002');
  const e3 = await alta('1Z000DUP000000003');
  const periodo = { periodo_desde: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), periodo_hasta: iso(hoy) };

  console.log('\n1. API — el primer borrador y lo que se ve después\n');
  const b1 = await J('POST', '/api/liquidaciones', { cliente_id: cli.id, ...periodo, envio_ids: [e1.id, e2.id] });
  check('el primer borrador se crea (201)', b1.status === 201, `status ${b1.status}`);

  const pend = await J('GET', `/api/liquidaciones/pendientes?cliente_id=${cli.id}`);
  const envs = ((pend.body || [])[0] || {}).envios || [];
  const p1 = envs.find((e) => e.id === e1.id); const p3 = envs.find((e) => e.id === e3.id);
  check('los envíos del borrador siguen en Pendientes (no están liquidados)', !!p1, JSON.stringify(envs.map((e) => e.id)));
  check('y vienen con borrador_id = el borrador que los tiene', p1 && p1.borrador_id === b1.body.id, JSON.stringify(p1 && p1.borrador_id));
  check('el envío que no está en ningún borrador viene sin borrador_id', p3 && p3.borrador_id == null, JSON.stringify(p3 && p3.borrador_id));

  const prev = await J('POST', '/api/liquidaciones/preview', { cliente_id: cli.id, envio_ids: [e1.id, e3.id], cargos: [], cotizaciones: [] });
  check('la vista previa devuelve en_borrador con el borrador #1', prev.status === 200 && Array.isArray(prev.body.en_borrador)
    && prev.body.en_borrador.length === 1 && prev.body.en_borrador[0].id === b1.body.id, JSON.stringify(prev.body.en_borrador));
  check('con la fecha y SOLO las guías en común', prev.body.en_borrador[0].fecha && prev.body.en_borrador[0].guias.length === 1
    && prev.body.en_borrador[0].guias[0] === '1Z000DUP000000001', JSON.stringify(prev.body.en_borrador[0]));
  const prevLimpia = await J('POST', '/api/liquidaciones/preview', { cliente_id: cli.id, envio_ids: [e3.id], cargos: [], cotizaciones: [] });
  check('sin envíos en común, en_borrador viene vacío', prevLimpia.status === 200 && prevLimpia.body.en_borrador.length === 0);

  console.log('\n2. API — crear el segundo borrador\n');
  const b2 = await J('POST', '/api/liquidaciones', { cliente_id: cli.id, ...periodo, envio_ids: [e1.id, e3.id] });
  check('se frena con 409', b2.status === 409, `status ${b2.status}`);
  check('el error nombra el borrador y la guía', new RegExp(`#${b1.body.id}`).test(b2.body.error || '') && /1Z000DUP000000001/.test(b2.body.error || ''), b2.body.error);
  check('y trae la lista `borradores` con el id', Array.isArray(b2.body.borradores) && b2.body.borradores[0].id === b1.body.id, JSON.stringify(b2.body.borradores));
  const lista = await J('GET', `/api/liquidaciones?cliente_id=${cli.id}`);
  const cuantas = (Array.isArray(lista.body) ? lista.body : (lista.body.items || lista.body.liquidaciones || [])).length;
  check('no se creó nada (sigue habiendo una sola liquidación)', cuantas === 1, `hay ${cuantas}`);

  const b2dup = await J('POST', '/api/liquidaciones', { cliente_id: cli.id, ...periodo, envio_ids: [e1.id, e3.id], permitir_duplicado: true });
  check('con permitir_duplicado se crea igual (201)', b2dup.status === 201, `status ${b2dup.status}`);
  const delDup = await J('DELETE', `/api/liquidaciones/${b2dup.body.id}`);
  check('(se borra ese duplicado para seguir)', delDup.status === 200, `status ${delDup.status}`);

  const b3 = await J('POST', '/api/liquidaciones', { cliente_id: cli.id, ...periodo, envio_ids: [e1.id, e3.id], reemplazar_borradores: [b1.body.id] });
  check('con reemplazar_borradores: [#1] se crea (201)', b3.status === 201, `status ${b3.status} ${JSON.stringify(b3.body).slice(0, 100)}`);
  check('y el borrador viejo desapareció', (await J('GET', `/api/liquidaciones/${b1.body.id}`)).status === 404);
  const pend2 = await J('GET', `/api/liquidaciones/pendientes?cliente_id=${cli.id}`);
  const envs2 = ((pend2.body || [])[0] || {}).envios || [];
  check('el envío #2, que estaba solo en el viejo, sigue pendiente (no se perdió)', envs2.some((e) => e.id === e2.id && e.borrador_id == null), JSON.stringify(envs2.map((e) => [e.id, e.borrador_id])));
  check('los del nuevo apuntan al borrador nuevo', envs2.filter((e) => e.borrador_id === b3.body.id).length === 2);

  const sinComun = await J('POST', '/api/liquidaciones', { cliente_id: cli.id, ...periodo, envio_ids: [e2.id] });
  check('un borrador con un envío que no está en otro se crea sin molestar', sinComun.status === 201, `status ${sinComun.status}`);
  await J('DELETE', `/api/liquidaciones/${sinComun.body.id}`);

  const conf = await J('POST', '/api/liquidaciones', { cliente_id: cli.id, ...periodo, envio_ids: [e3.id], confirmar: true });
  check('confirmar directo con un envío que está en el borrador #3 también se frena (409)', conf.status === 409, `status ${conf.status}`);

  // Estado para la pantalla: borrador #3 tiene e1 y e3; e2 libre.
  console.log('\n3. Pantalla — el chip y el aviso\n');
  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text());
  });
  const dialogos = [];
  let respuestaDialogo = false;
  page.on('dialog', async (d) => { dialogos.push(d.message()); await (respuestaDialogo ? d.accept() : d.dismiss()); });

  await page.goto(`${BASE}/pages/liquidaciones.html`);
  await esperar(2500);
  const pendHtml = await page.innerHTML('#pendientes-list');
  check('en Pendientes, el envío del borrador lleva el chip "en borrador #N"', new RegExp(`en borrador #${b3.body.id}`).test(pendHtml));
  const chipsDeEste = (pendHtml.match(new RegExp(`en borrador #${b3.body.id}<`, 'g')) || []).length;
  check('dos envíos con el chip de ese borrador, el libre sin chip', chipsDeEste === 2, `chips: ${chipsDeEste}`);

  await page.click(`[data-liq-cliente="${cli.id}"]`);
  await esperar(1500);
  const tabla = await page.innerHTML('#liq-envios-body');
  check('en la tabla de Crear también está el chip (en dos filas)', (tabla.match(new RegExp(`en borrador #${b3.body.id}<`, 'g')) || []).length === 2);

  await page.click('#btn-preview');
  await esperar(1500);
  const aviso = await page.$('#liq-aviso-borradores:not([hidden])');
  check('la vista previa muestra el aviso amarillo', !!aviso);
  const avisoTxt = aviso ? await aviso.textContent() : '';
  check('con el número del borrador y las guías en común', new RegExp(`#${b3.body.id}`).test(avisoTxt) && /1Z000DUP000000001/.test(avisoTxt) && /1Z000DUP000000003/.test(avisoTxt), avisoTxt.slice(0, 160));
  check('y el botón "Borrar ese borrador"', !!(await page.$('#liq-aviso-borradores [data-borrar-previo]')));
  if (process.env.CAPTURA) await page.screenshot({ path: process.env.CAPTURA, fullPage: false });

  console.log('\n4. Pantalla — confirmar pregunta; cancelar no crea nada\n');
  respuestaDialogo = false;
  await page.click('#btn-confirmar-liq');
  await esperar(1500);
  check('salió la pregunta', dialogos.length === 1 && /ya están en otro borrador/.test(dialogos[0]), dialogos.join(' | ').slice(0, 160));
  check('que nombra el borrador', new RegExp(`#${b3.body.id}`).test(dialogos[0] || ''));
  const alerta = await page.textContent('#alert-box');
  check('cancelar avisa que no se creó', /No se creó/.test(alerta), alerta.slice(0, 120));
  const lista2 = await J('GET', `/api/liquidaciones?cliente_id=${cli.id}`);
  const todas2 = Array.isArray(lista2.body) ? lista2.body : (lista2.body.items || lista2.body.liquidaciones || []);
  check('y en el servidor no hay ninguna confirmada', !todas2.some((l) => l.estado === 'confirmada') && todas2.length === 1, JSON.stringify(todas2.map((l) => [l.id, l.estado])));

  console.log('\n5. Pantalla — aceptar borra el viejo y confirma\n');
  respuestaDialogo = true;
  await page.click('#btn-confirmar-liq');
  await esperar(2000);
  const alerta2 = await page.textContent('#alert-box');
  check('confirma y avisa "Liquidación #N confirmada"', /confirmada/.test(alerta2), alerta2.slice(0, 120));
  check('el borrador viejo #3 ya no existe', (await J('GET', `/api/liquidaciones/${b3.body.id}`)).status === 404);
  const lista3 = await J('GET', `/api/liquidaciones?cliente_id=${cli.id}`);
  const todas3 = Array.isArray(lista3.body) ? lista3.body : (lista3.body.items || lista3.body.liquidaciones || []);
  check('queda UNA liquidación, confirmada, con los 3 envíos', todas3.length === 1 && todas3[0].estado === 'confirmada', JSON.stringify(todas3.map((l) => [l.id, l.estado])));
  const pend3 = await J('GET', `/api/liquidaciones/pendientes?cliente_id=${cli.id}`);
  check('y no queda nada pendiente del cliente', !((pend3.body || [])[0] || {}).envios || (pend3.body[0].envios || []).length === 0);
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
