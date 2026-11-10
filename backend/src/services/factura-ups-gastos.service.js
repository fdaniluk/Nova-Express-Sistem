// Lector de la "FACTURA - LIQUIDACION DE GASTOS" de UPS (punto de venta 0027), 10/11/2026.
//
// Es la factura del flete de una IMPORTACIÓN con flete a cobrar en destino (F/C): una guía
// por factura (1Z3R6A45…), con el país de origen, los bultos, el peso y este desglose:
//   SERVICIO INTERNACIONAL
//     VALOR TARIFARIO      993,10
//     DESCUENTO (75,00%)  -744,83
//     SOBRECARGO           109,97   ← combustible
//     SEGURO                19,10
//     TOTAL                377,34
//   PERCEPCION INGRESOS BRUTOS  (DN 'B' 1/2004 5,66 + Res 421/AGIP/2016 5,66)
//   IMPRESIÓN DE ETIQUETA    1,10
//   TEMPORADA ALTA          19,95
//   (total del pie)        409,71
// Hasta hoy el sistema contestaba "No se detectó ninguna guía" (facturas 0027-00014363 y
// 0027-00014772). En el texto plano de pdf-parse las etiquetas y los importes salen en
// tandas separadas y no se sabe cuál es de cuál: se lee por POSICIONES (el importe de cada
// renglón es el número que está a la misma altura, a la derecha de la etiqueta).
//
// Devuelve la MISMA forma que una factura de flete de UPS: neto = flete (tarifario −
// descuento) + sobrecargo; seguro, etiqueta y temporada alta van como recargos. La
// percepción de IIBB NO se reparte en el envío (decisión del 05/10): queda en la cabecera.

const { parseImporte } = require('./factura-ups.service');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const IMPORTE = /^-?[\d.]*\d,\d{2}$/;

function esLiquidacionDeGastosUPS(texto) {
  return /UPS de Argentina/i.test(texto) && /FACTURA\s*-\s*LIQUIDACI[OÓ]N DE GASTOS/i.test(texto);
}

function extraerLiquidacionGastosUPSDesdePaginas(paginas) {
  const items = paginas.flat();
  const advertencias = [];
  // Importe del renglón de una etiqueta: el/los números a la misma altura (±4), a su derecha.
  const enRenglon = (re) => {
    const et = items.find((i) => re.test(i.s.trim()));
    if (!et) return [];
    return items
      .filter((i) => Math.abs(i.y - et.y) <= 4 && i.x > et.x && IMPORTE.test(i.s.trim()))
      .sort((a, b) => a.x - b.x)
      .map((i) => parseImporte(i.s.trim()));
  };
  const uno = (re) => { const v = enRenglon(re); return v.length ? v[0] : null; };
  const textoAlLado = (re, valorRe) => {
    const et = items.find((i) => re.test(i.s.trim()));
    if (!et) return null;
    const v = items.filter((i) => Math.abs(i.y - et.y) <= 4 && i.x > et.x && valorRe.test(i.s.trim())).sort((a, b) => a.x - b.x)[0];
    return v ? v.s.trim() : null;
  };

  // Número: "0027" y "00014363" vienen en dos textos, uno al lado del otro.
  const pv = items.find((i) => /^\d{4}$/.test(i.s.trim()) && items.some((j) => /^\d{8}$/.test(j.s.trim()) && Math.abs(j.y - i.y) <= 4 && j.x > i.x));
  const nro = pv ? items.find((j) => /^\d{8}$/.test(j.s.trim()) && Math.abs(j.y - pv.y) <= 4 && j.x > pv.x) : null;
  const numero_factura = pv && nro ? `${pv.s.trim()}-${nro.s.trim()}` : null;
  if (!numero_factura) advertencias.push({ tipo: 'sin_numero_factura', detalle: 'No se pudo leer el número de la factura.' });
  // Fecha: la primera fecha de arriba hacia abajo (la de emisión; el vencimiento va más abajo).
  // UPS la escribe sin cero adelante ("2/11/2026"): se normaliza a dd/mm/aaaa.
  const fechas = items.filter((i) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(i.s.trim())).sort((a, b) => b.y - a.y);
  const fecha_factura = fechas.length
    ? fechas[0].s.trim().split('/').map((p, k) => (k < 2 ? p.padStart(2, '0') : p)).join('/')
    : null;
  if (!fecha_factura) advertencias.push({ tipo: 'sin_fecha_factura', detalle: 'No se pudo leer la fecha de la factura.' });

  const guiaIt = items.find((i) => /^1Z[0-9A-Z]{16}$/.test(i.s.trim()));
  const tarifario = uno(/^VALOR TARIFARIO/i);
  const descuento = uno(/^DESCUENTO/i) || 0;
  const sobrecargo = uno(/^SOBRECARGO/i) || 0;
  const seguro = uno(/^SEGURO/i) || 0;
  const totalServicio = uno(/^TOTAL:?$/i);
  const etiqueta = uno(/^IMPRESI[OÓ]N DE ETIQUETA/i) || 0;
  const temporada = uno(/^TEMPORADA ALTA/i) || 0;
  const percepciones = r2(
    items.filter((i) => /^(DN\s|Res\s*N)/i.test(i.s.trim()))
      .map((et) => items.filter((i) => Math.abs(i.y - et.y) <= 4 && i.x > et.x && IMPORTE.test(i.s.trim())).map((i) => parseImporte(i.s.trim()))[0] || 0)
      .reduce((s, x) => s + x, 0)
  );
  // Total del pie: el importe suelto más abajo de la tabla (debajo de "TEMPORADA ALTA").
  const yTabla = Math.min(...items.filter((i) => /^(TEMPORADA ALTA|IMPRESI[OÓ]N DE ETIQUETA|TOTAL:?$)/i.test(i.s.trim())).map((i) => i.y), Infinity);
  const pie = items.filter((i) => IMPORTE.test(i.s.trim()) && i.y < yTabla - 20).sort((a, b) => b.y - a.y)[0];
  const total_declarado = pie ? parseImporte(pie.s.trim()) : null;

  const guias = [];
  if (!guiaIt) {
    advertencias.push({ tipo: 'sin_guias', detalle: 'No se detectó la guía en la factura de liquidación de gastos de UPS.' });
  } else {
    const peso = textoAlLado(/^Peso Total del Env/i, /^\d+(,\d+)?$/);
    const flete_neto = tarifario != null ? r2(tarifario + descuento) : null;
    const neto = flete_neto != null ? r2(flete_neto + sobrecargo) : null;
    const cargos = [];
    if (seguro) cargos.push({ nombre: 'Seguro (Declared Value)', monto: r2(seguro) });
    if (etiqueta) cargos.push({ nombre: 'Impresión de etiqueta', monto: r2(etiqueta) });
    if (temporada) cargos.push({ nombre: 'Temporada alta (Peak Surcharge)', monto: r2(temporada) });
    const total_recargos = r2(cargos.reduce((s, c) => s + c.monto, 0));
    if (neto == null) {
      advertencias.push({ tipo: 'sin_neto', guia: guiaIt.s.trim(), detalle: 'No se pudo leer el VALOR TARIFARIO de la factura. La guía NO tiene costo calculable.' });
    } else if (totalServicio != null && Math.abs(r2(neto + seguro) - totalServicio) >= 0.05) {
      advertencias.push({ tipo: 'servicio_no_cuadra', guia: guiaIt.s.trim(), detalle: `El desglose del servicio (tarifario ${tarifario} + descuento ${descuento} + sobrecargo ${sobrecargo} + seguro ${seguro}) no da el TOTAL del servicio (${totalServicio}).` });
    }
    guias.push({
      tracking: guiaIt.s.trim(),
      numero_guia: guiaIt.s.trim(),
      pais: textoAlLado(/^Pa[ií]s de Origen/i, /^[A-Za-zÁÉÍÓÚÑáéíóúñ .,'()-]{3,}$/),
      peso: peso != null ? Number(peso.replace(',', '.')) : null,
      flete_neto,
      fuel: neto != null ? r2(sobrecargo) : null,
      neto,
      total_recargos,
      percepcion: null,
      costo_total: neto != null ? r2(neto + total_recargos) : null,
      cargos,
    });
  }

  const conCosto = guias.filter((g) => g.costo_total != null);
  const suma_guias = r2(conCosto.reduce((s, g) => s + g.costo_total, 0));
  const subtotal_factura = total_declarado != null ? r2(total_declarado - percepciones) : null;
  let diferencia = null, cuadra = null;
  if (total_declarado != null) {
    diferencia = r2(subtotal_factura - suma_guias);
    cuadra = Math.abs(diferencia) < 0.05;
    if (!cuadra) advertencias.push({ tipo: 'total_no_cuadra', detalle: `La suma de la guía (USD ${suma_guias.toFixed(2)}) no coincide con el total de la factura sin percepciones (USD ${subtotal_factura.toFixed(2)}). Diferencia: USD ${diferencia.toFixed(2)}. Revisá la factura.` });
    else if (percepciones > 0) advertencias.push({ tipo: 'percepcion_aparte', detalle: `La factura incluye USD ${percepciones.toFixed(2)} de percepción de Ingresos Brutos. No se reparte en el envío: queda registrada en la factura.` });
  } else {
    advertencias.push({ tipo: 'sin_total_declarado', detalle: 'No se pudo leer el total de la factura, así que no se pudo verificar que cuadre.' });
  }

  return {
    courier: 'UPS',
    tipo: 'flete',
    formato: 'liquidacion_gastos',
    numero_factura,
    fecha_factura,
    guias,
    total_declarado,
    subtotal_factura,
    suma_guias,
    diferencia,
    cuadra,
    percepciones: percepciones || null,
    percepciones_repartidas: false,
    suma_guias_final: suma_guias,
    advertencias,
  };
}

module.exports = { esLiquidacionDeGastosUPS, extraerLiquidacionGastosUPSDesdePaginas };
