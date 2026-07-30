#!/usr/bin/env node
/**
 * test-aviso-guia.js — el aviso de guía mal tipeada, en un navegador de verdad.
 *
 * Verifica que el validador esté efectivamente cargado en las pantallas y que el aviso
 * aparezca y desaparezca. Un `node --check` no dice nada de esto: el archivo puede estar
 * perfecto y el <script> no estar en el HTML.
 *
 *   cd backend && node scripts/test-aviso-guia.js
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.log('⚠ playwright no está instalado — se saltea la prueba de navegador.');
  console.log('  El validador en sí lo cubre scripts/test-validar-guia.js, que no necesita nada.');
  process.exit(0);
}

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT_TEST || 3997;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_aviso_guia.db';
const TOKEN = 'token-test-aviso-guia';

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
  await new Promise((res, rej) => db.run(
    'INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?,?,?)',
    [crypto.createHash('sha256').update(TOKEN).digest('hex'), 1, new Date(Date.now() + 36e5).toISOString()],
    (e) => (e ? rej(e) : res())));
  db.close();

  const candidatos = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = candidatos.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));

  console.log('\n1. Cargar envío — aviso debajo del campo\n');
  await page.goto(BASE + '/pages/envios.html', { waitUntil: 'networkidle' });
  await esperar(700);

  check('el validador está cargado en la pantalla',
    await page.evaluate(() => typeof validarGuia === 'function'));

  const estado = () => page.evaluate(() => {
    const a = document.getElementById('aviso-guia');
    return { visible: !!a && a.style.display !== 'none', texto: a ? a.textContent : null };
  });

  await page.selectOption('#courier', 'UPS');
  await page.fill('#numero_guia', '1Z327W096794727256');   // buena
  await page.dispatchEvent('#numero_guia', 'blur');
  await esperar(300);
  check('una guía bien tipeada no muestra aviso', !(await estado()).visible,
    JSON.stringify(await estado()));

  await page.fill('#numero_guia', '1Z32W7096793613086');   // cruzada, de la base real
  await page.dispatchEvent('#numero_guia', 'blur');
  await esperar(300);
  let e = await estado();
  check('una guía cruzada muestra el aviso', e.visible, JSON.stringify(e));
  check('y el aviso explica qué revisar', /verificador|caracteres/i.test(e.texto || ''), e.texto);

  await page.fill('#numero_guia', '1Z327W096794727256');   // vuelve a una buena
  await page.dispatchEvent('#numero_guia', 'blur');
  await esperar(300);
  check('al corregirla el aviso desaparece', !(await estado()).visible);

  console.log('\n2. Salidas — ícono en el renglón\n');
  await page.goto(BASE + '/pages/salidas.html', { waitUntil: 'networkidle' });
  await esperar(1500);

  check('el validador está cargado en Salidas',
    await page.evaluate(() => typeof validarGuia === 'function'));

  const pintadas = await page.evaluate(() =>
    document.querySelectorAll('td[data-col="numero_guia"].cell-guia-mala').length);
  const filas = await page.evaluate(() => document.querySelectorAll('td[data-col="numero_guia"]').length);
  check('hay renglones de guías en pantalla', filas > 0, `${filas} renglones`);
  check('las guías mal tipeadas tienen la celda pintada', pintadas > 0, `${pintadas} pintadas`);
  console.log(`      ${filas} renglones · ${pintadas} celdas pintadas`);

  // el color tiene que verse de verdad, no solo estar la clase puesta
  const fondo = await page.evaluate(() => {
    const td = document.querySelector('td[data-col="numero_guia"].cell-guia-mala');
    return td ? getComputedStyle(td).backgroundColor : null;
  });
  check('la celda pintada tiene fondo ámbar', fondo === 'rgb(254, 243, 199)', fondo);

  const titulo = await page.evaluate(() => {
    const td = document.querySelector('td[data-col="numero_guia"].cell-guia-mala');
    return td ? td.getAttribute('title') : null;
  });
  check('y al pasar el mouse explica el motivo', /mal cargada/i.test(titulo || ''), titulo);

  const iconosViejos = await page.evaluate(() => document.querySelectorAll('.guia-sospechosa').length);
  check('ya no queda el ícono chiquito', iconosViejos === 0, `${iconosViejos}`);

  console.log('\n3. Sin errores de JavaScript\n');
  const relevantes = errores.filter((x) => !/favicon|net::ERR/i.test(x));
  check('ningún error en las dos pantallas', relevantes.length === 0, relevantes.slice(0, 2).join(' | '));

  await browser.close();
  srv.kill();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
