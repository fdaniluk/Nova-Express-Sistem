#!/usr/bin/env node
/**
 * test-pantalla-suma-salidas.js — elegir celdas en Salidas y ver la cuenta, estilo Excel
 * (15/09/2026), en un navegador de verdad.
 *
 * El pedido de Felipe, textual: *"Pensá siempre en Excel. Marcás las celdas que querés
 * sumar y simplemente abajo te aparece el resultado. No necesito una barra nueva abajo que
 * esté constantemente mostrándome valores. Quiero elegir a la hora de sumar o no sumar, o
 * qué sumar o qué no sumar, o hasta dónde sumar."* Y el ejemplo que dio: filtrar por un
 * cliente, marcar la columna de la plata, ver el número, seguir.
 *
 * QUÉ CUIDA, en orden de riesgo:
 *
 *  1. QUE EL CLICK SIMPLE SIGA ABRIENDO EL ENVÍO. La tabla ya usaba el click para abrir el
 *     modal. Si seleccionar se lo come, se rompe lo que la oficina hace todo el día. Por
 *     eso hay dos controles: el click pelado abre, y el arrastre NO abre.
 *  2. QUE EL NÚMERO SEA EL CORRECTO. Ninguna suma está escrita acá: se compara contra los
 *     valores de los envíos que la propia tanda cargó, o contra la suma de las celdas
 *     leídas de la pantalla.
 *  3. QUE NO SE VEA NADA SIN SELECCIÓN. Es lo que Felipe mandó sacar el 09/09.
 *  4. Que se pueda elegir a mano qué entra y qué no (Ctrl+click), hasta dónde (Shift), y la
 *     columna entera (Shift en el rótulo).
 *  5. Que filtrar y volver a sumar dé el total de ESE cliente (el caso que él contó).
 *
 *   cd backend && node scripts/test-pantalla-suma-salidas.js
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

const PORT = process.env.PORT_TEST || 3926;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_suma_salidas.db';
const TOKEN = 'token-test-suma-salidas';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const redondo = (n) => Math.round(Number(n) * 100) / 100;

async function main() {
  prepararDb(DB, { desdeProduccion: false });
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

  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const hoy = require('../src/utils/fecha').hoyLocal();

  await fetch(BASE + '/api/configuracion', {
    method: 'PUT', headers: H, body: JSON.stringify({ fuel_pct: 30 }),
  }).catch(() => {});

  /* Dos clientes, como en el ejemplo de Felipe: filtra por uno y suma lo de ese. Las ventas
     son distintas entre sí a propósito, así una suma mal armada no puede dar bien de casualidad. */
  const nuevoCliente = async (nombre) => (await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H, body: JSON.stringify({ nombre, tarifa_pct: 60, tipo_cobro: 'CC' }),
  })).json());
  const cliA = await nuevoCliente('GENASTASIO SRL');
  const cliB = await nuevoCliente('PIO SA');

  const alta = (cliente_id, guia, total, peso) => fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id, fecha: hoy, courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion',
      numero_guia: guia, pais_destino: 'Brasil', peso_real: peso, largo: 30, ancho: 20, alto: 20,
      fob: 100, total_cobrado: total,
    }),
  }).then((r) => r.json());

  const VENTAS_A = [125.50, 340.25, 88.10];
  const VENTAS_B = [210.00, 77.40];
  const PESOS_A = [3, 7.5, 12];
  const envA = [];
  for (let i = 0; i < VENTAS_A.length; i++) envA.push(await alta(cliA.id, `1Z900AA1012345000${i}`, VENTAS_A[i], PESOS_A[i]));
  for (let i = 0; i < VENTAS_B.length; i++) await alta(cliB.id, `1Z900BB1012345000${i}`, VENTAS_B[i], 5);
  check('(fixture) los 5 envíos existen', envA.every((e) => e.id));

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  await page.goto(BASE + '/pages/salidas.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('#salidas-body tr[data-envio-id]', { timeout: 15000 });
  await esperar(500);

  /* ── Utilería ────────────────────────────────────────────────────────────────────── */
  // Índice de la columna por su rótulo: nada de números de columna escritos a mano, que se
  // corren en cuanto alguien agrega una columna.
  const colDe = (rotulo) => page.evaluate((r) => {
    const ths = [...document.querySelectorAll('.salidas-table tr.th-cols th')];
    return ths.findIndex((th) => {
      const i = th.querySelector('.th-inner');
      const c = (i || th).cloneNode(true);
      c.querySelectorAll('button, .sort-icon').forEach((n) => n.remove());
      return (c.textContent || '').trim() === r;
    });
  }, rotulo);

  /* Ojo con `nth-of-type`: el tbody tiene también las sub-filas de detalle, así que contar
     "el enésimo tr" no es lo mismo que "la enésima fila de envío". Se usa el locator sobre
     las filas de datos, que es exactamente lo que numera la pantalla. */
  const celda = (fila, col) => page.locator('#salidas-body tr[data-envio-id]').nth(fila).locator('td').nth(col);
  const centro = async (loc) => {
    const b = await loc.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  // El texto que se VE en una celda, sin el ▾ del detalle ni el "kg" — igual que la pantalla.
  const numerosDeColumna = (col, hasta) => page.$$eval('#salidas-body tr[data-envio-id]', (ns, d) => ns
    .slice(0, d.hasta == null ? ns.length : d.hasta)
    .map((tr) => {
      const c = tr.cells[d.col].cloneNode(true);
      c.querySelectorAll('button, .unit, .track-btn, .alert-icon').forEach((n) => n.remove());
      return Number((c.textContent || '').replace(/\s+/g, ' ').trim());
    }), { col, hasta });
  // Arrastra desde una celda hasta otra, como lo haría una persona: apretar, mover, soltar.
  const arrastrar = async (desde, hasta, modificador) => {
    /* La tabla es más ancha que la pantalla: sin traer las celdas a la vista, el mouse se
       mueve a coordenadas que están fuera del viewport y no pasa nada. Los dos scrolls van
       ANTES de medir, porque el segundo mueve al primero. */
    await desde.scrollIntoViewIfNeeded();
    await hasta.scrollIntoViewIfNeeded();
    await esperar(120);
    const a = await centro(desde), b = await centro(hasta);
    if (modificador) await page.keyboard.down(modificador);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
    if (modificador) await page.keyboard.up(modificador);
    await esperar(200);
  };
  const pastilla = () => page.evaluate(() => {
    const c = document.getElementById('sal-suma');
    if (!c || c.hidden) return null;
    const val = (id) => { const n = document.getElementById(id); return n ? n.textContent.trim() : null; };
    return { texto: c.textContent.replace(/\s+/g, ' ').trim(), cuenta: val('ss-cuenta'), suma: val('ss-suma-valor'), promedio: val('ss-promedio'), crudo: c.dataset.suma };
  });
  const modalAbierto = async () => !!(await page.$('#sal-edit-overlay:not(.hidden)'));
  const cerrarModal = async () => { if (await modalAbierto()) { await page.click('#sal-modal-close'); await esperar(300); } };
  const seleccionadas = () => page.$$eval('#salidas-body td.cell-sel', (ns) => ns.length);

  const COL_VENTA = await colDe('Venta Total');
  const COL_PFACT = await colDe('P.Fact');
  const COL_PCT = await colDe('%');
  const COL_DESTINO = await colDe('Destino');
  check('(fixture) se ubicaron las columnas por su rótulo', COL_VENTA > 0 && COL_PFACT > 0 && COL_PCT > 0 && COL_DESTINO > 0,
    `venta ${COL_VENTA} · pfact ${COL_PFACT} · % ${COL_PCT} · destino ${COL_DESTINO}`);

  // ── 1 ──────────────────────────────────────────────────────────────────────────────
  console.log('\n1. Sin selección no se ve nada (lo que Felipe mandó sacar el 09/09)\n');
  check('la pastilla arranca escondida', (await pastilla()) === null);
  check('   y no hay ninguna celda marcada', (await seleccionadas()) === 0);

  // ── 2 ──────────────────────────────────────────────────────────────────────────────
  console.log('\n2. El click simple SIGUE abriendo el envío\n');
  /* Se usa la columna de Destino: Venta Total tiene el ▾ que abre el desglose, así que un
     click ahí no abre el modal ni antes ni ahora (lo saltea bindRowEdit por diseño). */
  await celda(0, COL_DESTINO).click();
  await esperar(600);
  check('un click pelado abre el modal, como siempre', await modalAbierto());
  check('   y no seleccionó nada', (await seleccionadas()) === 0 && (await pastilla()) === null);
  await cerrarModal();

  // ── 3 ──────────────────────────────────────────────────────────────────────────────
  console.log('\n3. Arrastrar: el rectángulo y la cuenta\n');
  const filasEnPantalla = await page.$$eval('#salidas-body tr[data-envio-id]', (ns) => ns.length);
  check('(fixture) hay 5 filas a la vista', filasEnPantalla === 5, String(filasEnPantalla));
  await arrastrar(celda(0, COL_VENTA), celda(2, COL_VENTA));
  check('el arrastre NO abrió el modal', !(await modalAbierto()));
  let p = await pastilla();
  check('aparece la pastilla', !!p, JSON.stringify(p));
  check('   marcó las 3 celdas', (await seleccionadas()) === 3, String(await seleccionadas()));
  check('   y el recuento dice 3', p && p.cuenta === '3', p && p.cuenta);
  // Las 3 primeras filas de la tabla son las que están a la vista, no necesariamente las de
  // un cliente: se suma lo que dicen ESAS celdas, leído de la pantalla.
  const vistas3 = await numerosDeColumna(COL_VENTA, 3);
  check('   la suma es la de esas 3 celdas', p && Number(p.crudo) === redondo(vistas3.reduce((a, b) => a + b, 0)),
    `pastilla ${p && p.crudo} · celdas ${vistas3.join(' + ')}`);
  check('   y muestra el promedio', p && /Promedio/.test(p.texto), p && p.texto);
  check('   con la unidad de la columna (USD)', p && /USD/.test(p.suma || ''), p && p.suma);

  // ── 4 ──────────────────────────────────────────────────────────────────────────────
  console.log('\n4. Elegir a mano qué entra y qué no\n');
  const antes = Number((await pastilla()).crudo);
  const quitado = vistas3[1];
  await celda(1, COL_VENTA).click({ modifiers: ['Control'] });
  await esperar(250);
  p = await pastilla();
  check('Ctrl+click saca una celda de la cuenta', p && Number(p.crudo) === redondo(antes - quitado),
    `antes ${antes} · sacando ${quitado} · quedó ${p && p.crudo}`);
  check('   y quedan 2 marcadas', (await seleccionadas()) === 2, String(await seleccionadas()));
  check('   sin abrir el modal', !(await modalAbierto()));
  await celda(1, COL_VENTA).click({ modifiers: ['Control'] });
  await esperar(250);
  p = await pastilla();
  check('otro Ctrl+click la vuelve a meter', p && Number(p.crudo) === redondo(antes), p && p.crudo);

  // ── 5 ──────────────────────────────────────────────────────────────────────────────
  console.log('\n5. Hasta dónde sumar: Shift y la columna entera\n');
  await celda(0, COL_DESTINO).click();
  await cerrarModal();
  await arrastrar(celda(0, COL_VENTA), celda(1, COL_VENTA));
  await celda(4, COL_VENTA).click({ modifiers: ['Shift'] });
  await esperar(250);
  p = await pastilla();
  check('Shift+click estira hasta esa fila (5 celdas)', (await seleccionadas()) === 5 && p.cuenta === '5',
    `${await seleccionadas()} marcadas · recuento ${p && p.cuenta}`);
  const todasVenta = await numerosDeColumna(COL_VENTA);
  check('   y suma las 5', Number(p.crudo) === redondo(todasVenta.reduce((a, b) => a + b, 0)),
    `${p.crudo} vs ${todasVenta.join(' + ')}`);

  await page.keyboard.press('Escape');
  await esperar(200);
  const thVenta = `.salidas-table tr.th-cols th:nth-child(${COL_VENTA + 1})`;
  await page.click(thVenta, { modifiers: ['Shift'] });
  await esperar(300);
  p = await pastilla();
  check('Shift+click en el rótulo elige la columna entera', p && p.cuenta === '5', p && p.cuenta);
  check('   y NO la ordena (el orden quedó igual)',
    !(await page.$eval(thVenta, (e) => e.classList.contains('sort-asc') || e.classList.contains('sort-desc'))));

  // ── 6 ──────────────────────────────────────────────────────────────────────────────
  console.log('\n6. El caso de Felipe: filtrar por cliente y sumar lo de ese cliente\n');
  await page.fill('#buscador', 'GENASTASIO');
  await esperar(700);
  check('el filtro dejó solo los de GENASTASIO',
    (await page.$$eval('#salidas-body tr[data-envio-id]', (ns) => ns.length)) === VENTAS_A.length);
  check('   y filtrar soltó la selección que había', (await pastilla()) === null && (await seleccionadas()) === 0);
  await page.click(`.salidas-table tr.th-cols th:nth-child(${COL_VENTA + 1})`, { modifiers: ['Shift'] });
  await esperar(300);
  p = await pastilla();
  check('sumando la columna da lo que se le cobró a ese cliente',
    p && Number(p.crudo) === redondo(VENTAS_A.reduce((a, b) => a + b, 0)),
    `${p && p.crudo} vs ${VENTAS_A.join(' + ')}`);

  // Y lo mismo en kilos, que fue el otro ejemplo que dio.
  await page.click(`.salidas-table tr.th-cols th:nth-child(${COL_PFACT + 1})`, { modifiers: ['Shift'] });
  await esperar(300);
  p = await pastilla();
  const kgVistos = await numerosDeColumna(COL_PFACT);
  check('los kilos también suman, y con su unidad',
    p && Number(p.crudo) === redondo(kgVistos.reduce((a, b) => a + b, 0)) && /kg/.test(p.suma || ''),
    `${p && p.suma} vs ${kgVistos.join(' + ')}`);

  // ── 7 ──────────────────────────────────────────────────────────────────────────────
  console.log('\n7. Los porcentajes no se suman\n');
  await page.click(`.salidas-table tr.th-cols th:nth-child(${COL_PCT + 1})`, { modifiers: ['Shift'] });
  await esperar(300);
  p = await pastilla();
  check('en la columna % no hay Suma (sumar porcentajes no dice nada)', p && p.suma === null, p && p.texto);
  check('   pero sí el promedio', p && p.promedio !== null && /%/.test(p.promedio), p && p.promedio);

  // ── 8 ──────────────────────────────────────────────────────────────────────────────
  console.log('\n8. Soltar la selección\n');
  await page.keyboard.press('Escape');
  await esperar(250);
  check('Esc la suelta y la pastilla se va', (await pastilla()) === null && (await seleccionadas()) === 0);
  await page.click(`.salidas-table tr.th-cols th:nth-child(${COL_VENTA + 1})`, { modifiers: ['Shift'] });
  await esperar(300);
  check('(vuelve a haber selección)', (await pastilla()) !== null);
  await page.click('#sal-suma-cerrar');
  await esperar(250);
  check('la ✕ de la pastilla también', (await pastilla()) === null && (await seleccionadas()) === 0);

  await page.click(`.salidas-table tr.th-cols th:nth-child(${COL_VENTA + 1})`, { modifiers: ['Shift'] });
  await esperar(300);
  await page.click(`.salidas-table tr.th-cols th:nth-child(${COL_VENTA + 1})`);   // ordenar
  await esperar(500);
  check('ordenar también la suelta (las filas ya no son las mismas)', (await pastilla()) === null);

  // ── 9 ──────────────────────────────────────────────────────────────────────────────
  console.log('\n9. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|Failed to load resource/i.test(x));
  check('ninguno', rel.length === 0, rel.slice(0, 2).join(' | '));

  await browser.close();
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
