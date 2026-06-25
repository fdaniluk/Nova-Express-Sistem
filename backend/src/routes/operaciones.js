const { Router } = require('express');
const { getDb } = require('../db');
const { procesarConfirmacion } = require('../services/pickups.service');

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ error: 'El parámetro fecha es requerido (YYYY-MM-DD)' });

    const db = getDb();

    const pickups = await db
      .prepare(
        `SELECT id, cliente_id, cliente_nombre, direccion, fecha, hora_inicio, hora_fin, estado, tipo_recoleccion, titulo,
                check_datos, check_guia, check_proforma, check_despachado,
                confirmado_ricardo, visto_juanqui_at, confirmado_juanqui, en_deposito_at, recolector
         FROM pickups
         WHERE fecha = ?
         ORDER BY hora_inicio ASC`
      )
      .all(fecha);

    // Rezagados: pickups NO despachados con fecha anterior al día pedido.
    // Se arrastran visualmente; su fecha real queda intacta.
    // Condición estricta fecha < ? para no duplicar los del día exacto.
    // Mismas columnas que la query de pickups del día → el frontend los renderiza igual.
    const rezagados = await db
      .prepare(
        `SELECT id, cliente_id, cliente_nombre, direccion, fecha, hora_inicio, hora_fin, estado, tipo_recoleccion, titulo,
                check_datos, check_guia, check_proforma, check_despachado,
                confirmado_ricardo, visto_juanqui_at, confirmado_juanqui, en_deposito_at, recolector
         FROM pickups
         WHERE (check_despachado = 0 OR check_despachado IS NULL)
           AND fecha < ?
         ORDER BY fecha ASC, hora_inicio ASC`
      )
      .all(fecha);

    // Cuadrantes del día: se renderizan debajo de su envío origen (envio_origen_id).
    const cuadrantes = await db
      .prepare(
        `SELECT q.id, q.cliente_id, q.envio_origen_id, q.pickup_id, q.titulo, q.fecha,
                c.nombre AS cliente_nombre, q.estado_operativo,
                q.check_datos, q.check_guia, q.check_proforma, q.check_despachado
         FROM cuadrantes q
         JOIN clientes c ON q.cliente_id = c.id
         WHERE q.fecha = ?
         ORDER BY c.nombre ASC`
      )
      .all(fecha);

    // Cuadrantes rezagados: no despachados de días anteriores (mismo criterio que envíos).
    const cuadrantesRezagados = await db
      .prepare(
        `SELECT q.id, q.cliente_id, q.envio_origen_id, q.pickup_id, q.titulo, q.fecha,
                c.nombre AS cliente_nombre, q.estado_operativo,
                q.check_datos, q.check_guia, q.check_proforma, q.check_despachado
         FROM cuadrantes q
         JOIN clientes c ON q.cliente_id = c.id
         WHERE (q.check_despachado = 0 OR q.check_despachado IS NULL)
           AND q.fecha < ?
         ORDER BY q.fecha ASC, c.nombre ASC`
      )
      .all(fecha);

    res.json({
      pickups,
      rezagados,
      cuadrantes,
      cuadrantes_rezagados: cuadrantesRezagados,
    });
  } catch (e) {
    next(e);
  }
});

router.patch('/envios/:id', async (req, res, next) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const current = await db.prepare('SELECT * FROM envios WHERE id = ?').get(id);
    if (!current) return res.status(404).json({ error: 'Envío no encontrado' });

    const { titulo, estado_operativo, check_datos, check_guia, check_proforma, check_despachado } = req.body;

    const updates = {};
    if (titulo !== undefined) updates.titulo = titulo;
    if (estado_operativo !== undefined) updates.estado_operativo = estado_operativo;
    if (check_datos !== undefined) updates.check_datos = Number(check_datos);
    if (check_guia !== undefined) updates.check_guia = Number(check_guia);
    if (check_proforma !== undefined) updates.check_proforma = Number(check_proforma);
    if (check_despachado !== undefined) updates.check_despachado = Number(check_despachado);

    if (Number(check_despachado) === 1) {
      updates.estado_operativo = 'despachado';
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    await db
      .prepare(`UPDATE envios SET ${setClauses} WHERE id = ?`)
      .run(...Object.values(updates), id);

    const updated = await db.prepare('SELECT * FROM envios WHERE id = ?').get(id);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

router.patch('/pickups/:id', async (req, res, next) => {
  try {
    const db = getDb();
    const { id } = req.params;

    // check_* y titulo son exclusivos del contexto operaciones; se aplican por separado
    const { check_datos, check_guia, check_proforma, check_despachado, titulo } = req.body;
    const checkUpdates = {};
    if (check_datos     !== undefined) checkUpdates.check_datos     = Number(check_datos);
    if (check_guia      !== undefined) checkUpdates.check_guia      = Number(check_guia);
    if (check_proforma  !== undefined) checkUpdates.check_proforma  = Number(check_proforma);
    if (check_despachado !== undefined) checkUpdates.check_despachado = Number(check_despachado);
    if (titulo          !== undefined) checkUpdates.titulo          = titulo;

    if (Object.keys(checkUpdates).length > 0) {
      const exists = await db.prepare('SELECT id FROM pickups WHERE id = ?').get(id);
      if (!exists) return res.status(404).json({ error: 'Pickup no encontrado' });
      const setClauses = Object.keys(checkUpdates).map(k => `${k} = ?`).join(', ');
      await db.prepare(`UPDATE pickups SET ${setClauses} WHERE id = ?`).run(...Object.values(checkUpdates), id);
    }

    // Confirmaciones via helper compartido (incluye regla de cadena + side-effects sobre envios)
    const { confirmar_ricardo, confirmar_juanqui, confirmar_deposito } = req.body;
    const hasConfirmation = confirmar_ricardo !== undefined
      || confirmar_juanqui  !== undefined
      || confirmar_deposito !== undefined;

    if (hasConfirmation) {
      const updated = await procesarConfirmacion(db, id, req.body);
      if (!updated) return res.status(404).json({ error: 'Pickup no encontrado' });
      return res.json(updated);
    }

    if (Object.keys(checkUpdates).length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    const updated = await db.prepare('SELECT * FROM pickups WHERE id = ?').get(id);
    res.json(updated);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// ── Cuadrantes ───────────────────────────────────────────

// Crea un cuadrante copiando cliente_id y fecha de la entidad origen.
// Acepta UNO de dos cuerpos (mutuamente excluyentes):
//   { envio_origen_id } → se ata a un envío; pickup_id queda NULL.
//   { pickup_id }       → se ata a un pickup standalone; envio_origen_id queda NULL.
router.post('/cuadrantes', async (req, res, next) => {
  try {
    const db = getDb();
    const { envio_origen_id, pickup_id } = req.body;

    if (!envio_origen_id && !pickup_id) {
      return res.status(400).json({ error: 'Se requiere envio_origen_id o pickup_id' });
    }
    if (envio_origen_id && pickup_id) {
      return res.status(400).json({ error: 'envio_origen_id y pickup_id son mutuamente excluyentes' });
    }

    let lastInsertRowid;
    if (envio_origen_id) {
      const origen = await db
        .prepare('SELECT id, cliente_id, fecha FROM envios WHERE id = ?')
        .get(envio_origen_id);
      if (!origen) return res.status(404).json({ error: 'Envío origen no encontrado' });

      ({ lastInsertRowid } = await db
        .prepare(
          `INSERT INTO cuadrantes (cliente_id, envio_origen_id, fecha)
           VALUES (?, ?, ?)`
        )
        .run(origen.cliente_id, origen.id, origen.fecha));
    } else {
      const origen = await db
        .prepare('SELECT id, cliente_id, fecha FROM pickups WHERE id = ?')
        .get(pickup_id);
      if (!origen) return res.status(404).json({ error: 'Pickup origen no encontrado' });

      ({ lastInsertRowid } = await db
        .prepare(
          `INSERT INTO cuadrantes (cliente_id, pickup_id, fecha)
           VALUES (?, ?, ?)`
        )
        .run(origen.cliente_id, origen.id, origen.fecha));
    }

    const creado = await db
      .prepare(
        `SELECT q.id, q.cliente_id, q.envio_origen_id, q.pickup_id, q.titulo, q.fecha,
                c.nombre AS cliente_nombre, q.estado_operativo,
                q.check_datos, q.check_guia, q.check_proforma, q.check_despachado
         FROM cuadrantes q
         JOIN clientes c ON q.cliente_id = c.id
         WHERE q.id = ?`
      )
      .get(lastInsertRowid);

    res.status(201).json(creado);
  } catch (e) {
    next(e);
  }
});

// Actualiza checks y/o título. Misma regla que envíos: check_despachado=1 → despachado.
router.patch('/cuadrantes/:id', async (req, res, next) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const current = await db.prepare('SELECT id FROM cuadrantes WHERE id = ?').get(id);
    if (!current) return res.status(404).json({ error: 'Cuadrante no encontrado' });

    const { titulo, estado_operativo, check_datos, check_guia, check_proforma, check_despachado } = req.body;

    const updates = {};
    if (titulo !== undefined) updates.titulo = titulo;
    if (estado_operativo !== undefined) updates.estado_operativo = estado_operativo;
    if (check_datos !== undefined) updates.check_datos = Number(check_datos);
    if (check_guia !== undefined) updates.check_guia = Number(check_guia);
    if (check_proforma !== undefined) updates.check_proforma = Number(check_proforma);
    if (check_despachado !== undefined) updates.check_despachado = Number(check_despachado);

    if (Number(check_despachado) === 1) {
      updates.estado_operativo = 'despachado';
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    await db
      .prepare(`UPDATE cuadrantes SET ${setClauses} WHERE id = ?`)
      .run(...Object.values(updates), id);

    const updated = await db
      .prepare(
        `SELECT q.id, q.cliente_id, q.envio_origen_id, q.pickup_id, q.titulo, q.fecha,
                c.nombre AS cliente_nombre, q.estado_operativo,
                q.check_datos, q.check_guia, q.check_proforma, q.check_despachado
         FROM cuadrantes q
         JOIN clientes c ON q.cliente_id = c.id
         WHERE q.id = ?`
      )
      .get(id);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

router.delete('/cuadrantes/:id', async (req, res, next) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { changes } = await db.prepare('DELETE FROM cuadrantes WHERE id = ?').run(id);
    if (!changes) return res.status(404).json({ error: 'Cuadrante no encontrado' });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;
