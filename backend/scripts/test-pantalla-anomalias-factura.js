#!/usr/bin/env node
// Pantallas de las anomalías de factura e Ingresos Brutos (05/10/2026):
// Facturas → pestaña "Ingresos Brutos" y chips en "Revisar guías"; Salidas → chip ⚠ en
// Costo UPS y bloque "Factura del courier" en el modal con "Cobrar al cliente".
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3967;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_anom.db';
const TOKEN = 'token-test-anom-pantalla';
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  prepararDb(DB);
  const sqlite3 = require('sqlite3');
  const raw = new sqlite3.Database(DB);
  const run = (sql, p = []) => new Promise((res, rej) => raw.run(sql, p, function (e) { e ? rej(e) : res(this); }));
  const cli = await run("INSERT INTO clientes (nombre, tipo_cobro, tarifa_pct, activo) VALUES ('ANOM PANTALLA', 'CC', 50, 1)");
  const env1 = await run(`INSERT INTO envios (cliente_id, fecha, courier, servicio_ups, tipo_envio, numero_guia, pais_destino, peso_real, peso_facturable, fob, total_cobrado, flete, seguro, fuel, adicionales, extras_json, costo_facturado, peso_facturado, courier_facturado, fecha_facturado, estado_revision, entrega)
    VALUES (?, '2026-09-12', 'UPS', 'UPS_EXP', 'exportacion', '1Z000ANOMPANT0001', 'Reino Unido', 8, 8, 100, 200, 60, 15, 20, 5, '[{"tipo":"surge","monto":5}]', 138.00, 8, 'UPS', '2026-09-20', 'a_revisar', 'normal')`, [cli.lastID]);
  const fac = await run(`INSERT INTO facturas_cargadas (numero_factura, fecha_factura, fecha_carga, courier, total_declarado, subtotal_factura, percepciones, tipo) VALUES ('F-PANT-1', '2026-09-20', '2026-09-21', 'UPS', 142.00, 138.00, 4.00, 'flete')`);
  await run(`INSERT INTO factura_guias (factura_id, envio_id, numero_guia, pais, peso_facturado, neto, total_recargos, costo_total, cargos_json, encontrada)
    VALUES (?, ?, '1Z000ANOMPANT0001', 'Reino Unido', 8, 100, 38, 138.00, '[{"nombre":"Extended Area Surcharge Destination","monto":32},{"nombre":"Residential","monto":6}]', 1)`, [fac.lastID, env1.lastID]);
  await new Promise((r) => raw.close(r));

  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; }); srv.stderr.on('data', (d) => { logErr += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text()); });
  page.on('dialog', (d) => d.accept());

  console.log('\n1. Facturas: Ingresos Brutos y Revisar guías\n');
  await page.goto(`${BASE}/pages/facturas.html`);
  await esperar(1500);
  await page.click('.tab[data-tab="iibb"]');
  await esperar(1500);
  const iibb = await page.textContent('#tab-iibb');
  check('la pestaña lista la factura con su percepción y el total del mes', /F-PANT-1/.test(iibb) && /4[.,]00/.test(iibb) && /2026-09/.test(iibb), iibb.replace(/\s+/g, ' ').slice(0, 300));
  check('dice que no se reparte entre los envíos', /no se reparte entre los envíos/.test(iibb));
  await page.click('.tab[data-tab="revisar"]');
  await esperar(1500);
  const rev = await page.textContent('#fac-table-body');
  check('Revisar guías: la guía muestra los chips de anomalía', /1Z000ANOMPANT0001/.test(rev) && /Área remota \/ extendida: USD 32\.00 no previsto/.test(rev) && /Entrega residencial: USD 6\.00 no previsto/.test(rev), rev.replace(/\s+/g, ' ').slice(0, 300));

  console.log('\n2. Salidas: chip ⚠ y bloque "Factura del courier"\n');
  await page.goto(`${BASE}/pages/salidas.html?desde=2026-09-12&hasta=2026-09-12`);
  await esperar(2500);
  const chip = await page.$('.chip-anom');
  check('la fila tiene el chip ⚠ 2 en Costo UPS', !!chip && /2/.test(await chip.textContent()));
  const title = chip ? await chip.getAttribute('title') : '';
  check('el tooltip explica qué', /no previsto/.test(title), title);
  await page.click('text=1Z000ANOMPANT0001');
  await esperar(1200);
  check('se abre el modal', !!(await page.$('#sal-edit-overlay:not(.hidden)')));
  const bloque = await page.textContent('#saled-factura-block').catch(() => '');
  check('el modal muestra "Factura del courier" con las dos anomalías', /Factura del courier/.test(bloque) && /Área remota/.test(bloque) && /residencial/i.test(bloque), bloque.replace(/\s+/g, ' ').slice(0, 300));
  const btns = await page.$$('.saled-anom-cobrar');
  check('cada anomalía tiene "Cobrar al cliente"', btns.length === 2);
  await btns[0].click();
  await esperar(500);
  const tipo = await page.inputValue('#saled-cargo-tipo');
  const monto = await page.inputValue('#saled-cargo-monto');
  check('abre el formulario de cargo posterior precargado (remota, 32.00)', tipo === 'remota' && monto === '32.00', `${tipo} ${monto}`);
  await page.click('#saled-cargo-form button[type="submit"]');
  await esperar(1500);
  const bloque2 = await page.textContent('#saled-factura-block');
  const cargos = await page.textContent('#saled-cargos-block');
  check('al guardar, el cargo aparece en Cargos posteriores y la anomalía desaparece', /Área remota/.test(cargos) && !/Área remota \/ extendida: USD 32/.test(bloque2) && /residencial/i.test(bloque2), bloque2.replace(/\s+/g, ' ').slice(0, 200));
  const chip2 = await page.$('.chip-anom');
  check('el chip de la fila baja a 1', !!chip2 && /1/.test(await chip2.textContent()));
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  await browser.close(); matar();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1500).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
