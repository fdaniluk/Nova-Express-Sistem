#!/usr/bin/env node
// Revisión de facturas, dos pedidos de Felipe (03/11/2026):
//   1. El ⚠ de la factura (peso / recargo) tiene que irse apenas se corrige el envío, sin F5:
//      GET /api/salidas/:id/anomalias recalcula, y el modal lo pide al guardar y al cargar
//      un cargo. Un cargo "Sobrepeso" (o escrito como tal) cubre la diferencia de kilos.
//   2. Ninguna guía entra marcada: la carga de facturas deja todo 'pendiente' (botonera ✓/✕
//      en Salidas) y la bandeja "Revisar" de Facturas trae las pendientes CON AVISO (margen
//      bajo, anomalía, sin precio) además de las marcadas a mano.
let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3984;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_revision_neutra.db';
const TOKEN = 'token-test-rev-neutra';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
function sql(q, p = []) { return new Promise((res, rej) => { const d = new sqlite3.Database(DB); d.run(q, p, function (e) { d.close(() => (e ? rej(e) : res(this))); }); }); }
function all(q, p = []) { return new Promise((res, rej) => { const d = new sqlite3.Database(DB); d.all(q, p, (e, r) => { d.close(() => (e ? rej(e) : res(r || []))); }); }); }

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const J = (m, u, b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  for (const col of ['flete_facturado', 'fuel_facturado']) await sql(`ALTER TABLE factura_guias ADD COLUMN ${col} REAL`).catch(() => {});

  const cli = (await J('POST', '/api/clientes', { nombre: 'REVISION SA', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  const alta = (g, extra = {}) => J('POST', '/api/envios', { cliente_id: cli.id, fecha: '2026-10-10', courier: 'UPS', servicio_ups: 'UPS_SAV', tipo_envio: 'exportacion', numero_guia: g, pais_destino: 'Estados Unidos', peso_real: 10, largo: 30, ancho: 20, alto: 20, fob: 100, total_cobrado: 300, ...extra });
  // A: UPS facturó 35 kg contra 10 cargados → ⚠ peso. B: todo cuadra (pendiente SIN aviso).
  // C: margen bajo (venta 100 contra costo 95). D: sin precio de venta.
  const eA = (await alta('1Z000REVNEU000001')).body;
  const eB = (await alta('1Z000REVNEU000002')).body;
  const eC = (await alta('1Z000REVNEU000003', { total_cobrado: 100 })).body;
  const eD = (await alta('1Z000REVNEU000004', { total_cobrado: 0 })).body;
  check('fixture: 4 envíos', [eA, eB, eC, eD].every((e) => e && e.id), JSON.stringify([eA, eB, eC, eD].map((e) => e && (e.id || e.error))));
  const fac = await sql("INSERT INTO facturas_cargadas (numero_factura, fecha_factura, fecha_carga, courier, total_declarado, subtotal_factura, percepciones, tipo) VALUES ('F-NEU-1', '2026-10-20', '2026-10-21', 'UPS', 500, 500, 0, 'flete')");
  const fg = (e, peso, costo) => sql('INSERT INTO factura_guias (factura_id, envio_id, numero_guia, pais, peso_facturado, neto, total_recargos, costo_total, cargos_json, encontrada, fuel_facturado) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 1, 20)', [fac.lastID, e.id, e.numero_guia, 'Estados Unidos', peso, costo, costo, '[]']);
  await fg(eA, 35, 200); await fg(eB, 10, 150); await fg(eC, 10, 95); await fg(eD, 10, 120);
  const marcar = (e, peso, costo) => sql("UPDATE envios SET costo_facturado = ?, peso_facturado = ?, courier_facturado = 'UPS', fecha_facturado = '2026-10-20', estado_revision = 'pendiente' WHERE id = ?", [costo, peso, e.id]);
  await marcar(eA, 35, 200); await marcar(eB, 10, 150); await marcar(eC, 10, 95); await marcar(eD, 10, 120);

  console.log('\n1. GET /api/salidas/:id/anomalias recalcula\n');
  let an = (await J('GET', `/api/salidas/${eA.id}/anomalias`)).body;
  check('A: aviso de peso (facturado 35, cargado 10)', an.anomalias.length === 1 && an.anomalias[0].clase === 'peso' && /\+25 kg/.test(an.anomalias[0].texto), JSON.stringify(an));
  check('B: sin anomalías', (await J('GET', `/api/salidas/${eB.id}/anomalias`)).body.anomalias.length === 0);
  // Se corrige el peso en Salidas (PATCH como el modal): el aviso tiene que irse.
  const p = (await J('PATCH', `/api/salidas/${eA.id}`, { peso_real: 35, peso_facturable: 35 })).status;
  an = (await J('GET', `/api/salidas/${eA.id}/anomalias`)).body;
  check('corregido el peso a 35 kg, el aviso desaparece', p === 200 && an.anomalias.length === 0, `${p} ${JSON.stringify(an)}`);
  // Vuelve a 10 y se cubre con un cargo "Sobrepeso" escrito a mano.
  await J('PATCH', `/api/salidas/${eA.id}`, { peso_real: 10, peso_facturable: 10 });
  check('   de vuelta en 10 kg reaparece', (await J('GET', `/api/salidas/${eA.id}/anomalias`)).body.anomalias.length === 1);
  const cargo = (await J('POST', `/api/salidas/${eA.id}/cargos`, { tipo: 'otro', label: 'Sobrepeso UPS', monto: 40 })).body;
  check('   un cargo "otro" llamado Sobrepeso cubre la diferencia de kilos', cargo && cargo.id && (await J('GET', `/api/salidas/${eA.id}/anomalias`)).body.anomalias.length === 0, JSON.stringify(cargo));
  await J('DELETE', `/api/salidas/${eA.id}/cargos/${cargo.id}`);
  check('   anulado el cargo, vuelve el aviso', (await J('GET', `/api/salidas/${eA.id}/anomalias`)).body.anomalias.length === 1);

  console.log('\n2. La bandeja "Revisar" trae las pendientes con aviso\n');
  const bandeja = (await J('GET', '/api/facturas/guias?todo=1')).body;
  const ids = bandeja.guias.map((g) => g.id);
  check('A (anomalía), C (margen bajo) y D (sin precio) están; B (todo bien) no', ids.includes(eA.id) && ids.includes(eC.id) && ids.includes(eD.id) && !ids.includes(eB.id), JSON.stringify(bandeja.guias.map((g) => [g.id, g.estado_revision, g.margen_bajo, g.anomalias.length])));
  check('   todas siguen "pendiente" (nadie las marcó)', bandeja.guias.every((g) => g.estado_revision === 'pendiente'));
  check('   C viene con margen_bajo = true y A con su anomalía', bandeja.guias.find((g) => g.id === eC.id).margen_bajo === true && bandeja.guias.find((g) => g.id === eA.id).anomalias.length === 1);
  await J('PATCH', `/api/facturas/guias/${eB.id}/estado`, { estado_revision: 'a_revisar' });
  const b2 = (await J('GET', '/api/facturas/guias?todo=1')).body;
  check('   B marcada a mano como "a revisar" entra, y va primera', b2.guias[0].id === eB.id && b2.guias[0].estado_revision === 'a_revisar', JSON.stringify(b2.guias.map((g) => [g.id, g.estado_revision])));
  await J('PATCH', `/api/facturas/guias/${eB.id}/estado`, { estado_revision: 'pendiente' });

  if (!chromium) { console.log('\n⚠ playwright no está instalado — se saltea la pantalla.'); }
  else {
    console.log('\n3. Pantallas\n');
    const exe = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => fs.existsSync(p));
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', (e) => errores.push(String(e)));
    const dialogos = [];
    let rechazarDialogo = false;
    page.on('dialog', (d) => { dialogos.push(d.message()); if (rechazarDialogo) d.dismiss(); else d.accept(); });
    await page.goto(`${BASE}/pages/salidas.html?buscar=1Z000REVNEU000001`); await esperar(2500);
    check('Salidas: la fila de A tiene el ⚠ 1 y la botonera ✓/✕ (pendiente)', !!(await page.$('.chip-anom')) && (await page.$$('tr[data-envio-id] .btn-revision-ok')).length === 1);
    await page.click('text=1Z000REVNEU000001'); await esperar(1000);
    check('   el modal muestra el aviso de peso', /Peso: facturado 35 kg/.test(await page.textContent('#saled-factura-block')));
    await page.fill('#saled-peso-real', '35'); await esperar(300);
    await page.click('#sal-modal-save'); await esperar(2000);
    check('   guardar con el peso cambiado y sin Recalcular pregunta si recalcula (se acepta)', dialogos.some((m) => /no tocaste "Recalcular"/.test(m)), dialogos.join(' | '));
    check('   corregido el peso y guardado, el ⚠ se fue de la fila sin refrescar', !(await page.$('.chip-anom')), String(await page.$$eval('.chip-anom', (c) => c.map((x) => x.textContent))));
    check('   y el peso facturable guardado es 35', Number((await all('SELECT peso_facturable FROM envios WHERE id = ?', [eA.id]))[0].peso_facturable) === 35);
    await page.click('text=1Z000REVNEU000001'); await esperar(1000);
    check('   y el modal ya no lo muestra', !/Peso: facturado/.test(await page.textContent('#saled-factura-block')));
    // Si dice que NO recalcula, se guarda tal cual: balanza 10 pero facturable sigue en 35.
    rechazarDialogo = true; dialogos.length = 0;
    await page.fill('#saled-peso-real', '10'); await page.click('#sal-modal-save'); await esperar(2000);
    const pesos = (await all('SELECT peso_real, peso_facturable FROM envios WHERE id = ?', [eA.id]))[0];
    check('   si no acepta recalcular, guarda tal cual (balanza 10, facturable sigue 35) y no hay ⚠', dialogos.length >= 1 && Number(pesos.peso_real) === 10 && Number(pesos.peso_facturable) === 35 && !(await page.$('.chip-anom')), JSON.stringify(pesos));
    rechazarDialogo = false;
    await page.click('text=1Z000REVNEU000001'); await esperar(1000);
    await page.click('#saled-recalcular'); await esperar(1500);
    await page.click('#sal-modal-save'); await esperar(2000);
    check('   recalculado a 10 kg el ⚠ reaparece', !!(await page.$('.chip-anom')));
    await page.click('text=1Z000REVNEU000001'); await esperar(1000);
    await page.click('#saled-cargo-btn'); await esperar(300);
    await page.selectOption('#saled-cargo-tipo', 'sobrepeso');
    await page.fill('#saled-cargo-monto', '40');
    await page.click('#saled-cargo-form button[type="submit"]'); await esperar(1500);
    check('   cargar un cargo Sobrepeso desde el modal saca el ⚠ del modal y de la fila', !/Peso: facturado/.test(await page.textContent('#saled-factura-block')) && !(await page.$('.chip-anom')));
    await page.click('#sal-modal-cancel'); await esperar(300);

    await page.goto(`${BASE}/pages/facturas.html`); await esperar(1000);
    await page.click('.tab[data-tab="revisar"]'); await esperar(1500);
    const seg = await page.$$eval('#fac-revisar-estado button', (bs) => bs.map((b) => b.textContent.trim()));
    check('Facturas → Revisar: arranca en "Todas" y tiene el filtro "Sin revisar"', /^Todas/.test(seg[0]) && seg.some((t) => /^Sin revisar/.test(t)), seg.join(' | '));
    const filas = await page.$$eval('#fac-table-body tr[data-id]', (trs) => trs.map((t) => ({ id: Number(t.dataset.id), txt: t.textContent.replace(/\s+/g, ' ') })));
    const fC = filas.find((f) => f.id === eC.id), fD = filas.find((f) => f.id === eD.id);
    check('   C dice "margen bajo el mínimo" y D "sin precio de venta", las dos con ✓ Aprobar / ✕ A revisar / Reclamar', fC && /margen bajo el mínimo/.test(fC.txt) && /Aprobar/.test(fC.txt) && /A revisar/.test(fC.txt) && /Reclamar/.test(fC.txt) && fD && /sin precio de venta/.test(fD.txt), JSON.stringify([fC, fD]));
    check('   A ya no está (el cargo Sobrepeso cubrió su único aviso) ni B', !filas.some((f) => f.id === eA.id || f.id === eB.id), JSON.stringify(filas.map((f) => f.id)));
    check('sin errores de JS', errores.length === 0, errores.join(' | '));
    await browser.close();
  }

  matar();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
