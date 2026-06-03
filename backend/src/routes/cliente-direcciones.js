const { Router } = require('express');
const { getDb } = require('../db');

const router = Router({ mergeParams: true });

router.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const cliente = await db.prepare('SELECT direccion_recoleccion FROM clientes WHERE id = ?').get(id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    const dirs = [];
    if (cliente.direccion_recoleccion) {
      dirs.push({ id: 'principal', direccion: cliente.direccion_recoleccion, es_principal: true });
    }

    const adicionales = await db
      .prepare('SELECT id, direccion FROM cliente_direcciones WHERE cliente_id = ? ORDER BY id ASC')
      .all(id);
    adicionales.forEach((d) => dirs.push({ id: d.id, direccion: d.direccion, es_principal: false }));

    res.json(dirs);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { direccion } = req.body;

    if (!direccion || !String(direccion).trim()) {
      return res.status(400).json({ error: 'La dirección es obligatoria' });
    }

    const result = await db
      .prepare('INSERT INTO cliente_direcciones (cliente_id, direccion) VALUES (?, ?)')
      .run(id, String(direccion).trim());

    const created = await db
      .prepare('SELECT id, direccion FROM cliente_direcciones WHERE id = ?')
      .get(result.lastInsertRowid);

    res.status(201).json({ id: created.id, direccion: created.direccion, es_principal: false });
  } catch (e) {
    next(e);
  }
});

router.delete('/:dirId', async (req, res, next) => {
  try {
    const { dirId } = req.params;

    if (dirId === 'principal') {
      return res.status(400).json({ error: 'No se puede eliminar la dirección principal' });
    }

    const db = getDb();
    const { id } = req.params;

    const result = await db
      .prepare('DELETE FROM cliente_direcciones WHERE id = ? AND cliente_id = ?')
      .run(dirId, id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Dirección no encontrada' });
    }

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
