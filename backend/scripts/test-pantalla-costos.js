#!/usr/bin/env node
// Pantalla Costos de la empresa (08/10/2026): dirección y empleado ven cosas distintas;
// cargar, editar, confirmar, traer fijos, dólar del mes, USD/ARS, categorías.
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3976;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_costos.db';
const ADMIN = 'tok-pcostos-admin'; const EMP = 'tok-pcostos-emp';
const SHOTS = process.env.SHOTS_DIR || null;
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, ADMIN);
  const sqlite3 = require('sqlite3'); const db = new sqlite3.Database(DB);
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
  const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await run("INSERT INTO usuarios (usuario, password_hash, rol, activo) VALUES ('ricardo_test', 'x', 'empleado', 1)");
  const emp = await get("SELECT id FROM usuarios WHERE usuario = 'ricardo_test'");
  await run('INSERT INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?, ?, ?)', [crypto.createHash('sha256').update(EMP).digest('hex'), emp.id, '2099-01-01 00:00:00']);
  await run("INSERT INTO cc_tipo_cambio (fecha, compra, venta, promedio, fuente) VALUES ('2026-10-02', 1400, 1420, 1410, 'manual'), ('2026-10-06', 1410, 1440, 1425, 'manual')");
  await run("INSERT INTO facturas_cargadas (numero_factura, fecha_factura, courier, total_declarado, subtotal_factura, percepciones) VALUES ('0020-1', '2026-10-05', 'UPS', 1000, 900, 90.5)");

  const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const errores = [];
  async function pagina(tok) {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
    await ctx.addCookies([{ name: 'nova_session', value: tok, url: BASE }]);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errores.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text()); });
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? '151200' : undefined));
    return page;
  }
  const ir = async (page) => { await page.goto(`${BASE}/pages/costos.html`); await esperar(1500); await page.evaluate(() => { document.getElementById('cos-mes').value = '2026-10'; document.getElementById('cos-mes').dispatchEvent(new Event('change')); }); await esperar(1200); };

  console.log('\n1. Dirección\n');
  const A = await pagina(ADMIN);
  await ir(A);
  check('el menú tiene "Costos"', !!(await A.$('.sidebar-nav a[href="costos.html"].active')));
  check('ve las tarjetas', await A.isVisible('#cos-tiles'));
  check('el dólar del mes es el promedio de Cobranzas', /1\.430|1430/.test(await A.textContent('#cos-tc')) && /promedio/.test(await A.textContent('#cos-tc')), await A.textContent('#cos-tc'));
  check('ve el botón de traer fijos y el de categorías', await A.isVisible('#btn-traer-fijos') && await A.isVisible('#btn-categorias'));
  check('Ingresos Brutos ya aparece solo (90,50)', /Ingresos Brutos/.test(await A.textContent('#cos-tabla')) && /90,50/.test(await A.textContent('#cos-tabla')));
  await A.selectOption('#c-categoria', { label: 'Sueldos' });
  await A.fill('#c-detalle', 'Victoria');
  await A.fill('#c-monto', '2400000');
  await A.selectOption('#c-moneda', 'ARS');
  await A.selectOption('#c-fijo', '1');
  await A.click('#btn-guardar');
  await esperar(1200);
  const t = await A.textContent('#cos-tabla');
  check('cargar un sueldo fijo en pesos lo lista confirmado y fijo', /Victoria/.test(t) && /confirmado/.test(t) && /fijo/.test(t), t.slice(0, 200));
  check('con su equivalente en USD (1.678,32)', /1\.678,32/.test(t), t.slice(0, 300));
  check('la tarjeta de costos suma en USD', /1\.768,82/.test(await A.textContent('#tile-costos')), await A.textContent('#tile-costos'));
  check('resultado neto = utilidad − costos (negativo sin envíos)', /-/.test(await A.textContent('#tile-neto .n')));
  await A.click('#cos-moneda button[data-moneda="ARS"]');
  await esperar(300);
  check('"Ver en ARS" cambia la columna y las tarjetas', (await A.textContent('#cos-th-conv')) === 'En ARS' && /\$\s?2\.529/.test(await A.textContent('#tile-costos .n')), await A.textContent('#tile-costos .n'));
  await A.click('#cos-moneda button[data-moneda="USD"]');
  await esperar(300);
  if (SHOTS) await A.screenshot({ path: path.join(SHOTS, 'costos-direccion.png'), fullPage: true });
  // dólar a mano
  await A.click('#cos-tc');
  await esperar(300);
  check('el pill del dólar abre el modal', await A.isVisible('#modal-tc'));
  await A.fill('#tc-valor', '1500');
  await A.click('#tc-guardar');
  await esperar(1000);
  check('el dólar a mano manda (1.500)', /1\.500|1500/.test(await A.textContent('#cos-tc')) && /a mano/.test(await A.textContent('#cos-tc')), await A.textContent('#cos-tc'));
  // categorías
  await A.click('#btn-categorias');
  await esperar(500);
  await A.fill('#cat-nombre', 'Software y sistemas');
  await A.click('#cat-agregar');
  await esperar(900);
  check('nueva categoría aparece en el modal y en el desplegable', /Software y sistemas/.test(await A.textContent('#cat-tabla')) && /Software y sistemas/.test(await A.textContent('#c-categoria')));
  await A.click('#modal-cat-cerrar');

  console.log('\n2. Empleado\n');
  const E = await pagina(EMP);
  await ir(E);
  check('no ve tarjetas ni fijos ni categorías', !(await E.isVisible('#cos-tiles')) && !(await E.isVisible('#btn-traer-fijos')) && !(await E.isVisible('#btn-categorias')) && !(await E.isVisible('#c-fijo-grupo')));
  check('ve el aviso de gastos del día a día', await E.isVisible('#cos-aviso-emp'));
  const opciones = await E.$$eval('#c-categoria option', (os) => os.map((o) => o.textContent));
  check('solo categorías de oficina (sin Sueldos)', !opciones.includes('Sueldos') && opciones.some((o) => /combustible/i.test(o)), opciones.join(','));
  check('no ve el sueldo de Victoria ni Ingresos Brutos', !/Victoria/.test(await E.textContent('#cos-tabla')) && !/Ingresos Brutos/.test(await E.textContent('#cos-tabla')));
  await E.selectOption('#c-categoria', { label: 'Vehículo y combustible' });
  await E.fill('#c-detalle', 'Nafta camioneta');
  await E.fill('#c-monto', '143000');
  await E.click('#btn-guardar');
  await esperar(1200);
  const te = await E.textContent('#cos-tabla');
  check('carga combustible y queda por confirmar, con su nombre', /Nafta camioneta/.test(te) && /por confirmar/.test(te) && /ricardo_test/.test(te), te.slice(0, 200));
  check('puede editar y borrar lo suyo', !!(await E.$('#cos-tabla button[data-action="editar"]')) && !!(await E.$('#cos-tabla button[data-action="eliminar"]')));
  if (SHOTS) await E.screenshot({ path: path.join(SHOTS, 'costos-empleado.png'), fullPage: true });

  console.log('\n3. Dirección confirma y trae fijos\n');
  await ir(A);
  check('dirección ve el gasto del empleado por confirmar con botón Confirmar', /Nafta camioneta/.test(await A.textContent('#cos-tabla')) && !!(await A.$('#cos-tabla button[data-action="confirmar"]')));
  check('la cabecera cuenta 1 por confirmar', /1 por confirmar/.test(await A.textContent('#cos-resumen')));
  await A.click('#cos-tabla button[data-action="confirmar"]');
  await esperar(1200);
  const tc = await A.textContent('#cos-tabla');
  check('confirmar con el monto real (151.200) lo deja confirmado', /151\.200/.test(tc) && !/por confirmar/.test(tc), tc.slice(0, 300));
  await A.evaluate(() => { document.getElementById('cos-mes').value = '2026-11'; document.getElementById('cos-mes').dispatchEvent(new Event('change')); });
  await esperar(1000);
  await A.click('#btn-traer-fijos');
  await esperar(1200);
  const tn = await A.textContent('#cos-tabla');
  check('en noviembre "Traer los fijos" copia el sueldo por confirmar', /Victoria/.test(tn) && /por confirmar/.test(tn) && !/Nafta/.test(tn), tn.slice(0, 200));
  check('ningún error en las pantallas', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  await browser.close(); db.close(); matar();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1500).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
