const {
  ZONAS_DHL, ZONAS_UPS, ZONAS_UPS_I,
  DHL_E_PKG, DHL_E_DOC, DHL_I_PKG, DHL_I_DOC,
  UPS_E_LIQD, UPS_E_PK, UPS_E_MN,
  UPS_I_LIQD, UPS_I_PK, UPS_I_MN,
  UPS_SE_LIQD, UPS_SE_PK, UPS_SE_MN,
  UPS_SI_LIQD, UPS_SI_PK, UPS_SI_MN,
  getDHL, getDHLBig, getUPS, getUPSSaverEsIt,
  getSurge, calcSeguroDHL, calcSeguroUPS, calcUPSDimExtras,
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

// Seguro UPS. NO tiene la regla escrita acá: delega en el motor compartido, que es el
// único lugar donde vive una tarifa. Antes esta función repetía la escala (0 / 15 / 1,5%)
// con los números sueltos; coincidían con los del motor por casualidad, y el día que se
// cambie la regla en un lado el otro se queda viejo. La función se conserva porque hay
// código que la importa por este nombre.
function calcularSeguro(fob) {
  return calcSeguroUPS(Number(fob) || 0).monto;
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
  if (l.startsWith('Área extendida'))                          return 'area_extendida';
  if (l.startsWith('DDP'))                                     return 'ddp';
  if (l.startsWith('Protección de documentos'))                return 'proteccion_doc';
  if (l.startsWith('Manejo adicional'))                        return 'manejo';
  if (l.startsWith('Paquete mayor tamaño') || l.includes('contorno')) return 'contorno';
  if (l.startsWith('Entrega residencial'))                     return 'residencial';
  if (l.startsWith('Tarifa de procesamiento'))                 return 'ipf';
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

// Convierte bultos del backend al formato que espera el motor.
//
// `pf` (peso facturable del bulto = el mayor entre real y volumétrico) NO estaba, y era la
// causa de una divergencia de USD 102 por bulto entre el cotizador y el backend: el
// cotizador sí lo mandaba, así que un bulto liviano pero enorme (10 kg reales, 80 kg por
// volumen) cobraba los 125 de sobrepeso en el cotizador y solo 23 de exceso de tamaño en el
// alta. El tarifario de DHL dice "cada pieza cuyo peso real O VOLUMÉTRICO exceda los 70 kg",
// así que los 125 son los correctos y el backend cobraba de menos.
//
// Mismo motor, distinta entrada: por eso no alcanza con compartir el archivo, hay que
// mandarle los mismos datos.
function mkBultosProc(bultos) {
  return bultos.map(b => {
    const pr  = Number(b.pesoReal ?? b.peso_real) || 0;
    const vol = pesoVolumetricoBulto(b.largo, b.ancho, b.alto);
    return {
      dims: [Number(b.largo) || 0, Number(b.ancho) || 0, Number(b.alto) || 0].sort((x, y) => y - x),
      pr,
      pf: Math.max(pr, vol),
    };
  });
}

// Traduce el `tipo_paquete` que guarda la tabla `envios` ('m' mercadería / 'd' documento)
// al `contenido` que entiende el motor ('paquete' / 'documento').
//
// Por qué existe: DHL tiene tarifa propia de DOCUMENTO hasta 2 kg, bastante más barata que
// la de paquete. El cotizador manual siempre mandó `contenido` y usaba la tabla correcta;
// Cargar envío guardaba el tipo de paquete pero NUNCA se lo pasaba al motor, así que
// cotizaba —y congelaba el costo— como si todo fuera mercadería. Para un documento DHL de
// 0,5 kg las dos pantallas llegaban a diferir 60%.
// (UPS no tiene tarifa de documento: ahí este valor no cambia nada.)
function contenidoDe(tipoPaquete) {
  return String(tipoPaquete ?? '').toLowerCase() === 'd' ? 'documento' : 'paquete';
}

function cotizarEnvio({ pais, tipo, servicio, pesoFacturable, fob, fuelPct, profitPct, zonaOverride, bultos = [], residencial = false, remota = false, entrega, ddp = false, proteccionDoc = false, contenido = 'paquete', precioKgVenta = null, seguroPropio = null }) {
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
    entrega,
    zonaOverride,
    ddp,
    proteccionDoc,
    contenido,
    precioKgVenta,
    // Seguro negociado del cliente ({pct, min}) o null. Lo resuelve profit.service; acá
    // solo se pasa. Reemplaza la escala de seguro del courier en DHL y en UPS.
    seguroPropio,
  });
  if (!r) return null;

  // La ganancia aplica SOLO sobre el flete de tabla. El IPF ya no entra acá: pasa a costo
  // como el surge y el DDP (criterio de Felipe, 29/07).
  // Con tarifa por kilo no hay porcentaje: la utilidad es la diferencia entre el flete que
  // se le vende al cliente (precio × kilo) y el flete que cuesta el courier. Si el precio
  // por kilo quedara por debajo del costo, esa diferencia da NEGATIVA — y así tiene que
  // verse, para que se note que ese cliente está dando pérdida.
  const profitMontoRaw =
    r.modoVenta === 'por_kg'
      ? (r.conGan - r.fleteBase) * (1 + fuel)
      : r.fleteBase * profit * (1 + fuel);
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
      modo_venta: r.modoVenta,
      precio_kg: r.precioKgVenta,
      kg_venta: r.pfVenta,
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
    modo_venta: r.modoVenta,
    precio_kg: r.precioKgVenta,
    kg_venta: r.pfVenta,
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
function desglosarCosto({ pais, tipo, servicio, pesoFacturable, fob, fuelPct, zonaOverride, bultos = [], residencial = false, remota = false, entrega, ddp = false, proteccionDoc = false, contenido = 'paquete' }) {
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
    entrega,
    zonaOverride,
    ddp,
    proteccionDoc,
    contenido,
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
  // La comparación va EN CENTAVOS, no en pesos. Con `Math.abs(a - b) > 0.01` la coma
  // flotante hacía saltar el aviso con diferencias de exactamente un centavo: 1.47 - 1.46
  // da 0.010000000000000009, que es mayor que 0.01. El aviso se disparaba sin que hubiera
  // nada roto —el propio comentario de arriba dice que ±0.01 es tolerable— y ensuciaba los
  // logs del VPS tapando los descuadres de verdad.
  if (Math.round(Math.abs(sumExtras - adicionales) * 100) > 1) {
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
  redondear2,
  cotizarEnvio,
  desglosarCosto,
  contenidoDe,
  calcSeguroDHL,
  buscarZona,
  ZONAS_DHL,
  ZONAS_UPS,
  ZONAS_UPS_I,
};
