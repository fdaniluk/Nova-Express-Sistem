#!/usr/bin/env node
/**
 * test-impuestos-impo.js — el estimador de impuestos de importación, contra la realidad.
 *
 * Los casos NO son inventados: son CUATRO liquidaciones reales que trajo Felipe el
 * 28/08/2026 — dos Notas de Venta de DHL (0280-01693029 y 0280-01692751) y dos
 * Facturas-Liquidación de UPS (0013-00991465 y 0013-00996104, en pesos, con su tipo
 * de cambio impreso). La función tiene que reproducir el TOTAL de cada una al centavo
 * (±0,02 por redondeo de conversión). Si alguien toca una alícuota, esto se pone rojo.
 *
 * Desde el 02/09/2026 la función recibe los KILOS, no el flete: el flete del CIF es un
 * flete AFORADO de USD 2,50 por kilo facturable (regla de Felipe), no el flete de venta.
 * Las liquidaciones lo confirman: 284,35 / 113,74 kg, 317,75 / 127,10 kg y 6,25 / 2,5 kg
 * dan 2,50 exacto. Hasta ese día el cotizador le mandaba el flete de venta con fuel y el
 * CIF salía inflado (la oficina lo vio en la pantalla).
 *
 *   cd backend && node scripts/test-impuestos-impo.js
 */

const { calcImpuestos, FLETE_AFORADO_KG } = require('../../shared/cotizador/cotizador-core');

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const cerca = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
const r2 = (n) => Math.round(n * 100) / 100;

console.log('\n0. El flete aforado\n');
check('2,50 USD por kilo facturable', FLETE_AFORADO_KG === 2.5, String(FLETE_AFORADO_KG));
check('la función lo calcula sola a partir de los kilos', cerca(calcImpuestos(0, 113.74, 0, 'DHL').flete, 284.35),
  String(r2(calcImpuestos(0, 113.74, 0, 'DHL').flete)));

console.log('\n1. DHL 0280-01693029 — China, 113,74 kg, arancel 20% (USD)\n');
let i = calcImpuestos(2900, 113.74, 0.20, 'DHL');
check('flete aforado 284,35 (2,50 × 113,74) como en la Nota de Venta', cerca(i.flete, 284.35), String(r2(i.flete)));
check('seguro aduanero 1% de (FOB+flete) = 31,84', cerca(i.seguroCIF, 31.84), String(r2(i.seguroCIF)));
check('CIF 3.216,19', cerca(i.CIF, 3216.19), String(r2(i.CIF)));
check('derechos 20% = 643,24', cerca(i.derechos, 643.24), String(r2(i.derechos)));
check('estadística 3% = 96,49', cerca(i.tasaEst, 96.49), String(r2(i.tasaEst)));
// DHL presenta UN solo renglón de IVA (21% sobre CIF+derechos+tasa+procesamiento);
// la función lo parte en IVA aduana + IVA del fee. La SUMA tiene que dar el renglón real.
check('IVA (aduana + s/fee) = 840,63 como en la factura', cerca(i.ivaAduana + i.ivaGastoDoc, 840.63),
  String(r2(i.ivaAduana + i.ivaGastoDoc)));
check('procesamiento DHL 47,11', cerca(i.gastoDoc, 47.11), String(r2(i.gastoDoc)));
check('percepción IIBB 55,08 (4%+3% sobre servicios)', cerca(i.percIIBB, 55.08), String(r2(i.percIIBB)));
check('TOTAL A PAGAR 1.682,55', cerca(i.total, 1682.55), String(r2(i.total)));

console.log('\n2. DHL 0280-01692751 — China, 127,10 kg, arancel 20% (USD)\n');
i = calcImpuestos(1150.50, 127.10, 0.20, 'DHL');
check('flete aforado 317,75 (2,50 × 127,10)', cerca(i.flete, 317.75), String(r2(i.flete)));
check('CIF 1.482,93', cerca(i.CIF, 1482.93), String(r2(i.CIF)));
check('procesamiento DHL 21,72', cerca(i.gastoDoc, 21.72), String(r2(i.gastoDoc)));
check('TOTAL A PAGAR 775,79', cerca(i.total, 775.79), String(r2(i.total)));

console.log('\n3. UPS 0013-00991465 — China, 63 kg, arancel 20% (ARS, TC 1.358)\n');
const TC1 = 1358;
// ⚠ El flete de esta liquidación (200.984 $ / 1.358 = 148,00 USD) es 2,50 × 59,2 kg, no
// × 63. Los 63 kg salieron del papel; 59,2 sale del flete. Uno de los dos números está
// mal copiado y hay que mirar la Factura-Liquidación de nuevo para saber cuál. Mientras
// tanto se usa el peso que reproduce el flete, que es lo que la aduana valoró.
i = calcImpuestos(3678822 / TC1, 59.2, 0.20, 'UPS');
check('flete aforado 148,00 USD = 200.984 $ / TC (2,50 × 59,2 kg)', cerca(i.flete, 148.00), String(r2(i.flete)));
check('seguro aduanero = 38.798,06 $', cerca(i.seguroCIF * TC1, 38798.06, 5), String(r2(i.seguroCIF * TC1)));
check('CIF = 3.918.604,06 $', cerca(i.CIF * TC1, 3918604.06, 5), String(r2(i.CIF * TC1)));
check('gasto documental FIJO USD 126', i.gastoDoc === 126, String(i.gastoDoc));
check('sin percepción IIBB en la muestra UPS', i.percIIBB === 0, String(i.percIIBB));
check('TOTAL = 2.120.495,04 $', cerca(i.total * TC1, 2120495.04, 30), String(r2(i.total * TC1)));

console.log('\n4. UPS 0013-00996104 — Chequia, 2,5 kg, ARANCEL 16% (ARS, TC 1.394,5)\n');
const TC2 = 1394.5;
i = calcImpuestos(3486026.88 / TC2, 2.5, 0.16, 'UPS');
check('flete aforado 6,25 USD (2,50 × 2,5 kg) = 8.715,63 $ / TC', cerca(i.flete * TC2, 8715.63, 1), String(r2(i.flete * TC2)));
check('derechos 16% = 564.750,39 $', cerca(i.derechos * TC2, 564750.39, 10), String(r2(i.derechos * TC2)));
check('gasto documental = 175.707 $ (126 USD × TC)', cerca(i.gastoDoc * TC2, 175707, 1), String(r2(i.gastoDoc * TC2)));
check('TOTAL = 1.765.316,08 $', cerca(i.total * TC2, 1765316.08, 30), String(r2(i.total * TC2)));

console.log('\n5. Los bordes\n');
i = calcImpuestos(1000, 40, 0, 'UPS');
check('arancel 0 → derechos 0 pero el resto vive', i.derechos === 0 && i.total > 0, JSON.stringify({ d: i.derechos, t: r2(i.total) }));
const iU = calcImpuestos(1000, 40, 0.20, 'UPS');
const iD = calcImpuestos(1000, 40, 0.20, 'DHL');
check('mismo envío: DHL suma IIBB y su fee, UPS su fijo — totales distintos', Math.abs(iU.total - iD.total) > 1,
  `UPS ${r2(iU.total)} vs DHL ${r2(iD.total)}`);
check('el label del servicio del motor sirve como courier (incluye "DHL")',
  calcImpuestos(1000, 40, 0.2, 'DHL Express Worldwide').percIIBB > 0);
check('el flete de venta NO entra: 40 kg dan el mismo CIF valgan lo que valgan',
  cerca(calcImpuestos(1000, 40, 0.2, 'UPS').CIF, calcImpuestos(1000, 40, 0.2, 'DHL').CIF));

console.log('\n' + '─'.repeat(60));
console.log(`${ok} pasaron · ${fail} fallaron`);
process.exit(fail === 0 ? 0 : 1);
