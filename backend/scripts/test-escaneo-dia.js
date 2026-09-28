#!/usr/bin/env node
/**
 * test-escaneo-dia.js — el chequeo de escaneo UPS del cierre diario (28/09/2026).
 *  1. Servicio (UPS simulado): cuenta cajas escaneadas / sin escanear por envío, pinta el
 *     semáforo por caja, tolera guías sin formato y errores de UPS.
 *  2. Pantalla: el botón "✔ Escaneo UPS" abre el modal con el resumen y la tabla (la
 *     respuesta de UPS se simula interceptando el POST).
 *  3. El cierre de MES también festeja (foto de finde), no solo el de semana.
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

let ok = 0; let fail = 0;
function check(n, c, d = '') { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function parteServicio() {
  console.log('\n1. Servicio con UPS simulado\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-esc-'));
  const DB = path.join(tmp, 'nova.db');
  prepararDb(DB, { desdeProduccion: false });
  process.env.DB_PATH = DB;
  const { initDb, getDb } = require('../src/db');
  await initDb();
  const db = getDb();
  const cli = await db.prepare(`INSERT INTO clientes (nombre, tipo_cobro) VALUES ('ESC PRUEBA', 'D')`).run();
  const hoy = iso(new Date());
  const alta = async (guia, cant) => {
    const r = await db.prepare(`INSERT INTO envios (cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, peso_real, peso_facturable, total_cobrado, cantidad_bultos) VALUES (?, ?, 'UPS', 'exportacion', ?, 'Estados Unidos', 5, 5, 100, ?)`).run(cli.lastInsertRowid, hoy, guia, cant);
    return r.lastInsertRowid;
  };
  const e1 = await alta('1Z000ESC000000001A', 2); // 2 cajas, las dos escaneadas
  await db.prepare(`INSERT INTO envio_bultos (envio_id, numero_bulto, numero_guia, peso_real, largo, ancho, alto) VALUES (?, 1, '1Z000ESC000000001A', 1, 10, 10, 10), (?, 2, '1Z000ESC000000001B', 1, 10, 10, 10)`).run(e1, e1);
  const e2 = await alta('1Z000ESC000000002A', 3); // 3 cajas, UPS escaneó 2
  const e3 = await alta('1Z000ESC000000003A', 1); // solo manifest
  const e4 = await alta('SINFORMATO', 1);
  const e5 = await alta('1Z000ESC000000005A', 1); // UPS falla
  await db.prepare(`INSERT INTO envios (cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, peso_real, peso_facturable, total_cobrado, cantidad_bultos) VALUES (?, ?, 'DHL', 'exportacion', '1234567890', 'Estados Unidos', 5, 5, 100, 1)`).run(cli.lastInsertRowid, hoy);

  const pk = (guia, tipo, estado) => ({ guia, tipo, estado, ubicacion: 'Buenos Aires, AR', fecha: hoy.replace(/-/g, ''), hora: '1500', semaforo: tipo === 'M' ? 'rojo' : (tipo === 'D' ? 'verde' : 'amarillo') });
  const respuestas = {
    '1Z000ESC000000001A': { tipo: 'P', estado: 'Pickup Scan', paquetes: [pk('1Z000ESC000000001A', 'P', 'Pickup Scan'), pk('1Z000ESC000000001B', 'I', 'Origin Scan')] },
    '1Z000ESC000000002A': { tipo: 'P', estado: 'Pickup Scan', paquetes: [pk('1Z000ESC000000002A', 'P', 'Pickup Scan'), pk('1Z000ESC000000002B', 'P', 'Pickup Scan'), pk('1Z000ESC000000002C', 'M', 'Shipper created a label, UPS has not received the package yet.')] },
    '1Z000ESC000000003A': { tipo: 'M', estado: 'Shipper created a label', paquetes: [pk('1Z000ESC000000003A', 'M', 'Shipper created a label')] },
  };
  const obtenerTracking = async (g) => { if (respuestas[g]) return respuestas[g]; throw new Error('TV1002 Invalid inquiry number'); };
  const { escaneoDelDia } = require('../src/services/tracking-auto.service');
  const r = await escaneoDelDia(db, { fecha: hoy, obtenerTracking, pausaMs: 0 });
  check('mira solo los envíos UPS del día', r.totales.envios === 5, JSON.stringify(r.totales));
  check('cuenta las cajas (2+3+1+1+1 = 8)', r.totales.cajas === 8);
  check('escaneadas: 2 + 2 = 4', r.totales.escaneadas === 4);
  check('sin escanear: 1 + 1 + 1 (sin guía) + 1 (sin respuesta) = 4', r.totales.sin_escanear === 4);
  check('no está todo ok', r.todo_ok === false);
  const f = Object.fromEntries(r.filas.map((x) => [x.envio_id, x]));
  check('envío 1: ok, 2/2', f[e1].estado === 'ok' && f[e1].escaneadas === 2);
  check('envío 2: parcial 2/3 con la caja C marcada sin escanear', f[e2].estado === 'parcial' && f[e2].paquetes.filter((p) => !p.escaneada).map((p) => p.guia).join() === '1Z000ESC000000002C');
  check('envío 3: sin escanear', f[e3].estado === 'sin_escanear');
  check('envío 4: sin guía (no se consulta)', f[e4].estado === 'sin_guia');
  check('envío 5: sin respuesta, con el error a la vista', f[e5].estado === 'sin_respuesta' && /TV1002/.test(f[e5].detalle));
  check('los problemas van primero', r.filas[0].estado !== 'ok' && r.filas[r.filas.length - 1].estado === 'ok');
  const b = await db.prepare('SELECT numero_bulto, estado_caja FROM envio_bultos WHERE envio_id = ? ORDER BY numero_bulto').all(e1);
  check('el semáforo se pintó por caja (amarillo las dos)', b.every((x) => x.estado_caja === 'amarillo'), JSON.stringify(b));
  const s3 = await db.prepare('SELECT tracking_estado FROM envios WHERE id = ?').get(e3);
  check('el envío solo con manifest queda rojo', s3.tracking_estado === 'rojo');
  const rVacio = await escaneoDelDia(db, { fecha: '2000-01-01', obtenerTracking, pausaMs: 0 });
  check('un día sin envíos UPS: 0 y no "todo ok"', rVacio.totales.envios === 0 && rVacio.todo_ok === false);
  const { closeDb } = require('../src/db');
  await closeDb();
}

async function partePantalla() {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está — se saltea la pantalla.'); return; }
  console.log('\n2. Pantalla\n');
  const PORT = process.env.PORT_TEST || 3942;
  const BASE = `http://localhost:${PORT}`;
  const DB = path.join(os.tmpdir(), 'test_pantalla_escaneo.db');
  const TOKEN = 'token-test-escaneo';
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production', UPS_CLIENT_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logOut = ''; let logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; }); srv.stderr.on('data', (d) => { logErr += d; });
  const matar = () => { try { srv.kill(); } catch { /* ya */ } };
  process.on('exit', matar);
  try {
    await esperarServidor(srv, BASE, () => logErr, () => logOut);
    await abrirSesion(DB, TOKEN);
    const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
    const J = async (m, u, b) => { const r = await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const a = (await J('POST', '/api/clientes', { nombre: 'ESC PANTALLA', tarifa_pct: 75, tipo_cobro: 'D' })).body;
    const hoy = iso(new Date());
    await J('POST', '/api/envios', { cliente_id: a.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP', numero_guia: '1Z000ESCP00000001', pais_destino: 'Estados Unidos', peso_real: 5, largo: 30, ancho: 20, alto: 15, fob: 300, total_cobrado: 100 });
    const sinCred = await J('POST', '/api/tracking/escaneo-dia', { fecha: hoy });
    check('sin credenciales UPS el servidor lo dice (503)', sinCred.status === 503);

    const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
    const exe = cand.find((p) => fs.existsSync(p));
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', (e) => errores.push(String(e)));
    // UPS simulado: se intercepta el POST y se contesta como contestaría el servidor.
    await page.route('**/api/tracking/escaneo-dia', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      fecha: hoy, consultado_en: `${hoy} 17:05:00`, todo_ok: false,
      totales: { envios: 2, cajas: 3, escaneadas: 2, sin_escanear: 1, sin_respuesta: 0, sin_guia: 0 },
      filas: [
        { envio_id: 2, guia: '1Z000ESCP00000002', cliente: 'OTRO', cajas: 2, escaneadas: 1, sin_escanear: 1, estado: 'parcial', detalle: 'Pickup Scan — Buenos Aires, AR', paquetes: [{ guia: '1Z000ESCP00000002', escaneada: true, estado: 'Pickup Scan' }, { guia: '1Z000ESCP0000000B', escaneada: false, estado: 'Shipper created a label' }] },
        { envio_id: 1, guia: '1Z000ESCP00000001', cliente: 'ESC PANTALLA', cajas: 1, escaneadas: 1, sin_escanear: 0, estado: 'ok', detalle: 'Pickup Scan — Buenos Aires, AR', paquetes: [{ guia: '1Z000ESCP00000001', escaneada: true, estado: 'Pickup Scan' }] },
      ],
    }) }));
    // El Excel del cierre también se simula, para probar el festejo del botón de MES.
    await page.route('**/api/salidas/exportar**', (route) => route.fulfill({ status: 200, headers: { 'X-Nova-Filas': '3', 'Content-Disposition': 'attachment; filename="x.xlsx"' }, contentType: 'application/octet-stream', body: 'x' }));
    await page.goto(`${BASE}/pages/salidas.html`);
    await esperar(2500);
    check('el botón "Escaneo UPS" está al lado del cierre', !!(await page.$('#btn-escaneo-ups')));
    await page.click('#btn-escaneo-ups');
    await esperar(800);
    check('se abre el modal', !!(await page.$('#esc-overlay:not(.hidden)')));
    const body = await page.textContent('#esc-body');
    check('el resumen dice cuántas cajas faltan', /1 caja sin escanear/.test(body), body.slice(0, 120));
    check('la tabla lista los envíos con su estado', /Faltan cajas/.test(body) && /Escaneado/.test(body));
    check('las cajas se ven una por una (✔ / ✕)', (await page.$$('.esc-caja.no')).length === 1 && (await page.$$('.esc-caja.si')).length === 2);
    check('el que tiene problema va primero', (await page.$$eval('.esc-tabla tbody tr', (trs) => trs.map((t) => t.className)))[0] === 'esc-mal');
    if (process.env.SHOTS_DIR) await page.screenshot({ path: path.join(process.env.SHOTS_DIR, 'escaneo-modal.png') });
    await page.click('#esc-close');

    // 3. El cierre de MES festeja
    console.log('\n3. Cierre de mes con foto\n');
    const tieneFinde = await page.evaluate(() => Boolean(window.NovaFinde));
    check('el módulo del festejo está cargado en Salidas', tieneFinde);
    await page.evaluate(() => { window.__festejos = 0; if (window.NovaFinde) window.NovaFinde.celebrar = () => { window.__festejos++; }; });
    await page.click('#btn-cierre-mes');
    await esperar(1200);
    check('bajar el cierre de MES dispara el festejo', (await page.evaluate(() => window.__festejos)) === 1);
    await page.click('#btn-cierre-semana');
    await esperar(1200);
    check('y el de semana sigue festejando', (await page.evaluate(() => window.__festejos)) === 2);
    check('sin errores de JavaScript', errores.length === 0, errores.join(' | ').slice(0, 200));
    await browser.close();
  } finally { matar(); }
}

(async () => {
  await parteServicio();
  await partePantalla();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => {}, 200).unref();
})().catch((e) => { console.error(e); process.exitCode = 1; });
