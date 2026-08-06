#!/usr/bin/env node
/**
 * test-pantalla-cierre.js — el cierre de período desde la pantalla, en un navegador de verdad.
 *
 * El endpoint y el Excel los cubre test-cierre-periodo.js. Esto controla lo otro: que la
 * persona de administración pueda efectivamente hacerlo, que el archivo BAJE (no que el
 * servidor lo haya generado: que llegue a la carpeta de Descargas), y que quien no tiene
 * el permiso no vea el botón.
 *
 * Lo que más importa acá: que la descarga NO dependa de internet. El botón viejo de
 * "Exportar Excel" arma la planilla en el navegador con una librería que se baja de un
 * CDN en cada uso; el día que la oficina se queda sin internet, ese botón no hace nada.
 * El de Cierre lo arma el servidor. Por eso el test corre con el CDN bloqueado a
 * propósito: si en algún momento alguien vuelve a atar el cierre a una librería externa,
 * este test se cae.
 *
 *   cd backend && node scripts/test-pantalla-cierre.js
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.log('⚠ playwright no está instalado — se saltea (necesita navegador de verdad).');
  process.exit(0);
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');
const sqlite3 = require('sqlite3');
const { prepararDb, abrirSesion } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3967;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_cierre.db';
const TOKEN = 'token-test-pantalla-cierre';
const TOKEN_SIN = 'token-test-pantalla-cierre-sin';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

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
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);
  const esperarSrvMuerto = () => new Promise((res) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return res();
    srv.once('exit', res);
    setTimeout(res, 2000);
  });

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await esperar(300);
  }

  const uid = await abrirSesion(DB, TOKEN);
  await sql("UPDATE usuarios SET rol='empleado', cerrar_mes=1, ver_dashboard=1, usuario='marcela' WHERE id=?", [uid]);
  await sql("INSERT INTO usuarios (usuario, password_hash, rol, cerrar_mes, ver_dashboard, activo) VALUES ('pepe','x','empleado',0,1,1)");
  const [pepe] = await sql("SELECT id FROM usuarios WHERE usuario='pepe'");
  await sql('INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?,?,?)',
    [crypto.createHash('sha256').update(TOKEN_SIN).digest('hex'), pepe.id,
      new Date(Date.now() + 36e5).toISOString()]);

  const cli = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'CIERRE PANTALLA', tarifa_pct: 80 }),
  })).json();

  // Dos envíos en el mes pasado: es el mes que la pantalla va a proponer por defecto en
  // los primeros días, y el que administración cierra en la vida real.
  const hoy = new Date();
  const mesPasado = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 15);
  const p = (n) => String(n).padStart(2, '0');
  const fechaMesPasado = `${mesPasado.getFullYear()}-${p(mesPasado.getMonth() + 1)}-15`;
  const mesPasadoStr = fechaMesPasado.slice(0, 7);

  for (const g of ['1Z000PANTCIE00001', '1Z000PANTCIE00002']) {
    await fetch(BASE + '/api/envios', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        cliente_id: cli.id, fecha: fechaMesPasado, courier: 'UPS', tipo_envio: 'exportacion',
        numero_guia: g, pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
        peso_real: 4, largo: 30, ancho: 20, alto: 20,
      }),
    });
  }

  const descargas = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cierre-'));
  const browser = await chromium.launch();

  const nuevaPagina = async (token) => {
    const ctx = await browser.newContext({
      viewport: { width: 1500, height: 950 },
      acceptDownloads: true,
    });
    await ctx.addCookies([{ name: 'nova_session', value: token, url: BASE }]);
    // El CDN, cortado a propósito: el cierre NO puede depender de internet.
    await ctx.route('**cdn.jsdelivr.net**', (route) => route.abort());
    const page = await ctx.newPage();
    return { ctx, page };
  };

  const { page } = await nuevaPagina(TOKEN);
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|ERR_FAILED|Failed to load resource/.test(m.text())) {
      errores.push(m.text());
    }
  });

  console.log('\n1. El bloque de cierre está donde tiene que estar\n');

  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);

  check('se ve el bloque de Cierre', await page.isVisible('.cierre-box'));
  check('está el botón del mes', await page.isVisible('#btn-cierre-mes'));
  check('está el botón de la semana', await page.isVisible('#btn-cierre-semana'));
  check('el botón viejo de Exportar Excel sigue estando',
    await page.isVisible('#btn-exportar-excel'));

  const mesPropuesto = await page.inputValue('#cierre-mes');
  const esperado = hoy.getDate() <= 5
    ? mesPasadoStr
    : `${hoy.getFullYear()}-${p(hoy.getMonth() + 1)}`;
  check('propone el mes correcto sin que nadie lo toque', mesPropuesto === esperado,
    `propuso ${mesPropuesto}, se esperaba ${esperado}`);

  check('avisa que nunca se cerró un período',
    /nunca se cerró/.test(await page.textContent('#cierre-ultimo')),
    await page.textContent('#cierre-ultimo'));

  console.log('\n2. El archivo BAJA de verdad\n');

  await page.fill('#cierre-mes', mesPasadoStr);
  const [descarga] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#btn-cierre-mes'),
  ]);
  const nombre = descarga.suggestedFilename();
  check('el archivo se descarga', !!nombre, nombre);
  check('el nombre dice el mes', nombre.includes(mesPasadoStr), nombre);
  check('y empieza con Nova-salidas', /^Nova-salidas-/.test(nombre), nombre);

  const destino = path.join(descargas, nombre);
  await descarga.saveAs(destino);
  check('el archivo llegó al disco y pesa', fs.existsSync(destino) && fs.statSync(destino).size > 3000,
    fs.existsSync(destino) ? String(fs.statSync(destino).size) : 'no existe');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(destino);
  const ws = wb.getWorksheet('Salidas');
  check('el Excel descargado abre', !!ws);
  check('trae los 2 envíos del mes', /2 envío/.test(String(ws.getCell(4, 1).value)),
    String(ws.getCell(4, 1).value));
  check('dice quién lo bajó', /marcela/.test(String(ws.getCell(3, 1).value)),
    String(ws.getCell(3, 1).value));

  // Lo que este test viene a cuidar: el CDN estuvo bloqueado toda la corrida.
  check('el cierre funcionó SIN internet (el CDN estuvo bloqueado)', !!ws);

  console.log('\n3. Después de cerrar, la pantalla lo dice\n');

  await esperar(1500);
  const cartel = await page.textContent('#cierre-ultimo');
  check('el cartel pasa a mostrar el último cierre', /último/.test(cartel), cartel);
  check('con el mes y la cantidad de envíos',
    cartel.includes(mesPasadoStr) && /2 envíos/.test(cartel), cartel);
  check('y ya no está marcado como atrasado',
    !(await page.$eval('#cierre-ultimo', (e) => e.classList.contains('atrasado'))));

  console.log('\n4. Un período vacío avisa en vez de pasar desapercibido\n');

  await page.fill('#cierre-mes', '2019-03');
  const [vacio] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#btn-cierre-mes'),
  ]);
  check('igual descarga el archivo (un mes vacío es un dato)', !!vacio.suggestedFilename());
  await esperar(1200);
  const alerta = await page.textContent('body');
  check('pero avisa que salió SIN envíos', /SIN envíos/.test(alerta));

  console.log('\n5. Sin el permiso, el botón no está\n');

  const { page: page2 } = await nuevaPagina(TOKEN_SIN);
  await page2.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  check('un empleado sin cerrar_mes NO ve el bloque',
    !(await page2.isVisible('.cierre-box')));
  check('pero sí ve la pantalla de Salidas',
    await page2.isVisible('#btn-exportar-excel'));

  console.log('\n6. El permiso se puede dar desde Usuarios\n');

  // La pantalla de Usuarios es solo de admin (auth-guard saca a los demás). Hasta acá
  // marcela venía siendo empleada a propósito, para probar que el permiso suelto alcanza
  // para el cierre sin darle nada más. Para esta parte se la asciende.
  await sql("UPDATE usuarios SET rol='admin' WHERE id=?", [uid]);
  await page.goto(`${BASE}/pages/usuarios.html`);
  await esperar(2500);
  check('la pantalla de Usuarios cargó', page.url().includes('usuarios.html'), page.url());
  check('la tabla tiene la columna Cierre',
    /Cierre/.test(await page.textContent('thead')), await page.textContent('thead'));
  check('está la tilde en el alta de usuario', !!(await page.$('#u-cerrar-mes')));

  const tildePepe = await page.$(`input.cierre-check[data-id="${pepe.id}"]`);
  check('cada usuario tiene su tilde de cierre', !!tildePepe);
  check('pepe arranca sin el permiso', !(await tildePepe.isChecked()));
  await tildePepe.check();
  await esperar(1800);
  const [pepeDespues] = await sql('SELECT cerrar_mes FROM usuarios WHERE id=?', [pepe.id]);
  check('darle el permiso lo guarda en la base', Number(pepeDespues.cerrar_mes) === 1,
    String(pepeDespues.cerrar_mes));

  // Y que efectivamente le sirva: mismo usuario, sesión nueva, ahora sí lo ve.
  const { page: page3 } = await nuevaPagina(TOKEN_SIN);
  await page3.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  check('con el permiso recién dado, ahora sí ve el bloque',
    await page3.isVisible('.cierre-box'));

  console.log('\n7. Sin errores de JavaScript\n');
  check('ningún error en las pantallas', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await browser.close();
  fs.rmSync(descargas, { recursive: true, force: true });
  matarSrv();
  await esperarSrvMuerto();
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
