/**
 * cotizaciones.controller.js — guardar una cotización y seguirle el estado.
 *
 * La regla que sostiene todo este módulo: EL PRECIO ACORDADO NO SE TIPEA. Sale de la
 * opción que se guardó cuando se emitió la cotización. Si el total viajara en el body,
 * cualquiera podría "aceptar" una cotización por otro número y el sistema lo tomaría
 * como el precio que el cliente aceptó, que es justo lo que este módulo viene a evitar.
 */
const modelo = require('../models/cotizacion.model');
const { getDb } = require('../db');

const TIPOS = ['exportacion', 'importacion'];

function hoyMas(dias) {
  const d = new Date();
  d.setDate(d.getDate() + Number(dias));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function clienteExiste(id) {
  const row = await getDb().prepare('SELECT id FROM clientes WHERE id = ?').get(id);
  return Boolean(row);
}

/* Valida lo que manda el cotizador. Es estricto con las opciones porque son la fuente
   del precio acordado: una opción sin servicio o sin total volvería inaceptable a la
   cotización más adelante, y el error aparecería recién el día que llega la caja. */
async function validar(body) {
  if (!body || typeof body !== 'object') return 'Falta el cuerpo del pedido';
  if (!body.pais) return 'Falta el país de destino';
  if (!TIPOS.includes(body.tipo_envio)) return "tipo_envio tiene que ser 'exportacion' o 'importacion'";
  if (body.cliente_id !== undefined && body.cliente_id !== null && body.cliente_id !== '') {
    if (!(await clienteExiste(body.cliente_id))) return 'El cliente indicado no existe';
  } else if (!body.cliente_nombre) {
    return 'Indicá un cliente o, si todavía no lo es, un nombre';
  }
  if (!Array.isArray(body.opciones) || body.opciones.length === 0) {
    return 'La cotización no tiene ninguna opción para guardar';
  }
  for (const o of body.opciones) {
    if (!o || !o.servicio) return 'Hay una opción sin servicio';
    if (typeof o.total !== 'number' || !Number.isFinite(o.total) || o.total <= 0) {
      return `La opción ${o.servicio} no tiene un total válido`;
    }
  }
  const servicios = body.opciones.map((o) => o.servicio);
  if (new Set(servicios).size !== servicios.length) {
    return 'La cotización tiene dos opciones para el mismo servicio';
  }
  return null;
}

async function listar(req, res, next) {
  try {
    const { cliente_id, estado, desde, hasta, limite } = req.query;
    // Un estado que no existe no se filtra en silencio: devolver cero filas haria pensar
    // que no hay cotizaciones cuando lo que hay es un parametro mal escrito.
    if (estado && !modelo.ESTADOS.includes(estado)) {
      return res.status(400).json({ error: `Estado inválido: ${estado}` });
    }
    res.json(await modelo.listar({ cliente_id, estado, desde, hasta, limite }));
  } catch (e) { next(e); }
}

async function obtener(req, res, next) {
  try {
    const q = await modelo.obtener(req.params.id);
    if (!q) return res.status(404).json({ error: 'Cotización no encontrada' });
    q.historial = await modelo.historial(q.id);
    res.json(q);
  } catch (e) { next(e); }
}

/** Las aceptadas de un cliente que todavía no se usaron: lo que Salidas va a preguntar. */
async function aceptadasDeCliente(req, res, next) {
  try {
    res.json(await modelo.aceptadasSinUsar(req.params.clienteId));
  } catch (e) { next(e); }
}

async function crear(req, res, next) {
  try {
    const error = await validar(req.body);
    if (error) return res.status(400).json({ error });

    // La validez por defecto son 15 días, los mismos que muestra la imagen que se le
    // manda al cliente. Si las dos fechas dijeran cosas distintas, el papel y el sistema
    // se contradirían justo el día que el cliente reclama el precio.
    const dias = Number(req.body.dias_validez);
    const vence_en = req.body.vence_en
      || hoyMas(Number.isFinite(dias) && dias > 0 ? dias : 15);

    const creada = await modelo.crear({ ...req.body, vence_en }, req.usuario);
    res.status(201).json(creada);
  } catch (e) { next(e); }
}

async function aceptar(req, res, next) {
  try {
    const servicio = req.body && req.body.servicio;
    if (!servicio) return res.status(400).json({ error: 'Indicá qué opción aceptó el cliente' });
    const q = await modelo.obtener(req.params.id);
    if (!q) return res.status(404).json({ error: 'Cotización no encontrada' });
    if (q.estado === 'rechazada') {
      return res.status(409).json({ error: 'La cotización está rechazada: cambiale el estado antes de aceptarla' });
    }
    const r = await modelo.aceptar(req.params.id, servicio, req.usuario);
    if (r && r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) { next(e); }
}

async function cambiarEstado(req, res, next) {
  try {
    const r = await modelo.cambiarEstado(req.params.id, req.body && req.body.estado, req.usuario);
    if (r === null) return res.status(404).json({ error: 'Cotización no encontrada' });
    if (r && r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) { next(e); }
}

async function editar(req, res, next) {
  try {
    const { total_acordado, notas, vence_en } = req.body || {};
    if (total_acordado !== undefined
        && (typeof total_acordado !== 'number' || !Number.isFinite(total_acordado) || total_acordado <= 0)) {
      return res.status(400).json({ error: 'total_acordado tiene que ser un número mayor a cero' });
    }
    const r = await modelo.editarAcordado(req.params.id, { total_acordado, notas, vence_en }, req.usuario);
    if (!r) return res.status(404).json({ error: 'Cotización no encontrada' });
    res.json(r);
  } catch (e) { next(e); }
}

async function eliminar(req, res, next) {
  try {
    const q = await modelo.obtener(req.params.id);
    if (!q) return res.status(404).json({ error: 'Cotización no encontrada' });
    // Una cotización ya atada a un envío es el respaldo del precio de ese envío: si se
    // borra, el envío queda con un precio acordado que no se puede justificar.
    if (q.envio_id) {
      return res.status(409).json({ error: 'La cotización está atada a un envío: no se puede borrar' });
    }
    await modelo.eliminar(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = { listar, obtener, aceptadasDeCliente, crear, aceptar, cambiarEstado, editar, eliminar };
