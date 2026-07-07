// Profit y porcentaje derivados AL VUELO desde el desglose congelado (Parte A)
// y total_cobrado, para que nunca queden desfasados si se edita el precio.
// Fuente ÚNICA de verdad del profit por envío: lo usa la vista Salidas para pintar
// cada fila y el Dashboard para agregar la utilidad por cliente/período. Debe
// coincidir al centavo entre ambas.
//   costo      = flete - descuento + seguro + fuel + derechos + adicionales + otros
//   profit     = total_cobrado - costo
//   porcentaje = profit / costo * 100   (margen sobre el costo)
// Si el costo es 0 o no hay total_cobrado, no se calcula: se devuelve lo que
// tenga la columna en la DB (envíos viejos importados, o envíos cuyos costos viven
// en liquidacion_items y no en envios) o vacío.
// Espera row.total = total_cobrado (alias del SELECT) y las columnas de costo planas.
function deriveProfit(row) {
  const costo = (row.flete || 0) - (row.descuento || 0) + (row.seguro || 0)
    + (row.fuel || 0) + (row.derechos || 0) + (row.adicionales || 0) + (row.otros || 0);
  if (costo === 0 || row.total == null || row.total === 0) {
    return { compra_total: costo, profit: row.profit ?? null, porcentaje: row.porcentaje ?? null };
  }
  const profit = Math.round((row.total - costo) * 100) / 100;
  const porcentaje = Math.round((profit / costo) * 10000) / 100;
  return { compra_total: costo, profit, porcentaje };
}

module.exports = { deriveProfit };
