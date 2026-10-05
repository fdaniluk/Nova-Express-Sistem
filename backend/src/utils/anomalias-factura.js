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
  { tipo: 'seguro',      re: /DECLARED VALUE|VALOR DECLARADO/i,                              label: 'Seguro (valor declarado)' },
  { tipo: 'manejo',      re: /ADDITIONAL HANDLING|MANEJO ADICIONAL/i,                        label: 'Manejo adicional' },
  { tipo: 'contorno',    re: /LARGE PACKAGE|OVER ?SIZE|PAQUETE GRANDE|MAYOR TAMA/i,          label: 'Paquete de mayor tamaño' },
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
  const cubiertoPorCargo = (tipo) => r2(cargosPost.filter((c) => CARGO_A_FAMILIA[c.tipo] === tipo).reduce((s, c) => s + (Number(c.monto) || 0), 0));

  // Lo previsto por el sistema, por familia (+ lo que la oficina ya cargó como cargo posterior).
  const previsto = (tipo) => {
    let base;
    if (tipo === 'seguro') base = r2(envio.seguro);
    else if (tipo === 'derechos') base = r2(envio.derechos);
    else {
      const tipos = CUBRE[tipo] || [];
      base = r2(extras.filter((x) => tipos.includes(String(x.tipo))).reduce((s, x) => s + (Number(x.monto) || 0), 0));
    }
    return r2(base + cubiertoPorCargo(tipo));
  };
  // Extras que el envío marcó aunque no tengan monto (ej. zona de entrega).
  const marcado = (tipo) => {
    if (tipo === 'remota') return Boolean(envio.remota) || (envio.entrega && envio.entrega !== 'normal');
    if (tipo === 'residencial') return envio.entrega === 'residencial';
    if (tipo === 'ddp') return Boolean(envio.ddp);
    if (tipo === 'seguro') return Boolean(envio.asegurado);
    return false;
  };

  for (const f of fact.values()) {
    if (f.monto <= 0) continue;                 // neteado o bonificado: nada que avisar
    if (f.tipo === 'fuel' || f.tipo === 'ipf') continue; // siempre está, no es anomalía
    if (f.tipo === 'papel') {
      out.push({ tipo: f.tipo, label: f.label, facturado: f.monto, previsto: 0, dif: f.monto, clase: 'no_previsto', texto: `${f.label}: USD ${f.monto.toFixed(2)} (no se bonificó)` });
      continue;
    }
    if (f.tipo === 'otro' || f.tipo === 'direccion') {
      out.push({ tipo: f.tipo, label: f.label, facturado: f.monto, previsto: 0, dif: f.monto, clase: 'no_previsto', texto: `${f.label}: USD ${f.monto.toFixed(2)} no previsto` });
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

  // Peso: lo que facturó el courier contra lo que se cargó.
  const pfac = Number(factura.peso_facturado);
  const pf = Number(envio.peso_facturable);
  if (pfac > 0 && pf > 0 && Math.abs(pfac - pf) >= PESO_MIN_KG && !(pfac > pf && cubiertoPorCargo('peso') > 0)) {
    const dif = r2(pfac - pf);
    out.push({ tipo: 'peso', label: 'Peso', facturado: pfac, previsto: pf, dif, clase: 'peso', texto: `Peso: facturado ${pfac} kg, cargado ${pf} kg (${dif > 0 ? '+' : ''}${dif} kg)` });
  }

  return out;
}

module.exports = { detectarAnomalias, familiaDe, FAMILIAS };
