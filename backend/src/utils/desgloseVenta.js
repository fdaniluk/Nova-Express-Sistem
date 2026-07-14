// Descomposición canónica de la VENTA de un envío (read-only).
//
// Toma el total_cobrado ya guardado (que incluye el profit cargado por el dueño) y lo parte
// en flete / fuel / seguro / adicional respetando la invariante:
//     flete + fuel + seguro + adicional === total_cobrado
//
// Es la MISMA lógica que usa la liquidación (liquidacion.model.js → calcularItem) para el
// desglose de cara al cliente. NO recotiza, NO aplica profit, NO usa el motor cotizarEnvio ni
// descomponerPrecioBase. Usa el fuel_pct congelado que se le pase (el del envío, no el de hoy).
//
// Criterio: seguro y adicional (cargos itemizados reales) se muestran tal cual; flete+fuel
// balancean el resto del total para que la suma cierre exacto en total_cobrado.
//
// Esta función NO incluye el "adicional manual" de una liquidación puntual (ese es un extra
// que se agrega aparte, encima de lo cobrado); acá solo se descompone lo que ya está cargado.

const { redondear2 } = require('../services/calculos.service');

// datos: { total_cobrado, seguro, adicionales, derechos, otros, fuel_pct }
// fuel_pct: porcentaje congelado del envío (ej. 27.5). Si es null/undefined se trata como 0
//           (el que quiera el comportamiento histórico de fallback a config debe resolverlo antes).
function descomponerVenta(datos = {}) {
  const fuelPct =
    datos.fuel_pct !== null && datos.fuel_pct !== undefined ? datos.fuel_pct : 0;
  const fuelDecimal = fuelPct / 100;

  // Valores que se muestran tal cual (forman parte de total_cobrado):
  const totalCobrado = redondear2(datos.total_cobrado || 0);
  const seguro = redondear2(datos.seguro || 0);
  // Adicionales itemizados guardados (surge en extras_json, derechos, otros).
  const adicional = redondear2(
    (datos.adicionales || 0) + (datos.derechos || 0) + (datos.otros || 0)
  );

  // flete+fuel balancean el resto del total cobrado, respetando la proporción de fuel.
  const base = redondear2(totalCobrado - seguro - adicional);
  const flete = redondear2(base / (1 + fuelDecimal));
  const fuel = redondear2(base - flete);

  // Invariante: flete + fuel + seguro + adicional === totalCobrado.
  return { flete, fuel, seguro, adicional, total: totalCobrado };
}

module.exports = { descomponerVenta };
