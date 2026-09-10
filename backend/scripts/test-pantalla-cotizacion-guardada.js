#!/usr/bin/env node
/**
 * test-pantalla-cotizacion-guardada.js — lo que se hace con una cotización YA guardada
 * (lista de la oficina del 10/09/2026, bloque A — LISTA-OFICINA-10-09.md).
 *
 *   A1 · en el perfil del cliente, "Ver cuadro" vuelve a armar el cuadro que se le manda
 *        al cliente (la imagen) con los números guardados, para reenviarlo;
 *   A2 · con UNA opción guardada, el perfil no vuelve a preguntar qué servicio se confirmó:
 *        el botón es directo "✓ Aceptada" y acepta ESE servicio;
 *   A3 · en Cargar envío, pinchar la cotización completa país, tipo, courier y servicio,
 *        bultos con medidas y pesos, FOB, DDP y zona de entrega —además del precio—;
 *   A4 · si el país ya está elegido, el panel muestra solo las cotizaciones a ese país
 *        (y avisa); si no hay ninguna a ese país, muestra todas y avisa.
 *
 *   cd backend && node scripts/test-pantalla-cotizacion-guardada.js
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
const sqlite3 = require('sqlite3');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3962;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_ctz_guardada.db';
const TOKEN = 'token-test-pantalla-ctz-guardada';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); }
  else { fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarQue(fn, ms = 8000) {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn().catch(() => false)) return true;
    // eslint-disable-next-line no-await-in-loop
    await esperar(200);
  }
  return false;
}
function sql(query, params = []) {
  return new Promise((res, rej) => {
    const d = new sqlite3.Database(DB);
    d.all(query, params, (e, r) => { d.close(() => (e ? rej(e) : res(r || []))); });
  });
}

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
  await sql('INSERT INTO configuracion_nova (id, fuel_pct) VALUES (1, 36) ON CONFLICT(id) DO UPDATE SET fuel_pct = 36');

  const cli = await (await fetch(`${BASE}/api/clientes`, {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'CTZ GUARDADA SRL', tarifa_pct: 80 }),
  })).json();

  // Una cotización de dos bultos a Estados Unidos, con DHL y UPS Saver cotizados y SOLO el
  // Saver guardado (el botón de al lado del servicio), DDP y entrega extendida.
  const ctzUsa = await (await fetch(`${BASE}/api/cotizaciones`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, pais: 'Estados Unidos', tipo_envio: 'exportacion',
      zona: '2', peso_facturable: 17, cantidad_bultos: 2, valor_declarado: 500, dias_validez: 15,
      entrada: {
        bultos: [{ pr: 6, l: 40, a: 30, al: 32, pv: 7.7, pf: 8 }, { pr: 9, l: 50, a: 40, al: 20, pv: 8, pf: 9 }],
        ganancia_pct: 80, ddp: true, entrega: 'extendida', proteccion_doc: false,
      },
      opciones: [
        { servicio: 'DHL', viaja: 0, total: 410.5, zona: 2, pf: 17, flete: 250, surge: 0, subtotal: 250, fuel_pct: 36, fuel_monto: 90, extras: [['Entrega extendida', 70.5]], costo: 200 },
        { servicio: 'UPS Worldwide Saver', viaja: 1, total: 386.2, zona: 2, pf: 17, flete: 230, surge: 12, subtotal: 242, fuel_pct: 36, fuel_monto: 87.12, extras: [['Entrega extendida', 57.08]], costo: 190 },
      ],
    }),
  })).json();
  // Y otra, de un bulto, a Chile, con DHL guardado.
  const ctzChile = await (await fetch(`${BASE}/api/cotizaciones`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, pais: 'Chile', tipo_envio: 'exportacion',
      zona: '1', peso_facturable: 3, cantidad_bultos: 1, valor_declarado: 80,
      entrada: { bultos: [{ pr: 2.5, l: 30, a: 20, al: 15, pv: 1.8, pf: 3 }], ganancia_pct: 80 },
      opciones: [{ servicio: 'DHL', viaja: 1, total: 120, zona: 1, pf: 3, flete: 80, surge: 0, subtotal: 80, fuel_pct: 36, fuel_monto: 28.8, extras: [], costo: 60 }],
    }),
  })).json();
  check('se crearon las dos cotizaciones', ctzUsa.id && ctzChile.id, JSON.stringify([ctzUsa, ctzChile]).slice(0, 200));

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
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource|fonts.googleapis|fonts.gstatic/.test(m.text())) {
      errores.push(m.text());
    }
  });
  page.on('dialog', (d) => d.accept());

  console.log('\n1. Perfil: el servicio guardado se ve, y no se vuelve a preguntar cuál\n');
  await page.goto(`${BASE}/pages/clientes-perfil.html?id=${cli.id}`);
  const hayTabla = await esperarQue(async () => (await page.$$('#ctz-lista .ctz-tabla tbody tr')).length >= 2);
  check('aparecen las dos cotizaciones', hayTabla);
  const filaUsa = () => page.$(`#ctz-lista tr:has(td:text("CTZ-${ctzUsa.numero}"))`);
  const fila = await filaUsa();
  check('está la fila de la cotización a Estados Unidos', !!fila);
  const opsTxt = fila ? await (await fila.$('td:nth-child(6)')).textContent() : '';
  check('la opción guardada (UPS Saver) lleva ✓ y la no guardada (DHL) no', /✓ UPS W\.S/.test(opsTxt) && !/✓ DHL/.test(opsTxt), opsTxt.trim());
  const botones = fila ? await fila.$$eval('.ctz-acciones button', (bs) => bs.map((b) => b.textContent.trim())) : [];
  check('el botón es directo "✓ Aceptada" (no "Aceptar DHL" / "Aceptar UPS…")', botones[0] === '✓ Aceptada' && !botones.some((b) => /^Aceptar /.test(b)), botones.join(' | '));
  await (await fila.$('.ctz-acciones button')).click();
  const acepto = await esperarQue(async () => {
    const f = await filaUsa();
    return f && /aceptada/.test(await (await f.$('.ctz-chip')).textContent());
  });
  check('al apretarlo queda aceptada…', acepto);
  const q1 = await (await fetch(`${BASE}/api/cotizaciones/${ctzUsa.id}`, { headers: H })).json();
  check('…con el servicio guardado (UPS Worldwide Saver) y su total (386.20) como acordado',
    q1.servicio_aceptado === 'UPS Worldwide Saver' && Number(q1.total_acordado) === 386.2, `${q1.servicio_aceptado} / ${q1.total_acordado}`);

  console.log('\n2. Perfil: "Ver cuadro" vuelve a armar la imagen que se le manda al cliente\n');
  const f2 = await filaUsa();
  await (await f2.$('button[data-accion="desglose"]')).click();
  const hayCuadroBtn = await esperarQue(async () => (await page.$$(`.ctz-ver-cuadro[data-id="${ctzUsa.id}"]`)).length >= 2);
  check('al abrir el desglose hay un botón "Ver cuadro" por opción', hayCuadroBtn);
  // Se espía fillText para leer lo que se dibuja (el PNG no se puede leer sin OCR).
  await page.evaluate(() => {
    window.__trazos = [];
    const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.fillText;
    proto.fillText = function espia(txt) { window.__trazos.push(String(txt)); return orig.apply(this, arguments); };
  });
  await page.click(`.ctz-ver-cuadro[data-id="${ctzUsa.id}"][data-servicio="UPS Worldwide Saver"]`);
  const abrio = await esperarQue(async () => page.$eval('#ctz-cuadro-overlay', (el) => el.classList.contains('on')));
  check('se abre el modal del cuadro', abrio);
  const cuadro = await page.evaluate(() => ({
    tit: document.getElementById('ctz-cuadro-tit').textContent,
    sub: document.getElementById('ctz-cuadro-sub').textContent,
    src: document.getElementById('ctz-cuadro-img').src.slice(0, 21),
    w: document.getElementById('ctz-cuadro-img').naturalWidth,
    trazos: window.__trazos,
  }));
  check('el título dice CTZ-n · UPS W.S', new RegExp(`CTZ-${ctzUsa.numero} · UPS W\\.S`).test(cuadro.tit), cuadro.tit);
  check('la imagen es un PNG dibujado (680 px × 2)', cuadro.src === 'data:image/png;base64' && cuadro.w === 1360, `${cuadro.src} ${cuadro.w}`);
  const t = cuadro.trazos.join(' | ');
  check('el cuadro lleva el nombre del cliente', /CTZ GUARDADA SRL/.test(t));
  check('y el servicio "Nova Express – UPS W.S"', /Nova Express/.test(t) && /UPS W\.S/.test(t));
  check('y el total guardado (386.20), no uno recalculado', /USD 386\.20/.test(t));
  check('y el desglose guardado: flete 230, surge 12, fuel 36% 87.12, entrega extendida', /USD 230\.00/.test(t) && /Surge fee UPS/.test(t) && /Fuel \(36%\)/.test(t) && /87\.12/.test(t) && /Entrega extendida/.test(t), t.slice(0, 300));
  check('y la línea de medidas: 2 bultos, 17.0 kg facturable, FOB 500', /2 bultos/.test(t) && /17\.0 kg facturable/.test(t) && /FOB USD 500\.00/.test(t), t.slice(0, 300));
  check('y la validez ("válida hasta el …")', /válida hasta el/.test(t));
  check('🔴 el cuadro NO lleva nuestro costo (190) ni la palabra profit', !/190\.00/.test(t) && !/profit/i.test(t));
  check('hay botones Copiar imagen y Descargar PNG', !!(await page.$('#ctz-cuadro-copiar')) && !!(await page.$('#ctz-cuadro-bajar')));
  await page.keyboard.press('Escape');
  await esperar(200);
  check('Esc cierra el modal', await page.$eval('#ctz-cuadro-overlay', (el) => !el.classList.contains('on')));

  console.log('\n3. Cargar envío: pinchar la cotización completa el formulario entero\n');
  await page.goto(`${BASE}/pages/envios.html`);
  await esperar(2500);
  await page.selectOption('#cliente_id', String(cli.id));
  const hayFilas = await esperarQue(async () => (await page.$$('#ctzr-panel .ctzr-fila')).length >= 2);
  check('sin país elegido el panel muestra las dos cotizaciones', hayFilas, await page.textContent('#ctzr-panel'));
  check('sin país no hay aviso de filtro', !(await page.$('#ctzr-panel .ctzr-aviso')));
  await page.click(`#ctzr-panel .ctzr-precio[data-ctz="${ctzUsa.id}"]`);
  await esperar(900);
  const form = await page.evaluate(() => {
    const v = (id) => document.getElementById(id).value;
    const c = (id) => document.getElementById(id).checked;
    const b = (i, f) => (document.querySelector(`[data-bulto="${i}"][data-field="${f}"]`) || {}).value;
    return {
      total: v('total_cobrado'), pais: v('pais_destino'), tipo: v('tipo_envio'), courier: v('courier'),
      servicio: v('cot-ups-variante'), upsVisible: document.getElementById('cot-ups-wrap').style.display !== 'none',
      n: v('cantidad_bultos'), b1: [b(1, 'largo'), b(1, 'ancho'), b(1, 'alto'), b(1, 'peso_real')].join('×'),
      b2: [b(2, 'largo'), b(2, 'ancho'), b(2, 'alto'), b(2, 'peso_real')].join('×'),
      pesoReal: v('peso_real'), fob: v('fob'), asegurado: c('asegurado'), ddp: c('ddp'), entrega: v('entrega'),
      nota: document.getElementById('ctzr-sugerido').textContent,
    };
  });
  check('el precio sugerido es el de la opción (386.20)', form.total === '386.20', form.total);
  check('país: Estados Unidos', form.pais === 'Estados Unidos', form.pais);
  check('tipo: exportación', form.tipo === 'exportacion', form.tipo);
  check('courier UPS y servicio Saver', form.courier === 'UPS' && form.servicio === 'UPS_SAV' && form.upsVisible, `${form.courier}/${form.servicio}`);
  check('2 bultos con sus medidas y pesos (40×30×32×6 y 50×40×20×9)', form.n === '2' && form.b1 === '40×30×32×6' && form.b2 === '50×40×20×9', `${form.n}: ${form.b1} / ${form.b2}`);
  check('peso balanza = suma de los bultos (15)', Number(form.pesoReal) === 15, form.pesoReal);
  check('FOB 500 y asegurado tildado', Number(form.fob) === 500 && form.asegurado, `${form.fob} / ${form.asegurado}`);
  check('DDP tildado y entrega extendida', form.ddp && form.entrega === 'extendida', `${form.ddp} / ${form.entrega}`);
  check('la nota dice de qué cotización salió todo', new RegExp(`CTZ-${ctzUsa.numero}`).test(form.nota), form.nota);

  console.log('\n4. Cargar envío: con el país elegido, solo las cotizaciones a ese país\n');
  await page.selectOption('#pais_destino', 'Chile');
  const soloChile = await esperarQue(async () => {
    const filas = await page.$$('#ctzr-panel .ctzr-fila');
    const txt = await page.textContent('#ctzr-panel');
    return filas.length === 1 && new RegExp(`CTZ-${ctzChile.numero}`).test(txt);
  });
  check('con Chile elegido queda solo la cotización a Chile', soloChile, (await page.textContent('#ctzr-panel')).slice(0, 120));
  check('y avisa que está filtrando por país', /Solo las cotizaciones a/.test(await page.textContent('#ctzr-panel')));
  await page.selectOption('#pais_destino', 'Alemania');
  const todasConAviso = await esperarQue(async () => {
    const filas = await page.$$('#ctzr-panel .ctzr-fila');
    return filas.length === 2 && /No hay cotizaciones a/.test(await page.textContent('#ctzr-panel'));
  });
  check('con un país sin cotizaciones (Alemania) muestra todas y avisa', todasConAviso, (await page.textContent('#ctzr-panel')).slice(0, 120));
  await page.click(`#ctzr-panel .ctzr-precio[data-ctz="${ctzChile.id}"]`);
  await esperar(700);
  const f4 = await page.evaluate(() => ({
    pais: document.getElementById('pais_destino').value, courier: document.getElementById('courier').value,
    n: document.getElementById('cantidad_bultos').value, peso: document.getElementById('peso_real').value,
    largo: document.getElementById('largo').value, total: document.getElementById('total_cobrado').value,
    ddp: document.getElementById('ddp').checked, entrega: document.getElementById('entrega').value,
  }));
  check('pinchar la de Chile (1 bulto, DHL) pisa país, courier, bulto único y precio',
    f4.pais === 'Chile' && f4.courier === 'DHL' && f4.n === '1' && Number(f4.peso) === 2.5 && Number(f4.largo) === 30 && f4.total === '120.00', JSON.stringify(f4));
  check('y apaga DDP / vuelve la entrega a normal (la nueva cotización no los tenía)', !f4.ddp && f4.entrega === 'normal', `${f4.ddp} / ${f4.entrega}`);

  console.log('\n5. Sin errores de JavaScript\n');
  check('ningún error en las pantallas', errores.length === 0, errores.slice(0, 3).join(' | '));

  await browser.close();
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('✗ error inesperado:', e); process.exit(1); });
