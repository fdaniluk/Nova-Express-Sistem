/**
 * cotizador-links.controller.js — la gestión de los links, del lado de la oficina.
 * (La cara pública vive en publico.controller.js.)
 */
const modelo = require('../models/cotizador-link.model');
const { getDb } = require('../db');

async function listarDeCliente(req, res, next) {
  try {
    res.json(await modelo.listarDeCliente(req.params.clienteId));
  } catch (e) { next(e); }
}

async function crear(req, res, next) {
  try {
    const { cliente_id, nombre, couriers, profit_pct, dias, nombrar } = req.body || {};
    if (cliente_id) {
      const c = await getDb().prepare('SELECT id FROM clientes WHERE id = ?').get(cliente_id);
      if (!c) return res.status(400).json({ error: 'El cliente indicado no existe' });
    } else {
      // Sin cliente el link necesita las dos cosas: a quién saludar y con qué margen cotizar.
      if (!nombre) return res.status(400).json({ error: 'Sin cliente, indicá un nombre para el link' });
      const p = Number(profit_pct);
      if (!Number.isFinite(p) || p < 0) {
        return res.status(400).json({ error: 'Sin cliente, indicá el porcentaje de ganancia del link' });
      }
    }
    if (couriers && !modelo.COURIERS.includes(couriers)) {
      return res.status(400).json({ error: `couriers tiene que ser uno de: ${modelo.COURIERS.join(', ')}` });
    }
    const link = await modelo.crear({ cliente_id, nombre, couriers, profit_pct, dias, nombrar }, req.usuario);
    res.status(201).json(link);
  } catch (e) { next(e); }
}

async function darDeBaja(req, res, next) {
  try {
    const ok = await modelo.darDeBaja(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Link no encontrado o ya dado de baja' });
    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = { listarDeCliente, crear, darDeBaja };
