#!/usr/bin/env node
/**
 * test-pantalla-cargar-envio.js — Cargar envío en 4 pasos con resumen lateral (12/09/2026).
 *
 * Estética módulo por módulo (Felipe, 08/09): Guías quedó como referencia y Cargar envío
 * era el primero de la lista. La maqueta la aprobó el 12/09 ("me gusta como quedó"). La
 * pantalla se reorganizó SIN cambiar ningún id: 1 Cliente y courier · 2 Destino y bultos ·
 * 3 Valor y extras · 4 Precio (cotizador automático + total cobrado + cotizaciones del
 * cliente), y a la derecha el resumen con el botón "Guardar envío".
 *
 * Lo que cuida esta tanda: los cuatro pasos con su número y título; el selector de servicio
 * UPS al lado del courier (aparece solo con UPS); "+ Agregar bulto" suma a la cantidad y
 * dibuja la fila; el resumen lateral espeja cliente, courier, guía, destino, bultos, FOB y
 * precio a medida que se carga; "Usar este precio" del cotizador cae en el total y en el
 * resumen; el botón Guardar del resumen crea el envío de verdad; "Cancelar edición" se
 * esconde hasta que se edita uno; y ningún error en consola.
 *
 *   cd backend && node scripts/test-pantalla-cargar-envio.js
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

const PORT = process.env.PORT_TEST || 3947;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_cargar_envio.db';
const TOKEN = 'token-test-cargar-envio';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  prepararDb(DB, { desdeProduccion: false });
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
  const cli = (await J('POST', '/api/clientes', { nombre: 'PASOS ENVIO SA', tarifa_pct: 80 })).body;

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text());
  });
  const resumen = async (k) => (await page.textContent(`#env-resumen [data-r="${k}"]`)).trim();

  console.log('\n1. Los cuatro pasos y el resumen\n');
  await page.goto(`${BASE}/pages/envios.html`);
  await esperar(2000);
  const pasos = await page.$$eval('#panel-nuevo .env-paso', (els) => els.map((e) => ({
    n: e.querySelector('.gui-num')?.textContent.trim(), t: e.querySelector('h3')?.textContent.trim(),
  })));
  check('hay cuatro pasos numerados', pasos.length === 4 && pasos.map((p) => p.n).join('') === '1234', JSON.stringify(pasos));
  check('con sus títulos', pasos.map((p) => p.t).join(' | ') === 'Cliente y courier | Destino y bultos | Valor y extras | Precio', pasos.map((p) => p.t).join(' | '));
  const enPaso = async (n, sel) => page.$(`#panel-nuevo .env-paso[data-paso="${n}"] ${sel}`);
  check('paso 1: cliente, fecha, courier, guía, dirección, tipo de paquete y "sin numerar"',
    !!(await enPaso(1, '#cliente_id')) && !!(await enPaso(1, '#fecha')) && !!(await enPaso(1, '#courier')) && !!(await enPaso(1, '#numero_guia'))
    && !!(await enPaso(1, '#tipo_envio')) && !!(await enPaso(1, '#tipo_paquete')) && !!(await enPaso(1, '#sin_numerar')));
  check('paso 2: país, zona, zona de entrega, cantidad, peso, medidas y el peso facturable',
    !!(await enPaso(2, '#pais_destino')) && !!(await enPaso(2, '#zona')) && !!(await enPaso(2, '#entrega')) && !!(await enPaso(2, '#cantidad_bultos'))
    && !!(await enPaso(2, '#peso_real')) && !!(await enPaso(2, '#largo')) && !!(await enPaso(2, '#peso-preview')) && !!(await enPaso(2, '#btn-agregar-bulto')));
  check('paso 3: FOB, fuel, asegurado, DDP, protección doc. y observaciones',
    !!(await enPaso(3, '#fob')) && !!(await enPaso(3, '#fuel_origen')) && !!(await enPaso(3, '#fuel_pct')) && !!(await enPaso(3, '#asegurado'))
    && !!(await enPaso(3, '#ddp')) && !!(await enPaso(3, '#proteccion_doc')) && !!(await enPaso(3, '#observaciones')));
  check('paso 4: cotizador automático, total cobrado y cotizaciones del cliente',
    !!(await enPaso(4, '#cot-profit')) && !!(await enPaso(4, '#cot-panel')) && !!(await enPaso(4, '#total_cobrado')) && !!(await enPaso(4, '#ctzr-panel')) && !!(await enPaso(4, '#ctzr-refrescar')));
  check('el resumen lateral existe con el botón Guardar y el Cancelar escondido',
    !!(await page.$('.gui-lateral #env-resumen')) && !!(await page.$('.gui-lateral #btn-guardar-envio'))
    && await page.$eval('#btn-cancelar-edit', (b) => b.classList.contains('hidden')));
  check('el botón Guardar apunta al formulario', (await page.getAttribute('#btn-guardar-envio', 'form')) === 'form-envio');
  check('las precargas siguen arriba del formulario (escondidas sin guías)', await page.$eval('#precargas-panel', (p) => p.classList.contains('hidden')));

  console.log('\n2. Courier y servicio UPS\n');
  check('con DHL no se ve el servicio UPS', await page.$eval('#cot-ups-wrap', (w) => w.style.display === 'none'));
  await page.selectOption('#courier', 'UPS'); await esperar(200);
  check('con UPS aparece "Servicio UPS" al lado del courier', await page.$eval('#cot-ups-wrap', (w) => w.style.display !== 'none' && !!w.closest('.env-paso[data-paso="1"]')));
  check('y la protección de documentos (solo DHL) se esconde', await page.$eval('#grupo-proteccion-doc', (g) => g.style.display === 'none'));

  console.log('\n3. El resumen espeja lo cargado\n');
  await page.selectOption('#cliente_id', String(cli.id)); await esperar(400);
  check('cliente', (await resumen('cliente')) === 'PASOS ENVIO SA', await resumen('cliente'));
  check('courier con el servicio', /UPS Expedited/.test(await resumen('courier')), await resumen('courier'));
  await page.fill('#numero_guia', '1Z327W096794727256'); await esperar(200);
  check('guía', (await resumen('guia')) === '1Z327W096794727256');
  await page.selectOption('#pais_destino', { label: 'Estados Unidos' }); await esperar(600);
  check('destino con la zona', /Estados Unidos · zona \d/.test(await resumen('destino')), await resumen('destino'));
  await page.fill('#peso_real', '6'); await page.fill('#largo', '30'); await page.fill('#ancho', '20'); await page.fill('#alto', '20');
  await page.fill('#fob', '300'); await esperar(1500);
  check('bultos con el peso facturable', /1 · 6(\.0)? kg facturables/.test(await resumen('bultos')), await resumen('bultos'));
  check('FOB con "asegurado" (FOB ≥ 100 se marca solo)', /300,00 · asegurado/.test(await resumen('fobr')), await resumen('fobr'));
  check('precio todavía vacío', (await resumen('fob')) === '—', await resumen('fob'));

  console.log('\n4. "+ Agregar bulto"\n');
  await page.click('#btn-agregar-bulto'); await esperar(500);
  check('la cantidad pasa a 2', (await page.inputValue('#cantidad_bultos')) === '2');
  check('aparecen las dos filas de bulto', (await page.$$('#bultos-container .bulto-row')).length === 2);
  check('el peso y las medidas de arriba quedan bloqueados (salen de los bultos)', await page.$eval('#peso_real', (i) => i.readOnly && i.classList.contains('campo-bloqueado')));
  await page.fill('[data-bulto="1"][data-field="peso_real"]', '6'); await page.fill('[data-bulto="1"][data-field="largo"]', '30'); await page.fill('[data-bulto="1"][data-field="ancho"]', '20'); await page.fill('[data-bulto="1"][data-field="alto"]', '20');
  await page.fill('[data-bulto="2"][data-field="peso_real"]', '4'); await page.fill('[data-bulto="2"][data-field="largo"]', '40'); await page.fill('[data-bulto="2"][data-field="ancho"]', '30'); await page.fill('[data-bulto="2"][data-field="alto"]', '20');
  await esperar(1500);
  check('el peso balanza de arriba es la suma (10)', (await page.inputValue('#peso_real')) === '10');
  check('el resumen dice 2 bultos', /^2 · /.test(await resumen('bultos')), await resumen('bultos'));

  console.log('\n5. El precio del cotizador cae en el total y en el resumen\n');
  check('el cotizador automático cotizó', !(await page.$eval('#cot-panel', (p) => p.classList.contains('hidden'))));
  const sugerido = parseFloat(await page.inputValue('#cot-precio-editable'));
  check('con un precio sugerido', sugerido > 0, String(sugerido));
  await page.click('#btn-aplicar-precio'); await esperar(300);
  check('"Usar este precio" lo pone en Total cobrado', parseFloat(await page.inputValue('#total_cobrado')) === sugerido);
  check('y el resumen lo muestra', (await resumen('fob')) !== '—' && /US\$/.test(await resumen('fob')), await resumen('fob'));

  console.log('\n6. Guardar desde el resumen crea el envío\n');
  await page.click('#btn-guardar-envio'); await esperar(1500);
  const lista = (await J('GET', `/api/envios?cliente_id=${cli.id}`)).body;
  const envios = Array.isArray(lista) ? lista : (lista.items || lista.envios || []);
  const creado = envios.find((e) => e.numero_guia === '1Z327W096794727256');
  check('el envío existe con la guía cargada', !!creado, JSON.stringify(envios).slice(0, 120));
  check('con 2 bultos y 10 kg de balanza', creado && Number(creado.cantidad_bultos) === 2 && Number(creado.peso_real) === 10, creado && JSON.stringify([creado.cantidad_bultos, creado.peso_real]));
  check('con el precio del cotizador', creado && Math.abs(Number(creado.total_cobrado) - sugerido) < 0.01, creado && String(creado.total_cobrado));
  check('después de guardar el formulario vuelve a cero y el resumen también', (await page.inputValue('#numero_guia')) === '' && (await resumen('guia')) === '—');

  console.log('\n7. Editar uno muestra "Cancelar edición" y el título cambia\n');
  await page.click('.tab[data-tab="listado"]'); await esperar(1200);
  await page.click(`#tabla-envios [data-edit="${creado.id}"]`); await esperar(1500);
  check('el título dice Editar envío', /Editar envío/.test(await page.textContent('#form-title')));
  check('"Cancelar edición" se ve en el resumen', !(await page.$eval('#btn-cancelar-edit', (b) => b.classList.contains('hidden'))));
  check('el resumen trae la guía del envío editado', (await resumen('guia')) === '1Z327W096794727256');
  await page.click('#btn-cancelar-edit'); await esperar(500);
  check('Cancelar vuelve a "Cargar envío" y esconde el botón', /Cargar envío/.test(await page.textContent('#form-title')) && await page.$eval('#btn-cancelar-edit', (b) => b.classList.contains('hidden')));
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
