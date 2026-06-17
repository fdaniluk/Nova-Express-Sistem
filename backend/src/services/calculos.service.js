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

function cotizarEnvio({ pais, tipo, servicio, pesoFacturable, fob, fuelPct, profitPct, zonaOverride, bultos = [], residencial = false, ddp = false }) {
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

module.exports = {
  pesoVolumetricoBulto,
  calcularPesos,
  calcularSeguro,
  calcularFleteFuel,
  redondear2,
  cotizarEnvio,
  calcSeguroDHL,
  buscarZona,
  ZONAS_DHL,
  ZONAS_UPS,
};
