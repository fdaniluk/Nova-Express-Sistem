#!/usr/bin/env node
// Pickups (06/10/2026): "horario a confirmar" y segunda franja horaria.
//   · API: crear sin hora con horario_pendiente=1; dos franjas; validaciones.
//   · Pantalla: el modal, la tarjeta del día, la vista semana, el detalle y Operaciones.
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3969;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_pickups_horario.db';
const TOKEN = 'token-test-pick-hor';
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

(async () => {
  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  const hoy = new Date();
  const lunes = new Date(hoy); lunes.setDate(hoy.getDate() + ((8 - hoy.getDay()) % 7 || 7));
  const fecha = iso(lunes);
  const cli = (await J('POST', '/clientes', { nombre: 'HORARIOS SA', tarifa_pct: 75, tipo_cobro: 'CC' })).body;

  console.log('\n1. API\n');
  let r = await J('POST', '/pickups', { cliente_id: cli.id, direccion: 'Calle 1', fecha });
  check('sin hora y sin la marca → 400 con mensaje claro', r.status === 400 && /horario a confirmar/.test(r.body.error), JSON.stringify(r.body));
  r = await J('POST', '/pickups', { cliente_id: cli.id, direccion: 'Calle 1', fecha, horario_pendiente: 1 });
  check('con "horario a confirmar" se crea sin hora', r.status === 201 && r.body.horario_pendiente === 1 && !r.body.hora_inicio, JSON.stringify(r.body).slice(0, 150));
  const pend = r.body;
  r = await J('POST', '/pickups', { cliente_id: cli.id, direccion: 'Calle 2', fecha, hora_inicio: '09:00', hora_fin: '12:00', hora2_inicio: '14:00', hora2_fin: '17:00' });
  check('dos franjas se guardan', r.status === 201 && r.body.hora2_inicio === '14:00' && r.body.hora2_fin === '17:00' && r.body.horario_pendiente === 0, JSON.stringify(r.body).slice(0, 150));
  const dos = r.body;
  r = await J('POST', '/pickups', { cliente_id: cli.id, direccion: 'Calle 3', fecha, hora_inicio: '09:00', hora_fin: '12:00', hora2_inicio: '11:00', hora2_fin: '13:00' });
  check('segunda franja que pisa la primera → 400', r.status === 400 && /después de que termine la primera/.test(r.body.error), JSON.stringify(r.body));
  r = await J('POST', '/pickups', { cliente_id: cli.id, direccion: 'Calle 3', fecha, hora_inicio: '09:00', hora_fin: '12:00', hora2_inicio: '14:00' });
  check('segunda franja incompleta → 400', r.status === 400 && /segunda franja/.test(r.body.error));
  r = await J('PUT', `/pickups/${pend.id}`, { horario_pendiente: 0, hora_inicio: '10:00', hora_fin: '11:00' });
  check('confirmar el horario por PUT saca la marca y guarda la hora', r.status === 200 && r.body.horario_pendiente === 0 && r.body.hora_inicio === '10:00', JSON.stringify(r.body).slice(0, 150));
  r = await J('PUT', `/pickups/${pend.id}`, { horario_pendiente: 1 });
  check('volver a "a confirmar" limpia las horas', r.status === 200 && r.body.horario_pendiente === 1 && !r.body.hora_inicio);
  const lista = (await J('GET', `/pickups?desde=${fecha}&hasta=${fecha}`)).body;
  check('el listado pone el "a confirmar" al final del día', lista.length === 2 && lista[0].id === dos.id && lista[1].id === pend.id, lista.map((p) => p.id).join(','));
  const ops = (await J('GET', `/operaciones?fecha=${fecha}`)).body;
  check('Operaciones devuelve los campos nuevos', JSON.stringify(ops).includes('"horario_pendiente"') && JSON.stringify(ops).includes('"hora2_inicio"'), JSON.stringify(ops).slice(0, 200));

  console.log('\n2. Pantalla\n');
  const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(`${BASE}/pages/pickups.html`);
  await esperar(2500);
  let pill = await page.$(`.day-pill[data-ymd="${fecha}"]`);
  for (let i = 0; i < 2 && !pill; i++) { await page.click('#btn-next-week'); await esperar(1000); pill = await page.$(`.day-pill[data-ymd="${fecha}"]`); }
  if (pill) { await pill.click(); await esperar(800); }
  let txt = await page.textContent('body');
  check('la tarjeta del día muestra "⏳ A confirmar"', /A confirmar/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 200));
  check('y las dos franjas "09:00 – 12:00 · 14:00 – 17:00"', /09:00 – 12:00 · 14:00 – 17:00/.test(txt));

  await page.$eval(`[data-action="detalle"][data-id="${pend.id}"]`, (el) => el.click());
  await esperar(800);
  const det = await page.textContent('#detalle-hora').catch(() => '');
  check('el detalle del pickup dice "A confirmar"', /A confirmar/.test(det), det);

  await page.click('#detalle-close');
  await esperar(400);
  // Modal nuevo: marcar "a confirmar" apaga las horas; "+ franja" abre la segunda.
  await page.click('#btn-nuevo-pickup');
  await esperar(500);
  await page.check('#m-horario-pendiente');
  await esperar(200);
  check('marcar "horario a confirmar" deshabilita las horas', await page.$eval('#m-hora-inicio', (i) => i.disabled));
  await page.uncheck('#m-horario-pendiente');
  await page.click('#m-hora2-add');
  await esperar(200);
  check('"+ franja" muestra la segunda franja', await page.isVisible('#m-hora-row-2'));
  await page.selectOption('#m-cliente', String(cli.id));
  await esperar(500);
  await page.fill('#m-direccion', 'Calle 9');
  await page.fill('#m-fecha', fecha);
  await page.fill('#m-hora-inicio', '08:00'); await page.fill('#m-hora-fin', '10:00');
  await page.fill('#m-hora2-inicio', '15:00'); await page.fill('#m-hora2-fin', '18:00');
  await page.click('#btn-modal-guardar');
  await esperar(1500);
  const creado = (await J('GET', `/pickups?desde=${fecha}&hasta=${fecha}`)).body.find((p) => p.direccion === 'Calle 9');
  check('guardado desde el modal con las dos franjas', !!creado && creado.hora2_inicio === '15:00' && creado.hora2_fin === '18:00', JSON.stringify(creado || {}).slice(0, 150));

  await page.click('#btn-vista-semana');
  await esperar(800);
  const sem = await page.textContent('#semana-list');
  check('vista semana: "A confirmar" y "08:00 / 15:00"', /A confirmar/.test(sem) && /08:00 \/ 15:00/.test(sem), sem.replace(/\s+/g, ' ').slice(0, 200));
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  await browser.close(); matar();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1500).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
