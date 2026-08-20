#!/usr/bin/env node
/**
 * test-pantalla-cotizacion-cliente.js — la cotización que se le manda AL CLIENTE, en un
 * navegador de verdad (20/08/2026).
 *
 * POR QUÉ EXISTE
 * La oficina manda las cotizaciones sacándole una imagen a la tarjeta del cotizador. Hasta
 * hoy, si se cotizaba CON UN CLIENTE ELEGIDO, esa tarjeta mostraba adentro
 * `Profit cliente: 120%` — o, peor con la tarifa por kilo, `Tarifa cliente: USD 5,00 por
 * kilo`. O sea: se le estaba mandando el margen al cliente, y puede haber pasado ya.
 *
 * Ahora esa línea vive en una TIRA INTERNA fuera de las tarjetas, y la imagen que se copia
 * NO es una captura del HTML: se dibuja de cero en un canvas. Este test existe para que esa
 * separación no se pierda de vista en la próxima edición.
 *
 * QUÉ SE PRUEBA, en orden de riesgo:
 *
 *  1. QUE EL PROFIT NO ESTÉ ADENTRO DE NINGUNA TARJETA, ni como porcentaje ni como precio
 *     por kilo. Es la fuga. Si esto se pone rojo, se le está mandando el margen al cliente.
 *  2. Que la tira interna SÍ lo muestre (si no, la oficina pierde el control que necesita)
 *     y que esté fuera de `.result-card`.
 *  3. Que la imagen copiada sea un PNG de verdad, que se genere por cada tarjeta, y que
 *     NO contenga el profit. Se controla el tamaño: una imagen vacía o de 0 px sería un
 *     falso verde.
 *  4. Que las opciones de presentación hagan lo que dicen: el logo cambia la imagen, el
 *     nombre del cliente y la validez también, y apagarlas la achica.
 *  5. Que los números de la imagen salgan del MISMO objeto que pintó la tarjeta (si la
 *     imagen recalculara, el papel podría decir otra cosa que la pantalla).
 *
 *   cd backend && node scripts/test-pantalla-cotizacion-cliente.js
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

const PORT = process.env.PORT_TEST || 3963;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_cot_cliente.db';
const TOKEN = 'token-test-cot-cliente';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
let matarTodo = () => {};
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else {
    fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`);
  }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await J('PUT', '/api/configuracion/fuel/NOVA', { fuel_pct: 28 });
  await J('PUT', '/api/configuracion/fuel/DHL', { fuel_pct: 28 });
  await J('PUT', '/api/configuracion/fuel/UPS', { fuel_pct: 28 });

  // Cliente PORCENTUAL con un margen bien reconocible: si 137 aparece en algún lado de la
  // tarjeta o de la imagen, es la fuga.
  const cliPct = (await J('POST', '/api/clientes', { nombre: 'FUGA PCT SRL', tarifa_pct: 137 })).body;
  // Cliente POR KILO: la otra cara de la misma fuga, el precio unitario cargado.
  const cliKg = (await J('POST', '/api/clientes', { nombre: 'FUGA KILO SRL', tarifa_pct: 50 })).body;
  await J('PUT', `/api/clientes/${cliKg.id}`, { modo_tarifa: 'por_kg' });
  // Sin zona ni peso_min: es la tarifa de TABLA del cliente, la que aplica a todo.
  const kgRes = await J('PUT', `/api/clientes/${cliKg.id}/tarifa-kg`, {
    servicio: 'UPS_EXP', tipo: 'export', precio_kg: 7.77,
  });
  if (kgRes.status !== 200) {
    console.log(`  ⚠ no se pudo cargar la tarifa por kilo: ${JSON.stringify(kgRes.body)}`);
  }

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, domain: 'localhost', path: '/' }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));

  await page.goto(BASE + '/pages/cotizador.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('#pres_logo');

  const cargar = async (clienteId) => {
    await page.selectOption('#pais', 'Estados Unidos');
    await page.selectOption('#couriers', 'ups_exp');
    await page.fill('#valor', '0');
    await page.selectOption('#cliente', String(clienteId));
    await page.fill('.bulto-row .b-peso', '10');
    await page.fill('.bulto-row .b-largo', '30');
    await page.fill('.bulto-row .b-ancho', '25');
    await page.fill('.bulto-row .b-alto', '20');
  };
  const cotizar = async () => { await page.click('.btn-calc'); await page.waitForSelector('.result-card', { timeout: 8000 }); await esperar(400); };

  // ── 1. LA FUGA ──────────────────────────────────────────────────────────────────────
  console.log('\n1. El profit del cliente NO puede estar adentro de la tarjeta\n');

  await cargar(cliPct.id);
  await cotizar();

  const textoTarjetas = await page.$$eval('.result-card', (c) => c.map((x) => x.textContent).join(' | '));
  check('la cotización con cliente sale', /UPS/.test(textoTarjetas), textoTarjetas.slice(0, 80));
  check('la tarjeta NO dice "Profit cliente"', !/Profit cliente/i.test(textoTarjetas));
  check('la tarjeta NO muestra el 137% del cliente', !/137/.test(textoTarjetas),
    (textoTarjetas.match(/.{0,30}137.{0,30}/) || [''])[0]);

  const tira = await page.$eval('#tira-interna', (e) => ({ txt: e.textContent, visible: e.offsetParent !== null }));
  check('la tira interna SÍ lo muestra (la oficina lo necesita)', /137/.test(tira.txt), tira.txt.slice(0, 80));
  check('y está visible', tira.visible);
  check('la tira dice que es solo para la oficina', /solo para la oficina/i.test(tira.txt));
  const tiraFuera = await page.$eval('#tira-interna', (e) => !e.closest('.result-card'));
  check('la tira vive FUERA de las tarjetas', tiraFuera);

  // ── 2. La misma fuga, con tarifa por kilo ───────────────────────────────────────────
  console.log('\n2. Lo mismo con un cliente por kilo (el precio unitario es igual de sensible)\n');

  await cargar(cliKg.id);
  await cotizar();
  const txtKg = await page.$$eval('.result-card', (c) => c.map((x) => x.textContent).join(' | '));
  check('la tarjeta NO dice "Tarifa cliente"', !/Tarifa cliente/i.test(txtKg));
  check('la tarjeta NO muestra el precio por kilo cargado (7.77)', !/7[.,]77/.test(txtKg),
    (txtKg.match(/.{0,30}7[.,]77.{0,30}/) || [''])[0]);
  const tiraKg = await page.$eval('#tira-interna', (e) => e.textContent);
  check('la tira interna sí muestra el precio por kilo', /7[.,]77/.test(tiraKg), tiraKg.slice(0, 90));

  // ── 3. La imagen que se copia ───────────────────────────────────────────────────────
  console.log('\n3. La imagen: es un PNG de verdad, y no lleva el margen adentro\n');

  await cargar(cliPct.id);
  await cotizar();

  check('hay un botón "Copiar imagen" por tarjeta',
    (await page.$$('.btn-copiar')).length === (await page.$$('.result-card')).length);

  /* El portapapeles no existe en el navegador de pruebas: se intercepta el dibujo y se
     saca el PNG en base64 directo del canvas, que es lo que se copiaría. */
  const png = await page.evaluate(async () => {
    const orig = HTMLCanvasElement.prototype.toBlob;
    let capturado = null;
    HTMLCanvasElement.prototype.toBlob = function toBlobEspia(cb, tipo) {
      capturado = this.toDataURL(tipo || 'image/png');
      return orig.call(this, cb, tipo);
    };
    await window.copiarImagen(0, document.querySelector('.btn-copiar'));
    HTMLCanvasElement.prototype.toBlob = orig;
    return capturado;
  });
  check('se genera una imagen', !!png && png.startsWith('data:image/png'), String(png).slice(0, 30));
  check('la imagen pesa lo que pesa un dibujo real (no está vacía)',
    png && png.length > 15000, png ? `${Math.round(png.length / 1024)} KB` : 'sin imagen');

  const medir = (d) => page.evaluate((dat) => new Promise((res) => {
    const i = new Image(); i.onload = () => res({ w: i.width, h: i.height }); i.src = dat;
  }), d);
  const dim = await medir(png);
  check('la imagen tiene un tamaño razonable (no 0×0)', dim.w > 600 && dim.h > 200, JSON.stringify(dim));

  /* Que el profit no esté en la imagen no se puede leer del PNG sin OCR. Lo que SÍ se
     puede garantizar es que la imagen no se dibuja del DOM: se controla que el dibujante
     no lea la tarjeta ni la tira. */
  const fuente = await page.evaluate(() => String(window.copiarImagen));
  check('el dibujante NO captura el DOM (no lee .result-card ni la tira)',
    !/result-card|tira-interna|innerHTML|outerHTML/.test(fuente));
  check('el dibujante tampoco toca el profit', !/profit/i.test(fuente));

  // ── 4. Las opciones de presentación ─────────────────────────────────────────────────
  console.log('\n4. Logo, nombre del cliente y validez cambian la imagen\n');

  const generar = () => page.evaluate(async () => {
    const orig = HTMLCanvasElement.prototype.toBlob;
    let cap = null;
    HTMLCanvasElement.prototype.toBlob = function espia(cb, t) { cap = this.toDataURL(t || 'image/png'); return orig.call(this, cb, t); };
    await window.copiarImagen(0, document.querySelector('.btn-copiar'));
    HTMLCanvasElement.prototype.toBlob = orig;
    return cap;
  });

  const conTodo = await page.evaluate(() => { document.getElementById('pres_logo').checked = true; });
  void conTodo;
  await page.fill('#pres_nombre', 'ASAPLAST S.R.L.');
  await page.check('#pres_validez');
  const imgCompleta = await generar();
  const dimCompleta = await medir(imgCompleta);

  await page.uncheck('#pres_validez');
  await page.fill('#pres_nombre', '');
  const imgPelada = await generar();
  const dimPelada = await medir(imgPelada);
  check('con nombre y validez la imagen es más alta que sin ellos',
    dimCompleta.h > dimPelada.h, `${dimCompleta.h} vs ${dimPelada.h}`);

  await page.uncheck('#pres_logo');
  const imgSinLogo = await generar();
  const dimSinLogo = await medir(imgSinLogo);
  check('sin logo se va la franja del pie y la imagen es más baja',
    dimSinLogo.h < dimPelada.h, `${dimSinLogo.h} vs ${dimPelada.h}`);
  check('sin logo la imagen igual se genera', imgSinLogo.startsWith('data:image/png'));
  check('apagar el logo no cambia el ancho', dimSinLogo.w === dimPelada.w);

  /* La fecha y la validez viven en la franja del pie, junto al logo. Entonces esa franja
     tiene que existir aunque apaguen el logo: si no, la validez no tendría dónde ir y se
     perdería en silencio (el caso que se introdujo al mover la fecha, 20/08). */
  await page.check('#pres_validez');
  const imgSinLogoConVal = await generar();
  const dimSinLogoConVal = await medir(imgSinLogoConVal);
  check('sin logo pero CON validez, la franja del pie igual aparece',
    dimSinLogoConVal.h > dimSinLogo.h, `${dimSinLogoConVal.h} vs ${dimSinLogo.h} (sin nada)`);
  await page.uncheck('#pres_validez');
  await page.check('#pres_logo');

  const dias = await page.$eval('#pres_dias', (e) => e.value);
  check('la validez viene con 15 días por defecto', dias === '15', dias);

  // ── 5. La imagen usa los números de la pantalla ─────────────────────────────────────
  console.log('\n5. La imagen no recalcula: usa el mismo objeto que pintó la tarjeta\n');

  const coherente = await page.evaluate(() => {
    const est = window.__cot;
    if (!est || !est.results || !est.results[0]) return { ok: false, motivo: 'sin estado' };
    const card = document.querySelector('.result-card');
    const totalPantalla = card.querySelector('.result-total').textContent.trim();
    const totalEstado = (window.fmt ? window.fmt(est.results[0].total) : null);
    return { ok: totalEstado === totalPantalla, totalPantalla, totalEstado };
  });
  check('el total guardado para la imagen es el mismo que muestra la tarjeta',
    coherente.ok, JSON.stringify(coherente));

  check('la pantalla no tiró ningún error de JavaScript', errores.length === 0, errores.join(' | ').slice(0, 160));

  // ── 6. Las tildes se VEN puestas y se pueden sacar ────────────────────────────────
  /* Bug encontrado el 20/08/2026, y estuvo invisible mucho tiempo: la regla general de
     inputs del cotizador lleva `appearance:none` (esta pensada para los campos de texto) y
     tambien alcanzaba a las tildes, borrandoles el dibujo nativo. El `accent-color` que
     habia no hacia nada sin apariencia nativa, asi que la tilde se veia IGUAL puesta que
     sin poner: lo unico que cambiaba era el aro del foco. La oficina creia que no se podian
     destildar y recargaba la pagina. Se destildaban siempre; no se veia.
     Esto NO es un test de estetica: si alguien vuelve a dejar la tilde sin dibujo, la
     oficina cotiza sin saber si el DDP o la proteccion de documentos estan puestos. */
  console.log('\n6. Las tildes muestran si están puestas y se pueden sacar\n');

  /* OJO AL MEDIR: la tilde tiene `transition: background .12s`. Si se lee el color en el
     instante del click se lee la animacion a mitad de camino y da el color ANTERIOR — la
     primera version de este test fallaba por eso y el CSS estaba bien. Por eso se espera a
     que el color efectivamente cambie, no a que pase un tiempo fijo. */
  const colorDe = (id) => page.$eval(`#${id}`, (e) => getComputedStyle(e).backgroundColor);
  const colorFila = (id) => page.$eval(`#${id}`, (e) => getComputedStyle(e.closest('.check-label')).backgroundColor);
  const esperarColorDistinto = async (id, previo) => {
    await page.waitForFunction(
      ([sel, antes]) => getComputedStyle(document.getElementById(sel)).backgroundColor !== antes,
      [id, previo], { timeout: 4000 },
    ).catch(() => {});
    return colorDe(id);
  };

  await page.uncheck('#ex_ddp');
  await page.waitForTimeout(200);
  const tildeApagada = await colorDe('ex_ddp');
  const filaApagada = await colorFila('ex_ddp');

  // Se tilda haciendo click en el RENGLON, que es como lo usa la oficina.
  await page.click('label:has(#ex_ddp)');
  check('hacer click en el renglón pone la tilde', await page.isChecked('#ex_ddp'));
  const tildePuesta = await esperarColorDistinto('ex_ddp', tildeApagada);
  const filaPuesta = await colorFila('ex_ddp');

  check('la tilde puesta se ve DISTINTA de la tilde sin poner',
    tildePuesta !== tildeApagada,
    `puesta ${tildePuesta} · sin poner ${tildeApagada}`);
  check('y no es solo el borde: se rellena de color',
    tildePuesta !== 'rgba(0, 0, 0, 0)' && tildePuesta !== 'rgb(255, 255, 255)', tildePuesta);
  check('el renglón entero también se pinta',
    filaPuesta !== filaApagada, `puesto ${filaPuesta} · sin poner ${filaApagada}`);
  check('la tilde dibuja el gancho (tiene ::after)',
    await page.$eval('#ex_ddp', (e) => getComputedStyle(e, '::after').content !== 'none'));

  // Y se puede SACAR, que era la queja concreta de la oficina.
  await page.click('label:has(#ex_ddp)');
  check('volver a hacer click la saca', !(await page.isChecked('#ex_ddp')));
  /* Acá hay que esperar a que LLEGUE al color de apagada, no a que se despegue del azul:
     la transición pasa por colores intermedios y cualquiera de ellos ya es "distinto". */
  await page.waitForFunction(
    ([sel, fin]) => getComputedStyle(document.getElementById(sel)).backgroundColor === fin,
    ['ex_ddp', tildeApagada], { timeout: 4000 },
  ).catch(() => {});
  check('y vuelve al color de apagada', (await colorDe('ex_ddp')) === tildeApagada,
    `quedó ${await colorDe('ex_ddp')} · esperado ${tildeApagada}`);

  check('las etiquetas de las opciones NO van en mayúscula sostenida',
    await page.$eval('label:has(#ex_ddp)', (e) => getComputedStyle(e).textTransform === 'none'));

  // ── 7. Títulos abreviados, panel de compra y cartel de +50 kg ─────────────────────
  /* Los tres pedidos de la oficina del 20/08/2026. El del panel de compra es el mismo
     riesgo que el profit: son NUESTROS numeros de costo, asi que tiene que vivir FUERA de
     la tarjeta — si entrara adentro, una captura de la tarjeta se los manda al cliente. */
  console.log('\n7. Títulos abreviados, panel de compra y cartel de +50 kg\n');

  // Las secciones anteriores dejaron un solo courier elegido: para mirar los tres títulos
  // hay que volver a cotizar con los tres.
  await page.selectOption('#couriers', 'ambos');
  await page.click('.btn-calc');
  await page.waitForSelector('.result-card');
  await esperar(1200);

  const titulos = await page.$$eval('.result-courier', (e) => e.map((x) => x.textContent.trim()));
  check('el servicio se muestra abreviado y no con el nombre largo',
    titulos.some((t) => /UPS W\.E/.test(t)) && !titulos.some((t) => /Worldwide Expedited/.test(t)),
    titulos.join(' | '));
  check('el Saver también', titulos.some((t) => /UPS W\.S/.test(t)), titulos.join(' | '));
  check('y DHL queda solo como "DHL"',
    titulos.some((t) => /^DHL/.test(t)) && !titulos.some((t) => /DHL Express Worldwide/.test(t)),
    titulos.join(' | '));

  const panel = await page.$$('.panel-compra');
  check('hay un panel de "nuestra compra" por cotización', panel.length >= 1, `hay ${panel.length}`);
  check('🔴 el panel de compra vive FUERA de la tarjeta (si no, una captura le manda el costo al cliente)',
    await page.$$eval('.result-card .panel-compra', (e) => e.length === 0));
  const textoPanel = await page.$eval('.panel-compra', (e) => e.textContent);
  check('el panel muestra el costo y la ganancia',
    /Costo total/i.test(textoPanel) && /Ganancia/i.test(textoPanel), textoPanel.slice(0, 90));
  check('y aclara que es solo para la oficina', /solo oficina/i.test(textoPanel));

  // El costo del panel tiene que ser MENOR que lo que se le cobra al cliente.
  const nums = await page.$eval('.res-fila', (fila) => {
    const total = fila.querySelector('.result-total').textContent.replace(/[^\d.]/g, '');
    const filas = [...fila.querySelectorAll('.panel-compra .pc-row')].map((r) => r.textContent);
    const costo = (filas.find((t) => /Costo total/i.test(t)) || '').replace(/[^\d.]/g, '');
    return { total: Number(total), costo: Number(costo) };
  });
  check('el costo es menor que el precio de venta', nums.costo > 0 && nums.costo < nums.total,
    `costo ${nums.costo} · venta ${nums.total}`);

  // El cartel de +50 kg: solo importación, solo DHL, solo arriba de 50 kg.
  await page.selectOption('#tipo', 'import');
  await page.selectOption('#couriers', 'dhl');
  await page.fill('.bulto-row .b-peso', '60');
  await page.click('.btn-calc');
  await page.waitForSelector('.result-card');
  await esperar(1200);
  check('en una impo DHL de más de 50 kg aparece el cartel "Tarifa +50Kg"',
    (await page.$$('.badge-50')).length === 1);

  await page.fill('.bulto-row .b-peso', '10');
  await page.click('.btn-calc');
  await esperar(1200);
  check('y NO aparece si el envío pesa menos de 50 kg',
    (await page.$$('.badge-50')).length === 0);

  await page.selectOption('#tipo', 'export');
  await page.fill('.bulto-row .b-peso', '60');
  await page.click('.btn-calc');
  await esperar(1200);
  check('tampoco aparece en una exportación de 60 kg (es solo para impo)',
    (await page.$$('.badge-50')).length === 0);

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
