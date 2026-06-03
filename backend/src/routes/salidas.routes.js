const { Router } = require('express');
const { getDb } = require('../db');

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    let sql = `
      SELECT
        e.id,
        e.numero_salida,
        e.courier,
        e.fecha,
        e.numero_guia,
        e.pais_destino        AS destino,
        e.destino_raw,
        e.direccion,
        e.bulto,
        e.tipo_paquete,
        e.tipo_envio,
        e.cantidad_bultos,
        e.peso_real           AS peso,
        e.largo,
        e.ancho,
        e.alto,
        e.peso_volumetrico,
        e.peso_facturable,
        e.asegurado,
        e.fob                 AS valor_declarado,
        e.flete,
        e.descuento,
        e.seguro,
        e.fuel,
        e.derechos,
        e.adicionales,
        e.otros,
        e.total_cobrado       AS total,
        e.profit,
        e.porcentaje,
        e.observaciones,
        e.liquidado,
        e.fecha_liquidacion,
        e.liquidacion_id,
        e.created_at,
        c.id                  AS cliente_id,
        c.nombre              AS cliente_nombre,
        c.tipo_cobro
      FROM envios e
      JOIN clientes c ON c.id = e.cliente_id
      WHERE 1=1`;

    const params = [];

    if (req.query.desde) {
      sql += ' AND e.fecha >= ?';
      params.push(req.query.desde);
    }
    if (req.query.hasta) {
      sql += ' AND e.fecha <= ?';
      params.push(req.query.hasta);
    }

    sql += ' ORDER BY e.fecha DESC, e.id DESC';

    const rows = await db.prepare(sql).all(...params);

    const result = rows.map((row) => ({
      id: row.id,
      numero_salida: row.numero_salida,
      courier: row.courier,
      fecha: row.fecha,
      numero_guia: row.numero_guia,
      tipo_cobro: row.tipo_cobro,
      cliente_id: row.cliente_id,
      cliente_nombre: row.cliente_nombre,
      destino: row.destino,
      destino_raw: row.destino_raw,
      direccion: row.direccion || (row.tipo_envio === 'importacion' ? 'impo' : 'expo'),
      bulto: row.bulto,
      tipo_paquete: row.tipo_paquete,
      cantidad_bultos: row.cantidad_bultos,
      peso: row.peso,
      largo: row.largo,
      ancho: row.ancho,
      alto: row.alto,
      peso_volumetrico: row.peso_volumetrico,
      peso_facturable: row.peso_facturable,
      asegurado: Boolean(row.asegurado),
      valor_declarado: row.valor_declarado,
      flete: row.flete,
      descuento: row.descuento,
      seguro: row.seguro,
      fuel: row.fuel,
      derechos: row.derechos,
      adicionales: row.adicionales,
      otros: row.otros,
      total: row.total,
      profit: row.profit,
      porcentaje: row.porcentaje,
      observaciones: row.observaciones,
      liquidado: Boolean(row.liquidado),
      fecha_liquidacion: row.fecha_liquidacion,
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Campos editables desde la vista Salidas.
// Bloqueados: cliente_id, courier, fecha, pais_destino, liquidado, liquidacion_id.
const SALIDAS_EDITABLE = [
  'numero_guia', 'numero_salida', 'bulto', 'tipo_paquete', 'asegurado', 'direccion',
  'flete', 'descuento', 'seguro', 'fuel', 'derechos', 'adicionales', 'otros',
  'profit', 'porcentaje', 'observaciones',
];

router.patch('/:id', async (req, res, next) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

    const existing = await db.prepare('SELECT id, numero_guia FROM envios WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Envío no encontrado' });

    const picked = {};
    for (const field of SALIDAS_EDITABLE) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        picked[field] = req.body[field];
      }
    }

    if (Object.keys(picked).length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    // numero_guia es UNIQUE: validar que no exista en otro envío
    if (picked.numero_guia !== undefined && picked.numero_guia !== existing.numero_guia) {
      if (!picked.numero_guia) {
        return res.status(400).json({ error: 'El número de guía no puede estar vacío' });
      }
      const dupe = await db
        .prepare('SELECT id FROM envios WHERE numero_guia = ? AND id != ?')
        .get(picked.numero_guia, id);
      if (dupe) {
        return res.status(409).json({ error: `Ya existe un envío con la guía "${picked.numero_guia}"` });
      }
    }

    const setClauses = Object.keys(picked).map((f) => `${f} = ?`).join(', ');
    const values = [...Object.values(picked), id];
    await db
      .prepare(`UPDATE envios SET ${setClauses}, updated_at = datetime('now', 'localtime') WHERE id = ?`)
      .run(...values);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
