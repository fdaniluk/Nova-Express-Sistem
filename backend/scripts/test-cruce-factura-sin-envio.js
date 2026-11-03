#!/usr/bin/env node
// Guía facturada "sin envío" que después se carga en Salidas (03/11/2026, pedido de Felipe):
//   · al crear el envío (o corregirle la guía) se cruza solo con lo que la factura dejó en
//     factura_guias: costo, peso, recargos (anomalías), impuestos DDP → cargo posterior.
//   · POST /api/facturas/sin-envio/cruzar barre las que quedaron; botón en Facturas → Sin envío.
//   · el envío entra 'pendiente' (botonera), la fila deja de estar en "Sin envío" y la
//     cabecera de la factura recuenta cruzadas / no encontradas.
let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3986;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_cruce_factura_sin_envio.db';
const TOKEN = 'token-test-cruce-fac';
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

  // Una factura de flete DHL con dos guías sin envío (una con recargo de área remota), y una
  // factura de impuestos UPS con una guía DDP sin envío.
  const fFlete = await sql("INSERT INTO facturas_cargadas (numero_factura, fecha_factura, fecha_carga, courier, cantidad_guias, guias_cruzadas, guias_no_encontradas, total_declarado, subtotal_factura, percepciones, tipo) VALUES ('DHL-SIN-1', '2026-10-20', '2026-10-21', 'DHL', 2, 0, 2, 420, 420, 0, 'flete')");
  await sql("INSERT INTO factura_guias (factura_id, envio_id, numero_guia, pais, peso_facturado, neto, total_recargos, costo_total, cargos_json, encontrada, fuel_facturado) VALUES (?, NULL, '9900CRUCE01', 'Chile', 12, 150, 32, 182, '[{\"nombre\":\"Remote Area Delivery\",\"monto\":32}]', 0, 25)", [fFlete.lastID]);
  await sql("INSERT INTO factura_guias (factura_id, envio_id, numero_guia, pais, peso_facturado, neto, total_recargos, costo_total, cargos_json, encontrada, fuel_facturado) VALUES (?, NULL, '9900CRUCE02', 'Chile', 5, 238, 0, 238, '[]', 0, 30)", [fFlete.lastID]);
  const fImp = await sql("INSERT INTO facturas_cargadas (numero_factura, fecha_factura, fecha_carga, courier, cantidad_guias, guias_cruzadas, guias_no_encontradas, total_declarado, subtotal_factura, percepciones, tipo) VALUES ('UPS-IMP-1', '2026-10-22', '2026-10-23', 'UPS', 1, 0, 1, 55, 55, 0, 'impuestos')");
  await sql("INSERT INTO factura_guias (factura_id, envio_id, numero_guia, pais, peso_facturado, neto, total_recargos, costo_total, cargos_json, encontrada) VALUES (?, NULL, '1Z000CRUCE0000001', 'Estados Unidos', NULL, 55, 0, 55, '[]', 0)", [fImp.lastID]);
  const sinEnvio0 = (await J('GET', '/api/facturas/sin-envio?todo=1')).body;
  check('fixture: 3 guías sin envío', sinEnvio0.total === 3, JSON.stringify(sinEnvio0.total));

  const cli = (await J('POST', '/api/clientes', { nombre: 'CRUCE SA', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  const alta = (b) => J('POST', '/api/envios', { cliente_id: cli.id, fecha: '2026-10-15', courier: 'DHL', tipo_envio: 'exportacion', pais_destino: 'Chile', peso_real: 10, largo: 30, ancho: 20, alto: 20, fob: 100, total_cobrado: 300, ...b });

  console.log('\n1. Al cargar el envío se cruza solo\n');
  const e1 = (await alta({ numero_guia: '9900CRUCE01' })).body;
  const r1 = (await all('SELECT costo_facturado, peso_facturado, courier_facturado, fecha_facturado, estado_revision FROM envios WHERE id = ?', [e1.id]))[0];
  check('el envío nuevo ya tiene la factura: costo 182, peso 12, DHL, fecha de la factura, pendiente', r1 && Number(r1.costo_facturado) === 182 && Number(r1.peso_facturado) === 12 && r1.courier_facturado === 'DHL' && r1.fecha_facturado === '2026-10-20' && r1.estado_revision === 'pendiente', JSON.stringify(r1));
  const fg1 = (await all("SELECT envio_id, encontrada FROM factura_guias WHERE numero_guia = '9900CRUCE01'"))[0];
  check('   la fila de la factura quedó atada al envío', fg1.envio_id === e1.id && fg1.encontrada === 1, JSON.stringify(fg1));
  const cab = (await all('SELECT guias_cruzadas, guias_no_encontradas FROM facturas_cargadas WHERE id = ?', [fFlete.lastID]))[0];
  check('   la cabecera recuenta: 1 cruzada, 1 no encontrada', cab.guias_cruzadas === 1 && cab.guias_no_encontradas === 1, JSON.stringify(cab));
  const sal = (await J('GET', '/api/salidas?desde=2026-10-15&hasta=2026-10-15')).body.find((r) => r.id === e1.id);
  check('   Salidas lo ve con la factura y el ⚠ del área remota no prevista (y el peso 12 vs 10)', sal && sal.costo_facturado === 182 && (sal.anomalias_factura || []).some((a) => /remota/i.test(a.label)) && (sal.anomalias_factura || []).some((a) => a.clase === 'peso'), JSON.stringify(sal && sal.anomalias_factura));
  check('   y ya no está en "Sin envío" (quedan 2)', (await J('GET', '/api/facturas/sin-envio?todo=1')).body.total === 2);

  console.log('\n2. Corregir la guía de un envío también cruza; impuestos DDP → cargo posterior\n');
  const e2 = (await alta({ numero_guia: '1Z000CRUCE0000001', courier: 'UPS', servicio_ups: 'UPS_SAV', pais_destino: 'Estados Unidos', ddp: 1 })).body;
  const r2 = (await all('SELECT impuestos_facturados, impuestos_fecha, impuestos_factura_id, costo_facturado FROM envios WHERE id = ?', [e2.id]))[0];
  check('envío DDP creado con la guía de la factura de impuestos: impuestos 55 y sin costo de flete', r2 && Number(r2.impuestos_facturados) === 55 && r2.impuestos_factura_id === fImp.lastID && r2.costo_facturado == null, JSON.stringify(r2));
  const cargos2 = (await J('GET', `/api/salidas/${e2.id}/cargos`)).body;
  check('   y el cargo posterior de impuestos DDP (55) para cobrárselo al cliente', Array.isArray(cargos2) && cargos2.some((c) => c.origen === 'impuestos_ddp' && Math.abs(c.monto - 55) < 0.011), JSON.stringify(cargos2));
  const e3 = (await alta({ numero_guia: '9900CRUCE99' })).body;
  check('un envío con una guía que no está en ninguna factura queda sin factura', (await all('SELECT costo_facturado FROM envios WHERE id = ?', [e3.id]))[0].costo_facturado == null);
  const pat = await J('PATCH', `/api/salidas/${e3.id}`, { numero_guia: '9900CRUCE02' });
  check('   al corregirle la guía a la que sí está en la factura, se cruza (PATCH avisa cruce_factura)', pat.status === 200 && pat.body.cruce_factura && pat.body.cruce_factura.flete === 238, JSON.stringify(pat.body));
  check('   y "Sin envío" queda vacío', (await J('GET', '/api/facturas/sin-envio?todo=1')).body.total === 0);

  console.log('\n3. El botón: POST /api/facturas/sin-envio/cruzar\n');
  // Se vuelve a dejar una guía sin cruzar a mano (como las que quedaron de antes del 03/11).
  await sql("UPDATE factura_guias SET envio_id = NULL, encontrada = 0 WHERE numero_guia = '9900CRUCE02'");
  await sql('UPDATE envios SET costo_facturado = NULL, peso_facturado = NULL, courier_facturado = NULL, fecha_facturado = NULL WHERE id = ?', [e3.id]);
  const vacio = (await J('POST', '/api/facturas/sin-envio/cruzar')).body;
  check('barre y cruza la que tiene envío (1)', vacio.cantidad === 1 && vacio.cruzados[0].numero_guia === '9900CRUCE02' && vacio.cruzados[0].flete === 238, JSON.stringify(vacio));
  check('   el envío quedó con la factura', Number((await all('SELECT costo_facturado FROM envios WHERE id = ?', [e3.id]))[0].costo_facturado) === 238);
  check('   una segunda pasada no hace nada', (await J('POST', '/api/facturas/sin-envio/cruzar')).body.cantidad === 0);
  // Un envío que YA tenía factura cruzada no se pisa: solo se ata la fila.
  const fOtra = await sql("INSERT INTO facturas_cargadas (numero_factura, fecha_factura, fecha_carga, courier, cantidad_guias, guias_cruzadas, guias_no_encontradas, total_declarado, subtotal_factura, percepciones, tipo) VALUES ('DHL-SIN-2', '2026-10-28', '2026-10-29', 'DHL', 1, 0, 1, 999, 999, 0, 'flete')");
  await sql("INSERT INTO factura_guias (factura_id, envio_id, numero_guia, pais, peso_facturado, neto, total_recargos, costo_total, cargos_json, encontrada) VALUES (?, NULL, '9900CRUCE01', 'Chile', 12, 150, 32, 999, '[]', 0)", [fOtra.lastID]);
  const otra = (await J('POST', '/api/facturas/sin-envio/cruzar')).body;
  check('   una fila repetida de una guía que ya tiene factura se ata pero no pisa el costo (sigue 182)', otra.cantidad === 1 && otra.cruzados[0].flete === null && Number((await all('SELECT costo_facturado FROM envios WHERE id = ?', [e1.id]))[0].costo_facturado) === 182, JSON.stringify(otra));

  if (!chromium) { console.log('\n⚠ playwright no está instalado — se saltea la pantalla.'); }
  else {
    console.log('\n4. Pantalla: el botón en Facturas → Sin envío\n');
    await sql("INSERT INTO factura_guias (factura_id, envio_id, numero_guia, pais, peso_facturado, neto, total_recargos, costo_total, cargos_json, encontrada) VALUES (?, NULL, '9900CRUCE77', 'Chile', 3, 80, 0, 80, '[]', 0)", [fOtra.lastID]);
    const exe = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => fs.existsSync(p));
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', (e) => errores.push(String(e)));
    await page.goto(`${BASE}/pages/facturas.html`); await esperar(1000);
    await page.click('.tab[data-tab="sinenvio"]'); await esperar(1200);
    check('la pestaña lista la guía 9900CRUCE77 y tiene el botón "Cruzar con Salidas"', /9900CRUCE77/.test(await page.textContent('#fac-sinenvio-body')) && !!(await page.$('#btn-sinenvio-cruzar')));
    await page.click('#btn-sinenvio-cruzar'); await esperar(1200);
    check('   sin envío para esa guía, avisa que no hay nada que cruzar', /Ninguna de estas guías tiene envío/.test(await page.textContent('#alert-box')), await page.textContent('#alert-box'));
    await sql("UPDATE envios SET numero_guia = '9900CRUCE77' WHERE id = ?", [e3.id]);
    await sql('UPDATE envios SET costo_facturado = NULL, peso_facturado = NULL WHERE id = ?', [e3.id]);
    await page.click('#btn-sinenvio-cruzar'); await esperar(1500);
    check('   con el envío cargado, cruza y lo dice (1 guía, USD 80.00)', /Se cruzó 1 guía/.test(await page.textContent('#alert-box')) && /9900CRUCE77 \(USD 80\.00\)/.test(await page.textContent('#alert-box')), await page.textContent('#alert-box'));
    check('   y la guía desapareció de la lista', !/9900CRUCE77/.test(await page.textContent('#fac-sinenvio-body')));
    check('sin errores de JS', errores.length === 0, errores.join(' | '));
    await browser.close();
  }

  matar();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
