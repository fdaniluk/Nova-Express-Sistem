const configuracionModel = require('../models/configuracion.model');

async function listarFuel(req, res, next) {
  try {
    res.json(await configuracionModel.listarFuel());
  } catch (e) {
    next(e);
  }
}

async function actualizarFuel(req, res, next) {
  try {
    const courier = req.params.courier?.toUpperCase();
    if (!['DHL', 'UPS'].includes(courier)) {
      return res.status(400).json({ error: 'Courier debe ser DHL o UPS' });
    }
    const { fuel_pct } = req.body;
    if (fuel_pct === undefined || Number.isNaN(Number(fuel_pct))) {
      return res.status(400).json({ error: 'fuel_pct es obligatorio y numérico' });
    }
    const cfg = await configuracionModel.actualizarFuel(courier, Number(fuel_pct));
    res.json(cfg);
  } catch (e) {
    next(e);
  }
}

async function historialFuel(req, res, next) {
  try {
    const courier = req.query.courier?.toUpperCase();
    res.json(await configuracionModel.historialFuel(courier));
  } catch (e) {
    next(e);
  }
}

async function listarUmbrales(req, res, next) {
  try {
    res.json(await configuracionModel.listarUmbrales());
  } catch (e) {
    next(e);
  }
}

async function actualizarUmbral(req, res, next) {
  try {
    const courier = req.params.courier?.toUpperCase();
    if (!['DHL', 'UPS'].includes(courier)) {
      return res.status(400).json({ error: 'Courier debe ser DHL o UPS' });
    }
    const { ganancia_minima_pct } = req.body;
    if (ganancia_minima_pct === undefined || Number.isNaN(Number(ganancia_minima_pct))) {
      return res.status(400).json({ error: 'ganancia_minima_pct es obligatorio y numérico' });
    }
    const cfg = await configuracionModel.actualizarUmbral(courier, Number(ganancia_minima_pct));
    res.json(cfg);
  } catch (e) {
    next(e);
  }
}

async function historialUmbral(req, res, next) {
  try {
    const courier = req.query.courier?.toUpperCase();
    res.json(await configuracionModel.historialUmbral(courier));
  } catch (e) {
    next(e);
  }
}

async function listarTolerancias(req, res, next) {
  try {
    res.json(await configuracionModel.listarTolerancias());
  } catch (e) {
    next(e);
  }
}

// Valida un porcentaje de tolerancia: numérico, no negativo, rango razonable 0 a 100.
function validarTolerancia(valor, nombre) {
  const n = Number(valor);
  if (valor === undefined || valor === null || valor === '' || Number.isNaN(n)) {
    return `${nombre} es obligatorio y numérico`;
  }
  if (n < 0 || n > 100) {
    return `${nombre} debe estar entre 0 y 100`;
  }
  return null;
}

async function actualizarTolerancias(req, res, next) {
  try {
    const courier = req.params.courier?.toUpperCase();
    if (!['DHL', 'UPS'].includes(courier)) {
      return res.status(400).json({ error: 'Courier debe ser DHL o UPS' });
    }
    const { tolerancia_peso_pct, tolerancia_costo_pct } = req.body;
    const errPeso = validarTolerancia(tolerancia_peso_pct, 'tolerancia_peso_pct');
    if (errPeso) return res.status(400).json({ error: errPeso });
    const errCosto = validarTolerancia(tolerancia_costo_pct, 'tolerancia_costo_pct');
    if (errCosto) return res.status(400).json({ error: errCosto });
    const cfg = await configuracionModel.actualizarTolerancias(
      courier, Number(tolerancia_peso_pct), Number(tolerancia_costo_pct)
    );
    res.json(cfg);
  } catch (e) {
    next(e);
  }
}

module.exports = {
  listarFuel, actualizarFuel, historialFuel,
  listarUmbrales, actualizarUmbral, historialUmbral,
  listarTolerancias, actualizarTolerancias,
};
