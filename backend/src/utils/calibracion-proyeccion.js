'use strict';
// Calibración de la proyección del mes (15/10/2026).
//
// Sale de medir, sobre los 34 meses completos de las planillas SALIDAS (dic-2023 → sep-2026,
// ~5.700 envíos), cuánto erró la proyección "mezcla" parada a cada altura del mes:
//   proyección = w · (lo del mes / hábiles pasados × hábiles del mes)
//              + (1 − w) · promedio de los 3 meses anteriores,    con w = hábiles pasados / hábiles del mes.
// Para cada décimo del mes: p10 y p90 del error firmado (proyección − real) / real en %, y el
// error medio absoluto (mape). Con eso la tarjeta dice "entre A y B" y la etiqueta de confianza
// sin depender de cuántos meses cerrados tenga el sistema (que arrancó en julio 2026).
//
// Lo que NO sirvió, para no volver a probarlo: el ritmo simple (23 % de error en kilos al 5º
// hábil, peor mes 64 %), el "perfil" de cuánto pesó la primera semana en meses anteriores
// (27 %), el mismo mes del año anterior escalado (33 %), ajustar por estacionalidad y usar 6
// meses de base en vez de 3. La primera semana pesó entre el 12 % y el 39 % del mes (mediana
// 23 %): no anticipa nada.
//
// Cuando el sistema tenga 6+ meses cerrados propios, analitica.service.js usa su propia
// medición (precisionHistorica) en lugar de esta tabla.
const CALIBRACION = {
  meses: 31, desde: '2024-03', hasta: '2026-09',
  envios: {
    0.1: { p10: -23.3, p90: 21.4, mape: 13.9 }, 0.2: { p10: -20.6, p90: 15.9, mape: 12.7 }, 0.3: { p10: -18.1, p90: 20.1, mape: 12.0 },
    0.4: { p10: -18.2, p90: 13.4, mape: 10.3 }, 0.5: { p10: -16.1, p90: 12.4, mape: 9.1 }, 0.6: { p10: -15.1, p90: 11.2, mape: 8.4 },
    0.7: { p10: -13.1, p90: 8.6, mape: 6.2 }, 0.8: { p10: -9.5, p90: 7.5, mape: 4.4 }, 0.9: { p10: -5.5, p90: 3.2, mape: 2.8 },
  },
  kg_fact: {
    0.1: { p10: -23.8, p90: 21.5, mape: 16.4 }, 0.2: { p10: -22.9, p90: 24.7, mape: 16.0 }, 0.3: { p10: -21.6, p90: 22.2, mape: 14.8 },
    0.4: { p10: -19.7, p90: 20.7, mape: 12.4 }, 0.5: { p10: -15.4, p90: 14.2, mape: 9.6 }, 0.6: { p10: -13.1, p90: 12.8, mape: 9.2 },
    0.7: { p10: -12.1, p90: 11.1, mape: 7.9 }, 0.8: { p10: -7.9, p90: 7.5, mape: 5.3 }, 0.9: { p10: -6.0, p90: 4.6, mape: 3.3 },
  },
  venta: {
    0.1: { p10: -28.1, p90: 29.5, mape: 16.7 }, 0.2: { p10: -23.6, p90: 26.3, mape: 16.7 }, 0.3: { p10: -21.0, p90: 26.0, mape: 16.1 },
    0.4: { p10: -20.6, p90: 22.6, mape: 14.0 }, 0.5: { p10: -17.3, p90: 17.8, mape: 11.4 }, 0.6: { p10: -15.5, p90: 18.0, mape: 10.4 },
    0.7: { p10: -15.3, p90: 11.0, mape: 9.3 }, 0.8: { p10: -9.5, p90: 7.4, mape: 6.3 }, 0.9: { p10: -5.8, p90: 5.0, mape: 3.7 },
  },
};

// Banda de error para una fracción del mes (0 < f < 1): el décimo más cercano.
function bandaCalibrada(campo, fraccion) {
  const t = CALIBRACION[campo];
  if (!t) return null;
  const f = Math.min(0.9, Math.max(0.1, Math.round(fraccion * 10) / 10));
  const b = t[f];
  return b ? { min: b.p10, max: b.p90, mape: b.mape, fraccion: f } : null;
}

module.exports = { CALIBRACION, bandaCalibrada };
