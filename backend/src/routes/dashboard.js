const { Router } = require('express');
const { getDb } = require('../db');

const router = Router();

function getFechaDesde(periodo) {
  const now = new Date();
  if (periodo === 'hoy') {
    return now.toISOString().slice(0, 10);
  }
  if (periodo === 'semana') {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  }
  // 'mes' — primer día del mes en curso
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

router.get('/metricas', async (req, res, next) => {
  try {
    const periodo = req.query.periodo || 'mes';
    const fechaDesde = getFechaDesde(periodo);
    const db = getDb();

    const baseUtilidad = `
      SUM(COALESCE(li.utilidad_usd, e.total_cobrado * c.tarifa_pct / 100.0))`;

    const chartSql =
      periodo === 'hoy'
        ? `SELECT strftime('%H:00', e.created_at) AS label,
             ${baseUtilidad} AS utilidad_usd,
             COUNT(e.id) AS envios
           FROM envios e
           JOIN clientes c ON c.id = e.cliente_id
           LEFT JOIN liquidacion_items li ON li.envio_id = e.id
           WHERE e.fecha >= ?
           GROUP BY label ORDER BY label`
        : `SELECT strftime('%d/%m', e.fecha) AS label,
             ${baseUtilidad} AS utilidad_usd,
             COUNT(e.id) AS envios
           FROM envios e
           JOIN clientes c ON c.id = e.cliente_id
           LEFT JOIN liquidacion_items li ON li.envio_id = e.id
           WHERE e.fecha >= ?
           GROUP BY e.fecha ORDER BY e.fecha`;

    const [
      utilRow,
      kilosRow,
      enviosRow,
      pendientesRow,
      clientesNuevosRow,
      paisRow,
      couriersRows,
      topClientesRows,
      chartRows,
    ] = await Promise.all([
      db
        .prepare(
          `SELECT ${baseUtilidad} AS utilidad_neta_usd
           FROM envios e
           JOIN clientes c ON c.id = e.cliente_id
           LEFT JOIN liquidacion_items li ON li.envio_id = e.id
           WHERE e.fecha >= ?`
        )
        .get(fechaDesde),

      db
        .prepare(
          `SELECT SUM(peso_facturable) AS kilos_facturados,
                  SUM(cantidad_bultos) AS bultos_despachados
           FROM envios WHERE fecha >= ?`
        )
        .get(fechaDesde),

      db
        .prepare(
          `SELECT COUNT(*) AS total, AVG(total_cobrado) AS ticket_promedio
           FROM envios WHERE fecha >= ?`
        )
        .get(fechaDesde),

      db.prepare(`SELECT COUNT(*) AS n FROM envios WHERE liquidado = 0`).get(),

      db
        .prepare(`SELECT COUNT(*) AS n FROM clientes WHERE date(created_at) >= ?`)
        .get(fechaDesde),

      db
        .prepare(
          `SELECT pais_destino, COUNT(*) AS n
           FROM envios WHERE fecha >= ?
           GROUP BY pais_destino ORDER BY n DESC LIMIT 1`
        )
        .get(fechaDesde),

      db
        .prepare(
          `SELECT courier, COUNT(*) AS cantidad
           FROM envios WHERE fecha >= ?
           GROUP BY courier ORDER BY cantidad DESC`
        )
        .all(fechaDesde),

      db
        .prepare(
          `SELECT c.id, c.nombre,
             COUNT(e.id) AS envios,
             SUM(e.peso_facturable) AS kilos,
             ${baseUtilidad} AS utilidad_usd
           FROM envios e
           JOIN clientes c ON c.id = e.cliente_id
           LEFT JOIN liquidacion_items li ON li.envio_id = e.id
           WHERE e.fecha >= ?
           GROUP BY c.id ORDER BY utilidad_usd DESC LIMIT 5`
        )
        .all(fechaDesde),

      db.prepare(chartSql).all(fechaDesde),
    ]);

    const totalEnvios = enviosRow.total || 0;
    const round2 = (n) => Math.round((n || 0) * 100) / 100;
    const round1 = (n) => Math.round((n || 0) * 10) / 10;

    res.json({
      utilidad_neta_usd: round2(utilRow.utilidad_neta_usd),
      kilos_facturados: round1(kilosRow.kilos_facturados),
      bultos_despachados: kilosRow.bultos_despachados || 0,
      envios_totales: totalEnvios,
      ticket_promedio_usd: round2(enviosRow.ticket_promedio),
      clientes_nuevos: clientesNuevosRow.n || 0,
      envios_pendientes_liquidar: pendientesRow.n || 0,
      pais_mas_activo: paisRow ? paisRow.pais_destino : null,
      mix_couriers: couriersRows.map((r) => ({
        courier: r.courier,
        cantidad: r.cantidad,
        porcentaje: totalEnvios > 0 ? Math.round((r.cantidad / totalEnvios) * 100) : 0,
      })),
      top_clientes: topClientesRows.map((r) => ({
        id: r.id,
        nombre: r.nombre,
        envios: r.envios,
        kilos: round1(r.kilos),
        utilidad_usd: round2(r.utilidad_usd),
      })),
      chart_data: chartRows.map((r) => ({
        label: r.label,
        utilidad_usd: round2(r.utilidad_usd),
        envios: r.envios,
      })),
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
