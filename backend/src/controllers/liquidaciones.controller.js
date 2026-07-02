const liquidacionModel = require('../models/liquidacion.model');
const envioModel = require('../models/envio.model');
const excelService = require('../services/excel.service');
const profitService = require('../services/profit.service');
const {
  cotizarEnvio,
  buscarZona,
  ZONAS_DHL,
  ZONAS_UPS,
  ZONAS_UPS_I,
} = require('../services/calculos.service');

// Normaliza el servicio del body (DHL | UPS_EXP | UPS_SAV) al enum de la matriz de
// profit (DHL | UPS_EXP | UPS_SAVER). Igual criterio que el motor: todo lo que no es
// DHL ni UPS_EXP se trata como Saver.
function normalizarServicioMatriz(servicio) {
  if (servicio === 'DHL') return 'DHL';
  if (servicio === 'UPS_EXP') return 'UPS_EXP';
  return 'UPS_SAVER';
}

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
    const { pais, tipo, servicio, pesoFacturable, fob, fuelPct, profitPct, zona, bultos, ddp, cliente_id, profitManual } = req.body;
    if (!servicio || !pesoFacturable) {
      return res.status(400).json({ error: 'servicio y pesoFacturable son obligatorios' });
    }

    const tipoEfectivo = tipo || 'export';

    // Resolución del profit: manual del body > matriz del cliente > profitPct plano.
    // Sin cliente_id (o con profitManual) el comportamiento es idéntico al histórico.
    let profitEfectivo = profitPct || 0;
    let profitOrigen = 'body';

    if (profitManual === true) {
      profitOrigen = 'manual';
    } else if (cliente_id) {
      const servicioMatriz = normalizarServicioMatriz(servicio);
      // Misma selección de tabla de zonas que el motor: DHL siempre ZONAS_DHL; UPS
      // según tipo. buscarZona aplica precedencia país y luego la zona del body.
      const zonasMap =
        servicio === 'DHL' ? ZONAS_DHL : tipoEfectivo === 'import' ? ZONAS_UPS_I : ZONAS_UPS;
      const zonaResuelta = buscarZona(zonasMap, pais, zona);
      const resuelto = await profitService.resolverProfit({
        clienteId: cliente_id,
        servicio: servicioMatriz,
        tipo: tipoEfectivo,
        zona: zonaResuelta,
        pesoFacturable,
      });
      if (resuelto) {
        profitEfectivo = resuelto.profitPct;
        profitOrigen = resuelto.origen;
      } else {
        // Cliente inexistente: no rompemos, caemos al profitPct del body y avisamos.
        console.warn(
          `[cotizar] resolverProfit devolvió null (cliente_id=${cliente_id} inexistente); se usa profitPct del body`
        );
        profitOrigen = 'body';
      }
    }

    const resultado = cotizarEnvio({ pais, tipo: tipoEfectivo, servicio, pesoFacturable, fob: fob || 0, fuelPct: fuelPct || 0, profitPct: profitEfectivo, zonaOverride: zona, bultos: bultos || [], ddp: ddp || false });
    if (!resultado) {
      const desc = pais ? `País "${pais}"` : `Zona ${zona}`;
      return res.status(404).json({ error: `${desc} no encontrado para ${servicio}` });
    }
    res.json({ ...resultado, profit_aplicado: profitEfectivo, profit_origen: profitOrigen });
  } catch (e) {
    next(e);
  }
}

module.exports = { pendientes, preview, crear, confirmar, listar, obtener, exportar, cotizar };
