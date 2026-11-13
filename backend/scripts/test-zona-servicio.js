#!/usr/bin/env node
// La zona que se muestra de un envío es la del SERVICIO usado (13/11/2026, Felipe).
// Caso real: Cueros Santa Cruz a Polonia por UPS, liquidación #233, decía zona 4 (la de
// DHL, con la que se había cargado) y es zona 6. La plata estaba bien: era la etiqueta.
//   · Al cargar: la zona la pone el sistema según país + courier + expo/impo.
//   · Al cambiar el courier (o país, o expo/impo): la zona se pone al día.
//   · Corrección de arrastre al arrancar: etiquetas viejas o vacías, sin tocar importes.
//   · País fuera de las tablas con zona a mano: no se toca.
const DB = process.env.DB_PATH_TEST || '/tmp/test_zona_servicio.db';
process.env.DB_PATH = DB;
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = Number(process.env.PORT_TEST || 4000);
const BASE = `http://localhost:${PORT}`;
const TOKEN = 'token-test-zona-servicio';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const cerca = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

async function levantar(port) {
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(port), NODE_ENV: 'production', SALUD_AUTO: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  await esperarServidor(srv, `http://localhost:${port}`, () => le, () => lo);
  return { srv, log: () => lo + le };
}

(async () => {
  const { zonaDelServicio } = require('../src/utils/zona-envio');
  console.log('\n1. La regla\n');
  check('Polonia: UPS expo 6 · DHL 4 · UPS impo 5', zonaDelServicio('Polonia', 'UPS', 'exportacion') === 6 && zonaDelServicio('Polonia', 'DHL', 'exportacion') === 4 && zonaDelServicio('Polonia', 'UPS', 'importacion') === 5);
  check('Estados Unidos: UPS expo 2 · DHL 3 · UPS impo 1 (acepta minúsculas)', zonaDelServicio('estados unidos', 'UPS', 'exportacion') === 2 && zonaDelServicio('Estados Unidos', 'DHL', 'exportacion') === 3 && zonaDelServicio('Estados Unidos', 'UPS', 'importacion') === 1);
  check('país que no está en las tablas: null (no inventa)', zonaDelServicio('Narnia', 'UPS', 'exportacion') === null && zonaDelServicio('', 'UPS', 'exportacion') === null);

  prepararDb(DB, { desdeProduccion: false });
  let s = await levantar(PORT);
  process.on('exit', () => { try { s.srv.kill(); } catch {} });
  await abrirSesion(DB, TOKEN);
  const J = (m, u, b, base = BASE) => fetch(base + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const cli = (await J('POST', '/clientes', { nombre: 'ZONAS SA', tarifa_pct: 60, tipo_cobro: 'CC' })).body;
  let n = 0;
  const mk = (extra) => J('POST', '/envios', { cliente_id: cli.id, fecha: '2026-10-16', courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion', numero_guia: `1Z327W09679000${String(++n).padStart(4, '0')}`, pais_destino: 'Polonia', peso_real: 30, largo: 40, ancho: 40, alto: 40, fob: 300, total_cobrado: 400, ...extra }).then((r) => r.body);
  const zona = async (id) => String((await J('GET', `/envios/${id}`)).body.zona);

  console.log('\n2. Al cargar\n');
  const a = await mk({ zona: '4' });
  check('UPS a Polonia cargado con zona 4 (la de DHL): queda en 6', await zona(a.id) === '6', await zona(a.id));
  const b = await mk({});
  check('sin zona en el alta: la pone el sistema (6)', await zona(b.id) === '6', await zona(b.id));
  const c = await mk({ tipo_envio: 'importacion' });
  check('importación UPS desde Polonia: zona 5 (tabla de importación)', await zona(c.id) === '5', await zona(c.id));
  const d = await mk({ courier: 'DHL', servicio_ups: null, numero_guia: '4455667788' });
  check('DHL a Polonia: zona 4', await zona(d.id) === '4', await zona(d.id));

  console.log('\n3. Al cambiar el courier después (el caso de Cueros Santa Cruz)\n');
  const antes = (await J('GET', `/envios/${d.id}`)).body;
  const pt = await J('PATCH', `/salidas/${d.id}`, { courier: 'UPS', servicio_ups: 'UPS_EXP', numero_guia: '1Z327W096790009999' });
  check('pasar el envío de DHL a UPS desde Salidas: 200 y la respuesta trae zona 6', pt.status === 200 && pt.body.zona === 6, JSON.stringify(pt.body));
  const sal = (await J('GET', '/salidas?desde=2026-10-01&hasta=2026-10-31')).body.find((x) => x.id === d.id);
  check('   Salidas muestra zona 6', sal && String(sal.zona) === '6', sal && sal.zona);
  check('   la venta no se movió por eso', cerca(sal.venta_total, antes.total_cobrado), `${sal.venta_total} vs ${antes.total_cobrado}`);
  const pt2 = await J('PATCH', `/salidas/${d.id}`, { observaciones: 'nota' });
  check('una edición que no cambia nada de eso no toca la zona ni la informa', pt2.status === 200 && pt2.body.zona === undefined && await zona(d.id) === '6');
  const put = await J('PUT', `/envios/${b.id}`, { ...(await J('GET', `/envios/${b.id}`)).body, courier: 'DHL', servicio_ups: null, numero_guia: '9988776655' });
  check('editar desde Cargar envío y pasarlo a DHL: zona 4', put.status === 200 && await zona(b.id) === '4', `${put.status} ${await zona(b.id)}`);

  console.log('\n4. La liquidación muestra la zona del servicio\n');
  const liq = (await J('POST', '/liquidaciones', { cliente_id: cli.id, periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', envio_ids: [a.id], confirmar: true })).body;
  check('liquidación confirmada: el ítem dice zona 6', liq.estado === 'confirmada' && String(liq.items[0].zona) === '6', JSON.stringify(liq.items && liq.items[0].zona));

  console.log('\n5. Corrección de arrastre al arrancar (envíos viejos, incluso liquidados)\n');
  const { initDb, getDb } = require('../src/db');
  await initDb(); const db = getDb();
  const fuera = await mk({ pais_destino: 'Narnia', zona: '3', numero_guia: '1Z327W096790008888' });
  await db.prepare("UPDATE envios SET zona = '4' WHERE id = ?").run(a.id);   // liquidado, etiqueta vieja
  await db.prepare('UPDATE envios SET zona = NULL WHERE id = ?').run(c.id);  // sin zona
  const foto = await db.prepare('SELECT flete, fuel, seguro, adicionales, total_cobrado, liquidado, liquidacion_id, updated_at FROM envios WHERE id = ?').get(a.id);
  const itemAntes = await db.prepare('SELECT flete, fuel, seguro, adicional, total_usd FROM liquidacion_items WHERE envio_id = ?').get(a.id);
  s.srv.kill(); await new Promise((r) => setTimeout(r, 600));
  s = await levantar(PORT + 1);
  const B2 = `http://localhost:${PORT + 1}`;
  check('al arrancar avisa en el log qué envíos corrigió', /zona de 2 envío\(s\) puesta al día/.test(s.log()) && new RegExp(`#${a.id} 4→6`).test(s.log()) && new RegExp(`#${c.id} —→5`).test(s.log()), (s.log().match(/Migración: zona[^\n]*/) || [''])[0]);
  const za = (await J('GET', `/envios/${a.id}`, null, B2)).body, zc = (await J('GET', `/envios/${c.id}`, null, B2)).body, zf = (await J('GET', `/envios/${fuera.id}`, null, B2)).body;
  check('el liquidado pasa de 4 a 6 y el vacío a 5', String(za.zona) === '6' && String(zc.zona) === '5', `${za.zona} ${zc.zona}`);
  const foto2 = await db.prepare('SELECT flete, fuel, seguro, adicionales, total_cobrado, liquidado, liquidacion_id, updated_at FROM envios WHERE id = ?').get(a.id);
  const itemDesp = await db.prepare('SELECT flete, fuel, seguro, adicional, total_usd FROM liquidacion_items WHERE envio_id = ?').get(a.id);
  check('   sin tocar NADA de plata del envío liquidado ni de su ítem', JSON.stringify(foto) === JSON.stringify(foto2) && JSON.stringify(itemAntes) === JSON.stringify(itemDesp), JSON.stringify([foto, foto2]));
  check('   el país fuera de las tablas conserva la zona puesta a mano (3)', String(zf.zona) === '3', zf.zona);
  const liq2 = (await J('GET', `/liquidaciones/${liq.id}`, null, B2)).body;
  check('la liquidación ya emitida, al volver a abrirla, muestra zona 6 y el mismo total', String(liq2.items[0].zona) === '6' && cerca(liq2.total, liq.total), JSON.stringify([liq2.items[0].zona, liq2.total]));
  const ExcelJS = require('exceljs');
  const rx = await fetch(`${B2}/api/liquidaciones/${liq.id}/export`, { headers: { Cookie: H.Cookie } });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await rx.arrayBuffer())); const ws = wb.worksheets[0];
  let colZona = 0, filaCab = 0; ws.eachRow((row, i) => row.eachCell((cel, j) => { if (String(cel.value) === 'ZONA') { colZona = j; filaCab = i; } }));
  const zonaExcel = colZona ? String(ws.getRow(filaCab + 1).getCell(colZona).value) : null;
  check('   y el Excel dice ZONA 6', zonaExcel === '6', String(zonaExcel));
  s.srv.kill(); await new Promise((r) => setTimeout(r, 400));
  s = await levantar(PORT + 2);
  check('arrancar de nuevo no vuelve a tocar nada (idempotente)', !/Migración: zona/.test(s.log()));
  s.srv.kill();

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 2500).unref();
})().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
