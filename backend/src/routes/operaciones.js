const { Router } = require('express');
const { getDb } = require('../db');

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
                confirmado_ricardo, confirmado_juanqui
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

    res.json({ envios: enviosConPickup, pickups });
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

    const current = await db.prepare('SELECT * FROM pickups WHERE id = ?').get(id);
    if (!current) return res.status(404).json({ error: 'Pickup no encontrado' });

    const { check_datos, check_guia, check_proforma, check_despachado, confirmar_ricardo, confirmar_juanqui } = req.body;

    const updates = {};
    if (check_datos !== undefined) updates.check_datos = Number(check_datos);
    if (check_guia !== undefined) updates.check_guia = Number(check_guia);
    if (check_proforma !== undefined) updates.check_proforma = Number(check_proforma);
    if (check_despachado !== undefined) updates.check_despachado = Number(check_despachado);

    if (confirmar_ricardo !== undefined) {
      if (confirmar_ricardo) {
        const ts = await db.prepare("SELECT datetime('now','localtime') AS ts").get();
        updates.confirmado_ricardo = ts.ts;
      } else {
        updates.confirmado_ricardo = null;
      }
    }
    if (confirmar_juanqui !== undefined) {
      if (confirmar_juanqui) {
        const ts = await db.prepare("SELECT datetime('now','localtime') AS ts").get();
        updates.confirmado_juanqui = ts.ts;
      } else {
        updates.confirmado_juanqui = null;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    if (confirmar_juanqui !== undefined || confirmar_ricardo !== undefined) {
      const nextJuanqui = 'confirmado_juanqui' in updates
        ? updates.confirmado_juanqui
        : current.confirmado_juanqui;
      updates.estado = nextJuanqui ? 'recolectado' : 'pendiente';
    }

    const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    await db
      .prepare(`UPDATE pickups SET ${setClauses} WHERE id = ?`)
      .run(...Object.values(updates), id);

    const updated = await db.prepare('SELECT * FROM pickups WHERE id = ?').get(id);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
