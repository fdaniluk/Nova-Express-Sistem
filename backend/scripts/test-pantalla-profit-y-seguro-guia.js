#!/usr/bin/env node
// Dos pedidos de la oficina (20/11/2026):
//  1. Salidas → editar un envío: si se escribe el PROFIT o el %, se acomoda la VENTA para
//     llegar a ese número (el % es sobre la compra total). Los costos no se tocan.
//  2. Una guía armada desde el sistema CON seguro: al pasarla a la carga del envío, la
//     tilde "Asegurado" viene puesta (antes había que ponerla a mano); sin seguro, no.
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3993;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_profit_seguro.db';
const TOKEN = 'token-test-profit-seguro';
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const cerca = (a, b, t = 0.011) => Math.abs(Number(a) - Number(b)) < t;

(async () => {
  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production', SALUD_AUTO: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  process.on('exit', () => { try { srv.kill(); } catch {} });
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const cli = (await J('POST', '/clientes', { nombre: 'PROFIT A MANO SA', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
  const env = (await J('POST', '/envios', { cliente_id: cli.id, fecha: hoy, courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion', numero_guia: '1Z327W096795000011', pais_destino: 'Estados Unidos', peso_real: 30, largo: 40, ancho: 40, alto: 40, fob: 300, total_cobrado: 500 })).body;
  const salida = async () => { const r = (await J('GET', `/salidas?desde=${hoy.slice(0, 8)}01`)).body; return (r.envios || r).find((e) => e.id === env.id); };
  const s0 = await salida();
  const compra = s0.compra_estimada;

  const exe = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = []; page.on('pageerror', (e) => errores.push(e.message));
  page.on('dialog', (d) => d.accept());

  console.log('\n1. Salidas: escribir el profit o el % acomoda la venta\n');
  await page.goto(`${BASE}/pages/salidas.html`);
  await page.waitForSelector(`tr[data-envio-id="${env.id}"]`);
  await page.click(`tr[data-envio-id="${env.id}"] td[data-col="cliente"]`).catch(() => page.click(`tr[data-envio-id="${env.id}"] td[data-col="courier"]`));
  await page.waitForSelector('#saled-porcentaje');
  await esperar(400);
  const v = async (id) => Number(await page.inputValue(id));
  check('arranca con venta 500 y el profit/% que da contra la compra', cerca(await v('#saled-total'), 500) && cerca(await v('#saled-profit'), 500 - compra) && cerca(await v('#saled-porcentaje'), (500 - compra) / compra * 100, 0.02), `${await v('#saled-total')} / ${await v('#saled-profit')} / ${await v('#saled-porcentaje')} (compra ${compra})`);
  const costosAntes = [await v('#saled-flete'), await v('#saled-fuel'), await v('#saled-seguro'), await v('#saled-adicionales')].join('|');

  await page.fill('#saled-porcentaje', '70');
  const esperada70 = Math.round(compra * 1.7 * 100) / 100;
  check(`escribir 70 % → la venta pasa a ${esperada70} (compra × 1,70)`, cerca(await v('#saled-total'), esperada70), String(await v('#saled-total')));
  check('   y el profit en USD se acomoda solo', cerca(await v('#saled-profit'), esperada70 - compra), String(await v('#saled-profit')));
  check('   lo que se está escribiendo no se pisa (sigue diciendo 70)', (await page.inputValue('#saled-porcentaje')) === '70');
  await page.locator('#saled-profit').focus();
  check('   al salir del casillero queda el % real con la venta en centavos (≈70)', cerca(await v('#saled-porcentaje'), 70, 0.02), String(await v('#saled-porcentaje')));

  await page.fill('#saled-profit', '200');
  check(`escribir profit 200 → la venta pasa a ${(compra + 200).toFixed(2)} y el % se acomoda`, cerca(await v('#saled-total'), compra + 200) && cerca(await v('#saled-porcentaje'), 200 / compra * 100, 0.02), `${await v('#saled-total')} / ${await v('#saled-porcentaje')}`);
  check('   los costos no se tocaron', [await v('#saled-flete'), await v('#saled-fuel'), await v('#saled-seguro'), await v('#saled-adicionales')].join('|') === costosAntes);
  await page.fill('#saled-profit', '');
  check('   borrar el casillero no rompe ni mueve la venta', cerca(await v('#saled-total'), compra + 200));
  await page.fill('#saled-profit', '200');

  check('   nada se guardó todavía (la venta sigue en 500 en el sistema)', cerca((await salida()).total, 500));
  await page.click('#sal-modal-save');
  await esperar(1500);
  const s1 = await salida();
  check('al guardar: venta y profit nuevos quedan en el envío, la compra igual', cerca(s1.total, compra + 200) && cerca(s1.profit_estimado, 200) && cerca(s1.compra_estimada, compra), `total ${s1.total} profit ${s1.profit_estimado} compra ${s1.compra_estimada}`);
  // Escribir la venta sigue funcionando como siempre
  await page.waitForSelector(`tr[data-envio-id="${env.id}"]`);
  await page.click(`tr[data-envio-id="${env.id}"] td[data-col="cliente"]`).catch(() => page.click(`tr[data-envio-id="${env.id}"] td[data-col="courier"]`));
  await page.waitForSelector('#saled-porcentaje'); await esperar(400);
  await page.fill('#saled-total', '600');
  check('escribir la venta sigue recalculando profit y % (como siempre)', cerca(await v('#saled-profit'), 600 - compra) && cerca(await v('#saled-porcentaje'), (600 - compra) / compra * 100, 0.02));

  console.log('\n2. Guía con seguro → la carga del envío trae "Asegurado" tildado\n');
  const guia = (asegurada, id) => ({ id, numero_guia: `1Z327W09679600${id}`, estado: 'emitida', entorno: 'prod', cliente_nombre: 'PROFIT A MANO SA', asegurada, ddp: false, fob: 457, fecha: hoy, bultos: [{}], peso_real: 5, destinatario_nombre: 'Arete Studio', destinatario_ciudad: 'Miami', destinatario_pais: 'US',
    envio: { cliente_id: cli.id, fecha: hoy, servicio_ups: 'UPS_EXP', numero_guia: `1Z327W09679600${id}`, pais_destino: 'Estados Unidos', cantidad_bultos: 1, peso_real: 5, largo: 30, ancho: 20, alto: 20, fob: 457, ddp: 0, observaciones: '', bultos: [] } });
  await page.route('**/api/guias/pendientes*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([guia(true, 9001), guia(false, 9002)]) }));
  await page.goto(`${BASE}/pages/envios.html`);
  await page.waitForSelector('#precargas-lista [data-cargar="9001"]');
  await page.click('#precargas-lista [data-cargar="9001"]'); await esperar(900);
  check('guía ASEGURADA: el formulario viene con "Asegurado" tildado y el FOB de la guía', await page.isChecked('#asegurado') && (await page.inputValue('#fob')) === '457' && (await page.inputValue('#numero_guia')) === '1Z327W096796009001');
  await page.fill('#fob', '50'); await esperar(300);
  check('   y no se destilda sola si después se corrige el FOB (manda la guía)', await page.isChecked('#asegurado'));
  await page.click('#precargas-lista [data-cargar="9002"]'); await esperar(900);
  check('guía SIN seguro: viene sin la tilde, aunque el FOB sea de 457', !(await page.isChecked('#asegurado')) && (await page.inputValue('#fob')) === '457');
  check('sin errores de JavaScript', errores.length === 0, errores.join(' | '));

  await browser.close();
  console.log(`\n${ok} pasaron · ${fail} fallaron\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
