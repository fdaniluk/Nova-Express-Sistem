#!/usr/bin/env node
/**
 * test-pantalla-filtros-salidas.js — los filtros por columna nuevos y el botón "1º bulto".
 *
 * Pedido de la oficina (28/08/2026): filtrar "como en el Excel", por columna. Se sumaron
 * desplegables a Fecha, #Sal, Bulto (por CANTIDAD de bultos del envío), Aseg y Revisión,
 * y un botón que deja UN renglón por envío para que el desglose de los multibulto no
 * ensucie la vista cuando revisan envíos.
 *
 *   cd backend && node scripts/test-pantalla-filtros-salidas.js
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
const { prepararDb, abrirSesion } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3944;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_filtros_salidas.db';
const TOKEN = 'token-test-filtros-salidas';

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
  // Guard de doble kill + espera del exit: ver test-pantalla-sin-envio.js (Windows).
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
    body: JSON.stringify({ nombre: 'FILTROS PANTALLA', tarifa_pct: 75 }),
  })).json();

  // Un envío de TRES bultos y uno de UN bulto, del día: el juego mínimo para probar
  // el "1º bulto" y el filtro por cantidad.
  const multi = await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion',
      numero_guia: '1Z000FILT000000001', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
      fob: 50, total_cobrado: 300,
      bultos: [
        { peso_real: 5, largo: 30, ancho: 20, alto: 20 },
        { peso_real: 6, largo: 30, ancho: 20, alto: 20 },
        { peso_real: 7, largo: 30, ancho: 20, alto: 20 },
      ],
    }),
  })).json();
  const simple = await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion',
      numero_guia: '1Z000FILT000000002', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
      fob: 120, total_cobrado: 100, asegurado: 1,
      bultos: [{ peso_real: 2, largo: 20, ancho: 15, alto: 10 }],
    }),
  })).json();
  check('se cargaron los dos envíos de prueba', !!multi.id && !!simple.id,
    JSON.stringify({ m: multi.id, s: simple.id }));

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errores.push(m.text());
  });

  console.log('\n1. Los filtros nuevos existen\n');
  await page.goto(BASE + '/pages/salidas.html', { waitUntil: 'networkidle' });
  await esperar(1200);

  for (const col of ['fecha', 'numero_salida', 'numero_bulto', 'asegurado', 'revision']) {
    check(`hay filtro de columna para ${col}`,
      await page.evaluate((c) => !!document.querySelector(`.filter-btn[data-filter="${c}"]`), col));
  }
  check('está el botón "1º bulto"', await page.evaluate(() => !!document.getElementById('btn-primer-bulto')));

  // Filas del envío multibulto (todas comparten data-envio-id).
  const filasDe = (id) => page.evaluate((i) =>
    document.querySelectorAll(`#salidas-body tr[data-envio-id="${i}"]`).length, id);

  console.log('\n2. "1º bulto" deja un renglón por envío\n');
  check('el multibulto muestra sus 3 renglones', (await filasDe(multi.id)) === 3,
    `${await filasDe(multi.id)}`);
  await page.click('#btn-primer-bulto');
  await esperar(400);
  check('con "1º bulto" queda 1 renglón', (await filasDe(multi.id)) === 1,
    `${await filasDe(multi.id)}`);
  check('y la celda sigue diciendo 1/3 (se ve que hay más bultos)',
    await page.evaluate((i) =>
      /1\/3/.test(document.querySelector(`#salidas-body tr[data-envio-id="${i}"]`)?.textContent || ''), multi.id));
  check('el de un bulto sigue con su renglón', (await filasDe(simple.id)) === 1);
  await page.click('#btn-primer-bulto'); // volver
  await esperar(400);
  check('al apagarlo vuelven los 3 renglones', (await filasDe(multi.id)) === 3);

  console.log('\n3. El filtro por cantidad de bultos (el caso del Excel de la oficina)\n');
  await page.click('.filter-btn[data-filter="numero_bulto"]');
  await esperar(300);
  await page.click('#dd-criterios button[data-criterio="cantidad_bultos"]');
  await esperar(300);
  const valores = await page.evaluate(() =>
    [...document.querySelectorAll('#dd-list label')].map((l) => l.textContent.trim()));
  check('el desplegable lista las cantidades (1 y 3)',
    valores.includes('1') && valores.includes('3'), valores.join('|'));
  await page.evaluate(() => {
    const cb = [...document.querySelectorAll('#dd-list input[type=checkbox]')].find((c) => c.value === '1');
    cb.click();
  });
  await page.click('#dd-apply');
  await esperar(400);
  check('filtrando "1" el multibulto desaparece', (await filasDe(multi.id)) === 0);
  check('y el de un bulto queda', (await filasDe(simple.id)) === 1);
  check('el chip del filtro dice Cant. bultos: 1',
    await page.evaluate(() => /Cant\. bultos:\s*1/.test(document.getElementById('filter-chips')?.textContent || '')),
    await page.evaluate(() => document.getElementById('filter-chips')?.textContent));

  console.log('\n4. El filtro de asegurado\n');
  await page.evaluate(() => document.querySelector('.chip-remove')?.click());
  await esperar(300);
  await page.click('.filter-btn[data-filter="asegurado"]');
  await esperar(300);
  const valsAseg = await page.evaluate(() =>
    [...document.querySelectorAll('#dd-list label')].map((l) => l.textContent.trim()));
  check('el desplegable de Aseg ofrece Sí/No', valsAseg.includes('Sí') && valsAseg.includes('No'),
    valsAseg.join('|'));
  await page.evaluate(() => {
    const cb = [...document.querySelectorAll('#dd-list input[type=checkbox]')].find((c) => c.value === 'Sí');
    cb.click();
  });
  await page.click('#dd-apply');
  await esperar(400);
  check('filtrando "Sí" queda el envío con FOB 120 (asegurado solo)', (await filasDe(simple.id)) === 1);
  check('y el de FOB 50 se va', (await filasDe(multi.id)) === 0);

  // ── El filtro que faltaba (31/08): por NÚMERO de bulto ─────────────────────
  //
  // "poder filtrar todos los bultos 1/1 1/2 1/3, para los casos en los que no interesa
  // ver los 2/2 2/3". Es un filtro de RENGLÓN, no de envío: el mismo envío aporta
  // renglones que entran y renglones que no.
  console.log('\n5. El filtro por número de bulto\n');
  await page.evaluate(() => document.querySelectorAll('.chip-remove').forEach((b) => b.click()));
  await esperar(400);

  await page.click('.filter-btn[data-filter="numero_bulto"]');
  await esperar(300);
  check('el desplegable abre en "Bulto n°"',
    await page.evaluate(() => document.querySelector('#dd-criterios button.active')?.dataset.criterio === 'numero_bulto'),
    await page.evaluate(() => document.querySelector('#dd-criterios button.active')?.textContent.trim()));
  const valsNum = await page.evaluate(() =>
    [...document.querySelectorAll('#dd-list label')].map((l) => l.textContent.trim()));
  check('ofrece los números de bulto que existen (1, 2 y 3)',
    ['1', '2', '3'].every((v) => valsNum.includes(v)), valsNum.join('|'));

  await page.evaluate(() => {
    const cb = [...document.querySelectorAll('#dd-list input[type=checkbox]')].find((c) => c.value === '1');
    cb.click();
  });
  await page.click('#dd-apply');
  await esperar(400);

  check('del multibulto queda UN renglón (el 1 de 3)', (await filasDe(multi.id)) === 1,
    String(await filasDe(multi.id)));
  check('y sigue diciendo 1/3: el total es el del envío, no el de lo que se ve',
    await page.evaluate((i) => /1\/3/.test(
      document.querySelector(`#salidas-body tr[data-envio-id="${i}"]`)?.textContent || ''), multi.id));
  check('el envío de un solo bulto no se va (su bulto TAMBIÉN es el 1)',
    (await filasDe(simple.id)) === 1);
  check('el chip dice Bulto n°: 1',
    await page.evaluate(() => /Bulto n°:\s*1/.test(document.getElementById('filter-chips')?.textContent || '')));

  // El caso inverso: pedir el bulto 3 deja SOLO el multibulto, y el de una caja se va.
  await page.click('.filter-btn[data-filter="numero_bulto"]');
  await esperar(300);
  await page.evaluate(() => {
    document.querySelectorAll('#dd-list input[type=checkbox]').forEach((c) => { if (c.checked) c.click(); });
    const cb = [...document.querySelectorAll('#dd-list input[type=checkbox]')].find((c) => c.value === '3');
    cb.click();
  });
  await page.click('#dd-apply');
  await esperar(400);
  check('filtrando el bulto 3 queda solo el renglón 3/3', (await filasDe(multi.id)) === 1);
  check('y el envío de un bulto desaparece (no tiene bulto 3)', (await filasDe(simple.id)) === 0);
  check('el renglón visible es el 3/3, con los datos del envío igual',
    await page.evaluate((i) => {
      const tr = document.querySelector(`#salidas-body tr[data-envio-id="${i}"]`);
      return /3\/3/.test(tr?.textContent || '') && /FILTROS PANTALLA/.test(tr?.textContent || '');
    }, multi.id));

  // Los dos criterios de la columna Bulto conviven.
  await page.click('.filter-btn[data-filter="numero_bulto"]');
  await esperar(300);
  check('el desplegable vuelve a abrir en el criterio aplicado',
    await page.evaluate(() => document.querySelector('#dd-criterios button.active')?.dataset.criterio === 'numero_bulto'));
  await page.click('#dd-criterios button[data-criterio="cantidad_bultos"]');
  await esperar(300);
  check('al cambiar de criterio la lista pasa a las cantidades',
    await page.evaluate(() => document.querySelector('#dd-criterios button.active')?.dataset.criterio === 'cantidad_bultos'));
  await page.click('#dd-clear');
  await esperar(400);
  check('el ▼ de Bulto sigue encendido: el filtro por número sigue puesto',
    await page.evaluate(() => document.querySelector('.filter-btn[data-filter="numero_bulto"]')?.classList.contains('active')));

  await page.evaluate(() => document.querySelectorAll('.chip-remove').forEach((b) => b.click()));
  await esperar(400);
  check('quitados los chips, vuelven los cuatro renglones',
    (await filasDe(multi.id)) === 3 && (await filasDe(simple.id)) === 1,
    `${await filasDe(multi.id)} + ${await filasDe(simple.id)}`);

  console.log('\n6. Sin errores de JavaScript\n');
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 2).join(' | '));

  await browser.close();
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
