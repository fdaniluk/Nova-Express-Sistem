// Cargos posteriores (25/09/2026): extracargos desde Salidas + impuestos DDP en la
// liquidación. Corre sobre una COPIA de la base (nunca la real).
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cargos-'));
fs.copyFileSync(path.join(__dirname, '..', '..', 'database', 'nova.db'), path.join(tmp, 'nova.db'));
process.env.DB_PATH = path.join(tmp, 'nova.db');
const assert = require('assert');
const { initDb, getDb } = require('../src/db');
const C = require('../src/models/envio-cargos.model');
const L = require('../src/models/liquidacion.model');
const excel = require('../src/services/excel.service');
const r2 = (n) => Math.round(n * 100) / 100;
const u = { id: 4, usuario: 'leandro' };

(async () => {
  await initDb();
  const db = getDb();

  // Un cliente con >= 2 envíos sin liquidar y al menos 1 liquidado en confirmada.
  const cli = await db.prepare(`
    SELECT c.id, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS nombre,
      (SELECT COUNT(*) FROM envios e WHERE e.cliente_id = c.id AND e.liquidado = 0 AND e.no_volo = 0 AND e.total_cobrado > 0) AS pend,
      (SELECT COUNT(*) FROM envios e JOIN liquidaciones l ON l.id = e.liquidacion_id WHERE e.cliente_id = c.id AND e.liquidado = 1 AND l.estado = 'confirmada') AS liq
    FROM clientes c WHERE pend >= 2 AND liq >= 1 ORDER BY pend DESC LIMIT 1`).get();
  assert(cli, 'no hay cliente para probar');
  const pend = await db.prepare('SELECT id, numero_guia, total_cobrado FROM envios WHERE cliente_id = ? AND liquidado = 0 AND no_volo = 0 AND total_cobrado > 0 ORDER BY fecha LIMIT 2').all(cli.id);
  const viejo = await db.prepare('SELECT e.id, e.numero_guia, e.liquidacion_id FROM envios e JOIN liquidaciones l ON l.id = e.liquidacion_id WHERE e.cliente_id = ? AND e.liquidado = 1 AND l.estado = \'confirmada\' LIMIT 1').get(cli.id);
  console.log('cliente', cli.id, cli.nombre, '| pendientes', pend.map((e) => e.numero_guia).join(','), '| viejo', viejo.numero_guia, 'liq#', viejo.liquidacion_id);

  // Base sin cargos
  const ids = pend.map((e) => e.id);
  const p0 = await L.preview({ cliente_id: cli.id, envio_ids: ids });
  assert.equal(p0.cargos_anteriores.length, 0);
  assert.equal(p0.total, p0.total_envios);

  // 1) Validaciones del alta
  await assert.rejects(C.agregar(pend[0].id, { tipo: 'manejo', monto: 0 }, u), /mayor a cero/);
  await assert.rejects(C.agregar(pend[0].id, { tipo: 'otro', monto: 10 }, u), /nombre/);
  await assert.rejects(C.agregar(pend[0].id, { tipo: 'zzz', monto: 10 }, u), /inválido/);

  // 2) Cargo manual a un envío SIN liquidar → entra en su ítem, al costo
  const c1 = await C.agregar(pend[0].id, { tipo: 'sobrepeso', monto: 12.5 }, u);
  assert.equal(c1.estado, 'pendiente'); assert.equal(c1.label, 'Sobrepeso');
  const c2 = await C.agregar(pend[0].id, { tipo: 'otro', label: 'Reempaque', monto: 7 }, u);
  // 3) Impuestos DDP a un envío YA liquidado → cargo de envío anterior
  const ri = await C.registrarImpuestos(db, viejo.id, 33.4, '2026-09-20');
  assert.equal(ri.accion, 'creado');
  const ri2 = await C.registrarImpuestos(db, viejo.id, 35, '2026-09-21'); // recarga: actualiza
  assert.equal(ri2.accion, 'actualizado');
  assert.equal((await C.obtener(ri.cargo_id)).monto, 35);

  const p1 = await L.preview({ cliente_id: cli.id, envio_ids: ids, cargos: [{ envio_id: pend[1].id, monto: 5, descripcion: 'Cargo adicional' }] });
  const it0 = p1.items.find((i) => i.envio_id === pend[0].id);
  const it1 = p1.items.find((i) => i.envio_id === pend[1].id);
  const it0base = p0.items.find((i) => i.envio_id === pend[0].id);
  assert.equal(it0.total_usd, r2(it0base.total_usd + 19.5), 'cargo posterior suma al total del ítem');
  assert.equal(it0.adicional, r2(it0base.adicional + 19.5));
  assert.equal(it0.utilidad_usd, it0base.utilidad_usd, 'al costo: la utilidad no cambia');
  assert(it0.adicional_detalle.some((d) => d.label === 'Sobrepeso' && d.monto === 12.5));
  assert(it0.adicional_detalle.some((d) => d.label === 'Reempaque' && d.monto === 7));
  assert.equal(it1.total_usd, r2(p0.items.find((i) => i.envio_id === pend[1].id).total_usd + 5), 'el adicional manual de la fila sigue funcionando');
  assert.equal(p1.cargos_anteriores.length, 1);
  assert.equal(p1.cargos_anteriores[0].numero_guia, viejo.numero_guia);
  assert.equal(p1.total_cargos_anteriores, 35);
  assert.equal(p1.total, r2(p1.total_envios + 35));
  console.log('preview ok: total envíos', p1.total_envios, '+ anteriores 35 =', p1.total);

  // 4) Borrador: los cargos quedan atados; se sueltan al borrar el borrador
  const b = await L.crear({ cliente_id: cli.id, periodo_desde: '2026-01-01', periodo_hasta: '2026-12-31', envio_ids: ids, cargos: [{ envio_id: pend[1].id, monto: 5, descripcion: 'Cargo adicional' }] });
  assert.equal(b.estado, 'borrador');
  assert.equal(b.total, p1.total);
  assert.equal(b.cargos_anteriores.length, 1);
  assert.equal((await C.obtener(c1.id)).liquidacion_id, b.id);
  assert.equal((await C.obtener(ri.cargo_id)).liquidacion_id, b.id);
  const bi0 = b.items.find((i) => i.envio_id === pend[0].id);
  assert(bi0.adicional_detalle.some((d) => d.label === 'Sobrepeso'), 'buscarPorId rotula el cargo');
  assert(!(await db.prepare("SELECT 1 FROM cargos_adicionales WHERE liquidacion_id = ? AND envio_id = ? AND descripcion = 'Cargo adicional'").get(b.id, pend[0].id)), 'sin fila espejo cuando el adicional es un cargo posterior');
  await assert.rejects(C.anular(c1.id, u), /borrador/);
  // Excel con la sección
  const buf = await excel.exportarLiquidacion(b);
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Liquidacion'); const textos = [];
  ws.eachRow((row) => row.eachCell((c) => { if (typeof c.value === 'string') textos.push(c.value); }));
  assert(textos.includes('CARGOS DE ENVÍOS ANTERIORES')); assert(textos.includes('TOTAL LIQUIDACIÓN')); assert(textos.includes('TOTAL ENVÍOS'));
  assert(textos.includes('Impuestos de destino (DDP)'));
  fs.writeFileSync(path.join(tmp, 'liq.xlsx'), buf);
  console.log('excel ok →', path.join(tmp, 'liq.xlsx'));

  // 5) Entra un cargo nuevo después del borrador → confirmar corta con 409
  const c3 = await C.agregar(pend[1].id, { tipo: 'remota', monto: 20 }, u);
  await assert.rejects(L.confirmar(b.id, ids, 'leandro'), (e) => e.status === 409 && /Calcular de nuevo/.test(e.message));
  // Anular el nuevo y volver a probar → confirma
  await C.anular(c3.id, u);
  assert.equal((await C.obtener(c3.id)).estado, 'anulado');
  await L.eliminarBorrador(b.id);
  assert.equal((await C.obtener(c1.id)).liquidacion_id, null, 'borrar el borrador suelta los cargos');
  assert.equal((await C.obtener(ri.cargo_id)).liquidacion_id, null);
  await C.anular(c2.id, u);

  const conf = await L.crear({ cliente_id: cli.id, periodo_desde: '2026-01-01', periodo_hasta: '2026-12-31', envio_ids: ids, confirmar: true, usuario: 'leandro' });
  assert.equal(conf.estado, 'confirmada');
  assert.equal(conf.total_cargos_anteriores, 35);
  assert.equal(conf.total, r2(conf.total_envios + 35));
  const ci0 = conf.items.find((i) => i.envio_id === pend[0].id);
  assert.equal(ci0.total_usd, r2(it0base.total_usd + 12.5));
  assert.equal((await C.obtener(c1.id)).estado, 'liquidado');
  assert.equal((await C.obtener(ri.cargo_id)).estado, 'liquidado');
  await assert.rejects(C.anular(c1.id, u), /confirmada/);
  // Cuenta corriente: el débito es por el total con cargos
  const deb = await db.prepare('SELECT importe FROM cc_comprobantes WHERE liquidacion_id = ?').get(conf.id);
  assert.equal(r2(deb.importe), conf.total, 'cc debita el total completo');
  // Los impuestos ya cobrados no se pisan si se recarga la factura con otro monto
  const ri3 = await C.registrarImpuestos(db, viejo.id, 40, '2026-09-22');
  assert.equal(ri3.accion, 'ya_liquidado');
  // Un cargo nuevo sobre un envío recién liquidado queda pendiente para la próxima
  const c4 = await C.agregar(pend[0].id, { tipo: 'manejo', monto: 3 }, u);
  const p2 = await L.preview({ cliente_id: cli.id, envio_ids: (await db.prepare('SELECT id FROM envios WHERE cliente_id = ? AND liquidado = 0 AND no_volo = 0 AND total_cobrado > 0 LIMIT 1').all(cli.id)).map((e) => e.id) }).catch(() => null);
  if (p2) { assert.equal(p2.cargos_anteriores.length, 1); assert.equal(p2.cargos_anteriores[0].id, c4.id); }
  const envioModel = require('../src/models/envio.model');
  const grupos = await envioModel.listarPendientesPorCliente({ cliente_id: cli.id });
  if (grupos.length) assert.equal(grupos[0].cargos_anteriores_total, 3);
  console.log('confirmada ok: liq#', conf.id, 'total', conf.total, '| cc', deb.importe);
  console.log('TODO OK');
  process.exit(0);
})().catch((e) => { console.error('FALLÓ:', e); process.exit(1); });
