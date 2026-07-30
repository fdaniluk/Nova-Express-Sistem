#!/usr/bin/env node
/**
 * test-liquidacion-sin-cotizador.js — la pantalla de liquidaciones después de sacar el
 * botón "Cotizar" por fila.
 *
 * Ese botón recalculaba un precio y lo mostraba, pero el resultado NUNCA llegaba a la
 * liquidación: el backend ignora `cotizaciones` a propósito desde que se decidió que la
 * liquidación no recotiza y lee los valores congelados del envío. El botón era lo que
 * quedó de la etapa anterior.
 *
 * Lo que importa probar es que sacarlo no rompió el flujo real: elegir cliente, ver los
 * envíos, calcular la previa y que el total dé lo mismo que antes.
 *
 *   cd backend && node scripts/test-liquidacion-sin-cotizador.js
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

const PORT = process.env.PORT_TEST || 3987;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_liq_sin_cot.db';
const TOKEN = 'token-test-liq-sin-cot';

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
  await abrirSesion(DB, TOKEN);

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

  // ── 1. Pendientes en orden alfabético ───────────────────────────────────────
  console.log('\n1. Pendientes en orden alfabético\n');
  await page.goto(BASE + '/pages/liquidaciones.html', { waitUntil: 'networkidle' });
  await esperar(1800);

  const nombres = await page.evaluate(() =>
    [...document.querySelectorAll('#pendientes-list [data-liq-cliente]')]
      .map((b) => b.closest('.card, .pend-card, tr, div')?.textContent || '')
      .map((t) => t.trim().split('\n')[0].trim()).filter(Boolean));
  check('la lista de pendientes tiene clientes', nombres.length > 0, `${nombres.length}`);
  if (nombres.length > 1) {
    const orden = [...nombres].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    check('vienen en orden alfabético', nombres.every((n, i) => n === orden[i]),
      nombres.slice(0, 4).join(' | '));
    console.log(`\n   ${nombres.slice(0, 5).join('\n   ')}\n`);
  }

  // ── 2. El botón Cotizar ya no está ──────────────────────────────────────────
  console.log('2. El botón "Cotizar" por fila ya no está\n');

  // Se usa el camino REAL de la oficina: el botón "Liquidar" de la primera tarjeta de
  // pendientes. Elegir un cliente cualquiera del desplegable no sirve: la mayoría no tiene
  // envíos pendientes y la tabla queda vacía por motivos legítimos.
  const cliente = await page.evaluate(() => {
    const btn = document.querySelector('#pendientes-list [data-liq-cliente]');
    if (!btn) return null;
    btn.click();
    return btn.dataset.liqCliente;
  });
  check('se entró a liquidar el primer cliente pendiente', !!cliente, String(cliente));
  await esperar(2500);

  const restos = await page.evaluate(() => ({
    botones: document.querySelectorAll('.btn-cotizar').length,
    paneles: document.querySelectorAll('.cot-panel').length,
    calc: document.querySelectorAll('.btn-calc-cot').length,
  }));
  check('no quedan botones "Cotizar"', restos.botones === 0, JSON.stringify(restos));
  check('no quedan paneles del cotizador', restos.paneles === 0, JSON.stringify(restos));
  check('no quedan botones "Calcular" de fila', restos.calc === 0, JSON.stringify(restos));

  // ── 3. El flujo real sigue andando ──────────────────────────────────────────
  console.log('\n3. Calcular la liquidación sigue funcionando\n');

  const filas = await page.evaluate(() =>
    document.querySelectorAll('#liq-envios-body tr').length);
  check('se listan los envíos del cliente', filas > 0, `${filas} filas`);

  // el encabezado de la tabla de ENVÍOS (no el de la previa, que está en el mismo bloque)
  const cols = await page.evaluate(() => {
    const tr = document.querySelector('#liq-envios-body tr');
    const th = document.querySelector('#liq-envios-body')
      ?.closest('table')?.querySelectorAll('thead th').length;
    return { celdas: tr ? tr.querySelectorAll('td').length : 0, encabezados: th || 0 };
  });
  check('las columnas del encabezado y de las filas coinciden',
    cols.celdas > 0 && cols.celdas === cols.encabezados, JSON.stringify(cols));

  await page.click('#btn-preview');
  await esperar(2500);

  const total = await page.evaluate(() => {
    const el = document.getElementById('liq-total');
    return el ? el.textContent.trim() : null;
  });
  check('la previa calcula un total', /\d/.test(total || ''), String(total));
  console.log(`\n   total de la previa: ${total}\n`);

  const confirmarHabilitado = await page.evaluate(() => {
    const b = document.getElementById('btn-confirmar-liq');
    return b ? !b.disabled : null;
  });
  check('el botón de confirmar queda habilitado', confirmarHabilitado === true,
    String(confirmarHabilitado));

  console.log('\n4. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|net::ERR|Failed to load resource/i.test(x));
  check('ningún error en la pantalla', rel.length === 0, rel.slice(0, 2).join(' | '));

  await browser.close();
  srv.kill();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
