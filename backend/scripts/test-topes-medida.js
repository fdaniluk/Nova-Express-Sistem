#!/usr/bin/env node
/**
 * test-topes-medida.js — los topes de aceptación de UPS y DHL (deuda 29).
 *
 * De dónde salió: el caso "alfombras a Australia" del 27/08/2026. Una alfombra de 2,80 m
 * pasaba el cotizador entera, se cotizaba, se pasaba el precio — y UPS no toma piezas con
 * el lado más largo de más de 274 cm. El precio salía perfecto para un envío que no viaja.
 *
 * La regla que cuida esta tanda: los topes AVISAN, NO FRENAN. El total tiene que dar
 * exactamente lo mismo con y sin aviso; lo único que cambia es que aparece el renglón.
 * Si algún día alguien hace que el tope mueva un centavo, esto se pone rojo.
 *
 *   cd backend && node scripts/test-topes-medida.js
 */

const { calcTopesPieza, cotizarServicio, TOPES_PIEZA } = require('../../shared/cotizador/cotizador-core');

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const texto = (arr) => (arr || []).join(' | ');
const bulto = (l, a, al, pr) => ({ dims: [l, a, al].sort((x, y) => y - x), pr, pf: Math.max(pr, (l * a * al) / 5000) });

console.log('\n1. Los números del tarifario\n');
check('UPS: lado 274, contorno 400, 70 kg por pieza',
  TOPES_PIEZA.UPS.lado === 274 && TOPES_PIEZA.UPS.contorno === 400 && TOPES_PIEZA.UPS.peso === 70,
  JSON.stringify(TOPES_PIEZA.UPS));
check('DHL: pieza de 120 × 80', TOPES_PIEZA.DHL.lado === 120 && TOPES_PIEZA.DHL.segundo === 80,
  JSON.stringify(TOPES_PIEZA.DHL));

console.log('\n2. La alfombra de 2,80 m (el caso real)\n');
let t = calcTopesPieza([bulto(280, 60, 20, 30)]);
check('UPS avisa por el lado largo', /274 cm/.test(texto(t.ups)), texto(t.ups));
check('y dice cuánto mide el bulto más grande', /280 cm/.test(texto(t.ups)), texto(t.ups));
check('DHL también avisa: 280 pasa su pieza de 120', /120 × 80 × 80/.test(texto(t.dhl)), texto(t.dhl));

console.log('\n3. Cada tope por separado\n');
// Dims flacas a propósito: con 40×30 el contorno se va a 414 y salta el OTRO tope.
check('un bulto de 274 justos NO avisa (el tope es "más de")',
  calcTopesPieza([bulto(274, 20, 15, 45)]).ups.length === 0,
  texto(calcTopesPieza([bulto(274, 20, 15, 45)]).ups));
check('275 sí avisa', /274 cm/.test(texto(calcTopesPieza([bulto(275, 20, 15, 45)]).ups)));
check('70 kg reales justos NO avisan', !/70 kg/.test(texto(calcTopesPieza([bulto(50, 40, 30, 70)]).ups)));
check('70,5 kg sí avisa', /70 kg/.test(texto(calcTopesPieza([bulto(50, 40, 30, 70.5)]).ups)));
check('el contorno de 400 sigue avisando como siempre',
  /contorno máximo de 400/.test(texto(calcTopesPieza([bulto(150, 90, 90, 20)]).ups)),
  texto(calcTopesPieza([bulto(150, 90, 90, 20)]).ups));
check('DHL: 120 × 80 × 80 justos NO avisan', calcTopesPieza([bulto(120, 80, 80, 10)]).dhl.length === 0);
check('DHL: 121 de lado sí avisa', calcTopesPieza([bulto(121, 80, 80, 10)]).dhl.length === 1);
check('DHL: 81 en el segundo lado también', calcTopesPieza([bulto(100, 81, 60, 10)]).dhl.length === 1);

console.log('\n4. El peso NO es tope en DHL (arriba de 70 kg lo toma y cobra 125)\n');
t = calcTopesPieza([bulto(60, 40, 40, 90)]);
check('DHL no avisa por peso', t.dhl.length === 0, texto(t.dhl));
check('UPS sí: 90 kg pasa su tope de 70', /70 kg/.test(texto(t.ups)), texto(t.ups));
const rDHL = cotizarServicio('DHL', { pais: 'Australia', pf: 90, fob: 400, fuelPct: 37, profitPct: 50, bultosProc: [bulto(60, 40, 40, 90)] });
check('y el sobrepeso de 125 se sigue cobrando', rDHL.sobrepesoTotal === 125, String(rDHL.sobrepesoTotal));

console.log('\n5. Un bulto normal no dispara nada\n');
t = calcTopesPieza([bulto(60, 40, 30, 15)]);
check('sin avisos en UPS', t.ups.length === 0, texto(t.ups));
check('sin avisos en DHL', t.dhl.length === 0, texto(t.dhl));

console.log('\n6. Se agrupa por regla, no por bulto\n');
const tres = [bulto(280, 60, 20, 30), bulto(300, 50, 20, 30), bulto(60, 40, 30, 10)];
t = calcTopesPieza(tres);
check('tres bultos, dos fuera de tope → UN solo renglón', t.ups.filter((m) => /274 cm/.test(m)).length === 1, texto(t.ups));
check('y dice "2 bultos"', /2 bultos/.test(texto(t.ups)), texto(t.ups));
check('con el más grande de los dos (300 cm)', /300 cm/.test(texto(t.ups)), texto(t.ups));
check('con uno solo dice "1 bulto", en singular', /1 bulto /.test(texto(calcTopesPieza([bulto(280, 60, 20, 30)]).ups)));

console.log('\n7. AVISAN, NO FRENAN: el precio no se mueve ni un centavo\n');
// El mismo bulto con UN centímetro de diferencia: 274 no avisa, 275 sí. Las dos medidas
// caen del mismo lado de todos los umbrales que SÍ cobran (contorno entre 300 y 400 →
// paquete de mayor tamaño en los dos; 45 kg reales → ninguno necesita el mínimo de 40).
// Así que si el total no da igual, es que el aviso está tocando la plata.
const base = { pais: 'Australia', tipo: 'export', pf: 45, fob: 400, fuelPct: 37, profitPct: 50 };
const conAviso = cotizarServicio('UPS_EXP', { ...base, bultosProc: [bulto(275, 20, 15, 45)] });
const sinAviso = cotizarServicio('UPS_EXP', { ...base, bultosProc: [bulto(274, 20, 15, 45)] });
check('el de 275 trae el aviso', (conAviso.avisosTope || []).length === 1, texto(conAviso.avisosTope));
check('el de 274 no trae ninguno', (sinAviso.avisosTope || []).length === 0, texto(sinAviso.avisosTope));
check('el flete de tabla es el mismo', conAviso.fleteBase === sinAviso.fleteBase,
  `${conAviso.fleteBase} vs ${sinAviso.fleteBase}`);
check('el peso facturable es el mismo', conAviso.pf === sinAviso.pf, `${conAviso.pf} vs ${sinAviso.pf}`);
check('los recargos son los mismos', JSON.stringify(conAviso.extras) === JSON.stringify(sinAviso.extras),
  JSON.stringify(conAviso.extras));
check('y el total es idéntico', Math.abs(conAviso.total - sinAviso.total) < 0.005,
  `${conAviso.total.toFixed(2)} vs ${sinAviso.total.toFixed(2)}`);
check('ningún renglón de recargo menciona el tope',
  !conAviso.extras.some((e) => /274|tope|acepta/i.test(String(e[0]))), JSON.stringify(conAviso.extras));

// Lo mismo en DHL: 120 no avisa, 121 sí, y ninguno de los dos cruza el 100 del extracargo
// por dimensión... salvo que los dos lo cruzan igual, que es justamente lo que se controla.
const dhlCon = cotizarServicio('DHL', { ...base, bultosProc: [bulto(121, 79, 60, 45)] });
const dhlSin = cotizarServicio('DHL', { ...base, bultosProc: [bulto(120, 79, 60, 45)] });
check('en DHL el de 121 avisa y el de 120 no',
  (dhlCon.avisosTope || []).length === 1 && (dhlSin.avisosTope || []).length === 0,
  texto(dhlCon.avisosTope) + ' // ' + texto(dhlSin.avisosTope));
check('y el total de DHL no cambia por el aviso', Math.abs(dhlCon.total - dhlSin.total) < 0.005,
  `${dhlCon.total.toFixed(2)} vs ${dhlSin.total.toFixed(2)}`);

console.log('\n8. Los bordes\n');
check('sin bultos no rompe', calcTopesPieza([]).ups.length === 0 && calcTopesPieza([]).dhl.length === 0);
check('con undefined tampoco', calcTopesPieza(undefined).ups.length === 0);
check('el motor siempre devuelve la lista, aunque esté vacía',
  Array.isArray(cotizarServicio('UPS_EXP', { ...base, bultosProc: [bulto(60, 40, 30, 15)] }).avisosTope));
check('y en DHL también',
  Array.isArray(cotizarServicio('DHL', { ...base, bultosProc: [bulto(60, 40, 30, 15)] }).avisosTope));

console.log('\n' + '─'.repeat(60));
console.log(`${ok} pasaron · ${fail} fallaron`);
process.exit(fail === 0 ? 0 : 1);
