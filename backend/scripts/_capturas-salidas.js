#!/usr/bin/env node
// Capturas ANOTADAS de la pantalla de Salidas para el manual Word (12/09/2026). No es una tanda.
// Levanta un servidor con base propia, carga envíos de ejemplo que muestren cada caso (multibulto,
// +50, DDP, factura UPS cruzada, revisión aprobada, sin precio) y saca las fotos con globitos
// numerados anclados a elementos reales (como en MANUAL-CONTROL-FACTURAS.md §7).
//   cd backend && node scripts/_capturas-salidas.js [carpeta de salida]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = 3977; const BASE = `http://localhost:${PORT}`;
const DB = '/tmp/demo_salidas_manual.db'; const TOKEN = 'token-demo-salidas';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
const OUT = process.argv[2] || '/tmp/manual-salidas'; fs.mkdirSync(OUT, { recursive: true });
function sql(q, p = []) { return new Promise((res, rej) => { const d = new sqlite3.Database(DB); d.run(q, p, function (e) { d.close(() => (e ? rej(e) : res(this))); }); }); }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const hoyLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const diasAtras = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logOut = ''; let logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; }); srv.stderr.on('data', (d) => { logErr += d; });
  process.on('exit', () => { try { srv.kill(); } catch { /* */ } });
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);

  const cliente = async (nombre, extra = {}) => (await (await fetch(`${BASE}/api/clientes`, { method: 'POST', headers: H, body: JSON.stringify({ nombre, tarifa_pct: 80, ...extra }) })).json());
  const andes = await cliente('Laboratorio Andes');
  const cueros = await cliente('Cueros del Sur', { tipo_cobro: 'S' });
  const textil = await cliente('Textil Norte');
  const nuevo = (body) => fetch(`${BASE}/api/envios`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ fecha: hoyLocal(), courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP', pais_destino: 'Estados Unidos', largo: 30, ancho: 20, alto: 20, ...body }),
  }).then((r) => r.json());

  // Los casos que el manual tiene que mostrar.
  const hoy = hoyLocal();
  const e1 = await nuevo({ cliente_id: andes.id, numero_guia: '1Z327W096794727256', peso_real: 6, fob: 300, total_cobrado: 182.4, fecha: diasAtras(6) });
  const e2 = await nuevo({ cliente_id: cueros.id, courier: 'DHL', servicio_ups: null, pais_destino: 'España', numero_guia: '9920000020', total_cobrado: 640, fecha: diasAtras(5), bultos: [{ peso_real: 5, largo: 30, ancho: 20, alto: 20 }, { peso_real: 7, largo: 40, ancho: 30, alto: 20 }, { peso_real: 6, largo: 30, ancho: 20, alto: 20 }] });
  const e3 = await nuevo({ cliente_id: textil.id, courier: 'DHL', servicio_ups: null, pais_destino: 'Brasil', numero_guia: '9920000031', peso_real: 70, largo: 60, ancho: 50, alto: 50, total_cobrado: 520, fecha: diasAtras(4) });
  const e4 = await nuevo({ cliente_id: andes.id, numero_guia: '1Z327W096792517745', peso_real: 12, fob: 900, ddp: 1, total_cobrado: 310, fecha: diasAtras(3) });
  const e5 = await nuevo({ cliente_id: cueros.id, numero_guia: '1Z327W096797664354', peso_real: 9, fob: 200, total_cobrado: 240, fecha: diasAtras(2) });
  const e6 = await nuevo({ cliente_id: textil.id, numero_guia: '1Z327W096790199567', peso_real: 4, fob: 0, total_cobrado: 0, fecha: diasAtras(1) });
  await sql("UPDATE envios SET costo_facturado = 118.9, peso_facturado = 6, courier_facturado = 'UPS', fecha_facturado = ?, estado_revision = 'pendiente' WHERE id = ?", [hoy, e1.id]);
  await sql("UPDATE envios SET costo_facturado = 171.2, peso_facturado = 11, courier_facturado = 'UPS', fecha_facturado = ?, estado_revision = 'revisado_ok' WHERE id = ?", [hoy, e5.id]);
  await sql("UPDATE envios SET impuestos_facturados = 46.3, impuestos_fecha = ? WHERE id = ?", [hoy, e4.id]);
  await sql("UPDATE envios SET tracking_estado = 'verde' WHERE id IN (?, ?)", [e5.id, e4.id]);
  await sql("UPDATE envios SET tracking_estado = 'amarillo' WHERE id = ?", [e1.id]);
  await sql("UPDATE envio_bultos SET estado_caja = 'amarillo' WHERE envio_id = ? AND numero_bulto IN (1, 2)", [e2.id]);
  await sql("UPDATE envio_bultos SET estado_caja = 'verde' WHERE envio_id = ? AND numero_bulto = 3", [e2.id]);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(`${BASE}/pages/salidas.html`, { waitUntil: 'networkidle' });
  await esperar(2500);

  // ── globitos ─────────────────────────────────────────────────────────────────
  await page.addStyleTag({ content: `
    .man-badge { position: absolute; z-index: 99999; width: 26px; height: 26px; border-radius: 50%; background: #EA6749; color: #fff; font: 700 15px/26px 'DM Sans', system-ui, sans-serif; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.35); pointer-events: none; }
    .man-badge.azul { background: #2A3661; }
  ` });
  const limpiar = () => page.evaluate(() => document.querySelectorAll('.man-badge').forEach((b) => b.remove()));
  // Ancla un globito a un elemento: pos = 'izq' | 'der' | 'arriba' | 'centro' | 'abajo'
  const badge = (sel, n, pos = 'izq', dx = 0, dy = 0, clase = '') => page.evaluate(({ sel, n, pos, dx, dy, clase }) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!el) return false;
    const r = el.getBoundingClientRect();
    const b = document.createElement('div'); b.className = 'man-badge ' + clase; b.textContent = n; document.body.appendChild(b);
    let x = r.left - 30; let y = r.top + r.height / 2 - 13;
    if (pos === 'der') { x = r.right + 4; }
    if (pos === 'arriba') { x = r.left + r.width / 2 - 13; y = r.top - 30; }
    if (pos === 'abajo') { x = r.left + r.width / 2 - 13; y = r.bottom + 4; }
    if (pos === 'centro') { x = r.left + r.width / 2 - 13; y = r.top + r.height / 2 - 13; }
    b.style.left = `${x + dx + window.scrollX}px`; b.style.top = `${y + dy + window.scrollY}px`;
    return true;
  }, { sel, n, pos, dx, dy, clase });
  const badgeNth = (sel, i, n, pos, dx, dy, clase) => page.evaluate(({ sel, i, n, pos, dx, dy, clase }) => {
    const el = document.querySelectorAll(sel)[i]; if (!el) return false;
    const r = el.getBoundingClientRect();
    const b = document.createElement('div'); b.className = 'man-badge ' + (clase || ''); b.textContent = n; document.body.appendChild(b);
    let x = r.left - 30; let y = r.top + r.height / 2 - 13;
    if (pos === 'der') { x = r.right + 4; }
    if (pos === 'arriba') { x = r.left + r.width / 2 - 13; y = r.top - 30; }
    if (pos === 'abajo') { x = r.left + r.width / 2 - 13; y = r.bottom + 4; }
    if (pos === 'centro') { x = r.left + r.width / 2 - 13; y = r.top + r.height / 2 - 13; }
    b.style.left = `${x + (dx || 0) + window.scrollX}px`; b.style.top = `${y + (dy || 0) + window.scrollY}px`;
    return true;
  }, { sel, i, n, pos, dx, dy, clase });
  const rect = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; }, sel);
  const shot = async (name, clip) => { await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: Math.max(0, clip.x), y: Math.max(0, clip.y), width: clip.width, height: clip.height } }); console.log('✓', name); };
  const colRect = (col) => page.evaluate((c) => { const th = document.querySelector(`.salidas-table thead tr.th-cols th[data-col="${c}"], .salidas-table thead tr.th-cols th[data-filter="${c}"]`); if (!th) return null; const r = th.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right }; }, col);

  // 1. La cabecera: VER / ACCIONES / barra / solapas
  await badge('#btn-solo-alertas', '1', 'abajo');
  await badge('#btn-primer-bulto', '2', 'abajo');
  await badge('#btn-sticky-cols', '3', 'abajo');
  await badge('#btn-toggle-ups', '4', 'abajo');
  await badge('#btn-leyenda', '5', 'abajo');
  await badge('#btn-copiar-guias', '6', 'abajo');
  await badge('#btn-limpiar-filtros', '7', 'abajo');
  await badge('#buscador', '8', 'der', 6, 0);
  await badge('#contador', '9', 'izq', -4, 0);
  await badge('.cierre-box', '10', 'abajo', -60, 0);
  await badge('#month-tabs .month-tab, #month-tabs button, #month-tabs > *', '11', 'der', 6, 0);
  const hdr = await rect('.sal-header'); const tabs = await rect('#month-tabs');
  await shot('01-cabecera', { x: hdr.x - 14, y: Math.max(0, hdr.y - 6), width: 1600 - hdr.x + 14, height: (tabs.b + 8) - Math.max(0, hdr.y - 6) });
  await limpiar();

  // 2. La tabla: banda de grupos, identificación, bultos desplegados, chips
  const tbl = await rect('#table-wrap');
  const fila = (id) => `tr[data-envio-id="${id}"]`;
  await badgeNth('.salidas-table thead tr.th-groups th', 0, '1', 'izq', 36, 0, 'azul');
  await badgeNth('.salidas-table thead tr.th-groups th', 1, '2', 'izq', 36, 0, 'azul');
  await badgeNth('.salidas-table thead tr.th-groups th', 2, '3', 'izq', 36, 0, 'azul');
  await badge(`${fila(e2.id)} .bultos-toggle`, '4', 'der', 44, 0);
  await badge(`${fila(e3.id)} .chip-tarifa50`, '5', 'der', 2, 0);
  await badge(`${fila(e4.id)} .chip-ddp`, '6', 'der', 2, 0);
  await badge(`${fila(e1.id)} td.bulto-cell`, '7', 'der', -14, 0);
  await badge(`${fila(e2.id)} + tr td.bulto-cell, ${fila(e2.id)} + tr td:nth-child(9)`, '8', 'der', -14, 0);
  await shot('02-tabla-identificacion', { x: tbl.x - 6, y: tbl.y - 4, width: 1600 - tbl.x, height: 370 });
  await limpiar();

  // 3. El bloque de la plata, en DOS fotos para que se lea impreso: (a) Venta · Costos ·
  //    Resultado y (b) Factura UPS. La tabla se desplaza hasta la columna pedida.
  const irAColumna = (texto) => page.evaluate((texto) => {
    let wrap = document.querySelector('.salidas-table');
    while (wrap && !(wrap.scrollWidth > wrap.clientWidth + 5 && /auto|scroll/.test(getComputedStyle(wrap).overflowX))) wrap = wrap.parentElement;
    if (!wrap) wrap = document.querySelector('#table-wrap');
    window.__salWrap = wrap;
    const cols = [...document.querySelectorAll('.salidas-table thead tr.th-cols th')];
    const th = cols.find((c) => c.textContent.trim().startsWith(texto));
    const fijas = cols.filter((c) => getComputedStyle(c).position === 'sticky' && getComputedStyle(c).left !== 'auto');
    const anchoFijas = fijas.length ? Math.max(...fijas.map((c) => c.getBoundingClientRect().right)) - wrap.getBoundingClientRect().left : 0;
    if (th) wrap.scrollLeft = th.getBoundingClientRect().left - wrap.getBoundingClientRect().left - Math.min(anchoFijas, 360) - 8 + wrap.scrollLeft;
  }, texto);
  const cellBadge = async (id, col, n) => badge(`${fila(id)} td[data-col="${col}"]`, n, 'abajo', 0, 6);
  await irAColumna('Venta Total'); await esperar(500);
  await cellBadge(e1.id, 'total', '1');
  await cellBadge(e1.id, 'compra_total', '2');
  await cellBadge(e1.id, 'profit', '3');
  await badge(`${fila(e6.id)} td[data-col="total"]`, '9', 'izq', 40, 0);
  await shot('03a-venta-costos', { x: tbl.x - 6, y: tbl.y - 4, width: 1600 - tbl.x, height: 400 });
  await limpiar();
  await irAColumna('Costo UPS'); await esperar(500);
  await cellBadge(e1.id, 'costo_ups', '4');
  await cellBadge(e1.id, 'porcentaje_real', '5');
  await cellBadge(e1.id, 'profit_real', '6');
  await cellBadge(e1.id, 'peso_ups', '7');
  await badge(`${fila(e1.id)} .revision-btns`, '8', 'abajo', 0, 6);
  await badge(`${fila(e5.id)} td[data-col="costo_ups"]`, '10', 'izq', 36, 0);
  await shot('03b-factura-ups', { x: tbl.x - 6, y: tbl.y - 4, width: 1600 - tbl.x, height: 400 });
  await limpiar();
  await page.evaluate(() => { (window.__salWrap || document.querySelector('#table-wrap')).scrollLeft = 0; });

  // 4. El ▼ de Bulto con el criterio Semáforo
  await page.click('.filter-btn[data-filter="bulto"]').catch(async () => { await page.click('.filter-btn[data-filter="numero_bulto"]'); });
  await esperar(500);
  await page.click('#dd-criterios button[data-criterio="estado_semaforo"]').catch(() => {});
  await esperar(400);
  await badge('#dd-criterios', '1', 'izq', 0, 0);
  await badge('#dd-list', '2', 'izq', 0, 0);
  await badge('#dd-apply', '3', 'der', 2, 0);
  const dd = await rect('#col-filter-dropdown');
  await shot('04-filtro-semaforo', { x: dd.x - 40, y: dd.y - 60, width: dd.w + 80, height: dd.h + 80 });
  await limpiar();
  await page.keyboard.press('Escape'); await esperar(300);

  // 5. Columnas fijas
  await page.click('#btn-sticky-cols'); await esperar(500);
  const sp = await rect('#sticky-cols-panel');
  if (sp) {
    await shot('05-columnas-fijas', { x: sp.x - 10, y: sp.y - 10, width: sp.w + 20, height: Math.min(sp.h + 20, 700) });
  }
  await limpiar();
  await page.keyboard.press('Escape'); await esperar(300);
  await page.click('#btn-sticky-cols').catch(() => {}); await esperar(200);
  if (await page.$('#sticky-cols-panel')) { await page.keyboard.press('Escape'); await esperar(200); }

  // 6. ? Colores
  await page.click('#btn-leyenda'); await esperar(500);
  const ley = await rect('#sal-leyenda');
  if (ley) await shot('06-colores', { x: ley.x - 10, y: ley.y - 10, width: ley.w + 20, height: ley.h + 20 });
  await page.keyboard.press('Escape'); await esperar(300);

  // 7. El modal en dos columnas (envío UPS: muestra el selector Servicio UPS)
  await page.click(`${fila(e1.id)} td[data-col="numero_guia"]`); await esperar(1200);
  const modal = await rect('.sal-modal-body');
  await badge('#saled-servicio-ups', '4', 'der', 4, 0);
  await badge('#saled-agregar-bulto', '5', 'der', 4, 0);
  await badge('#saled-total', '6', 'izq', -2, 0);
  await badge('#saled-compra-view', '7', 'izq', -2, 0);
  await badge('#saled-profit', '8', 'izq', -2, 0);
  await badge('#saled-recalcular', '9', 'izq', -2, 0);
  await badge('#saled-calcular-venta', '10', 'izq', -2, 0);
  await badge('#sal-modal-save', '11', 'izq', -2, 0);
  await badge('#sal-modal-delete', '12', 'abajo', 0, -2);
  await badge('#sal-modal-no-volo', '13', 'abajo', 0, -6);
  const mc = await rect('.sal-modal-box') || modal;
  console.log('modal', JSON.stringify(mc));
  await shot('07-modal', { x: mc.x - 16, y: Math.max(0, mc.y - 16), width: mc.w + 32, height: 1000 - Math.max(0, mc.y - 16) });
  await limpiar();

  await browser.close();
  srv.kill();
}
main().catch((e) => { console.error(e); process.exit(1); });
