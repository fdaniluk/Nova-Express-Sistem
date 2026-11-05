#!/usr/bin/env node
// Panel de Salud automático y revisión mensual de recargos (04/11/2026, "chicos, solos"):
//   · Chequeo "Recargos de UPS y DHL": ámbar cada mes hasta tocar "Ya los revisé" (guarda la
//     fecha en Configuración); rojo si la tabla de demanda de DHL vence en ≤ 30 días o venció.
//   · Corrida diaria del servidor guardada en salud_corridas; GET /salud/ultima la devuelve
//     sin volver a correr nada; el menú muestra un globito con los rojos.
const DB = process.env.DB_PATH_TEST || '/tmp/test_salud_automatica.db';
process.env.DB_PATH = DB;
let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = Number(process.env.PORT_TEST || 3995);
const BASE = `http://localhost:${PORT}`;
const TOKEN = 'token-test-salud-auto';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function levantar(env, port) {
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(port), NODE_ENV: 'production', SALUD_AUTO: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  await esperarServidor(srv, `http://localhost:${port}`, () => le, () => lo);
  return srv;
}

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  // "Hoy" fijo: 15/12/2026 → la demanda DHL (vence 05/02/2027) está a 52 días: no es rojo.
  const srv = await levantar({ NOVA_HOY: '2026-12-15' }, PORT);
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await abrirSesion(DB, TOKEN);
  const J = (m, u, b, base = BASE) => fetch(base + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  console.log('\n1. Chequeo "Recargos de UPS y DHL: revisión mensual"\n');
  const s1 = (await J('GET', '/api/salud')).body;
  const rc = s1.chequeos.find((c) => c.id === 'recargos_couriers');
  check('el panel tiene 15 chequeos y el de recargos está en "Plata"', s1.chequeos.length === 15 && rc && rc.grupo === 'plata', String(s1.chequeos.length));
  check('sin revisión del mes: ÁMBAR y lo explica', rc.severidad === 'ambar' && /nadie revisó este mes/.test(rc.resumen), rc.resumen);
  check('   trae el botón "Ya los revisé este mes" (PUT a Configuración, con confirmación)', rc.accion && rc.accion.metodo === 'PUT' && /recargos-revisados/.test(rc.accion.url) && /revisé/.test(rc.accion.texto) && !!rc.accion.confirmar, JSON.stringify(rc.accion));
  check('   el detalle dice qué mirar: demanda DHL vigente, fuel UPS y DHL, surge, áreas', rc.detalle.some((d) => /DHL · recargo por demanda/.test(d.recargo) && /vigente hasta el 05\/02\/2027/.test(d.estado)) && rc.detalle.some((d) => /UPS · fuel/.test(d.recargo)) && rc.detalle.some((d) => /DHL · fuel/.test(d.recargo)) && rc.detalle.some((d) => /surge/.test(d.recargo)) && rc.detalle.some((d) => /áreas/.test(d.recargo)), JSON.stringify(rc.detalle.map((d) => d.recargo)));
  const sinPermiso = await fetch(BASE + '/api/configuracion/recargos-revisados', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('marcar sin sesión: 401', sinPermiso.status === 401, String(sinPermiso.status));
  const marcado = await J('PUT', '/api/configuracion/recargos-revisados', {});
  check('"Ya los revisé" guarda la fecha de hoy (del servidor)', marcado.status === 200 && marcado.body.recargos_revisados === '2026-12-15', JSON.stringify(marcado.body));
  const rc2 = (await J('GET', '/api/salud')).body.chequeos.find((c) => c.id === 'recargos_couriers');
  check('   y el chequeo pasa a OK con la fecha', rc2.severidad === 'ok' && /revisados este mes/.test(rc2.resumen) && rc2.revisado_el === '2026-12-15', rc2.resumen);
  const lectura = (await J('GET', '/api/configuracion/recargos-revisados')).body;
  check('   GET /configuracion/recargos-revisados la devuelve', lectura.recargos_revisados === '2026-12-15', JSON.stringify(lectura));
  const malo = await J('PUT', '/api/configuracion/recargos-revisados', { recargos_revisados: 'ayer' });
  check('   una fecha inválida se rechaza', malo.status === 400);

  console.log('\n2. Al mes siguiente vuelve a avisar; cerca del vencimiento de DHL, rojo\n');
  const srv2 = await levantar({ NOVA_HOY: '2027-01-20' }, PORT + 1);
  const B2 = `http://localhost:${PORT + 1}`;
  const rc3 = (await J('GET', '/api/salud', null, B2)).body.chequeos.find((c) => c.id === 'recargos_couriers');
  check('20/01/2027 (revisado en diciembre): la demanda DHL vence en 16 días → ROJO', rc3.severidad === 'rojo' && /por vencer|vencida/.test(rc3.resumen) && rc3.detalle.some((d) => /vence el 05\/02\/2027 \(en 16 días\)/.test(d.estado)), rc3.resumen + ' | ' + JSON.stringify(rc3.detalle[0]));
  const srv3 = await levantar({ NOVA_HOY: '2027-03-01' }, PORT + 2);
  const rc4 = (await J('GET', '/api/salud', null, `http://localhost:${PORT + 2}`)).body.chequeos.find((c) => c.id === 'recargos_couriers');
  check('01/03/2027: tabla VENCIDA → rojo y lo dice', rc4.severidad === 'rojo' && rc4.detalle.some((d) => /VENCIDO el 05\/02\/2027/.test(d.estado)), JSON.stringify(rc4.detalle[0]));
  srv3.kill();

  console.log('\n3. Corrida automática guardada y GET /salud/ultima\n');
  const vacia = (await J('GET', '/api/salud/ultima')).body;
  check('sin corridas: rojo 0 y sin fecha', vacia && vacia.rojo === 0 && vacia.corrida_en === null, JSON.stringify(vacia));
  // La corrida se dispara acá mismo (en el servidor va cada 24 h), con el "hoy" del rojo.
  process.env.NOVA_HOY = '2027-01-20';
  const { initDb } = require('../src/db');
  await initDb();
  const salud = require('../src/services/salud.service');
  const r = await salud.correrYGuardar();
  check('correrYGuardar devuelve el resumen con los rojos', r.rojo >= 1 && r.rojos.some((x) => x.id === 'recargos_couriers'), JSON.stringify(r));
  const ult = (await J('GET', '/api/salud/ultima')).body;
  check('GET /salud/ultima trae la última corrida (rojo ≥ 1, con fecha y los títulos)', ult.rojo === r.rojo && !!ult.corrida_en && ult.rojos.some((x) => /Recargos de UPS y DHL/.test(x.titulo)), JSON.stringify(ult));
  const sinSalud = await fetch(BASE + '/api/salud/ultima');
  check('   sin sesión: 401 (quien no tiene permiso no ve nada)', sinSalud.status === 401, String(sinSalud.status));

  if (!chromium) { console.log('\n⚠ playwright no está instalado — se saltea la pantalla.'); }
  else {
    console.log('\n4. Pantalla: globito en el menú y botón en el panel\n');
    const exe = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => fs.existsSync(p));
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: B2 }]);
    const page = await ctx.newPage();
    const errores = []; page.on('pageerror', (e) => errores.push(String(e)));
    page.on('dialog', (d) => d.accept());
    await page.goto(`${B2}/pages/salidas.html`); await esperar(2500);
    const badge = await page.$eval('.sidebar-nav a[href$="salud.html"] .nav-badge', (b) => ({ n: b.textContent.trim(), t: b.title })).catch(() => null);
    check('en Salidas, el ítem Salud del menú lleva el globito con los rojos de la última corrida', badge && badge.n === String(r.rojo) && /Recargos de UPS y DHL/.test(badge.t), JSON.stringify(badge));
    await page.goto(`${B2}/pages/salud.html`); await esperar(3500);
    const btn = await page.$('.chequeo[data-id="recargos_couriers"] .chequeo-accion');
    check('en Salud, la tarjeta de recargos tiene el botón "Ya los revisé este mes"', !!btn);
    await btn.click(); await esperar(2500);
    const lect2 = (await J('GET', '/api/configuracion/recargos-revisados', null, B2)).body;
    check('   tocarlo (y aceptar la confirmación) guarda la fecha de hoy del servidor', lect2.recargos_revisados === '2027-01-20', JSON.stringify(lect2));
    check('sin errores de JavaScript', errores.length === 0, errores.slice(0, 2).join(' | '));
    await browser.close();
  }

  srv2.kill(); matar();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 2500).unref();
})().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
