#!/usr/bin/env node
/**
 * test-pantalla-venta-salidas.js — el envío SIN PESAR y el botón "Calcular venta",
 * en un navegador de verdad.
 *
 * El circuito lo cubre test-envio-sin-pesar.js por API. Esto controla lo otro: que la
 * oficina lo pueda hacer desde la pantalla.
 *
 * EL CASO (Kasdorf y parecidos): los envíos no pasan por el depósito. Se manda la guía, el
 * cliente la imprime y despacha, y los pesos reales llegan días después. El envío se carga
 * sin pesar y se completa desde Salidas.
 *
 * Lo que más importa acá: que "Recalcular" (costo) y "Calcular venta" (precio) sean dos
 * cosas distintas, y que el segundo NUNCA pise una venta ya cargada sin confirmar.
 *
 *   cd backend && node scripts/test-pantalla-venta-salidas.js
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.log('⚠ playwright no está instalado — se saltea (necesita navegador de verdad).');
  process.exit(0);
}

const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3973;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_venta_salidas.db';
const TOKEN = 'token-test-pantalla-venta';

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
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);
  const esperarSrvMuerto = () => new Promise((res) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return res();
    srv.once('exit', res);
    setTimeout(res, 2000);
  });

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await esperar(300);
  }
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const hoy = new Date().toISOString().slice(0, 10);

  const cli = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H,
    body: JSON.stringify({ nombre: 'KASDORF PANTALLA', tarifa_pct: 75 }),
  })).json();

  // El envío del lunes: sin pesos ni medidas.
  const env = await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion',
      numero_guia: '1Z000PANT000000001', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
    }),
  })).json();

  console.log('\n1. El envío sin pesar\n');
  check('el alta sin peso lo acepta', !!env.id, JSON.stringify(env).slice(0, 100));
  check('no le inventa costo', env.flete === null, `flete=${env.flete}`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) {
      errores.push(m.text());
    }
  });

  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  const grilla = await page.textContent('body');
  check('la grilla lo marca como "sin pesar"', /sin pesar/.test(grilla));
  check('y la celda queda resaltada', (await page.$$('td.cell-sin-pesar')).length > 0);

  console.log('\n2. El jueves: llegan los pesos\n');

  await page.click('text=1Z000PANT000000001');
  await esperar(1000);
  check('se abre el modal', !!(await page.$('#sal-edit-overlay:not(.hidden)')));
  check('está el botón Calcular venta', !!(await page.$('#saled-calcular-venta')));

  await page.fill('#saled-peso-real', '12');
  await page.fill('#saled-largo', '40');
  await page.fill('#saled-ancho', '30');
  await page.fill('#saled-alto', '30');

  console.log('\n3. Calcular venta usa el profit del cliente\n');

  await page.click('#saled-calcular-venta');
  await esperar(3500);
  const panelVisible = await page.$eval('#saled-venta-panel',
    (e) => !e.classList.contains('hidden')).catch(() => false);
  check('aparece el panel del precio sugerido', panelVisible);
  const panel = panelVisible ? await page.textContent('#saled-venta-panel') : '';
  check('dice el profit del cliente (75%)', /75%/.test(panel), panel.slice(0, 160));
  check('dice de dónde salió el margen', /matriz|cliente|zona|tabla|banda/.test(panel),
    panel.slice(0, 160));
  check('muestra el precio de venta sugerido', /Precio de venta sugerido/.test(panel));
  check('sin venta previa el botón dice "Usar este precio"', /Usar este precio/.test(panel));

  await page.click('#saled-venta-aplicar');
  await esperar(900);
  const total = await page.inputValue('#saled-total');
  const flete = await page.inputValue('#saled-flete');
  const profit = await page.inputValue('#saled-profit');
  check('el total se completa solo', Number(total) > 0, `total=${total}`);
  check('el costo también quedó cargado', Number(flete) > 0, `flete=${flete}`);
  check('la utilidad se deriva sola', Number(profit) > 0, `profit=${profit}`);
  check('la venta es mayor que el costo', Number(total) > Number(flete));

  console.log('\n4. No pisa una venta ya cargada sin confirmar\n');

  await page.click('#saled-calcular-venta');
  await esperar(3500);
  const panel2 = await page.textContent('#saled-venta-panel');
  check('avisa que el envío ya tiene venta', /ya tiene una venta cargada/.test(panel2),
    panel2.slice(0, 200));
  check('el botón pasa a decir "Reemplazar"', /Reemplazar/.test(panel2));
  check('muestra la diferencia contra lo cargado', /Diferencia/.test(panel2));
  await page.click('#saled-venta-descartar');
  await esperar(500);
  check('"Dejar como está" no toca el total',
    (await page.inputValue('#saled-total')) === total);

  console.log('\n5. Recalcular es el COSTO, no el precio\n');

  await page.click('#saled-recalcular');
  await esperar(2500);
  check('Recalcular NO toca el total cobrado',
    (await page.inputValue('#saled-total')) === total,
    `antes ${total} · después ${await page.inputValue('#saled-total')}`);
  check('pero sí repuebla el costo', Number(await page.inputValue('#saled-flete')) > 0);

  await page.click('#sal-modal-save');
  await esperar(2500);
  const g = await (await fetch(`${BASE}/api/envios/${env.id}`, { headers: H })).json();
  check('la venta queda guardada en la base', Number(g.total_cobrado) > 0, `total=${g.total_cobrado}`);
  check('el costo queda guardado', Number(g.flete) > 0, `flete=${g.flete}`);
  check('el peso facturable quedó en 12', Number(g.peso_facturable) === 12, `pf=${g.peso_facturable}`);

  console.log('\n6. Sirve para los envíos viejos sin precio\n');

  // El caso inverso: envío CON peso pero sin venta, porque se cargó antes de que el cliente
  // tuviera matriz. Se le carga la matriz después y el botón la tiene que tomar.
  const cli2 = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'VIEJO SIN MATRIZ', tarifa_pct: 0 }),
  })).json();
  const viejo = await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli2.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion',
      numero_guia: '1Z000INVE000000001', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
      peso_real: 8, bultos: [{ peso_real: 8, largo: 35, ancho: 25, alto: 25 }],
    }),
  })).json();
  check('el envío viejo tiene costo pero la venta en 0',
    Number(viejo.flete) > 0 && Number(viejo.total_cobrado) === 0);

  await fetch(`${BASE}/api/clientes/${cli2.id}/profit-matrix`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ servicio: 'UPS_EXP', tipo: 'export', zona: null, peso_min: 5, peso_max: 10, profit_pct: 85 }),
  });

  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  await page.click('text=1Z000INVE000000001');
  await esperar(1000);
  await page.click('#saled-calcular-venta');
  await esperar(3500);
  const panel3 = await page.textContent('#saled-venta-panel');
  check('anda directo, sin tener que recalcular antes',
    /Precio de venta sugerido/.test(panel3));
  check('toma el profit cargado DESPUÉS del envío (85%)', /85%/.test(panel3),
    panel3.slice(0, 170));
  check('no avisa de pisar nada, porque la venta estaba en 0',
    !/ya tiene una venta cargada/.test(panel3));

  console.log('\n7. Sin errores de JavaScript\n');
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
