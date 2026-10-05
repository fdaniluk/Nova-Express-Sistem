// Liquidación SOLO de cargos de envíos anteriores (05/10/2026). Pedido de Felipe: el envío
// fue en julio, el extracargo llegó en agosto y en agosto el cliente no tuvo envíos → se
// tiene que poder armar una liquidación únicamente con esos cargos. Y en pantalla y en el
// Excel tiene que quedar claro de qué envío es, la fecha del envío y qué cargo es.
// Corre sobre una COPIA de la base (nunca la real).
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-solocargos-'));
fs.copyFileSync(path.join(__dirname, '..', '..', 'database', 'nova.db'), path.join(tmp, 'nova.db'));
process.env.DB_PATH = path.join(tmp, 'nova.db');
const assert = require('assert');
const ExcelJS = require('exceljs');
const { initDb, getDb } = require('../src/db');
const C = require('../src/models/envio-cargos.model');
const L = require('../src/models/liquidacion.model');
const E = require('../src/models/envio.model');
const excel = require('../src/services/excel.service');
const u = { id: 4, usuario: 'leandro' };

let ok = 0; let fail = 0;
function check(nombre, cond, det) {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fail++; console.log(`  ✗ ${nombre}${det ? '  → ' + det : ''}`); }
}

(async () => {
  await initDb();
  const db = getDb();

  // Un cliente SIN envíos pendientes y con al menos un envío liquidado en confirmada.
  const cli = await db.prepare(`
    SELECT c.id, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS nombre
    FROM clientes c
    WHERE NOT EXISTS (SELECT 1 FROM envios e WHERE e.cliente_id = c.id AND e.liquidado = 0 AND e.no_volo = 0)
      AND EXISTS (SELECT 1 FROM envios e JOIN liquidaciones l ON l.id = e.liquidacion_id WHERE e.cliente_id = c.id AND e.liquidado = 1 AND l.estado = 'confirmada')
      AND NOT EXISTS (SELECT 1 FROM envio_cargos x JOIN envios e ON e.id = x.envio_id WHERE e.cliente_id = c.id AND x.liquidacion_id IS NULL AND x.anulado_at IS NULL)
    ORDER BY c.id LIMIT 1`).get();
  assert(cli, 'no hay cliente para probar');
  const viejo = await db.prepare(`SELECT e.id, e.numero_guia, e.fecha, e.pais_destino, e.liquidacion_id FROM envios e JOIN liquidaciones l ON l.id = e.liquidacion_id
    WHERE e.cliente_id = ? AND e.liquidado = 1 AND l.estado = 'confirmada' ORDER BY e.fecha LIMIT 1`).get(cli.id);
  console.log('cliente', cli.id, cli.nombre, '| envío viejo', viejo.numero_guia, viejo.fecha, 'liq#', viejo.liquidacion_id);

  console.log('\n1. Sin nada pendiente, no se puede liquidar\n');
  await assert.rejects(L.preview({ cliente_id: cli.id, envio_ids: [] }), /nada para liquidar/);
  check('preview sin envíos y sin cargos → error claro', true);
  const g0 = (await E.listarPendientesPorCliente({ cliente_id: cli.id }));
  check('no aparece en pendientes', g0.length === 0, JSON.stringify(g0));

  console.log('\n2. Llegan dos cargos a un envío ya liquidado\n');
  const c1 = await C.agregar(viejo.id, { tipo: 'sobrepeso', monto: 12.5, fecha: '2026-08-15' }, u);
  const c2 = await C.agregar(viejo.id, { tipo: 'ddp', monto: 40, fecha: '2026-08-20' }, u);
  check('quedan pendientes', c1.estado === 'pendiente' && c2.estado === 'pendiente');
  check('rótulo: qué cargo, cuándo se informó, de qué envío', C.rotulo({ ...c1, numero_guia: viejo.numero_guia, envio_fecha: viejo.fecha }, { conEnvio: true }) === `Sobrepeso · informado el 15/08/2026 · envío ${viejo.numero_guia} del ${C.fechaCorta(viejo.fecha)}`, C.rotulo({ ...c1, numero_guia: viejo.numero_guia, envio_fecha: viejo.fecha }, { conEnvio: true }));

  const g1 = await E.listarPendientesPorCliente({ cliente_id: cli.id });
  check('Pendientes lo lista aunque no tenga envíos (grupo solo-cargos)', g1.length === 1 && g1[0].solo_cargos === true && g1[0].envios.length === 0, JSON.stringify(g1).slice(0, 200));
  check('el grupo trae los cargos con guía, fecha del envío, país y concepto', g1[0].cargos_anteriores.length === 2 && g1[0].cargos_anteriores[0].numero_guia === viejo.numero_guia && g1[0].cargos_anteriores[0].envio_fecha === viejo.fecha && g1[0].cargos_anteriores[0].label === 'Sobrepeso' && g1[0].cargos_anteriores[0].fecha === '2026-08-15' && g1[0].cargos_anteriores[0].liquidacion_original_id === viejo.liquidacion_id, JSON.stringify(g1[0].cargos_anteriores));
  check('contador y total', g1[0].cargos_anteriores_n === 2 && g1[0].cargos_anteriores_total === 52.5);
  const gAll = await E.listarPendientesPorCliente({});
  const pos = gAll.findIndex((g) => g.cliente_id === cli.id);
  check('en la lista general también está, ordenado por nombre', pos >= 0 && (pos === 0 || String(gAll[pos - 1].cliente_nombre).localeCompare(cli.nombre, 'es', { sensitivity: 'base' }) <= 0), `pos ${pos}`);

  console.log('\n3. Vista previa y borrador sin envíos\n');
  const p = await L.preview({ cliente_id: cli.id, envio_ids: [] });
  check('preview: 0 ítems, 2 cargos, total = cargos', p.items.length === 0 && p.cargos_anteriores.length === 2 && p.total_envios === 0 && p.total === 52.5, JSON.stringify({ t: p.total, te: p.total_envios }));
  check('cada cargo trae guía, fecha, país y liquidación original', p.cargos_anteriores.every((c) => c.numero_guia === viejo.numero_guia && c.envio_fecha === viejo.fecha && c.pais_destino === viejo.pais_destino && c.liquidacion_original_id === viejo.liquidacion_id));
  const b = await L.crear({ cliente_id: cli.id, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-31', envio_ids: [] });
  check('se crea el borrador con total 52.5 y sin ítems', b.estado === 'borrador' && b.total === 52.5 && b.items.length === 0 && b.cargos_anteriores.length === 2);
  check('los cargos quedan atados al borrador', (await C.obtener(c1.id)).liquidacion_id === b.id && (await C.obtener(c2.id)).liquidacion_id === b.id);
  const g2 = await E.listarPendientesPorCliente({ cliente_id: cli.id });
  check('mientras están en el borrador, salen de pendientes', g2.length === 0);

  console.log('\n4. Excel\n');
  const buf = await excel.exportarLiquidacion(b);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Liquidacion');
  const textos = [];
  ws.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === 'string') textos.push(cell.value); }));
  const t = textos.join('\n');
  check('dice que no hay envíos y manda a la sección de cargos', /Sin envíos en este período/.test(t), t.slice(0, 300));
  check('sección CARGOS DE ENVÍOS ANTERIORES con la aclaración de que es solo cargos', /CARGOS DE ENVÍOS ANTERIORES/.test(t) && /no incluye envíos/.test(t));
  check('concepto completo: cargo, cuándo se informó, destino y liquidación original', textos.some((x) => x === `Sobrepeso · informado el 15/08/2026 · envío a ${viejo.pais_destino}, cobrado en la liquidación #${viejo.liquidacion_id}`), textos.filter((x) => /Sobrepeso/.test(x)).join(' | '));
  check('la guía del envío está en su columna', textos.includes(viejo.numero_guia));
  check('TOTAL LIQUIDACIÓN', /TOTAL LIQUIDACIÓN/.test(t));

  console.log('\n5. Confirmar\n');
  const conf = await L.confirmar(b.id, [], u.usuario);
  check('se confirma', conf.estado === 'confirmada' && conf.total === 52.5);
  check('los cargos quedan liquidados', (await C.obtener(c1.id)).estado === 'liquidado');
  const cc = await db.prepare('SELECT importe FROM cc_comprobantes WHERE liquidacion_id = ?').get(b.id);
  check('cuenta corriente: débito por 52.5', cc && Math.abs(cc.importe - 52.5) < 0.01, JSON.stringify(cc));
  const g3 = await E.listarPendientesPorCliente({ cliente_id: cli.id });
  check('ya no hay nada pendiente', g3.length === 0);

  console.log('\n6. Con envíos de la misma liquidación, el cargo también se rotula completo\n');
  const otro = await db.prepare(`SELECT e.id, e.cliente_id, e.numero_guia FROM envios e WHERE e.liquidado = 0 AND e.no_volo = 0 AND e.total_cobrado > 0 ORDER BY e.id DESC LIMIT 1`).get();
  const c3 = await C.agregar(otro.id, { tipo: 'remota', monto: 9, fecha: '2026-09-02' }, u);
  const p2 = await L.preview({ cliente_id: otro.cliente_id, envio_ids: [otro.id] });
  const det = p2.items[0].adicional_detalle.find((d) => d.monto === 9);
  check('detalle del ítem: "Área remota · informado el 02/09/2026"', det && det.label === 'Área remota · informado el 02/09/2026', JSON.stringify(p2.items[0].adicional_detalle));
  await C.anular(c3.id, u);

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('✗', e); process.exit(1); });
