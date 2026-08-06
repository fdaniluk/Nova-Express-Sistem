#!/usr/bin/env node
/**
 * test-pantalla-salud.js — la pantalla del panel de salud, en un navegador de verdad.
 *
 * El servicio y sus 14 chequeos los cubre test-salud.js. Esto controla lo otro: que lo
 * que el backend detecta llegue efectivamente a los ojos de alguien. Un servicio
 * perfecto detrás de una pantalla que no pinta nada no le sirve a nadie.
 *
 * Lo que más importa acá es el punto 4: que la franja del Dashboard aparezca sola. El
 * panel entero existe para no tener que acordarse de entrar a mirarlo.
 *
 *   cd backend && npm run test-pantalla-salud
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.log('⚠ playwright no está instalado — se saltea (necesita navegador de verdad).');
  process.exit(0);
}

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT_TEST || 3988;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_salud.db';
const TOKEN = 'token-test-pantalla-salud';
const TOKEN_EMP = 'token-test-pantalla-salud-emp';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function fechaMas(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function main() {
  for (const f of [DB, DB + '-wal', DB + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);

  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  // Windows: llamar srv.kill() DOS VECES sobre el mismo handle revienta libuv con
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
  // Pasaba porque el cierre explícito mata el server y, acto seguido, process.exit() dispara
  // este mismo handler, que lo vuelve a matar cuando el handle ya se está cerrando. En Linux
  // no se notaba; en Windows cortaba el `npm test` entero a mitad de la cadena, sin que
  // ningún test hubiera fallado. El guard hace que solo la primera llamada tenga efecto.
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);
  // Matar al server NO es instantaneo: kill() manda la senal y el proceso hijo tarda en
  // morir. Si se llama process.exit() antes de que muera, Node se cae en Windows con
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src/win/async.c, line 94
  // porque el handle del hijo se esta cerrando cuando el proceso ya arranco a salir. No
  // falla ningun test: se muere Node y corta la cadena del `npm test` a la mitad. Esta
  // funcion espera al 'exit' del hijo (con tope de 2 s por si quedara colgado) para que el
  // handle este cerrado ANTES de salir.
  const esperarSrvMuerto = () => new Promise((res) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return res();
    srv.once('exit', res);
    setTimeout(res, 2000);
  });

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await esperar(300);
  }

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

  await q("INSERT INTO usuarios (id, usuario, password_hash, rol, ver_dashboard, editar_config, ver_salud) VALUES (1,'tester','x','admin',1,1,1)");
  await q("INSERT INTO usuarios (id, usuario, password_hash, rol, ver_dashboard, editar_config, ver_salud) VALUES (2,'empleado','x','empleado',1,0,0)");
  for (const [tok, uid] of [[TOKEN, 1], [TOKEN_EMP, 2]]) {
    await q('INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?,?,?)',
      [crypto.createHash('sha256').update(tok).digest('hex'), uid, new Date(Date.now() + 36e5).toISOString()]);
  }

  // Un problema rojo, plantado a propósito: un envío en dos liquidaciones.
  // Se saca antes el "Cliente Demo" que siembra schema.sql, para que el unico rojo de
  // la pantalla sea el que planta este test y las aserciones midan lo que dicen medir.
  await q("DELETE FROM clientes WHERE nombre = 'Cliente Demo'");
  await q("INSERT INTO clientes (id, nombre, tipo_cobro, activo, tarifa_pct) VALUES (1,'Cliente Uno','D',1,25)");
  await q(`INSERT INTO envios (id, cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, peso_real,
             total_cobrado, flete, seguro, fuel)
           VALUES (10, 1, ?, 'UPS', 'exportacion', '1ZDUPLICADO', 'US', 5, 500, 300, 20, 100)`, [fechaMas(-3)]);
  for (const [id, estado] of [[100, 'confirmada'], [101, 'borrador']]) {
    await q(`INSERT INTO liquidaciones (id, cliente_id, periodo_desde, periodo_hasta, fecha, total, estado)
             VALUES (?, 1, ?, ?, ?, 500, ?)`, [id, fechaMas(-10), fechaMas(-1), fechaMas(-3), estado]);
    await q('INSERT INTO liquidacion_items (liquidacion_id, envio_id, total_usd, fuel_pct_usado) VALUES (?, 10, 500, 32)', [id]);
  }
  // `db.close()` de sqlite3 NO es sincronico: encola el cierre en un hilo del pool y avisa
  // por un handle async de libuv. Si el proceso arranca a salir antes de que ese aviso
  // llegue, el hilo termina llamando uv_async_send sobre un handle que YA se esta cerrando
  // y en Windows eso revienta con:
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
  // No falla ningun test: se muere Node y corta la cadena del `npm test` a la mitad. En
  // Linux la carrera casi siempre sale bien y por eso no se veia. Esperar el callback del
  // close es la sincronizacion que faltaba.
  await new Promise((res) => db.close(() => res()));

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errores.push('console: ' + m.text()); });

  // ── 1. La pantalla abre y pinta el semáforo ─────────────────────────────────
  console.log('\n1. La pantalla abre y muestra el estado\n');

  await page.goto(`${BASE}/pages/salud.html`, { waitUntil: 'networkidle' });
  await esperar(1800);

  const tiles = await page.evaluate(() =>
    [...document.querySelectorAll('.salud-tile')].map((t) => t.className));
  check('el semáforo se pintó', tiles.length >= 2, tiles.join(' | '));
  check('hay al menos un contador en rojo', tiles.some((c) => c.includes('rojo')), tiles.join(' | '));

  const tarjetas = await page.evaluate(() => document.querySelectorAll('.chequeo').length);
  // 14 desde el 06/08/2026, cuando se sumo "cierres" (los meses archivados afuera).
  check('se listan los 14 chequeos', tarjetas === 14, String(tarjetas));

  const enVerde = await page.evaluate(() => document.querySelectorAll('.chequeo.ok').length);
  check('los chequeos en verde también se muestran', enVerde > 0, String(enVerde));

  // ── 2. El problema plantado se ve, con su detalle abierto ───────────────────
  // Arranca abierto a propósito: si hay que hacer un clic para ver qué pasa, no se hace.
  console.log('\n2. El problema aparece con el detalle a la vista\n');

  const abierto = await page.evaluate(() => {
    const c = document.querySelector('.chequeo.rojo');
    return c ? { abierto: c.classList.contains('abierto'), texto: c.textContent } : null;
  });
  check('el chequeo en rojo arranca abierto', !!abierto && abierto.abierto);
  check('se ve la guía del envío duplicado', !!abierto && /1ZDUPLICADO/.test(abierto.texto),
    (abierto ? abierto.texto : '').slice(0, 120));
  check('se ven las dos liquicaciones con su estado',
    !!abierto && /confirmada/.test(abierto.texto) && /borrador/.test(abierto.texto));

  const montoTxt = await page.evaluate(() => {
    const m = document.querySelector('.chequeo.rojo .chequeo-monto');
    return m ? m.textContent : null;
  });
  check('muestra la plata en juego con formato de moneda', /500/.test(montoTxt || ''), String(montoTxt));

  // ── 3. Cada alerta lleva a la pantalla donde se arregla ─────────────────────
  console.log('\n3. Cada alerta linkea a donde se resuelve\n');

  const link = await page.evaluate(() => {
    const a = document.querySelector('.chequeo.rojo .chequeo-acciones a');
    return a ? { href: a.getAttribute('href'), texto: a.textContent.trim() } : null;
  });
  check('el chequeo de liquidaciones linkea a Liquidaciones',
    !!link && link.href === 'liquidaciones.html', JSON.stringify(link));

  const sinLink = await page.evaluate(() =>
    [...document.querySelectorAll('.chequeo')].filter((c) =>
      !c.classList.contains('ok') && !c.querySelector('.chequeo-acciones')).map((c) =>
      c.dataset.id));
  // Backups y huérfanos no tienen pantalla donde arreglarse — son de infraestructura.
  check('solo backups y huérfanos quedan sin link',
    sinLink.every((id) => ['backups', 'huerfanos'].includes(id)), sinLink.join(', '));

  // ── 4. La franja del Dashboard aparece sola ─────────────────────────────────
  // Esto es lo que hace que el panel sirva: que avise sin que haya que acordarse.
  console.log('\n4. El Dashboard avisa solo\n');

  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await esperar(2000);

  const franja = await page.evaluate(() => {
    const f = document.getElementById('franja-salud');
    if (!f) return null;
    return { visible: !f.hidden, texto: f.textContent, href: f.getAttribute('href') };
  });
  check('la franja aparece en el Dashboard', !!franja && franja.visible, JSON.stringify(franja));
  check('nombra el problema concreto, no un genérico',
    !!franja && /liquidaci/i.test(franja.texto), (franja ? franja.texto : '').slice(0, 140));
  check('la franja linkea al panel', !!franja && franja.href === 'pages/salud.html');

  // ── 5. Sin problemas, la franja NO aparece ─────────────────────────────────
  // Un aviso permanente se vuelve paisaje y se deja de leer.
  console.log('\n5. Con todo en orden, la franja no molesta\n');

  const db2 = new sqlite3.Database(DB);
  const q2 = (sql, p = []) => new Promise((res, rej) => db2.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await q2('DELETE FROM liquidacion_items WHERE liquidacion_id = 101');
  // `db2.close()` de sqlite3 NO es sincronico: encola el cierre en un hilo del pool y avisa
  // por un handle async de libuv. Si el proceso arranca a salir antes de que ese aviso
  // llegue, el hilo termina llamando uv_async_send sobre un handle que YA se esta cerrando
  // y en Windows eso revienta con:
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
  // No falla ningun test: se muere Node y corta la cadena del `npm test` a la mitad. En
  // Linux la carrera casi siempre sale bien y por eso no se veia. Esperar el callback del
  // close es la sincronizacion que faltaba.
  await new Promise((res) => db2.close(() => res()));

  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await esperar(2000);
  const franja2 = await page.evaluate(() => {
    const f = document.getElementById('franja-salud');
    return f ? !f.hidden : null;
  });
  check('sin nada en rojo, la franja queda oculta', franja2 === false, String(franja2));

  // ── 6. El permiso ───────────────────────────────────────────────────────────
  console.log('\n6. Quién ve la pantalla\n');

  const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx2.addCookies([{ name: 'nova_session', value: TOKEN_EMP, url: BASE }]);
  const page2 = await ctx2.newPage();

  await page2.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await esperar(1500);
  const navOculta = await page2.evaluate(() => {
    const a = document.querySelector('a[href="pages/salud.html"].nav-item');
    return a ? a.style.display : 'no-existe';
  });
  check('el empleado sin permiso no ve "Salud" en el menú', navOculta === 'none', navOculta);

  await page2.goto(`${BASE}/pages/salud.html`, { waitUntil: 'networkidle' });
  await esperar(1500);
  check('si entra por URL, lo saca de la pantalla',
    !page2.url().includes('salud.html'), page2.url());

  // El admin sí la ve.
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await esperar(1500);
  const navVisible = await page.evaluate(() => {
    const a = document.querySelector('a[href="pages/salud.html"].nav-item');
    return a ? a.style.display : 'no-existe';
  });
  check('el admin sí ve "Salud" en el menú', navVisible === '', navVisible);

  // ── 7. Sin errores de JavaScript ────────────────────────────────────────────
  console.log('\n7. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|net::ERR|Failed to load resource/i.test(x));
  check('ningún error en las dos pantallas', rel.length === 0, rel.slice(0, 2).join(' | '));

  await browser.close();
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  // Ni siquiera acá se llama process.exit(): matar el proceso a mano es lo que venía
  // reventando en Windows. Se deja el código de salida y Node termina solo cuando no le
  // queda nada pendiente, que es cuando ya no hay ningún handle a medio cerrar.
  // El timer es la red de seguridad por si algo quedara vivo (sockets keep-alive de
  // fetch, por ejemplo): va con .unref(), así NO sostiene el proceso —si no hay nada
  // más, Node sale igual al instante— y solo actúa si a los 3 s todavía sigue en pie.
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
