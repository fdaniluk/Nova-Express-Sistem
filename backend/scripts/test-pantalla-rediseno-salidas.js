#!/usr/bin/env node
/**
 * test-pantalla-rediseno-salidas.js — el rediseño de Salidas (09/09/2026, Fase A) en un
 * navegador de verdad. SALIDAS-REDISENO.md §3.
 *
 * Lo que se controla:
 *
 *   · la cabecera tiene los dos grupos VER / ACCIONES con los botones de siempre (ids) y
 *     el Cierre vive en la barra del buscador;
 *   · los importes de la grilla van sin "$" y el cero en gris (.em), pero el número sigue
 *     siendo legible con punto decimal (lo que leen los otros tests y el copiado);
 *   · la banda de grupos arriba de los rótulos cubre EXACTAMENTE las 38 columnas y se
 *     pliega junto con el bloque UPS;
 *   · tildar filas hace que "Copiar guías" muestre (n) envíos — por ENVÍO, aunque se tilde
 *     la sub-fila de un bulto — y "Seleccionar todo" / destildar lo actualizan;
 *   · el botón "? Colores" abre la leyenda y Esc la cierra.
 *
 * (La barra de totales que salió con la Fase A se sacó el mismo día a pedido de Felipe;
 * lo que quiere administración —elegir celdas y ver la cuenta al momento— está pendiente.)
 *
 *   cd backend && node scripts/test-pantalla-rediseno-salidas.js
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
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_rediseno_salidas.db';
const TOKEN = 'token-test-pantalla-rediseno';
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

  const copiarN = () => page.$eval('#copiar-guias-n', (el) => el.textContent.trim());

  console.log('\n1. La cabecera: dos grupos, mismos botones\n');
  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(2500);
  const cab = await page.evaluate(() => {
    const g = [...document.querySelectorAll('.sal-header .sal-grupo')];
    return {
      grupos: g.map((x) => x.querySelector('.sal-grupo-lbl')?.textContent.trim()),
      ver: g[0] ? [...g[0].querySelectorAll('button')].map((b) => b.id) : [],
      acciones: g[1] ? [...g[1].querySelectorAll('button')].map((b) => b.id) : [],
      cierreEnToolbar: !!document.querySelector('.salidas-toolbar .cierre-box'),
      sinBarraTotales: !document.getElementById('sal-totales'),
    };
  });
  check('hay dos grupos: Ver y Acciones', cab.grupos.length === 2 && /Ver/i.test(cab.grupos[0]) && /Acciones/i.test(cab.grupos[1]), cab.grupos.join(' / '));
  check('VER tiene alertas, 1º bulto, columnas fijas, columnas UPS y ? Colores',
    ['btn-solo-alertas', 'btn-primer-bulto', 'btn-sticky-cols', 'btn-toggle-ups', 'btn-leyenda'].every((id) => cab.ver.includes(id)), cab.ver.join(','));
  check('ACCIONES tiene Copiar guías y Limpiar filtros', ['btn-copiar-guias', 'btn-limpiar-filtros'].every((id) => cab.acciones.includes(id)), cab.acciones.join(','));
  check('el Cierre vive en la barra del buscador', cab.cierreEnToolbar);
  check('NO hay barra de totales (se sacó el 09/09 a pedido de Felipe)', cab.sinBarraTotales);
  check('sin tildes el botón Copiar guías no muestra número', (await copiarN()) === '', await copiarN());

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

  console.log('\n4. Tildar filas: Copiar guías muestra (n) envíos\n');
  // Tildar e1 (primer renglón) y la SUB-FILA del segundo bulto de e2: dos envíos, no tres tildes.
  await page.click(`#salidas-body tr[data-envio-id="${e1.id}"] .chk-guia`);
  const subChk = await page.$(`#salidas-body tr.bulto-detail-row[data-envio-id="${e2.id}"] .chk-guia`);
  if (subChk) await subChk.click();
  else await page.click(`#salidas-body tr[data-envio-id="${e2.id}"] .chk-guia`);
  await esperar(300);
  check('el botón Copiar guías dice (2) — la sub-fila del bulto cuenta al envío, no aparte', (await copiarN()) === '(2)', await copiarN());
  await page.click('#chk-all-guias');
  await esperar(300);
  check('"Seleccionar todo" → (3)', (await copiarN()) === '(3)', await copiarN());
  await page.click('#chk-all-guias');
  await esperar(300);
  check('destildar todo lo saca', (await copiarN()) === '', await copiarN());
  await page.click(`#salidas-body tr[data-envio-id="${e3.id}"] .chk-guia`);
  await esperar(200);
  await page.click('#btn-primer-bulto');
  await esperar(400);
  check('"1º bulto" rehace la tabla y la selección se pierde (el (n) se va)', (await copiarN()) === '', await copiarN());
  await page.click('#btn-primer-bulto');
  await esperar(300);

  console.log('\n5. "? Colores" abre la leyenda y Esc la cierra\n');
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

  console.log('\n6. Sin errores de JavaScript\n');
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  await browser.close();
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('✗ error inesperado:', e); process.exit(1); });
