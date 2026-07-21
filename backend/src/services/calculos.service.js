const {
  ZONAS_DHL, ZONAS_UPS, ZONAS_UPS_I,
  DHL_E_PKG, DHL_E_DOC, DHL_I_PKG, DHL_I_DOC,
  UPS_E_LIQD, UPS_E_PK, UPS_E_MN,
  UPS_I_LIQD, UPS_I_PK, UPS_I_MN,
  UPS_SE_LIQD, UPS_SE_PK, UPS_SE_MN,
  UPS_SI_LIQD, UPS_SI_PK, UPS_SI_MN,
  getDHL, getDHLBig, getUPS, getUPSSaverEsIt,
  getSurge, calcSeguroDHL, calcUPSDimExtras,
  cotizarServicio: cotizarServicioCore,
} = require('../../../shared/cotizador/cotizador-core');

function pesoVolumetricoBulto(largo, ancho, alto) {
  const l = Number(largo) || 0;
  const a = Number(ancho) || 0;
  const h = Number(alto) || 0;
  if (l <= 0 || a <= 0 || h <= 0) return 0;
  return (l * a * h) / 5000;
}

function calcularPesos(pesoReal, bultos = [], dims = {}) {
  const real = Number(pesoReal) || 0;
  let volTotal = 0;
  let pfTotal  = 0;
  if (bultos && bultos.length > 0) {
    for (const b of bultos) {
      const vol = pesoVolumetricoBulto(b.largo, b.ancho, b.alto);
      const pr  = Number(b.peso_real) || 0;
      volTotal += vol;
      pfTotal  += Math.max(pr, vol);
    }
  } else {
    const vol = (dims.largo && dims.ancho && dims.alto)
      ? pesoVolumetricoBulto(dims.largo, dims.ancho, dims.alto)
      : 0;
    volTotal = vol;
    pfTotal  = Math.max(real, vol);
  }
  const pesoVolumetrico = Math.round(volTotal * 1000) / 1000;
  const pesoFacturable  = Math.round(pfTotal * 1000) / 1000;
  return { pesoVolumetrico, pesoFacturable };
}

function calcularSeguro(fob) {
  const valor = Number(fob) || 0;
  if (valor < 100) return 0;
  if (valor <= 1000) return 15;
  return Math.round(valor * 0.015 * 100) / 100;
}

function calcularFleteFuel(totalCobrado, fob, fuelPct) {
  const total       = Number(totalCobrado) || 0;
  const seguro      = calcularSeguro(fob);
  const fuelDecimal = (Number(fuelPct) || 0) / 100;
  const flete       = Math.round(((total - seguro) / (1 + fuelDecimal)) * 100) / 100;
  const fuel        = Math.round(flete * fuelDecimal * 100) / 100;
  return { seguro, flete, fuel, total };
}

function redondear2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// Labels del array `extras` del motor (cotizador-core) que representan el SEGURO.
// El seguro va en columna propia (no en adicionales), así que se excluye del array.
const _LABELS_SEGURO = new Set(['Seguro', 'Seguro DHL']);

// Mapea el label humano que arma el motor a un código `tipo` canónico y estable.
// El motor agrega sufijos dinámicos (pesos, conteos) a algunos labels, por eso el
// match es por prefijo/contenido. Cualquier label desconocido cae en 'otro' (no rompe).
function labelATipo(label) {
  const l = String(label || '');
  if (l.startsWith('GoGreen'))                                 return 'gogreen';
  if (l.startsWith('Sobrepeso'))                               return 'sobrepeso';
  if (l.startsWith('Exceso de tamaño'))                        return 'oversize';
  if (l.startsWith('Área remota'))                             return 'area_remota';
  if (l.startsWith('DDP'))                                     return 'ddp';
  if (l.startsWith('Manejo adicional'))                        return 'manejo';
  if (l.startsWith('Paquete mayor tamaño') || l.includes('contorno')) return 'contorno';
  if (l.startsWith('Entrega residencial'))                     return 'residencial';
  return 'otro';
}

// Reconstruye el desglose de adicionales como array de { tipo, label, monto } a partir
// del resultado del motor, de forma que Σ(montos) == adicionales (= total−flete−seguro−fuel):
//   - excluye la entrada de seguro del array del motor (va en columna propia),
//   - antepone una entrada sintética de surge cuando el motor lo expone aparte (UPS).
function construirExtrasDesglose(r) {
  const out = [];
  const surge = redondear2(r.surge || 0);
  if (surge > 0) {
    out.push({ tipo: 'surge', label: 'Recargo por demanda (surge)', monto: surge });
  }
  for (const [label, monto] of (r.extras || [])) {
    if (_LABELS_SEGURO.has(label)) continue;
    out.push({ tipo: labelATipo(label), label, monto: redondear2(monto) });
  }
  return out;
}


const _DIACRITICS_RE = new RegExp('[\\u0300-\\u036f]', 'g');
function normPais(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(_DIACRITICS_RE, '');
}

function canonizarPais(pais) {
  if (!pais) return pais;
  const norm = pais.trim().toLowerCase();
  return (
    Object.keys(ZONAS_DHL).find(k => k.toLowerCase() === norm) ||
    Object.keys(ZONAS_UPS).find(k => k.toLowerCase() === norm) ||
    pais
  );
}

function buscarZona(zonas, pais, zonaOverride) {
  if (pais) {
    if (zonas[pais] !== undefined) return zonas[pais];
    const paisLow = pais.trim().toLowerCase();
    const keyLow  = Object.keys(zonas).find(k => k.toLowerCase() === paisLow);
    if (keyLow) return zonas[keyLow];
    const paisNorm = normPais(pais);
    const keyNorm  = Object.keys(zonas).find(k => normPais(k) === paisNorm);
    if (keyNorm) return zonas[keyNorm];
  }
  return zonaOverride ? Number(zonaOverride) : undefined;
}

// Convierte bultos del backend al formato que espera calcUPSDimExtras del módulo.
function mkBultosProc(bultos) {
  return bultos.map(b => ({
    dims: [Number(b.largo) || 0, Number(b.ancho) || 0, Number(b.alto) || 0].sort((x, y) => y - x),
    pr:   Number(b.pesoReal ?? b.peso_real) || 0,
  }));
}

function cotizarEnvio({ pais, tipo, servicio, pesoFacturable, fob, fuelPct, profitPct, zonaOverride, bultos = [], residencial = false, remota = false, ddp = false }) {
  const pf     = Number(pesoFacturable) || 0;
  const fuel   = (Number(fuelPct)   || 0) / 100;
  const profit = (Number(profitPct) || 0) / 100;

  // Canonizar país para lookup exacto en el core (el core solo hace exact match)
  const paisCanon = canonizarPais(pais) || pais || '';

  // Si el país canonizado no aparece en el mapa, el core usará zonaOverride como fallback
  const r = cotizarServicioCore(servicio, {
    pais: paisCanon,
    tipo,
    pf,
    fob,
    fuelPct:   Number(fuelPct)   || 0,
    profitPct: Number(profitPct) || 0,
    bultosProc: mkBultosProc(bultos),
    residencial,
    remota,
    zonaOverride,
    ddp,
  });
  if (!r) return null;

  // profitMonto según fórmula canónica del v8: aplica sobre (fleteBase + feeUSA)
  const profitMontoRaw = (r.fleteBase + r.feeUSA) * profit * (1 + fuel);
  // precioBase = total sin profit = (flete+surge)*(1+fuel) + manejo + seguro [+ extras]
  const precioBaseRaw  = r.total - profitMontoRaw;

  if (servicio === 'DHL') {
    return {
      precioBase:  redondear2(precioBaseRaw),
      profitMonto: redondear2(profitMontoRaw),
      utilidad:    redondear2(profitMontoRaw),
      precioFinal: redondear2(r.total),
      zona: r.zona,
      servicio: 'DHL Express',
      extras: r.extras,
    };
  }

  return {
    precioBase:  redondear2(precioBaseRaw),
    profitMonto: redondear2(profitMontoRaw),
    utilidad:    redondear2(profitMontoRaw),
    precioFinal: redondear2(r.total),
    zona: r.zona,
    surge:   redondear2(r.surge),
    manejo:  redondear2(r.manejo),
    contorno: r.contornoExtra,
    servicio: servicio === 'UPS_EXP' ? 'UPS Expedited' : 'UPS Saver',
    extras: r.extras,
  };
}

// Desglose AL COSTO (profit 0) que se congela al crear el envío.
// Sale del MISMO motor que el cotizador y el liquidador (cotizarServicio del core);
// acá no se recalcula ningún cargo a mano. Mapea el resultado a las columnas de `envios`:
//   flete       = fleteBase + feeUSA          (el feeUSA de UPS US/Canadá va acá)
//   seguro      = seguro del motor             (su regla por FOB, tal cual)
//   fuel        = monto de fuel a profit 0     (DHL: fleteBase·fuel; UPS: (fleteBase+feeUSA+surge)·fuel)
//   adicionales = todos los recargos restantes (UPS: surge+manejo[+contorno]+remota+residencial;
//                 DHL: goGreen+sobrepeso+exceso+remota) = total − flete − fuel − seguro
//   derechos / descuento / otros = 0 (no se usan)
// Por construcción flete+seguro+fuel+adicionales == total (costo a profit 0).
// El fuelPct debe ser el autoritativo de config (lo resuelve el caller).
// Devuelve null si el país no figura en las tablas y no hay zonaOverride.
function desglosarCosto({ pais, tipo, servicio, pesoFacturable, fob, fuelPct, zonaOverride, bultos = [], residencial = false, remota = false, ddp = false }) {
  const paisCanon = canonizarPais(pais) || pais || '';
  const r = cotizarServicioCore(servicio, {
    pais: paisCanon,
    tipo,
    pf: Number(pesoFacturable) || 0,
    fob,
    fuelPct:   Number(fuelPct) || 0,
    profitPct: 0,
    bultosProc: mkBultosProc(bultos),
    residencial,
    remota,
    zonaOverride,
    ddp,
  });
  if (!r) return null;

  const flete  = redondear2(r.flete);
  const seguro = redondear2(r.seguro);
  const fuel   = redondear2(r.fuelMonto);
  const total  = redondear2(r.total);
  const adicionales = redondear2(total - flete - seguro - fuel);

  // Array informativo de adicionales por tipo. `adicionales` (residual) sigue siendo la
  // fuente de verdad del número; el array es puramente aditivo. Verificación interna:
  // Σ(montos) debe coincidir con adicionales (±0.01 por redondeo). Si no, es un bug de
  // reconciliación: se reporta sin romper el alta (no se tapa).
  const extras = construirExtrasDesglose(r);
  const sumExtras = redondear2(extras.reduce((s, e) => s + e.monto, 0));
  if (Math.abs(sumExtras - adicionales) > 0.01) {
    console.warn(
      `[desglosarCosto] reconciliación de extras no cuadra: Σ=${sumExtras} != adicionales=${adicionales} ` +
      `(servicio=${servicio}, pais=${paisCanon}, zona=${r.zona})`
    );
  }

  // El fuel% efectivamente usado se devuelve para congelarlo por envío (columna fuel_pct).
  // No altera ningún monto: es el mismo valor que entró por el parámetro fuelPct.
  return { flete, seguro, fuel, fuel_pct: Number(fuelPct) || 0, adicionales, derechos: 0, descuento: 0, otros: 0, total, zona: r.zona, extras };
}

module.exports = {
  pesoVolumetricoBulto,
  calcularPesos,
  calcularSeguro,
  calcularFleteFuel,
  redondear2,
  cotizarEnvio,
  desglosarCosto,
  calcSeguroDHL,
  buscarZona,
  ZONAS_DHL,
  ZONAS_UPS,
  ZONAS_UPS_I,
};
