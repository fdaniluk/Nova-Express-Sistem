#!/usr/bin/env node
/**
 * test-pantalla-columnas-fijas.js — "📌 Columnas fijas" de Salidas: CUALQUIER columna.
 *
 * Pedido de Felipe (07/09/2026): "que lo deje fijar la columna que quiera, hoy en día solo
 * te deja elegir algunas". Antes el panelito ofrecía 7 (las de identificación); ahora
 * ofrece todas las columnas de la tabla, en su orden, y el sticky se emite por posición
 * (:nth-child), así que también vale para las celdas sin data-col (Largo, Profit Real…).
 *
 *   cd backend && node scripts/test-pantalla-columnas-fijas.js
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

const PORT = process.env.PORT_TEST || 3939;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_columnas_fijas.db';
const TOKEN = 'token-test-columnas-fijas';

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

  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const hoy = new Date().toISOString().slice(0, 10);

  const cli = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H,
    body: JSON.stringify({ nombre: 'COLUMNAS FIJAS', tarifa_pct: 75 }),
  })).json();
  // Un multibulto (para que haya sub-filas de bulto) y uno simple.
  const multi = await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion',
      numero_guia: '1Z000FIJA000000001', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
      fob: 50, total_cobrado: 300,
      bultos: [
        { peso_real: 5, largo: 30, ancho: 20, alto: 20 },
        { peso_real: 6, largo: 30, ancho: 20, alto: 20 },
      ],
    }),
  })).json();
  const simple = await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion',
      numero_guia: '1Z000FIJA000000002', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
      fob: 120, total_cobrado: 100,
      bultos: [{ peso_real: 2, largo: 20, ancho: 15, alto: 10 }],
    }),
  })).json();
  check('se cargaron los dos envíos de prueba', !!multi.id && !!simple.id,
    JSON.stringify({ m: multi.id, s: simple.id }));

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  // Viewport angosto a propósito: la tabla tiene que desbordar para que haya scroll horizontal.
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errores.push(m.text());
  });

  // Helpers de lectura de la pantalla.
  const abrirPanel = async () => {
    const visible = await page.evaluate(() => document.getElementById('sticky-cols-panel')?.style.display !== 'none');
    if (!visible) { await page.click('#btn-sticky-cols'); await esperar(200); }
  };
  const tildar = async (label, on) => {
    await abrirPanel();
    const cambio = await page.evaluate(({ label, on }) => {
      const lab = [...document.querySelectorAll('#sticky-cols-panel label')]
        .find((l) => l.textContent.trim() === label);
      if (!lab) return 'no-label';
      const cb = lab.querySelector('input');
      if (cb.checked === on) return 'igual';
      cb.click();
      return 'ok';
    }, { label, on });
    await esperar(200);
    return cambio;
  };
  // Índice 1-based del th cuyo rótulo es `label` (para comparar con las celdas).
  const nthDe = (label) => page.evaluate((label) => {
    const ths = [...document.querySelectorAll('.salidas-table thead th')];
    const i = ths.findIndex((th) => {
      const inner = th.querySelector('.th-inner') || th;
      let t = '';
      inner.childNodes.forEach((n) => { if (n.nodeType === Node.TEXT_NODE) t += n.textContent; });
      return t.trim() === label;
    });
    return i + 1;
  }, label);
  const estiloCelda = (nth, sel = '#salidas-body tr[data-envio-id]') => page.evaluate(({ nth, sel }) => {
    const tr = document.querySelector(sel);
    const td = tr && tr.children[nth - 1];
    if (!td) return null;
    const cs = getComputedStyle(td);
    return { position: cs.position, left: parseFloat(cs.left) || 0, bg: cs.backgroundColor, x: td.getBoundingClientRect().left };
  }, { nth, sel });
  const estiloTh = (nth) => page.evaluate((nth) => {
    const th = document.querySelector(`.salidas-table thead th:nth-child(${nth})`);
    const cs = getComputedStyle(th);
    return { position: cs.position, left: parseFloat(cs.left) || 0, width: th.getBoundingClientRect().width, z: cs.zIndex };
  }, nth);

  console.log('\n1. El panel ofrece TODAS las columnas de la tabla\n');
  await page.goto(BASE + '/pages/salidas.html', { waitUntil: 'networkidle' });
  await esperar(1200);

  const totalTh = await page.evaluate(() => document.querySelectorAll('.salidas-table thead th').length);
  const totalCb = await page.evaluate(() => document.querySelectorAll('#sticky-cols-panel input[type=checkbox]').length);
  check(`hay un checkbox por columna menos el tilde de selección (${totalTh - 1})`, totalCb === totalTh - 1,
    `th=${totalTh} checkboxes=${totalCb}`);
  check('el panel tiene más de 7 opciones (antes eran solo 7)', totalCb > 7, `${totalCb}`);
  const rotulos = await page.evaluate(() => [...document.querySelectorAll('#sticky-cols-panel label')].map((l) => l.textContent.trim()));
  for (const r of ['#Sal', 'Cliente', 'Largo', 'P.Balanza', 'Venta Total', 'Profit Real', 'Revisión', 'Estado', 'Observaciones']) {
    check(`se puede fijar "${r}"`, rotulos.includes(r));
  }
  check('el orden del panel es el orden de la tabla (#Sal antes que Largo antes que Observaciones)',
    rotulos.indexOf('#Sal') < rotulos.indexOf('Largo') && rotulos.indexOf('Largo') < rotulos.indexOf('Observaciones'));
  check('el rótulo no arrastra el ▼ del filtro', !rotulos.some((r) => r.includes('▼')));
  check('hay botón "Ninguna"', await page.evaluate(() => !!document.querySelector('#sticky-cols-panel .sticky-cols-none')));

  console.log('\n2. Por defecto siguen fijas #Sal y Cliente\n');
  const nSal = await nthDe('#Sal');
  const nCli = await nthDe('Cliente');
  const nLargo = await nthDe('Largo');
  const nProfReal = await nthDe('Profit Real');
  const nObs = await nthDe('Observaciones');
  check('se ubicaron las columnas de referencia', nSal > 1 && nCli > nSal && nLargo > nCli && nProfReal > nLargo && nObs > nProfReal,
    JSON.stringify({ nSal, nCli, nLargo, nProfReal, nObs }));
  let sSal = await estiloCelda(nSal), sCli = await estiloCelda(nCli), sLargo = await estiloCelda(nLargo);
  check('#Sal está sticky', sSal?.position === 'sticky', JSON.stringify(sSal));
  check('Cliente está sticky', sCli?.position === 'sticky', JSON.stringify(sCli));
  check('Largo NO está sticky todavía', sLargo?.position !== 'sticky', JSON.stringify(sLargo));
  const wChk = await page.evaluate(() => document.querySelector('.salidas-table th.chk-cell').getBoundingClientRect().width);
  check('#Sal arranca justo después del checkbox', Math.abs(sSal.left - wChk) < 1, `left=${sSal.left} chk=${wChk}`);

  console.log('\n3. Se fija una columna que antes no se podía: Largo (sin data-col)\n');
  check('se tildó Largo', (await tildar('Largo', true)) === 'ok');
  sLargo = await estiloCelda(nLargo);
  const thLargo = await estiloTh(nLargo);
  check('la celda de Largo quedó sticky', sLargo?.position === 'sticky', JSON.stringify(sLargo));
  check('el th de Largo quedó sticky', thLargo.position === 'sticky', JSON.stringify(thLargo));
  check('el th de Largo va por encima del thead (z-index 3)', String(thLargo.z) === '3', `z=${thLargo.z}`);
  const wSal = (await estiloTh(nSal)).width, wCli = (await estiloTh(nCli)).width;
  check('Largo se apila después del checkbox + #Sal + Cliente (las del medio pasan por debajo)',
    Math.abs(sLargo.left - (wChk + wSal + wCli)) < 1, `left=${sLargo.left} esperado=${wChk + wSal + wCli}`);
  check('la celda fijada tiene fondo opaco (blanco)', sLargo.bg === 'rgb(255, 255, 255)', sLargo.bg);
  const sLargoBulto = await estiloCelda(nLargo, '#salidas-body tr.bulto-detail-row');
  check('la sub-fila de bulto también fija Largo', sLargoBulto?.position === 'sticky', JSON.stringify(sLargoBulto));
  check('y con el fondo gris de sub-fila', sLargoBulto?.bg === 'rgb(248, 250, 252)', sLargoBulto?.bg);

  console.log('\n4. Al scrollear horizontal, la columna fijada se queda en su lugar\n');
  const scrollable = await page.evaluate(() => {
    const w = document.getElementById('table-wrap');
    return w.scrollWidth > w.clientWidth + 300;
  });
  check('la tabla desborda (hay scroll horizontal para probar)', scrollable);
  const xObsAntes = (await estiloCelda(nObs)).x;
  // Scroll hasta el final: recién ahí Largo "toca" su tope y se queda pegado a la izquierda.
  const scrolled = await page.evaluate(() => {
    const w = document.getElementById('table-wrap');
    w.scrollLeft = w.scrollWidth;
    // El sticky se mide desde el borde interior del contenedor (clientLeft = su borde).
    return { left: w.getBoundingClientRect().left + w.clientLeft, scrollLeft: w.scrollLeft };
  });
  await esperar(300);
  const sLargoScroll = await estiloCelda(nLargo);
  const xObsDespues = (await estiloCelda(nObs)).x;
  check('Largo quedó pegado en su tope (wrap.left + su left)',
    Math.abs(sLargoScroll.x - (scrolled.left + sLargoScroll.left)) < 1,
    `x=${sLargoScroll.x} esperado=${scrolled.left + sLargoScroll.left}`);
  check('una columna no fijada (Observaciones) sí se corrió con el scroll',
    Math.abs((xObsAntes - xObsDespues) - scrolled.scrollLeft) < 1,
    `${xObsAntes} → ${xObsDespues} (scroll ${scrolled.scrollLeft})`);
  await page.evaluate(() => { document.getElementById('table-wrap').scrollLeft = 0; });

  console.log('\n5. Una columna del bloque UPS: Profit Real, con el bloque plegado y desplegado\n');
  check('se tildó Profit Real', (await tildar('Profit Real', true)) === 'ok');
  let sPR = await estiloCelda(nProfReal);
  const upsVisible = await page.evaluate(() => !document.getElementById('salidas-table').classList.contains('ups-collapsed'));
  if (upsVisible) {
    check('Profit Real quedó sticky', sPR?.position === 'sticky', JSON.stringify(sPR));
  } else {
    check('el bloque UPS está plegado: Profit Real no se ve (no rompe nada)', sPR !== null);
  }
  await page.click('#btn-toggle-ups').catch(() => {});
  await esperar(400);
  const upsVisible2 = await page.evaluate(() => !document.getElementById('salidas-table').classList.contains('ups-collapsed'));
  check('el botón del bloque UPS cambió el estado', upsVisible2 !== upsVisible);
  sPR = await estiloCelda(nProfReal);
  const sObs = await estiloCelda(nObs);
  check('plegar/desplegar el bloque UPS no rompe el sticky (Largo sigue fijo)', (await estiloCelda(nLargo))?.position === 'sticky');
  check('Observaciones sigue sin fijar', sObs?.position !== 'sticky');
  await page.click('#btn-toggle-ups').catch(() => {});
  await esperar(300);

  console.log('\n6. Persiste entre recargas y respeta lo guardado con el formato viejo\n');
  await page.reload({ waitUntil: 'networkidle' });
  await esperar(1200);
  check('después de recargar, Largo sigue fijo', (await estiloCelda(nLargo))?.position === 'sticky');
  check('y Profit Real también', (await estiloCelda(nProfReal))?.position === 'sticky');
  const guardado = await page.evaluate(() => JSON.parse(localStorage.getItem('nova.salidas.stickyCols') || '[]'));
  check('lo guardado usa claves estables (numero_salida, cliente_nombre, largo, profit_real)',
    JSON.stringify(guardado) === JSON.stringify(['numero_salida', 'cliente_nombre', 'largo', 'profit_real']), JSON.stringify(guardado));

  // Formato viejo (antes del 07/09): solo las 7 de identificación, por data-col.
  await page.evaluate(() => localStorage.setItem('nova.salidas.stickyCols', JSON.stringify(['numero_salida', 'destino'])));
  await page.reload({ waitUntil: 'networkidle' });
  await esperar(1200);
  const nDest = await nthDe('Destino');
  check('un guardado viejo (numero_salida + destino) se respeta: Destino fijo',
    (await estiloCelda(nDest))?.position === 'sticky');
  check('y Largo suelto', (await estiloCelda(nLargo))?.position !== 'sticky');
  check('el panel muestra tildado lo que está fijo', await page.evaluate(() => {
    const on = [...document.querySelectorAll('#sticky-cols-panel input:checked')].map((c) => c.value);
    return JSON.stringify(on) === JSON.stringify(['numero_salida', 'destino']);
  }));

  console.log('\n7. "Ninguna" suelta todas\n');
  await abrirPanel();
  await page.click('#sticky-cols-panel .sticky-cols-none');
  await esperar(300);
  check('ninguna celda queda sticky (salvo el checkbox)', await page.evaluate(() => {
    const tr = document.querySelector('#salidas-body tr[data-envio-id]');
    return [...tr.children].slice(1).every((td) => getComputedStyle(td).position !== 'sticky');
  }));
  check('el checkbox de selección sigue fijo (CSS estático)', await page.evaluate(() =>
    getComputedStyle(document.querySelector('#salidas-body tr[data-envio-id] td.chk-cell')).position === 'sticky'));
  check('quedó guardado vacío', await page.evaluate(() => localStorage.getItem('nova.salidas.stickyCols') === '[]'));

  console.log('\n8. Sin errores de JavaScript\n');
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 2).join(' | '));

  await browser.close();
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
