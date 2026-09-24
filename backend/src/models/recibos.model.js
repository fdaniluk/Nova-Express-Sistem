// Cobranzas — entrega 3: cargar pago, confirmar y eliminar (24/09/2026).
// Diseño: AUDITORIA-GECOM-Y-REDISENO-COBRANZAS.md §4.2, §4.3 y §4.5.
//
// Decisiones de Felipe (24/09):
//  · La imputación la elige la persona a mano (a qué liquidación/factura va cada peso).
//    El sistema no propone nada; lo que no se imputa queda A FAVOR del cliente (AC).
//  · Solo confirma quien tiene `confirmar_pagos` (Marcelo). Si lo carga él, queda
//    confirmado de una; si lo carga otro, queda INFORMADO y va a la bandeja.
//  · Transferencia (y Mercado Pago): comprobante adjunto obligatorio.
//
// Cómo se guarda un pago:
//  · cc_comprobantes tipo RC (el crédito en la cuenta, importe en la moneda del libro,
//    saldo 0) + cc_recibos (estado, número interno, talonario) + cc_recibo_valores (con
//    qué pagó: una o más líneas) + cc_recibo_imputaciones (a qué débito va cada importe).
//  · Mientras está INFORMADO, las imputaciones quedan 'pendiente_valor' y NO bajan el
//    saldo de nada: la deuda sigue hasta que Marcelo confirma. Al confirmar pasan a
//    'aplicada', baja el saldo de cada débito y el resto se vuelve un AC a favor.
//  · Eliminar NUNCA borra: anula el RC con motivo, revierte imputaciones (la deuda
//    vuelve), anula el AC del resto y los cheques. Queda todo en la base.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('../db');
const config = require('../config');
const { hoyLocal } = require('../utils/fecha');
const entrantes = require('./entrantes.model');

const MEDIOS = ['efectivo', 'transferencia', 'cheque', 'mercadopago', 'otro'];
const MEDIOS_CON_COMPROBANTE = ['transferencia', 'mercadopago'];
const MONEDA_LIBRO = { CF: 'ARS', SF: 'USD' };
const TIPOS_ADJUNTO = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic' };

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const ahora = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' }).replace('T', ' ');

function dirAdjuntos() {
  return config.adjuntosDir || path.join(path.dirname(config.dbPath), 'adjuntos');
}

// Guarda el archivo en disco y devuelve la ruta relativa que va a la base.
function guardarAdjunto(file) {
  const ext = TIPOS_ADJUNTO[file.mimetype];
  if (!ext) throw err('El comprobante tiene que ser PDF o imagen (JPG, PNG)');
  const mes = hoyLocal().slice(0, 7);
  const rel = path.join('cobranzas', mes, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  const abs = path.join(dirAdjuntos(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, file.buffer);
  return rel.split(path.sep).join('/');
}

function rutaAdjunto(rel) {
  const base = path.resolve(dirAdjuntos());
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base + path.sep)) throw err('Ruta inválida', 400);
  return abs;
}

// Convierte un valor a la moneda del libro. Si las monedas no coinciden hace falta el TC.
function aMonedaLibro(importe, monedaValor, monedaLibro, tc) {
  if (monedaValor === monedaLibro) return r2(importe);
  if (!(tc > 0)) throw err(`El pago tiene valores en ${monedaValor} y el libro es en ${monedaLibro}: falta el tipo de cambio`);
  return monedaLibro === 'ARS' ? r2(importe * tc) : r2(importe / tc);
}

// ── Cargar ──────────────────────────────────────────────────────────────────────────
// datos: { cliente_id, libro, fecha, tc_pago, numero_talonario, observaciones,
//          valores: [{ medio, moneda, importe, banco, numero, fecha_vto, cuit_emisor, adjunto }],
//          imputaciones: [{ comprobante_id, importe }] }
// archivos: { [adjunto]: multerFile } — cada valor apunta a su archivo por nombre de campo.
async function cargarPago(datos, archivos, usuario) {
  const db = getDb();
  const clienteId = Number(datos.cliente_id);
  const cli = await db.prepare('SELECT id FROM clientes WHERE id = ?').get(clienteId);
  if (!cli) throw err('Cliente inexistente', 404);
  const libro = datos.libro;
  if (!MONEDA_LIBRO[libro]) throw err('libro debe ser CF o SF');
  const monedaLibro = MONEDA_LIBRO[libro];
  // Pago que entró solo (Mercado Pago / banco): el "con qué pagó" lo manda el movimiento,
  // no la pantalla, y el comprobante es el propio movimiento (no hace falta adjunto).
  let entrante = null;
  if (datos.entrante_id) {
    entrante = await entrantes.obtener(Number(datos.entrante_id), db);
    if (!entrante) throw err('Movimiento inexistente', 404);
    if (entrante.estado !== 'nuevo') throw err('Ese movimiento ya se revisó', 409);
    datos.valores = [{ medio: entrante.fuente === 'mercadopago' ? 'mercadopago' : 'transferencia', moneda: entrante.moneda,
      importe: entrante.importe, cuit_emisor: entrante.cuit_emisor, numero: `${entrante.fuente}:${entrante.id_externo}` }];
    datos.fecha = entrante.fecha; // la fecha del pago es la del movimiento
  }

  const fecha = String(datos.fecha || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw err('Fecha inválida');
  if (fecha > hoyLocal()) throw err('La fecha del pago no puede ser futura');
  const tc = datos.tc_pago != null && datos.tc_pago !== '' ? Number(datos.tc_pago) : null;

  const valores = Array.isArray(datos.valores) ? datos.valores : [];
  if (!valores.length) throw err('Falta con qué pagó (al menos un valor)');
  let total = 0;
  const vals = valores.map((v, i) => {
    const medio = v.medio;
    if (!MEDIOS.includes(medio)) throw err(`Valor ${i + 1}: medio inválido`);
    const moneda = v.moneda;
    if (!['ARS', 'USD'].includes(moneda)) throw err(`Valor ${i + 1}: moneda inválida`);
    const importe = r2(v.importe);
    if (!(importe > 0)) throw err(`Valor ${i + 1}: el importe tiene que ser mayor a 0`);
    const file = v.adjunto ? archivos[v.adjunto] : null;
    if (MEDIOS_CON_COMPROBANTE.includes(medio) && !file && !entrante) throw err(`Valor ${i + 1}: la ${medio === 'mercadopago' ? 'transferencia de Mercado Pago' : 'transferencia'} necesita el comprobante adjunto`);
    if (medio === 'cheque' && (!v.banco || !v.numero || !v.fecha_vto)) throw err(`Valor ${i + 1}: el cheque necesita banco, número y fecha de cobro`);
    const enLibro = aMonedaLibro(importe, moneda, monedaLibro, tc);
    total = r2(total + enLibro);
    return { medio, moneda, importe, en_libro: enLibro, banco: v.banco || null, numero: v.numero || null,
      fecha_vto: v.fecha_vto || null, cuit_emisor: v.cuit_emisor || null, file };
  });

  // Imputación manual: cada débito tiene que ser del cliente, del mismo libro, estar vivo
  // y no recibir más de lo que debe. La suma no puede pasar el total del pago.
  const imps = [];
  let imputado = 0;
  for (const im of (Array.isArray(datos.imputaciones) ? datos.imputaciones : [])) {
    const importe = r2(im.importe);
    if (!(importe > 0)) continue;
    const c = await db.prepare('SELECT * FROM cc_comprobantes WHERE id = ?').get(Number(im.comprobante_id));
    if (!c || Number(c.cliente_id) !== clienteId || c.libro !== libro || c.anulado_at || !['FA', 'LQ', 'ND'].includes(c.tipo)) {
      throw err('Una de las deudas elegidas no es de este cliente o de este libro');
    }
    // Lo que ya está comprometido por otros pagos informados (sin confirmar) también cuenta.
    const comprometido = (await db.prepare(
      `SELECT COALESCE(SUM(i.importe),0) AS s FROM cc_recibo_imputaciones i
       JOIN cc_recibos r ON r.id = i.recibo_id JOIN cc_comprobantes rc ON rc.id = r.comprobante_id
       WHERE i.comprobante_id = ? AND i.estado = 'pendiente_valor' AND rc.anulado_at IS NULL`
    ).get(c.id)).s;
    const disponible = r2(c.saldo - comprometido);
    if (importe > disponible + 0.005) {
      throw err(`${c.numero || c.tipo} debe ${disponible.toFixed(2)}${comprometido > 0.005 ? ' (descontando otro pago sin confirmar)' : ''}: no se le pueden aplicar ${importe.toFixed(2)}`);
    }
    imps.push({ comprobante_id: c.id, importe });
    imputado = r2(imputado + importe);
  }
  if (imputado > total + 0.005) throw err(`Se aplican ${imputado.toFixed(2)} y el pago es de ${total.toFixed(2)}`);

  const talonario = datos.numero_talonario ? String(datos.numero_talonario).trim() : null;
  if (talonario) {
    const ya = await db.prepare(
      `SELECT r.id FROM cc_recibos r JOIN cc_comprobantes rc ON rc.id = r.comprobante_id
       WHERE r.numero_talonario = ? AND rc.anulado_at IS NULL`
    ).get(talonario);
    if (ya) throw err(`El recibo de talonario ${talonario} ya está cargado`);
  }

  const confirma = usuario && usuario.confirmar_pagos === 1;
  // Los archivos se escriben antes de la transacción; si algo falla después quedan
  // huérfanos en disco pero nunca hay un pago en la base sin su comprobante.
  for (const v of vals) v.adjunto_rel = v.file ? guardarAdjunto(v.file) : null;

  return db.transaction(async () => {
    const num = (await db.prepare('SELECT COALESCE(MAX(numero_sistema),0) + 1 AS n FROM cc_recibos').get()).n;
    const rs = await db.prepare('SELECT id FROM clientes_razones_sociales WHERE cliente_id = ? AND activa = 1 ORDER BY principal DESC, id LIMIT 1').get(clienteId);
    const medios = [...new Set(vals.map((v) => v.medio))].join(' + ');
    const rc = await db.prepare(
      `INSERT INTO cc_comprobantes (cliente_id, razon_social_id, libro, tipo, numero, fecha, moneda, importe, tc_dia,
         importe_usd, importe_ars, saldo, descripcion, origen, creado_por)
       VALUES (?, ?, ?, 'RC', ?, ?, ?, ?, ?, ?, ?, 0, ?, 'sistema', ?)`
    ).run(clienteId, rs ? rs.id : null, libro, `RC-${num}`, fecha, monedaLibro, total, tc,
      monedaLibro === 'USD' ? total : (tc ? r2(total / tc) : null),
      monedaLibro === 'ARS' ? total : (tc ? r2(total * tc) : null),
      `Pago ${medios}${talonario ? ` · talonario ${talonario}` : ''}`, usuario ? usuario.usuario : null);
    const rcId = rc.lastInsertRowid;
    const rec = await db.prepare(
      `INSERT INTO cc_recibos (comprobante_id, numero_sistema, numero_talonario, cobrador_id, estado, confirmado_por,
         confirmado_at, moneda_pago, tc_pago, total, observaciones)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(rcId, num, talonario, usuario ? usuario.id : null, confirma ? 'confirmado' : 'informado',
      confirma ? usuario.usuario : null, confirma ? ahora() : null,
      vals.length === 1 ? vals[0].moneda : 'mixto', tc, total, datos.observaciones || null);
    const reciboId = rec.lastInsertRowid;

    for (const v of vals) {
      const rv = await db.prepare(
        `INSERT INTO cc_recibo_valores (recibo_id, medio, moneda, importe, banco, numero, fecha_vto, cuit_emisor, comprobante_adjunto)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(reciboId, v.medio, v.moneda, v.importe, v.banco, v.numero, v.fecha_vto, v.cuit_emisor, v.adjunto_rel);
      if (v.medio === 'cheque') {
        const ch = await db.prepare(
          `INSERT INTO cc_cheques (cliente_id, recibo_valor_id, banco, numero, fecha_emision, fecha_vto, importe, moneda, cuit_emisor, estado)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recibido')`
        ).run(clienteId, rv.lastInsertRowid, v.banco, v.numero, fecha, v.fecha_vto, v.importe, v.moneda, v.cuit_emisor);
        await db.prepare('UPDATE cc_recibo_valores SET cheque_id = ? WHERE id = ?').run(ch.lastInsertRowid, rv.lastInsertRowid);
      }
    }
    for (const im of imps) {
      await db.prepare('INSERT INTO cc_recibo_imputaciones (recibo_id, comprobante_id, importe, estado) VALUES (?, ?, ?, ?)')
        .run(reciboId, im.comprobante_id, im.importe, confirma ? 'aplicada' : 'pendiente_valor');
    }
    if (entrante) await entrantes.marcarRevisado(db, entrante.id, reciboId, clienteId, usuario);
    if (confirma) await aplicar(db, reciboId, usuario);
    return reciboId;
  });
}

// Baja los saldos de lo imputado y deja el resto a favor. Se llama dentro de la transacción.
async function aplicar(db, reciboId, usuario) {
  const r = await db.prepare(
    `SELECT r.*, rc.cliente_id, rc.libro, rc.fecha, rc.moneda, rc.razon_social_id, rc.numero AS rc_numero
     FROM cc_recibos r JOIN cc_comprobantes rc ON rc.id = r.comprobante_id WHERE r.id = ?`
  ).get(reciboId);
  const imps = await db.prepare('SELECT * FROM cc_recibo_imputaciones WHERE recibo_id = ? AND estado IN (\'aplicada\',\'pendiente_valor\')').all(reciboId);
  let imputado = 0;
  for (const im of imps) {
    const c = await db.prepare('SELECT id, numero, tipo, saldo, anulado_at FROM cc_comprobantes WHERE id = ?').get(im.comprobante_id);
    if (!c || c.anulado_at) throw err(`La deuda ${c ? c.numero : im.comprobante_id} fue anulada: corregí el pago antes de confirmarlo`, 409);
    if (im.importe > c.saldo + 0.005) throw err(`${c.numero || c.tipo} ya debe solo ${Number(c.saldo).toFixed(2)} (se cobró por otro lado): no se le pueden aplicar ${im.importe.toFixed(2)}`, 409);
    await db.prepare('UPDATE cc_comprobantes SET saldo = MAX(0, ROUND(saldo - ?, 2)) WHERE id = ?').run(im.importe, c.id);
    await db.prepare('UPDATE cc_recibo_imputaciones SET estado = \'aplicada\' WHERE id = ?').run(im.id);
    imputado = r2(imputado + im.importe);
  }
  const resto = r2(r.total - imputado);
  if (resto > 0.005) {
    await db.prepare(
      `INSERT INTO cc_comprobantes (cliente_id, razon_social_id, libro, tipo, numero, fecha, moneda, importe, saldo,
         referencia_id, descripcion, origen, creado_por)
       VALUES (?, ?, ?, 'AC', ?, ?, ?, ?, ?, ?, ?, 'sistema', ?)`
    ).run(r.cliente_id, r.razon_social_id, r.libro, `AC-${r.numero_sistema}`, r.fecha, r.moneda, resto, resto,
      r.comprobante_id, `A favor: resto sin aplicar del ${r.rc_numero}`, usuario ? usuario.usuario : null);
  }
}

// ── Confirmar ───────────────────────────────────────────────────────────────────────
async function confirmarPago(reciboId, usuario) {
  const db = getDb();
  const r = await obtenerRecibo(reciboId);
  if (!r) throw err('Pago inexistente', 404);
  if (r.anulado_at) throw err('Ese pago está eliminado', 409);
  if (r.estado === 'confirmado') throw err('Ese pago ya está confirmado', 409);
  await db.transaction(async () => {
    await aplicar(db, reciboId, usuario);
    await db.prepare('UPDATE cc_recibos SET estado = \'confirmado\', confirmado_por = ?, confirmado_at = ? WHERE id = ?')
      .run(usuario.usuario, ahora(), reciboId);
  });
  return obtenerRecibo(reciboId);
}

// ── Eliminar (anular con motivo) ────────────────────────────────────────────────────
async function eliminarPago(reciboId, motivo, usuario) {
  const db = getDb();
  motivo = String(motivo || '').trim();
  if (motivo.length < 3) throw err('Escribí el motivo');
  const r = await obtenerRecibo(reciboId);
  if (!r) throw err('Pago inexistente', 404);
  if (r.anulado_at) throw err('Ese pago ya está eliminado', 409);
  const puedeConfirmar = usuario && usuario.confirmar_pagos === 1;
  if (r.estado === 'confirmado' && !puedeConfirmar) throw err('Un pago confirmado solo lo puede eliminar quien confirma pagos', 403);
  if (r.estado === 'informado' && !puedeConfirmar && Number(r.cobrador_id) !== Number(usuario.id)) {
    throw err('Solo quien lo cargó (o quien confirma pagos) puede eliminar este pago', 403);
  }
  await db.transaction(async () => {
    const ac = await db.prepare('SELECT * FROM cc_comprobantes WHERE referencia_id = ? AND tipo = \'AC\' AND anulado_at IS NULL').get(r.comprobante_id);
    if (ac && ac.saldo < ac.importe - 0.005) throw err('El saldo a favor que dejó este pago ya se usó en otra deuda: primero hay que deshacer eso', 409);
    const imps = await db.prepare('SELECT * FROM cc_recibo_imputaciones WHERE recibo_id = ? AND estado != \'revertida\'').all(reciboId);
    for (const im of imps) {
      if (im.estado === 'aplicada') await db.prepare('UPDATE cc_comprobantes SET saldo = ROUND(saldo + ?, 2) WHERE id = ?').run(im.importe, im.comprobante_id);
      await db.prepare('UPDATE cc_recibo_imputaciones SET estado = \'revertida\' WHERE id = ?').run(im.id);
    }
    const marca = [ahora(), usuario.usuario, motivo];
    if (ac) await db.prepare('UPDATE cc_comprobantes SET anulado_at = ?, anulado_por = ?, anulado_motivo = ?, saldo = 0 WHERE id = ?').run(...marca, ac.id);
    await db.prepare('UPDATE cc_comprobantes SET anulado_at = ?, anulado_por = ?, anulado_motivo = ? WHERE id = ?').run(...marca, r.comprobante_id);
    await entrantes.liberarPorRecibo(db, reciboId);
    await db.prepare(
      `UPDATE cc_cheques SET estado = 'anulado', estado_at = ?, estado_por = ?
       WHERE recibo_valor_id IN (SELECT id FROM cc_recibo_valores WHERE recibo_id = ?)`
    ).run(ahora(), usuario.usuario, reciboId);
  });
  return obtenerRecibo(reciboId);
}

// ── Lecturas ────────────────────────────────────────────────────────────────────────
async function obtenerRecibo(reciboId) {
  const db = getDb();
  const r = await db.prepare(
    `SELECT r.*, rc.cliente_id, rc.libro, rc.fecha, rc.moneda, rc.numero AS rc_numero, rc.anulado_at, rc.anulado_por,
            rc.anulado_motivo, rc.creado_por, rc.creado_at, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente
     FROM cc_recibos r JOIN cc_comprobantes rc ON rc.id = r.comprobante_id JOIN clientes c ON c.id = rc.cliente_id
     WHERE r.id = ?`
  ).get(reciboId);
  if (!r) return null;
  r.valores = await db.prepare('SELECT id, medio, moneda, importe, banco, numero, fecha_vto, cuit_emisor, (comprobante_adjunto IS NOT NULL) AS tiene_adjunto FROM cc_recibo_valores WHERE recibo_id = ? ORDER BY id').all(reciboId);
  r.imputaciones = await db.prepare(
    `SELECT i.id, i.comprobante_id, i.importe, i.estado, c.tipo, c.numero, c.fecha, c.importe AS importe_comprobante, c.liquidacion_id
     FROM cc_recibo_imputaciones i JOIN cc_comprobantes c ON c.id = i.comprobante_id WHERE i.recibo_id = ? ORDER BY c.fecha, c.id`
  ).all(reciboId);
  r.entrante = await db.prepare('SELECT id, fuente, id_externo, fecha, nombre_emisor, cuit_emisor, referencia FROM pagos_entrantes WHERE recibo_id = ?').get(reciboId) || null;
  r.a_favor = r2(r.total - r.imputaciones.filter((i) => i.estado !== 'revertida').reduce((a, i) => a + i.importe, 0));
  return r;
}

async function listar(where, params, limite = 200) {
  const ids = await getDb().prepare(
    `SELECT r.id FROM cc_recibos r JOIN cc_comprobantes rc ON rc.id = r.comprobante_id
     WHERE ${where} ORDER BY rc.fecha DESC, r.id DESC LIMIT ${Number(limite)}`
  ).all(...params);
  const out = [];
  for (const { id } of ids) out.push(await obtenerRecibo(id));
  return out;
}

// Bandeja: los informados que esperan confirmación (los más viejos primero).
async function bandeja() {
  const lista = await listar('r.estado = \'informado\' AND rc.anulado_at IS NULL', [], 500);
  return lista.reverse();
}

// Pagos del cliente para la ficha (incluye eliminados para verlos tachados si se pide).
async function pagosCliente(clienteId, { incluirEliminados = false } = {}) {
  return listar(`rc.cliente_id = ? ${incluirEliminados ? '' : 'AND rc.anulado_at IS NULL'}`, [clienteId], 100);
}

async function adjuntoDeValor(valorId) {
  const v = await getDb().prepare('SELECT comprobante_adjunto FROM cc_recibo_valores WHERE id = ?').get(valorId);
  if (!v || !v.comprobante_adjunto) return null;
  return rutaAdjunto(v.comprobante_adjunto);
}

module.exports = {
  MEDIOS, cargarPago, confirmarPago, eliminarPago, obtenerRecibo, bandeja, pagosCliente, adjuntoDeValor,
};
