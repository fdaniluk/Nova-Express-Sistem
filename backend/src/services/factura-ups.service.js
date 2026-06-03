const pdfParse = require('pdf-parse');

// Argentine number format: comma = decimal separator, dot = thousands separator
// Examples: "1,292,50" → 1292.50, "-2,50" → -2.50, "215,34" → 215.34
function parseAR(str) {
  str = str.trim();
  const neg = str.startsWith('-');
  str = str.replace(/^-/, '');
  const parts = str.split(',');
  let num;
  if (parts.length === 1) {
    num = parseFloat(str.replace(/\./g, '')) || 0;
  } else {
    const decimal = parts[parts.length - 1];
    const integer = parts.slice(0, -1).join('').replace(/\./g, '');
    num = parseFloat(integer + '.' + decimal) || 0;
  }
  return neg ? -num : num;
}

async function extraerFacturaUPS(buffer) {
  const data = await pdfParse(buffer);
  const lines = data.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  let numero_factura = null;
  let fecha_factura = null;

  for (const line of lines) {
    // "N° 0020-00074402" — cuatro dígitos, guión, ocho dígitos
    if (!numero_factura) {
      const m = line.match(/N°\s+(\d{4}-\d{8})/);
      if (m) numero_factura = m[1];
    }
    // Fecha sola al principio del encabezado: "31/05/2026"
    if (!fecha_factura) {
      const m = line.match(/^(\d{2}\/\d{2}\/\d{4})$/);
      if (m) fecha_factura = m[1];
    }
    if (numero_factura && fecha_factura) break;
  }

  // State-machine extraction (validated logic from scripts/diagnostico_factura.js)
  const guias = [];
  let current = null;
  let state = 'idle';

  for (const line of lines) {
    // Tracking line: "1Z327W096790199567   26.00Kg NC 19/05/2026 GB  ..."
    const trackingMatch = line.match(/^(1Z\w+)\s+([\d.]+)Kg\s+\w+\s+[\d/]+\s+([A-Z]{2})\s/);
    if (trackingMatch) {
      if (current) guias.push(current);
      current = {
        tracking: trackingMatch[1],
        peso: parseFloat(trackingMatch[2]),
        pais: trackingMatch[3],
        neto: null,
        cargos: [],
      };
      state = 'columnas';
      continue;
    }

    if (!current) continue;

    if (state === 'columnas') {
      const col = line.match(/^(-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)$/);
      if (col) state = 'neto';
      continue;
    }

    if (state === 'neto') {
      const netoMatch = line.match(/^(-?[\d.,]+)$/);
      if (netoMatch) {
        current.neto = parseAR(netoMatch[1]);
        state = 'cargos';
      }
      continue;
    }

    if (state === 'cargos') {
      // "Additional Handling         27,65"  or  "PAPER COMMERCIAL INVOICE SURCHARGE   -2,50"
      const cargoMatch = line.match(/^(.+?)\s{2,}(-?[\d.,]+)$/);
      if (cargoMatch && /[A-Za-záéíóúñÁÉÍÓÚÑ]/.test(cargoMatch[1])) {
        current.cargos.push({ nombre: cargoMatch[1].trim(), monto: parseAR(cargoMatch[2]) });
      }
    }
  }

  if (current) guias.push(current);

  // Dedup by tracking number (PDF can repeat header lines across pages)
  const seen = new Set();
  const unicas = guias.filter(g => {
    if (seen.has(g.tracking)) return false;
    seen.add(g.tracking);
    return true;
  });

  const resultado = unicas.map(g => {
    const total_recargos = Math.round(g.cargos.reduce((s, c) => s + c.monto, 0) * 100) / 100;
    const costo_total = Math.round(((g.neto ?? 0) + total_recargos) * 100) / 100;
    return {
      numero_guia: g.tracking,
      pais: g.pais,
      peso: g.peso,
      neto: g.neto ?? 0,
      total_recargos,
      costo_total,
    };
  });

  return { numero_factura, fecha_factura, guias: resultado };
}

module.exports = { extraerFacturaUPS };
