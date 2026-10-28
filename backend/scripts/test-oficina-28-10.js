#!/usr/bin/env node
/**
 * test-oficina-28-10.js — los pedidos de Felipe del 28/10/2026:
 *
 *   1. "+ matriz" en el cliente SOLO si alguna celda cobra distinto del general y está
 *      vigente (matriz_distintas). Un cliente con todas las celdas iguales al general
 *      cobra un solo % y no tiene que decir "matriz".
 *   2. Salidas: "Profit total" (venta − compra) y, al lado, "Profit flete" = flete de
 *      venta − flete de tabla del courier, sin fuel ni ningún otro concepto.
 *   3. Otros conceptos (concepto + monto, al costo, sin ganancia):
 *      · en la LIQUIDACIÓN: preview, borrador, retomar, confirmar, Excel, total;
 *      · en la COTIZACIÓN: viajan en `entrada.otros_conceptos` y el panel de Cargar envío
 *        los devuelve en `datos.otros_conceptos` para pasarlos como cargos del envío.
 *
 *   cd backend && node scripts/test-oficina-28-10.js
 */
const { spawn } = require('child_process');
const path = require('path');
const ExcelJS = require('exceljs');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3968;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_oficina_28_10.db';
const TOKEN = 'token-test-oficina-2810';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
let matarServidor = () => {};
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else {
    fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`);
  }
}
const cerca = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) < tol;

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
  const matar = () => { if (muerto) return; muerto = true; try { srv.kill(); } catch { /* ya estaba */ } };
  matarServidor = matar;
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));
  const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const J = async (metodo, u, body) => {
    const r = await fetch(BASE + u, { method: metodo, headers: H, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  await run("INSERT INTO clientes (id, nombre, tipo_cobro, tarifa_pct, activo) VALUES (981, 'OFICINA 2810 SA', 'CC', 50, 1)");
  await run("INSERT INTO clientes (id, nombre, tipo_cobro, tarifa_pct, activo) VALUES (982, 'OFICINA 2810 MATRIZ', 'CC', 50, 1)");
  await run("INSERT OR REPLACE INTO configuracion_fuel (courier, fuel_pct) VALUES ('UPS', 20)").catch(() => {});

  // ── 1. "+ matriz" solo si cobra distinto ───────────────────────────────────────────
  console.log('\n1. "+ matriz" solo si alguna celda cobra distinto del general\n');
  const cli = async (id) => (await J('GET', `/api/clientes/${id}`)).body;
  let c = await cli(982);
  check('sin celdas: matriz_celdas 0 y matriz_distintas 0', c.matriz_celdas === 0 && c.matriz_distintas === 0, JSON.stringify([c.matriz_celdas, c.matriz_distintas]));
  // Dos celdas IGUALES al general (50), cargadas desde la pantalla (con fecha).
  let r = await J('PUT', '/api/clientes/982/profit-matrix', { servicio: 'UPS_EXP', tipo: 'export', zona: 1, peso_min: 5, peso_max: 10, profit_pct: 50 });
  check('se carga una celda con el mismo % que el general', r.status < 300, JSON.stringify(r.body));
  await J('PUT', '/api/clientes/982/profit-matrix', { servicio: 'UPS_EXP', tipo: 'export', zona: 2, peso_min: 5, peso_max: 10, profit_pct: 50 });
  c = await cli(982);
  check('dos celdas iguales al general: matriz_celdas 2 pero matriz_distintas 0 (no dice "+ matriz")', c.matriz_celdas === 2 && c.matriz_distintas === 0, JSON.stringify([c.matriz_celdas, c.matriz_distintas]));
  const lista = (await J('GET', '/api/clientes?todos=1')).body.find((x) => x.id === 982);
  check('la lista de clientes trae lo mismo', lista && lista.matriz_distintas === 0 && lista.matriz_celdas === 2, JSON.stringify(lista && [lista.matriz_celdas, lista.matriz_distintas]));
  await J('PUT', '/api/clientes/982/profit-matrix', { servicio: 'UPS_EXP', tipo: 'export', zona: 3, peso_min: 5, peso_max: 10, profit_pct: 70 });
  c = await cli(982);
  check('una celda con 70 (≠ 50): matriz_distintas 1 → "+ matriz"', c.matriz_distintas === 1, String(c.matriz_distintas));
  // Cambiar el general DESPUÉS: con "manda lo último" el 60 pisa todas las celdas → ninguna vigente.
  await new Promise((res) => setTimeout(res, 20));
  r = await J('PUT', '/api/clientes/982', { tarifa_pct: 60 });
  c = await cli(982);
  check('general cambiado después a 60: las 3 celdas quedan pisadas → matriz_distintas 0', c.matriz_distintas === 0 && c.matriz_celdas === 3, JSON.stringify([c.tarifa_pct, c.matriz_celdas, c.matriz_distintas]));
  await new Promise((res) => setTimeout(res, 20));
  await J('PUT', '/api/clientes/982/profit-matrix', { servicio: 'UPS_EXP', tipo: 'export', zona: 3, peso_min: 5, peso_max: 10, profit_pct: 70 });
  c = await cli(982);
  check('se vuelve a cargar la celda de 70 (más nueva que el general): matriz_distintas 1', c.matriz_distintas === 1, String(c.matriz_distintas));
  // Celda vieja (sin fecha, como las de producción) con general sin fecha: cuenta si es distinta.
  await run("UPDATE clientes SET tarifa_pct = 50, tarifa_pct_desde = NULL WHERE id = 982");
  await run("UPDATE profit_overrides SET vigente_desde = NULL WHERE cliente_id = 982");
  c = await cli(982);
  check('celdas y general sin fecha (regla vieja: la celda manda): cuentan solo las distintas (1)', c.matriz_distintas === 1 && c.matriz_celdas === 3, JSON.stringify([c.matriz_celdas, c.matriz_distintas]));

  // ── 2. Salidas: Profit total + Profit flete ───────────────────────────────────────
  console.log('\n2. Salidas: profit_flete = flete de venta − flete de tabla, sin fuel ni nada más\n');
  const alta = await J('POST', '/api/envios', {
    cliente_id: 981, fecha: '2026-10-20', courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion', tipo_paquete: 'm',
    numero_guia: '1Z000OFI28100001', pais_destino: 'Estados Unidos', cantidad_bultos: 1, peso_real: 10, largo: 10, ancho: 10, alto: 10,
    fob: 50, total_cobrado: 200, fuel_pct: 20,
  });
  check('se carga un envío', alta.status === 201, JSON.stringify(alta.body).slice(0, 150));
  const envioId = alta.body.id;
  const fila = await get('SELECT flete, descuento, fuel, seguro, adicionales, derechos, otros, extras_json, fuel_pct FROM envios WHERE id = ?', [envioId]);
  const sal = (await J('GET', '/api/salidas?desde=2026-10-20&hasta=2026-10-20')).body.find((e) => e.id === envioId);
  check('Salidas devuelve profit_flete y venta_desglose', sal && sal.profit_flete != null && sal.venta_desglose && sal.venta_desglose.flete != null, JSON.stringify(sal && { pf: sal.profit_flete, vd: sal.venta_desglose }));
  const esperado = Math.round((sal.venta_desglose.flete - ((Number(fila.flete) || 0) - (Number(fila.descuento) || 0))) * 100) / 100;
  check('profit_flete = flete de venta (desglose) − flete de tabla', cerca(sal.profit_flete, esperado), `${sal.profit_flete} vs ${esperado}`);
  check('es DISTINTO del profit total (que lleva fuel, seguro, surge…)', !cerca(sal.profit_flete, sal.profit_estimado ?? sal.profit), `${sal.profit_flete} vs ${sal.profit_estimado}`);
  check('y menor que el profit total (el fuel sobre la ganancia del flete va en el total, no acá)', sal.profit_flete < (sal.profit_estimado ?? sal.profit), `${sal.profit_flete} < ${sal.profit_estimado}`);
  // Un envío sin precio: profit_flete null (no se inventa).
  const alta0 = await J('POST', '/api/envios', {
    cliente_id: 981, fecha: '2026-10-20', courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion', tipo_paquete: 'm',
    numero_guia: '1Z000OFI28100002', pais_destino: 'Estados Unidos', cantidad_bultos: 1, peso_real: 10, largo: 10, ancho: 10, alto: 10, fob: 50, total_cobrado: 0,
  });
  const sal0 = (await J('GET', '/api/salidas?desde=2026-10-20&hasta=2026-10-20')).body.find((e) => e.id === alta0.body.id);
  check('envío sin precio: profit_flete null', sal0 && sal0.profit_flete == null, JSON.stringify(sal0 && sal0.profit_flete));
  const fs = require('fs');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'pages', 'salidas.html'), 'utf8');
  check('la grilla tiene "Profit total" y "Profit flete" (41 columnas, Resultado estimado de 3)', /Profit total</.test(html) && /data-col="profit_flete"/.test(html) && /thg-resultado" colspan="3"/.test(html) && /colspan="41"/.test(html));

  // ── 3a. Otros conceptos en la liquidación ────────────────────────────────────────
  console.log('\n3a. Otros conceptos en la liquidación\n');
  const conceptos = [{ concepto: 'Encomienda Vía Cargo pagada por Nova (12/10)', monto: 35.5 }, { concepto: 'Embalaje especial', monto: 10 }];
  let prev = await J('POST', '/api/liquidaciones/preview', { cliente_id: 981, envio_ids: [envioId], cargos: [], cotizaciones: [], conceptos });
  check('preview acepta conceptos', prev.status === 200, JSON.stringify(prev.body).slice(0, 200));
  check('los devuelve y suma total_conceptos 45.50', prev.body.conceptos.length === 2 && cerca(prev.body.total_conceptos, 45.5), JSON.stringify(prev.body.conceptos));
  check('total = envíos + conceptos', cerca(prev.body.total, prev.body.total_envios + 45.5), `${prev.body.total} vs ${prev.body.total_envios} + 45.5`);
  check('la utilidad NO los incluye (van al costo)', cerca(prev.body.utilidad_total, prev.body.items.reduce((s, i) => s + (i.utilidad_usd || 0), 0)));
  const malo = await J('POST', '/api/liquidaciones/preview', { cliente_id: 981, envio_ids: [envioId], cargos: [], conceptos: [{ concepto: '', monto: 5 }] });
  check('concepto sin nombre → 400 claro', malo.status === 400 && /nombre/.test(malo.body.error), JSON.stringify(malo.body));
  const malo2 = await J('POST', '/api/liquidaciones/preview', { cliente_id: 981, envio_ids: [envioId], cargos: [], conceptos: [{ concepto: 'X', monto: 0 }] });
  check('monto 0 → 400 claro', malo2.status === 400 && /mayor a cero/.test(malo2.body.error), JSON.stringify(malo2.body));

  const bor = await J('POST', '/api/liquidaciones', { cliente_id: 981, periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', envio_ids: [envioId], cargos: [], conceptos, confirmar: false });
  check('el borrador se crea con los conceptos y el total', bor.status === 201 && bor.body.conceptos.length === 2 && cerca(bor.body.total, prev.body.total), JSON.stringify(bor.body && { t: bor.body.total, c: bor.body.conceptos }));
  const filasC = await all('SELECT concepto, monto FROM liquidacion_conceptos WHERE liquidacion_id = ?', [bor.body.id]);
  check('quedan en liquidacion_conceptos', filasC.length === 2 && cerca(filasC[0].monto, 35.5));
  const obt = (await J('GET', `/api/liquidaciones/${bor.body.id}`)).body;
  check('GET /liquidaciones/:id los devuelve (para retomar el borrador)', obt.conceptos.length === 2 && obt.conceptos[0].concepto === conceptos[0].concepto && cerca(obt.total_conceptos, 45.5), JSON.stringify(obt.conceptos));

  console.log('\n   Excel\n');
  const rx = await fetch(`${BASE}/api/liquidaciones/${bor.body.id}/export`, { headers: H });
  check('exporta', rx.status === 200, String(rx.status));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await rx.arrayBuffer()));
  const ws = wb.getWorksheet('Liquidacion') || wb.worksheets[0];
  const celdas = [];
  ws.eachRow((row) => row.eachCell((cell) => celdas.push({ v: cell.value, r: cell.row, c: cell.col })));
  const textos = celdas.filter((x) => typeof x.v === 'string').map((x) => x.v);
  check('sección OTROS CONCEPTOS con cada concepto por su nombre', textos.includes('OTROS CONCEPTOS') && textos.includes(conceptos[0].concepto) && textos.includes('Embalaje especial'), textos.filter((t) => /CONCEPTO|Encomienda|Embalaje/.test(t)).join(' | '));
  const filaTotalEnvios = celdas.find((x) => x.v === 'TOTAL ENVÍOS');
  const filaTotalConc = celdas.find((x) => x.v === 'TOTAL OTROS CONCEPTOS');
  const filaTotalLiq = celdas.find((x) => x.v === 'TOTAL LIQUIDACIÓN');
  check('la fila TOTAL pasa a TOTAL ENVÍOS y cierra con TOTAL LIQUIDACIÓN', filaTotalEnvios && filaTotalConc && filaTotalLiq);
  const montoConc = filaTotalConc && celdas.find((x) => x.r === filaTotalConc.r && typeof x.v === 'number');
  const montoLiq = filaTotalLiq && celdas.find((x) => x.r === filaTotalLiq.r && typeof x.v === 'number');
  check('TOTAL OTROS CONCEPTOS 45.50 y TOTAL LIQUIDACIÓN = total del borrador', montoConc && cerca(montoConc.v, 45.5) && montoLiq && cerca(montoLiq.v, bor.body.total), JSON.stringify({ c: montoConc && montoConc.v, l: montoLiq && montoLiq.v, t: bor.body.total }));

  console.log('\n   Borrar y confirmar\n');
  const del = await J('DELETE', `/api/liquidaciones/${bor.body.id}`);
  const quedan = await get('SELECT COUNT(*) n FROM liquidacion_conceptos WHERE liquidacion_id = ?', [bor.body.id]);
  check('borrar el borrador borra sus conceptos', del.status < 300 && quedan.n === 0, JSON.stringify({ s: del.status, n: quedan.n }));
  const conf = await J('POST', '/api/liquidaciones', { cliente_id: 981, periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31', envio_ids: [envioId], cargos: [], conceptos, confirmar: true });
  check('confirmada directa con conceptos: total incluye los 45.50', conf.status === 201 && conf.body.estado === 'confirmada' && cerca(conf.body.total, prev.body.total), JSON.stringify(conf.body && { e: conf.body.estado, t: conf.body.total }));
  const liqRow = await get('SELECT total FROM liquidaciones WHERE id = ?', [conf.body.id]);
  check('liquidaciones.total (lo que va a la cuenta corriente) también', cerca(liqRow.total, prev.body.total), String(liqRow.total));
  // Solo conceptos, sin envíos ni cargos: se puede (la encomienda del mes de un cliente sin envíos).
  const solo = await J('POST', '/api/liquidaciones/preview', { cliente_id: 981, envio_ids: [], cargos: [], conceptos: [{ concepto: 'Encomiendas del mes', monto: 80 }] });
  check('liquidación SOLO de conceptos: preview ok, total 80', solo.status === 200 && cerca(solo.body.total, 80) && solo.body.items.length === 0, JSON.stringify(solo.body && { s: solo.status, t: solo.body.total }));
  const nada = await J('POST', '/api/liquidaciones/preview', { cliente_id: 981, envio_ids: [], cargos: [], conceptos: [] });
  check('sin nada sigue cortando', nada.status === 400 && /nada para liquidar/.test(nada.body.error));

  // ── 3b. Otros conceptos en la cotización ─────────────────────────────────────────
  console.log('\n3b. Otros conceptos en la cotización → panel de Cargar envío\n');
  const otros = [{ concepto: 'Encomienda pagada por Nova', monto: 25 }];
  const ctz = await J('POST', '/api/cotizaciones', {
    cliente_id: 981, pais: 'Estados Unidos', tipo_envio: 'exportacion', contenido: 'paquete',
    zona: '2', peso_facturable: 10, cantidad_bultos: 1, valor_declarado: 50, viaja_al_cliente: 1,
    entrada: { bultos: [{ pr: 10, l: 10, a: 10, al: 10, pv: 0.2, pf: 10 }], ganancia_pct: 50, fuel_fuente: 'manual', otros_conceptos: otros },
    opciones: [{ viaja: 1, servicio: 'UPS Worldwide Expedited', total: 225, pf: 10, zona: 2, costo: 100, extras: [['Encomienda pagada por Nova', 25]] }],
  });
  check('se guarda la cotización con otros_conceptos en la entrada', ctz.status === 201, JSON.stringify(ctz.body).slice(0, 120));
  const rec = (await J('GET', '/api/cotizaciones/cliente/981/recientes')).body;
  const q = rec.find((x) => x.id === ctz.body.id);
  check('el panel los devuelve en datos.otros_conceptos (nombre + monto)', q && Array.isArray(q.datos.otros_conceptos) && q.datos.otros_conceptos.length === 1 && q.datos.otros_conceptos[0].concepto === 'Encomienda pagada por Nova' && q.datos.otros_conceptos[0].monto === 25, JSON.stringify(q && q.datos));
  check('el total de la opción sigue siendo el que vio el cliente (225, con el concepto adentro)', q && q.opciones_resumen[0].total === 225);
  const ctz2 = await J('POST', '/api/cotizaciones', {
    cliente_id: 981, pais: 'Estados Unidos', tipo_envio: 'exportacion', contenido: 'paquete', zona: '2', peso_facturable: 10, cantidad_bultos: 1, valor_declarado: 50, viaja_al_cliente: 1,
    entrada: { bultos: [] }, opciones: [{ viaja: 1, servicio: 'UPS Worldwide Expedited', total: 200, pf: 10, zona: 2 }],
  });
  const q2 = (await J('GET', '/api/cotizaciones/cliente/981/recientes')).body.find((x) => x.id === ctz2.body.id);
  check('una cotización sin conceptos trae la lista vacía', q2 && Array.isArray(q2.datos.otros_conceptos) && q2.datos.otros_conceptos.length === 0);
  // El cargo que Cargar envío agrega al guardar el envío: al costo, con nombre, entra en la liquidación.
  const cargo = await J('POST', `/api/salidas/${envioId}/cargos`, { tipo: 'otro', label: 'Encomienda pagada por Nova', monto: 25, fecha: '2026-10-20' });
  check('el cargo "otro" con el nombre del concepto se agrega al envío (es lo que hace Cargar envío al guardar)', cargo.status === 201 && cargo.body.label === 'Encomienda pagada por Nova', JSON.stringify(cargo.body));
  const sal2 = (await J('GET', '/api/salidas?desde=2026-10-20&hasta=2026-10-20')).body.find((e) => e.id === envioId);
  check('en Salidas suma a la venta y a la compra: el profit total no cambia', sal2 && cerca(sal2.venta_total, sal.venta_total + 25) && cerca(sal2.profit_estimado, sal.profit_estimado), JSON.stringify({ v: [sal.venta_total, sal2.venta_total], p: [sal.profit_estimado, sal2.profit_estimado] }));
  check('y el profit flete tampoco', cerca(sal2.profit_flete, sal.profit_flete));

  matar();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => {}, 200).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exitCode = 1; matarServidor(); });
