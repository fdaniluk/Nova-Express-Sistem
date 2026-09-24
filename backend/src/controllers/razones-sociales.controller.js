// Razones sociales por cliente y unir clientes (22/09/2026).
const svc = require('../services/razones-sociales.service');
const { getDb } = require('../db');

async function clienteExiste(id) {
  return Boolean(await getDb().prepare('SELECT id FROM clientes WHERE id = ?').get(id));
}

// GET /api/clientes/:id/razones-sociales
async function listar(req, res, next) {
  try {
    if (!(await clienteExiste(req.params.id))) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json({ razones_sociales: await svc.listar(req.params.id) });
  } catch (e) { next(e); }
}
// POST /api/clientes/:id/razones-sociales
async function crear(req, res, next) {
  try {
    if (!(await clienteExiste(req.params.id))) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.status(201).json(await svc.crear(req.params.id, req.body || {}));
  } catch (e) { next(e); }
}
// PUT /api/clientes/razones-sociales/:rid
async function editar(req, res, next) {
  try { res.json(await svc.editar(req.params.rid, req.body || {})); } catch (e) { next(e); }
}
// POST /api/clientes/razones-sociales/:rid/mover  { cliente_id }
async function mover(req, res, next) {
  try {
    const dest = Number((req.body || {}).cliente_id);
    if (!dest) return res.status(400).json({ error: 'cliente_id destino es obligatorio' });
    res.json(await svc.moverACliente(req.params.rid, dest));
  } catch (e) { next(e); }
}
// POST /api/clientes/:id/unir  { destino_id }  → el cliente :id (origen) se funde en destino_id
async function unir(req, res, next) {
  try {
    const dest = Number((req.body || {}).destino_id);
    if (!dest) return res.status(400).json({ error: 'destino_id es obligatorio' });
    res.json(await svc.unirClientes(req.params.id, dest, { usuario: req.usuario ? req.usuario.usuario : null }));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
}

// POST /api/clientes/:id/unir/preview  { destino_id }
async function unirPreview(req, res, next) {
  try {
    const dest = Number((req.body || {}).destino_id);
    if (!dest) return res.status(400).json({ error: 'destino_id es obligatorio' });
    res.json(await svc.previewUnion(req.params.id, dest));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
}
// GET /api/clientes/duplicados
async function duplicados(req, res, next) {
  try { res.json({ pares: await svc.posiblesDuplicados() }); } catch (e) { next(e); }
}

module.exports = { listar, crear, editar, mover, unir, unirPreview, duplicados };
