const { Router } = require('express');
const { getDb } = require('../db');
const { deriveProfit, costoEstimado } = require('../utils/profit');
const { hoyLocal, hoyLocalMas } = require('../utils/fecha');

const router = Router();

function getFechaDesde(periodo) {
  const now = new Date();
  // hoyLocal(): con toISOString() (UTC) el período 'hoy' apuntaba a mañana después de
  // las 21:00 y el dashboard salía vacío.
  if (periodo === 'hoy') {
    return hoyLocal(now);
  }
  if (periodo === 'semana') {
    return hoyLocalMas(-7, now);
  }
  // 'mes' — primer día del mes en curso
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

router.get('/metricas', async (req, res, next) => {
  try {
    const mesParam = req.query.mes;
    let desde;
    let hasta;
    let modoMes = false;

    if (mesParam !== undefined) {
      if (!/^\d{4}-\d{2}$/.test(mesParam)) {
        return res.status(400).json({ error: 'Formato de mes inválido, se espera YYYY-MM' });
      }
      const [anio, mes] = mesParam.split('-').map(Number);
      if (mes < 1 || mes > 12) {
        return res.status(400).json({ error: 'Mes fuera de rango (01-12)' });
      }
      modoMes = true;
      desde = `${mesParam}-01`;
      // Cota superior EXCLUSIVA: primer día del mes siguiente (diciembre -> enero del año siguiente)
      const anioHasta = mes === 12 ? anio + 1 : anio;
      const mesHasta = mes === 12 ? 1 : mes + 1;
      hasta = `${anioHasta}-${String(mesHasta).padStart(2, '0')}-01`;
    } else {
      const periodo = req.query.periodo || 'mes';
      desde = getFechaDesde(periodo);
      hasta = '9999-12-31';
    }

    const periodo = req.query.periodo || 'mes';
    const db = getDb();

    // La utilidad ya NO se resuelve en SQL: el profit por envío se deriva en JS con
    // deriveProfit (la MISMA función que Salidas), así que traemos los envíos del período
    // con sus columnas de costo + total_cobrado y la utilidad de la liquidación confirmada,
    // y agregamos utilidad_neta / top_clientes / chart_data en memoria.
    // El LEFT JOIN a liquidacion_items se pre-agrega por envío (subquery GROUP BY envio_id)
    // para garantizar UNA fila por envío: sin eso, un envío con varios items confirmados se
    // duplicaría e inflaría counts y sumas.
    const [
      enviosPeriodo,
      kilosRow,
      enviosRow,
      pendientesRow,
      clientesNuevosRow,
      paisRow,
      couriersRows,
    ] = await Promise.all([
      db
        .prepare(
          `SELECT
             e.id,
             e.created_at,
             e.fecha,
             e.peso_facturable,
             e.total_cobrado AS total,
             e.flete, e.descuento, e.seguro, e.fuel, e.derechos, e.adicionales, e.otros,
             e.profit, e.porcentaje,
             e.estado_revision, e.costo_facturado,
             c.id     AS cliente_id,
             c.nombre AS cliente_nombre,
             li.utilidad_usd AS utilidad_liq,
             li.venta_liq    AS venta_liq
           FROM envios e
           JOIN clientes c ON c.id = e.cliente_id
           LEFT JOIN (
             SELECT envio_id,
                    SUM(utilidad_usd) AS utilidad_usd,
                    SUM(total_usd)    AS venta_liq
             FROM liquidacion_items
             WHERE liquidacion_id IN (SELECT id FROM liquidaciones WHERE estado = 'confirmada')
             GROUP BY envio_id
           ) li ON li.envio_id = e.id
           WHERE e.fecha >= ? AND e.fecha < ?`
        )
        .all(desde, hasta),

      db
        .prepare(
          `SELECT SUM(peso_facturable) AS kilos_facturados,
                  SUM(cantidad_bultos) AS bultos_despachados
           FROM envios WHERE fecha >= ? AND fecha < ?`
        )
        .get(desde, hasta),

      db
        .prepare(
          `SELECT COUNT(*) AS total, AVG(total_cobrado) AS ticket_promedio
           FROM envios WHERE fecha >= ? AND fecha < ?`
        )
        .get(desde, hasta),

      db.prepare(`SELECT COUNT(*) AS n FROM envios WHERE liquidado = 0`).get(),

      db
        .prepare(
          `SELECT COUNT(*) AS n FROM clientes WHERE date(created_at) >= ? AND date(created_at) < ?`
        )
        .get(desde, hasta),

      db
        .prepare(
          `SELECT pais_destino, COUNT(*) AS n
           FROM envios WHERE fecha >= ? AND fecha < ?
           GROUP BY pais_destino ORDER BY n DESC LIMIT 1`
        )
        .get(desde, hasta),

      db
        .prepare(
          `SELECT courier, COUNT(*) AS cantidad
           FROM envios WHERE fecha >= ? AND fecha < ?
           GROUP BY courier ORDER BY cantidad DESC`
        )
        .all(desde, hasta),
    ]);

    const totalEnvios = enviosRow.total || 0;
    const round2 = (n) => Math.round((n || 0) * 100) / 100;
    const round1 = (n) => Math.round((n || 0) * 10) / 10;

    // Utilidad de UN envío. Precedencia de arriba hacia abajo (la primera que aplica gana):
    //   1. COSTO REAL (Etapa 3): factura UPS aprobada (estado_revision='revisado_ok' con
    //      costo_facturado). deriveProfit devuelve profit_real=true → venta − costo real.
    //      GANA sobre la foto de la liquidación: los envíos D/S/Q se liquidan ANTES de que
    //      llegue la factura, así que la realidad recién conocida debe pisar la estimación
    //      congelada. Es la MISMA función/valor que pinta cada fila en Salidas → coinciden.
    //   2. LIQUIDACIÓN confirmada → li.utilidad_usd (snapshot congelado). IGUAL QUE ANTES.
    //   3. ESTIMACIÓN → profit venta − costo estimado vía deriveProfit. IGUAL QUE ANTES.
    // Si deriveProfit no puede calcular (costo 0 y sin liquidación) devuelve profit null:
    // ese envío cuenta 0 (no null), para no romper la suma.
    const utilidadEnvio = (row) => {
      const { profit, profit_real } = deriveProfit(row);
      if (profit_real) return profit;
      if (row.utilidad_liq != null) return row.utilidad_liq;
      return profit == null ? 0 : profit;
    };

    // Agregación en una sola pasada: total del período, acumulado por cliente y por
    // bucket del gráfico. El gráfico agrupa por hora (created_at) en 'hoy', si no por fecha.
    const chartHoy = !modoMes && periodo === 'hoy';
    let utilidadNeta = 0;
    const porCliente = new Map();
    const porChart = new Map();

    // DESVÍO DE COTIZACIÓN (solo envíos con factura ya aprobada, únicos comparables contra
    // la verdad): cuánto nos desviamos al estimar. desvio_envio = costo real − costo estimado.
    // Positivo = UPS cobró MÁS que lo estimado → cotizamos corto y perdemos margen.
    let desvioTotal = 0;    // Σ (costo_facturado − costo_estimado) de los 'revisado_ok'
    let desvioBase = 0;     // Σ costo_estimado de esos mismos, denominador del %
    let cantidadComparados = 0;
    // PLATA EN DISPUTA (envíos en reclamo con factura cargada): utilidad optimista que
    // todavía se está peleando con UPS y podría evaporarse si UPS gana el reclamo.
    let disputaTotal = 0;   // Σ (costo_facturado − costo_estimado) de los 'reclamar'
    let disputaCantidad = 0;

    for (const row of enviosPeriodo) {
      const u = utilidadEnvio(row);
      utilidadNeta += u;

      // Métricas de comparación estimación vs. real. El costo estimado SALE de la misma
      // fuente que deriveProfit (costoEstimado), así son consistentes con la utilidad.
      if (row.costo_facturado != null) {
        if (row.estado_revision === 'revisado_ok') {
          const est = costoEstimado(row);
          desvioTotal += row.costo_facturado - est;
          desvioBase += est;
          cantidadComparados += 1;
        } else if (row.estado_revision === 'reclamar') {
          disputaTotal += row.costo_facturado - costoEstimado(row);
          disputaCantidad += 1;
        }
      }

      let cl = porCliente.get(row.cliente_id);
      if (!cl) {
        cl = { id: row.cliente_id, nombre: row.cliente_nombre, envios: 0, kilos: 0, utilidad_usd: 0 };
        porCliente.set(row.cliente_id, cl);
      }
      cl.envios += 1;
      cl.kilos += row.peso_facturable || 0;
      cl.utilidad_usd += u;

      // Clave de bucket ordenable (HH o YYYY-MM-DD); label es lo que ve el usuario.
      const key = chartHoy ? `${String(row.created_at || '').slice(11, 13)}:00` : row.fecha;
      let ch = porChart.get(key);
      if (!ch) {
        const label = chartHoy ? key : `${row.fecha.slice(8, 10)}/${row.fecha.slice(5, 7)}`;
        ch = { key, label, utilidad_usd: 0, envios: 0 };
        porChart.set(key, ch);
      }
      ch.utilidad_usd += u;
      ch.envios += 1;
    }

    const topClientesRows = [...porCliente.values()]
      .sort((a, b) => b.utilidad_usd - a.utilidad_usd)
      .slice(0, 5);

    const chartRows = [...porChart.values()].sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    );

    res.json({
      utilidad_neta_usd: round2(utilidadNeta),
      desvio_cotizacion_usd: round2(desvioTotal),
      desvio_cotizacion_pct: desvioBase !== 0 ? round2((desvioTotal / desvioBase) * 100) : 0,
      cantidad_envios_comparados: cantidadComparados,
      disputa_usd: round2(disputaTotal),
      disputa_cantidad: disputaCantidad,
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

router.get('/meses', async (req, res, next) => {
  try {
    const db = getDb();
    const rows = await db
      .prepare(
        `SELECT strftime('%Y-%m', fecha) AS mes, COUNT(*) AS n
         FROM envios GROUP BY mes ORDER BY mes DESC`
      )
      .all();
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
