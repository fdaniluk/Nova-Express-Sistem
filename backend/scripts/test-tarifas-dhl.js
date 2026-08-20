#!/usr/bin/env node
/**
 * test-tarifas-dhl.js — fija las tarifas de DHL contra el PDF oficial 2026.
 *
 * Los valores de abajo están copiados a mano del tarifario. Si alguien toca el motor y
 * un número deja de coincidir, esta prueba lo caza antes de que salga una cotización mal.
 *
 * El foco está en los bordes, que es donde estaba el error: el salto de 70 a 71 kg en
 * exportación se iba 10 USD para arriba porque la fórmula aplicaba la tarifa del tramo
 * alto a todo el excedente sobre 30 kg en vez de acumular tramo por tramo.
 *
 *   cd backend && npm run test-tarifas-dhl
 */

const core = require('../../shared/cotizador/cotizador-core.js');

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const cerca = (a, b) => Math.abs(a - b) <= 0.005;

// [peso, zona1..zona6] — copiados del PDF oficial DHL 2026
const OFICIAL = {
  E_PKG: [
    [0.5, 24.91, 26.35, 28.43, 37.05, 42.79, 47.02],
    [10, 71.32, 81.44, 89.21, 119.5, 135.95, 150.12],
    [10.5, 73.07, 83.22, 91.29, 122.02, 139.12, 153.63],
    [11, 74.82, 84.99, 93.38, 124.55, 142.3, 157.14],
    [20, 106.32, 117, 130.93, 170.04, 199.37, 220.26],
    [20.5, 108.1, 119.2, 133.41, 173.21, 203, 224.25],
    [30, 141.88, 161.1, 180.49, 233.6, 271.89, 300.06],
    [50, 216.92, 255.74, 286.75, 365.76, 424.49, 467.78],
    [69, 288.21, 345.65, 387.69, 491.31, 569.46, 627.12],
    [70, 291.96, 350.38, 393.01, 497.92, 577.09, 635.5],
    [71, 295.79, 355.24, 398.57, 504.69, 584.91, 644.05],
    [100, 406.83, 496.12, 559.96, 700.99, 811.45, 891.91],
    [200, 789.73, 981.92, 1116.46, 1377.89, 1592.65, 1746.61],
    [299, 1168.8, 1462.86, 1667.39, 2048.02, 2366.04, 2592.76],
    [300, 1172.63, 1467.72, 1672.96, 2054.79, 2373.85, 2601.31],
  ],
  I_PKG: [
    [0.5, 30.9, 35.77, 39.42, 52.79, 64.67, 75.24],
    [10, 80, 110.82, 136.8, 184.8, 227.12, 269.35],
    [10.5, 82.32, 113.86, 140.23, 188.92, 233.3, 276.81],
    [11, 84.64, 116.9, 143.66, 193.03, 239.47, 284.26],
    [20, 126.34, 171.58, 205.4, 267.12, 350.6, 418.45],
    [30, 172.68, 232.34, 274, 349.44, 474.08, 567.55],
    [40, 220.07, 293.66, 346.1, 440.58, 599.52, 721.69],
    [49, 262.72, 348.85, 410.99, 522.61, 712.42, 860.42],
    [50, 267.46, 354.98, 418.2, 531.72, 724.96, 875.83],
  ],
  E_DOC: [
    [0.5, 15.87, 16.34, 17.63, 24.23, 29.15, 32.39],
    [2, 30.16, 34.38, 37.54, 45.16, 46.01, 51.72],
  ],
  I_DOC: [
    [0.5, 19.96, 24.28, 28.88, 36.57, 48.97, 55.75],
    [2, 33.42, 41.27, 51.7, 59.74, 76.15, 83.25],
  ],
};

const TABLA = {
  E_PKG: core.DHL_E_PKG, I_PKG: core.DHL_I_PKG,
  E_DOC: core.DHL_E_DOC, I_DOC: core.DHL_I_DOC,
};

for (const [nombre, filas] of Object.entries(OFICIAL)) {
  console.log(`\n${nombre} — contra el PDF oficial\n`);
  let malas = 0, celdas = 0;
  for (const fila of filas) {
    const pf = fila[0];
    for (let z = 1; z <= 6; z++) {
      celdas++;
      const obtenido = core.getDHL(TABLA[nombre], z, pf);
      if (!cerca(obtenido, fila[z])) {
        malas++;
        if (malas <= 5) console.log(`      ${pf} kg zona ${z}: PDF ${fila[z]} · sistema ${Number(obtenido).toFixed(2)}`);
      }
    }
  }
  check(`las ${celdas} celdas coinciden`, malas === 0, `${malas} difieren`);
}

// ── El salto de 70 a 71 kg, que es donde estaba el error ────────────────────
console.log('\nEl borde de los 70 kg en exportación\n');

for (let z = 1; z <= 6; z++) {
  const a = core.getDHL(core.DHL_E_PKG, z, 70);
  const b = core.getDHL(core.DHL_E_PKG, z, 71);
  const salto = b - a;
  // el tarifario sube ~1 kg de tarifa entre 70 y 71: nunca más de 10 USD
  check(`zona ${z}: de 70 a 71 kg sube ${salto.toFixed(2)} y no un escalón`,
    salto > 0 && salto < 10, `${a.toFixed(2)} → ${b.toFixed(2)}`);
}

// ── Redondeo y extrapolación ────────────────────────────────────────────────
console.log('\nRedondeo y pesos fuera de tabla\n');

check('un peso intermedio toma la fila de arriba (10.2 kg = 10.5 kg)',
  cerca(core.getDHL(core.DHL_E_PKG, 1, 10.2), 73.07),
  String(core.getDHL(core.DHL_E_PKG, 1, 10.2)));
check('70.4 kg toma la fila de 70.5, no la de 70',
  core.getDHL(core.DHL_E_PKG, 1, 70.4) > core.getDHL(core.DHL_E_PKG, 1, 70));
check('arriba de 300 kg extrapola con el valor por kilo (301 kg zona 1)',
  cerca(core.getDHL(core.DHL_E_PKG, 1, 301), 1172.63 + 4.27),
  String(core.getDHL(core.DHL_E_PKG, 1, 301)));
check('la tarifa siempre sube con el peso (de 10 a 300 kg, zona 3)', (() => {
  let prev = 0;
  for (let p = 10; p <= 300; p += 0.5) {
    const v = core.getDHL(core.DHL_E_PKG, 3, p);
    if (v < prev) return false;
    prev = v;
  }
  return true;
})());

// ── Importación arriba de 50 kg: manda la tabla especial ────────────────────
console.log('\nImportación arriba de 50 kg\n');

check('un envío de importación de 60 kg usa la tabla especial, no la común', (() => {
  const r = core.cotizarServicio('DHL', {
    pais: 'Estados Unidos', tipo: 'import', pf: 60, fob: 0, fuelPct: 0, profitPct: 0, bultosProc: [],
  });
  // ojo: la zona la resuelve el motor desde el país, no es siempre la 1
  return cerca(r.fleteBase, core.getDHLBig(r.zona, 60));
})());

// ── Los mapas de zonas cubren los mismos países ─────────────────────────────
// El 15/08/2026 la oficina quiso cotizar una impo desde Bélgica: UPS cotizaba y DHL decía
// que el país no existía. Bélgica NO ESTABA en el mapa de DHL ni en el de UPS expo — y
// nadie lo notó en meses porque nunca antes se había cotizado a Bélgica. Este bloque
// existe para que un país que le falte a UN mapa no vuelva a esperar a que un cliente
// lo pida: todo país de los mapas de UPS tiene que resolver también en DHL (al revés no:
// hay islas que DHL sirve y UPS no lista, y eso es legítimo del tarifario de UPS).
console.log('\nLos mapas de zonas cubren los mismos países\n');

check('Bélgica resuelve en DHL (impo y expo), zona 4',
  core.resolverZona('Bélgica', 'DHL', 'import') === 4
  && core.resolverZona('Bélgica', 'DHL', 'export') === 4);
check('Bélgica resuelve en UPS exportación, zona 4',
  core.resolverZona('Bélgica', 'UPS_EXP', 'export') === 4);
check('Bélgica resuelve en UPS importación (zona 5, como siempre)',
  core.resolverZona('Bélgica', 'UPS_EXP', 'import') === 5);
check('una impo desde Bélgica cotiza por DHL de verdad (no null)', (() => {
  const r = core.cotizarServicio('DHL', {
    pais: 'Bélgica', tipo: 'import', pf: 5, fob: 0, fuelPct: 0, profitPct: 0, bultosProc: [],
  });
  return r !== null && r.total > 0;
})());

// El mismo país con el nombre del otro mapa: los alias del 15/08.
check('"Antigua y Barbuda" (nombre UPS) resuelve en DHL',
  core.resolverZona('Antigua y Barbuda', 'DHL', 'export') === 2);
check('"Antigua" (nombre DHL) resuelve en UPS',
  core.resolverZona('Antigua', 'UPS_EXP', 'export') === 3);
check('"Guyana Francesa" y "Guayana Francesa" resuelven en los dos couriers',
  core.resolverZona('Guyana Francesa', 'DHL', 'export') === 2
  && core.resolverZona('Guayana Francesa', 'UPS_EXP', 'export') === 3);

check('NINGÚN país de los mapas de UPS falta en el de DHL', (() => {
  const faltan = [...new Set([...Object.keys(core.ZONAS_UPS), ...Object.keys(core.ZONAS_UPS_I)])]
    .filter((p) => core.ZONAS_DHL[p] === undefined);
  if (faltan.length) console.log('      faltan en DHL: ' + faltan.join(', '));
  return faltan.length === 0;
})());

// La Guayana Francesa se escribe de dos formas y cada courier usa la suya. Las dos tienen
// que resolver en los DOS mapas: el desplegable ofrece la de DHL ("Guyana Francesa") y sin
// esto cotizar por UPS fallaba con "ese país no existe" (encontrado el 20/08/2026).
check('las dos grafías de la Guayana Francesa resuelven en DHL y en UPS', (() => {
  for (const g of ['Guyana Francesa', 'Guayana Francesa']) {
    if (core.ZONAS_DHL[g] === undefined) return false;
    if (core.ZONAS_UPS[g] === undefined) return false;
    if (core.ZONAS_UPS_I[g] === undefined) return false;
  }
  return true;
})());

// CANARIO. Al revés que el chequeo de arriba: hay países que están en DHL y NO en UPS, y
// eso es legítimo — UPS no presta servicio a Cuba, Irán o Somalia, y a varias islas
// diminutas. Pero si la lista CRECE es que alguien agregó un destino a DHL y se olvidó de
// UPS, que es exactamente cómo nacieron el error de Bélgica y el de la Guayana Francesa.
// Si este test se pone rojo: agregá el país al mapa de UPS, o —si UPS realmente no lo
// lleva— sumalo a esta lista a conciencia.
const SOLO_DHL = [
  'Cabo Verde', 'Camboya', 'Camerún', 'Chad', 'Ciudad del Vaticano', 'Cuba', 'Groenlandia',
  'Guinea Ecuatorial', 'Irán', 'Isla de Reunión', 'Isla Malvinas', 'Islas Cook',
  'Islas Marshall', 'Islas Salomón', 'Jersey', 'Kiribati', 'Kosovo', 'Myanmar', 'Niue',
  'Palau', 'Samoa', 'San Eustaquio', 'Somalia', 'Sudán del Sur', 'Tonga', 'Tuvalu',
];
check(`los países que DHL lleva y UPS no siguen siendo los ${SOLO_DHL.length} conocidos`, (() => {
  const hoy = Object.keys(core.ZONAS_DHL).filter((p) => core.ZONAS_UPS[p] === undefined).sort();
  const nuevos = hoy.filter((p) => !SOLO_DHL.includes(p));
  const idos = SOLO_DHL.filter((p) => !hoy.includes(p));
  if (nuevos.length) console.log('      NUEVOS sin zona UPS (¿falta cargarlos?): ' + nuevos.join(', '));
  if (idos.length) console.log('      ya no están: ' + idos.join(', '));
  return nuevos.length === 0 && idos.length === 0;
})());

console.log('\n' + '─'.repeat(60));
console.log(`${ok} pasaron · ${fail} fallaron`);
process.exit(fail === 0 ? 0 : 1);
