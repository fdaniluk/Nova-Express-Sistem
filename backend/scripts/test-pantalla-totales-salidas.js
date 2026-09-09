#!/usr/bin/env node
/**
 * test-pantalla-totales-salidas.js — el rediseño de Salidas (09/09/2026) en un navegador
 * de verdad. SALIDAS-REDISENO.md, Fase A.
 *
 * Lo que la oficina pidió y acá se controla:
 *
 *   · la barra de totales ("la suma de Excel"): Σ de lo que está en pantalla, que cuadra
 *     al centavo con lo que devuelve /api/salidas, y que sigue a los filtros;
 *   · tildar filas arma un segundo bloque con la Σ de la selección (por ENVÍO, aunque se
 *     tilde la sub-fila de un bulto) y el botón "Copiar guías" muestra cuántas hay;
 *   · un envío NO VOLÓ se cuenta pero no suma plata ni kilos, y la barra lo avisa;
 *   · la banda de grupos arriba de los rótulos cubre EXACTAMENTE las 38 columnas y se
 *     pliega junto con el bloque UPS;
 *   · los importes de la grilla van sin "$" y el cero en gris (.em), pero el número sigue
 *     siendo legible con punto decimal (lo que leen los otros tests y el copiado);
 *   · el botón "? Colores" abre la leyenda y Esc la cierra.
 *
 *   cd backend && node scripts/test-pantalla-totales-salidas.js
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

const PORT = process.env.PORT_TEST || 3961;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_totales_salidas.db';
const TOKEN = 'token-test-pantalla-totales';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); }
  else { fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (t) => Number(String(t || '').replace(/[^0-9.-]/g, ''));
const cerca = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) < tol;

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = ''; let logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch { /* ya estaba */ } };
  process.on('exit', matarSrv);

  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);

  const hoy = new Date().toISOString().slice(0, 10);
  const cliA = await (await fetch(`${BASE}/api/clientes`, {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'TOTALES A', tarifa_pct: 80 }),
  })).json();
  const cliB = await (await fetch(`${BASE}/api/clientes`, {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'TOTALES B', tarifa_pct: 80 }),
  })).json();

  const nuevo = (body) => fetch(`${BASE}/api/envios`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      fecha: hoy, courier: 'DHL', tipo_envio: 'exportacion', pais_destino: 'Estados Unidos',
      largo: 30, ancho: 20, alto: 20, ...body,
    }),
  }).then((r) => r.json());

  // Tres envíos: dos del cliente A (uno multibulto), uno del B. Ventas redondas para sumar a ojo.
  const e1 = await nuevo({ cliente_id: cliA.id, numero_guia: '9920000010', peso_real: 6, total_cobrado: 250 });
  const e2 = await nuevo({
    cliente_id: cliA.id, numero_guia: '9920000028', total_cobrado: 400,
    bultos: [
      { peso_real: 5, largo: 30, ancho: 20, alto: 20 },
      { peso_real: 7, largo: 30, ancho: 20, alto: 20 },
    ],
  });
  const e3 = await nuevo({ cliente_id: cliB.id, numero_guia: '9920000036', peso_real: 10, total_cobrado: 500 });
  check('se crearon los tres envíos', e1.id && e2.id && e3.id, JSON.stringify([e1, e2, e3]).slice(0, 200));

  // Lo que el servidor dice de cada uno: la barra tiene que cuadrar con ESTO.
  const api = await (await fetch(`${BASE}/api/salidas`, { headers: H })).json();
  const lista = Array.isArray(api) ? api : (api.data || api.salidas || []);
  const porId = new Map(lista.map((e) => [e.id, e]));
  const suma = (ids, campo) => ids.reduce((acc, id) => acc + (Number(porId.get(id)?.[campo]) || 0), 0);
  const todos = [e1.id, e2.id, e3.id];
  check('la API devuelve los tres', todos.every((id) => porId.has(id)), `${lista.length} filas`);

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) {
      errores.push(m.text());
    }
  });
  page.on('dialog', (d) => d.accept());

  const tot = () => page.evaluate(() => {
    const o = {};
    document.querySelectorAll('#sal-totales > .sal-tot .v[data-tot]').forEach((el) => { o[el.dataset.tot] = el.textContent.trim(); });
    o.sel = document.getElementById('sal-totales-sel').textContent.replace(/\s+/g, ' ').trim();
    o.selOn = document.getElementById('sal-totales-sel').classList.contains('on');
    o.hint = (document.getElementById('sal-totales-hint').textContent || '').trim();
    o.copiarN = document.getElementById('copiar-guias-n').textContent.trim();
    return o;
  });
  const selV = (k) => page.$eval(`#sal-totales-sel .v[data-tot="${k}"]`, (el) => el.textContent.trim()).catch(() => null);

  console.log('\n1. La barra de totales cuadra con la API\n');
  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(2500);
  let t = await tot();
  check('hay barra de totales', !!(await page.$('#sal-totales')));
  check('Envíos = 3', t.envios === '3', t.envios);
  check('Bultos = 4 (1 + 2 + 1)', t.bultos === '4', t.bultos);
  check('Kg facturables = Σ peso_facturable de la API', cerca(num(t.kg_fact), suma(todos, 'peso_facturable'), 0.06), `${t.kg_fact} vs ${suma(todos, 'peso_facturable')}`);
  check('Kg balanza = 6 + 12 + 10 = 28', cerca(num(t.kg_real), 28, 0.06), t.kg_real);
  check('Venta = 250 + 400 + 500 = 1150', cerca(num(t.venta), 1150), t.venta);
  const compraApi = todos.reduce((a, id) => a + (Number(porId.get(id).compra_estimada ?? porId.get(id).compra_total) || 0), 0);
  const profitApi = todos.reduce((a, id) => a + (Number(porId.get(id).profit_estimado ?? porId.get(id).profit) || 0), 0);
  check('Compra = Σ compra de la API (al centavo)', cerca(num(t.compra), compraApi), `${t.compra} vs ${compraApi.toFixed(2)}`);
  check('Profit = Σ profit de la API (al centavo)', cerca(num(t.profit), profitApi), `${t.profit} vs ${profitApi.toFixed(2)}`);
  check('% promedio = profit / compra', compraApi > 0 && cerca(num(t.pct), (profitApi / compraApi) * 100, 0.06), t.pct);
  check('sin selección no hay bloque de selección', !t.selOn && t.sel === '', t.sel);
  check('el botón Copiar guías no muestra número', t.copiarN === '', t.copiarN);
  check('la barra explica que es la Σ de la pantalla y que el clic copia', /pantalla/.test(t.hint) && /copia/.test(t.hint), t.hint);

  console.log('\n2. Los importes de la grilla: sin "$", cero en gris, punto decimal\n');
  const celdas = await page.evaluate((id) => {
    const tr = document.querySelector(`#salidas-body tr[data-envio-id="${id}"]`);
    const c = (col) => tr.querySelector(`td[data-col="${col}"]`);
    return {
      total: c('total').textContent.trim(), flete: c('flete').textContent.trim(),
      descuento: c('descuento').innerHTML, profit: c('profit').textContent.trim(),
      compra: c('compra_total').textContent.trim(),
    };
  }, e1.id);
  check('Venta Total dice 250.00 (sin "$")', celdas.total.startsWith('250.00'), celdas.total);
  check('Flete es un número con punto decimal', /^\d+\.\d\d$/.test(celdas.flete), celdas.flete);
  check('Descuento 0 va en gris (.em) y no como "$0.00"', /class="em">0</.test(celdas.descuento) && !/\$/.test(celdas.descuento), celdas.descuento);
  check('Profit sin "$"', !/\$/.test(celdas.profit) && cerca(num(celdas.total) - num(celdas.compra), num(celdas.profit)), `${celdas.total} − ${celdas.compra} = ${celdas.profit}`);

  console.log('\n3. La banda de grupos cubre las 38 columnas y se pliega con el bloque UPS\n');
  const banda = await page.evaluate(() => {
    const ths = [...document.querySelectorAll('.salidas-table thead tr.th-groups th')];
    const cols = document.querySelectorAll('.salidas-table thead tr.th-cols th').length;
    const visibles = ths.filter((t) => t.offsetParent !== null || getComputedStyle(t).display !== 'none');
    return {
      grupos: ths.length,
      colspanTotal: ths.reduce((a, t) => a + Number(t.getAttribute('colspan') || 1), 0),
      cols,
      textos: ths.map((t) => t.textContent.trim()),
      upsVisible: visibles.some((t) => t.classList.contains('thg-ups')),
      tablaPlegada: document.getElementById('salidas-table').classList.contains('ups-collapsed'),
      topRotulos: getComputedStyle(document.querySelector('.salidas-table thead tr.th-cols th')).top,
    };
  });
  check('hay 8 grupos', banda.grupos === 8, String(banda.grupos));
  check('la suma de colspans es igual a las columnas de abajo (38)', banda.colspanTotal === banda.cols && banda.cols === 38, `${banda.colspanTotal} vs ${banda.cols}`);
  check('los grupos son Identificación · Bulto · Medidas · Venta · Costos · Resultado · Factura UPS · Estado',
    /Identificaci/.test(banda.textos[0]) && /Bulto/.test(banda.textos[1]) && /Medidas/.test(banda.textos[2]) && /Venta/.test(banda.textos[3])
      && /Costos/.test(banda.textos[4]) && /Resultado/.test(banda.textos[5]) && /UPS/.test(banda.textos[6]) && /Estado/.test(banda.textos[7]), banda.textos.join(' | '));
  check('el grupo "Factura UPS" está plegado junto con el bloque UPS (nada pendiente de revisión)', banda.tablaPlegada && !banda.upsVisible, JSON.stringify({ plegada: banda.tablaPlegada, ups: banda.upsVisible }));
  check('la fila de rótulos se pega debajo de la banda (top > 0)', parseFloat(banda.topRotulos) >= 20, banda.topRotulos);
  await page.click('#btn-toggle-ups');
  await esperar(300);
  const upsAbierto = await page.evaluate(() => {
    const th = document.querySelector('.salidas-table thead tr.th-groups th.thg-ups');
    return getComputedStyle(th).display !== 'none';
  });
  check('al abrir las columnas UPS aparece también el grupo "Factura UPS"', upsAbierto);
  await page.click('#btn-toggle-ups');
  await esperar(300);

  console.log('\n4. Tildar filas arma la Σ de la selección (por envío)\n');
  // Tildar e1 (primer renglón) y la SUB-FILA del segundo bulto de e2: dos envíos, no tres tildes.
  await page.click(`#salidas-body tr[data-envio-id="${e1.id}"] .chk-guia`);
  const subChk = await page.$(`#salidas-body tr.bulto-detail-row[data-envio-id="${e2.id}"] .chk-guia`);
  if (subChk) await subChk.click();
  else await page.click(`#salidas-body tr[data-envio-id="${e2.id}"] .chk-guia`);
  await esperar(300);
  t = await tot();
  check('aparece el bloque de selección', t.selOn, t.sel);
  check('dice "Selección · 2 envíos" (la sub-fila del bulto cuenta al envío, no aparte)', /Selecci.n · 2 env.os/.test(t.sel), t.sel);
  check('Bultos de la selección = 3 (1 + 2)', (await selV('bultos')) === '3', await selV('bultos'));
  check('Venta de la selección = 250 + 400 = 650', cerca(num(await selV('venta')), 650), await selV('venta'));
  check('Kg fact. de la selección = Σ de los dos envíos', cerca(num(await selV('kg_fact')), suma([e1.id, e2.id], 'peso_facturable'), 0.06), await selV('kg_fact'));
  check('el botón Copiar guías dice (2)', t.copiarN === '(2)', t.copiarN);
  check('la Σ de pantalla no cambió (sigue en 3 envíos / 1150)', t.envios === '3' && cerca(num(t.venta), 1150), `${t.envios} / ${t.venta}`);
  check('con selección a la vista el hint se esconde (no crece la barra)',
    await page.$eval('#sal-totales-hint', (el) => getComputedStyle(el).display === 'none'));

  // "Seleccionar todo" del header
  await page.click('#chk-all-guias');
  await esperar(300);
  t = await tot();
  check('"Seleccionar todo" → Selección · 3 envíos', /3 env.os/.test(t.sel) && t.copiarN === '(3)', `${t.sel} · ${t.copiarN}`);
  await page.click('#chk-all-guias');
  await esperar(300);
  t = await tot();
  check('destildar todo saca el bloque de selección', !t.selOn && t.copiarN === '', `${t.selOn} · ${t.copiarN}`);

  console.log('\n5. La Σ sigue a los filtros\n');
  await page.fill('#buscador', 'TOTALES B');
  await esperar(600);
  t = await tot();
  check('buscando al cliente B quedan 1 envío y Venta 500', t.envios === '1' && cerca(num(t.venta), 500), `${t.envios} / ${t.venta}`);
  await page.click('#btn-limpiar-filtros');
  await esperar(600);
  t = await tot();
  check('"Limpiar filtros" vuelve a 3 / 1150', t.envios === '3' && cerca(num(t.venta), 1150), `${t.envios} / ${t.venta}`);

  console.log('\n6. NO VOLÓ se cuenta pero no suma\n');
  const nv = await fetch(`${BASE}/api/salidas/${e3.id}/no-volo`, { method: 'PATCH', headers: H, body: JSON.stringify({ no_volo: true }) });
  check('se marcó e3 como NO VOLÓ por la API', nv.ok, String(nv.status));
  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(2500);
  t = await tot();
  check('Envíos sigue en 3', t.envios === '3', t.envios);
  check('pero Venta bajó a 650 (250 + 400)', cerca(num(t.venta), 650), t.venta);
  check('y Bultos a 3', t.bultos === '3', t.bultos);
  check('la barra avisa que hay 1 NO VOLÓ que no suma', /1 NO VOL. no suma/.test(t.hint), t.hint);

  console.log('\n7. "? Colores" abre la leyenda y Esc la cierra\n');
  await page.click('#btn-leyenda');
  await esperar(300);
  const ley = await page.$('#sal-leyenda');
  check('aparece la leyenda', !!ley);
  const leyTxt = ley ? await ley.textContent() : '';
  check('explica el rojo (profit negativo), el NO VOLÓ y la guía mal tipeada',
    /negativo/.test(leyTxt) && /NO VOL/.test(leyTxt) && /tipe/.test(leyTxt), leyTxt.slice(0, 120));
  check('explica los estados de la caja (rojo · amarillo · verde)', /rojo · amarillo · verde/.test(leyTxt));
  await page.keyboard.press('Escape');
  await esperar(200);
  check('Esc la cierra', !(await page.$('#sal-leyenda')));

  console.log('\n8. Sin errores de JavaScript\n');
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  await browser.close();
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('✗ error inesperado:', e); process.exit(1); });
