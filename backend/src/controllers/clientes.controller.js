const clienteModel = require('../models/cliente.model');
const { getDb } = require('../db');
const { deriveProfit, utilidadEnvio, SUBQUERY_LIQUIDACION, SUBQUERY_CARGOS } = require('../utils/profit');

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
    const nombre = String(req.body.razon_social || req.body.nombre || '').trim();
    if (!nombre) {
      return res.status(400).json({ error: 'razon_social es obligatorio' });
    }
    const cliente = await clienteModel.crear(req.body);
    res.status(201).json(clienteModel.parseTarifa(cliente));
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ya existe un cliente con ese nombre' });
    }
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
}

async function actualizar(req, res, next) {
  try {
    const cliente = await clienteModel.actualizar(req.params.id, req.body);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(clienteModel.parseTarifa(cliente));
  } catch (e) {
    // modo_tarifa / fuel_pct_propio / tipo_cobro inválidos llegan como 400 desde el modelo:
    // se devuelve el mensaje, no un 500 pelado.
    if (e.status === 400) return res.status(400).json({ error: e.message });
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ya existe un cliente con ese nombre' });
    }
    next(e);
  }
}

/* Activar / desactivar (17/09/2026). Un cliente inactivo conserva todo su historial pero
   no aparece en los selectores del sistema ni en la lista (salvo con el filtro). */
async function activar(req, res, next) {
  try {
    const cliente = await clienteModel.actualizar(req.params.id, { activo: req.body?.activo !== false });
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(clienteModel.parseTarifa(cliente));
  } catch (e) {
    next(e);
  }
}

async function eliminar(req, res, next) {
  try {
    const borrado = await clienteModel.eliminar(req.params.id);
    if (!borrado) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.status(204).end();
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    if (e.status === 409) return res.status(409).json({ error: e.message, dependencias: e.dependencias });
    next(e);
  }
}

async function perfil(req, res, next) {
  try {
    const db = getDb();
    const { id } = req.params;

    const cliente = await clienteModel.buscarPorId(id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    // La utilidad por envío se deriva en JS con deriveProfit: la MISMA función y la MISMA
    // precedencia que usan Salidas y el Dashboard (costo real de factura aprobada > foto de
    // la liquidación confirmada > estimación venta − costo del desglose congelado). Antes acá
    // se hacía total_cobrado × tarifa_pct en SQL, que solo es cierto para el cliente
    // porcentual "de manual": pisaba a los por-kilo, a las tarifas negociadas y al costo real.
    // El LEFT JOIN a liquidacion_items va pre-agregado por envío (GROUP BY envio_id) para
    // garantizar UNA fila por envío, igual que en el Dashboard.
    const filas = await db
      .prepare(
        `SELECT
           e.id,
           e.numero_guia,
           e.fecha,
           e.pais_destino AS pais,
           e.courier,
           e.asegurado,
           e.liquidado,
           e.no_volo,
           e.total_cobrado AS total,
           e.flete, e.descuento, e.seguro, e.fuel, e.derechos, e.adicionales, e.otros,
           e.profit, e.porcentaje,
           e.estado_revision, e.costo_facturado,
           li.utilidad_usd AS utilidad_liq,
           li.venta_liq    AS venta_liq,
           cp.cargos_post  AS cargos_post,
           cp.cargos_ddp   AS cargos_ddp
         FROM envios e
         LEFT JOIN (${SUBQUERY_LIQUIDACION}) li ON li.envio_id = e.id
         LEFT JOIN (${SUBQUERY_CARGOS}) cp ON cp.envio_id = e.id
         WHERE e.cliente_id = ?
         ORDER BY e.fecha DESC, e.id DESC`
      )
      .all(id);

    const round2 = (n) => Math.round((n || 0) * 100) / 100;


    let utilidadTotal = 0;
    let ultimaLiquidacion = null;
    const porMes = new Map();
    const guias = [];

    for (const row of filas) {
      // NO VOLO: el envio se sigue MOSTRANDO en la lista de guias del cliente (existe, tiene
      // su numero y su guia), pero no suma un peso en la utilidad ni en el conteo mensual.
      // Mismo criterio que el Dashboard: un envio que nunca salio no mueve la estadistica.
      const noVolo = Boolean(row.no_volo);
      const u = noVolo ? 0 : utilidadEnvio(row);
      utilidadTotal += u;

      const mes = String(row.fecha || '').slice(0, 7);
      if (row.liquidado && mes && (!ultimaLiquidacion || mes > ultimaLiquidacion)) {
        ultimaLiquidacion = mes;
      }
      if (mes && !noVolo) {
        let m = porMes.get(mes);
        if (!m) { m = { mes, utilidad_usd: 0, cantidad_envios: 0 }; porMes.set(mes, m); }
        m.utilidad_usd += u;
        m.cantidad_envios += 1;
      }

      guias.push({
        id: row.id,
        numero_guia: row.numero_guia,
        fecha: row.fecha,
        pais: row.pais,
        courier: row.courier,
        asegurado: Boolean(row.asegurado),
        total_cobrado_usd: round2(row.total),
        utilidad_usd: round2(u),
        no_volo: noVolo,
        estado: noVolo ? 'no_volo' : (row.liquidado ? 'liquidado' : 'pendiente'),
      });
    }

    const utilidadMensual = [...porMes.values()]
      .sort((a, b) => b.mes.localeCompare(a.mes))
      .slice(0, 12);

    res.json({
      cliente: clienteModel.parseTarifa(cliente),
      stats: {
        total_guias: filas.filter((r) => !r.no_volo).length,
        guias_no_volaron: filas.filter((r) => Boolean(r.no_volo)).length,
        utilidad_total_usd: round2(utilidadTotal),
        ultima_liquidacion: ultimaLiquidacion,
      },
      utilidad_mensual: utilidadMensual.map((r) => ({
        mes: r.mes,
        utilidad_usd: round2(r.utilidad_usd),
        cantidad_envios: r.cantidad_envios,
      })),
      guias,
    });
  } catch (e) {
    next(e);
  }
}

module.exports = { listar, buscarPorId, crear, actualizar, activar, eliminar, perfil };
