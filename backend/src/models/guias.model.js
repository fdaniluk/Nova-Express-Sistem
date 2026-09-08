// Guías emitidas desde el sistema (guías, etapa 2 — 08/09/2026, GUIAS-UPS.md 3-bis).
//
// Una guía nace acá, con guía UPS + proforma, y queda como PRECARGA (estado 'emitida')
// hasta que la oficina la confirma desde Cargar envío, que crea el envío de siempre y
// marca la guía 'confirmada' (envio.model.crear con guia_id). Mientras es precarga no
// existe en Salidas, liquidaciones, cierre ni facturas: no hay envío.
const { getDb } = require('../db');
const ups = require('../services/ups-shipping.service');
const { hoyLocal } = require('../utils/fecha');

const SIN_BLOBS = `g.id, g.cliente_id, g.destinatario_id, g.fecha, g.courier, g.servicio, g.cuenta, g.entorno,
  g.numero_guia, g.estado, g.ddp, g.fob, g.contenido, g.proforma_numero, g.datos_json, g.cargo_ups,
  g.envio_id, g.usuario, g.nota, g.created_at, g.updated_at, g.anulada_at,
  (g.etiqueta_gif IS NOT NULL) AS tiene_etiqueta,
  COALESCE(NULLIF(c.nombre_nova, ''), c.nombre) AS cliente_nombre,
  d.nombre AS destinatario_nombre, d.ciudad AS destinatario_ciudad, d.pais AS destinatario_pais`;

const FROM = `FROM guias g
  JOIN clientes c ON c.id = g.cliente_id
  LEFT JOIN destinatarios d ON d.id = g.destinatario_id`;

function mapGuia(row) {
  if (!row) return null;
  let datos = {};
  try { datos = JSON.parse(row.datos_json || '{}'); } catch { datos = {}; }
  const { datos_json, ...resto } = row;
  return {
    ...resto,
    ddp: Boolean(row.ddp),
    tiene_etiqueta: Boolean(row.tiene_etiqueta),
    datos,
    bultos: datos.bultos || [],
    items: datos.items || [],
    pais_destino: datos.pais_destino || row.destinatario_pais || null,
    peso_real: (datos.bultos || []).reduce((s, b) => s + (Number(b.peso_real) || 0), 0),
  };
}

async function buscarPorId(id) {
  const row = await getDb().prepare(`SELECT ${SIN_BLOBS} ${FROM} WHERE g.id = ?`).get(id);
  return mapGuia(row);
}

async function listar({ fecha, estado, desde, hasta, cliente_id } = {}) {
  const where = [];
  const params = [];
  if (fecha) { where.push('g.fecha = ?'); params.push(fecha); }
  if (desde) { where.push('g.fecha >= ?'); params.push(desde); }
  if (hasta) { where.push('g.fecha <= ?'); params.push(hasta); }
  if (estado) { where.push('g.estado = ?'); params.push(estado); }
  if (cliente_id) { where.push('g.cliente_id = ?'); params.push(cliente_id); }
  const rows = await getDb()
    .prepare(`SELECT ${SIN_BLOBS} ${FROM} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY g.fecha DESC, g.id DESC LIMIT 500`)
    .all(...params);
  return rows.map(mapGuia);
}

/** Precargas pendientes de confirmar (de cualquier fecha), las más viejas primero. */
async function pendientes() {
  const rows = await getDb()
    .prepare(`SELECT ${SIN_BLOBS} ${FROM} WHERE g.estado = 'emitida' ORDER BY g.fecha, g.id`)
    .all();
  return rows.map(mapGuia);
}

async function etiqueta(id) {
  const row = await getDb().prepare('SELECT numero_guia, etiqueta_gif, entorno FROM guias WHERE id = ?').get(id);
  if (!row || !row.etiqueta_gif) return null;
  return row;
}

function limpiarBultos(bultos) {
  if (!Array.isArray(bultos)) return [];
  return bultos.map((b, i) => ({
    numero_bulto: i + 1,
    peso_real: Number(b.peso_real) || 0,
    largo: Number(b.largo) || null,
    ancho: Number(b.ancho) || null,
    alto: Number(b.alto) || null,
  })).filter((b) => b.peso_real > 0 || (b.largo && b.ancho && b.alto));
}

function limpiarItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it, i) => ({
    orden: i + 1,
    cantidad: Number(it.cantidad) || 1,
    descripcion: String(it.descripcion ?? '').trim(),
    valor_unitario: Number(it.valor_unitario) || 0,
  })).filter((it) => it.descripcion);
}

function totalItems(items) {
  return Math.round(items.reduce((s, it) => s + it.cantidad * it.valor_unitario, 0) * 100) / 100;
}

/**
 * Pide la guía a UPS y la guarda como precarga. Devuelve { guia } o { errores: [...] }
 * (errores de datos → 400 sin llamar a UPS; errores de UPS → 502 con lo que dijo UPS).
 */
async function emitir(input, usuario) {
  const db = getDb();
  const cliente = input.cliente_id
    ? await db.prepare('SELECT * FROM clientes WHERE id = ?').get(input.cliente_id)
    : null;
  const destinatario = input.destinatario_id && cliente
    ? await db.prepare('SELECT * FROM destinatarios WHERE id = ? AND cliente_id = ?').get(input.destinatario_id, cliente.id)
    : null;
  const bultos = limpiarBultos(input.bultos);
  const items = limpiarItems(input.items);
  const servicio = String(input.servicio || '').trim();
  const contenido = String(input.contenido ?? '').trim();
  const fob = input.fob !== undefined && input.fob !== null && input.fob !== ''
    ? Number(input.fob) || 0
    : totalItems(items);
  // hoyLocal(): toISOString() es UTC y adelanta un día después de las 21:00 (regla de ESTADO).
  const fecha = String(input.fecha || '').slice(0, 10) || hoyLocal();

  const faltan = ups.validar({ cliente, destinatario, bultos, servicio, contenido });
  if (input.destinatario_id && cliente && !destinatario) faltan.push('El destinatario no es de ese cliente');
  if (faltan.length) return { errores: faltan, tipo: 'datos' };

  const pedido = ups.armarPedido({
    cliente, destinatario, bultos, servicio, ddp: Boolean(input.ddp), contenido, fob,
    referencia: `nova cli ${cliente.id}`,
  });
  const r = await ups.pedirGuia(pedido);
  if (!r.ok) return { errores: r.errores, tipo: 'ups', status: r.status, respuesta: r.data };

  const resumen = ups.resumirRespuesta(r.data);
  const datos = {
    pais_destino: input.pais_destino || destinatario.pais,
    bultos,
    items,
    observaciones: String(input.observaciones ?? '').trim() || null,
    trackings: resumen.trackings,
    alertas: resumen.alertas,
    moneda: resumen.moneda,
  };
  // Con varios bultos UPS devuelve una etiqueta por bulto; se guardan todas en orden,
  // separadas para que la impresión las saque una atrás de otra.
  const etiquetas = resumen.etiquetas.filter(Boolean);
  const result = await db
    .prepare(
      `INSERT INTO guias (cliente_id, destinatario_id, fecha, courier, servicio, cuenta, entorno, numero_guia,
         estado, ddp, fob, contenido, proforma_numero, datos_json, request_json, response_json, etiqueta_gif,
         cargo_ups, usuario)
       VALUES (?, ?, ?, 'UPS', ?, ?, ?, ?, 'emitida', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      cliente.id, destinatario.id, fecha, servicio, ups.cuentaExpo(), ups.entorno(), resumen.numero_guia,
      input.ddp ? 1 : 0, fob, contenido, String(input.proforma_numero ?? '').trim() || null,
      JSON.stringify(datos), JSON.stringify(pedido), JSON.stringify(r.data),
      etiquetas.length ? JSON.stringify(etiquetas) : null, resumen.cargo, usuario || null
    );
  await db.prepare("UPDATE destinatarios SET ultimo_uso = datetime('now', 'localtime') WHERE id = ?").run(destinatario.id);
  return { guia: await buscarPorId(result.lastInsertRowid) };
}

/** Edita lo que no cambia la guía ya impresa: proforma, contenido, renglones, FOB, nota. */
async function actualizar(id, data) {
  const db = getDb();
  const g = await db.prepare('SELECT * FROM guias WHERE id = ?').get(id);
  if (!g) return null;
  if (g.estado !== 'emitida') {
    const err = new Error(`La guía ya está ${g.estado}: se edita desde el envío`);
    err.status = 400;
    throw err;
  }
  let datos = {};
  try { datos = JSON.parse(g.datos_json || '{}'); } catch { datos = {}; }
  if (data.items !== undefined) datos.items = limpiarItems(data.items);
  if (data.observaciones !== undefined) datos.observaciones = String(data.observaciones ?? '').trim() || null;
  if (data.bultos !== undefined) datos.bultos = limpiarBultos(data.bultos);
  const fob = data.fob !== undefined ? (Number(data.fob) || 0) : g.fob;
  await db
    .prepare(
      `UPDATE guias SET contenido = ?, proforma_numero = ?, fob = ?, nota = ?, datos_json = ?,
         updated_at = datetime('now', 'localtime') WHERE id = ?`
    )
    .run(
      data.contenido !== undefined ? (String(data.contenido).trim() || null) : g.contenido,
      data.proforma_numero !== undefined ? (String(data.proforma_numero).trim() || null) : g.proforma_numero,
      fob,
      data.nota !== undefined ? (String(data.nota).trim() || null) : g.nota,
      JSON.stringify(datos),
      id
    );
  return buscarPorId(id);
}

async function anular(id, nota) {
  const db = getDb();
  const g = await db.prepare('SELECT * FROM guias WHERE id = ?').get(id);
  if (!g) return null;
  if (g.estado === 'confirmada') {
    const err = new Error('La guía ya se confirmó como envío: anulala desde Salidas (borrando el envío) antes');
    err.status = 400;
    throw err;
  }
  if (g.estado === 'anulada') return { guia: await buscarPorId(id), ya: true };
  let ups_resultado = null;
  if (g.numero_guia) {
    const r = await ups.anularGuia(g.numero_guia);
    if (!r.ok) return { errores: r.errores, status: r.status };
    ups_resultado = r.data;
  }
  await db
    .prepare(
      `UPDATE guias SET estado = 'anulada', nota = ?, anulada_at = datetime('now', 'localtime'),
         updated_at = datetime('now', 'localtime') WHERE id = ?`
    )
    .run(String(nota ?? '').trim() || g.nota || null, id);
  return { guia: await buscarPorId(id), ups: ups_resultado };
}

/**
 * Lo que Cargar envío necesita para precargar el formulario a partir de la guía:
 * el mismo cuerpo que manda el alta de un envío, más guia_id, destinatario e items.
 */
function comoEnvio(g) {
  const bultos = g.bultos || [];
  // El entorno de test de UPS devuelve SIEMPRE el mismo número comodín (1ZXXXX…): si la
  // oficina confirma dos guías de prueba, la segunda chocaría con la guía única del envío.
  // Se le pega el id para que sea única y se note que es de prueba.
  const numero = g.entorno === 'test' && /^1ZX+$/i.test(g.numero_guia || '')
    ? `${g.numero_guia}-P${g.id}`
    : g.numero_guia;
  return {
    guia_id: g.id,
    cliente_id: g.cliente_id,
    fecha: g.fecha,
    courier: 'UPS',
    servicio_ups: g.servicio,
    tipo_envio: 'exportacion',
    tipo_paquete: 'm',
    numero_guia: numero,
    pais_destino: g.pais_destino,
    cantidad_bultos: bultos.length || 1,
    peso_real: g.peso_real,
    largo: bultos.length === 1 ? bultos[0].largo : null,
    ancho: bultos.length === 1 ? bultos[0].ancho : null,
    alto: bultos.length === 1 ? bultos[0].alto : null,
    bultos: bultos.length > 1 ? bultos : undefined,
    fob: g.fob,
    ddp: g.ddp ? 1 : 0,
    observaciones: g.datos.observaciones || null,
    destinatario_id: g.destinatario_id,
    contenido: g.contenido,
    proforma_numero: g.proforma_numero,
    items: g.items,
  };
}

module.exports = { buscarPorId, listar, pendientes, etiqueta, emitir, actualizar, anular, comoEnvio };
