const cobranzasModel = require('../models/cobranzas.model');
const { getDb } = require('../db');

const MONEDAS = ['ARS', 'USD'];
const FORMAS_PAGO = ['efectivo', 'cheque', 'transferencia', 'otro'];

// Valida fecha en formato YYYY-MM-DD y que sea una fecha real (no 2026-13-40).
function esFechaValida(fecha) {
  if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const d = new Date(`${fecha}T00:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  const [y, m, day] = fecha.split('-').map(Number);
  return d.getFullYear() === y && d.getMonth() + 1 === m && d.getDate() === day;
}

async function clienteExiste(id) {
  const row = await getDb().prepare('SELECT id FROM clientes WHERE id = ?').get(id);
  return Boolean(row);
}

// Valida el cuerpo de una cobranza. `parcial` = true para PATCH: solo valida los
// campos presentes. Devuelve un mensaje de error (string) o null si está todo OK.
async function validar(body, { parcial } = {}) {
  const tiene = (campo) => Object.prototype.hasOwnProperty.call(body, campo);

  if (!parcial || tiene('cliente_id')) {
    if (body.cliente_id === undefined || body.cliente_id === null || body.cliente_id === '') {
      return 'cliente_id es obligatorio';
    }
    if (!(await clienteExiste(body.cliente_id))) {
      return 'El cliente indicado no existe';
    }
  }

  if (!parcial || tiene('fecha')) {
    if (!esFechaValida(body.fecha)) {
      return 'fecha inválida: usá el formato YYYY-MM-DD';
    }
  }

  if (!parcial || tiene('monto')) {
    const monto = Number(body.monto);
    if (!Number.isFinite(monto) || monto <= 0) {
      return 'monto debe ser un número mayor a 0';
    }
  }

  if (!parcial || tiene('moneda')) {
    if (!MONEDAS.includes(body.moneda)) {
      return "moneda debe ser 'ARS' o 'USD'";
    }
  }

  if (!parcial || tiene('forma_pago')) {
    if (!FORMAS_PAGO.includes(body.forma_pago)) {
      return "forma_pago debe ser 'efectivo', 'cheque', 'transferencia' u 'otro'";
    }
  }

  return null;
}

// Suma los montos por moneda SIN mezclar ARS y USD.
function resumir(cobranzas) {
  const resumen = { cantidad: cobranzas.length, total_ars: 0, total_usd: 0 };
  for (const c of cobranzas) {
    if (c.moneda === 'USD') resumen.total_usd += c.monto;
    else resumen.total_ars += c.monto;
  }
  resumen.total_ars = Math.round(resumen.total_ars * 100) / 100;
  resumen.total_usd = Math.round(resumen.total_usd * 100) / 100;
  return resumen;
}

async function listar(req, res, next) {
  try {
    const { cliente_id, desde, hasta } = req.query;
    if (desde && !esFechaValida(desde)) {
      return res.status(400).json({ error: 'desde inválido: usá el formato YYYY-MM-DD' });
    }
    if (hasta && !esFechaValida(hasta)) {
      return res.status(400).json({ error: 'hasta inválido: usá el formato YYYY-MM-DD' });
    }
    const cobranzas = await cobranzasModel.listar({ cliente_id, desde, hasta });
    res.json({ cobranzas, resumen: resumir(cobranzas) });
  } catch (e) {
    next(e);
  }
}

async function crear(req, res, next) {
  try {
    const error = await validar(req.body, { parcial: false });
    if (error) return res.status(400).json({ error });

    const cobranza = await cobranzasModel.crear({
      cliente_id: req.body.cliente_id,
      fecha: req.body.fecha,
      monto: Number(req.body.monto),
      moneda: req.body.moneda,
      forma_pago: req.body.forma_pago,
      pickup_id: req.body.pickup_id,
      nota: req.body.nota,
      usuario: req.usuario ? req.usuario.usuario : null,
    });
    res.status(201).json(cobranza);
  } catch (e) {
    next(e);
  }
}

async function actualizar(req, res, next) {
  try {
    const existente = await cobranzasModel.obtenerPorId(req.params.id);
    if (!existente) return res.status(404).json({ error: 'Cobranza no encontrada' });

    const error = await validar(req.body, { parcial: true });
    if (error) return res.status(400).json({ error });

    const data = { ...req.body };
    if (Object.prototype.hasOwnProperty.call(data, 'monto')) data.monto = Number(data.monto);

    const cobranza = await cobranzasModel.actualizar(req.params.id, data);
    res.json(cobranza);
  } catch (e) {
    next(e);
  }
}

async function eliminar(req, res, next) {
  try {
    const ok = await cobranzasModel.eliminar(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Cobranza no encontrada' });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}

module.exports = { listar, crear, actualizar, eliminar };
