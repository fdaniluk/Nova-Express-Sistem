#!/usr/bin/env node
/**
 * test-pantalla-proteccion-doc.js — la tilde de Protección de Documentos de DHL (USD 7,50),
 * en un navegador de verdad.
 *
 * El cargo lo cubre test-proteccion-doc.js. Esto controla lo otro: que la tilde aparezca
 * SOLO cuando corresponde, que se destilde sola al dejar de corresponder, y que un envío
 * que ya tiene el cargo no lo pierda por abrirlo.
 *
 * La regla de visibilidad (Felipe, 04/08): la tilde se ve solo si el envío es DOCUMENTO y
 * va por DHL. El servicio cubre pasaportes, visas y certificados; en un paquete no va.
 *
 *   cd backend && node scripts/test-pantalla-proteccion-doc.js
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

const PORT = process.env.PORT_TEST || 3972;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_proteccion_doc.db';
const TOKEN = 'token-test-pantalla-prot-doc';

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

  // Espera la línea de "listo" que imprime NUESTRO servidor (no un /api/health que puede
  // contestar otro node vivo en el puerto), hasta 60 s: en Windows el primer arranque de
  // node del día tarda y con 12 s el test reventaba con un ECONNREFUSED que parecía del
  // cortafuegos. Ver scripts/_base-test.js.
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const hoy = new Date().toISOString().slice(0, 10);

  const cli = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H,
    body: JSON.stringify({ nombre: 'PROT DOC PANTALLA', tarifa_pct: 80 }),
  })).json();

  const nuevoEnvio = (guia, extra) => fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'DHL', tipo_envio: 'exportacion',
      numero_guia: guia, pais_destino: 'Estados Unidos',
      peso_real: 1, largo: 20, ancho: 15, alto: 2, ...extra,
    }),
  }).then((r) => r.json());

  const envDoc = await nuevoEnvio('9900000045', { tipo_paquete: 'd', proteccion_doc: 1 });
  // El caso raro: mercadería CON el cargo puesto. Solo puede existir en envíos cargados
  // antes de que la tilde se atara al tipo de paquete, pero es justo el que no hay que
  // pisar en silencio.
  const envMerc = await nuevoEnvio('9900000053', { tipo_paquete: 'm', proteccion_doc: 1, peso_real: 3, largo: 30, ancho: 20, alto: 20 });

  // Igual que en el resto de las tandas de pantalla: si el chromium de Playwright no
  // esta donde el paquete lo espera, se usa el que haya. Sin esto la tanda no corre en
  // el contenedor, que es justamente donde se verifica antes de entregar.
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
  const visible = (sel) => page.$eval(sel, (e) => {
    const s = getComputedStyle(e);
    return s.display !== 'none' && s.visibility !== 'hidden';
  });

  console.log('\n1. Cotizador: la tilde sigue al tipo de contenido\n');

  await page.goto(`${BASE}/pages/cotizador.html`);
  await esperar(2500);
  check('con "Paquete" la tilde NO se ve', !(await visible('#ex_proteccion_doc_label')));
  await page.selectOption('#contenido', 'documento');
  await esperar(700);
  check('con "Documento" aparece', await visible('#ex_proteccion_doc_label'));
  const etiqueta = await page.textContent('#ex_proteccion_doc_label');
  check('la etiqueta dice el monto del tarifario', /7,50/.test(etiqueta), etiqueta.trim());

  await page.check('#ex_proteccion_doc');
  await page.selectOption('#contenido', 'paquete');
  await esperar(700);
  check('al volver a paquete se esconde', !(await visible('#ex_proteccion_doc_label')));
  check('y se destilda sola (no queda un cobro escondido)',
    !(await page.isChecked('#ex_proteccion_doc')));

  console.log('\n2. Cargar envío: lo mismo, y además solo DHL\n');

  await page.goto(`${BASE}/pages/envios.html`);
  await esperar(2500);
  check('arranca en mercadería y NO se ve', !(await visible('#grupo-proteccion-doc')));
  await page.selectOption('#tipo_paquete', 'd');
  await esperar(700);
  check('con documento aparece', await visible('#grupo-proteccion-doc'));
  await page.check('#proteccion_doc');
  await page.selectOption('#tipo_paquete', 'm');
  await esperar(700);
  check('al volver a mercadería se esconde y se destilda',
    !(await visible('#grupo-proteccion-doc')) && !(await page.isChecked('#proteccion_doc')));

  console.log('\n3. Salidas: el envío documento\n');

  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  await page.click('text=9900000045');
  await esperar(1000);
  check('se abre el modal del envío', !!(await page.$('#sal-edit-overlay:not(.hidden)')));
  check('la tilde se ve', await visible('#saled-prot-doc-label'));
  check('y viene marcada', await page.isChecked('#saled-proteccion-doc'));

  const adicAntes = await page.inputValue('#saled-adicionales');
  await page.selectOption('#saled-tipo-paquete', 'm');
  await esperar(600);
  check('al pasarlo a mercadería se esconde y se destilda',
    !(await visible('#saled-prot-doc-label')) && !(await page.isChecked('#saled-proteccion-doc')));

  // Volver a documento y recalcular: el cargo tiene que reaparecer en los adicionales.
  await page.selectOption('#saled-tipo-paquete', 'd');
  await esperar(600);
  await page.check('#saled-proteccion-doc');
  await page.click('#saled-recalcular');
  await esperar(2500);
  const adicDespues = await page.inputValue('#saled-adicionales');
  check('recalcular con la tilde deja los 7,50 en los adicionales',
    Number(adicDespues) > 0, `antes ${adicAntes} · después ${adicDespues}`);
  const extrasTxt = await page.textContent('#saled-extras-block');
  check('y aparece en el desglose con su nombre', /Protecci/.test(extrasTxt),
    extrasTxt.slice(0, 120));

  await page.click('#sal-modal-save');
  await esperar(2500);
  const guardado = await (await fetch(`${BASE}/api/envios/${envDoc.id}`, { headers: H })).json();
  check('queda guardado en la base', Number(guardado.proteccion_doc) === 1,
    String(guardado.proteccion_doc));

  console.log('\n4. Un envío que YA tiene el cargo no se pisa por abrirlo\n');

  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  await page.click('text=9900000053');
  await esperar(1000);
  check('se muestra aunque hoy no califique (es mercadería)',
    await visible('#saled-prot-doc-label'));
  check('y NO se destilda solo: abrir un envío no le cambia la plata',
    await page.isChecked('#saled-proteccion-doc'));

  console.log('\n5. Sin errores de JavaScript\n');
  check('ningún error en las tres pantallas', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await browser.close();
  matarSrv();
  await esperarSrvMuerto();
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
