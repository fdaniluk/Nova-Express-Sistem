#!/usr/bin/env node
/**
 * test-tarifa-50.js — la tarifa DHL "MAS 50 KGS" de exportación (01/09/2026).
 *
 * De dónde salió: Nova tiene DOS cuentas de DHL para exportación. La segunda ("MAS 50 KGS")
 * tiene tarifa propia arriba de 50 kg y, sobre todo, NO COBRA GoGreen — 0,98 USD por kilo
 * facturable, que en 60 kg son 58,80 USD, más que toda la diferencia de flete.
 *
 * Las dos reglas que cuida esta tanda:
 *   1. NUNCA se elige la tarifa más cara. La elección se hace por COSTO COMPLETO
 *      (flete + fuel + GoGreen), no por flete pelado, porque una tarifa paga GoGreen y
 *      la otra no. Con las tablas de hoy gana la +50 en las seis zonas de 51 a 300 kg.
 *   2. Cuando se usa la +50, el resultado lo DICE (`tarifa50` y `avisoTarifa50`). No es
 *      cosmética: la guía se emite contra la otra cuenta de DHL, y si la oficina no lo ve,
 *      el envío se despacha por la cuenta equivocada.
 *
 * Y lo que NO tiene que moverse: documentos, importación, UPS, y todo lo de 50 kg para
 * abajo. Ahí no hay tarifa +50 que valga y el precio tiene que dar igual que siempre.
 *
 *   cd backend && node scripts/test-tarifa-50.js
 */

const {
  cotizarServicio, getDHLE50, getDHL, getDHLBig,
  DHL_E_50_PK, DHL_E_PKG, MSG_TARIFA_50,
} = require('../../shared/cotizador/cotizador-core');

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const cerca = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;

// Cotización DHL de exportación con un solo bulto del peso pedido.
// dims chicas a propósito: no tienen que dispararse recargos dimensionales que ensucien
// la comparación (sobrepeso, exceso, pieza no convencional).
const dhl = (pais, kg, extra = {}) => cotizarServicio('DHL', {
  pais, tipo: 'export', pf: kg, fob: 0, fuelPct: 39.5, profitPct: 100,
  bultosProc: [{ dims: [50, 40, 30], pr: kg }], ...extra,
});

console.log('\n1. Los valores por kilo del tarifario\n');
check('los seis rates son los del PDF',
  JSON.stringify(DHL_E_50_PK) === JSON.stringify([4.38, 4.98, 6.00, 6.60, 7.50, 8.40]),
  JSON.stringify(DHL_E_50_PK));

console.log('\n2. Celda por celda contra el PDF oficial\n');
// Filas copiadas A MANO del PDF "TARIFARIO DHL EXPO MAS 50 KGS" (las 6 zonas).
// Si alguien toca la fórmula o los rates, esto se pone rojo.
const PDF = [
  [51, 223.38, 253.98, 306, 336.6, 382.5, 428.4],
  [60, 262.8, 298.8, 360, 396, 450, 504],
  [71, 310.98, 353.58, 426, 468.6, 532.5, 596.4],
  [100, 438, 498, 600, 660, 750, 840],
  [150, 657, 747, 900, 990, 1125, 1260],
  [200, 876, 996, 1200, 1320, 1500, 1680],
  [250, 1095, 1245, 1500, 1650, 1875, 2100],
  [300, 1314, 1494, 1800, 1980, 2250, 2520],
];
let malas = [];
PDF.forEach((fila) => {
  for (let z = 1; z <= 6; z++) {
    const m = getDHLE50(z, fila[0]);
    if (!cerca(m, fila[z])) malas.push(`${fila[0]}kg z${z}: motor ${m} ≠ PDF ${fila[z]}`);
  }
});
check(`las ${PDF.length * 6} celdas del PDF coinciden al centavo`, malas.length === 0, malas.slice(0, 3).join(' | '));

console.log('\n3. La tarifa es lineal en todo el rango\n');
let noLineal = 0;
for (let kg = 51; kg <= 300; kg++) {
  for (let z = 1; z <= 6; z++) if (!cerca(getDHLE50(z, kg), kg * DHL_E_50_PK[z - 1])) noLineal++;
}
check('las 1.500 celdas de 51 a 300 kg son kilos × valor por kilo', noLineal === 0, `${noLineal} no cuadran`);
check('DHL redondea el peso para arriba: 60,1 kg paga 61', cerca(getDHLE50(1, 60.1), 61 * 4.38), String(getDHLE50(1, 60.1)));
check('arriba de 300 kg sigue el mismo valor por kilo', cerca(getDHLE50(4, 350), 350 * 6.60), String(getDHLE50(4, 350)));
check('debajo de 51 kg esta tarifa no existe', getDHLE50(1, 50) === null && getDHLE50(1, 30) === null);

console.log('\n4. El borde: 50 kg contra 51 kg\n');
const a50 = dhl('Brasil', 50), a51 = dhl('Brasil', 51);
check('50 kg va por la tarifa de siempre', a50.tarifa50 === false, JSON.stringify(a50.tarifa50));
check('y paga GoGreen', a50.goGreen > 0, String(a50.goGreen));
check('51 kg va por la +50', a51.tarifa50 === true);
check('y NO paga GoGreen', a51.goGreen === 0, String(a51.goGreen));
check('el flete de 51 kg es el del PDF', cerca(a51.fleteBase, 223.38), String(a51.fleteBase));
check('el aviso viaja con el resultado', a51.avisoTarifa50 === MSG_TARIFA_50, String(a51.avisoTarifa50));
check('y a 50 kg no hay aviso', a50.avisoTarifa50 === null);

console.log('\n5. Las seis zonas, de 51 a 300 kg\n');
// La regla dura: el costo elegido NUNCA puede ser el más caro de los dos.
// Costo = flete × (1+fuel) + GoGreen, que es lo que DHL le factura a Nova.
const PAIS_ZONA = { 1: 'Brasil', 2: 'Colombia', 3: 'Estados Unidos', 4: 'España', 5: 'China', 6: 'Australia' };
const FUEL = 0.395;
let peor = [], sinAviso = [], ganaron50 = 0, total = 0;
for (let z = 1; z <= 6; z++) {
  for (let kg = 51; kg <= 300; kg++) {
    total++;
    const r = dhl(PAIS_ZONA[z], kg);
    const costoNormal = getDHL(DHL_E_PKG, z, kg) * (1 + FUEL) + Number((kg * 0.98).toFixed(2));
    const costo50 = getDHLE50(z, kg) * (1 + FUEL);
    const elegido = r.fleteBase * (1 + FUEL) + r.goGreen;
    if (elegido > Math.min(costoNormal, costo50) + 0.005) peor.push(`z${z} ${kg}kg`);
    if (r.tarifa50) { ganaron50++; if (!r.avisoTarifa50) sinAviso.push(`z${z} ${kg}kg`); }
  }
}
check(`en los ${total} casilleros se eligió siempre el costo menor`, peor.length === 0, peor.slice(0, 3).join(' | '));
check('con las tarifas de hoy la +50 gana en TODOS', ganaron50 === total, `ganó en ${ganaron50} de ${total}`);
check('y en todos avisó', sinAviso.length === 0, sinAviso.slice(0, 3).join(' | '));

console.log('\n6. Lo que NO se tiene que mover\n');
// Valores del tarifario de siempre (DHL_E_PKG / DHL_E_PKG_BIG), copiados a mano.
check('50 kg zona 1 sigue costando 216,92 de flete', cerca(a50.fleteBase, 216.92), String(a50.fleteBase));
check('10 kg zona 4 sigue costando 119,50', cerca(dhl('España', 10).fleteBase, 119.50), String(dhl('España', 10).fleteBase));
check('el GoGreen de 10 kg sigue siendo 9,80', cerca(dhl('España', 10).goGreen, 9.80), String(dhl('España', 10).goGreen));

const doc = cotizarServicio('DHL', {
  pais: 'España', tipo: 'export', pf: 1.5, fob: 0, fuelPct: 39.5, profitPct: 100,
  bultosProc: [{ dims: [30, 20, 2], pr: 1.5 }], contenido: 'documento',
});
check('los documentos siguen con su tabla propia y sin +50', doc.tarifa50 === false && cerca(doc.fleteBase, 38.28),
  `${doc.tarifa50} / ${doc.fleteBase}`);

const impo = cotizarServicio('DHL', {
  pais: 'China', tipo: 'import', pf: 60, fob: 0, fuelPct: 39.5, profitPct: 100,
  bultosProc: [{ dims: [50, 40, 30], pr: 60 }],
});
check('importación arriba de 50 kg sigue con DHL_I_BIG', cerca(impo.fleteBase, getDHLBig(5, 60)), String(impo.fleteBase));
check('y sigue sin GoGreen, como venía', impo.goGreen === 0);
check('pero NO se marca como tarifa +50 (esa es la de expo)', impo.tarifa50 === false);

const ups = cotizarServicio('UPS_EXP', {
  pais: 'España', tipo: 'export', pf: 60, fob: 0, fuelPct: 39.5, profitPct: 100,
  bultosProc: [{ dims: [50, 40, 30], pr: 60 }],
});
check('UPS ni se entera', ups.tarifa50 === undefined || ups.tarifa50 === false, String(ups.tarifa50));

console.log('\n7. El precio final cierra\n');
// El total tiene que ser exactamente flete×(1+profit)×(1+fuel) + extras, sin GoGreen.
const e = dhl('España', 60);
// Los extras van a costo, después del margen y sin fuel (criterio del 29/07). Un bulto de
// 60 kg paga "pieza no convencional", así que entra en el esperado como está: el punto de
// este control es que el GoGreen NO está y que el resto del cálculo no se movió.
const esperado = e.fleteBase * 2 * 1.395 + e.extrasTotal;
check('60 kg a España: total = flete × (1+profit) × (1+fuel) + extras, sin GoGreen',
  cerca(e.total, esperado, 0.02), `${e.total} vs ${esperado}`);
check('y el flete es el del PDF (396,00)', cerca(e.fleteBase, 396), String(e.fleteBase));
check('el desglose no trae renglón de GoGreen',
  !e.extras.some(([n]) => String(n).startsWith('GoGreen')), JSON.stringify(e.extras));
check('a 50 kg el renglón de GoGreen sigue estando',
  a50.extras.some(([n]) => String(n).startsWith('GoGreen')), JSON.stringify(a50.extras.map(x => x[0])));

console.log('\n8. Los bordes feos\n');
check('50,5 kg ya es +50', dhl('Brasil', 50.5).tarifa50 === true);
check('50,0 kg exacto todavía no', dhl('Brasil', 50).tarifa50 === false);
check('un peso enorme no rompe', dhl('Brasil', 1000).total > 0);
check('el flete nunca baja al subir el peso', (() => {
  for (let z = 1; z <= 6; z++) {
    let ant = 0;
    for (let kg = 51; kg <= 300; kg++) { const v = getDHLE50(z, kg); if (v < ant) return false; ant = v; }
  }
  return true;
})());

console.log('\n' + '─'.repeat(60));
console.log(`${ok} pasaron · ${fail} fallaron`);
process.exit(fail === 0 ? 0 : 1);
