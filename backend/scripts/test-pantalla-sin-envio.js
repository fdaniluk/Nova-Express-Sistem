#!/usr/bin/env node
/**
 * test-pantalla-sin-envio.js — la pestaña "Sin envío" en un navegador de verdad.
 *
 * El endpoint lo cubre test-guias-sin-envio.js. Esto controla lo otro: que la pestaña
 * exista, que se pueda abrir y que pinte las filas.
 * Un endpoint perfecto con una pestaña que no abre no le sirve a nadie.
 *
 *   cd backend && node scripts/test-pantalla-sin-envio.js
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

const PORT = process.env.PORT_TEST || 3990;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_sin_envio.db';
const TOKEN = 'token-test-pantalla-sin-envio';
const PDF = path.join(__dirname, '..', '..', 'facturas-ejemplo', 'factura_test_ups.pdf');

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await esperar(300);
  }

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await q('INSERT OR REPLACE INTO sesiones (token_hash,usuario_id,expira_en) VALUES (?,?,?)',
    [crypto.createHash('sha256').update(TOKEN).digest('hex'), 1, new Date(Date.now() + 36e5).toISOString()]);

  // Se deja la factura de ejemplo cargada con casi todas sus guías sin envío.
  await q('DELETE FROM factura_guias');
  await q('DELETE FROM facturas_cargadas');
  const { extraerFacturaUPS } = require('../src/services/factura-ups.service.js');
  const factura = await extraerFacturaUPS(fs.readFileSync(PDF));
  for (const g of factura.guias) {
    await q('DELETE FROM envio_bultos WHERE envio_id IN (SELECT id FROM envios WHERE numero_guia = ?)', [g.numero_guia]);
    await q('DELETE FROM envios WHERE numero_guia = ?', [g.numero_guia]);
  }
  const fd = new FormData();
  fd.append('pdf', new Blob([fs.readFileSync(PDF)], { type: 'application/pdf' }), 'factura.pdf');
  fd.append('sobreescribir', 'false');
  await fetch(BASE + '/api/facturas/cargar', {
    method: 'POST', headers: { Cookie: `nova_session=${TOKEN}` }, body: fd });
  db.close();

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errores.push('console: ' + m.text()); });
  const faltantes = [];
  page.on('response', (r) => { if (r.status() === 404) faltantes.push(r.url()); });

  console.log('\n1. La pestaña existe y avisa cuántas hay\n');
  await page.goto(BASE + '/pages/facturas.html', { waitUntil: 'networkidle' });
  await esperar(1200);

  check('está la pestaña "Sin envío"',
    await page.evaluate(() => !!document.querySelector('[data-tab="sinenvio"]')));

  const badge = await page.evaluate(() => {
    const b = document.getElementById('sinenvio-badge');
    return b ? { texto: b.textContent, visible: !b.classList.contains('hidden') } : null;
  });
  check('el contador de la pestaña se ve sin tener que abrirla', badge && badge.visible,
    JSON.stringify(badge));
  check('y dice cuántas guías quedaron sin envío', badge && Number(badge.texto) >= 9,
    badge ? badge.texto : '-');

  console.log('\n2. Al abrirla, muestra las filas\n');
  await page.click('[data-tab="sinenvio"]');
  await esperar(1200);

  check('la pestaña se abre', await page.evaluate(() =>
    !document.getElementById('tab-sinenvio').classList.contains('hidden')));

  const filas = await page.evaluate(() =>
    document.querySelectorAll('#fac-sinenvio-body tr').length);
  check('pinta una fila por guía', filas >= 9, `${filas} filas`);

  const counter = await page.evaluate(() => {
    const c = document.getElementById('fac-sinenvio-counter');
    return c ? c.textContent.trim() : null;
  });
  check('muestra el total de plata facturada', /USD|\$/.test(counter || ''), counter);
  console.log(`\n   ${counter}\n`);

  const texto = await page.evaluate(() =>
    document.getElementById('fac-sinenvio-body').textContent);
  check('las filas muestran los números de guía', /1Z327W/.test(texto), texto.slice(0, 80));

  // No se sugiere ningún envío parecido (ver el comentario en facturas.routes.js).
  check('no aparece ninguna sugerencia de guía parecida',
    !/quisiste|diferencia/i.test(texto), texto.slice(0, 100));

  console.log('3. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|net::ERR/i.test(x));
  const falt = faltantes.filter((u) => !/favicon/i.test(u));
  if (falt.length) console.log('    404: ' + falt.join('\n    404: '));
  // el 404 del favicon no es un problema de la pantalla; cualquier otro sí
  const soloFavicon = falt.length === 0 && rel.every((x) => /Failed to load resource/.test(x));
  check('ningún error en la pantalla', rel.length === 0 || soloFavicon,
    rel.slice(0, 2).join(' | '));

  await browser.close();
  srv.kill();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
