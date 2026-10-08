#!/usr/bin/env node
// Costos de la empresa (08/10/2026) — la API y sus reglas:
//   · categorías iniciales, con "oficina" para los gastos del día a día; nueva a mano;
//   · dólar del mes: a mano > promedio de Cobranzas > último > sin cargar;
//   · un empleado carga solo en categorías de oficina y entra "por confirmar"; no ve
//     sueldos ni totales; no edita lo confirmado ni lo de otro;
//   · dirección (ver_costos) ve todo, confirma con el monto real, trae los fijos del mes
//     anterior (idempotente), ve Ingresos Brutos automático y el resultado neto;
//   · la serie por mes para el Dashboard.
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3975;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_costos.db';
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  // Dos sesiones: el admin (abrirSesion) y un empleado sin ver_costos.
  const ADMIN = 'tok-costos-admin'; await abrirSesion(DB, ADMIN);
  const sqlite3 = require('sqlite3'); const db = new sqlite3.Database(DB);
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
  const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await run("INSERT INTO usuarios (usuario, password_hash, rol, activo) VALUES ('ricardo_test', 'x', 'empleado', 1)");
  const emp = await get("SELECT id FROM usuarios WHERE usuario = 'ricardo_test'");
  const EMP = 'tok-costos-emp';
  const crypto = require('crypto');
  await run('INSERT INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?, ?, ?)', [crypto.createHash('sha256').update(EMP).digest('hex'), emp.id, '2099-01-01 00:00:00']);
  const J = (tok) => (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: { 'Content-Type': 'application/json', Cookie: `nova_session=${tok}` }, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const A = J(ADMIN); const E = J(EMP);
  const MES = '2026-10'; const ANT = '2026-09';

  console.log('\n1. Categorías y dólar del mes\n');
  const cats = await A('GET', '/costos/categorias');
  check('10 categorías iniciales para dirección', cats.status === 200 && cats.body.length === 10, JSON.stringify(cats.body).slice(0, 120));
  check('Ingresos Brutos es automática', cats.body.some((c) => c.automatica === 'iibb'));
  const catsEmp = await E('GET', '/costos/categorias');
  check('el empleado ve solo las de oficina (sin Sueldos ni IIBB)', catsEmp.status === 200 && catsEmp.body.every((c) => c.oficina && !c.automatica) && !catsEmp.body.some((c) => /Sueldos/.test(c.nombre)), JSON.stringify(catsEmp.body.map((c) => c.nombre)));
  const nueva = await A('POST', '/costos/categorias', { nombre: 'Software y sistemas', oficina: 0 });
  check('nueva categoría a mano', nueva.status === 201 && nueva.body.nombre === 'Software y sistemas');
  check('el empleado no puede crear categorías', (await E('POST', '/costos/categorias', { nombre: 'x' })).status === 403);
  check('sin tipo de cambio cargado se avisa', (await A('GET', `/costos/tc?mes=${MES}`)).body.tc === null);
  await run("INSERT INTO cc_tipo_cambio (fecha, compra, venta, promedio, fuente) VALUES ('2026-10-02', 1400, 1420, 1410, 'manual'), ('2026-10-06', 1410, 1440, 1425, 'manual'), ('2026-09-15', 1380, 1400, 1390, 'manual')");
  const tc = await A('GET', `/costos/tc?mes=${MES}`);
  check('promedio de Cobranzas del mes (1430)', tc.body.tc === 1430 && /promedio/.test(tc.body.tc_fuente), JSON.stringify(tc.body));
  const tcMan = await A('PUT', '/costos/tc', { mes: MES, tc: 1500 });
  check('a mano manda', tcMan.body.tc === 1500 && tcMan.body.manual === true);
  check('borrar el manual vuelve al promedio', (await A('PUT', '/costos/tc', { mes: MES, tc: null })).body.tc === 1430);
  check('el empleado no toca el dólar', (await E('PUT', '/costos/tc', { mes: MES, tc: 1 })).status === 403);

  console.log('\n2. Dirección carga; el empleado carga lo suyo por confirmar\n');
  const sueldos = cats.body.find((c) => c.nombre === 'Sueldos'); const alquiler = cats.body.find((c) => c.nombre === 'Alquiler');
  const combustible = cats.body.find((c) => /combustible/i.test(c.nombre)); const iibbCat = cats.body.find((c) => c.automatica === 'iibb');
  const s1 = await A('POST', '/costos', { mes: MES, categoria_id: sueldos.id, detalle: 'Victoria', monto: 2400000, moneda: 'ARS', fijo: 1 });
  check('sueldo en pesos, fijo, entra confirmado', s1.status === 201 && s1.body.estado === 'confirmado' && s1.body.fijo === 1, JSON.stringify(s1.body).slice(0, 150));
  const a1 = await A('POST', '/costos', { mes: MES, categoria_id: alquiler.id, detalle: 'Alquiler Florida', monto: 1430, moneda: 'USD', fijo: 1 });
  check('alquiler en dólares, fijo', a1.status === 201);
  check('no se carga a mano en Ingresos Brutos', (await A('POST', '/costos', { mes: MES, categoria_id: iibbCat.id, detalle: 'x', monto: 1, moneda: 'USD' })).status === 400);
  check('monto 0 o moneda rara se rechazan', (await A('POST', '/costos', { mes: MES, categoria_id: sueldos.id, detalle: 'x', monto: 0, moneda: 'ARS' })).status === 400 && (await A('POST', '/costos', { mes: MES, categoria_id: sueldos.id, detalle: 'x', monto: 5, moneda: 'EUR' })).status === 400);
  const e1 = await E('POST', '/costos', { mes: MES, categoria_id: combustible.id, detalle: 'Nafta camioneta', monto: 143000, moneda: 'ARS', fijo: 1 });
  check('el empleado carga combustible y queda por confirmar (y nunca fijo)', e1.status === 201 && e1.body.estado === 'por_confirmar' && e1.body.fijo === 0, JSON.stringify(e1.body).slice(0, 150));
  check('el empleado no carga sueldos', (await E('POST', '/costos', { mes: MES, categoria_id: sueldos.id, detalle: 'x', monto: 1, moneda: 'ARS' })).status === 403);
  const e1b = await E('PUT', `/costos/${e1.body.id}`, { monto: 150000 });
  check('el empleado edita lo suyo mientras está por confirmar', e1b.status === 200 && e1b.body.monto === 150000);
  check('pero no edita lo de dirección', (await E('PUT', `/costos/${s1.body.id}`, { monto: 1 })).status === 403);
  check('ni confirma', (await E('POST', `/costos/${e1.body.id}/confirmar`, {})).status === 403);

  console.log('\n3. Lo que ve cada uno\n');
  const vistaEmp = await E('GET', `/costos?mes=${MES}`);
  check('el empleado ve solo el combustible, sin totales', vistaEmp.status === 200 && vistaEmp.body.puede_todo === false && vistaEmp.body.costos.length === 1 && !vistaEmp.body.totales, JSON.stringify(vistaEmp.body).slice(0, 200));
  await run("INSERT INTO facturas_cargadas (numero_factura, fecha_factura, courier, total_declarado, subtotal_factura, percepciones) VALUES ('0020-1', '2026-10-05', 'UPS', 1000, 900, 90.5), ('1700A1', '2026-10-07', 'DHL', 500, 480, 20)");
  const vista = await A('GET', `/costos?mes=${MES}`);
  const b = vista.body;
  check('dirección ve los 4 renglones (3 cargados + IIBB automático)', vista.status === 200 && b.puede_todo === true && b.costos.length === 4, String(b.costos && b.costos.length));
  check('Ingresos Brutos suma las percepciones del mes (110.50, 1 UPS + 1 DHL)', b.iibb && b.iibb.monto === 110.5 && /1 UPS \+ 1 DHL/.test(b.iibb.detalle), JSON.stringify(b.iibb));
  check('cada costo trae su equivalente en la otra moneda con el dólar del mes', b.costos.find((c) => c.detalle === 'Victoria').usd === 1678.32 && b.costos.find((c) => c.detalle === 'Alquiler Florida').ars === 2044900, JSON.stringify(b.costos.map((c) => [c.detalle, c.ars, c.usd])));
  const t = b.totales;
  check('totales: ARS 2.550.000 · USD 1.540,50 · todo en USD 3.323,72', t && t.ars === 2550000 && t.usd === 1540.5 && t.usd_total === 3323.72, JSON.stringify(t));
  check('resultado neto = utilidad de envíos − costos', t && t.resultado_neto === Math.round((t.utilidad_envios - t.usd_total) * 100) / 100, JSON.stringify(t));
  check('por categoría, con % del total', b.categorias.length === 4 && b.categorias.every((c) => typeof c.pct === 'number'), JSON.stringify(b.categorias));
  check('cuenta 1 por confirmar', b.por_confirmar === 1);

  console.log('\n4. Confirmar y traer los fijos\n');
  const conf = await A('POST', `/costos/${e1.body.id}/confirmar`, { monto: 151200 });
  check('dirección confirma con el monto real', conf.status === 200 && conf.body.estado === 'confirmado' && conf.body.monto === 151200 && conf.body.confirmado_por_nombre, JSON.stringify(conf.body).slice(0, 200));
  check('ya confirmado, el empleado no lo borra', (await E('DELETE', `/costos/${e1.body.id}`)).status === 403);
  const NOV = '2026-11';
  const tr = await A('POST', '/costos/traer-fijos', { mes: NOV });
  check('traer fijos copia los 2 fijos de octubre a noviembre', tr.status === 200 && tr.body.copiados === 2, JSON.stringify(tr.body));
  check('de nuevo no duplica', (await A('POST', '/costos/traer-fijos', { mes: NOV })).body.copiados === 0);
  const nov = await A('GET', `/costos?mes=${NOV}`);
  check('en noviembre entran por confirmar con el monto de octubre', nov.body.costos.length === 2 && nov.body.costos.every((c) => c.estado === 'por_confirmar' && c.origen_id), JSON.stringify(nov.body.costos.map((c) => [c.detalle, c.estado, c.monto])));
  check('noviembre sin cotización propia usa el último dólar cargado (1440)', nov.body.tc === 1440 && /último/.test(nov.body.tc_fuente), nov.body.tc_fuente);
  check('el mes anterior de noviembre es octubre, con su total', nov.body.totales.mes_anterior.mes === MES && nov.body.totales.mes_anterior.usd_total > 3000, JSON.stringify(nov.body.totales.mes_anterior));

  console.log('\n5. Serie para el Dashboard\n');
  const serie = await A('GET', `/costos/serie?desde=${ANT}&hasta=${NOV}`);
  check('tres meses, octubre con sus costos en USD', serie.status === 200 && serie.body.length === 3 && serie.body[1].mes === MES && serie.body[1].costos_usd > 3300, JSON.stringify(serie.body));
  check('el empleado no ve la serie', (await E('GET', `/costos/serie?desde=${ANT}&hasta=${NOV}`)).status === 403);
  check('mes inválido da 400', (await A('GET', '/costos?mes=octubre')).status === 400);

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  db.close(); matar();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('✗', e); process.exit(1); });
