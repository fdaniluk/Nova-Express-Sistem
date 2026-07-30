const profitService = require('../services/profit.service');

// GET /api/clientes/:id/profit-matrix?servicio=X&tipo=Y
async function getMatrix(req, res, next) {
  try {
    const { id } = req.params;
    const { servicio, tipo } = req.query;

    if (!profitService.SERVICIOS.includes(servicio)) {
      return res.status(400).json({ error: `servicio inválido. Válidos: ${profitService.SERVICIOS.join(', ')}` });
    }
    if (!profitService.TIPOS.includes(tipo)) {
      return res.status(400).json({ error: `tipo inválido. Válidos: ${profitService.TIPOS.join(', ')}` });
    }
    if (!(await profitService.clienteExiste(id))) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const matriz = await profitService.obtenerMatriz(id, servicio, tipo);
    res.json(matriz);
  } catch (e) {
    next(e);
  }
}

// PUT /api/clientes/:id/profit-matrix
async function putOverride(req, res, next) {
  try {
    const { id } = req.params;
    if (!(await profitService.clienteExiste(id))) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const override = await profitService.upsertOverride(id, req.body);
    res.json(override);
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
}

// DELETE /api/clientes/:id/profit-matrix
async function deleteOverride(req, res, next) {
  try {
    const { id } = req.params;
    if (!(await profitService.clienteExiste(id))) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const borrado = await profitService.eliminarOverride(id, req.body);
    if (!borrado) return res.status(404).json({ error: 'Override no encontrado' });
    res.status(204).end();
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
}

// GET /api/clientes/:id/profit-resolve?servicio=X&tipo=Y&zona=Z&pf=N
async function resolve(req, res, next) {
  try {
    const { id } = req.params;
    const { servicio, tipo, zona, pf } = req.query;

    if (!profitService.SERVICIOS.includes(servicio)) {
      return res.status(400).json({ error: `servicio inválido. Válidos: ${profitService.SERVICIOS.join(', ')}` });
    }
    if (!profitService.TIPOS.includes(tipo)) {
      return res.status(400).json({ error: `tipo inválido. Válidos: ${profitService.TIPOS.join(', ')}` });
    }

    // resolverTarifaVenta decide solo si el cliente cobra por porcentaje o por kilo.
    // Sigue devolviendo profitPct y origen (el contrato de siempre) y agrega modo,
    // precioKg y la advertencia si está en modo por kilo pero le falta la tarifa para
    // ese peso/zona.
    const resultado = await profitService.resolverTarifaVenta({
      clienteId: id,
      servicio,
      tipo,
      zona: zona === undefined ? null : zona,
      pesoFacturable: pf,
    });

    if (resultado === null) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const fuelPctPropio = await profitService.resolverFuelPropio(id);
    res.json({ ...resultado, fuelPctPropio });
  } catch (e) {
    next(e);
  }
}

// ── Tarifa por kilo ──────────────────────────────────────────────────────────
// Los mismos endpoints que la matriz de profit, pero contra tarifa_kg_overrides.

// GET /api/clientes/:id/tarifa-kg?servicio=X&tipo=Y
async function getMatrixKg(req, res, next) {
  try {
    const { id } = req.params;
    const { servicio, tipo } = req.query;

    if (!profitService.SERVICIOS.includes(servicio)) {
      return res.status(400).json({ error: `servicio inválido. Válidos: ${profitService.SERVICIOS.join(', ')}` });
    }
    if (!profitService.TIPOS.includes(tipo)) {
      return res.status(400).json({ error: `tipo inválido. Válidos: ${profitService.TIPOS.join(', ')}` });
    }
    if (!(await profitService.clienteExiste(id))) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    res.json(await profitService.obtenerMatrizKg(id, servicio, tipo));
  } catch (e) {
    next(e);
  }
}

// PUT /api/clientes/:id/tarifa-kg
async function putOverrideKg(req, res, next) {
  try {
    const { id } = req.params;
    if (!(await profitService.clienteExiste(id))) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    res.json(await profitService.upsertOverrideKg(id, req.body));
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
}

// DELETE /api/clientes/:id/tarifa-kg
async function deleteOverrideKg(req, res, next) {
  try {
    const { id } = req.params;
    if (!(await profitService.clienteExiste(id))) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const borrado = await profitService.eliminarOverrideKg(id, req.body);
    if (!borrado) return res.status(404).json({ error: 'Tarifa no encontrada' });
    res.status(204).end();
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
}

module.exports = {
  getMatrix,
  putOverride,
  deleteOverride,
  resolve,
  getMatrixKg,
  putOverrideKg,
  deleteOverrideKg,
};
