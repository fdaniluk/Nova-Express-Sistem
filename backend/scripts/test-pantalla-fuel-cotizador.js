#!/usr/bin/env node
/**
 * test-pantalla-fuel-cotizador.js — el desplegable de fuel del Cotizador, en un navegador
 * de verdad.
 *
 * POR QUÉ EXISTE
 * Hasta el 10/08/2026 el fuel del cotizador se tipeaba a mano y no salía de ningún lado.
 * Ese es el defecto que dejó 4 envíos congelados en 39% cuando Configuración decía 33%:
 * nadie se acuerda de cambiar un campo que arranca vacío, y el error no se ve — el número
 * igual parece razonable. Felipe pidió las mismas tres opciones que en Cargar envío, pero
 * adaptadas a que el cotizador muestra DHL y UPS juntos en una sola pantalla:
 *
 *   Fuel Nova (predeterminado) — el nuestro, el MISMO para la tarjeta de DHL y las de UPS
 *   Fuel proveedor            — a cada una la suya: DHL con el de DHL, UPS con el de UPS
 *   A mano                    — el número que se escriba, para las dos
 *
 * QUÉ SE PRUEBA, en orden de riesgo:
 *
 *  1. Que el porcentaje que se muestra sea el que de verdad se aplicó a la plata. Que la
 *     etiqueta diga 28% y el monto esté calculado con 39,5% es la peor falla posible acá:
 *     nadie la ve hasta que llega la factura.
 *  2. Que "Fuel proveedor" le dé a cada courier el suyo, no el del otro.
 *  3. Que con el fuel sin cargar NO cotice. Un precio sin fuel sale por debajo del costo,
 *     y es exactamente el tipo de número plausible que el sistema prefería devolver.
 *  4. Que un cliente con fuel propio negociado NO pise la elección en silencio: manda lo
 *     elegido y la pantalla avisa. Antes lo pisaba sin decir nada.
 *
 *   cd backend && node scripts/test-pantalla-fuel-cotizador.js
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

const PORT = process.env.PORT_TEST || 3964;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_fuel_cot.db';
const TOKEN = 'token-test-fuel-cotizador';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

const FUEL_NOVA = 28;
const FUEL_DHL = 41;
const FUEL_UPS = 39.5;

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const J = async (m, u, b) => {
    const r = await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  await J('PUT', '/api/configuracion/fuel/NOVA', { fuel_pct: FUEL_NOVA });
  await J('PUT', '/api/configuracion/fuel/DHL', { fuel_pct: FUEL_DHL });
  await J('PUT', '/api/configuracion/fuel/UPS', { fuel_pct: FUEL_UPS });

  const cliPropio = (await J('POST', '/api/clientes', { nombre: 'FUEL PROPIO COT', tarifa_pct: 60 })).body;
  await J('PUT', `/api/clientes/${cliPropio.id}`, { fuel_pct_propio: 12 });

  // Igual que en el resto de las tandas de pantalla: si el chromium de Playwright no
  // esta donde el paquete lo espera, se usa el que haya. Sin esto la tanda no corre en
  // el contenedor, que es justamente donde se verifica antes de entregar.
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
  await page.waitForSelector('#fuel_fuente');

  /* Llena el formulario mínimo para que la cotización salga. Un bulto, país conocido. */
  const cargarFormulario = async (clienteId = '') => {
    await page.selectOption('#pais', { label: 'Estados Unidos' }).catch(async () => {
      await page.selectOption('#pais', 'Estados Unidos');
    });
    await page.selectOption('#couriers', 'ambos');
    await page.fill('#valor', '0');
    if (clienteId) await page.selectOption('#cliente', String(clienteId));
    else await page.fill('#ganancia', '50');
    await page.fill('.bulto-row .b-peso', '10');
    await page.fill('.bulto-row .b-largo', '30');
    await page.fill('.bulto-row .b-ancho', '25');
    await page.fill('.bulto-row .b-alto', '20');
  };

  /* Lee las tarjetas: courier, el % que dice la fila de fuel, el monto de fuel y el
     subtotal. Con eso se puede controlar que la etiqueta y la plata coincidan. */
  const leerTarjetas = () => page.$$eval('.result-card', (cards) => cards.map((c) => {
    const num = (t) => Number(String(t).replace(/[^0-9.,-]/g, '').replace(/\./g, (m, i, s) =>
      (s.indexOf(',') > -1 ? '' : '.')).replace(',', '.')) || 0;
    const filas = [...c.querySelectorAll('.brow')];
    const fuelRow = filas.find((f) => /^Fuel \(/.test(f.querySelector('.bl').textContent.trim()));
    const subRow = filas.find((f) => /^Subtotal/.test(f.querySelector('.bl').textContent.trim()));
    const totRow = filas.find((f) => f.classList.contains('total-row'));
    const etiqueta = fuelRow ? fuelRow.querySelector('.bl').textContent.trim() : '';
    return {
      courier: c.querySelector('.result-courier').textContent.trim(),
      fuelPctEtiqueta: etiqueta ? parseFloat(etiqueta.replace('Fuel (', '').replace('%)', '')) : null,
      fuelMonto: fuelRow ? num(fuelRow.querySelector('.br').textContent) : null,
      subtotal: subRow ? num(subRow.querySelector('.br').textContent) : null,
      total: totRow ? num(totRow.querySelector('.br').textContent) : null,
      cuerpo: c.textContent,
    };
  }));

  const cotizar = async () => {
    await page.click('.btn-calc');
    await esperar(1200);
  };

  console.log('\n1. El predeterminado es Fuel Nova y sale de Configuración\n');

  check('el desplegable arranca en "Fuel Nova"',
    (await page.inputValue('#fuel_fuente')) === 'nova');
  check('el campo muestra el Fuel Nova de Configuración, no vacío',
    Number(await page.inputValue('#fuel')) === FUEL_NOVA, await page.inputValue('#fuel'));
  // El campo no se bloquea: escribir encima es una forma legítima de decir "quiero este
  // número", y es como la oficina lo viene usando. Lo que NO puede pasar es que quede
  // diciendo "Fuel Nova" mientras muestra otro número.
  await page.fill('#fuel', '33');
  check('escribir encima pasa la fuente a "A mano" sola',
    (await page.inputValue('#fuel_fuente')) === 'manual');
  check('y respeta el número tipeado', (await page.inputValue('#fuel')) === '33');
  await page.selectOption('#fuel_fuente', 'nova');
  check('al volver a Fuel Nova recupera el de Configuración',
    Number(await page.inputValue('#fuel')) === FUEL_NOVA, await page.inputValue('#fuel'));

  await cargarFormulario();
  await cotizar();
  let cards = await leerTarjetas();
  check('cotiza las tres tarjetas', cards.length === 3, String(cards.length));

  const dhl = () => cards.find((c) => /DHL/i.test(c.courier));
  const ups = () => cards.find((c) => /UPS/i.test(c.courier));

  check('DHL se cotiza con el Fuel Nova', dhl() && dhl().fuelPctEtiqueta === FUEL_NOVA,
    dhl() && String(dhl().fuelPctEtiqueta));
  check('UPS se cotiza con el MISMO Fuel Nova', ups() && ups().fuelPctEtiqueta === FUEL_NOVA,
    ups() && String(ups().fuelPctEtiqueta));

  // Lo que de verdad importa: que el porcentaje de la etiqueta sea el que se usó para la
  // plata. Una etiqueta que miente es peor que no tener etiqueta.
  for (const c of cards) {
    const esperado = c.subtotal * (FUEL_NOVA / 100);
    check(`el monto de fuel de ${c.courier} está calculado con ese ${FUEL_NOVA}%`,
      Math.abs(c.fuelMonto - esperado) < 0.02,
      `mostró ${c.fuelMonto} y con ${FUEL_NOVA}% sobre ${c.subtotal} da ${esperado.toFixed(2)}`);
  }

  console.log('\n2. "Fuel proveedor" le da a cada uno el suyo\n');

  await page.selectOption('#fuel_fuente', 'proveedor');
  await esperar(200);
  const hintProv = await page.textContent('#fuel-hint');
  check('la ayuda muestra los dos porcentajes antes de cotizar',
    hintProv.includes(String(FUEL_DHL)) && hintProv.includes(String(FUEL_UPS)), hintProv);

  await cotizar();
  cards = await leerTarjetas();
  check('DHL toma el fuel de DHL', dhl() && dhl().fuelPctEtiqueta === FUEL_DHL,
    dhl() && String(dhl().fuelPctEtiqueta));
  check('UPS toma el fuel de UPS', ups() && ups().fuelPctEtiqueta === FUEL_UPS,
    ups() && String(ups().fuelPctEtiqueta));
  check('y no son el mismo número', FUEL_DHL !== FUEL_UPS);
  for (const c of cards) {
    const pct = /DHL/i.test(c.courier) ? FUEL_DHL : FUEL_UPS;
    const esperado = c.subtotal * (pct / 100);
    check(`el monto de ${c.courier} está calculado con ${pct}%`,
      Math.abs(c.fuelMonto - esperado) < 0.02,
      `mostró ${c.fuelMonto}, esperaba ${esperado.toFixed(2)}`);
  }

  console.log('\n3. "A mano" respeta el número escrito\n');

  await page.selectOption('#fuel_fuente', 'manual');
  await esperar(200);
  await page.fill('#fuel', '7');
  check('la fuente queda en "A mano"', (await page.inputValue('#fuel_fuente')) === 'manual');
  await cotizar();
  cards = await leerTarjetas();
  check('los dos couriers usan el 7% escrito',
    cards.length === 3 && cards.every((c) => c.fuelPctEtiqueta === 7),
    cards.map((c) => c.fuelPctEtiqueta).join(' · '));

  console.log('\n4. Con el fuel sin cargar NO cotiza\n');

  await J('PUT', '/api/configuracion/fuel/NOVA', { fuel_pct: 0 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#fuel_fuente');
  await cargarFormulario();
  check('vuelve a arrancar en Fuel Nova', (await page.inputValue('#fuel_fuente')) === 'nova');
  await cotizar();
  const err = await page.textContent('#error-msg');
  const visible = await page.$eval('#error-msg', (e) => e.style.display !== 'none');
  check('avisa que falta cargarlo en Configuración',
    visible && /Configuraci/i.test(err), err);
  check('y NO devuelve ningún precio', (await page.$$('.result-card')).length === 0);

  // Con "A mano" sí puede cotizar aunque Configuración esté en cero: ahí la decisión de
  // quien cotiza es explícita.
  await page.selectOption('#fuel_fuente', 'manual');
  await page.fill('#fuel', '30');
  await cotizar();
  check('con "A mano" sí cotiza, aunque Configuración esté en cero',
    (await page.$$('.result-card')).length === 3);

  await J('PUT', '/api/configuracion/fuel/NOVA', { fuel_pct: FUEL_NOVA });

  console.log('\n5. Un cliente con fuel propio no pisa la elección en silencio\n');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#fuel_fuente');
  await cargarFormulario(cliPropio.id);
  await cotizar();
  cards = await leerTarjetas();
  check('se cotiza con el Fuel Nova elegido, no con el 12% del cliente',
    cards.length > 0 && cards.every((c) => c.fuelPctEtiqueta === FUEL_NOVA),
    cards.map((c) => c.fuelPctEtiqueta).join(' · '));
  const aviso = await page.textContent('#error-msg');
  check('pero la pantalla avisa que ese cliente tiene fuel propio',
    /fuel propio/i.test(aviso) && aviso.includes('12'), aviso);
  check('el aviso dice con qué porcentaje se cotizó',
    aviso.includes(String(FUEL_NOVA)), aviso);

  console.log('\n6. La pantalla no tira errores de javascript\n');
  check('sin errores en la consola', errores.length === 0, errores.join(' · '));

  await browser.close();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  matarSrv();
  await esperarSrvMuerto();
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
