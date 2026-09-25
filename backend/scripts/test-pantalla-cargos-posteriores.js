#!/usr/bin/env node
/**
 * test-pantalla-cargos-posteriores.js — cargos posteriores (25/09/2026) en un navegador
 * de verdad: "+ Agregar cargo" en el modal de Salidas, chip "cargo" en la grilla y la
 * sección "Cargos de envíos anteriores" en la vista previa de Liquidaciones.
 *
 *   cd backend && node scripts/test-pantalla-cargos-posteriores.js
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3941;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || path.join(require('os').tmpdir(), 'test_pantalla_cargos.db');
const TOKEN = 'token-test-pantalla-cargos';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
const SHOTS = process.env.SHOTS_DIR || null;

let ok = 0; let fail = 0;
let matarTodo = () => {};
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else { fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = ''; let logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; });
  let muerto = false;
  const matarSrv = () => { if (muerto) return; muerto = true; try { srv.kill(); } catch { /* ya */ } };
  matarTodo = matarSrv;
  process.on('exit', matarSrv);
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const J = async (m, u, b) => {
    const r = await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const hoy = new Date();
  const dia = (n) => iso(new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - n));
  const a = (await J('POST', '/api/clientes', { nombre: 'KOSTUME PRUEBA', tarifa_pct: 75, tipo_cobro: 'CC' })).body;
  const alta = (guia, fecha, total, extra = {}) => J('POST', '/api/envios', {
    cliente_id: a.id, fecha, courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP',
    numero_guia: guia, pais_destino: 'Estados Unidos', peso_real: 5, largo: 30, ancho: 20, alto: 15,
    fob: 300, total_cobrado: total, ...extra,
  });
  // Mismo mes que los nuevos, así los tres se ven en la solapa activa de Salidas.
  const viejo = (await alta('1Z000CARGO00000001', dia(hoy.getDate() > 12 ? 10 : 0), 236.4, { ddp: 1 })).body;
  const nuevo1 = (await alta('1Z000CARGO00000002', dia(3), 118.2)).body;
  const nuevo2 = (await alta('1Z000CARGO00000003', dia(1), 402.7)).body;
  // El viejo se liquida y confirma → después le llegan los impuestos DDP.
  const liq0 = await J('POST', '/api/liquidaciones', { cliente_id: a.id, periodo_desde: dia(60), periodo_hasta: dia(30), envio_ids: [viejo.id], cargos: [], cotizaciones: [], confirmar: true });
  check('fixture: liquidación del envío viejo confirmada', liq0.status === 201 && liq0.body.estado === 'confirmada', JSON.stringify(liq0.body).slice(0, 120));
  const rc = await J('POST', `/api/salidas/${viejo.id}/cargos`, { tipo: 'ddp', monto: 33.4 });
  check('API: se agrega un cargo DDP al envío ya liquidado (queda pendiente)', rc.status === 201 && rc.body.estado === 'pendiente', JSON.stringify(rc.body).slice(0, 120));
  const rBad = await J('POST', `/api/salidas/${viejo.id}/cargos`, { tipo: 'otro', monto: 5 });
  check('API: "otro" sin nombre → 400', rBad.status === 400);
  const tipos = await J('GET', '/api/salidas/cargos/tipos');
  check('API: la lista de tipos llega', tipos.status === 200 && tipos.body.ddp);

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('dialog', (d) => d.accept());
  page.on('console', (m) => { if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text()); });

  // ── 1. Salidas: chip y modal ─────────────────────────────────────────────────
  console.log('\n1. Salidas\n');
  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  // El envío viejo es de hace 40 días: puede estar en otra solapa de mes. Buscamos por guía.
  const chipViejo = await page.$(`#salidas-body tr[data-envio-id="${viejo.id}"] .chip-cargo`);
  check('el envío viejo muestra el chip "cargo" (pendiente)', !!chipViejo);
  if (chipViejo) check('el chip dice el importe', /33[.,]40/.test(await chipViejo.textContent()), await chipViejo.textContent());

  await page.click('text=1Z000CARGO00000002');
  await esperar(600);
  check('se abre el modal del envío nuevo', !!(await page.$('#sal-edit-overlay:not(.hidden)')));
  check('el bloque "Cargos posteriores" está', !!(await page.$('#saled-cargos-block')));
  check('arranca sin cargos', /Sin cargos posteriores/.test(await page.textContent('#saled-cargos-block')));
  await page.click('#saled-cargo-btn');
  await esperar(200);
  check('el formulario aparece', !!(await page.$('#saled-cargo-form:not(.hidden)')));
  await page.selectOption('#saled-cargo-tipo', 'sobrepeso');
  await page.fill('#saled-cargo-monto', '12.5');
  await page.click('#saled-cargo-form button[type=submit]');
  await esperar(900);
  const bloque = await page.textContent('#saled-cargos-block');
  check('el cargo queda listado como pendiente', /Sobrepeso/.test(bloque) && /pendiente/.test(bloque), bloque.slice(0, 120));
  check('el chip aparece en la grilla sin refrescar', !!(await page.$(`#salidas-body tr[data-envio-id="${nuevo1.id}"] .chip-cargo`)));
  await page.click('#saled-cargo-btn');
  await page.selectOption('#saled-cargo-tipo', 'otro');
  check('con "otro" aparece el campo del nombre', !!(await page.$('#saled-cargo-label:not(.hidden)')));
  await page.fill('#saled-cargo-label', 'Reempaque');
  await page.fill('#saled-cargo-monto', '7');
  await page.click('#saled-cargo-form button[type=submit]');
  await esperar(900);
  check('el segundo cargo también está', /Reempaque/.test(await page.textContent('#saled-cargos-block')));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'cargos-modal.png') });
  // Anular el segundo
  const dels = await page.$$('.saled-cargo-del');
  check('cada cargo pendiente tiene su × para anular', dels.length === 2, String(dels.length));
  await dels[1].click();
  await esperar(900);
  check('anulado: desaparece del bloque', !/Reempaque/.test(await page.textContent('#saled-cargos-block')));
  await page.click('#sal-modal-close');
  await esperar(300);

  // ── 2. Liquidaciones: vista previa con cargos ────────────────────────────────
  console.log('\n2. Liquidaciones\n');
  await page.goto(`${BASE}/pages/liquidaciones.html`);
  await esperar(2500);
  const tarjeta = await page.textContent('#pendientes-list');
  check('Pendientes avisa "+ 1 cargo de envíos anteriores"', /1 cargo de envíos anteriores/.test(tarjeta), tarjeta.slice(0, 200));
  await page.click('.tab[data-tab="crear"]');
  await page.selectOption('#liq-cliente', String(a.id));
  await page.fill('#liq-desde', dia(10));
  await page.fill('#liq-hasta', dia(0));
  await page.click('#btn-cargar-envios');
  await esperar(1200);
  await page.click('#btn-preview');
  await esperar(1500);
  const prev = await page.textContent('#liq-preview');
  check('el ítem del envío nuevo desglosa "Sobrepeso"', /Sobrepeso/.test(prev));
  check('la sección "Cargos de envíos anteriores" se ve', !!(await page.$('#liq-cargos-ant:not([hidden])')));
  const ant = await page.textContent('#liq-cargos-ant');
  check('…con la guía del envío viejo y los impuestos DDP', /1Z000CARGO00000001/.test(ant) && /Impuestos de destino/.test(ant) && /33[.,]40/.test(ant), ant.slice(0, 200));
  const totalTxt = await page.textContent('#liq-cargos-ant .liq-total-general');
  const esperado = 118.2 + 12.5 + 402.7 + 33.4;
  check(`el total liquidación = envíos + cargo + anteriores (${esperado.toFixed(2)})`, totalTxt.replace(/\./g, '').replace(',', '.').includes(esperado.toFixed(2).replace('.', '.')) || /566[.,]80/.test(totalTxt), totalTxt);
  check('la fila de la tabla dice "Total envíos" y suma solo los envíos (533,40)', /Total envíos/.test(prev) && /533[.,]40/.test(await page.textContent('#liq-total')), await page.textContent('#liq-total'));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'cargos-liquidacion.png'), fullPage: true });

  // Confirmar → Excel con la sección
  await page.click('#btn-confirmar-liq');
  await esperar(1500);
  const hist = await J('GET', `/api/liquidaciones?cliente_id=${a.id}`);
  const conf = hist.body.find((l) => l.estado === 'confirmada' && l.id !== liq0.body.id);
  check('se confirmó la liquidación con el total completo', conf && Math.abs(conf.total - esperado) < 0.011, conf && String(conf.total));
  const x = await fetch(`${BASE}/api/liquidaciones/${conf.id}/export`, { headers: H });
  check('el Excel se descarga', x.status === 200);
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
  const textos = []; wb.getWorksheet('Liquidacion').eachRow((row) => row.eachCell((c) => { if (typeof c.value === 'string') textos.push(c.value); }));
  check('el Excel tiene la sección CARGOS DE ENVÍOS ANTERIORES y el TOTAL LIQUIDACIÓN', textos.includes('CARGOS DE ENVÍOS ANTERIORES') && textos.includes('TOTAL LIQUIDACIÓN'));
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'liq-cargos.xlsx'), Buffer.from(await (await fetch(`${BASE}/api/liquidaciones/${conf.id}/export`, { headers: H })).arrayBuffer()));

  // El chip del viejo se apaga (cargo ya liquidado)
  const cargosViejo = (await J('GET', `/api/salidas/${viejo.id}/cargos`)).body;
  check('el cargo del envío viejo quedó "liquidado" en la nueva liquidación', cargosViejo[0].estado === 'liquidado' && cargosViejo[0].liquidacion_id === conf.id);

  check('la pantalla no tiró ningún error de JavaScript', errores.length === 0, errores.join(' | ').slice(0, 200));
  await browser.close();
  matarSrv();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => {}, 200).unref();
}

main().catch((e) => { console.error(e); process.exitCode = 1; matarTodo(); });
