const { Router } = require('express');
const { getDb } = require('../db');
const { procesarConfirmacion } = require('../services/pickups.service');

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ error: 'El parámetro fecha es requerido (YYYY-MM-DD)' });

    const db = getDb();

    // Las entregas de importación (pickups.entrega_impo = 1) no pasan por acá: la caja
    // ya entró y solo hay que llevarla al cliente. Viven en Pickups nada más.
    const pickups = await db
      .prepare(
        `SELECT id, cliente_id, cliente_nombre, direccion, fecha, hora_inicio, hora_fin, estado, tipo_recoleccion, titulo,
                check_datos, check_guia, check_proforma, check_despachado,
                confirmado_ricardo, visto_juanqui_at, confirmado_juanqui, en_deposito_at, recolector, mostrar_en_operaciones
         FROM pickups
         WHERE fecha = ?
           AND (mostrar_en_operaciones = 1 OR mostrar_en_operaciones IS NULL)
           AND COALESCE(entrega_impo, 0) = 0
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
                confirmado_ricardo, visto_juanqui_at, confirmado_juanqui, en_deposito_at, recolector, mostrar_en_operaciones
         FROM pickups
         WHERE (check_despachado = 0 OR check_despachado IS NULL)
           AND fecha < ?
           AND (mostrar_en_operaciones = 1 OR mostrar_en_operaciones IS NULL)
           AND COALESCE(entrega_impo, 0) = 0
         ORDER BY fecha ASC, hora_inicio ASC`
      )
      .all(fecha);

    // Cuadrantes del día: se renderizan debajo de su envío origen (envio_origen_id).
    const cuadrantes = await db
      .prepare(
        `SELECT q.id, q.cliente_id, q.envio_origen_id, q.pickup_id, q.titulo, q.fecha,
                COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre, q.estado_operativo,
                q.check_datos, q.check_guia, q.check_proforma, q.check_despachado
         FROM cuadrantes q
         JOIN clientes c ON q.cliente_id = c.id
         WHERE q.fecha = ?
         -- por el mismo nombre que se muestra (ver COALESCE del SELECT)
         ORDER BY COALESCE(NULLIF(c.nombre_nova,''), c.nombre) COLLATE NOCASE ASC`
      )
      .all(fecha);

    // Cuadrantes rezagados: no despachados de días anteriores (mismo criterio que envíos).
    const cuadrantesRezagados = await db
      .prepare(
        `SELECT q.id, q.cliente_id, q.envio_origen_id, q.pickup_id, q.titulo, q.fecha,
                COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre, q.estado_operativo,
                q.check_datos, q.check_guia, q.check_proforma, q.check_despachado
         FROM cuadrantes q
         JOIN clientes c ON q.cliente_id = c.id
         WHERE (q.check_despachado = 0 OR q.check_despachado IS NULL)
           AND q.fecha < ?
         -- por el mismo nombre que se muestra (ver COALESCE del SELECT)
         ORDER BY q.fecha ASC, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) COLLATE NOCASE ASC`
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

// ── Envíos SIN pickup (pedido de operaciones, 26/08/2026) ────────────────────
// El caso típico es una IMPORTACIÓN: no la pasa a buscar nadie, así que no existe en
// Pickups, pero operaciones la necesita en su módulo para seguir si están los datos, la
// guía y la proforma. Se guarda como un pickup de tipo 'ninguna': aprovecha los checks y
// el arrastre de rezagados que ya existen, y el GET de la pantalla de Pickups lo excluye
// — los choferes nunca lo ven.
router.post('/sueltos', async (req, res, next) => {
  try {
    const db = getDb();
    const { cliente_id, fecha, titulo, notas } = req.body || {};
    if (!cliente_id || !fecha) {
      return res.status(400).json({ error: 'cliente_id y fecha son obligatorios' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) {
      return res.status(400).json({ error: 'Formato de fecha inválido (YYYY-MM-DD)' });
    }
    const cliente = await db
      .prepare('SELECT nombre, nombre_nova FROM clientes WHERE id = ?')
      .get(cliente_id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    const nombre = (cliente.nombre_nova && cliente.nombre_nova.trim()) || cliente.nombre;

    // direccion y horas son NOT NULL en la tabla pero acá no significan nada: no hay
    // recolección. Se guardan neutros y el render de Operaciones no los muestra.
    const result = await db
      .prepare(
        `INSERT INTO pickups
           (cliente_id, cliente_nombre, direccion, fecha, hora_inicio, hora_fin, notas,
            tipo_recoleccion, estado, titulo, mostrar_en_operaciones)
         VALUES (?, ?, '—', ?, '00:00', '00:00', ?, 'ninguna', 'sin_recoleccion', ?, 1)`
      )
      .run(cliente_id, nombre, fecha, notas || null, titulo || null);

    const created = await db.prepare('SELECT * FROM pickups WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

// Borrar una tarjeta suelta. SOLO las de tipo 'ninguna': un pickup de verdad se borra
// desde su pantalla, con su circuito. Sin esto, operaciones no tendría cómo deshacer
// una tarjeta cargada por error (en Pickups no la ve nadie).
router.delete('/sueltos/:id', async (req, res, next) => {
  try {
    const db = getDb();
    const fila = await db
      .prepare("SELECT id, tipo_recoleccion FROM pickups WHERE id = ?")
      .get(req.params.id);
    if (!fila) return res.status(404).json({ error: 'No encontrado' });
    if (fila.tipo_recoleccion !== 'ninguna') {
      return res.status(400).json({ error: 'Solo se pueden borrar desde acá los envíos sin pickup' });
    }
    await db.prepare('DELETE FROM pickups WHERE id = ?').run(fila.id);
    res.json({ ok: true });
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
                COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre, q.estado_operativo,
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
                COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre, q.estado_operativo,
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
