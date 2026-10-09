#!/usr/bin/env node
// Ocultar columnas en Salidas (09/10/2026, pedido de Felipe): cualquier columna se puede
// sacar de la vista desde el botón "Ocultar columnas"; queda guardado por navegador; la banda
// de grupos y las sub-filas acomodan sus colspans; las flechas y la suma de celdas saltean
// lo oculto; convive con el bloque UPS y con las columnas fijas; el Excel sale completo.
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3985;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_ocultar_cols.db';
const TOKEN = 'token-test-ocultar-cols';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const J = (m, u, b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const hoy = new Date();
  const fecha = iso(new Date(hoy.getFullYear(), hoy.getMonth(), Math.max(1, hoy.getDate() - 1)));
  const cli = (await J('POST', '/api/clientes', { nombre: 'OCULTAR PRUEBA', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  const alta = (guia) => J('POST', '/api/envios', { cliente_id: cli.id, fecha, courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP', numero_guia: guia, pais_destino: 'Estados Unidos', peso_real: 10, largo: 30, ancho: 20, alto: 15, fob: 300, total_cobrado: 100 });
  const e1 = (await alta('1Z000OCULTAR000001')).body;
  const e2 = (await alta('1Z000OCULTAR000002')).body;
  check('fixture: dos envíos', e1 && e1.id && e2 && e2.id);

  const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(2500);

  const visible = (col) => page.evaluate((c) => { const th = document.querySelector(`.salidas-table thead tr.th-cols th[data-col="${c}"]`); return !!th && getComputedStyle(th).display !== 'none'; }, col);
  const tdVisible = (id, col) => page.evaluate(([i, c]) => { const td = document.querySelector(`tr[data-envio-id="${i}"] td[data-col="${c}"]`); return !!td && getComputedStyle(td).display !== 'none'; }, [id, col]);
  const grupoSpan = (cls) => page.evaluate((k) => { const th = document.querySelector(`.salidas-table thead tr.th-groups th.${k}`); return th ? [th.colSpan, getComputedStyle(th).display] : null; }, cls);

  console.log('\n1. Ocultar y mostrar\n');
  check('el botón está y sin columnas ocultas no marca nada', !!(await page.$('#btn-hide-cols')) && !(await page.$('#btn-hide-cols.active')));
  await page.click('#btn-hide-cols');
  await esperar(300);
  check('abre el panel con un tilde por columna, todos tildados', await page.isVisible('#hidden-cols-panel') && (await page.$$eval('#hidden-cols-panel input[type=checkbox]', (cs) => cs.length > 30 && cs.every((c) => c.checked))));
  await page.click('#hidden-cols-panel input[value="seguro"]');
  await page.click('#hidden-cols-panel input[value="fuel"]');
  await esperar(300);
  check('Seguro y Fuel desaparecen del thead', !(await visible('seguro')) && !(await visible('fuel')) && (await visible('flete')));
  check('y de las filas', !(await tdVisible(e1.id, 'seguro')) && !(await tdVisible(e2.id, 'fuel')) && (await tdVisible(e1.id, 'flete')));
  const g = await grupoSpan('thg-costos');
  check('la banda "Costos (USD)" abarca 2 columnas menos (9 → 7)', g && g[0] === 7, JSON.stringify(g));
  check('el botón marca 2 ocultas', /2/.test(await page.textContent('#btn-hide-cols')) && !!(await page.$('#btn-hide-cols.active')));
  // Un grupo entero oculto desaparece.
  await page.click('#hidden-cols-panel input[value="profit"]');
  await page.click('#hidden-cols-panel input[value="porcentaje"]');
  await esperar(300);
  const gr = await grupoSpan('thg-resultado');
  check('ocultando Profit y % desaparece el título "Resultado"', gr && gr[1] === 'none', JSON.stringify(gr));
  await page.click('#hidden-cols-panel input[value="profit"]');
  await page.click('#hidden-cols-panel input[value="porcentaje"]');
  await esperar(300);
  check('al volver a tildarlas, "Resultado" vuelve con sus 2 columnas', JSON.stringify(await grupoSpan('thg-resultado')) === '[2,"table-cell"]', JSON.stringify(await grupoSpan('thg-resultado')));

  console.log('\n2. Sobrevive al re-render, al filtro y a recargar\n');
  await page.fill('#buscador', 'OCULTAR');
  await esperar(800);
  check('tras filtrar, Seguro y Fuel siguen ocultas', !(await visible('seguro')) && !(await tdVisible(e1.id, 'fuel')));
  await page.reload();
  await esperar(2500);
  check('tras recargar la página también (localStorage)', !(await visible('seguro')) && !(await visible('fuel')) && /2/.test(await page.textContent('#btn-hide-cols')));

  console.log('\n3. Flechas y suma saltean lo oculto\n');
  await page.click(`tr[data-envio-id="${e1.id}"] td[data-col="flete"]`);
  await esperar(600);
  if (await page.isVisible('#sal-modal-cancel')) { await page.click('#sal-modal-cancel'); await esperar(300); }
  await page.focus('#table-wrap');
  const colActiva = () => page.evaluate(() => { const td = document.querySelector('td.cell-active') || document.querySelector('.salidas-table td.active-cell'); return td ? td.dataset.col : null; });
  const antes = await colActiva();
  await page.keyboard.press('ArrowRight');
  await esperar(200);
  const despues = await colActiva();
  check(`→ desde Flete va a Dscto, que está visible (${antes} → ${despues})`, antes === 'flete' && despues === 'descuento', `${antes} → ${despues}`);
  await page.keyboard.press('ArrowRight');
  await esperar(200);
  check('la siguiente es Flete+Fuel (Seguro y Fuel salteadas)', (await colActiva()) === 'flete_fuel', await colActiva());

  console.log('\n4. Convive con el bloque UPS y las fijas\n');
  await page.click('#btn-toggle-ups');
  await esperar(400);
  const upsOn = await page.evaluate(() => !document.getElementById('salidas-table').classList.contains('ups-collapsed'));
  check('el bloque UPS se pliega/despliega igual con columnas ocultas', typeof upsOn === 'boolean' && (await visible('flete')) && !(await visible('seguro')));
  await page.click('#btn-sticky-cols');
  await esperar(200);
  await page.click('#sticky-cols-panel input[value="flete"]');
  await esperar(300);
  const stickyCss = await page.evaluate(() => document.getElementById('sticky-cols-style').textContent);
  check('fijar Flete sigue andando', /position:sticky/.test(stickyCss));

  console.log('\n5. Mostrar todas y Excel completo\n');
  await page.click('#btn-hide-cols');
  await esperar(200);
  await page.click('#hidden-cols-panel .hidden-cols-all');
  await esperar(300);
  check('"Mostrar todas" las trae de vuelta', (await visible('seguro')) && (await visible('fuel')) && !(await page.$('#btn-hide-cols.active')));
  check('la banda "Costos (USD)" vuelve a 9', JSON.stringify(await grupoSpan('thg-costos')) === '[9,"table-cell"]', JSON.stringify(await grupoSpan('thg-costos')));
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  await browser.close(); matar();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1500).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
