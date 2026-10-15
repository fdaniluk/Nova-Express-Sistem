#!/usr/bin/env node
// Pickups (15/10/2026): orden a mano dentro del día, arrastrando la tarjeta.
//   · API: PATCH /pickups/:id/orden; el listado respeta la posición; cambiar la hora lo
//     devuelve al orden por horario; las demás tarjetas siguen por horario.
//   · Pantalla: arrastrar una tarjeta arriba de otra la deja ahí (📌) y el 📌 la devuelve.
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3971;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_pickups_orden.db';
const TOKEN = 'token-test-pick-ord';
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
  const cli = (await J('POST', '/clientes', { nombre: 'ORDEN SA', tarifa_pct: 75, tipo_cobro: 'CC' })).body;
  const crear = async (dir, hi, hf) => (await J('POST', '/pickups', { cliente_id: cli.id, direccion: dir, fecha, hora_inicio: hi, hora_fin: hf, mostrar_en_operaciones: 1 })).body;
  const a = await crear('Nueve', '09:00', '10:00');
  const b = await crear('Once', '11:00', '12:00');
  const c = await crear('Catorce', '14:00', '15:00');
  const pend = (await J('POST', '/pickups', { cliente_id: cli.id, direccion: 'Pendiente', fecha, horario_pendiente: 1, mostrar_en_operaciones: 1 })).body;
  const ids = async () => (await J('GET', `/pickups?desde=${fecha}&hasta=${fecha}`)).body.map((p) => p.id);

  console.log('\n1. API\n');
  check('de entrada el orden es por horario, el "a confirmar" al final', (await ids()).join() === [a.id, b.id, c.id, pend.id].join(), (await ids()).join());
  let r = await J('PATCH', `/pickups/${c.id}/orden`, { orden_manual: 600 });
  check('PATCH /orden guarda la posición', r.status === 200 && r.body.orden_manual === 600, JSON.stringify(r.body).slice(0, 120));
  check('el de las 14 con posición 600 (entre 9:00=540 y 11:00=660) queda segundo', (await ids()).join() === [a.id, c.id, b.id, pend.id].join(), (await ids()).join());
  const d = await crear('Diez', '10:00', '11:00');
  check('un pickup nuevo de las 10 se acomoda solo por su hora (antes del movido)', (await ids()).join() === [a.id, d.id, c.id, b.id, pend.id].join(), (await ids()).join());
  r = await J('PUT', `/pickups/${c.id}`, { notas: 'sin tocar la hora' });
  check('editar otra cosa del pickup conserva el orden a mano', r.body.orden_manual === 600, JSON.stringify(r.body.orden_manual));
  r = await J('PUT', `/pickups/${c.id}`, { hora_inicio: '15:00', hora_fin: '16:00' });
  check('cambiarle la hora lo devuelve al orden por horario', r.body.orden_manual === null && (await ids()).join() === [a.id, d.id, b.id, c.id, pend.id].join(), (await ids()).join());
  r = await J('PATCH', `/pickups/${c.id}/orden`, { orden_manual: 'x' });
  check('posición inválida → 400', r.status === 400);
  r = await J('PATCH', `/pickups/99999/orden`, { orden_manual: 1 });
  check('pickup inexistente → 404', r.status === 404);
  r = await J('PATCH', `/pickups/${pend.id}/orden`, { orden_manual: 539 });
  check('el "a confirmar" también se puede subir a mano (primero)', (await ids())[0] === pend.id, (await ids()).join());
  await J('PATCH', `/pickups/${pend.id}/orden`, { orden_manual: null });
  check('y con null vuelve al final', (await ids()).slice(-1)[0] === pend.id);
  await J('PATCH', `/pickups/${c.id}/orden`, { orden_manual: 600 });
  const ops = (await J('GET', `/operaciones?fecha=${fecha}`)).body;
  const opsIds = (ops.pickups || []).map((p) => p.id);
  check('Operaciones respeta el mismo orden a mano', opsIds.join() === (await ids()).join(), JSON.stringify(opsIds));
  await J('PATCH', `/pickups/${c.id}/orden`, { orden_manual: null });

  console.log('\n2. Pantalla: arrastrar\n');
  const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text()); });
  page.on('dialog', (dlg) => dlg.accept());
  await page.goto(`${BASE}/pages/pickups.html`);
  await esperar(2500);
  let pill = await page.$(`.day-pill[data-ymd="${fecha}"]`);
  for (let i = 0; i < 2 && !pill; i++) { await page.click('#btn-next-week'); await esperar(1000); pill = await page.$(`.day-pill[data-ymd="${fecha}"]`); }
  if (pill) { await pill.click(); await esperar(800); }
  const ordenPantalla = () => page.$$eval('#pickups-dia-list .pickup-card-v2', (cs) => cs.map((x) => Number(x.id.replace('pickup-card-', ''))));
  check('la pantalla muestra el día en el orden del servidor', (await ordenPantalla()).join() === [a.id, d.id, b.id, c.id, pend.id].join(), (await ordenPantalla()).join());
  check('las tarjetas se pueden arrastrar', await page.$eval(`#pickup-card-${c.id}`, (el) => el.getAttribute('draggable')) === 'true');
  // Arrastrar el de las 15 (último con hora) arriba del de las 10 (segundo).
  await page.dragAndDrop(`#pickup-card-${c.id}`, `#pickup-card-${d.id}`, { targetPosition: { x: 200, y: 8 } });
  await esperar(1200);
  let ord = await ordenPantalla();
  check('soltarlo arriba del segundo lo deja segundo', ord.join() === [a.id, c.id, d.id, b.id, pend.id].join(), ord.join());
  check('   y el servidor lo guardó (posición entre 9:00 y 10:00)', (await ids()).join() === [a.id, c.id, d.id, b.id, pend.id].join(), (await ids()).join());
  const pc = (await J('GET', `/pickups?desde=${fecha}&hasta=${fecha}`)).body.find((p) => p.id === c.id);
  check('   posición = promedio de las vecinas (570)', pc.orden_manual === 570, String(pc.orden_manual));
  check('   la tarjeta muestra el 📌', !!(await page.$(`#pickup-card-${c.id} .pin-orden`)));
  if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/pickups-orden.png' });
  // Arrastrar al final de todo.
  const boxP = await (await page.$(`#pickup-card-${pend.id}`)).boundingBox();
  await page.dragAndDrop(`#pickup-card-${a.id}`, `#pickup-card-${pend.id}`, { targetPosition: { x: 200, y: boxP.height - 6 } });
  await esperar(1200);
  ord = await ordenPantalla();
  check('soltarlo abajo de todo lo deja último', ord.slice(-1)[0] === a.id, ord.join());
  await page.click(`#pickup-card-${a.id} .pin-orden`);
  await esperar(1000);
  ord = await ordenPantalla();
  check('el 📌 lo devuelve al orden por horario (primero)', ord[0] === a.id && !(await page.$(`#pickup-card-${a.id} .pin-orden`)), ord.join());
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  await browser.close(); matar();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('✗', e); process.exit(1); });
