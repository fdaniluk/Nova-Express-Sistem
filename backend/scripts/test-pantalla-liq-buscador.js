#!/usr/bin/env node
/**
 * test-pantalla-liq-buscador.js — el buscador por cliente de "Envíos sin liquidar"
 * (15/09/2026), en un navegador de verdad.
 *
 * Pedido de Felipe: *"agregame en la parte de las liquidaciones un buscador por cliente,
 * que si bien ya lo tenemos organizado por orden alfabético, no estaría de más un buscador
 * como el del módulo de clientes"*.
 *
 * QUÉ CUIDA, en orden de riesgo:
 *
 *  1. QUE FILTRAR NO SE COMA NINGÚN CLIENTE. Un buscador que esconde de más en la pantalla
 *     de lo que falta cobrar es plata que se pasa de largo: se controla que al vaciar el
 *     campo vuelvan TODOS, y que el contador diga siempre cuántos hay de cuántos.
 *  2. QUE EL BOTÓN "LIQUIDAR" SIGA LLEVANDO AL CLIENTE CORRECTO con el buscador puesto —
 *     el grupo se busca en la lista entera, no en lo que quedó a la vista.
 *  3. Que filtre sin tildes ni mayúsculas y con varias palabras sueltas, igual que el
 *     buscador de Clientes.
 *  4. Que NO vuelva a pedirle los datos al servidor (si lo hiciera, se perderían los
 *     filtros de fecha / courier / tipo de cobro de arriba).
 *
 *   cd backend && node scripts/test-pantalla-liq-buscador.js
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

const PORT = process.env.PORT_TEST || 3923;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_liq_buscador.db';
const TOKEN = 'token-test-liq-buscador';

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
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const hoy = require('../src/utils/fecha').hoyLocal();

  /* Cuatro clientes elegidos para que el buscador tenga con qué equivocarse:
     · PÉREZ lleva tilde (hay que encontrarlo tipeando "perez");
     · MARTINEZ y MARTINEZ HNOS empiezan igual (una búsqueda tiene que traer los dos);
     · GONZALEZ no se parece a ninguno. */
  const NOMBRES = ['PÉREZ S.A.', 'MARTINEZ SRL', 'MARTINEZ HNOS', 'GONZALEZ Y CIA'];
  const clientes = [];
  for (const nombre of NOMBRES) {
    clientes.push(await (await fetch(BASE + '/api/clientes', {
      method: 'POST', headers: H, body: JSON.stringify({ nombre, tarifa_pct: 60, tipo_cobro: 'CC' }),
    })).json());
  }
  let g = 0;
  for (const c of clientes) {
    await fetch(BASE + '/api/envios', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        cliente_id: c.id, fecha: hoy, courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion',
        numero_guia: `1Z700AA1012345000${g++}`, pais_destino: 'Brasil',
        peso_real: 4, largo: 30, ancho: 20, alto: 20, fob: 100, total_cobrado: 150 + g,
      }),
    });
  }
  check('(fixture) los 4 clientes con envío sin liquidar existen', clientes.every((c) => c.id));

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  // Cada llamada a la lista de pendientes queda anotada: así se comprueba que escribir en el
  // buscador NO le pide nada al servidor.
  let llamadasPendientes = 0;
  page.on('request', (r) => { if (/\/api\/liquidaciones\/pendientes/.test(r.url())) llamadasPendientes++; });

  await page.goto(BASE + '/pages/liquidaciones.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('#pendientes-list .cliente-grupo', { timeout: 15000 });
  await esperar(400);

  const visibles = () => page.$$eval('#pendientes-list .cliente-grupo strong', (ns) => ns.map((n) => n.textContent.trim()));
  const cuenta = () => page.textContent('#buscador-pendientes-cuenta').then((t) => (t || '').trim());
  const buscar = async (txt) => { await page.fill('#buscador-pendientes', txt); await esperar(250); };

  // ── 1 ──────────────────────────────────────────────────────────────────────────────
  console.log('\n1. Arranca mostrando todo\n');
  check('el buscador está en la pantalla', !!(await page.$('#buscador-pendientes')));
  check('se ven los 4 clientes', (await visibles()).length === 4, (await visibles()).join(' | '));
  check('   y el contador dice cuántos hay', /4 cliente/.test(await cuenta()), await cuenta());
  const llamadasAlCargar = llamadasPendientes;

  // ── 2 ──────────────────────────────────────────────────────────────────────────────
  console.log('\n2. Filtrar mientras se escribe\n');
  await buscar('gonzalez');
  let v = await visibles();
  check('deja solo el que coincide', v.length === 1 && /GONZALEZ/.test(v[0]), v.join(' | '));
  check('   y el contador dice 1 de 4', (await cuenta()) === '1 de 4', await cuenta());

  await buscar('martinez');
  v = await visibles();
  check('un apellido repetido trae a los dos', v.length === 2 && v.every((x) => /MARTINEZ/.test(x)), v.join(' | '));

  await buscar('perez');
  v = await visibles();
  check('sin tilde encuentra a PÉREZ (igual que en Clientes)', v.length === 1 && /PÉREZ/.test(v[0]), v.join(' | '));

  await buscar('MARTINEZ hnos');
  v = await visibles();
  check('dos palabras sueltas afinan la búsqueda', v.length === 1 && /HNOS/.test(v[0]), v.join(' | '));

  await buscar('1Z700AA10123450000');
  v = await visibles();
  check('también encuentra por número de guía', v.length === 1, v.join(' | '));

  await buscar('zzzz');
  check('sin coincidencias lo dice, no deja la lista muda',
    /Ningún cliente coincide/.test(await page.textContent('#pendientes-list')),
    (await page.textContent('#pendientes-list')).slice(0, 80));

  // ── 3 ──────────────────────────────────────────────────────────────────────────────
  console.log('\n3. Vaciar el campo devuelve TODO (lo que no se ve, no se cobra)\n');
  await buscar('');
  check('vuelven los 4', (await visibles()).length === 4, (await visibles()).join(' | '));
  await buscar('martinez');
  await page.press('#buscador-pendientes', 'Escape');
  await esperar(250);
  check('Escape también limpia', (await visibles()).length === 4 && (await page.inputValue('#buscador-pendientes')) === '');
  check('   y el foco no se va del campo',
    await page.evaluate(() => document.activeElement && document.activeElement.id === 'buscador-pendientes'));

  // ── 4 ──────────────────────────────────────────────────────────────────────────────
  console.log('\n4. No le vuelve a pedir nada al servidor\n');
  check('escribir no dispara pedidos a /pendientes', llamadasPendientes === llamadasAlCargar,
    `${llamadasAlCargar} al cargar · ${llamadasPendientes} ahora`);
  // Y los filtros de arriba siguen funcionando como siempre (esos SÍ piden al servidor).
  await page.selectOption('#pend-courier', 'DHL');
  await page.click('#btn-pend-filtrar');
  await esperar(900);
  check('el filtro de courier sí consulta al servidor', llamadasPendientes > llamadasAlCargar);
  check('   y sin envíos DHL la lista queda vacía con su mensaje',
    /No hay envíos pendientes/.test(await page.textContent('#pendientes-list')));
  await page.selectOption('#pend-courier', '');
  await page.click('#btn-pend-filtrar');
  await esperar(900);
  check('   al sacarlo vuelven los 4', (await visibles()).length === 4);

  // ── 5 ──────────────────────────────────────────────────────────────────────────────
  console.log('\n5. "Liquidar" sigue llevando al cliente correcto con el buscador puesto\n');
  await buscar('hnos');
  const objetivo = clientes.find((c) => c.nombre === 'MARTINEZ HNOS');
  await page.click('#pendientes-list .cliente-grupo button[data-liq-cliente]');
  await esperar(1200);
  check('salta a la solapa Crear', !(await page.$eval('#panel-crear', (e) => e.classList.contains('hidden'))));
  check('   con ESE cliente elegido (no el primero de la lista)',
    (await page.inputValue('#liq-cliente')) === String(objetivo.id),
    `elegido ${await page.inputValue('#liq-cliente')} · esperado ${objetivo.id}`);
  check('   y con la fecha "desde" del envío más viejo del grupo',
    (await page.inputValue('#liq-desde')) === hoy, await page.inputValue('#liq-desde'));

  // ── 6 ──────────────────────────────────────────────────────────────────────────────
  console.log('\n6. Sin errores de JavaScript\n');
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
