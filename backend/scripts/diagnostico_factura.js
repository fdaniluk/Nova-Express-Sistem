const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const PDF_PATH = path.join(__dirname, '../../facturas-ejemplo/factura_test_ups.pdf');

// Formato argentino: punto = miles, coma = decimal
// "1,292,50" (PDF drops the dot) → 1292.50, "-2,50" → -2.50
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

async function main() {
  const buffer = fs.readFileSync(PDF_PATH);
  const data = await pdfParse(buffer);
  const lines = data.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  const guias = [];
  let current = null;
  // Estados: idle → columnas → neto → cargos
  let state = 'idle';

  for (const line of lines) {
    // Línea de tracking: "1Z327W096790199567   26.00Kg NC 19/05/2026 GB  ....."
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
      // "1,292,50    -1,150,33       518,92      -445,75"
      const col = line.match(/^(-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)$/);
      if (col) state = 'neto';
      continue;
    }

    if (state === 'neto') {
      // Número suelto: "215,34"
      const netoMatch = line.match(/^(-?[\d.,]+)$/);
      if (netoMatch) {
        current.neto = parseAR(netoMatch[1]);
        state = 'cargos';
      }
      continue;
    }

    if (state === 'cargos') {
      // "Additional Handling         27,65" o "PAPER COMMERCIAL INVOICE SURCHARGE         -2,50"
      // Requiere al menos 2 espacios antes del número y que el nombre tenga letras
      const cargoMatch = line.match(/^(.+?)\s{2,}(-?[\d.,]+)$/);
      if (cargoMatch && /[A-Za-záéíóúñÁÉÍÓÚÑ]/.test(cargoMatch[1])) {
        current.cargos.push({
          nombre: cargoMatch[1].trim(),
          monto: parseAR(cargoMatch[2]),
        });
      }
    }
  }

  if (current) guias.push(current);

  // Deduplicar por tracking (por si el texto de alguna página repite algo)
  const seen = new Set();
  const unicas = guias.filter(g => {
    if (seen.has(g.tracking)) return false;
    seen.add(g.tracking);
    return true;
  });

  // ─── DETALLE POR GUÍA ───────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  console.log(`DIAGNÓSTICO DE EXTRACCIÓN — ${unicas.length} GUÍAS DETECTADAS`);
  console.log('═'.repeat(72));

  let totalGeneral = 0;

  unicas.forEach((g, i) => {
    const sumaCargos = g.cargos.reduce((s, c) => s + c.monto, 0);
    const costoTotal = (g.neto ?? 0) + sumaCargos;
    totalGeneral += costoTotal;

    console.log(`\n[${i + 1}] ${g.tracking}  |  ${g.pais}  |  ${g.peso} kg`);
    console.log(`    Neto línea  : ${(g.neto ?? 0).toFixed(2).padStart(9)}`);
    console.log(`    Cargos adicionales:`);
    if (g.cargos.length === 0) {
      console.log('      (ninguno)');
    } else {
      g.cargos.forEach(c => {
        const signo = c.monto >= 0 ? '+' : '';
        console.log(`      ${(signo + c.monto.toFixed(2)).padStart(9)}  ${c.nombre}`);
      });
    }
    console.log(`    Suma cargos : ${sumaCargos.toFixed(2).padStart(9)}`);
    console.log(`    ─────────────────────────`);
    console.log(`    COSTO TOTAL : ${costoTotal.toFixed(2).padStart(9)}`);
  });

  // ─── TABLA RESUMEN ───────────────────────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(72));
  console.log('TABLA RESUMEN');
  console.log('═'.repeat(72));
  const H = ['Tracking', 'País', 'Peso', 'Neto', 'Cargos', 'Total'];
  console.log(
    H[0].padEnd(22) + H[1].padEnd(6) + H[2].padEnd(9) +
    H[3].padStart(9) + H[4].padStart(10) + H[5].padStart(10)
  );
  console.log('─'.repeat(66));

  unicas.forEach(g => {
    const sumaCargos = g.cargos.reduce((s, c) => s + c.monto, 0);
    const costoTotal = (g.neto ?? 0) + sumaCargos;
    console.log(
      g.tracking.padEnd(22) +
      g.pais.padEnd(6) +
      (g.peso + ' kg').padEnd(9) +
      (g.neto ?? 0).toFixed(2).padStart(9) +
      sumaCargos.toFixed(2).padStart(10) +
      costoTotal.toFixed(2).padStart(10)
    );
  });

  console.log('─'.repeat(66));
  console.log(
    'TOTAL GENERAL'.padEnd(46) + totalGeneral.toFixed(2).padStart(10)
  );
  console.log('\nTotal declarado en la factura: USD 3,159.55');
  const diff = Math.abs(totalGeneral - 3159.55);
  console.log(`Diferencia vs. factura       : ${diff < 0.05 ? '✓ OK (' + diff.toFixed(2) + ')' : '⚠ ' + diff.toFixed(2)}`);
}

main().catch(console.error);
