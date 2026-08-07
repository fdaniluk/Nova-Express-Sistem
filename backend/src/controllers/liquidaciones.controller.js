const liquidacionModel = require('../models/liquidacion.model');
const envioModel = require('../models/envio.model');
const excelService = require('../services/excel.service');
const profitService = require('../services/profit.service');
const cotizacionService = require('../services/cotizacion.service');
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
    // TODA la resolución de parámetros vive en cotizacion.service. Este handler ya no
    // decide nada: recibe, normaliza y llama al motor.
    //
    // Antes armaba acá el fuel, la zona y el profit, y cada pantalla mandaba lo suyo por
    // su cuenta. Así se desviaron cuatro veces (contenido, ddp, el fuel en 0 de "Calcular
    // venta", y el profit resuelto sin país). Mientras la resolución esté en un solo
    // lugar, una pantalla nueva no puede inventar su propia versión de la verdad.
    //
    // Acepta las dos formas:
    //   · body plano, como siempre (el cotizador manual y las liquidaciones);
    //   · { envio_id } y el servidor saca del envío todo lo que no venga en el body
    //     (lo usa "Calcular venta" de Salidas). Lo que venga en el body PISA al envío,
    //     porque la pantalla puede estar editando el peso o el país antes de guardar.
    const entrada = await cotizacionService.normalizarEntrada(req.body || {});

    if (!entrada.servicio || !entrada.pesoFacturable) {
      return res.status(400).json({ error: 'servicio y pesoFacturable son obligatorios' });
    }

    const resultado = cotizarEnvio({
      pais: entrada.pais,
      tipo: entrada.tipo,
      servicio: entrada.servicio,
      pesoFacturable: entrada.pesoFacturable,
      fob: entrada.fob,
      fuelPct: entrada.fuelPct,
      profitPct: entrada.profitPct,
      zonaOverride: entrada.zona,
      bultos: entrada.bultos,
      remota: false,
      entrega: entrada.entrega,
      ddp: entrada.ddp,
      proteccionDoc: entrada.proteccionDoc,
      contenido: entrada.contenido,
      precioKgVenta: entrada.precioKgVenta,
      seguroPropio: entrada.seguroPropio,
    });

    if (!resultado) {
      const desc = entrada.pais ? `País "${entrada.pais}"` : `Zona ${entrada.zona}`;
      return res.status(404).json({ error: `${desc} no encontrado para ${entrada.servicio}` });
    }

    res.json({
      ...resultado,
      profit_aplicado: entrada.profitPct,
      profit_origen: entrada.profit_origen,
      modo_venta: entrada.modo_venta,
      precio_kg_aplicado: entrada.precio_kg_aplicado,
      fuel_aplicado: entrada.fuelPct,
      fuel_origen: entrada.fuel_origen,
      seguro_propio: entrada.seguroPropio,
      zona_aplicada: entrada.zona,
      advertencia: entrada.advertencia,
    });
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: e.message });
    next(e);
  }
}

module.exports = { pendientes, preview, crear, confirmar, listar, obtener, exportar, cotizar };
