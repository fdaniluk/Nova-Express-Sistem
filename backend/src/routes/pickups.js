const { Router } = require('express');
const { getDb } = require('../db');

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    const { desde, hasta } = req.query;

    let rows;
    if (desde && hasta) {
      rows = await db
        .prepare(
          'SELECT * FROM pickups WHERE fecha >= ? AND fecha <= ? ORDER BY fecha ASC, hora_inicio ASC'
        )
        .all(desde, hasta);
    } else if (desde) {
      rows = await db
        .prepare('SELECT * FROM pickups WHERE fecha >= ? ORDER BY fecha ASC, hora_inicio ASC')
        .all(desde);
    } else if (hasta) {
      rows = await db
        .prepare('SELECT * FROM pickups WHERE fecha <= ? ORDER BY fecha ASC, hora_inicio ASC')
        .all(hasta);
    } else {
      rows = await db
        .prepare('SELECT * FROM pickups ORDER BY fecha ASC, hora_inicio ASC')
        .all();
    }

    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const db = getDb();
    const { cliente_id, direccion, fecha, hora_inicio, hora_fin, notas } = req.body;

    if (!cliente_id || !direccion || !fecha || !hora_inicio || !hora_fin) {
      return res
        .status(400)
        .json({ error: 'cliente_id, direccion, fecha, hora_inicio y hora_fin son obligatorios' });
    }

    const cliente = await db
      .prepare('SELECT nombre FROM clientes WHERE id = ?')
      .get(cliente_id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    const result = await db
      .prepare(
        'INSERT INTO pickups (cliente_id, cliente_nombre, direccion, fecha, hora_inicio, hora_fin, notas) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(cliente_id, cliente.nombre, direccion, fecha, hora_inicio, hora_fin, notas || null);

    const created = await db.prepare('SELECT * FROM pickups WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const existing = await db.prepare('SELECT * FROM pickups WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Pickup no encontrado' });

    const { cliente_id, direccion, fecha, hora_inicio, hora_fin, notas, estado } = req.body;

    const newClienteId = cliente_id != null ? cliente_id : existing.cliente_id;
    const newFecha = fecha != null ? fecha : existing.fecha;
    const newEstado = estado !== undefined ? estado : existing.estado;
    let clienteNombre = existing.cliente_nombre;

    if (cliente_id != null && String(cliente_id) !== String(existing.cliente_id)) {
      const cliente = await db.prepare('SELECT nombre FROM clientes WHERE id = ?').get(cliente_id);
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
      clienteNombre = cliente.nombre;
    }

    await db
      .prepare(
        'UPDATE pickups SET cliente_id=?, cliente_nombre=?, direccion=?, fecha=?, hora_inicio=?, hora_fin=?, notas=?, estado=? WHERE id=?'
      )
      .run(
        newClienteId,
        clienteNombre,
        direccion != null ? direccion : existing.direccion,
        newFecha,
        hora_inicio != null ? hora_inicio : existing.hora_inicio,
        hora_fin != null ? hora_fin : existing.hora_fin,
        notas !== undefined ? notas : existing.notas,
        newEstado,
        id
      );

    if (newEstado === 'recolectado' && existing.estado !== 'recolectado') {
      await db
        .prepare(
          `UPDATE envios SET estado_operativo = 'en_deposito'
           WHERE cliente_id = ? AND fecha = ? AND estado_operativo = 'pendiente'`
        )
        .run(newClienteId, newFecha);
    }

    const updated = await db.prepare('SELECT * FROM pickups WHERE id = ?').get(id);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const db = getDb();
    const result = await db.prepare('DELETE FROM pickups WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Pickup no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
