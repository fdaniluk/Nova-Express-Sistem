// Pagos que entraron solos (Mercado Pago; después Galicia). 24/09/2026.
//
// Circuito que pidió Felipe: el sistema AVISA y SUGIERE → la oficina REVISA y lo pasa →
// Marcelo APRUEBA. Nada se aplica solo.
//   1. Entra el movimiento (mercadopago.service) → pagos_entrantes, estado 'nuevo'.
//   2. Este modelo sugiere de qué cliente es y a qué deuda iría.
//   3. La oficina abre la sugerencia, corrige si hace falta y guarda → se crea el recibo
//      INFORMADO (recibos.model.cargarPago con entrante_id) y el entrante pasa a 'revisado'.
//   4. Marcelo lo confirma en su bandeja (el mismo circuito de siempre).
// Si el recibo se elimina, el entrante vuelve a 'nuevo' para revisarlo de nuevo.
const { getDb } = require('../db');
const { tipoCambioPara } = require('./cuenta-corriente.model');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const soloDigitos = (s) => String(s || '').replace(/\D/g, '');
const ahora = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });

// ── ¿De quién es? ───────────────────────────────────────────────────────────────────
// 1) Una cuenta ya aprendida (cliente_cuentas). 2) El CUIT de alguna razón social o de la
// ficha del cliente. Si hay más de un cliente con ese CUIT no adivina.
async function clientePorCuit(cuit, db = getDb()) {
  const c = soloDigitos(cuit);
  if (c.length < 7) return null;
  const aprendida = await db.prepare(
    `SELECT cc.cliente_id AS id, COALESCE(NULLIF(cl.nombre_nova,''), cl.nombre) AS nombre, 'cuenta conocida' AS por
     FROM cliente_cuentas cc JOIN clientes cl ON cl.id = cc.cliente_id WHERE cc.cuit = ?`
  ).get(c);
  if (aprendida) return aprendida;
  const rows = await db.prepare(
    `SELECT DISTINCT cl.id, COALESCE(NULLIF(cl.nombre_nova,''), cl.nombre) AS nombre
     FROM clientes cl LEFT JOIN clientes_razones_sociales rs ON rs.cliente_id = cl.id AND rs.activa = 1
     WHERE REPLACE(REPLACE(REPLACE(COALESCE(rs.cuit,''),'-',''),' ',''),'.','') = ?
        OR REPLACE(REPLACE(REPLACE(COALESCE(cl.cuit,''),'-',''),' ',''),'.','') = ?`
  ).all(c, c);
  if (rows.length === 1) return { ...rows[0], por: 'CUIT de la ficha' };
  return null;
}

// ── ¿A qué deuda iría? ──────────────────────────────────────────────────────────────
// Libro: si paga en pesos y tiene deuda con factura, CF; si no, SF (dólares, con el TC del
// día). Dentro del libro: si el importe coincide con una deuda (±1 % en SF por el TC), esa;
// si no, las más viejas primero hasta cubrir el pago. Es SOLO una sugerencia.
async function sugerirImputacion(clienteId, entrante, db = getDb()) {
  const abiertos = await db.prepare(
    `SELECT id, libro, tipo, numero, fecha, saldo, liquidacion_id, descripcion
     FROM cc_comprobantes WHERE cliente_id = ? AND anulado_at IS NULL AND tipo IN ('FA','LQ','ND') AND saldo > 0.005
     ORDER BY fecha, id`
  ).all(clienteId);
  // Lo que ya está reservado por otros pagos informados no se vuelve a sugerir.
  for (const a of abiertos) {
    const res = (await db.prepare(
      `SELECT COALESCE(SUM(i.importe),0) AS s FROM cc_recibo_imputaciones i
       JOIN cc_recibos r ON r.id = i.recibo_id JOIN cc_comprobantes rc ON rc.id = r.comprobante_id
       WHERE i.comprobante_id = ? AND i.estado = 'pendiente_valor' AND rc.anulado_at IS NULL`
    ).get(a.id)).s;
    a.disponible = r2(a.saldo - res);
  }
  const vivos = abiertos.filter((a) => a.disponible > 0.005);
  const cf = vivos.filter((a) => a.libro === 'CF');
  const sf = vivos.filter((a) => a.libro === 'SF');
  let libro;
  if (entrante.moneda === 'USD') libro = 'SF';
  else libro = cf.length || !sf.length ? 'CF' : 'SF';
  const deudas = libro === 'CF' ? cf : sf;

  let tc = null;
  let totalLibro = entrante.importe;
  if ((libro === 'SF' && entrante.moneda === 'ARS') || (libro === 'CF' && entrante.moneda === 'USD')) {
    const row = await tipoCambioPara(entrante.fecha, db);
    tc = row ? (row.venta || row.promedio) : null;
    totalLibro = tc ? r2(libro === 'SF' ? entrante.importe / tc : entrante.importe * tc) : null;
  }
  if (!deudas.length) return { libro, tc, imputaciones: [], motivo: 'No tiene deuda abierta: quedaría todo a favor.' };
  if (totalLibro == null) return { libro, tc: null, imputaciones: [], motivo: 'Paga en pesos y la deuda es en dólares: falta el tipo de cambio del día para sugerir.' };

  const tolerancia = libro === 'SF' && tc ? Math.max(0.01, totalLibro * 0.01) : 0.01;
  const exacta = deudas.find((d) => Math.abs(d.disponible - totalLibro) <= tolerancia);
  const ref = (d) => (d.tipo === 'LQ' && d.liquidacion_id ? `Liquidación #${d.liquidacion_id}` : `${d.tipo} ${d.numero || ''}`.trim());
  if (exacta) {
    return { libro, tc, imputaciones: [{ comprobante_id: exacta.id, importe: r2(Math.min(exacta.disponible, totalLibro)), ref: ref(exacta) }],
      motivo: `El importe coincide con ${ref(exacta)}.` };
  }
  let resto = totalLibro;
  const imps = [];
  for (const d of deudas) {
    if (resto <= 0.005) break;
    const imp = r2(Math.min(d.disponible, resto));
    imps.push({ comprobante_id: d.id, importe: imp, ref: ref(d) });
    resto = r2(resto - imp);
  }
  return { libro, tc, imputaciones: imps,
    motivo: `No coincide con ninguna deuda: se sugiere cancelar las más viejas primero${resto > 0.005 ? ' y el resto queda a favor' : ''}.` };
}

async function conSugerencia(e, db = getDb()) {
  let cliente = null;
  if (e.cliente_id) {
    cliente = await db.prepare(`SELECT id, COALESCE(NULLIF(nombre_nova,''), nombre) AS nombre, 'elegido por la oficina' AS por FROM clientes WHERE id = ?`).get(e.cliente_id);
  } else {
    cliente = await clientePorCuit(e.cuit_emisor, db);
  }
  const sug = cliente ? await sugerirImputacion(cliente.id, e, db) : null;
  const { crudo, ...resto } = e;
  return { ...resto, cliente_sugerido: cliente, sugerencia: sug };
}

async function listar({ estado = 'nuevo', limite = 200 } = {}) {
  const db = getDb();
  const rows = await db.prepare(
    `SELECT * FROM pagos_entrantes WHERE estado = ? ORDER BY fecha DESC, id DESC LIMIT ${Number(limite)}`
  ).all(estado);
  const out = [];
  for (const e of rows) out.push(await conSugerencia(e, db));
  return out;
}

async function obtener(id, db = getDb()) {
  return db.prepare('SELECT * FROM pagos_entrantes WHERE id = ?').get(id);
}

async function sugerencia(id) {
  const e = await obtener(id);
  if (!e) throw err('Movimiento inexistente', 404);
  return conSugerencia(e);
}

// La oficina dice de qué cliente es (cuando el sistema no lo reconoció o se equivocó).
async function asignarCliente(id, clienteId) {
  const db = getDb();
  const e = await obtener(id, db);
  if (!e) throw err('Movimiento inexistente', 404);
  if (e.estado !== 'nuevo') throw err('Ese movimiento ya se revisó', 409);
  const c = await db.prepare('SELECT id FROM clientes WHERE id = ?').get(clienteId);
  if (!c) throw err('Cliente inexistente', 404);
  await db.prepare('UPDATE pagos_entrantes SET cliente_id = ? WHERE id = ?').run(clienteId, id);
  return sugerencia(id);
}

// No es plata de un cliente (reintegro, cobro de UPS, movimiento propio…).
async function descartar(id, motivo, usuario) {
  const db = getDb();
  motivo = String(motivo || '').trim();
  if (motivo.length < 3) throw err('Escribí por qué se descarta');
  const e = await obtener(id, db);
  if (!e) throw err('Movimiento inexistente', 404);
  if (e.estado !== 'nuevo') throw err('Ese movimiento ya se revisó', 409);
  await db.prepare(`UPDATE pagos_entrantes SET estado = 'descartado', descartado_por = ?, descartado_motivo = ?, descartado_at = ? WHERE id = ?`)
    .run(usuario ? usuario.usuario : null, motivo, ahora(), id);
  return obtener(id, db);
}

async function reabrir(id) {
  await getDb().prepare(`UPDATE pagos_entrantes SET estado = 'nuevo', descartado_por = NULL, descartado_motivo = NULL, descartado_at = NULL WHERE id = ? AND estado = 'descartado'`).run(id);
  return obtener(id);
}

// ── Enganches con recibos.model ─────────────────────────────────────────────────────
// Al revisar: el recibo informado queda atado al movimiento y el CUIT se aprende.
async function marcarRevisado(db, entranteId, reciboId, clienteId, usuario) {
  const e = await obtener(entranteId, db);
  const u = await db.prepare(`UPDATE pagos_entrantes SET estado = 'revisado', recibo_id = ?, cliente_id = ? WHERE id = ? AND estado = 'nuevo'`).run(reciboId, clienteId, entranteId);
  if (!u.changes) throw err('Otra persona ya revisó ese movimiento', 409);
  const cuit = soloDigitos(e && e.cuit_emisor);
  if (cuit.length >= 7) {
    await db.prepare(
      `INSERT OR IGNORE INTO cliente_cuentas (cliente_id, cuit, nombre, origen, vinculada_por) VALUES (?, ?, ?, ?, ?)`
    ).run(clienteId, cuit, e.nombre_emisor || null, e.fuente, usuario ? usuario.usuario : null);
  }
}

// Al eliminar el recibo: el movimiento vuelve a la lista para revisarlo de nuevo.
async function liberarPorRecibo(db, reciboId) {
  await db.prepare(`UPDATE pagos_entrantes SET estado = 'nuevo', recibo_id = NULL WHERE recibo_id = ?`).run(reciboId);
}

async function contar() {
  const r = await getDb().prepare(`SELECT COUNT(*) AS n FROM pagos_entrantes WHERE estado = 'nuevo'`).get();
  return r.n;
}

module.exports = {
  listar, obtener, sugerencia, asignarCliente, descartar, reabrir, marcarRevisado, liberarPorRecibo,
  clientePorCuit, sugerirImputacion, contar,
};
