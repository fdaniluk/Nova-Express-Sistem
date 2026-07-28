#!/usr/bin/env node
/**
 * test-regla-documentos.js — prueba en navegador REAL la regla "documentos solo por DHL".
 *
 * Levanta el sistema, abre Cargar envío y el Cotizador en Chromium, y verifica que al
 * elegir "Documento" el courier quede forzado a DHL y las opciones de UPS bloqueadas.
 *
 * Un `node --check` solo valida sintaxis: no detecta que una función referenciada esté
 * fuera de alcance ni que un listener no se dispare. Por eso esta prueba abre la página
 * de verdad.
 *
 *   cd backend && node scripts/test-regla-documentos.js
 *
 * Requiere: npm install playwright  ·  DB_PATH apuntando a una copia (no a la base viva).
 */

// Playwright NO es dependencia del proyecto (baja ~150 MB de navegador). Si no está
// instalado la prueba se saltea con aviso en vez de romper: el freno del backend lo
// cubre scripts/test-api-documentos-dhl.js, que no necesita nada extra.
let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.log('⚠ playwright no está instalado — se saltea la prueba de navegador.');
  console.log('  Para correrla:  npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT_TEST || 3991;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_regla_doc.db';
const TOKEN = 'token-test-regla-documentos';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  // ── servidor ──────────────────────────────────────────────────────────────
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

  // sesión directa en la base, para no pasar por el login
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const hash = crypto.createHash('sha256').update(TOKEN).digest('hex');
  await new Promise((res, rej) => db.run(
    'INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?,?,?)',
    [hash, 1, new Date(Date.now() + 3600e3).toISOString()],
    (e) => (e ? rej(e) : res())
  ));
  db.close();

  const fs = require('fs');
  const candidatos = [
    process.env.CHROME_PATH,
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  ].filter(Boolean);
  const exe = candidatos.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errores.push('console: ' + m.text()); });
  const faltantes = [];
  page.on('response', (r) => { if (r.status() === 404) faltantes.push(r.url()); });

  // ── 1. Cargar envío ───────────────────────────────────────────────────────
  console.log('\n1. Cargar envío — regla documentos → DHL\n');
  await page.goto(BASE + '/pages/envios.html', { waitUntil: 'networkidle' });
  await esperar(700);

  const estado = () => page.evaluate(() => ({
    courier: document.getElementById('courier').value,
    upsDeshabilitado: [...document.getElementById('courier').options]
      .filter((o) => o.value !== 'DHL').every((o) => o.disabled),
    avisoVisible: (() => {
      const a = document.getElementById('aviso-doc-dhl');
      return !!a && a.style.display !== 'none';
    })(),
    upsWrap: document.getElementById('cot-ups-wrap').style.display,
  }));

  const inicial = await estado();
  check('arranca en mercadería con UPS habilitado', !inicial.upsDeshabilitado, JSON.stringify(inicial));
  check('el aviso arranca oculto', !inicial.avisoVisible);

  // elegir UPS primero, después documento: tiene que volver a DHL
  await page.selectOption('#courier', 'UPS');
  await esperar(250);
  check('se puede elegir UPS con mercadería', (await estado()).courier === 'UPS');

  await page.selectOption('#tipo_paquete', 'd');
  await esperar(700);
  const conDoc = await estado();
  check('al elegir Documento el courier pasa a DHL', conDoc.courier === 'DHL', conDoc.courier);
  check('las opciones de UPS quedan bloqueadas', conDoc.upsDeshabilitado);
  check('aparece el aviso', conDoc.avisoVisible);
  check('se oculta el selector de variante UPS', conDoc.upsWrap === 'none', conDoc.upsWrap);

  await page.selectOption('#tipo_paquete', 'm');
  await esperar(400);
  const conMerc = await estado();
  check('al volver a Mercadería se re-habilita UPS', !conMerc.upsDeshabilitado);
  check('el aviso se vuelve a ocultar', !conMerc.avisoVisible);

  // ── 2. Cotizador ──────────────────────────────────────────────────────────
  console.log('\n2. Cotizador — regla documentos → solo DHL\n');
  await page.goto(BASE + '/pages/cotizador.html', { waitUntil: 'networkidle' });
  await esperar(700);

  const estadoCot = () => page.evaluate(() => ({
    couriers: document.getElementById('couriers').value,
    upsDeshabilitado: [...document.getElementById('couriers').options]
      .filter((o) => o.value !== 'dhl').every((o) => o.disabled),
  }));

  const ci = await estadoCot();
  check('arranca con las opciones de UPS habilitadas', !ci.upsDeshabilitado, JSON.stringify(ci));

  await page.selectOption('#couriers', 'ups_sav');
  await esperar(200);
  await page.selectOption('#contenido', 'documento');
  await esperar(600);
  const cd = await estadoCot();
  check('al elegir Documento queda en "Solo DHL"', cd.couriers === 'dhl', cd.couriers);
  check('las opciones de UPS quedan bloqueadas', cd.upsDeshabilitado);

  await page.selectOption('#contenido', 'paquete');
  await esperar(400);
  const cp = await estadoCot();
  check('al volver a Paquete se re-habilita UPS', !cp.upsDeshabilitado);
  check('recupera la elección previa (UPS Saver)', cp.couriers === 'ups_sav', cp.couriers);

  // ── 3. Sin errores de JS ──────────────────────────────────────────────────
  console.log('\n3. Consola del navegador\n');
  const relevantes = errores.filter((e) => !/favicon|net::ERR/i.test(e));
  const faltantesReales = faltantes.filter((u) => !/favicon/i.test(u));
  if (faltantesReales.length) console.log('    404: ' + faltantesReales.join('\n    404: '));
  // un 404 de favicon no es un error de la pantalla; cualquier otro sí
  const soloFavicon = relevantes.length > 0 && faltantesReales.length === 0 &&
    relevantes.every((e) => /Failed to load resource/.test(e));
  check('ningún error de JavaScript en las dos pantallas',
    relevantes.length === 0 || soloFavicon,
    relevantes.slice(0, 3).join(' | '));

  await browser.close();
  srv.kill();

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
