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

    const resultado = await profitService.resolverProfit({
      clienteId: id,
      servicio,
      tipo,
      zona: zona === undefined ? null : zona,
      pesoFacturable: pf,
    });

    if (resultado === null) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    res.json(resultado);
  } catch (e) {
    next(e);
  }
}

module.exports = { getMatrix, putOverride, deleteOverride, resolve };
