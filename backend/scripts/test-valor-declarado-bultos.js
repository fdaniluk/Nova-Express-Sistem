#!/usr/bin/env node
/**
 * test-valor-declarado-bultos.js — Guías: valor declarado por bulto (oficina 30/10/2026).
 *
 * LA REGLA: el seguro de UPS se declara por bulto. El FOB de la proforma se reparte en
 * PARTES IGUALES entre los bultos (antes era por peso); la pantalla lo precarga y deja
 * corregirlo bulto por bulto. Lo que manda es el FOB total: si los bultos no lo suman, la
 * guía no sale (error de datos, sin llamar a UPS). Lo que viajó queda en datos.bultos[].
 *
 * Corre con UPS_SHIPPING_MOCK=1 y abre la pantalla en un navegador de verdad.
 *
 *   cd backend && node scripts/test-valor-declarado-bultos.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3996;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_valor_declarado_bultos.db';
const TOKEN = 'token-test-vd-bultos';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n0. El reparto y la validación (servicio)\n');
  const ups = require('../src/services/ups-shipping.service');
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('100 en 2 bultos → 50 + 50 (partes iguales, ya no por peso)', eq(ups.repartirValorDeclarado(100, [{ peso_real: 3 }, { peso_real: 1 }]), [50, 50]), JSON.stringify(ups.repartirValorDeclarado(100, [{ peso_real: 3 }, { peso_real: 1 }])));
  check('10 en 3 bultos → 3,33 + 3,33 + 3,34 (el último cierra)', eq(ups.repartirValorDeclarado(10, [{}, {}, {}]), [3.33, 3.33, 3.34]), JSON.stringify(ups.repartirValorDeclarado(10, [{}, {}, {}])));
  check('FOB 0 → todos 0', eq(ups.repartirValorDeclarado(0, [{}, {}]), [0, 0]));
  let v = ups.validarValoresDeclarados(400, [{ peso_real: 1 }, { peso_real: 2 }]);
  check('sin valores tipeados → valores null (reparte el modelo)', !v.error && v.valores === null, JSON.stringify(v));
  v = ups.validarValoresDeclarados(400, [{ valor_declarado: 300 }, { valor_declarado: 100 }]);
  check('300 + 100 contra FOB 400 → cierra', !v.error && eq(v.valores, [300, 100]), JSON.stringify(v));
  v = ups.validarValoresDeclarados(400, [{ valor_declarado: 300 }, { valor_declarado: 50 }]);
  check('300 + 50 contra FOB 400 → error que dice las dos cifras', /350\.00/.test(v.error || '') && /400\.00/.test(v.error || ''), JSON.stringify(v));
  v = ups.validarValoresDeclarados(400, [{ valor_declarado: 300 }, { valor_declarado: null }]);
  check('uno tipeado y otro vacío → error que dice qué bulto falta', /bulto 2/.test(v.error || ''), JSON.stringify(v));
  v = ups.validarValoresDeclarados(400, [{ valor_declarado: 133.33 }, { valor_declarado: 133.33 }, { valor_declarado: 133.34 }]);
  check('centavos: 133,33 + 133,33 + 133,34 cierra en 400', !v.error && eq(v.valores, [133.33, 133.33, 133.34]), JSON.stringify(v));

  prepararDb(DB);
  const envSrv = {
    ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production',
    UPS_SHIPPING_MOCK: '1', UPS_SHIPPING_ENTORNO: 'test', UPS_CUENTA_EXPO: '327W09',
    UPS_SHIPPER_NOMBRE: 'NOVA EXPRESS', UPS_SHIPPER_TELEFONO: '5411 4000 0000',
    UPS_SHIPPER_DIRECCION: 'Av. Nova 100', UPS_SHIPPER_CIUDAD: 'Bella Vista', UPS_SHIPPER_CP: '1661',
  };
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: envSrv, stdio: ['ignore', 'pipe', 'pipe'] });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);

  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
  const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: H, body: JSON.stringify(b) });
  const get = (u) => fetch(BASE + u, { headers: H });

  const sqlite3 = require('sqlite3');
  const dbRaw = new sqlite3.Database(DB);
  const one = (q, p = []) => new Promise((res, rej) => dbRaw.get(q, p, (e2, row) => (e2 ? rej(e2) : res(row))));
  const pedidoDe = async (id) => JSON.parse((await one('SELECT request_json FROM guias WHERE id = ?', [id])).request_json).ShipmentRequest;
  const dvDe = (req) => req.Shipment.Package.map((p) => Number(p.PackageServiceOptions?.DeclaredValue?.MonetaryValue || 0));

  const cli = await j(await post('/api/clientes', {
    nombre: 'VD TEST SA', tarifa_pct: 70, cuit: '30-22222222-3', direccion_recoleccion: 'Calle Falsa 123',
    codigo_postal: '1661', localidad: 'Bella Vista', provincia: 'Buenos Aires', telefono: '11 4000 1111', contacto: 'Pedro',
  }));
  const dGB = await j(await post(`/api/clientes/${cli.id}/destinatarios`, {
    nombre: 'LONDON LEATHER LTD', contacto: 'Jane', direccion1: '10 Downing St', codigo_postal: 'SW1A 2AA', ciudad: 'London',
    pais: 'Reino Unido', telefono: '+44 20 7000 0000',
  }));
  const base = {
    cliente_id: cli.id, destinatario_id: dGB.id, fecha: '2026-10-30', servicio: 'UPS_SAV',
    contenido: 'Cueros', items: [{ cantidad: 2, descripcion: 'Leather hides', valor_unitario: 150 }, { cantidad: 4, descripcion: 'Samples', valor_unitario: 25 }],
  };

  console.log('\n1. Sin valores por bulto → el FOB se reparte en partes iguales\n');
  let r = await post('/api/guias', { ...base, bultos: [{ peso_real: 12.4 }, { peso_real: 3 }] });
  let g = await j(r);
  check('POST /guias → 201', r.status === 201, `${r.status} ${JSON.stringify(g).slice(0, 200)}`);
  let dv = dvDe(await pedidoDe(g.id));
  check('  DeclaredValue 200 + 200 (FOB 400, dos bultos de peso distinto)', eq(dv, [200, 200]), JSON.stringify(dv));
  check('  la guía guarda lo que viajó en cada bulto', eq(g.bultos.map((b) => b.valor_declarado), [200, 200]), JSON.stringify(g.bultos));
  check('  valor_declarado_ups = FOB 400', g.valor_declarado_ups === 400 && g.asegurada === true);

  console.log('\n2. Valores tipeados que cierran → van tal cual a UPS\n');
  r = await post('/api/guias', { ...base, bultos: [{ peso_real: 12.4, valor_declarado: 350 }, { peso_real: 3, valor_declarado: 50 }] });
  g = await j(r);
  check('POST /guias → 201', r.status === 201, `${r.status} ${JSON.stringify(g).slice(0, 200)}`);
  dv = dvDe(await pedidoDe(g.id));
  check('  DeclaredValue 350 + 50', eq(dv, [350, 50]), JSON.stringify(dv));
  check('  guardados en la guía', eq(g.bultos.map((b) => b.valor_declarado), [350, 50]), JSON.stringify(g.bultos));

  console.log('\n3. Valores que no suman el FOB → 400, sin guía\n');
  const antes = (await j(await get('/api/guias'))).length;
  r = await post('/api/guias', { ...base, bultos: [{ peso_real: 12.4, valor_declarado: 300 }, { peso_real: 3, valor_declarado: 50 }] });
  let e = await j(r);
  check('300 + 50 contra FOB 400 → 400 de datos', r.status === 400 && /Faltan datos/.test(e.error), `${r.status} ${JSON.stringify(e)}`);
  check('  el error dice 350.00 y 400.00', e.errores?.some((x) => /350\.00/.test(x) && /400\.00/.test(x)), JSON.stringify(e.errores));
  r = await post('/api/guias', { ...base, bultos: [{ peso_real: 12.4, valor_declarado: 400 }, { peso_real: 3 }] });
  e = await j(r);
  check('uno con valor y otro vacío → 400 que nombra el bulto 2', r.status === 400 && e.errores?.some((x) => /bulto 2/.test(x)), `${r.status} ${JSON.stringify(e)}`);
  check('  no se creó ninguna guía', (await j(await get('/api/guias'))).length === antes);

  console.log('\n4. FOB explícito manda sobre los renglones; sin seguro no se valida nada\n');
  r = await post('/api/guias', { ...base, fob: 500, bultos: [{ peso_real: 1, valor_declarado: 250 }, { peso_real: 1, valor_declarado: 250 }] });
  g = await j(r);
  check('fob 500 tipeado + 250/250 → 201', r.status === 201, `${r.status} ${JSON.stringify(g).slice(0, 200)}`);
  r = await post('/api/guias', { ...base, asegurar: 0, bultos: [{ peso_real: 1, valor_declarado: 1 }, { peso_real: 1, valor_declarado: 2 }] });
  g = await j(r);
  check('asegurar 0 con valores que no cierran → 201 igual (no viaja DeclaredValue)', r.status === 201 && eq(dvDe(await pedidoDe(g.id)), [0, 0]) && eq(g.bultos.map((b) => b.valor_declarado), [0, 0]), `${r.status} ${JSON.stringify(g.bultos)}`);

  console.log('\n5. La pantalla: columna "Valor decl.", reparto automático, corrección a mano y freno\n');
  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e2) => errores.push(String(e2)));
  page.on('console', (m) => { if (m.type() === 'error') errores.push('console: ' + m.text()); });
  await page.goto(BASE + '/pages/guias.html', { waitUntil: 'networkidle' });
  await esperar(1000);

  check('la tabla de bultos tiene la columna Valor decl. (USD)', await page.evaluate(() => [...document.querySelectorAll('#g-bultos thead th')].some((th) => /Valor decl/.test(th.textContent))));
  // Cliente, destinatario, renglones.
  await page.selectOption('#g-cliente', String(cli.id));
  await esperar(800);
  await page.selectOption('#g-destinatario', String(dGB.id)).catch(() => {});
  await page.fill('#g-contenido', 'Cueros');
  const fila = (i, f) => `#g-items tbody tr:nth-child(${i}) [data-f="${f}"]`;
  await page.fill(fila(1, 'cantidad'), '2');
  await page.fill(fila(1, 'descripcion'), 'Leather hides');
  await page.fill(fila(1, 'valor_unitario'), '150');
  await page.click('#g-item-agregar');
  await page.fill(fila(2, 'cantidad'), '4');
  await page.fill(fila(2, 'descripcion'), 'Samples');
  await page.fill(fila(2, 'valor_unitario'), '25');
  await page.click('#g-bulto-agregar');
  await page.click('#g-bulto-agregar');
  for (let i = 1; i <= 3; i++) await page.fill(`#g-bultos tbody tr:nth-child(${i}) [data-f="peso_real"]`, String(i));
  await esperar(200);
  const vds = () => page.evaluate(() => [...document.querySelectorAll('#g-bultos tbody [data-f="valor_declarado"]')].map((i) => ({ v: i.value, m: i.dataset.manual, d: i.disabled })));
  let lista = await vds();
  check('3 bultos y FOB 400 → 133,33 + 133,33 + 133,34 automáticos', eq(lista.map((x) => x.v), ['133.33', '133.33', '133.34']) && lista.every((x) => x.m === '0' && !x.d), JSON.stringify(lista));
  const pie = () => page.evaluate(() => document.getElementById('g-vd-pie').textContent);
  check('  el pie dice 400,00 de 400,00', /400\.00 de US\$ 400\.00/.test(await pie()), await pie());

  await page.fill('#g-bultos tbody tr:nth-child(1) [data-f="valor_declarado"]', '300');
  await esperar(150);
  lista = await vds();
  check('tipeo 300 en el bulto 1 → los otros dos se reparten los 100 (50 + 50)', eq(lista.map((x) => x.v), ['300', '50.00', '50.00']) && lista[0].m === '1', JSON.stringify(lista));

  await page.fill('#g-bultos tbody tr:nth-child(2) [data-f="valor_declarado"]', '80');
  await esperar(150);
  lista = await vds();
  check('tipeo 80 en el bulto 2 → el 3 queda en 20', eq(lista.map((x) => x.v), ['300', '80', '20.00']), JSON.stringify(lista));

  await page.fill('#g-bultos tbody tr:nth-child(3) [data-f="valor_declarado"]', '50');
  await esperar(150);
  check('los tres a mano y no suman → el pie avisa en rojo', /430\.00 de US\$ 400\.00/.test(await pie()) && await page.evaluate(() => document.getElementById('g-vd-pie').classList.contains('gui-vd-mal')), await pie());
  await page.click('#g-emitir');
  await esperar(600);
  const err = await page.evaluate(() => document.getElementById('g-errores').textContent);
  check('  Emitir frena antes de pedir la guía y dice las dos cifras', /430\.00/.test(err) && /400\.00/.test(err), err.slice(0, 200));
  check('  no se creó guía', (await j(await get('/api/guias'))).length === antes + 2);

  await page.fill('#g-bultos tbody tr:nth-child(3) [data-f="valor_declarado"]', '');
  await esperar(150);
  lista = await vds();
  check('vaciar el bulto 3 → vuelve al automático con el resto (20)', lista[2].v === '20.00' && lista[2].m === '0', JSON.stringify(lista));

  await page.fill(fila(2, 'valor_unitario'), '50');
  await esperar(150);
  lista = await vds();
  check('cambia el FOB a 500 → los manuales quedan y el automático absorbe (120)', eq(lista.map((x) => x.v), ['300', '80', '120.00']), JSON.stringify(lista));

  await page.uncheck('#g-seguro');
  await esperar(150);
  lista = await vds();
  check('sin seguro UPS → los casilleros se apagan y el pie lo dice', lista.every((x) => x.d) && /Sin seguro/.test(await pie()), JSON.stringify(lista));
  await page.check('#g-seguro');
  await esperar(150);

  await page.click('#g-emitir');
  await esperar(1500);
  const guias = await j(await get('/api/guias'));
  const nueva = guias.length === antes + 3 ? guias.reduce((a, b) => (b.id > a.id ? b : a)) : null;
  check('Emitir con 300 + 80 + 120 → la guía sale con esos valores', !!nueva && eq(nueva.bultos.map((b) => b.valor_declarado), [300, 80, 120]), JSON.stringify(nueva?.bultos));
  if (nueva) check('  y eso es lo que viajó a UPS', eq(dvDe(await pedidoDe(nueva.id)), [300, 80, 120]));

  console.log('\n6. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|net::ERR|Failed to load resource/i.test(x));
  check('ningún error en la pantalla', rel.length === 0, rel.join(' | ').slice(0, 300));

  await browser.close();
  await new Promise((res) => dbRaw.close(() => res()));
  matarSrv();
  console.log(`\n${ok} pasaron · ${fail} fallaron\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
