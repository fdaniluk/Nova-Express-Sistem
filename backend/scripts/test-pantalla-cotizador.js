#!/usr/bin/env node
/**
 * test-pantalla-cotizador.js — el cotizador con la estética del sistema (14/09/2026).
 *
 * La pantalla se rehízo con el mismo criterio que Guías y Cargar envío: cuatro pasos
 * numerados en tarjetas, resumen lateral fijo con el botón de calcular, extras como
 * chips, y el CSS propio (que tenía su propia tipografía y su propia paleta, metido
 * adentro del html) mudado a `frontend/css/modules/cotizador.css`.
 *
 * QUÉ CUIDA ESTA TANDA, en orden de riesgo:
 *
 *  1. QUE NO SE HAYA CAÍDO NINGÚN CAMPO EN LA MUDANZA. El cuerpo de la pantalla se
 *     reescribió entero: si un id se perdió, el JS de arriba (que es el mismo de antes)
 *     rompe en silencio y la oficina se queda sin cotizar. Se controlan TODOS los ids
 *     que usa el script de la pantalla y las otras trece tandas del cotizador.
 *  2. QUE EL RESUMEN LATERAL DIGA LO MISMO QUE LA TARJETA. Es un número nuevo en
 *     pantalla: si el facturable del costado no es el de la cotización, es peor que no
 *     tenerlo. Se compara contra lo que dice la tarjeta, no contra un número escrito acá.
 *  3. Que el botón de calcular, que se mudó al costado, siga cotizando.
 *  4. Que el profit y el panel de compra sigan FUERA de la tarjeta (la tarjeta es lo que
 *     se le manda al cliente: regla vieja de Felipe, 26/08).
 *  5. Que los cuatro pasos estén y que el <style> viejo ya no esté.
 *
 *   cd backend && node scripts/test-pantalla-cotizador.js
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

const PORT = process.env.PORT_TEST || 3931;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_cotizador.db';
const TOKEN = 'token-test-cotizador-estetica';

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

  // Sin fuel cargado la pantalla no cotiza (regla del cotizador).
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));
  await q("INSERT OR REPLACE INTO configuracion_nova (id, fuel_pct, fecha_actualizacion) VALUES (1, 30.5, datetime('now'))");
  await new Promise((res) => db.close(() => res()));

  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H,
    body: JSON.stringify({ nombre: 'ESTETICA S.R.L.', tarifa_pct: 75, tipo_cobro: 'CC' }),
  });

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));

  await page.goto(BASE + '/pages/cotizador.html', { waitUntil: 'networkidle' });
  await esperar(900);

  // ── 1 ────────────────────────────────────────────────────────────────────────
  console.log('\n1. Ningún campo se cayó en la mudanza\n');
  const IDS = [
    'pais', 'tipo', 'couriers', 'bultos-wrap', 'dup-cant',
    'valor', 'seguro-info', 'contenido',
    'ex_entrega', 'ex_residencial', 'ex_ddp', 'ex_proteccion_doc', 'ex_proteccion_doc_label',
    'card-impuestos', 'arancel-otro',
    'cliente', 'cliente-hint', 'ganancia', 'field-ganancia', 'fuel', 'fuel_fuente', 'fuel-hint',
    'pres_nombre', 'pres_logo', 'pres_validez', 'pres_dias',
    'error-msg', 'tira-interna', 'results', 'lbl_pais',
    'ctz-para-quien', 'pq-cliente', 'pq-otro', 'pq-ok', 'pq-cancelar', 'pq-error', 'pq-profit',
  ];
  const faltan = await page.evaluate((ids) => ids.filter((i) => !document.getElementById(i)), IDS);
  check(`están los ${IDS.length} ids que usa el JS`, faltan.length === 0, 'faltan: ' + faltan.join(', '));
  check('los radios de arancel siguen siendo input[name=arancel]',
    (await page.$$('input[name="arancel"]')).length >= 5);
  check('el botón de calcular sigue siendo .btn-calc', (await page.$$('.btn-calc')).length === 1);
  check('arranca con un bulto vacío', (await page.$$('.bulto-row')).length === 1);

  // ── 2 ────────────────────────────────────────────────────────────────────────
  console.log('\n2. Los cuatro pasos y el CSS mudado\n');
  const pasos = await page.$$eval('.cot-paso .cot-paso-cab h3', (hs) => hs.map((h) => h.textContent.trim()));
  check('hay cuatro pasos numerados', pasos.length === 4, pasos.join(' · '));
  check('   1 destino, 2 bultos, 3 valor y extras, 4 cliente',
    /destino/i.test(pasos[0] || '') && /bulto/i.test(pasos[1] || '')
    && /valor/i.test(pasos[2] || '') && /cliente/i.test(pasos[3] || ''), pasos.join(' · '));
  const numeros = await page.$$eval('.cot-paso .cot-num', (ns) => ns.map((n) => n.textContent.trim()).join(''));
  check('   con los números 1 a 4 a la vista', numeros === '1234', numeros);

  const html = await page.content();
  check('la pantalla ya no trae su propio <style>', !/<style[\s>]/i.test(html));
  check('   ni la tipografía traída de Google', !/fonts\.googleapis/i.test(html));
  check('el CSS vive en css/modules/cotizador.css', /css\/modules\/cotizador\.css/.test(html));
  const linkOk = await page.evaluate(async () => {
    const l = document.querySelector('link[href*="cotizador.css"]');
    if (!l) return 'sin link';
    const r = await fetch(l.href); return r.status;
  });
  check('   y el servidor lo sirve', linkOk === 200, String(linkOk));
  // Si el CSS no cargara, el botón principal quedaría gris del navegador.
  const colorBtn = await page.$eval('.btn-calc', (b) => getComputedStyle(b).backgroundColor);
  check('el botón principal está en el naranja de la marca',
    colorBtn.replace(/\s/g, '') === 'rgb(234,103,73)', colorBtn);

  // ── 3 ────────────────────────────────────────────────────────────────────────
  console.log('\n3. El resumen lateral se llena solo\n');
  const resumen = (k) => page.$eval(`#cot-resumen dd[data-r="${k}"]`, (e) => e.textContent.trim());
  check('arranca vacío, sin inventar nada', (await resumen('bultos')) === '—' && (await resumen('pf')) === '—');

  await page.selectOption('#tipo', 'export');
  await page.selectOption('#pais', { label: 'Brasil' }).catch(() => page.selectOption('#pais', 'Brasil'));
  await page.fill('.bulto-row .b-peso', '12.5');
  await page.fill('.bulto-row .b-largo', '45');
  await page.fill('.bulto-row .b-ancho', '45');
  await page.fill('.bulto-row .b-alto', '35');
  await page.dispatchEvent('.bulto-row .b-alto', 'input');
  await esperar(300);
  check('toma el destino', /Brasil/i.test(await resumen('pais')), await resumen('pais'));
  check('   y la operación', /Exportaci/i.test(await resumen('tipo')), await resumen('tipo'));
  check('cuenta el bulto cargado', (await resumen('bultos')) === '1', await resumen('bultos'));
  // 45×45×35/5000 = 14,175 → medio kilo para arriba = 14,5 (gana el volumétrico).
  check('   con el facturable redondeado a medio kilo', (await resumen('pf')) === '14,5 kg', await resumen('pf'));

  await page.click('.btn-add');
  const filas = await page.$$('.bulto-row');
  await filas[1].$eval('.b-peso', (e) => { e.value = '8.2'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await filas[1].$eval('.b-largo', (e) => { e.value = '40'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await filas[1].$eval('.b-ancho', (e) => { e.value = '30'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await filas[1].$eval('.b-alto', (e) => { e.value = '30'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await esperar(300);
  check('agregar un bulto lo suma al resumen', (await resumen('bultos')) === '2', await resumen('bultos'));
  check('   y suma los facturables de a medio kilo (14,5 + 8,5)',
    (await resumen('pf')) === '23,0 kg', await resumen('pf'));

  await page.fill('#valor', '250');
  await page.dispatchEvent('#valor', 'input');
  await esperar(250);
  check('toma el valor declarado', /250/.test(await resumen('fob')), await resumen('fob'));
  check('sin cliente dice "Sin cliente"', /sin cliente/i.test(await resumen('cliente')), await resumen('cliente'));
  await page.fill('#ganancia', '60');
  await page.dispatchEvent('#ganancia', 'input');
  await esperar(250);
  check('   y muestra la ganancia manual', (await resumen('ganancia')) === '60%', await resumen('ganancia'));

  await page.selectOption('#cliente', { label: 'ESTETICA S.R.L.' });
  await esperar(400);
  check('con cliente elegido muestra su nombre', /ESTETICA/i.test(await resumen('cliente')), await resumen('cliente'));
  /* El campo de ganancia se apaga y el porcentaje sale de la matriz del cliente: decir
     "—" ahí se leería como "sin ganancia". */
  check('   y avisa que el precio sale de su tarifa',
    /tarifa del cliente/i.test(await resumen('ganancia')), await resumen('ganancia'));

  const bultoBorrado = await page.$$('.bulto-row');
  await bultoBorrado[1].$eval('.btn-remove', (b) => b.click());
  await esperar(300);
  check('borrar un bulto también actualiza el resumen', (await resumen('bultos')) === '1', await resumen('bultos'));
  await page.click('.btn-add');
  const filas2 = await page.$$('.bulto-row');
  await filas2[1].$eval('.b-peso', (e) => { e.value = '8.2'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await filas2[1].$eval('.b-largo', (e) => { e.value = '40'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await filas2[1].$eval('.b-ancho', (e) => { e.value = '30'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await filas2[1].$eval('.b-alto', (e) => { e.value = '30'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await esperar(300);

  // ── 4 ────────────────────────────────────────────────────────────────────────
  console.log('\n4. El botón del costado cotiza, y la tarjeta dice lo mismo que el resumen\n');
  await page.click('.btn-calc');
  await esperar(2500);
  const tarjetas = await page.$$('.res-fila .result-card');
  check('salieron las tres tarjetas', tarjetas.length === 3, String(tarjetas.length));
  const meta = await page.$eval('.result-meta', (e) => e.textContent);
  const pfResumen = (await resumen('pf')).replace(' kg', '').replace(',', '.');
  check('el facturable de la tarjeta es el del resumen',
    meta.includes(`${pfResumen} kg facturable`), `resumen ${pfResumen} · tarjeta ${meta.slice(0, 120)}`);
  const totales = await page.$$eval('.result-total', (ns) => ns.map((n) => n.textContent.trim()));
  check('   y cada tarjeta trae su total en USD',
    totales.length === 3 && totales.every((t) => /^USD [\d.,]+$/.test(t)), totales.join(' · '));

  // ── 5 ────────────────────────────────────────────────────────────────────────
  console.log('\n5. Lo nuestro sigue FUERA de la tarjeta (la tarjeta se la mandamos al cliente)\n');
  const compraAdentro = await page.$$('.result-card .panel-compra');
  check('el panel de compra no está adentro de la tarjeta', compraAdentro.length === 0, String(compraAdentro.length));
  const guardarAdentro = await page.$$('.result-card .btn-viaja');
  check('el botón de guardar tampoco', guardarAdentro.length === 0, String(guardarAdentro.length));
  check('los dos viven en la columna de oficina',
    (await page.$$('.res-fila .col-oficina .panel-compra')).length === 3
    && (await page.$$('.res-fila .col-oficina .btn-viaja')).length === 3);
  const textoTarjeta = await page.$eval('.result-card', (e) => e.textContent);
  check('y en la tarjeta no aparece ni el profit ni el costo',
    !/profit|nuestra compra|ganancia/i.test(textoTarjeta), textoTarjeta.slice(0, 120));
  const tira = await page.$eval('#tira-interna', (e) => (e.style.display !== 'none' ? e.textContent : ''));
  check('el profit del cliente sí sale en la tira interna',
    /solo para la oficina/i.test(tira) && /75/.test(tira), tira.slice(0, 140));

  // ── 6 ────────────────────────────────────────────────────────────────────────
  console.log('\n6. En el teléfono nada se pisa (Felipe, 14/09: "quedó con cosas superpuestas")\n');
  /* Reproducido a 390 px el mismo día del deploy: la fila de bulto apretaba los rótulos uno
     encima de otro y el precio de la tarjeta quedaba encima de la línea de medidas. Se mide
     con las cajas reales de los elementos, no con la clase del CSS. */
  await page.setViewportSize({ width: 390, height: 844 });
  await esperar(500);
  const tel = await page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const meta = document.querySelector('.result-card .result-meta');
    const total = document.querySelector('.result-card .result-total');
    const peso = document.querySelector('.bulto-row .b-peso');
    const largo = document.querySelector('.bulto-row .b-largo');
    const labels = [...document.querySelector('.bulto-row').querySelectorAll('.cot-field label')].map(r);
    const seVe = (b) => b.width > 1 && b.height > 1;
    return {
      totalDebajoDeMeta: r(total).top >= r(meta).bottom - 1,
      pesoAncho: r(peso).width,
      rotulosVisibles: labels.filter(seVe).length,
      rotulosSeSolapan: labels.some((a, i) => labels.some((b, j) => i < j && seVe(a) && seVe(b)
        && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)),
      largoDebajoOAlLado: r(largo).left >= r(peso).right - 1 || r(largo).top >= r(peso).bottom - 1,
      scrollHorizontal: document.scrollingElement.scrollWidth - window.innerWidth,
    };
  });
  check('el precio de la tarjeta queda DEBAJO de la línea de medidas, no encima', tel.totalDebajoDeMeta);
  check('el campo de peso del bulto tiene lugar para escribir (> 90 px)', tel.pesoAncho > 90, String(tel.pesoAncho));
  check('los rótulos de la fila de bulto se ven (en el teléfono no hay cabecera)', tel.rotulosVisibles === 4, String(tel.rotulosVisibles));
  check('   y no se pisan entre sí', !tel.rotulosSeSolapan);
  check('   (largo va al lado o debajo del peso, nunca encima)', tel.largoDebajoOAlLado);
  check('la página no se desborda a los costados', tel.scrollHorizontal <= 0, String(tel.scrollHorizontal));
  await page.setViewportSize({ width: 1500, height: 950 });

  // ── 7 ────────────────────────────────────────────────────────────────────────
  console.log('\n7. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|Failed to load resource/i.test(x));
  check('ningún error en la pantalla', rel.length === 0, rel.slice(0, 2).join(' | '));

  await browser.close();
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
