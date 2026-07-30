#!/usr/bin/env node
/**
 * test-pantalla-tarifa-kg.js — el perfil del cliente en modo "precio por kilo",
 * en un navegador de verdad.
 *
 * El motor y el resolvedor los cubre test-tarifa-por-kg.js. Esto controla lo otro: que la
 * oficina pueda efectivamente cambiar el modo, cargar un rango y ver el precio en la
 * grilla. Una API perfecta con una pantalla que no guarda no le sirve a nadie.
 *
 *   cd backend && npm run test-pantalla-tarifa-kg
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.log('⚠ playwright no está instalado — se saltea (necesita navegador de verdad).');
  process.exit(0);
}

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
// Arranque común: base de test fresca (copia de producción) y sesión válida.
// Ver scripts/_base-test.js para por qué hace falta.
const { prepararDb, abrirSesion } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3986;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_tarifa_kg.db';
const TOKEN = 'token-test-tarifa-kg';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Base de test: copia FRESCA de la de producción en cada corrida.
  prepararDb(DB);

  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  // Si el test se corta por un error, el servidor tiene que morir igual: si queda vivo se
  // queda con el puerto y la corrida siguiente le habla al servidor VIEJO, con la base
  // vieja, y falla con 401 sin motivo aparente.
  process.on('exit', () => { try { srv.kill(); } catch {} });

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await esperar(300);
  }

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await abrirSesion(DB, TOKEN);
  const [cliente] = await q('SELECT id, nombre FROM clientes WHERE activo = 1 ORDER BY id LIMIT 1');
  await q('DELETE FROM tarifa_kg_overrides WHERE cliente_id = ?', [cliente.id]);
  await q("UPDATE clientes SET modo_tarifa = 'porcentaje', fuel_pct_propio = NULL WHERE id = ?", [cliente.id]);
  db.close();

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errores.push('console: ' + m.text()); });

  // ── 1. Arranca en modo porcentaje, como siempre ─────────────────────────────
  console.log('\n1. El perfil abre en modo porcentaje\n');
  await page.goto(`${BASE}/pages/clientes-perfil.html?id=${cliente.id}`, { waitUntil: 'networkidle' });
  await esperar(1200);
  await page.click('#btn-editar-tarifas');
  await esperar(1200);

  check('el selector de modo está en la pantalla',
    await page.evaluate(() => !!document.getElementById('tarifas-modo-select')));
  check('arranca en "Porcentaje de ganancia"',
    (await page.inputValue('#tarifas-modo-select')) === 'porcentaje');
  check('el control de rangos está oculto en modo porcentaje',
    await page.evaluate(() => document.getElementById('tarifas-rangos').classList.contains('hidden')));

  const bandasPct = await page.evaluate(() =>
    [...document.querySelectorAll('td.banda-label')].map((t) => t.textContent.trim()));
  check('se ven las 9 bandas fijas de siempre', bandasPct.length === 9, bandasPct.join(' | '));
  const celdaPct = await page.evaluate(() => {
    const td = document.querySelector('td.tarifa-cell .cell-val');
    return td ? td.textContent.trim() : null;
  });
  check('las celdas muestran porcentajes', /%$/.test(celdaPct || ''), String(celdaPct));

  // ── 2. Cambiar a precio por kilo ────────────────────────────────────────────
  console.log('\n2. Pasarlo a precio por kilo\n');
  await page.selectOption('#tarifas-modo-select', 'por_kg');
  await esperar(1500);

  check('el control de rangos aparece',
    await page.evaluate(() => !document.getElementById('tarifas-rangos').classList.contains('hidden')));
  check('la etiqueta del general pasa a USD por kilo',
    /kilo/i.test(await page.textContent('#tarifas-general-label')),
    await page.textContent('#tarifas-general-label'));
  check('avisa que todavía no hay rangos cargados',
    /rangos de peso/i.test(await page.textContent('#tarifas-grid')),
    (await page.textContent('#tarifas-grid')).slice(0, 80));

  // ── 3. Cargar el rango del ejemplo real: 1 a 10 kg a USD 5 ──────────────────
  // Cada tabla (servicio + tipo) tiene sus propios rangos, igual que la matriz de profit.
  // Se carga en UPS Expedited Expo, que es la que después cotiza el cotizador.
  console.log('\n3. Cargar un rango (1 a 10 kg, USD 5 el kilo) en UPS Expedited Expo\n');
  await page.click('#tarifas-tabs .tab[data-serv="UPS_EXP"][data-tipo="export"]');
  await esperar(1200);
  check('se puede cambiar de tabla estando en modo por kilo',
    await page.evaluate(() => !document.getElementById('tarifas-rangos').classList.contains('hidden')));

  await page.fill('#rango-desde', '1');
  await page.fill('#rango-hasta', '10');
  await page.fill('#rango-precio', '5');
  await page.click('#btn-agregar-rango');
  await esperar(1500);

  const filas = await page.evaluate(() =>
    [...document.querySelectorAll('td.banda-label')].map((t) => t.textContent.trim()));
  check('aparece la fila del rango', filas.some((f) => f.startsWith('1-10 kg')), filas.join(' | '));

  const valores = await page.evaluate(() =>
    [...document.querySelectorAll('td.tarifa-cell .cell-val')].map((v) => v.textContent.trim()));
  check('las seis zonas muestran USD 5.00',
    valores.length === 6 && valores.every((v) => v === 'USD 5.00'), valores.join(' | '));

  // ── 4. Pisar una zona puntual ───────────────────────────────────────────────
  console.log('\n4. Pisar el precio de una zona\n');
  await page.evaluate(() => document.querySelector('td.tarifa-cell[data-zona="3"]').click());
  await esperar(400);
  await page.fill('td.tarifa-cell[data-zona="3"] input', '7.5');
  await page.press('td.tarifa-cell[data-zona="3"] input', 'Enter');
  await esperar(1500);

  const trasEditar = await page.evaluate(() =>
    [...document.querySelectorAll('td.tarifa-cell')].map((td) => ({
      zona: td.dataset.zona,
      val: td.querySelector('.cell-val').textContent.trim(),
      propio: td.classList.contains('propio'),
    })));
  const z3 = trasEditar.find((c) => c.zona === '3');
  check('la zona 3 queda en USD 7.50', z3 && z3.val === 'USD 7.50', JSON.stringify(z3));
  check('y se marca como propia (se puede quitar)', z3 && z3.propio, JSON.stringify(z3));
  check('las otras zonas no se movieron',
    trasEditar.filter((c) => c.zona !== '3').every((c) => c.val === 'USD 5.00'),
    trasEditar.map((c) => c.val).join(' | '));

  // ── 5. Fuel propio del cliente ──────────────────────────────────────────────
  console.log('\n5. Fuel propio del cliente\n');
  await page.fill('#tarifas-fuel-input', '25');
  await page.click('#btn-guardar-fuel');
  await esperar(1200);
  check('se guarda y queda escrito en el campo',
    (await page.inputValue('#tarifas-fuel-input')) === '25');
  check('aparece el botón para quitarlo',
    await page.evaluate(() => !document.getElementById('btn-borrar-fuel').classList.contains('hidden')));

  await page.click('#btn-borrar-fuel');
  await esperar(1200);
  check('al quitarlo el campo queda vacío',
    (await page.inputValue('#tarifas-fuel-input')) === '');

  // ── 6. El cotizador aplica la tarifa por kilo ───────────────────────────────
  console.log('\n6. El cotizador cobra el precio por kilo\n');
  await page.goto(BASE + '/pages/cotizador.html', { waitUntil: 'networkidle' });
  await esperar(1200);
  await page.selectOption('#cliente', String(cliente.id));
  await page.selectOption('#pais', 'Estados Unidos');
  await page.selectOption('#couriers', 'ups_exp');
  await page.fill('#fuel', '39.5');
  await page.fill('.b-peso', '6');
  await page.fill('.b-largo', '30');
  await page.fill('.b-ancho', '20');
  await page.fill('.b-alto', '10');
  await page.click('.btn-calc');
  await esperar(2500);

  const texto = await page.textContent('#results');
  check('la cotización dice que es tarifa por kilo', /por kilo/i.test(texto || ''),
    (texto || '').slice(0, 120));
  check('muestra el flete como kilos × precio', /6\.0 kg × USD 5\.00/.test(texto || ''),
    (texto || '').slice(0, 200));
  check('y el flete internacional da USD 30.00', /Flete internacional[^$]*USD 30\.00/.test(texto || ''),
    (texto || '').match(/Flete internacional.{0,60}/)?.[0] || '');
  console.log(`      ${(texto || '').match(/Flete internacional.{0,50}/)?.[0] || ''}`);

  // ── 7. Un peso fuera de todo rango avisa, no cotiza cero ────────────────────
  console.log('\n7. Un peso sin rango cargado avisa\n');
  await page.fill('.b-peso', '60');
  await page.click('.btn-calc');
  await esperar(2500);

  const aviso = await page.evaluate(() => {
    const e = document.getElementById('error-msg');
    return e && e.style.display !== 'none' ? e.textContent : null;
  });
  check('sale el aviso de que falta la tarifa', /no hay tarifa cargada/i.test(aviso || ''),
    String(aviso));
  const texto2 = await page.textContent('#results');
  check('igual cotiza (con el porcentaje), no queda en cero',
    /Total/.test(texto2 || '') && !/USD 0\.00\s*$/.test(texto2 || ''), (texto2 || '').slice(0, 80));

  console.log('\n8. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|net::ERR|Failed to load resource/i.test(x));
  check('ningún error en las dos pantallas', rel.length === 0, rel.slice(0, 2).join(' | '));

  await browser.close();
  srv.kill();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
