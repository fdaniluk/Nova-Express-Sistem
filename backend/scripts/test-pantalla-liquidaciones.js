#!/usr/bin/env node
/**
 * test-pantalla-liquidaciones.js — la pantalla Liquidaciones con la estética del sistema
 * (16/09/2026, ítem 4 del orden de estética), en un navegador de verdad.
 *
 * QUÉ SE PRUEBA
 *  1. Pendientes: cada cliente es una tarjeta con nombre, chip de tipo de cobro, total y
 *     el botón Liquidar; el contador de la pestaña y la píldora de la cabecera dicen
 *     cuántos clientes hay sin liquidar.
 *  2. Crear: tres pasos numerados + resumen lateral. El resumen se arma de lo que está en
 *     pantalla (cliente, período, tildes, adicionales) y el total SOLO aparece después de
 *     Calcular. Destildar un envío invalida la previa y vuelve a apagar el total.
 *  3. 🔴 El profit de la liquidación se ve en el resumen marcado "solo oficina", y sigue
 *     sin ir al Excel (eso lo cuida test-liquidacion-desglose; acá se controla la marca).
 *  4. Historial: estado como chip (confirmada / borrador) y botones con borde.
 *  5. Teléfono (390 px): sin scroll horizontal, los campos del paso 1 entran en la
 *     tarjeta, el resumen baja debajo de los pasos.
 *  6. Ningún id que usa el JS cambió (los que toca el resto de las tandas).
 *
 *   cd backend && node scripts/test-pantalla-liquidaciones.js
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

const PORT = process.env.PORT_TEST || 3934;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || path.join(require('os').tmpdir(), 'test_pantalla_liquidaciones.db');
const TOKEN = 'token-test-pantalla-liq';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
let matarTodo = () => {};
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else {
    fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`);
  }
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
  const matarSrv = () => { if (muerto) return; muerto = true; try { srv.kill(); } catch { /* ya estaba */ } };
  matarTodo = matarSrv;
  process.on('exit', matarSrv);

  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);

  const J = async (m, u, b) => {
    const r = await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // ── Fixtures: dos clientes con envíos sin liquidar, uno ya liquidado ──────────────
  const hoy = new Date();
  const dia = (n) => iso(new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - n));
  const cli = async (nombre, tipo) => (await J('POST', '/api/clientes', { nombre, tarifa_pct: 75, tipo_cobro: tipo })).body;
  const alta = (cliente_id, guia, fecha, courier, total) => J('POST', '/api/envios', {
    cliente_id, fecha, courier, tipo_envio: 'exportacion', servicio_ups: courier === 'UPS' ? 'UPS_EXP' : undefined,
    numero_guia: guia, pais_destino: 'Estados Unidos', peso_real: 5, largo: 30, ancho: 20, alto: 15,
    fob: 300, total_cobrado: total,
  });
  const a = await cli('ASAPLAST PRUEBA', 'S');
  const b = await cli('CUEROS PRUEBA', 'CC');
  const c = await cli('NUMANA PRUEBA', 'D');
  await alta(a.id, '1Z000LIQ0000000001', dia(5), 'UPS', 236.4);
  await alta(a.id, '1Z000LIQ0000000002', dia(3), 'UPS', 118.2);
  await alta(a.id, '4400000000', dia(1), 'DHL', 402.7);
  await alta(b.id, '1Z000LIQ0000000003', dia(2), 'UPS', 566.1);
  await alta(c.id, '1Z000LIQ0000000004', dia(1), 'UPS', 157.48);
  const pendC = (await J('GET', `/api/liquidaciones/pendientes?cliente_id=${c.id}`)).body;
  await J('POST', '/api/liquidaciones', {
    cliente_id: c.id, periodo_desde: dia(30), periodo_hasta: dia(0),
    envio_ids: pendC[0].envios.map((e) => e.id), cargos: [], cotizaciones: [], confirmar: true,
  });

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text());
  });

  // ── 1. Pendientes ───────────────────────────────────────────────────────────────
  console.log('\n1. Pendientes: tarjetas por cliente y contador\n');
  await page.goto(`${BASE}/pages/liquidaciones.html`);
  await page.waitForSelector('#pendientes-list .cliente-grupo', { timeout: 15000 });
  await esperar(400);

  check('el CSS del módulo se cargó (no quedó un <style> adentro del html)',
    await page.evaluate(() => !document.querySelector('head style')
      && [...document.styleSheets].some((s) => /liquidaciones\.css/.test(s.href || ''))));

  const grupos = await page.$$eval('#pendientes-list .cliente-grupo', (gs) => gs.map((g) => ({
    nombre: g.querySelector('strong')?.textContent.trim(),
    chip: g.querySelector('.liq-chip.cobro')?.textContent.trim(),
    total: g.querySelector('.cliente-grupo-total')?.textContent.trim(),
    boton: !!g.querySelector('button[data-liq-cliente]'),
    couriers: [...g.querySelectorAll('.liq-chip[class*="courier-"]')].map((x) => x.textContent.trim()),
    guias: g.querySelectorAll('.guia-num').length,
  })));
  check('hay una tarjeta por cliente sin liquidar (2)', grupos.length === 2, `${grupos.length}`);
  const ga = grupos.find((g) => g.nombre === 'ASAPLAST PRUEBA');
  check('la tarjeta lleva el nombre en <strong> (lo que leen las otras tandas)', !!ga);
  check('el tipo de cobro va como chip', ga && ga.chip === 'Semanal', ga && ga.chip);
  check('el total del cliente se ve resaltado', ga && /757,30/.test(ga.total), ga && ga.total);
  check('y el botón Liquidar está', ga && ga.boton);
  check('cada envío lleva el courier como chip (UPS / DHL)',
    ga && ga.couriers.length === 3 && ga.couriers.includes('DHL') && ga.couriers.includes('UPS'), ga && ga.couriers.join(','));
  check('y la guía en tipografía de guía', ga && ga.guias === 3);

  const badge = await page.$eval('#tab-badge-pendientes', (e) => ({ txt: e.textContent.trim(), oculto: e.hidden }));
  check('la pestaña Pendientes muestra el contador (2)', badge.txt === '2' && !badge.oculto, JSON.stringify(badge));
  const pill = await page.$eval('#liq-pill-pendientes', (e) => e.textContent.trim());
  check('la cabecera dice cuántos clientes y por cuánto', /2 clientes sin liquidar/.test(pill) && /1\.323,40/.test(pill), pill);

  check('el buscador y los filtros viven en la misma barra',
    await page.$eval('.liq-toolbar', (t) => !!t.querySelector('#buscador-pendientes') && !!t.querySelector('#pend-courier') && !!t.querySelector('#btn-pend-todo')));
  check('"Ver todo" es un botón con borde (secundario)',
    await page.$eval('#btn-pend-todo', (b) => b.classList.contains('btn-outline') && getComputedStyle(b).borderStyle === 'solid'));

  // ── 2. Crear: pasos + resumen ───────────────────────────────────────────────────
  console.log('\n2. Crear: tres pasos y el resumen lateral\n');
  await page.click('.tab[data-tab="crear"]');
  await esperar(200);
  const pasos = await page.$$eval('#panel-crear .liq-paso', (ps) => ps.map((p) => ({
    num: p.querySelector('.liq-num')?.textContent.trim(), titulo: p.querySelector('h3')?.textContent.trim(),
    apagado: p.classList.contains('apagado'),
  })));
  check('hay tres pasos numerados 1, 2, 3', pasos.map((p) => p.num).join('') === '123', JSON.stringify(pasos));
  check('recién entrando, los pasos 2 y 3 están apagados', !pasos[0].apagado && pasos[1].apagado && pasos[2].apagado);
  const res0 = await page.$$eval('.liq-resumen dd', (ds) => ds.map((d) => d.textContent.trim()));
  check('el resumen arranca vacío (todo en "—")', res0.every((t) => t === '—'), res0.join(' | '));
  check('el profit "solo oficina" no se ve sin previa',
    await page.$eval('#liq-res-profit', (e) => e.classList.contains('hidden')));
  check('los tres botones viven en el resumen, con el de confirmar en naranja',
    await page.$eval('.liq-resumen', (r) => {
      const conf = r.querySelector('#btn-confirmar-liq');
      return !!r.querySelector('#btn-preview') && !!r.querySelector('#btn-export-borrador') && !!conf
        && conf.disabled && /rgb\(242, 106, 75\)/.test(getComputedStyle(conf).backgroundColor);
    }));

  // Se entra como lo hace la oficina: por el botón Liquidar de un cliente
  await page.click('.tab[data-tab="pendientes"]');
  await page.waitForSelector('#pendientes-list .cliente-grupo');
  await page.click(`[data-liq-cliente="${a.id}"]`);
  await page.waitForSelector('#liq-envios-body tr[data-envio-id]');
  await esperar(300);

  const leer = () => page.evaluate(() => {
    const q = (r) => document.querySelector(`.liq-resumen [data-r="${r}"]`)?.textContent.trim();
    return {
      cliente: q('cliente'), periodo: q('periodo'), envios: q('envios'), adic: q('adicionales'), total: q('total'),
      profitOculto: document.getElementById('liq-res-profit').classList.contains('hidden'),
      paso2: document.getElementById('liq-paso-2').classList.contains('apagado'),
      paso3: document.getElementById('liq-paso-3').classList.contains('apagado'),
      extra: document.getElementById('liq-paso-2-extra').textContent.trim(),
      pie: document.getElementById('liq-resumen-pie').textContent.trim(),
    };
  });
  let r = await leer();
  check('el resumen muestra el cliente (sin el tipo de cobro entre paréntesis)', r.cliente === 'ASAPLAST PRUEBA', r.cliente);
  check('y el período', /\d{2}\/\d{2}\/\d{4} – \d{2}\/\d{2}\/\d{4}/.test(r.periodo), r.periodo);
  check('y cuántos envíos están marcados (3 de 3)', r.envios === '3 de 3', r.envios);
  check('el paso 2 se prende y dice "3 marcados"', !r.paso2 && r.extra === '3 marcados', r.extra);
  check('el paso 3 sigue apagado y el total en "—" hasta calcular', r.paso3 && r.total === '—', r.total);

  // Destildar uno y tipear un adicional: el resumen acompaña
  await page.uncheck('#liq-envios-body tr[data-envio-id]:nth-child(3) .liq-envio-check');
  await page.$eval('#liq-envios-body tr[data-envio-id]:nth-child(1) .liq-adicional', (e) => {
    e.value = '12.5'; e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await esperar(150);
  r = await leer();
  check('destildar un envío baja el conteo (2 de 3)', r.envios === '2 de 3', r.envios);
  check('el adicional tipeado se suma en el resumen', /12,50/.test(r.adic), r.adic);
  check('y el paso 2 dice "2 marcados"', r.extra === '2 marcados', r.extra);

  await page.click('#btn-preview');
  await page.waitForSelector('#liq-preview:not(.hidden)');
  await esperar(300);
  r = await leer();
  const totalTabla = await page.$eval('#liq-total', (e) => e.textContent.trim());
  check('después de Calcular, el resumen muestra el total…', /\d/.test(r.total) && r.total !== '—', r.total);
  check('…y es EL MISMO número que el pie de la tabla del desglose', r.total === totalTabla, `${r.total} vs ${totalTabla}`);
  check('el paso 3 se prende', !r.paso3);
  check('🔴 el profit de la liquidación se ve en el resumen, marcado "solo oficina"',
    !r.profitOculto && await page.$eval('#liq-res-profit', (e) => /solo oficina/.test(e.textContent) && /\d/.test(e.querySelector('[data-r="profit"]').textContent)));
  const profitTabla = await page.$eval('#liq-profit-total', (e) => e.textContent.trim());
  const profitRes = await page.$eval('#liq-res-profit [data-r="profit"]', (e) => e.textContent.trim());
  check('y es el mismo número que el pie de la columna interna', profitRes === profitTabla, `${profitRes} vs ${profitTabla}`);
  check('Confirmar y Exportar se habilitan', await page.evaluate(() =>
    !document.getElementById('btn-confirmar-liq').disabled && !document.getElementById('btn-export-borrador').disabled));
  check('el pie del resumen avisa que está listo', /Listo para confirmar/.test(r.pie), r.pie);

  // Tocar la selección invalida la previa: el total del resumen vuelve a "—"
  await page.check('#liq-envios-body tr[data-envio-id]:nth-child(3) .liq-envio-check');
  await esperar(200);
  r = await leer();
  check('tocar una tilde invalida la previa: el total vuelve a "—"', r.total === '—' && r.paso3, r.total);
  check('y el profit se esconde', r.profitOculto);
  check('y Confirmar se apaga', await page.$eval('#btn-confirmar-liq', (b) => b.disabled));

  // Las celdas numéricas van a la derecha (tabla del paso 2)
  check('los importes de la tabla van alineados a la derecha',
    await page.$eval('#liq-envios-body tr[data-envio-id] td:nth-child(6)', (td) => getComputedStyle(td).textAlign === 'right'));

  // ── 3. Historial ────────────────────────────────────────────────────────────────
  console.log('\n3. Historial: chips de estado y botones con borde\n');
  await page.click('.tab[data-tab="historial"]');
  await page.waitForSelector('#hist-body tr');
  await esperar(300);
  const hist = await page.$$eval('#hist-body tr', (trs) => trs.map((tr) => ({
    chip: tr.querySelector('.liq-chip')?.className, txt: tr.querySelector('.liq-chip')?.textContent.trim(),
    excel: tr.querySelector('[data-export]')?.classList.contains('btn-outline'),
  })));
  check('la confirmada lleva chip verde "confirmada"',
    hist.some((h) => /confirmada/.test(h.chip) && h.txt === 'confirmada'), JSON.stringify(hist));
  check('el botón Excel es con borde', hist.every((h) => h.excel));
  check('los filtros del historial van en la misma barra que en Pendientes',
    await page.$eval('#panel-historial .liq-toolbar', (t) => !!t.querySelector('#hist-cliente') && !!t.querySelector('#btn-hist-filtrar')));

  // ── 4. Teléfono ─────────────────────────────────────────────────────────────────
  console.log('\n4. Teléfono (390 px): todo entra, sin scroll de costado\n');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('.tab[data-tab="pendientes"]');
  await page.waitForSelector('#pendientes-list .cliente-grupo');
  await esperar(400);
  const scrollX = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('Pendientes: la página no tiene scroll horizontal', (await scrollX()) <= 1, `${await scrollX()} px de más`);
  check('la tarjeta del cliente entra en la pantalla',
    await page.$eval('#pendientes-list .cliente-grupo', (g) => g.getBoundingClientRect().right <= 390.5));

  await page.click('.tab[data-tab="crear"]');
  await esperar(400);
  check('Crear: la página no tiene scroll horizontal', (await scrollX()) <= 1, `${await scrollX()} px de más`);
  const cajas = await page.evaluate(() => {
    const paso = document.getElementById('liq-paso-1').getBoundingClientRect();
    const sel = document.getElementById('liq-cliente').getBoundingClientRect();
    const btn = document.getElementById('btn-cargar-envios').getBoundingClientRect();
    const res = document.querySelector('.liq-resumen').getBoundingClientRect();
    const p3 = document.getElementById('liq-paso-3').getBoundingClientRect();
    return { pasoDer: paso.right, selDer: sel.right, btnDer: btn.right, resTop: res.top, p3Bot: p3.bottom };
  });
  check('el selector de cliente y el botón entran en la tarjeta del paso 1',
    cajas.selDer <= cajas.pasoDer + 0.5 && cajas.btnDer <= cajas.pasoDer + 0.5, JSON.stringify(cajas));
  check('el resumen baja debajo de los pasos (no queda al costado)', cajas.resTop >= cajas.p3Bot - 1, JSON.stringify(cajas));

  // ── 5. Los ids que usa el JS siguen todos ───────────────────────────────────────
  console.log('\n5. Ningún id cambió\n');
  const ids = ['pend-desde', 'pend-hasta', 'pend-courier', 'pend-tipo-cobro', 'btn-pend-filtrar', 'btn-pend-todo',
    'buscador-pendientes', 'buscador-pendientes-cuenta', 'pendientes-list', 'liq-cliente', 'liq-desde', 'liq-hasta',
    'btn-cargar-envios', 'liq-envios-wrap', 'liq-select-all', 'liq-envios-body', 'liq-preview', 'liq-preview-body',
    'liq-total', 'liq-profit-total', 'liq-utilidad-total', 'fuel-info', 'btn-preview', 'btn-export-borrador',
    'btn-confirmar-liq', 'hist-cliente', 'hist-desde', 'hist-hasta', 'btn-hist-filtrar', 'hist-body', 'alert-box'];
  const faltan = await page.evaluate((lista) => lista.filter((id) => !document.getElementById(id)), ids);
  check(`los ${ids.length} ids de la pantalla siguen existiendo`, faltan.length === 0, faltan.join(', '));

  check('la pantalla no tiró ningún error de JavaScript', errores.length === 0, errores.join(' | ').slice(0, 160));

  await browser.close();
  matarSrv();
  // El formato lo lee verificar.js para sumar las tandas: no cambiarlo.
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => {}, 200).unref();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  matarTodo();
});
