#!/usr/bin/env node
// Pickups (06/11/2026, pedido de Felipe): "con muchos pickups no se ve a simple vista qué
// se levantó y qué no".
//   · Los contadores del resumen del día son FILTROS: tocar "en camioneta" deja solo esos;
//     tocarlo de nuevo o "Ver todos" vuelve a la lista completa; se mantiene al cambiar de día.
//   · Las tarjetas en camioneta y en depósito llevan fondo lleno (azul / verde), distinto
//     del pastel de las sin confirmar / Ricardo.
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3997;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_pickups_filtro.db';
const TOKEN = 'token-test-pick-filtro';
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

(async () => {
  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production', SALUD_AUTO: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  // Lunes y martes de la semana que viene (la pantalla abre en el día de hoy; se navega).
  const hoy = new Date();
  const lunes = new Date(hoy); lunes.setDate(hoy.getDate() + ((8 - hoy.getDay()) % 7 || 7));
  const martes = new Date(lunes); martes.setDate(lunes.getDate() + 1);
  const fL = iso(lunes), fM = iso(martes);
  const cli = (await J('POST', '/clientes', { nombre: 'FILTRO SA', tarifa_pct: 75, tipo_cobro: 'CC' })).body;
  const crear = async (dir, fecha, hi, extra = {}) => (await J('POST', '/pickups', { cliente_id: cli.id, direccion: dir, fecha, hora_inicio: hi, hora_fin: hi.replace(/^(\d\d)/, (m) => String(Number(m) + 1).padStart(2, '0')), mostrar_en_operaciones: 1, ...extra })).body;
  const pend = await crear('Sin confirmar 1', fL, '09:00');
  const conf = await crear('Ricardo 1', fL, '10:00');
  const cam = await crear('Camioneta 1', fL, '11:00');
  const dep = await crear('Deposito 1', fL, '12:00');
  const cliente = await crear('Lo trae el cliente', fL, '13:00', { tipo_recoleccion: 'cliente' });
  const camM = await crear('Camioneta martes', fM, '09:00');
  const confirmar = async (p, hasta) => {
    await J('PATCH', `/pickups/${p.id}`, { confirmar_ricardo: true, recolector: 'Juanqui' });
    if (hasta === 'conf') return;
    await J('PATCH', `/pickups/${p.id}`, { confirmar_juanqui: true });
    if (hasta === 'cam') return;
    await J('PATCH', `/pickups/${p.id}`, { confirmar_deposito: true });
  };
  await confirmar(conf, 'conf'); await confirmar(cam, 'cam'); await confirmar(dep, 'dep'); await confirmar(camM, 'cam');
  const lista = (await J('GET', `/pickups?desde=${fL}&hasta=${fM}`)).body;
  check('fixture: 6 pickups, uno por estado (+ uno del martes en camioneta)', lista.length === 6 && lista.find((p) => p.id === cam.id).confirmado_juanqui && lista.find((p) => p.id === dep.id).en_deposito_at, JSON.stringify(lista.map((p) => [p.direccion, p.estado])));

  console.log('\nPantalla\n');
  const exe = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = []; page.on('pageerror', (e) => errores.push(String(e)));
  await page.goto(`${BASE}/pages/pickups.html`); await esperar(2000);
  await page.click('#btn-next-week'); await esperar(800);
  await page.click(`.day-pill[data-ymd="${fL}"]`); await esperar(600);
  const visibles = () => page.$$eval('#pickups-dia-list .pickup-card-v2', (cs) => cs.map((c) => c.querySelector('.pickup-direccion span').textContent.trim()));
  check('lunes: se ven los 5', (await visibles()).length === 5, JSON.stringify(await visibles()));
  const cont = await page.$eval('#resumen-bar', (b) => [...b.querySelectorAll('.resumen-card')].filter((x) => x.style.display !== 'none').map((x) => x.textContent.trim().replace(/\s+/g, ' ')));
  check('contadores: 1 sin confirmar · 1 Ricardo · 1 en camioneta · 1 en depósito · 1 cliente/courier', cont.join(' | ') === '1 sin confirmar | 1 Ricardo | 1 en camioneta | 1 en depósito | 1 cliente/courier', cont.join(' | '));
  check('los contadores son botones (se pueden tocar)', await page.$eval('#count-cam', (b) => b.tagName === 'BUTTON' && b.getAttribute('aria-pressed') === 'false'));

  // Colores: camioneta y depósito con fondo lleno, distinto de pendiente/Ricardo.
  const bg = async (id) => page.$eval(`#pickup-card-${id}`, (c) => getComputedStyle(c).backgroundColor);
  const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
  const bCam = await bg(cam.id), bDep = await bg(dep.id), bPend = await bg(pend.id), bConf = await bg(conf.id);
  check('la tarjeta EN CAMIONETA tiene fondo azul lleno (bastante más oscuro que la pendiente)', lum(bCam) < lum(bPend) - 0.12 && bCam.match(/\d+/g).map(Number)[2] > 200, `${bCam} vs ${bPend}`);
  check('la tarjeta EN DEPÓSITO tiene fondo verde lleno', lum(bDep) < lum(bConf) - 0.12 && (() => { const [r, g, b] = bDep.match(/\d+/g).map(Number); return g > r && g > b; })(), `${bDep} vs ${bConf}`);
  check('   y la chapa "En depósito" es verde oscuro con letra blanca', await page.$eval(`#pickup-card-${dep.id} .pickup-badge.dep`, (b) => getComputedStyle(b).color === 'rgb(255, 255, 255)'));

  // Filtro: tocar "en camioneta".
  await page.click('#count-cam'); await esperar(300);
  check('tocar "en camioneta": queda solo ese pickup', (await visibles()).join() === 'Camioneta 1', JSON.stringify(await visibles()));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  check('   el botón queda marcado (aria-pressed) y aparece "Ver todos"', await page.$eval('#count-cam', (b) => b.getAttribute('aria-pressed') === 'true' && b.classList.contains('activo')) && await page.$eval('#btn-filtro-todos', (b) => !b.classList.contains('hidden')));
  check('   los otros contadores siguen contando el día completo (no lo filtrado)', (await page.$eval('#count-pend b', (b) => b.textContent)) === '1');
  await page.click('#count-dep'); await esperar(300);
  check('tocar "en depósito": cambia el filtro (uno solo a la vez)', (await visibles()).join() === 'Deposito 1' && await page.$eval('#count-cam', (b) => b.getAttribute('aria-pressed') === 'false'), JSON.stringify(await visibles()));
  await page.click('#count-dep'); await esperar(300);
  check('tocar el mismo de nuevo: vuelven los 5 y se esconde "Ver todos"', (await visibles()).length === 5 && await page.$eval('#btn-filtro-todos', (b) => b.classList.contains('hidden')));
  await page.click('#count-gris'); await esperar(300);
  check('"cliente/courier" filtra el que trae el cliente', (await visibles()).join() === 'Lo trae el cliente', JSON.stringify(await visibles()));
  await page.click('#count-pend'); await esperar(300);
  check('"sin confirmar" deja el pendiente (el del cliente no cuenta como sin confirmar)', (await visibles()).join() === 'Sin confirmar 1', JSON.stringify(await visibles()));
  await page.click('#count-cam'); await esperar(300);
  // El filtro se mantiene al cambiar de día.
  await page.click(`.day-pill[data-ymd="${fM}"]`); await esperar(500);
  check('cambiar al martes mantiene el filtro "en camioneta": se ve el del martes', (await visibles()).join() === 'Camioneta martes' && await page.$eval('#count-cam', (b) => b.getAttribute('aria-pressed') === 'true'), JSON.stringify(await visibles()));
  await page.click('#count-dep'); await esperar(300);
  const vacio = await page.textContent('#pickups-dia-list');
  check('martes con filtro "en depósito" (no hay): lo dice y ofrece ver los del día', /Ningún pickup en depósito este día/.test(vacio) && /ver los 1/.test(vacio), vacio.trim());
  await page.click('#pickups-dia-list [data-action="filtro-todos"]'); await esperar(300);
  check('   "ver los N" saca el filtro', (await visibles()).length === 1 && await page.$eval('#btn-filtro-todos', (b) => b.classList.contains('hidden')));
  // Confirmar algo con un filtro puesto: la tarjeta sale de la lista filtrada.
  await page.click(`.day-pill[data-ymd="${fL}"]`); await esperar(500);
  await page.click('#count-cam'); await esperar(300);
  await page.click(`#pickup-card-${cam.id} [data-action="conf-deposito"]`); await esperar(1200);
  check('con el filtro "en camioneta" puesto, confirmar depósito saca la tarjeta de la lista y el contador baja a 0', (await visibles()).length === 0 && (await page.$eval('#count-cam b', (b) => b.textContent)) === '0' && (await page.$eval('#count-dep b', (b) => b.textContent)) === '2', JSON.stringify(await visibles()));
  await page.click('#btn-filtro-todos'); await esperar(300);
  check('sin errores de JavaScript', errores.length === 0, errores.slice(0, 2).join(' | '));
  await browser.close();

  matar();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 2500).unref();
})().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
