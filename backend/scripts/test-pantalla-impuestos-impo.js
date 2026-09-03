#!/usr/bin/env node
/**
 * test-pantalla-impuestos-impo.js — el panel de impuestos de impo EN LA PANTALLA.
 *
 * La matemática la clava test-impuestos-impo.js contra las 4 liquidaciones reales; esto
 * controla lo otro: que el panel del cotizador ARME esos renglones sin romperse — el
 * gasto documental fijo de UPS, el procesamiento + IIBB de DHL, y el arancel "Otro %"
 * que se sumó porque las facturas reales trajeron un 16% que los radios no tenían.
 *
 *   cd backend && node scripts/test-pantalla-impuestos-impo.js
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

const PORT = process.env.PORT_TEST || 3943;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_impuestos.db';
const TOKEN = 'token-test-impuestos';

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

  // Espera la línea de "listo" que imprime NUESTRO servidor (no un /api/health que puede
  // contestar otro node vivo en el puerto), hasta 60 s: en Windows el primer arranque de
  // node del día tarda y con 12 s el test reventaba con un ECONNREFUSED que parecía del
  // cortafuegos. Ver scripts/_base-test.js.
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);

  // El cotizador necesita el fuel cargado para cotizar (regla de la pantalla).
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));
  await q("INSERT OR REPLACE INTO configuracion_nova (id, fuel_pct, fecha_actualizacion) VALUES (1, 37, datetime('now'))");
  await new Promise((res) => db.close(() => res()));

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));

  await page.goto(BASE + '/pages/cotizador.html', { waitUntil: 'networkidle' });
  await esperar(800);

  console.log('\n1. Una impo de China con arancel 20%\n');
  await page.selectOption('#tipo', 'import');
  await page.selectOption('#pais', { label: 'China' }).catch(() => page.selectOption('#pais', 'China'));
  await page.selectOption('#couriers', 'ambos');
  await page.fill('#valor', '2900');
  const conCliente = await page.evaluate(() => {
    const g = document.getElementById('ganancia');
    return g && g.disabled;
  });
  if (!conCliente) await page.fill('#ganancia', '50');
  await page.fill('.bulto-row .b-peso', '100');
  await page.fill('.bulto-row .b-largo', '60');
  await page.fill('.bulto-row .b-ancho', '50');
  await page.fill('.bulto-row .b-alto', '50');
  await page.click('input[name="arancel"][value="0.20"]');
  await page.click('.btn-calc');
  await esperar(1200);

  // Se lee SOLO el panel de resultados: document.body.textContent incluye el código del
  // script inline, que contiene estas mismas frases adentro del template.
  const texto = await page.evaluate(() => document.getElementById('results').textContent);
  check('el panel de impuestos aparece', /Impuestos en destino estimados/.test(texto));
  check('dice arancel 20%', /arancel 20%/.test(texto));
  check('UPS muestra su gasto documental FIJO de USD 126', /Gasto documental UPS \(fijo USD 126\)/.test(texto));
  check('DHL muestra su procesamiento (1,465% CIF)', /Procesamiento de aranceles DHL/.test(texto));
  check('DHL muestra la percepción IIBB', /Percep\. IIBB \(Bs\.As\. 4% \+ CABA 3%\)/.test(texto));

  console.log('\n2. El arancel "Otro %" (el 16% real de la factura de UPS)\n');
  await page.click('input[name="arancel"][value="otro"]');
  await page.fill('#arancel-otro', '16');
  await page.click('.btn-calc');
  await esperar(1200);
  const texto2 = await page.evaluate(() => document.getElementById('results').textContent);
  check('cotiza con el arancel tipeado', /arancel 16%/.test(texto2), (texto2.match(/arancel [\d,.]+%/) || [])[0]);
  check('los derechos dicen 16%', /Derechos importación \(16%\)/.test(texto2));

  console.log('\n3. Sin arancel no hay panel, y sin errores\n');
  await page.click('input[name="arancel"][value="0"]');
  await page.click('.btn-calc');
  await esperar(1000);
  const texto3 = await page.evaluate(() => document.getElementById('results').textContent);
  check('sin arancel el panel no aparece', !/Impuestos en destino estimados/.test(texto3));
  const rel = errores.filter((x) => !/favicon|Failed to load resource/i.test(x));
  check('ningún error de JavaScript', rel.length === 0, rel.slice(0, 2).join(' | '));

  await browser.close();
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
