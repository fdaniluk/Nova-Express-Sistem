// Profit y porcentaje derivados AL VUELO desde el desglose congelado (Parte A)
// y total_cobrado, para que nunca queden desfasados si se edita el precio.
// Fuente ÚNICA de verdad del profit por envío: lo usa la vista Salidas para pintar
// cada fila y el Dashboard para agregar la utilidad por cliente/período. Debe
// coincidir al centavo entre ambas.
//
// Precedencia del profit (de arriba hacia abajo; la primera que aplica gana):
//   1. COSTO REAL (rama nueva, Etapa 3): si el envío tiene estado_revision =
//      'revisado_ok' y costo_facturado != null, la utilidad se calcula contra lo que
//      REALMENTE pagamos a UPS → profit = venta − costo_facturado, y se marca
//      profit_real = true. Esta rama gana sobre la foto congelada de la liquidación
//      (esa precedencia la aplica el dashboard mirando profit_real; ver utilidadEnvio).
//      SOLO 'revisado_ok' dispara esto: 'pendiente'/'a_revisar'/'reclamar' siguen con
//      la estimación (si la guía está en reclamo sostenemos que nuestro número es el
//      correcto, sería absurdo calcular la utilidad con el número que estamos peleando).
//   2/3. COSTO ESTIMADO (comportamiento histórico, profit_real = false):
//      costo      = flete - descuento + seguro + fuel + derechos + adicionales + otros
//      profit     = total_cobrado - costo
//      porcentaje = profit / costo * 100   (margen sobre el costo)
// Si el costo es 0 o no hay total_cobrado, no se calcula: se devuelve lo que
// tenga la columna en la DB (envíos viejos importados, o envíos cuyos costos viven
// en liquidacion_items y no en envios) o vacío.
// Espera row.total = total_cobrado (alias del SELECT) y las columnas de costo planas.
// Opcionales para la rama nueva: row.estado_revision, row.costo_facturado y
// row.venta_liq (SUM de liquidacion_items.total_usd de la liquidación confirmada).
// Costo ESTIMADO por nosotros a partir del desglose congelado. Es la fórmula que
// usa la rama estimada de deriveProfit; se expone aparte para que el Dashboard pueda
// pedir el costo estimado de CUALQUIER envío (incluso uno 'revisado_ok', donde
// deriveProfit devuelve el costo real y no el estimado) sin re-tipear la fórmula y
// arriesgar que quede desalineada con la utilidad. Fuente única de la estimación.
function costoEstimado(row) {
  return (row.flete || 0) - (row.descuento || 0) + (row.seguro || 0)
    + (row.fuel || 0) + (row.derechos || 0) + (row.adicionales || 0) + (row.otros || 0);
}

function deriveProfit(row) {
  // RAMA NUEVA (Etapa 3): costo real de la factura UPS ya aprobada. costo_facturado 0
  // es un valor válido (se pagó 0) → se habilita con != null, no con truthiness.
  if (row.estado_revision === 'revisado_ok' && row.costo_facturado != null) {
    // Venta CORRECTA = lo que realmente se le cobró al cliente. Si el envío está
    // liquidado, la liquidación pudo sumar un adicional manual encima de total_cobrado
    // y esa venta completa quedó congelada en liquidacion_items.total_usd (row.venta_liq).
    // Sin liquidación (o sin ese dato) se usa total_cobrado. Solo se LEE la liquidación:
    // no se toca ningún monto.
    const venta = row.venta_liq != null ? row.venta_liq : row.total;
    if (venta != null) {
      const costoReal = row.costo_facturado;
      const profit = Math.round((venta - costoReal) * 100) / 100;
      // costo real 0 → margen indefinido (no dividir por cero); se deja null.
      const porcentaje = costoReal !== 0 ? Math.round((profit / costoReal) * 10000) / 100 : null;
      return { compra_total: costoReal, profit, porcentaje, profit_real: true };
    }
    // Aprobada pero sin venta cargada: no se puede calcular el real → cae a la estimación.
  }

  // RAMA ESTIMADA (histórica, sin cambios de número): costo derivado del desglose.
  const costo = costoEstimado(row);
  if (costo === 0 || row.total == null || row.total === 0) {
    return { compra_total: costo, profit: row.profit ?? null, porcentaje: row.porcentaje ?? null, profit_real: false };
  }
  const profit = Math.round((row.total - costo) * 100) / 100;
  const porcentaje = Math.round((profit / costo) * 10000) / 100;
  return { compra_total: costo, profit, porcentaje, profit_real: false };
}

module.exports = { deriveProfit, costoEstimado };
