// Cuenta corriente por cliente (módulo Cobranzas). Diseño: COBRANZAS-DISENO.md.
//
// Dos libros por cliente: CF (con factura, pesos) y SF (sin factura, dólares). Cada
// movimiento es una fila de cc_comprobantes; el signo lo da el tipo (FA/LQ/ND débito,
// NC/RC/AC crédito). `saldo` es lo que falta cancelar de un débito y se recalcula desde
// las imputaciones de recibos (etapa 2). Etapa 1 = débitos automáticos desde la
// liquidación confirmada + consultas de saldos, pendientes e historial.
const { getDb } = require('../db');
const { hoyLocal } = require('../utils/fecha');

const DEBITOS = ['FA', 'LQ', 'ND'];
const CREDITOS = ['NC', 'RC', 'AC'];
const LIBROS = ['CF', 'SF'];
const MONEDA_LIBRO = { CF: 'ARS', SF: 'USD' };

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// TC del día (o el último cargado antes de esa fecha). null si no hay ninguno.
async function tipoCambioPara(fecha, db = getDb()) {
  return db.prepare(
    'SELECT * FROM cc_tipo_cambio WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1'
  ).get(fecha);
}

function equivalentes(moneda, importe, tc) {
  if (!tc) return { importe_usd: moneda === 'USD' ? importe : null, importe_ars: moneda === 'ARS' ? importe : null };
  return moneda === 'USD'
    ? { importe_usd: importe, importe_ars: r2(importe * tc) }
    : { importe_usd: r2(importe / tc), importe_ars: importe };
}

// Débito LQ por una liquidación confirmada. Se llama DENTRO de la transacción que
// confirma (recibe el db de la transacción). Idempotente por liquidacion_id.
async function registrarDebitoLiquidacion(db, liquidacionId, { usuario } = {}) {
  const ya = await db.prepare('SELECT id FROM cc_comprobantes WHERE liquidacion_id = ?').get(liquidacionId);
  if (ya) return ya.id;
  const liq = await db.prepare(
    `SELECT l.*, c.libro_default, c.plazo_pago_dias, c.tipo_cambio AS tc_pref
     FROM liquidaciones l JOIN clientes c ON c.id = l.cliente_id WHERE l.id = ?`
  ).get(liquidacionId);
  if (!liq || liq.estado !== 'confirmada') return null;

  const libro = LIBROS.includes(liq.libro_default) ? liq.libro_default : 'SF';
  const moneda = liq.moneda || 'USD';
  const fecha = liq.fecha_confirmacion || hoyLocal();
  const plazo = Number(liq.plazo_pago_dias) || 0;
  const venc = (await db.prepare("SELECT date(?, '+' || ? || ' days') AS v").get(fecha, plazo)).v;
  const tcRow = await tipoCambioPara(fecha, db);
  const tc = tcRow ? (liq.tc_pref === 'promedio' ? tcRow.promedio : tcRow.venta) : null;
  const eq = equivalentes(moneda, liq.total, tc);

  const res = await db.prepare(
    `INSERT INTO cc_comprobantes (cliente_id, libro, tipo, numero, fecha, vencimiento, moneda,
       importe, tc_dia, importe_usd, importe_ars, saldo, liquidacion_id, descripcion, origen, creado_por)
     VALUES (?, ?, 'LQ', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sistema', ?)`
  ).run(
    liq.cliente_id, libro, `LQ-${liq.id}`, fecha, venc, moneda,
    liq.total, tc, eq.importe_usd, eq.importe_ars, liq.total, liq.id,
    `Liquidación #${liq.id} (${liq.periodo_desde} a ${liq.periodo_hasta})`, usuario || null
  );
  return res.lastInsertRowid;
}

// Comprobante manual (FA, ND, NC o ajuste). NC/ND con referencia_id a la FA/LQ que corrigen.
async function crearComprobante({
  cliente_id, libro, tipo, letra = null, punto_venta = null, numero = null, fecha, moneda,
  importe, referencia_id = null, descripcion = null, origen = 'sistema', usuario = null,
}) {
  const db = getDb();
  if (!LIBROS.includes(libro)) throw Object.assign(new Error('libro inválido'), { status: 400 });
  if (!['FA', 'ND', 'NC', 'AC'].includes(tipo)) throw Object.assign(new Error('tipo inválido para carga manual'), { status: 400 });
  const cli = await db.prepare('SELECT plazo_pago_dias, tipo_cambio FROM clientes WHERE id = ?').get(cliente_id);
  if (!cli) throw Object.assign(new Error('Cliente inexistente'), { status: 404 });
  moneda = moneda || MONEDA_LIBRO[libro];
  const plazo = Number(cli.plazo_pago_dias) || 0;
  const venc = DEBITOS.includes(tipo)
    ? (await db.prepare("SELECT date(?, '+' || ? || ' days') AS v").get(fecha, plazo)).v
    : null;
  const tcRow = await tipoCambioPara(fecha, db);
  const tc = tcRow ? (cli.tipo_cambio === 'promedio' ? tcRow.promedio : tcRow.venta) : null;
  const eq = equivalentes(moneda, importe, tc);

  return db.transaction(async () => {
    const res = await db.prepare(
      `INSERT INTO cc_comprobantes (cliente_id, libro, tipo, letra, punto_venta, numero, fecha, vencimiento,
         moneda, importe, tc_dia, importe_usd, importe_ars, saldo, referencia_id, descripcion, origen, creado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(cliente_id, libro, tipo, letra, punto_venta, numero, fecha, venc, moneda, importe, tc,
      eq.importe_usd, eq.importe_ars, DEBITOS.includes(tipo) ? importe : 0, referencia_id,
      descripcion, origen, usuario);
    // Una NC con referencia baja el saldo de la factura que corrige.
    if (tipo === 'NC' && referencia_id) {
      await db.prepare(
        'UPDATE cc_comprobantes SET saldo = MAX(0, saldo - ?) WHERE id = ? AND tipo IN (\'FA\',\'LQ\',\'ND\')'
      ).run(importe, referencia_id);
    }
    return res.lastInsertRowid;
  });
}

// Pantalla 1: saldo por cliente en los dos libros + antigüedad + último reclamo.
async function saldosPorCliente({ libro = null, soloConSaldo = true, tipo_cobro = null } = {}) {
  const db = getDb();
  const hoy = hoyLocal();
  const rows = await db.prepare(
    `SELECT c.id AS cliente_id, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente, c.tipo_cobro,
            c.plazo_pago_dias,
            SUM(CASE WHEN cc.libro='CF' AND cc.tipo IN ('FA','LQ','ND') THEN cc.saldo ELSE 0 END) AS saldo_cf,
            SUM(CASE WHEN cc.libro='SF' AND cc.tipo IN ('FA','LQ','ND') THEN cc.saldo ELSE 0 END) AS saldo_sf,
            SUM(CASE WHEN cc.libro='CF' AND cc.tipo='AC' THEN cc.saldo ELSE 0 END) AS a_favor_cf,
            SUM(CASE WHEN cc.libro='SF' AND cc.tipo='AC' THEN cc.saldo ELSE 0 END) AS a_favor_sf,
            SUM(CASE WHEN cc.tipo IN ('FA','LQ','ND') AND cc.saldo > 0.005 THEN 1 ELSE 0 END) AS abiertos,
            MIN(CASE WHEN cc.tipo IN ('FA','LQ','ND') AND cc.saldo > 0.005 THEN cc.fecha END) AS fecha_mas_vieja,
            MIN(CASE WHEN cc.tipo IN ('FA','LQ','ND') AND cc.saldo > 0.005 THEN cc.vencimiento END) AS vencimiento_mas_viejo,
            (SELECT r.fecha || ' · ' || COALESCE(r.usuario,'') FROM cc_reclamos r WHERE r.cliente_id = c.id ORDER BY r.fecha DESC, r.id DESC LIMIT 1) AS ultimo_reclamo,
            (SELECT COUNT(*) FROM cc_cheques ch WHERE ch.cliente_id = c.id AND ch.estado = 'recibido') AS cheques_en_cartera
     FROM clientes c
     LEFT JOIN cc_comprobantes cc ON cc.cliente_id = c.id AND cc.anulado_at IS NULL
       ${libro ? 'AND cc.libro = ?' : ''}
     WHERE 1=1 ${tipo_cobro ? 'AND c.tipo_cobro = ?' : ''}
     GROUP BY c.id
     ORDER BY cliente COLLATE NOCASE`
  ).all(...[libro, tipo_cobro].filter(Boolean));
  const out = rows.map((r) => {
    const dias = (f) => (f ? Math.floor((new Date(hoy) - new Date(f)) / 86400000) : null);
    return {
      ...r,
      saldo_cf: r2(r.saldo_cf), saldo_sf: r2(r.saldo_sf),
      a_favor_cf: r2(r.a_favor_cf), a_favor_sf: r2(r.a_favor_sf),
      antiguedad_dias: dias(r.fecha_mas_vieja),
      dias_vencido: r.vencimiento_mas_viejo && r.vencimiento_mas_viejo < hoy ? dias(r.vencimiento_mas_viejo) : 0,
    };
  });
  return soloConSaldo ? out.filter((r) => r.saldo_cf > 0.005 || r.saldo_sf > 0.005 || r.a_favor_cf > 0.005 || r.a_favor_sf > 0.005) : out;
}

// Pantalla 3: débitos abiertos del cliente, por libro, con envíos que los componen.
async function pendientesCliente(clienteId) {
  const db = getDb();
  const hoy = hoyLocal();
  const rows = await db.prepare(
    `SELECT cc.*,
            (SELECT COUNT(*) FROM liquidacion_items li WHERE li.liquidacion_id = cc.liquidacion_id) AS envios
     FROM cc_comprobantes cc
     WHERE cc.cliente_id = ? AND cc.anulado_at IS NULL
       AND ((cc.tipo IN ('FA','LQ','ND') AND cc.saldo > 0.005) OR (cc.tipo = 'AC' AND cc.saldo > 0.005))
     ORDER BY cc.libro, cc.fecha, cc.id`
  ).all(clienteId);
  const porLibro = { CF: [], SF: [] };
  for (const r of rows) {
    const mora = r.vencimiento && r.vencimiento < hoy ? Math.floor((new Date(hoy) - new Date(r.vencimiento)) / 86400000) : 0;
    porLibro[r.libro].push({ ...r, mora_dias: mora });
  }
  const tot = (arr) => r2(arr.filter((x) => DEBITOS.includes(x.tipo)).reduce((a, x) => a + x.saldo, 0)
    - arr.filter((x) => x.tipo === 'AC').reduce((a, x) => a + x.saldo, 0));
  return { CF: porLibro.CF, SF: porLibro.SF, saldo_cf: tot(porLibro.CF), saldo_sf: tot(porLibro.SF) };
}

// Pantalla 2: historial completo con débito / crédito / saldo acumulado.
async function historialCliente(clienteId, { libro = null, desde = null, hasta = null, incluirAnulados = false } = {}) {
  const db = getDb();
  const params = [clienteId];
  let where = 'cc.cliente_id = ?';
  if (!incluirAnulados) where += ' AND cc.anulado_at IS NULL';
  if (libro) { where += ' AND cc.libro = ?'; params.push(libro); }
  if (desde) { where += ' AND cc.fecha >= ?'; params.push(desde); }
  if (hasta) { where += ' AND cc.fecha <= ?'; params.push(hasta); }
  const rows = await db.prepare(
    `SELECT cc.*, ref.tipo AS ref_tipo, ref.numero AS ref_numero
     FROM cc_comprobantes cc LEFT JOIN cc_comprobantes ref ON ref.id = cc.referencia_id
     WHERE ${where} ORDER BY cc.libro, cc.fecha, cc.id`
  ).all(...params);
  const acum = { CF: 0, SF: 0 };
  return rows.map((r) => {
    const debito = DEBITOS.includes(r.tipo) ? r.importe : 0;
    const credito = CREDITOS.includes(r.tipo) ? r.importe : 0;
    if (!r.anulado_at) acum[r.libro] = r2(acum[r.libro] + debito - credito);
    return { ...r, debito, credito, acumulado: acum[r.libro] };
  });
}

async function obtenerComprobante(id) {
  return getDb().prepare('SELECT * FROM cc_comprobantes WHERE id = ?').get(id);
}

// Tipo de cambio: alta/actualización de un día.
async function guardarTipoCambio({ fecha, compra = null, venta = null, promedio = null, fuente = 'manual' }) {
  const db = getDb();
  if (promedio == null && compra != null && venta != null) promedio = r2((Number(compra) + Number(venta)) / 2);
  await db.prepare(
    `INSERT INTO cc_tipo_cambio (fecha, compra, venta, promedio, fuente) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(fecha) DO UPDATE SET compra = excluded.compra, venta = excluded.venta,
       promedio = excluded.promedio, fuente = excluded.fuente`
  ).run(fecha, compra, venta, promedio, fuente);
  return db.prepare('SELECT * FROM cc_tipo_cambio WHERE fecha = ?').get(fecha);
}

async function listarTipoCambio(limit = 60) {
  return getDb().prepare('SELECT * FROM cc_tipo_cambio ORDER BY fecha DESC LIMIT ?').all(limit);
}

module.exports = {
  DEBITOS, CREDITOS, LIBROS, MONEDA_LIBRO,
  registrarDebitoLiquidacion, crearComprobante, saldosPorCliente, pendientesCliente,
  historialCliente, obtenerComprobante, tipoCambioPara, guardarTipoCambio, listarTipoCambio,
};
