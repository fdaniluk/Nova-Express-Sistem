// /api/clientes/:id/remitentes — perfiles de remitente del cliente (08/09/2026).
// GET devuelve la ficha del cliente primero (id null, principal true) y después los
// perfiles cargados. Los perfiles se borran en blando (activo = 0): una guía o un envío
// ya emitido puede apuntar a ellos.
const { Router } = require('express');
const { getDb } = require('../db');
const remitentes = require('../models/remitentes.model');

const router = Router({ mergeParams: true });

async function cliente(req, res) {
  const c = await getDb().prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!c) res.status(404).json({ error: 'Cliente no encontrado' });
  return c;
}

router.get('/', async (req, res, next) => {
  try {
    const c = await cliente(req, res);
    if (!c) return;
    res.json(await remitentes.listar(c, { todos: req.query.todos === '1' }));
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const c = await cliente(req, res);
    if (!c) return;
    res.status(201).json(await remitentes.crear(c.id, req.body || {}));
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.put('/:remId', async (req, res, next) => {
  try {
    const r = await remitentes.actualizar(req.params.id, req.params.remId, req.body || {});
    if (!r) return res.status(404).json({ error: 'Remitente no encontrado' });
    res.json(r);
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.delete('/:remId', async (req, res, next) => {
  try {
    const ok = await remitentes.desactivar(req.params.id, req.params.remId);
    if (!ok) return res.status(404).json({ error: 'Remitente no encontrado' });
    res.json({ ok: true, id: Number(req.params.remId) });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
