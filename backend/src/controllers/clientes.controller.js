const clienteModel = require('../models/cliente.model');
const { getDb } = require('../db');

async function listar(req, res, next) {
  try {
    const clientes = (await clienteModel.listar(req.query)).map(clienteModel.parseTarifa);
    res.json(clientes);
  } catch (e) {
    next(e);
  }
}

async function buscarPorId(req, res, next) {
  try {
    const cliente = await clienteModel.buscarPorId(req.params.id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(clienteModel.parseTarifa(cliente));
  } catch (e) {
    next(e);
  }
}

async function crear(req, res, next) {
  try {
    const nombre = req.body.razon_social || req.body.nombre;
    if (!nombre) {
      return res.status(400).json({ error: 'razon_social es obligatorio' });
    }
    const cliente = await clienteModel.crear(req.body);
    res.status(201).json(clienteModel.parseTarifa(cliente));
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ya existe un cliente con ese nombre' });
    }
    next(e);
  }
}

async function actualizar(req, res, next) {
  try {
    const cliente = await clienteModel.actualizar(req.params.id, req.body);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(clienteModel.parseTarifa(cliente));
  } catch (e) {
    next(e);
  }
}

async function eliminar(req, res, next) {
  try {
    await clienteModel.eliminar(req.params.id);
    res.status(204).end();
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
}

async function perfil(req, res, next) {
  try {
    const db = getDb();
    const { id } = req.params;

    const cliente = await clienteModel.buscarPorId(id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    const [statsRow, guias, utilidadMensual] = await Promise.all([
      db
        .prepare(
          `SELECT
             COUNT(e.id) AS total_guias,
             SUM(COALESCE(li.utilidad_usd, e.total_cobrado * c.tarifa_pct / 100.0)) AS utilidad_total_usd,
             MAX(CASE WHEN e.liquidado = 1 THEN strftime('%Y-%m', e.fecha) ELSE NULL END) AS ultima_liquidacion
           FROM envios e
           JOIN clientes c ON c.id = e.cliente_id
           LEFT JOIN liquidacion_items li
                  ON li.envio_id = e.id
                 AND li.liquidacion_id IN (SELECT id FROM liquidaciones WHERE estado = 'confirmada')
           WHERE e.cliente_id = ?`
        )
        .get(id),

      db
        .prepare(
          `SELECT
             e.id,
             e.numero_guia,
             e.fecha,
             e.pais_destino AS pais,
             e.courier,
             e.asegurado,
             e.total_cobrado AS total_cobrado_usd,
             COALESCE(li.utilidad_usd, e.total_cobrado * c.tarifa_pct / 100.0) AS utilidad_usd,
             CASE WHEN e.liquidado = 1 THEN 'liquidado' ELSE 'pendiente' END AS estado
           FROM envios e
           JOIN clientes c ON c.id = e.cliente_id
           LEFT JOIN liquidacion_items li
                  ON li.envio_id = e.id
                 AND li.liquidacion_id IN (SELECT id FROM liquidaciones WHERE estado = 'confirmada')
           WHERE e.cliente_id = ?
           ORDER BY e.fecha DESC, e.id DESC`
        )
        .all(id),

      db
        .prepare(
          `SELECT
             strftime('%Y-%m', e.fecha) AS mes,
             SUM(COALESCE(li.utilidad_usd, e.total_cobrado * c.tarifa_pct / 100.0)) AS utilidad_usd,
             COUNT(e.id) AS cantidad_envios
           FROM envios e
           JOIN clientes c ON c.id = e.cliente_id
           LEFT JOIN liquidacion_items li
                  ON li.envio_id = e.id
                 AND li.liquidacion_id IN (SELECT id FROM liquidaciones WHERE estado = 'confirmada')
           WHERE e.cliente_id = ?
           GROUP BY mes
           ORDER BY mes DESC
           LIMIT 12`
        )
        .all(id),
    ]);

    const round2 = (n) => Math.round((n || 0) * 100) / 100;

    res.json({
      cliente: clienteModel.parseTarifa(cliente),
      stats: {
        total_guias: statsRow.total_guias || 0,
        utilidad_total_usd: round2(statsRow.utilidad_total_usd),
        ultima_liquidacion: statsRow.ultima_liquidacion || null,
      },
      utilidad_mensual: utilidadMensual.map((r) => ({
        mes: r.mes,
        utilidad_usd: round2(r.utilidad_usd),
        cantidad_envios: r.cantidad_envios,
      })),
      guias: guias.map((g) => ({
        id: g.id,
        numero_guia: g.numero_guia,
        fecha: g.fecha,
        pais: g.pais,
        courier: g.courier,
        asegurado: Boolean(g.asegurado),
        total_cobrado_usd: round2(g.total_cobrado_usd),
        utilidad_usd: round2(g.utilidad_usd),
        estado: g.estado,
      })),
    });
  } catch (e) {
    next(e);
  }
}

module.exports = { listar, buscarPorId, crear, actualizar, eliminar, perfil };
