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

// El surge de UPS es el ÚNICO cargo del courier al que se le aplica combustible: UPS lo
// factura así y el motor hace lo mismo (fuel = (flete + surge) × pct). Pero el desglose al
// costo congela el surge PELADO en `adicionales`, y el fuel del surge queda dentro de la
// columna `fuel`. Si acá se descompone la venta restando el surge pelado, ese fuel no tiene
// dónde ir y cae adentro del flete. Para un cliente por kilo, el flete deja de ser kg × precio.
//
// Lo encontró la oficina el 02/09/2026 comparando la liquidación de cueros contra su Excel:
// 3 a 11 USD de más en el flete de cada envío, siempre exactamente surge × fuel / (1 + fuel).
// El TOTAL estaba bien; el reparto no. Desde entonces el surge va a Adicional CON su fuel y
// el flete queda clavado en kg × precio (o flete de tabla × (1 + profit)).
//
// Lee el desglose por tipo que dejó el alta (envios.extras_json). Los envíos anteriores a
// esa columna no tienen cómo separar el surge y quedan como estaban: el total cierra igual.
function surgeDe(extras) {
  let lista = extras;
  if (typeof lista === 'string') {
    try { lista = JSON.parse(lista); } catch { lista = []; }
  }
  if (!Array.isArray(lista)) return 0;
  return lista
    .filter((e) => e && e.tipo === 'surge')
    .reduce((s, e) => s + (Number(e.monto) || 0), 0);
}

// datos: { total_cobrado, seguro, adicionales, derechos, otros, fuel_pct, extras }
// fuel_pct: porcentaje congelado del envío (ej. 27.5). Si es null/undefined se trata como 0
//           (el que quiera el comportamiento histórico de fallback a config debe resolverlo antes).
// extras:   el desglose por tipo del envío (array o el JSON crudo de envios.extras_json).
//           Opcional: sin él no se puede separar el surge y el reparto es el histórico.
function descomponerVenta(datos = {}) {
  const fuelPct =
    datos.fuel_pct !== null && datos.fuel_pct !== undefined ? datos.fuel_pct : 0;
  const fuelDecimal = fuelPct / 100;

  // Valores que se muestran tal cual (forman parte de total_cobrado):
  const totalCobrado = redondear2(datos.total_cobrado || 0);
  const seguro = redondear2(datos.seguro || 0);
  // El fuel del surge se muestra junto al surge, en Adicional (ver arriba).
  const fuelSurge = redondear2(surgeDe(datos.extras) * fuelDecimal);
  // Adicionales itemizados guardados (surge en extras_json, derechos, otros) + el fuel del surge.
  const adicional = redondear2(
    (datos.adicionales || 0) + (datos.derechos || 0) + (datos.otros || 0) + fuelSurge
  );

  // flete+fuel balancean el resto del total cobrado, respetando la proporción de fuel.
  const base = redondear2(totalCobrado - seguro - adicional);
  const flete = redondear2(base / (1 + fuelDecimal));
  const fuel = redondear2(base - flete);

  // Invariante: flete + fuel + seguro + adicional === totalCobrado.
  return { flete, fuel, seguro, adicional, total: totalCobrado };
}

// Rótulos de cara al cliente para los tipos del desglose del alta (envios.extras_json).
// El GoGreen y el surge son los que la oficina pregunta seguido: los dos van en Adicional,
// nunca en el flete (Felipe, 07/09/2026). El surge se muestra CON su fuel, porque así lo
// factura UPS y así lo reparte descomponerVenta.
const LABEL_ADICIONAL = {
  surge: 'Surge fee (con fuel)',
  gogreen: 'GoGreen',
  manejo: 'Manejo adicional',
  contorno: 'Mayor tamaño',
  remota: 'Área remota',
  residencial: 'Entrega residencial',
  ddp: 'DDP',
  ipf: 'Procesamiento internacional',
  proteccion_doc: 'Protección de documentos',
  sobrepeso: 'Sobrepeso',
  exceso: 'Exceso de medida',
  no_convencional: 'Pieza no convencional',
};

function parseExtras(extras) {
  let lista = extras;
  if (typeof lista === 'string') {
    try { lista = JSON.parse(lista); } catch { lista = []; }
  }
  return Array.isArray(lista) ? lista : [];
}

// El detalle de la columna Adicional de la venta: qué cargos la componen, uno por línea,
// con la misma plata que descomponerVenta() pone en `adicional` (la suma cierra exacto; si
// el redondeo desvía centavos, la diferencia va en una línea "Otros cargos"). Read-only.
// datos: los mismos de descomponerVenta. Devuelve [{ tipo, label, monto }] en el orden del alta.
function detallarAdicional(datos = {}) {
  const fuelPct = datos.fuel_pct !== null && datos.fuel_pct !== undefined ? datos.fuel_pct : 0;
  const fuelDecimal = fuelPct / 100;
  const lineas = [];
  for (const x of parseExtras(datos.extras)) {
    if (!x || !(Number(x.monto) > 0)) continue;
    const tipo = String(x.tipo || 'otro');
    const label = LABEL_ADICIONAL[tipo] || x.label || 'Recargo';
    // El surge va con su fuel, calculado IGUAL que en descomponerVenta (surge redondeado +
    // fuel del surge redondeado), para que la suma cierre al centavo.
    const monto = tipo === 'surge'
      ? redondear2(redondear2(Number(x.monto)) + redondear2(Number(x.monto) * fuelDecimal))
      : redondear2(Number(x.monto));
    lineas.push({ tipo, label, monto });
  }
  // Envíos sin desglose por tipo (anteriores a extras_json): el bloque entero de adicionales
  // congelado en el alta va en una sola línea, que es toda la verdad que hay.
  if (!lineas.length && Number(datos.adicionales) > 0) {
    lineas.push({ tipo: 'adicionales', label: 'Recargos del courier', monto: redondear2(datos.adicionales) });
  }
  if (Number(datos.derechos) > 0) lineas.push({ tipo: 'derechos', label: 'Derechos / impuestos', monto: redondear2(datos.derechos) });
  if (Number(datos.otros) > 0) lineas.push({ tipo: 'otros', label: 'Otros', monto: redondear2(datos.otros) });

  const objetivo = descomponerVenta(datos).adicional;
  const suma = redondear2(lineas.reduce((s, l) => s + l.monto, 0));
  const dif = redondear2(objetivo - suma);
  if (Math.abs(dif) >= 0.01) {
    // Centavos de redondeo (el residual `adicionales` del alta vs. la suma de sus extras): se
    // absorben en la línea más grande, no merecen una línea propia. Una diferencia mayor sí.
    if (Math.abs(dif) < 0.05 && lineas.length) {
      const mayor = lineas.reduce((a, b) => (b.monto > a.monto ? b : a));
      mayor.monto = redondear2(mayor.monto + dif);
    } else {
      lineas.push({ tipo: 'ajuste', label: 'Otros cargos', monto: dif });
    }
  }
  return lineas;
}

module.exports = { descomponerVenta, surgeDe, detallarAdicional, LABEL_ADICIONAL };
