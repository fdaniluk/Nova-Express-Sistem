const { Router } = require('express');
const { getDb } = require('../db');
const { RECOLECTORES, derivarEstado, procesarConfirmacion } = require('../services/pickups.service');

const router = Router();

// GET /recolectores — antes de rutas /:id para evitar colisiones futuras
router.get('/recolectores', (req, res) => {
  res.json(RECOLECTORES);
});

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
    const { cliente_id, direccion, fecha, hora_inicio, hora_fin, notas, courier, recolector, tiene_cobro } = req.body;
    console.log('[POST /pickups] body:', JSON.stringify(req.body));

    if (!cliente_id || !direccion || !fecha || !hora_inicio || !hora_fin) {
      return res
        .status(400)
        .json({ error: 'cliente_id, direccion, fecha, hora_inicio y hora_fin son obligatorios' });
    }

    if (recolector != null && !RECOLECTORES.includes(recolector)) {
      return res.status(400).json({ error: `Recolector inválido. Valores permitidos: ${RECOLECTORES.join(', ')}` });
    }

    const cliente = await db
      .prepare('SELECT nombre FROM clientes WHERE id = ?')
      .get(cliente_id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    const result = await db
      .prepare(
        `INSERT INTO pickups
           (cliente_id, cliente_nombre, direccion, fecha, hora_inicio, hora_fin, notas, courier, recolector, tiene_cobro)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cliente_id,
        cliente.nombre,
        direccion,
        fecha,
        hora_inicio,
        hora_fin,
        notas || null,
        courier || null,
        recolector || null,
        tiene_cobro ? 1 : 0
      );

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

    // `estado` no se acepta como campo libre: se deriva de los timestamps actuales
    const { cliente_id, direccion, fecha, hora_inicio, hora_fin, notas, courier, recolector, tiene_cobro } = req.body;

    if (recolector != null && !RECOLECTORES.includes(recolector)) {
      return res.status(400).json({ error: `Recolector inválido. Valores permitidos: ${RECOLECTORES.join(', ')}` });
    }

    const newClienteId = cliente_id != null ? cliente_id : existing.cliente_id;
    let clienteNombre = existing.cliente_nombre;

    if (cliente_id != null && String(cliente_id) !== String(existing.cliente_id)) {
      const cliente = await db.prepare('SELECT nombre FROM clientes WHERE id = ?').get(cliente_id);
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
      clienteNombre = cliente.nombre;
    }

    // El PUT no altera los timestamps de confirmación; estado se re-deriva de ellos.
    const estado = derivarEstado(existing.confirmado_juanqui, existing.en_deposito_at);

    await db
      .prepare(
        `UPDATE pickups
         SET cliente_id=?, cliente_nombre=?, direccion=?, fecha=?, hora_inicio=?, hora_fin=?,
             notas=?, estado=?, courier=?, recolector=?, tiene_cobro=?
         WHERE id=?`
      )
      .run(
        newClienteId,
        clienteNombre,
        direccion     != null      ? direccion     : existing.direccion,
        fecha         != null      ? fecha         : existing.fecha,
        hora_inicio   != null      ? hora_inicio   : existing.hora_inicio,
        hora_fin      != null      ? hora_fin      : existing.hora_fin,
        notas         !== undefined ? notas         : existing.notas,
        estado,
        courier       !== undefined ? courier       : existing.courier,
        recolector    !== undefined ? recolector    : existing.recolector,
        tiene_cobro   !== undefined ? (tiene_cobro ? 1 : 0) : existing.tiene_cobro,
        id
      );

    const updated = await db.prepare('SELECT * FROM pickups WHERE id = ?').get(id);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const db = getDb();
    const updated = await procesarConfirmacion(db, req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Pickup no encontrado' });
    res.json(updated);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
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
