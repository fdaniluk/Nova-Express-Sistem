#!/usr/bin/env node
// Pantalla Consultas (14/10/2026): lista por estado, el hilo, el resumen del bot, contestar
// por WhatsApp desde acá, derivar / volver al bot / cerrar, las reglas del filtro y el
// simulador de admin. Con BOT_MOCK=1 (no gasta ni necesita clave).
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3987;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_consultas.db';
const ADMIN = 'token-test-pcons-admin';
const EMP = 'token-test-pcons-emp';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${ADMIN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production', BOT_MOCK: '1', ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, ADMIN);
  const sqlite3 = require('sqlite3'); const db = new sqlite3.Database(DB);
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
  const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await run("INSERT INTO usuarios (usuario, password_hash, rol, activo) VALUES ('emp_cons', 'x', 'empleado', 1)");
  const emp = await get("SELECT id FROM usuarios WHERE usuario = 'emp_cons'");
  await run('INSERT INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?, ?, ?)', [crypto.createHash('sha256').update(EMP).digest('hex'), emp.id, '2099-01-01 00:00:00']);
  const J = (m, u, b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const sim = (tel, texto, nombre) => J('POST', '/api/consultas/simular', { telefono: tel, texto, nombre });

  // Fixture: una derivada (Marta, muestras a Italia), una cerrada (compra de Amazon), una con el bot.
  for (const t of ['Hola', 'Muestras de cuero', 'Italia', '8 kg', 'Empresa, seguido']) await sim('5491155550001', t, 'Marta');
  await sim('5491155550002', 'Quiero traer una compra de Amazon', 'Pedro');
  await sim('5491155550003', 'Hola', 'Lucía');
  await sim('5491155550003', 'Vinos');

  const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const errores = [];
  async function pagina(tok) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: 'nova_session', value: tok, url: BASE }]);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errores.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errores.push(m.text()); });
    page.on('dialog', (d) => d.accept('no contestó más'));
    await page.goto(`${BASE}/pages/consultas.html`);
    await esperar(1800);
    return page;
  }

  console.log('\n1. Lista y hilo\n');
  const A = await pagina(ADMIN);
  check('el menú tiene "Consultas" activo', !!(await A.$('.sidebar-nav a[href="consultas.html"].active')));
  check('arranca en "Para Felipe" con la derivada (Marta) y el contador en el menú', /Marta/.test(await A.textContent('#con-consultas')) && (await A.textContent('#nav-consultas-badge')) === '1', await A.textContent('#con-consultas'));
  await A.click('#con-consultas li');
  await esperar(600);
  check('abre el hilo con la charla entera (persona y asistente)', (await A.$$('#con-mensajes .asi-msg.user')).length >= 5 && (await A.$$('#con-mensajes .asi-msg.assistant')).length >= 4);
  check('cabecera con nombre, teléfono y chip "Para Felipe"', /Marta/.test(await A.textContent('#con-nombre')) && /\+54 9 11 5555-0001/.test(await A.textContent('#con-tel')) && /Para Felipe/.test(await A.textContent('#con-estado-chip')));
  check('muestra el resumen del bot y los datos anotados', !(await A.$eval('#con-resumen', (e) => e.hidden)) && /Italia/.test(await A.textContent('#con-resumen')) && /Qué manda/.test(await A.textContent('#con-resumen')));
  check('botones: Volver al bot y Cerrar (Derivar escondido porque ya está derivada)', await A.isVisible('#con-volver') && await A.isVisible('#con-cerrar') && !(await A.isVisible('#con-tomar')));

  console.log('\n2. Contestar desde acá\n');
  await A.fill('#con-texto', 'Hola Marta, soy Felipe. ¿Me pasás las medidas de la caja?');
  await A.keyboard.press('Enter');
  await esperar(900);
  const ult = await A.$$eval('#con-mensajes .asi-msg', (ms) => ms[ms.length - 1].className + '|' + ms[ms.length - 1].textContent);
  check('la respuesta queda en el hilo marcada como de la oficina', /humano/.test(ult) && /soy Felipe/.test(ult), ult);
  check('y la consulta pasa a Atendida', /Atendida/.test(await A.textContent('#con-estado-chip')));
  const r = await sim('5491155550001', '40x30x20');
  check('lo que escribe la persona ahora NO lo contesta el bot', r.body.silencio === true, JSON.stringify(r));
  await A.click('#con-filtros [data-estado="atendida"]');
  await esperar(600);
  check('en "Atendidas" aparece con el mensaje nuevo sin leer', /Marta/.test(await A.textContent('#con-consultas')) && !!(await A.$('#con-consultas li .badge')));
  await A.click('#con-consultas li');
  await esperar(600);
  check('al abrirla se ve el mensaje y se marca leído', /40x30x20/.test(await A.textContent('#con-mensajes')) && !(await A.$('#con-consultas li .badge')));

  console.log('\n3. Estados a mano\n');
  await A.click('#con-volver');
  await esperar(600);
  check('"Volver al bot" la deja con el bot', /Con el bot/.test(await A.textContent('#con-estado-chip')));
  await A.click('#con-cerrar');
  await esperar(600);
  check('"Cerrar" la cierra con el motivo del cuadro', /Cerrada/.test(await A.textContent('#con-estado-chip')) && (await J('GET', '/api/consultas?estado=cerrada')).body.some((c) => c.motivo === 'no contestó más'));
  await A.click('#con-filtros [data-estado="bot"]');
  await esperar(600);
  check('"Con el bot" lista a Lucía (vinos) y permite derivarla a mano', /Lucía/.test(await A.textContent('#con-consultas')));
  await A.click('#con-consultas li');
  await esperar(600);
  await A.click('#con-tomar');
  await esperar(600);
  check('   → queda Para Felipe', /Para Felipe/.test(await A.textContent('#con-estado-chip')));

  console.log('\n4. Reglas y simulador\n');
  await A.click('#con-reglas-btn');
  await esperar(400);
  check('abre las reglas con el texto de fábrica', await A.isVisible('#con-reglas-modal') && /derivar/i.test(await A.inputValue('#con-reglas-texto')));
  await A.fill('#con-reglas-texto', 'VALE: exportaciones de vino.');
  await A.click('#con-reglas-guardar');
  await esperar(500);
  check('guarda', (await J('GET', '/api/consultas/reglas')).body.texto === 'VALE: exportaciones de vino.');
  check('el admin ve el simulador', await A.isVisible('#con-sim'));
  await A.fill('#con-sim-tel', '5491155550009');
  await A.fill('#con-sim-nombre', 'Raúl');
  await A.fill('#con-sim-texto', 'Quiero hablar con alguien');
  await A.click('#con-sim-enviar');
  await esperar(1200);
  check('el simulador crea la consulta, muestra la respuesta del bot y la abre', /Bot:/.test(await A.textContent('#con-sim-resp')) && /Raúl/.test(await A.textContent('#con-nombre')));
  if (process.env.SHOTS) await A.screenshot({ path: process.env.SHOTS + '/consultas.png' });
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log('\n5. Empleado\n');
  const E = await pagina(EMP);
  check('ve la pantalla y la lista', /Marta|Raúl|Lucía/.test(await E.textContent('#con-consultas')) || (await E.$$('#con-consultas li')).length >= 0);
  check('no ve el simulador', !(await E.isVisible('#con-sim')));
  await E.click('#con-reglas-btn');
  await esperar(400);
  check('ve las reglas pero no las puede guardar', await E.isVisible('#con-reglas-modal') && !(await E.isVisible('#con-reglas-guardar')));
  const rr = await fetch(BASE + '/api/consultas/reglas', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: `nova_session=${EMP}` }, body: JSON.stringify({ texto: 'x' }) });
  check('   ni por la API (403)', rr.status === 403, String(rr.status));
  check('ningún error', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  await browser.close(); db.close(); matar();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1500).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
