const { Router } = require('express');
const { getDb } = require('../db');
const { procesarConfirmacion } = require('../services/pickups.service');

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ error: 'El parámetro fecha es requerido (YYYY-MM-DD)' });

    const db = getDb();

    const envios = await db
      .prepare(
        `SELECT e.id, e.numero_guia, c.nombre AS cliente_nombre, e.cliente_id,
                e.pais_destino AS pais, e.estado_operativo,
                e.check_datos, e.check_guia, e.check_proforma, e.check_despachado
         FROM envios e
         JOIN clientes c ON e.cliente_id = c.id
         WHERE e.fecha = ?
         ORDER BY c.nombre ASC`
      )
      .all(fecha);

    const pickups = await db
      .prepare(
        `SELECT id, cliente_id, cliente_nombre, direccion, hora_inicio, hora_fin, estado,
                check_datos, check_guia, check_proforma, check_despachado,
                confirmado_ricardo, visto_juanqui_at, confirmado_juanqui, en_deposito_at, recolector
         FROM pickups
         WHERE fecha = ?
         ORDER BY hora_inicio ASC`
      )
      .all(fecha);

    const pickupByCliente = {};
    pickups.forEach((p) => {
      pickupByCliente[p.cliente_id] = p.id;
    });

    const enviosConPickup = envios.map((e) => ({
      ...e,
      pickup_id: pickupByCliente[e.cliente_id] || null,
    }));

    // Rezagados: envíos NO despachados con fecha anterior al día pedido.
    // Se arrastran visualmente; su e.fecha real queda intacta.
    // Condición estricta e.fecha < ? para no duplicar los de fecha exacta.
    const rezagados = await db
      .prepare(
        `SELECT e.id, e.numero_guia, c.nombre AS cliente_nombre, e.cliente_id,
                e.pais_destino AS pais, e.estado_operativo, e.fecha,
                e.check_datos, e.check_guia, e.check_proforma, e.check_despachado
         FROM envios e
         JOIN clientes c ON e.cliente_id = c.id
         WHERE (e.check_despachado = 0 OR e.check_despachado IS NULL)
           AND e.fecha < ?
         ORDER BY e.fecha ASC, c.nombre ASC`
      )
      .all(fecha);

    res.json({ envios: enviosConPickup, pickups, rezagados });
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

    const { estado_operativo, check_datos, check_guia, check_proforma, check_despachado } = req.body;

    const updates = {};
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

    // check_* son exclusivos del contexto operaciones; se aplican por separado
    const { check_datos, check_guia, check_proforma, check_despachado } = req.body;
    const checkUpdates = {};
    if (check_datos     !== undefined) checkUpdates.check_datos     = Number(check_datos);
    if (check_guia      !== undefined) checkUpdates.check_guia      = Number(check_guia);
    if (check_proforma  !== undefined) checkUpdates.check_proforma  = Number(check_proforma);
    if (check_despachado !== undefined) checkUpdates.check_despachado = Number(check_despachado);

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

module.exports = router;
