#!/usr/bin/env node
/**
 * test-fecha-corte.js — la FECHA DE CORTE del control (07/09/2026).
 *
 * Pedido de Felipe: el sistema se usó a medias hasta agosto (envíos de prueba, ventas sin
 * cargar) y recién en septiembre se usa en serio. "Revisar guías" se llenaba de envíos
 * viejos con 100 % de diferencia que no son problemas reales. Desde el corte (por defecto
 * 01/09/2026, editable en Configuración):
 *   · el panel de salud destaca solo lo posterior (lo anterior se cuenta en una nota);
 *   · "Revisar guías" y "Guías sin envío" muestran solo lo posterior, con "Ver anteriores".
 *
 *   cd backend && node scripts/test-fecha-corte.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3936;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_fecha_corte.db';
const TOKEN = 'token-test-fecha-corte';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

  console.log('\n1. La fecha de corte existe y arranca en 01/09/2026\n');
  let c = await j(await fetch(BASE + '/api/configuracion/corte', { headers: H }));
  check('GET /configuracion/corte → 2026-09-01', c.fecha_corte_control === '2026-09-01', JSON.stringify(c));

  // Dos envíos con costo facturado y venta en 0 (100 % de diferencia → a_revisar):
  // uno de JULIO (antes del corte) y uno de SEPTIEMBRE (después).
  const cli = await j(await fetch(BASE + '/api/clientes', { method: 'POST', headers: H, body: JSON.stringify({ nombre: 'CORTE TEST', tarifa_pct: 75 }) }));
  const alta = async (fecha, guia) => j(await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({ cliente_id: cli.id, fecha, courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP',
      numero_guia: guia, pais_destino: 'Estados Unidos', fob: 50, total_cobrado: 0, bultos: [{ peso_real: 3, largo: 20, ancho: 20, alto: 20 }] }),
  }));
  const viejo = await alta('2026-07-15', '1ZCORTE0000000JUL');
  const nuevo = await alta('2026-09-03', '1ZCORTE0000000SEP');
  const sqlite3 = require('sqlite3');
  const dbRaw = new sqlite3.Database(DB);
  const sql = (q, p = []) => new Promise((res, rej) => dbRaw.run(q, p, (e) => (e ? rej(e) : res())));
  await sql("UPDATE envios SET costo_facturado = 120, peso_facturado = 3, courier_facturado = 'UPS', fecha_facturado = '2026-09-05', estado_revision = 'a_revisar' WHERE id IN (?, ?)", [viejo.id, nuevo.id]);
  // Guías facturadas sin envío: una en una factura de agosto y otra en una de septiembre.
  await sql("INSERT INTO facturas_cargadas (id, courier, numero_factura, fecha_factura, cantidad_guias, total_declarado) VALUES (9001, 'UPS', 'F-AGO', '2026-08-05', 1, 100)");
  await sql("INSERT INTO factura_guias (factura_id, numero_guia, pais, peso_facturado, costo_total, encontrada) VALUES (9001, '1ZSINENVIOAGO', 'US', 2, 100, 0)");
  await sql("INSERT INTO facturas_cargadas (id, courier, numero_factura, fecha_factura, cantidad_guias, total_declarado) VALUES (9002, 'UPS', 'F-SEP', '2026-09-05', 1, 100)");
  await sql("INSERT INTO factura_guias (factura_id, numero_guia, pais, peso_facturado, costo_total, encontrada) VALUES (9002, '1ZSINENVIOSEP', 'US', 2, 100, 0)");
  await new Promise((res) => dbRaw.close(() => res()));

  console.log('\n2. "Revisar guías" muestra solo lo posterior al corte\n');
  let g = await j(await fetch(BASE + '/api/facturas/guias', { headers: H }));
  check('la respuesta trae { guias, fecha_corte, anteriores }', Array.isArray(g.guias) && g.fecha_corte === '2026-09-01' && typeof g.anteriores === 'number', JSON.stringify({ fc: g.fecha_corte, a: g.anteriores }));
  check('el envío de septiembre está', g.guias.some((x) => x.id === nuevo.id));
  check('el de julio NO está', !g.guias.some((x) => x.id === viejo.id));
  check('y se cuenta entre los anteriores (≥ 1)', g.anteriores >= 1, `${g.anteriores}`);
  const gTodo = await j(await fetch(BASE + '/api/facturas/guias?todo=1', { headers: H }));
  check('con ?todo=1 aparecen los dos', gTodo.guias.some((x) => x.id === viejo.id) && gTodo.guias.some((x) => x.id === nuevo.id) && gTodo.todo === true);

  console.log('\n3. "Guías sin envío" mira la fecha de la factura\n');
  let se = await j(await fetch(BASE + '/api/facturas/sin-envio', { headers: H }));
  check('la de la factura de septiembre está', se.guias.some((x) => x.numero_guia === '1ZSINENVIOSEP'));
  check('la de la factura de agosto NO está', !se.guias.some((x) => x.numero_guia === '1ZSINENVIOAGO'));
  check('trae fecha_corte y anteriores', se.fecha_corte === '2026-09-01' && se.anteriores >= 1, JSON.stringify({ fc: se.fecha_corte, a: se.anteriores }));
  const seTodo = await j(await fetch(BASE + '/api/facturas/sin-envio?todo=1', { headers: H }));
  check('con ?todo=1 aparece la de agosto', seTodo.guias.some((x) => x.numero_guia === '1ZSINENVIOAGO'));

  console.log('\n4. El panel de salud respeta el corte\n');
  let sal = await j(await fetch(BASE + '/api/salud', { headers: H }));
  check('el panel dice desde cuándo controla', sal.fecha_corte === '2026-09-01', String(sal.fecha_corte));
  const chq = (id) => (sal.chequeos || []).find((x) => x.id === id);
  const gse = chq('guias_sin_envio');
  check('"guías sin envío" no lista la de agosto', gse && !(gse.detalle || []).some((d) => d.guia === '1ZSINENVIOAGO'), JSON.stringify(gse && gse.detalle));
  check('  pero sí la de septiembre', gse && (gse.detalle || []).some((d) => d.guia === '1ZSINENVIOSEP'));
  check('  y avisa que hay anteriores que no destaca', gse && /anterior/.test(gse.resumen), gse && gse.resumen);
  const esp = chq('envios_sin_precio');
  check('"envíos sin precio" no destaca el de julio', esp && !(esp.detalle || []).some((d) => d.guia === '1ZCORTE0000000JUL'), JSON.stringify(esp && esp.detalle));
  check('  y lo cuenta en la nota', esp && /anterior/.test(esp.resumen), esp && esp.resumen);
  const cie = chq('cierres');
  check('"cierres" no reclama meses anteriores al corte', cie && !(cie.detalle || []).some((d) => String(d.mes) < '2026-09'), JSON.stringify(cie && cie.detalle));

  console.log('\n5. Cambiar la fecha en Configuración cambia todo junto\n');
  let r = await fetch(BASE + '/api/configuracion/corte', { method: 'PUT', headers: H, body: JSON.stringify({ fecha_corte_control: '07/09/2026' }) });
  check('una fecha mal escrita → 400', r.status === 400, `${r.status}`);
  r = await fetch(BASE + '/api/configuracion/corte', { method: 'PUT', headers: H, body: JSON.stringify({ fecha_corte_control: '2026-01-01' }) });
  c = await j(r);
  check('PUT 2026-01-01 → 200 y queda guardada', r.status === 200 && c.fecha_corte_control === '2026-01-01', `${r.status} ${JSON.stringify(c)}`);
  g = await j(await fetch(BASE + '/api/facturas/guias', { headers: H }));
  check('ahora "Revisar guías" trae el de julio sin pedir todo', g.guias.some((x) => x.id === viejo.id) && g.fecha_corte === '2026-01-01');
  sal = await j(await fetch(BASE + '/api/salud', { headers: H }));
  check('y el panel controla desde 2026-01-01', sal.fecha_corte === '2026-01-01');
  await fetch(BASE + '/api/configuracion/corte', { method: 'PUT', headers: H, body: JSON.stringify({ fecha_corte_control: '2026-09-01' }) });

  console.log('\n6. Pantalla: nota y "Ver anteriores" en Facturas, tarjeta en Configuración\n');
  let chromium = null;
  try { ({ chromium } = require('playwright')); } catch { chromium = null; }
  if (!chromium) {
    console.log('  ⚠ playwright no está instalado — se saltea la parte de pantalla.');
  } else {
    const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
      '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
    const exe = cand.find((p) => fs.existsSync(p));
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', (e) => errores.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errores.push(m.text()); });

    await page.goto(BASE + '/pages/facturas.html', { waitUntil: 'networkidle' });
    await esperar(800);
    await page.click('.tab[data-tab="revisar"]');
    await esperar(1500);
    const filas = () => page.evaluate(() => [...document.querySelectorAll('#fac-table-body tr[data-id]')].map((t) => t.dataset.id));
    const nota = () => page.evaluate(() => document.getElementById('fac-revisar-corte')?.textContent.trim() || '');
    check('la nota dice desde cuándo se muestra', /Mostrando desde el 01\/09\/2026/.test(await nota()), await nota());
    check('la tabla trae el de septiembre y no el de julio', (await filas()).includes(String(nuevo.id)) && !(await filas()).includes(String(viejo.id)));
    check('hay link "Ver anteriores"', await page.evaluate(() => !!document.querySelector('#fac-revisar-corte [data-corte-toggle]')));
    await page.click('#fac-revisar-corte [data-corte-toggle]');
    await esperar(1200);
    check('al tocarlo aparece el de julio', (await filas()).includes(String(viejo.id)), (await filas()).join(','));
    check('y la nota ofrece volver', /Volver a mostrar/.test(await nota()), await nota());
    await page.click('#fac-revisar-corte [data-corte-toggle]');
    await esperar(1200);
    check('al volver, el de julio desaparece otra vez', !(await filas()).includes(String(viejo.id)));

    await page.goto(BASE + '/pages/configuracion.html', { waitUntil: 'networkidle' });
    await esperar(1000);
    check('Configuración muestra la fecha de corte', await page.evaluate(() => document.getElementById('corte-actual')?.textContent.trim() === '01/09/2026'),
      await page.evaluate(() => document.getElementById('corte-actual')?.textContent));
    await page.fill('#corte-input', '2026-08-01');
    await page.click('#btn-corte-guardar');
    await esperar(800);
    check('guardar cambia la fecha en el acto', await page.evaluate(() => document.getElementById('corte-actual')?.textContent.trim() === '01/08/2026'));
    c = await j(await fetch(BASE + '/api/configuracion/corte', { headers: H }));
    check('  y quedó persistida', c.fecha_corte_control === '2026-08-01', JSON.stringify(c));
    await fetch(BASE + '/api/configuracion/corte', { method: 'PUT', headers: H, body: JSON.stringify({ fecha_corte_control: '2026-09-01' }) });

    await page.goto(BASE + '/pages/salud.html', { waitUntil: 'networkidle' });
    await esperar(2500);
    check('el pie del panel de salud dice desde cuándo controla', await page.evaluate(() => /Se controla desde el 01\/09\/2026/.test(document.body.textContent)));
    check('ningún error de JavaScript', errores.length === 0, errores.slice(0, 2).join(' | '));
    await browser.close();
  }

  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
