#!/usr/bin/env node
// Cambio de módulo sin pantalla en blanco (03/11/2026):
//   - auth-guard recuerda el usuario (localStorage nova_me) y dibuja la pantalla al
//     instante; la verificación contra /api/auth/me corre en segundo plano.
//   - 401 → login (y se olvida el usuario); permisos distintos → la pantalla se recarga
//     con los reales (incluido el redirect por URL).
//   - main.js: pre-carga del HTML de los módulos (speculation rules) y tbody gris mientras
//     no hay datos (nova-cargando).
//   - main.css: view transitions entre páginas con el menú fijo.
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3981;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_cambio_modulo.db';
const TOKEN = 'token-test-cambio-modulo';
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
function sql(q, p = []) {
  const db = new sqlite3.Database(DB);
  return new Promise((res, rej) => db.run(q, p, function (e) { db.close(); e ? rej(e) : res(this); }));
}

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  const usuarioId = await abrirSesion(DB, TOKEN);

  const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('dialog', (d) => d.accept());

  // /api/auth/me y los datos tardan 1,2 s: así se ve qué hace la pantalla MIENTRAS espera.
  let demorar = false;
  await page.route(/\/api\//, async (route) => {
    if (demorar) await esperar(1200);
    route.continue();
  });
  const estado = () => page.evaluate(() => ({
    visibility: document.body.style.visibility,
    user: window.currentUser ? window.currentUser.rol : null,
    me: localStorage.getItem('nova_me'),
    specRules: !!document.querySelector('script[type="speculationrules"]'),
    cargando: Array.from(document.querySelectorAll('tbody.nova-cargando')).map((t) => t.id || t.parentElement.id || '?'),
    vtMenu: getComputedStyle(document.querySelector('.sidebar')).viewTransitionName,
  }));

  console.log('\n1. Primera entrada (sin usuario recordado): como siempre, oculta hasta la respuesta\n');
  demorar = true;
  await page.goto(`${BASE}/pages/salidas.html`, { waitUntil: 'domcontentloaded' });
  let e = await estado();
  check('la pantalla arranca oculta', e.visibility === 'hidden', e.visibility);
  check('todavía no hay usuario', e.user === null && e.me === null);
  check('Salidas escribe su propio "Cargando…" (el gris genérico no hace falta)', e.cargando.length === 0, JSON.stringify(e.cargando));
  await esperar(2500);
  e = await estado();
  check('después de la respuesta se ve', e.visibility === '', e.visibility);
  check('y queda el usuario recordado (nova_me)', !!e.me && JSON.parse(e.me).rol === 'admin', e.me);
  check('el gris de la tabla se fue al llegar los datos', e.cargando.length === 0, JSON.stringify(e.cargando));
  check('las speculation rules para pre-cargar el menú están en el head', e.specRules);
  check('el menú tiene nombre de view transition (queda fijo al cambiar de módulo)', e.vtMenu === 'nova-menu', e.vtMenu);
  const vt = await page.evaluate(() => Array.from(document.styleSheets).some((s) => { try { return Array.from(s.cssRules).some((r) => r.cssText.startsWith('@view-transition')); } catch { return false; } }));
  check('main.css declara @view-transition { navigation: auto }', vt);

  console.log('\n2. Cambio de módulo con usuario recordado: se dibuja al instante\n');
  await page.goto(`${BASE}/pages/envios.html`, { waitUntil: 'domcontentloaded' });
  e = await estado();
  check('la pantalla NO está oculta mientras espera a /api/auth/me', e.visibility === '', e.visibility);
  check('la tabla de Envíos se marca gris mientras no hay datos', e.cargando.includes('tabla-envios'), JSON.stringify(e.cargando));
  check('window.currentUser ya está (del recordado)', e.user === 'admin', e.user);
  const menuVisible = await page.evaluate(() => Array.from(document.querySelectorAll('.sidebar-nav a')).filter((a) => a.offsetParent !== null).length);
  check('el menú se ve completo (admin)', menuVisible >= 10, String(menuVisible));
  await esperar(2500);
  e = await estado();
  check('después de confirmar con el servidor sigue visible y sin recargar', e.visibility === '' && e.user === 'admin');
  const yaLlegoEvento = await page.evaluate(() => new Promise((r) => { window.addEventListener('nova:usuario', () => r(true), { once: true }); setTimeout(() => r(false), 100); }));
  check('el evento nova:usuario ya se disparó (no queda nadie esperando)', yaLlegoEvento === false);

  console.log('\n2b. Varios cambios de módulo seguidos por el menú (view transitions): sin errores\n');
  demorar = false;
  for (const h of ['clientes.html', 'guias.html', 'salidas.html', 'liquidaciones.html', 'envios.html', 'clientes.html']) {
    await page.click(`.sidebar-nav a[href="${h}"]`);
    await page.waitForURL(new RegExp(h.replace('.', '\\.')), { timeout: 8000 });
    await esperar(700);
  }
  check('seis cambios de módulo sin errores de JS (el fundido no se saltea ni avisa)', errores.length === 0, errores.join(' | '));
  const vtInline = await page.evaluate(() => Array.from(document.querySelectorAll('head style')).some((s) => /@view-transition/.test(s.textContent)));
  check('el opt-in a view transitions está inline en el head (no solo en main.css)', vtInline);
  demorar = true;

  console.log('\n3. Permisos que cambian en el servidor: se recarga con los reales\n');
  await sql('UPDATE usuarios SET ver_dashboard = 0 WHERE id = ?', [usuarioId]);
  await page.goto(`${BASE}/index.html`, { waitUntil: 'commit' });
  const urlAlEntrar = page.url();
  check('el dashboard se abre primero con el usuario recordado (ver_dashboard 1)', /index\.html/.test(urlAlEntrar), urlAlEntrar);
  await page.waitForURL(/envios\.html/, { timeout: 8000 }).catch(() => {});
  await esperar(2500);
  e = await estado();
  check('el servidor dice ver_dashboard 0 → recarga y lo manda a Envíos', /envios\.html/.test(page.url()), page.url());
  check('y el recordado ya es el nuevo', !!e.me && JSON.parse(e.me).ver_dashboard === 0, e.me);
  const dashOculto = await page.evaluate(() => Array.from(document.querySelectorAll('a[href="../index.html"]')).every((a) => a.style.display === 'none'));
  check('el ítem Dashboard del menú queda escondido', dashOculto);
  await sql('UPDATE usuarios SET ver_dashboard = 1 WHERE id = ?', [usuarioId]);

  console.log('\n4. Sesión vencida: al login y se olvida el usuario\n');
  await sql('DELETE FROM sesiones');
  demorar = false;
  await page.goto(`${BASE}/pages/salidas.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/login\.html/, { timeout: 8000 }).catch(() => {});
  check('termina en login.html', /login\.html/.test(page.url()), page.url());
  const meTrasLogin = await page.evaluate(() => localStorage.getItem('nova_me'));
  check('nova_me borrado', meTrasLogin === null, meTrasLogin);

  check('sin errores de JS en ninguna pantalla', errores.length === 0, errores.join(' | '));
  await browser.close();
  matar();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
