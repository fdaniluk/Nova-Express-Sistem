const cotizacionService = require('../services/cotizacion.service');
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
    const { servicio, tipo, zona, pf, pais } = req.query;

    if (!profitService.SERVICIOS.includes(servicio)) {
      return res.status(400).json({ error: `servicio inválido. Válidos: ${profitService.SERVICIOS.join(', ')}` });
    }
    if (!profitService.TIPOS.includes(tipo)) {
      return res.status(400).json({ error: `tipo inválido. Válidos: ${profitService.TIPOS.join(', ')}` });
    }

    // LA ZONA SE RESUELVE IGUAL QUE AL COTIZAR: manda el país, la zona suelta es respaldo.
    // Antes esta pantalla preguntaba sin país, y sin país no hay zona: nunca encontraba la
    // celda de la matriz y devolvía el porcentaje general del cliente. Resultado: Cargar
    // envío MOSTRABA 75% mientras el sistema COBRABA el 70% de la celda (07/08/2026, lo
    // encontró la oficina). Los dos números salen ahora del mismo resolvedor.
    const zonaEfectiva = cotizacionService.resolverZona({
      servicio: servicio === 'UPS_SAVER' ? 'UPS_SAV' : servicio,
      tipo,
      pais: pais || null,
      zona: zona === undefined || zona === '' ? undefined : zona,
    });

    // resolverTarifaVenta decide solo si el cliente cobra por porcentaje o por kilo.
    // Sigue devolviendo profitPct y origen (el contrato de siempre) y agrega modo,
    // precioKg y la advertencia si está en modo por kilo pero le falta la tarifa para
    // ese peso/zona.
    const resultado = await profitService.resolverTarifaVenta({
      clienteId: id,
      servicio,
      tipo,
      zona: zonaEfectiva === undefined ? null : zonaEfectiva,
      pesoFacturable: pf,
    });

    if (resultado === null) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const fuelPctPropio = await profitService.resolverFuelPropio(id);
    // Seguro negociado del cliente ({pct, min} o null). El cotizador lo necesita para
    // pasárselo al motor: sin esto cotizaría con la escala de lista y el envío se cargaría
    // con un seguro distinto del que se le factura.
    const seguroPropio = await profitService.resolverSeguroPropio(id);
    res.json({ ...resultado, fuelPctPropio, seguroPropio });
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

// GET /api/clientes/:id/tramos
// Devuelve el juego de tramos del cliente y si es propio o heredado del por defecto.
async function getTramos(req, res, next) {
  try {
    const { id } = req.params;
    if (!(await profitService.clienteExiste(id))) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const propio = await profitService.obtenerTramosCliente(id);
    res.json({ ...propio, por_defecto: profitService.TRAMOS_POR_DEFECTO });
  } catch (e) {
    next(e);
  }
}

// PUT /api/clientes/:id/tramos
// Body: { tramos: [{min, max}, ...] } · lista vacía o ausente = volver al juego por defecto.
// Responde 409 si hay precios cargados en tramos que el juego nuevo no contempla: se
// rechaza el cambio antes que dejar un precio cobrándose sin que la pantalla lo muestre.
async function putTramos(req, res, next) {
  try {
    const { id } = req.params;
    if (!(await profitService.clienteExiste(id))) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const guardado = await profitService.guardarTramosCliente(id, req.body ? req.body.tramos : null);
    res.json({ ...guardado, por_defecto: profitService.TRAMOS_POR_DEFECTO });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    if (e.status === 409) return res.status(409).json({ error: e.message, huerfanos: e.huerfanos });
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
  getTramos,
  putTramos,
};
