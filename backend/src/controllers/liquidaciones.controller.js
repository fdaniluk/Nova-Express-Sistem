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
    // `contenido` ('paquete' | 'documento') selecciona la tarifa de documento de DHL hasta
    // 2 kg. El cotizador manual siempre lo mandó; Cargar envío no, y por eso las dos
    // pantallas daban números distintos para el mismo documento. Si no viene se asume
    // 'paquete', que es el comportamiento histórico (no rompe otros llamadores).
    const { pais, tipo, servicio, pesoFacturable, fob, fuelPct, profitPct, zona, bultos, ddp, remota, entrega, cliente_id, profitManual, contenido } = req.body;
    if (!servicio || !pesoFacturable) {
      return res.status(400).json({ error: 'servicio y pesoFacturable son obligatorios' });
    }

    const tipoEfectivo = tipo || 'export';

    // Resolución de la tarifa de venta: manual del body > cliente > profitPct plano.
    // El cliente puede estar en modo porcentaje (matriz de profit) o en modo precio por
    // kilo (tarifa_kg_overrides); de eso se encarga resolverTarifaVenta, que es el único
    // lugar donde se decide. Sin cliente_id (o con profitManual) el comportamiento es
    // idéntico al histórico.
    let profitEfectivo = profitPct || 0;
    let profitOrigen = 'body';
    let precioKgVenta = null;
    let modoVenta = 'porcentaje';
    let advertencia = null;
    let fuelEfectivo = Number(fuelPct) || 0;
    let fuelOrigen = 'body';

    if (profitManual === true) {
      profitOrigen = 'manual';
    } else if (cliente_id) {
      const servicioMatriz = normalizarServicioMatriz(servicio);
      // Misma selección de tabla de zonas que el motor: DHL siempre ZONAS_DHL; UPS
      // según tipo. buscarZona aplica precedencia país y luego la zona del body.
      const zonasMap =
        servicio === 'DHL' ? ZONAS_DHL : tipoEfectivo === 'import' ? ZONAS_UPS_I : ZONAS_UPS;
      const zonaResuelta = buscarZona(zonasMap, pais, zona);
      const resuelto = await profitService.resolverTarifaVenta({
        clienteId: cliente_id,
        servicio: servicioMatriz,
        tipo: tipoEfectivo,
        zona: zonaResuelta,
        pesoFacturable,
      });
      if (resuelto) {
        profitEfectivo = resuelto.profitPct;
        profitOrigen = resuelto.origen;
        precioKgVenta = resuelto.precioKg;
        modoVenta = resuelto.modo;
        advertencia = resuelto.advertencia;
      } else {
        // Cliente inexistente: no rompemos, caemos al profitPct del body y avisamos.
        console.warn(
          `[cotizar] resolverTarifaVenta devolvió null (cliente_id=${cliente_id} inexistente); se usa profitPct del body`
        );
        profitOrigen = 'body';
      }
    }

    // Fuel propio del cliente: si lo tiene cargado, pisa al de Configuración que viene en
    // el body. Es por cliente, no por envío: el envío igual congela el % que se le aplicó.
    if (cliente_id) {
      const fuelPropio = await profitService.resolverFuelPropio(cliente_id);
      if (fuelPropio !== null) {
        fuelEfectivo = fuelPropio;
        fuelOrigen = 'cliente';
      }
    }

    const resultado = cotizarEnvio({ pais, tipo: tipoEfectivo, servicio, pesoFacturable, fob: fob || 0, fuelPct: fuelEfectivo, profitPct: profitEfectivo, zonaOverride: zona, bultos: bultos || [], remota: remota || false, entrega, ddp: ddp || false, contenido: contenido === 'documento' ? 'documento' : 'paquete', precioKgVenta });
    if (!resultado) {
      const desc = pais ? `País "${pais}"` : `Zona ${zona}`;
      return res.status(404).json({ error: `${desc} no encontrado para ${servicio}` });
    }
    res.json({
      ...resultado,
      profit_aplicado: profitEfectivo,
      profit_origen: profitOrigen,
      modo_venta: modoVenta,
      precio_kg_aplicado: precioKgVenta,
      fuel_aplicado: fuelEfectivo,
      fuel_origen: fuelOrigen,
      advertencia,
    });
  } catch (e) {
    next(e);
  }
}

module.exports = { pendientes, preview, crear, confirmar, listar, obtener, exportar, cotizar };
