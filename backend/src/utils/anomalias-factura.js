// Anomalías de la factura del courier contra lo que el envío tenía previsto (05/10/2026).
//
// Pedido de Felipe: "cuando uno carga una factura, necesito que sea visible si la guía
// tuvo algún extracargo o adicional que nosotros no habíamos contemplado: área remota,
// medidas, lo que sea". Acá se cruza el detalle de recargos de la factura (factura_guias.
// cargos_json, tal como lo nombra UPS) con el desglose que el sistema calculó al cargar
// el envío (envios.extras_json + seguro + peso facturable) y se devuelve una lista corta
// de lo que NO estaba previsto o vino más caro. La usan Salidas (chip + modal), la carga
// de facturas (resumen) y la bandeja de revisión.
//
// Solo lectura: no toca nada. Si el envío no tiene factura, devuelve [].

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Familias: cómo se llama el recargo en la factura de UPS → qué tipo de extra del
// sistema lo cubre. Un recargo que no cae en ninguna familia es "otro": siempre anomalía.
const FAMILIAS = [
  // Los nombres de DHL (07/10): VALUE PROTECTION = seguro; Non-conveyable (NCP) = manejo;
  // Over Sized Piece (OSP) = mayor tamaño; GoGreen Plus siempre está (se ignora, como el fuel).
  { tipo: 'seguro',      re: /DECLARED VALUE|VALOR DECLARADO|VALUE PROTECTION/i,             label: 'Seguro (valor declarado)' },
  { tipo: 'manejo',      re: /ADDITIONAL HANDLING|MANEJO ADICIONAL|NON.?CONVEYABLE|\(NCP\)/i, label: 'Manejo adicional' },
  { tipo: 'contorno',    re: /LARGE PACKAGE|OVER ?SIZE|PAQUETE GRANDE|MAYOR TAMA|\(OSP\)/i,  label: 'Paquete de mayor tamaño' },
  { tipo: 'gogreen',     re: /GO ?GREEN/i,                                                   label: 'GoGreen' },
  { tipo: 'residencial', re: /RESIDENTIAL|RESIDENCIAL/i,                                     label: 'Entrega residencial' },
  { tipo: 'remota',      re: /EXTENDED AREA|REMOTE AREA|AREA EXTENDIDA|AREA REMOTA|ÁREA/i,   label: 'Área remota / extendida' },
  { tipo: 'surge',       re: /SURGE|INCREMENTO DE VOLUMEN|PEAK|DEMAND/i,                     label: 'Recargo por demanda' },
  { tipo: 'ipf',         re: /INTERNATIONAL PROCESSING/i,                                    label: 'Procesamiento internacional' },
  { tipo: 'papel',       re: /PAPER COMMERCIAL INVOICE/i,                                    label: 'Factura comercial en papel' },
  { tipo: 'ddp',         re: /DUTY AND TAX FORWARDING|DUTY|IMPUESTOS DE DESTINO/i,           label: 'Impuestos de destino (DDP)' },
  { tipo: 'direccion',   re: /ADDRESS CORRECTION|CORRECCI.N DE DIRECCI/i,                    label: 'Corrección de dirección' },
  { tipo: 'derechos',    re: /DERECHOS DE EXPORTACI/i,                                       label: 'Derechos de exportación' },
  { tipo: 'fuel',        re: /FUEL|COMBUSTIBLE/i,                                            label: 'Fuel' },
];

// Qué tipos del desglose del sistema cubren cada familia.
const CUBRE = {
  manejo: ['manejo'],
  contorno: ['contorno', 'oversize', 'no_convencional'],
  residencial: ['residencial'],
  remota: ['remota', 'area_remota', 'area_extendida'],
  surge: ['surge'],
  ipf: ['ipf'],
  ddp: ['ddp'],
  derechos: ['derechos'],
};

// Umbral para "vino más caro de lo previsto": desde USD 2 y 10 % por encima.
const DIF_MIN_USD = 2;
const DIF_MIN_PCT = 10;
// Diferencia de peso que vale la pena avisar.
const PESO_MIN_KG = 0.5;

function familiaDe(nombre) {
  const n = String(nombre || '');
  for (const f of FAMILIAS) if (f.re.test(n)) return f;
  return { tipo: 'otro', label: n.trim() || 'Recargo sin nombre' };
}

function parseLista(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; }
}

/**
 * @param {object} envio  { extras_json|extras, seguro, derechos, peso_facturable, ddp, entrega, remota, asegurado }
 * @param {object} factura { cargos (array {nombre,monto}) | cargos_json, peso_facturado }
 * @returns {Array<{tipo, label, facturado, previsto, dif, clase, texto}>}
 *   clase: 'no_previsto' | 'mas_caro' | 'peso'
 */
function detectarAnomalias(envio, factura) {
  if (!envio || !factura) return [];
  const cargos = parseLista(factura.cargos != null ? factura.cargos : factura.cargos_json);
  const extras = parseLista(envio.extras != null ? envio.extras : envio.extras_json);
  const out = [];

  // Lo facturado, sumado por familia (los 4 / -4 de la factura en papel se netean solos).
  const fact = new Map();
  for (const c of cargos) {
    const f = familiaDe(c.nombre || c.label);
    const key = f.tipo === 'otro' ? `otro:${f.label}` : f.tipo;
    const prev = fact.get(key) || { tipo: f.tipo, label: f.label, monto: 0 };
    prev.monto = r2(prev.monto + (Number(c.monto) || 0));
    fact.set(key, prev);
  }

  // Cargos posteriores ya cargados por la oficina (envio_cargos, no anulados): si ya se
  // agregó un "área remota" al envío, la línea de la factura está cubierta y no es anomalía.
  const CARGO_A_FAMILIA = { manejo: 'manejo', mayor_tamano: 'contorno', remota: 'remota', residencial: 'residencial', ddp: 'ddp', sobrepeso: 'peso' };
  const cargosPost = parseLista(envio.cargos_posteriores != null ? envio.cargos_posteriores : envio.cargos)
    .filter((c) => c && c.estado !== 'anulado' && !c.anulado_at);
  // Un cargo "otro" cubre por NOMBRE (06/10: "Cobrar al cliente" crea el cargo con el
  // rótulo de la familia, ej. "Corrección de dirección", "Recargo por demanda"; también si
  // la oficina lo escribió parecido, ej. "area remota"). Sin esto, el aviso seguía después
  // de cargar el cargo y la oficina lo cargaba dos veces.
  const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const ALIAS = {
    remota: ['area remota', 'area extendida', 'remota', 'extendida', 'extended area', 'remote area'],
    residencial: ['residencial', 'residential'],
    manejo: ['manejo', 'additional handling', 'non conveyable', 'ncp'],
    contorno: ['mayor tamano', 'paquete grande', 'large package', 'oversize', 'over sized', 'osp'],
    surge: ['surge', 'demanda', 'incremento de volumen', 'peak'],
    seguro: ['seguro', 'valor declarado', 'declared value', 'value protection'],
    papel: ['papel', 'paper'],
    ddp: ['ddp', 'impuestos de destino', 'duty'],
    direccion: ['correccion de direccion', 'address correction', 'direccion'],
    derechos: ['derechos de exportacion'],
  };
  const cubrePorNombre = (c, tipo, labelFamilia) => {
    if (c.tipo !== 'otro') return false;
    const l = norm(c.label);
    if (!l) return false;
    if (labelFamilia && (l === norm(labelFamilia) || l.includes(norm(labelFamilia)) || norm(labelFamilia).includes(l))) return true;
    return (ALIAS[tipo] || []).some((a) => l.includes(a));
  };
  const cubiertoPorCargo = (tipo, labelFamilia = null) => r2(cargosPost
    .filter((c) => CARGO_A_FAMILIA[c.tipo] === tipo || cubrePorNombre(c, tipo, labelFamilia))
    .reduce((s, c) => s + (Number(c.monto) || 0), 0));

  // Lo previsto por el sistema, por familia (+ lo que la oficina ya cargó como cargo posterior).
  const previsto = (tipo) => {
    let base;
    if (tipo === 'seguro') base = r2(envio.seguro);
    else if (tipo === 'derechos') base = r2(envio.derechos);
    else {
      const tipos = CUBRE[tipo] || [];
      base = r2(extras.filter((x) => tipos.includes(String(x.tipo))).reduce((s, x) => s + (Number(x.monto) || 0), 0));
    }
    return r2(base + cubiertoPorCargo(tipo, FAMILIAS.find((f) => f.tipo === tipo)?.label));
  };
  // Extras que el envío marcó aunque no tengan monto (ej. zona de entrega).
  const marcado = (tipo) => {
    if (tipo === 'remota') return Boolean(envio.remota) || (envio.entrega && envio.entrega !== 'normal');
    if (tipo === 'residencial') return Boolean(envio.residencial) || envio.entrega === 'residencial';
    if (tipo === 'ddp') return Boolean(envio.ddp);
    if (tipo === 'seguro') return Boolean(envio.asegurado);
    return false;
  };

  for (const f of fact.values()) {
    if (f.monto <= 0) continue;                 // neteado o bonificado: nada que avisar
    if (f.tipo === 'fuel' || f.tipo === 'ipf' || f.tipo === 'gogreen') continue; // siempre está, no es anomalía
    if (f.tipo === 'papel' || f.tipo === 'otro' || f.tipo === 'direccion') {
      // Nunca previstos por el sistema: la única cobertura posible es un cargo posterior
      // con ese nombre (lo crea "Cobrar al cliente" o lo escribe la oficina).
      const cub = cubiertoPorCargo(f.tipo, f.label);
      const dif = r2(f.monto - cub);
      if (dif < DIF_MIN_USD) continue;
      out.push({ tipo: f.tipo, label: f.label, facturado: f.monto, previsto: cub, dif, clase: 'no_previsto', texto: `${f.label}: USD ${f.monto.toFixed(2)} ${f.tipo === 'papel' ? '(no se bonificó)' : 'no previsto'}${cub > 0 ? ` · ya cargado USD ${cub.toFixed(2)}` : ''}` });
      continue;
    }
    const p = previsto(f.tipo);
    if (!(p > 0) && !marcado(f.tipo)) {
      out.push({ tipo: f.tipo, label: f.label, facturado: f.monto, previsto: 0, dif: f.monto, clase: 'no_previsto', texto: `${f.label}: USD ${f.monto.toFixed(2)} no previsto` });
      continue;
    }
    if (p > 0) {
      const dif = r2(f.monto - p);
      if (dif >= DIF_MIN_USD && (dif / p) * 100 >= DIF_MIN_PCT) {
        out.push({ tipo: f.tipo, label: f.label, facturado: f.monto, previsto: p, dif, clase: 'mas_caro', texto: `${f.label}: facturado USD ${f.monto.toFixed(2)}, previsto USD ${p.toFixed(2)} (+${dif.toFixed(2)})` });
      }
    }
  }

  // Peso: lo que facturó el courier contra lo que se cargó. Solo cuando UPS cobró MÁS
  // kilos (pedido de Felipe 05/10: si cobró menos es a favor nuestro, no es alerta).
  const pfac = Number(factura.peso_facturado);
  const pf = Number(envio.peso_facturable);
  if (pfac > 0 && pf > 0 && pfac - pf >= PESO_MIN_KG && cubiertoPorCargo('peso') <= 0) {
    const dif = r2(pfac - pf);
    out.push({ tipo: 'peso', label: 'Peso', facturado: pfac, previsto: pf, dif, clase: 'peso', texto: `Peso: facturado ${pfac} kg, cargado ${pf} kg (+${dif} kg)` });
  }

  // Fuel: el que cobró UPS (columna de la factura) contra el que el sistema calculó al
  // costo (envios.fuel). Solo cuando vino más caro, mismo umbral que los recargos.
  const ffac = Number(factura.fuel_facturado);
  const fsys = Number(envio.fuel);
  if (ffac > 0 && fsys > 0) {
    const dif = r2(ffac - fsys);
    if (dif >= DIF_MIN_USD && (dif / fsys) * 100 >= DIF_MIN_PCT) {
      out.push({ tipo: 'fuel', label: 'Fuel', facturado: ffac, previsto: fsys, dif, clase: 'mas_caro', texto: `Fuel: facturado USD ${ffac.toFixed(2)}, calculado USD ${fsys.toFixed(2)} (+${dif.toFixed(2)})` });
    }
  }

  return out;
}

module.exports = { detectarAnomalias, familiaDe, FAMILIAS };
