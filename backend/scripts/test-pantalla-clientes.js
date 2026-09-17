#!/usr/bin/env node
/**
 * test-pantalla-clientes.js — el módulo Clientes (lista + alta + perfil) después del
 * rediseño del 17/09/2026, por API y en un navegador de verdad.
 *
 * QUÉ SE PRUEBA
 *  A. API
 *   1. La lista sin filtro trae SOLO activos; ?todos=1 trae también inactivos; ?activo=0
 *      trae los inactivos (antes '0' era truthy y devolvía los activos).
 *   2. Un campo de texto se puede VACIAR (antes COALESCE lo hacía imposible).
 *   3. Validaciones: tipo_cobro inválido → 400 (no 500), tarifa negativa → 400,
 *      email inválido → 400, plazo de pago decimal → 400.
 *   4. Eliminar un cliente con envíos → 409 con la lista de lo que tiene; sin rastro → 204;
 *      inexistente → 404.
 *   5. PUT /:id/activo desactiva y activa; el inactivo desaparece de la lista sin filtro.
 *   6. La lista trae matriz_celdas / kg_celdas / tramos_propios, y cambian al cargar una
 *      celda o un precio por kilo.
 *   7. plazo_pago_dias y tipo_cambio se guardan y se pueden vaciar / validar.
 *  B. Pantalla Clientes
 *   8. La columna Margen dice "75 %", "75 % + matriz", "por kilo" o "sin margen".
 *   9. Filtros: estado (Activos / Inactivos / Todos), tipo de cobro, "Sin margen", buscador.
 *  10. El alta tiene las cuatro secciones y "Usar los mismos datos" copia el WhatsApp.
 *  11. Un cliente con envíos no ofrece Eliminar hasta estar inactivo; Desactivar lo saca.
 *  12. Nada del HTML se rompe con una razón social con comillas.
 *  C. Perfil
 *  13. Cabecera con nombre Nova, chips (cobro, facturación, estado, margen) y botones.
 *  14. Tarjetas de números: envíos, utilidad, sin liquidar (con total), última liquidación.
 *  15. La ficha marca en ámbar lo que falta para la guía y avisa.
 *  16. Editar → vaciar el CUIT → guardar → queda vacío de verdad.
 *  17. Libretas, direcciones y links se dibujan; el resumen de la matriz dice lo mismo
 *      que la cabecera.
 *  18. Teléfono (390 px): sin scroll horizontal en la lista y en el perfil.
 *
 *   cd backend && node scripts/test-pantalla-clientes.js
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

const PORT = process.env.PORT_TEST || 3935;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || path.join(require('os').tmpdir(), 'test_pantalla_clientes.db');
const TOKEN = 'token-test-pantalla-clientes';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
let matarTodo = () => {};
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else {
    fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`);
  }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = ''; let logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; });
  let muerto = false;
  const matarSrv = () => { if (muerto) return; muerto = true; try { srv.kill(); } catch { /* ya estaba */ } };
  matarTodo = matarSrv;
  process.on('exit', matarSrv);

  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);

  const J = async (m, u, b) => {
    const r = await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // ── A. API ───────────────────────────────────────────────────────────────────────
  console.log('\nA. La API de clientes\n');

  const hoy = new Date();
  const dia = (n) => iso(new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - n));
  const conMatriz = (await J('POST', '/api/clientes', { razon_social: 'ASAPLAST "PRUEBA" S.R.L.', nombre_nova: 'ASAPLAST', tarifa_pct: 75, tipo_cobro: 'S', cuit: '30-71234567-8', whatsapp: '+54 9 11 5555-1234', email: 'm@asaplast.com.ar', direccion_recoleccion: 'Av. Mitre 2450, Munro' })).body;
  const porKilo = (await J('POST', '/api/clientes', { razon_social: 'CUEROS PRUEBA S.A.', tarifa_pct: 0, tipo_cobro: 'CC' })).body;
  const sinMargen = (await J('POST', '/api/clientes', { razon_social: 'NUMANA PRUEBA', tarifa_pct: 0, tipo_cobro: 'D' })).body;
  const soloPct = (await J('POST', '/api/clientes', { razon_social: 'SOLO PORCENTAJE', tarifa_pct: 60, tipo_cobro: 'Q', plazo_pago_dias: 15, tipo_cambio: 'promedio' })).body;
  check('se crean los cuatro clientes de prueba', conMatriz?.id && porKilo?.id && sinMargen?.id && soloPct?.id);
  check('plazo de pago y tipo de cambio se guardan en el alta', soloPct.plazo_pago_dias === 15 && soloPct.tipo_cambio === 'promedio', JSON.stringify([soloPct.plazo_pago_dias, soloPct.tipo_cambio]));
  check('sin tipo de cambio, queda "venta"', conMatriz.tipo_cambio === 'venta');

  // Matriz: una celda de % para ASAPLAST y un precio por kilo para CUEROS
  let r = await J('PUT', `/api/clientes/${conMatriz.id}/profit-matrix`, { servicio: 'DHL', tipo: 'export', profit_pct: 60 });
  check('se carga una celda de % (general de tabla DHL export)', r.status === 200 || r.status === 201, `${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
  r = await J('PUT', `/api/clientes/${porKilo.id}`, { modo_tarifa: 'por_kg' });
  r = await J('PUT', `/api/clientes/${porKilo.id}/tarifa-kg`, { servicio: 'UPS_EXP', tipo: 'export', precio_kg: 5 });
  check('se carga un precio por kilo', r.status === 200 || r.status === 201, `${r.status}`);

  let lista = (await J('GET', '/api/clientes')).body;
  const deLista = (id) => lista.find((c) => c.id === id);
  check('la lista trae matriz_celdas (1 para ASAPLAST)', deLista(conMatriz.id).matriz_celdas === 1, JSON.stringify(deLista(conMatriz.id).matriz_celdas));
  check('y kg_celdas (1 para CUEROS)', deLista(porKilo.id).kg_celdas === 1);
  check('y 0 / 0 para el que no tiene nada', deLista(sinMargen.id).matriz_celdas === 0 && deLista(sinMargen.id).kg_celdas === 0);

  // Vaciar un campo
  r = await J('PUT', `/api/clientes/${conMatriz.id}`, { cuit: '' });
  check('🔴 vaciar el CUIT lo deja vacío de verdad (antes COALESCE lo impedía)', r.status === 200 && r.body.cuit === null, JSON.stringify(r.body?.cuit));
  r = await J('PUT', `/api/clientes/${conMatriz.id}`, { email: '   ' });
  check('un texto de solo espacios también queda vacío', r.body?.email === null);
  r = await J('PUT', `/api/clientes/${conMatriz.id}`, { cuit: '30-71234567-8', email: 'm@asaplast.com.ar' });
  check('y se vuelve a cargar', r.body?.cuit === '30-71234567-8');
  r = await J('PUT', `/api/clientes/${conMatriz.id}`, { nombre_nova: 'ASAPLAST' });
  check('mandar un solo campo no pisa el resto', r.body?.cuit === '30-71234567-8' && r.body?.whatsapp === '+54 9 11 5555-1234');

  // Validaciones
  r = await J('PUT', `/api/clientes/${conMatriz.id}`, { tipo_cobro: 'X' });
  check('tipo_cobro inválido → 400 con mensaje (no 500)', r.status === 400 && /cobro/i.test(r.body?.error || ''), `${r.status} ${r.body?.error}`);
  r = await J('PUT', `/api/clientes/${conMatriz.id}`, { tarifa_pct: -5 });
  check('tarifa negativa → 400', r.status === 400);
  r = await J('POST', '/api/clientes', { razon_social: 'MAIL MALO', email: 'esto-no-es-un-mail' });
  check('email inválido → 400', r.status === 400);
  r = await J('PUT', `/api/clientes/${conMatriz.id}`, { plazo_pago_dias: 7.5 });
  check('plazo de pago con decimales → 400', r.status === 400);
  r = await J('PUT', `/api/clientes/${conMatriz.id}`, { tipo_cambio: 'oficial' });
  check('tipo de cambio inválido → 400', r.status === 400);
  r = await J('PUT', `/api/clientes/${soloPct.id}`, { plazo_pago_dias: '' });
  check('el plazo de pago se puede vaciar', r.status === 200 && r.body.plazo_pago_dias === null, JSON.stringify(r.body?.plazo_pago_dias));
  r = await J('POST', '/api/clientes', { razon_social: '   ' });
  check('razón social de solo espacios → 400', r.status === 400);

  // Envío para ASAPLAST → no se puede eliminar
  r = await J('POST', '/api/envios', {
    cliente_id: conMatriz.id, fecha: dia(3), courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP',
    numero_guia: '1Z000CLIENTES00001', pais_destino: 'Chile', peso_real: 4, largo: 30, ancho: 20, alto: 15, fob: 250, total_cobrado: 118.2,
  });
  check('se carga un envío del cliente', r.status === 201, `${r.status}`);
  r = await J('DELETE', `/api/clientes/${conMatriz.id}`);
  check('eliminar un cliente con envíos → 409 y dice qué tiene', r.status === 409 && r.body?.dependencias?.['envíos'] === 1 && /desactivar/i.test(r.body?.error || ''), `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  r = await J('DELETE', '/api/clientes/999999');
  check('eliminar uno inexistente → 404 (antes 204)', r.status === 404);

  // Activo / inactivo
  r = await J('PUT', `/api/clientes/${sinMargen.id}/activo`, { activo: false });
  check('PUT /:id/activo desactiva', r.status === 200 && r.body.activo === 0);
  lista = (await J('GET', '/api/clientes')).body;
  check('el inactivo NO aparece en la lista sin filtro (los selectores del sistema)', !lista.some((c) => c.id === sinMargen.id));
  lista = (await J('GET', '/api/clientes?todos=1')).body;
  check('con ?todos=1 sí aparece', lista.some((c) => c.id === sinMargen.id));
  lista = (await J('GET', '/api/clientes?activo=0')).body;
  check('?activo=0 trae SOLO inactivos (antes devolvía los activos)', lista.length === 1 && lista[0].id === sinMargen.id, `${lista.length}`);
  r = await J('PUT', `/api/clientes/${sinMargen.id}/activo`, { activo: true });
  check('y se vuelve a activar', r.body?.activo === 1);
  const temp = (await J('POST', '/api/clientes', { razon_social: 'TEMPORAL SIN RASTRO' })).body;
  r = await J('DELETE', `/api/clientes/${temp.id}`);
  check('un cliente sin rastro sí se elimina → 204', r.status === 204);

  // ── B. Pantalla Clientes ─────────────────────────────────────────────────────────
  console.log('\nB. La pantalla Clientes\n');
  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text());
  });

  await page.goto(`${BASE}/pages/clientes.html`);
  await page.waitForSelector('#tabla-clientes tr[data-cliente-id]', { timeout: 15000 });
  await esperar(300);

  check('el CSS del módulo se cargó', await page.evaluate(() => [...document.styleSheets].some((s) => /clientes\.css/.test(s.href || ''))));
  const filas = await page.$$eval('#tabla-clientes tr[data-cliente-id]', (trs) => trs.map((tr) => ({
    id: Number(tr.dataset.clienteId), nombre: tr.querySelector('.cli-nombre a')?.textContent.trim(),
    sub: tr.querySelector('.cli-sub')?.textContent.trim() || '', margen: tr.querySelector('td.n .cli-chip')?.textContent.trim(),
    estado: tr.querySelector('.cli-chip.activo, .cli-chip.inactivo')?.textContent.trim(),
    acciones: [...tr.querySelectorAll('td.acciones .btn')].map((b) => b.textContent.trim()),
  })));
  const fila = (id) => filas.find((f) => f.id === id);
  const activosApi = (await J('GET', '/api/clientes')).body;
  check('la lista muestra todos los clientes activos', filas.length === activosApi.length, `${filas.length} vs ${activosApi.length}`);
  check('el nombre Nova va grande y la razón social abajo', fila(conMatriz.id).nombre === 'ASAPLAST' && /ASAPLAST "PRUEBA" S.R.L./.test(fila(conMatriz.id).sub), JSON.stringify(fila(conMatriz.id)));
  check('🔴 Margen dice "75 % + matriz" para el que tiene celdas propias', fila(conMatriz.id).margen === '75 % + matriz', fila(conMatriz.id).margen);
  check('"por kilo" para el que cobra por kilo', fila(porKilo.id).margen === 'por kilo', fila(porKilo.id).margen);
  check('"sin margen" para el que no tiene nada', fila(sinMargen.id).margen === 'sin margen', fila(sinMargen.id).margen);
  check('"60 %" pelado para el que solo tiene el general', fila(soloPct.id).margen === '60 %', fila(soloPct.id).margen);
  check('los botones de la fila son Perfil · Cotizar · Editar · Desactivar (Eliminar no aparece en un activo)',
    JSON.stringify(fila(conMatriz.id).acciones) === JSON.stringify(['Perfil', 'Cotizar', 'Editar', 'Desactivar']), JSON.stringify(fila(conMatriz.id).acciones));
  const pill = await page.$eval('#cli-pill', (e) => e.textContent.trim());
  const sinMargenApi = activosApi.filter((c) => !(Number(c.tarifa_pct) > 0) && !c.matriz_celdas && !c.kg_celdas && c.modo_tarifa !== 'por_kg').length;
  check('la cabecera cuenta clientes y cuántos sin margen', pill === `${activosApi.length} clientes · ${sinMargenApi} sin margen`, `${pill} · esperado ${activosApi.length} / ${sinMargenApi}`);

  // Filtros
  await page.click('#filtro-margen [data-margen="sin"]');
  check('el filtro "Sin margen" deja solo los que no tienen nada', (await page.$$('#tabla-clientes tr[data-cliente-id]')).length === sinMargenApi);
  await page.click('#filtro-margen [data-margen="todos"]');
  await page.selectOption('#filtro-cobro', 'CC');
  check('el filtro por tipo de cobro funciona', (await page.$$eval('#tabla-clientes tr[data-cliente-id]', (t) => t.length)) === 1);
  await page.selectOption('#filtro-cobro', '');
  await page.fill('#buscador-clientes', 'cueros');
  check('el buscador filtra por nombre', (await page.$$eval('#tabla-clientes tr[data-cliente-id]', (t) => t.length)) === 1);
  await page.fill('#buscador-clientes', '');

  // Desactivar desde la pantalla
  page.once('dialog', (d) => d.accept());
  await page.click(`#tabla-clientes tr[data-cliente-id="${sinMargen.id}"] [data-action="desactivar"]`);
  await esperar(800);
  check('Desactivar lo saca de la lista de activos', !(await page.$(`#tabla-clientes tr[data-cliente-id="${sinMargen.id}"]`)));
  await page.click('#filtro-estado [data-estado="inactivos"]');
  await esperar(150);
  const accInactivo = await page.$$eval(`#tabla-clientes tr[data-cliente-id="${sinMargen.id}"] td.acciones .btn`, (bs) => bs.map((b) => b.textContent.trim()));
  check('en Inactivos aparece con Activar y Eliminar', accInactivo.includes('Activar') && accInactivo.includes('Eliminar'), accInactivo.join(','));
  await page.click(`#tabla-clientes tr[data-cliente-id="${sinMargen.id}"] [data-action="activar"]`);
  await esperar(800);
  await page.click('#filtro-estado [data-estado="activos"]');
  await esperar(150);
  check('Activar lo devuelve', !!(await page.$(`#tabla-clientes tr[data-cliente-id="${sinMargen.id}"]`)));

  // Alta: secciones y "Usar los mismos datos"
  await page.click('#btn-nuevo');
  await esperar(200);
  const secciones = await page.$$eval('#form-panel .cli-sec h4', (hs) => hs.map((h) => h.firstChild.textContent.trim()));
  check('el alta tiene las cuatro secciones', secciones.length === 4 && /Identificación/.test(secciones[0]) && /guías/.test(secciones[3]), secciones.join(' | '));
  await page.fill('#f-whatsapp', '+54 9 11 4444-0000');
  await page.fill('#f-direccion_recoleccion', 'Calle Falsa 123, San Martín');
  await page.click('#btn-copiar-guia');
  check('"Usar los mismos datos" copia el WhatsApp al teléfono de guía y saca la localidad de la dirección',
    (await page.inputValue('#f-telefono')) === '+54 9 11 4444-0000' && (await page.inputValue('#f-localidad')) === 'San Martín');
  await page.fill('#f-razon_social', 'NUEVO DESDE PANTALLA');
  await page.fill('#f-plazo_pago_dias', '30');
  await page.click('#btn-guardar-cliente');
  await esperar(900);
  const creado = (await J('GET', '/api/clientes')).body.find((c) => c.nombre === 'NUEVO DESDE PANTALLA');
  check('el alta desde la pantalla guarda todo (plazo 30, teléfono copiado, CUIT vacío)', creado && creado.plazo_pago_dias === 30 && creado.telefono === '+54 9 11 4444-0000' && creado.cuit === null, JSON.stringify(creado).slice(0, 200));

  // Editar y vaciar desde la pantalla
  await page.click(`#tabla-clientes tr[data-cliente-id="${conMatriz.id}"] [data-action="editar"]`);
  await esperar(200);
  check('el formulario carga la razón social con comillas sin romperse', (await page.inputValue('#f-razon_social')) === 'ASAPLAST "PRUEBA" S.R.L.');
  await page.fill('#f-email', '');
  await page.click('#btn-guardar-cliente');
  await esperar(900);
  check('🔴 vaciar el email desde la pantalla lo deja vacío', (await J('GET', `/api/clientes/${conMatriz.id}`)).body.email === null);
  await J('PUT', `/api/clientes/${conMatriz.id}`, { email: 'm@asaplast.com.ar' });

  // ── C. Perfil ────────────────────────────────────────────────────────────────────
  console.log('\nC. El perfil del cliente\n');
  await page.goto(`${BASE}/pages/clientes-perfil.html?id=${conMatriz.id}`);
  await page.waitForSelector('#info-grid .info-field', { timeout: 15000 });
  await esperar(900);

  check('la cabecera muestra el nombre Nova', (await page.$eval('#page-title', (e) => e.textContent.trim())) === 'ASAPLAST');
  check('y la razón social con el CUIT debajo', /ASAPLAST "PRUEBA" S.R.L. · CUIT 30-71234567-8/.test(await page.$eval('#per-razon', (e) => e.textContent)));
  const chips = await page.$$eval('#per-chips .cli-chip', (cs) => cs.map((c) => c.textContent.trim()));
  check('chips: Semanal · Responsable inscripto · Activo · 75 % + matriz', chips.join('|') === 'Semanal|Responsable inscripto|Activo|75 % + matriz', chips.join('|'));
  check('Cotizar y Cargar envío llevan al cliente', await page.evaluate((id) =>
    document.getElementById('btn-cotizar').getAttribute('href') === `cotizador.html?cliente=${id}`
    && document.getElementById('btn-cargar-envio').getAttribute('href') === `envios.html?cliente=${id}`, conMatriz.id));

  const kpis = await page.evaluate(() => ({
    guias: document.getElementById('stat-guias').textContent.trim(),
    util: document.getElementById('stat-utilidad').textContent.trim(),
    sinLiq: document.getElementById('stat-sin-liquidar').textContent.trim(),
    sinLiqSub: document.getElementById('stat-sin-liquidar-sub').textContent.trim(),
  }));
  check('tarjetas: 1 envío, 1 sin liquidar con su total', kpis.guias === '1' && kpis.sinLiq === '1' && /118,20/.test(kpis.sinLiqSub), JSON.stringify(kpis));

  const ficha = await page.evaluate(() => ({
    secs: [...document.querySelectorAll('#info-grid .per-ficha-sec')].map((s) => s.textContent.trim()),
    faltan: [...document.querySelectorAll('#info-grid .field-value.falta')].length,
    aviso: document.querySelector('#info-grid .per-ficha-aviso')?.textContent.trim(),
    tarifa: document.querySelector('#field-tarifa_pct .field-value')?.textContent.trim(),
    plazo: document.querySelector('#field-plazo_pago_dias .field-value')?.textContent.trim(),
  }));
  check('la ficha tiene las cuatro secciones', ficha.secs.length === 4, ficha.secs.join('|'));
  check('marca en ámbar lo que falta para la guía y lo avisa', ficha.faltan === 4 && /Teléfono/.test(ficha.aviso) && /Código postal/.test(ficha.aviso), `${ficha.faltan} · ${ficha.aviso}`);
  check('el % de la ficha dice "75 % + matriz"', ficha.tarifa === '75 % + matriz', ficha.tarifa);
  check('el plazo de pago sin cargar dice "sin definir"', ficha.plazo === 'sin definir', ficha.plazo);

  const resumen = await page.$eval('#tarifas-resumen', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  check('el resumen de la matriz dice el general y cuántas celdas propias', /75 % sobre el flete/.test(resumen) && /1 celda\(s\) propia\(s\)/.test(resumen), resumen.slice(0, 120));

  // Editar y vaciar el CUIT desde el perfil
  await page.click('#btn-editar');
  await esperar(150);
  check('en edición el input tiene la razón social entera (con comillas)', (await page.inputValue('#pf-nombre')) === 'ASAPLAST "PRUEBA" S.R.L.');
  await page.fill('#pf-cuit', '');
  await page.fill('#pf-telefono', '+54 11 4756-1234');
  await page.click('#btn-guardar');
  await esperar(900);
  const trasGuardar = (await J('GET', `/api/clientes/${conMatriz.id}`)).body;
  check('🔴 desde el perfil, vaciar el CUIT lo deja vacío y el teléfono se guarda', trasGuardar.cuit === null && trasGuardar.telefono === '+54 11 4756-1234', JSON.stringify([trasGuardar.cuit, trasGuardar.telefono]));
  check('la cabecera se actualiza sin recargar (ya no muestra el CUIT)', !/CUIT/.test(await page.$eval('#per-razon', (e) => e.textContent)));
  check('el aviso de la ficha baja a lo que sigue faltando', /Para emitir guías falta/.test(await page.$eval('#info-grid .per-ficha-aviso', (e) => e.textContent)) && !/Teléfono/.test(await page.$eval('#info-grid .per-ficha-aviso', (e) => e.textContent)));

  const libretas = await page.$$eval('#libretas-lista li', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
  check('Libretas: remitentes y destinatarios con link a Guías', libretas.length === 2 && /Remitentes/.test(libretas[0]) && /Destinatarios/.test(libretas[1]), libretas.join(' | '));
  check('Direcciones y links se dibujaron', await page.evaluate(() => !!document.querySelector('#dirs-list li') && !!document.querySelector('#links-list li')));
  const guiasTabla = await page.$$eval('#tabla-guias tr', (trs) => trs.map((t) => t.querySelectorAll('td').length));
  check('la tabla de envíos tiene las 8 columnas (el colspan viejo decía 7)', guiasTabla.length === 1 && guiasTabla[0] === 8, JSON.stringify(guiasTabla));
  check('el envío se ve con chip "sin liquidar"', /sin liquidar/.test(await page.$eval('#tabla-guias', (e) => e.textContent)));

  // Los ids que usa el resto del JS (matriz, tarifario, cotizaciones, links) siguen
  const ids = ['btn-editar', 'btn-guardar', 'btn-cancelar-edit', 'info-grid', 'card-tarifas', 'btn-armar-tarifario', 'btn-editar-tarifas',
    'tarifas-panel', 'tarifas-fuel-input', 'btn-guardar-fuel', 'btn-borrar-fuel', 'tarifas-seguro-pct', 'tarifas-seguro-min', 'btn-guardar-seguro',
    'btn-borrar-seguro', 'tarifas-seguro-hint', 'tarifas-tabs', 'tarifas-grid-ayuda', 'tarifas-alerta', 'tarifas-grid', 'dirs-list', 'btn-agregar-dir',
    'add-dir-form', 'nueva-direccion', 'btn-guardar-dir', 'btn-cancelar-dir', 'ctz-filtro-estado', 'btn-ctz-actualizar', 'ctz-lista', 'links-list',
    'link-form', 'link-couriers', 'link-dias', 'link-nombrar', 'btn-crear-link', 'stat-guias', 'stat-utilidad', 'stat-ultima-liq', 'chart-mensual',
    'chart-empty', 'tabla-guias', 'tarifario-modal', 'tarifario-cerrar'];
  const faltanIds = await page.evaluate((l) => l.filter((id) => !document.getElementById(id)), ids);
  check(`los ${ids.length} ids del perfil siguen existiendo`, faltanIds.length === 0, faltanIds.join(', '));

  // La grilla de tarifas se abre y se dibuja
  await page.click('#btn-editar-tarifas');
  await page.waitForSelector('#tarifas-grid table', { timeout: 15000 });
  check('"Editar tarifas" abre la grilla de siempre', (await page.$$('#tarifas-grid table')).length >= 1);

  // ── D. Teléfono ──────────────────────────────────────────────────────────────────
  console.log('\nD. Teléfono (390 px)\n');
  await page.setViewportSize({ width: 390, height: 844 });
  await esperar(300);
  const scrollX = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('el perfil no tiene scroll horizontal', (await scrollX()) <= 1, `${await scrollX()} px de más`);
  check('el resumen lateral baja debajo de la columna principal', await page.evaluate(() =>
    document.getElementById('card-direcciones').getBoundingClientRect().top >= document.getElementById('card-envios').getBoundingClientRect().bottom - 1));
  await page.goto(`${BASE}/pages/clientes.html`);
  await page.waitForSelector('#tabla-clientes tr[data-cliente-id]');
  await esperar(300);
  check('la lista no tiene scroll horizontal (la tabla scrollea adentro de su tarjeta)', (await scrollX()) <= 1, `${await scrollX()} px de más`);

  check('la pantalla no tiró ningún error de JavaScript', errores.length === 0, errores.join(' | ').slice(0, 200));

  await browser.close();
  matarSrv();
  // El formato lo lee verificar.js para sumar las tandas: no cambiarlo.
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => {}, 200).unref();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  matarTodo();
});
