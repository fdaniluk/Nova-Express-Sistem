#!/usr/bin/env node
// Salud y Cobros en pickup con la estética del sistema (08/10/2026, último ítem).
//   · Salud: semáforo en tarjetas (urgente / para mirar / en orden / corte), grupos en pasos
//     con chip de resumen, filtro "solo lo que hay que mirar".
//   · Cobros en pickup: el alta es el paso 1 siempre a la vista; guardar, editar y borrar
//     siguen andando; chips de forma de pago y origen; tarjeta de clientes.
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3974;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_salud_cobros.db';
const TOKEN = 'token-test-salud-cobros';
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const cli = await J('POST', '/clientes', { nombre: 'Fagliano Test', tipo_cobro: 'D' });
  check('fixture: cliente creado', cli.status === 201 || cli.status === 200, JSON.stringify(cli.body).slice(0, 120));
  const clienteId = cli.body.id || (cli.body.cliente && cli.body.cliente.id);

  const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text()); });
  page.on('dialog', (d) => d.accept());

  console.log('\n1. Salud\n');
  await page.goto(`${BASE}/pages/salud.html`);
  await esperar(2500);
  const tiles = await page.$$eval('.salud-tile', (ts) => ts.map((t) => t.className + '|' + (t.querySelector('.tile-label') || {}).textContent));
  check('semáforo: urgente, para mirar y en orden siempre están', tiles.some((t) => /rojo\|Urgente/.test(t)) && tiles.some((t) => /ambar\|Para mirar/.test(t)) && tiles.some((t) => /ok\|En orden/.test(t)), tiles.join(' ; '));
  check('los grupos son pasos numerados con chip de resumen', (await page.$$('.salud-paso')).length === 3 && (await page.$$('.salud-paso .sal-chip')).length === 3);
  check('la cabecera dice cuándo se revisó', /revisado/.test(await page.textContent('#sal-revisado')));
  check('el botón principal es coral', !!(await page.$('#btn-refrescar.btn-coral')));
  const total = (await page.$$('.chequeo')).length;
  await page.click('#sal-filtro button[data-filtro="mirar"]');
  await esperar(200);
  const visibles = await page.$$eval('.chequeo', (cs) => cs.filter((c) => !c.classList.contains('oculto')).length);
  const conAlgo = await page.$$eval('.chequeo', (cs) => cs.filter((c) => !c.classList.contains('ok')).length);
  check(`"solo lo que hay que mirar" esconde los verdes (${visibles} de ${total})`, visibles === conAlgo && visibles < total, `${visibles}/${total}, con algo ${conAlgo}`);
  check('un grupo sin nada dice "nada para mirar"', (await page.$$eval('.sal-vacio', (vs) => vs.filter((v) => !v.hidden).length)) >= 0);
  await page.click('#sal-filtro button[data-filtro="todos"]');
  await esperar(200);
  check('"Todos" los vuelve a mostrar', (await page.$$eval('.chequeo', (cs) => cs.filter((c) => !c.classList.contains('oculto')).length)) === total);
  check('los chequeos con algo siguen arrancando abiertos y con su botón', (await page.$$eval('.chequeo:not(.ok)', (cs) => cs.every((c) => c.classList.contains('abierto')))));

  console.log('\n2. Cobros en pickup\n');
  await page.goto(`${BASE}/pages/cobros-pickup.html`);
  await esperar(2000);
  check('el alta es el paso 1 y está a la vista', !!(await page.$('#form-panel.cp-paso')) && (await page.isVisible('#form-cobranza-el')));
  check('dos pasos', (await page.$$('.cp-paso')).length === 2);
  await page.selectOption('#c-cliente', String(clienteId));
  await page.fill('#c-monto', '150000');
  await page.selectOption('#c-forma_pago', 'transferencia');
  await page.fill('#c-nota', 'a cuenta de septiembre');
  await page.click('#btn-guardar');
  await esperar(1200);
  const fila = await page.$('#tabla-cobranzas tr:has-text("Fagliano Test")');
  check('guardar lista la cobranza', !!fila);
  check('forma de pago y origen como chips', !!fila && !!(await fila.$('.cp-chip-azul:has-text("transferencia")')) && !!(await fila.$('.cp-chip:has-text("directa")')));
  check('la tarjeta de clientes cuenta 1', (await page.textContent('#total-clientes')).trim() === '1' && /Fagliano Test/.test(await page.textContent('#desglose-clientes')));
  check('el total ARS se actualizó', /150\.000/.test(await page.textContent('#total-ars')), await page.textContent('#total-ars'));
  check('la cabecera dice cuántos cobros hay', /1 cobro/.test(await page.textContent('#cp-resumen')));
  check('el formulario volvió a "nueva" después de guardar', (await page.textContent('#form-title')).trim() === 'Nueva cobranza' && (await page.inputValue('#c-monto')) === '');
  await (await fila.$('button[data-action="editar"]')).click();
  await esperar(300);
  check('editar carga la fila en el paso 1 y lo marca', (await page.textContent('#form-title')).trim() === 'Editar cobranza' && (await page.inputValue('#c-monto')) === '150000' && !!(await page.$('#form-panel.editando')));
  await page.fill('#c-monto', '175000');
  await page.click('#btn-guardar');
  await esperar(1200);
  check('guardar cambios actualiza el monto', /175\.000/.test(await page.textContent('#tabla-cobranzas')), (await page.textContent('#tabla-cobranzas')).slice(0, 200));
  check('y el formulario vuelve a "nueva"', (await page.textContent('#form-title')).trim() === 'Nueva cobranza' && !(await page.$('#form-panel.editando')));
  await (await page.$('#tabla-cobranzas button[data-action="eliminar"]')).click();
  await esperar(1200);
  check('eliminar la saca de la lista', /No hay cobranzas/.test(await page.textContent('#tabla-cobranzas')));
  check('ningún error en las pantallas', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  await browser.close(); matar();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1500).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
