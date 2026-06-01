const liquidacionModel = require('../models/liquidacion.model');
const envioModel = require('../models/envio.model');
const excelService = require('../services/excel.service');
const { cotizarEnvio } = require('../services/calculos.service');

async function pendientes(req, res, next) {
  try {
    res.json(await envioModel.listarPendientesPorCliente(req.query));
  } catch (e) {
    next(e);
  }
}

async function preview(req, res, next) {
  try {
    const { cliente_id, envio_ids, cargos, cotizaciones } = req.body;
    if (!cliente_id || !envio_ids?.length) {
      return res.status(400).json({ error: 'cliente_id y envio_ids son obligatorios' });
    }
    res.json(await liquidacionModel.preview({
      cliente_id,
      envio_ids,
      cargos: cargos || [],
      cotizaciones: cotizaciones || [],
    }));
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
}

async function crear(req, res, next) {
  try {
    const { cliente_id, periodo_desde, periodo_hasta, envio_ids, cargos, cotizaciones, confirmar } =
      req.body;
    if (!cliente_id || !periodo_desde || !periodo_hasta || !envio_ids?.length) {
      return res
        .status(400)
        .json({ error: 'cliente_id, periodo_desde, periodo_hasta y envio_ids son obligatorios' });
    }
    const liq = await liquidacionModel.crear({
      cliente_id,
      periodo_desde,
      periodo_hasta,
      envio_ids,
      cargos: cargos || [],
      cotizaciones: cotizaciones || [],
      confirmar: Boolean(confirmar),
    });
    res.status(201).json(liq);
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
}

async function confirmar(req, res, next) {
  try {
    const liq = await liquidacionModel.confirmar(req.params.id);
    if (!liq) return res.status(404).json({ error: 'Liquidación no encontrada' });
    res.json(liq);
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
}

async function listar(req, res, next) {
  try {
    res.json(await liquidacionModel.listar(req.query));
  } catch (e) {
    next(e);
  }
}

async function obtener(req, res, next) {
  try {
    const liq = await liquidacionModel.buscarPorId(req.params.id);
    if (!liq) return res.status(404).json({ error: 'Liquidación no encontrada' });
    res.json(liq);
  } catch (e) {
    next(e);
  }
}

async function exportar(req, res, next) {
  try {
    const liq = await liquidacionModel.buscarPorId(req.params.id);
    if (!liq) return res.status(404).json({ error: 'Liquidación no encontrada' });
    const buffer = await excelService.exportarLiquidacion(liq);
    const filename = excelService.nombreArchivoExport(liq.cliente_nombre, liq.fecha);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) {
    next(e);
  }
}

// Endpoint para cotizar un envío puntual sin guardarlo
async function cotizar(req, res, next) {
  try {
    const { pais, tipo, servicio, pesoFacturable, fob, fuelPct, profitPct } = req.body;
    if (!pais || !servicio || !pesoFacturable) {
      return res.status(400).json({ error: 'pais, servicio y pesoFacturable son obligatorios' });
    }
    const resultado = cotizarEnvio({ pais, tipo: tipo || 'export', servicio, pesoFacturable, fob: fob || 0, fuelPct: fuelPct || 0, profitPct: profitPct || 0 });
    if (!resultado) {
      return res.status(404).json({ error: `País "${pais}" no encontrado para ${servicio}` });
    }
    res.json(resultado);
  } catch (e) {
    next(e);
  }
}

module.exports = { pendientes, preview, crear, confirmar, listar, obtener, exportar, cotizar };
