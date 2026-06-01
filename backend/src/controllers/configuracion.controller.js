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

module.exports = { listarFuel, actualizarFuel, historialFuel };
