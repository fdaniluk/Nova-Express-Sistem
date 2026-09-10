const configuracionModel = require('../models/configuracion.model');

// Devuelve los TRES fuels: NOVA, DHL y UPS. NOVA va primero porque es el que se usa por
// defecto al cargar un envio. La forma de cada fila es la misma para los tres, asi la
// pantalla no necesita casos especiales.
async function listarFuel(req, res, next) {
  try {
    res.json(await configuracionModel.listarFuelTodos());
  } catch (e) {
    next(e);
  }
}

async function actualizarFuel(req, res, next) {
  try {
    const courier = req.params.courier?.toUpperCase();
    if (!['DHL', 'UPS', 'NOVA'].includes(courier)) {
      return res.status(400).json({ error: 'Courier debe ser DHL, UPS o NOVA' });
    }
    const { fuel_pct } = req.body;
    if (fuel_pct === undefined || Number.isNaN(Number(fuel_pct))) {
      return res.status(400).json({ error: 'fuel_pct es obligatorio y numérico' });
    }
    // Un fuel negativo no existe, y uno de 500% es un dedazo. Se rechazan los dos: este
    // numero multiplica el flete de TODOS los envios nuevos, no es lugar para adivinar.
    const pct = Number(fuel_pct);
    if (pct < 0 || pct > 200) {
      return res.status(400).json({ error: 'El fuel debe estar entre 0 y 200%.' });
    }
    const cfg = courier === 'NOVA'
      ? await configuracionModel.actualizarFuelNova(pct)
      : await configuracionModel.actualizarFuel(courier, pct);
    res.json(cfg);
  } catch (e) {
    next(e);
  }
}

async function historialFuel(req, res, next) {
  try {
    const courier = req.query.courier?.toUpperCase();
    if (courier === 'NOVA') {
      return res.json(await configuracionModel.historialFuelNova());
    }
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

// Valida un umbral por monto absoluto (USD o kg): numérico y no negativo. Sin tope de 100,
// a diferencia de los porcentajes: un desvío en USD/kg puede ser cualquier valor positivo.
function validarMonto(valor, nombre) {
  const n = Number(valor);
  if (valor === undefined || valor === null || valor === '' || Number.isNaN(n)) {
    return `${nombre} es obligatorio y numérico`;
  }
  if (n < 0) {
    return `${nombre} no puede ser negativo`;
  }
  return null;
}

async function actualizarTolerancias(req, res, next) {
  try {
    const courier = req.params.courier?.toUpperCase();
    if (!['DHL', 'UPS'].includes(courier)) {
      return res.status(400).json({ error: 'Courier debe ser DHL o UPS' });
    }
    const {
      tolerancia_peso_pct, tolerancia_costo_pct,
      tolerancia_costo_usd, tolerancia_peso_kg,
    } = req.body;
    const errPeso = validarTolerancia(tolerancia_peso_pct, 'tolerancia_peso_pct');
    if (errPeso) return res.status(400).json({ error: errPeso });
    const errCosto = validarTolerancia(tolerancia_costo_pct, 'tolerancia_costo_pct');
    if (errCosto) return res.status(400).json({ error: errCosto });
    const errCostoUsd = validarMonto(tolerancia_costo_usd, 'tolerancia_costo_usd');
    if (errCostoUsd) return res.status(400).json({ error: errCostoUsd });
    const errPesoKg = validarMonto(tolerancia_peso_kg, 'tolerancia_peso_kg');
    if (errPesoKg) return res.status(400).json({ error: errPesoKg });
    const cfg = await configuracionModel.actualizarTolerancias(
      courier,
      Number(tolerancia_peso_pct), Number(tolerancia_costo_pct),
      Number(tolerancia_costo_usd), Number(tolerancia_peso_kg)
    );
    res.json(cfg);
  } catch (e) {
    next(e);
  }
}

// Fecha de corte del control (ver configuracion.model.js).
async function obtenerCorte(req, res, next) {
  try {
    res.json({ fecha_corte_control: await configuracionModel.obtenerFechaCorte() });
  } catch (e) { next(e); }
}

async function actualizarCorte(req, res, next) {
  try {
    const { fecha_corte_control } = req.body || {};
    const v = String(fecha_corte_control || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(`${v}T12:00:00`).getTime())) {
      return res.status(400).json({ error: 'fecha_corte_control debe ser una fecha YYYY-MM-DD válida.' });
    }
    res.json(await configuracionModel.actualizarFechaCorte(v));
  } catch (e) { next(e); }
}

async function obtenerProforma(req, res, next) {
  try {
    res.json({ proforma_proximo: await configuracionModel.obtenerProformaProximo() });
  } catch (e) { next(e); }
}

async function actualizarProforma(req, res, next) {
  try {
    const n = Number(String((req.body || {}).proforma_proximo ?? '').trim());
    if (!Number.isInteger(n) || n <= 0) {
      return res.status(400).json({ error: 'proforma_proximo debe ser un número entero mayor que cero.' });
    }
    res.json(await configuracionModel.actualizarProformaProximo(n));
  } catch (e) { next(e); }
}

async function obtenerMargen(req, res, next) {
  try {
    res.json({ margen_objetivo_pct: await configuracionModel.obtenerMargenObjetivo() });
  } catch (e) { next(e); }
}

// null / vacío borra la línea; un número entre 0 y 500 la fija.
async function actualizarMargen(req, res, next) {
  try {
    const raw = (req.body || {}).margen_objetivo_pct;
    if (raw === null || raw === '' || raw === undefined) {
      res.json(await configuracionModel.actualizarMargenObjetivo(null));
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 500) {
      return res.status(400).json({ error: 'margen_objetivo_pct debe ser un porcentaje entre 0 y 500 (o vacío para sacar la línea).' });
    }
    res.json(await configuracionModel.actualizarMargenObjetivo(n));
  } catch (e) { next(e); }
}

module.exports = {
  obtenerMargen, actualizarMargen,
  obtenerProforma, actualizarProforma,
  obtenerCorte, actualizarCorte,
  listarFuel, actualizarFuel, historialFuel,
  listarUmbrales, actualizarUmbral, historialUmbral,
  listarTolerancias, actualizarTolerancias,
};
