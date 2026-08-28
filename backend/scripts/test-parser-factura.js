#!/usr/bin/env node
/**
 * test-parser-factura.js — pruebas del parser de facturas de UPS.
 *
 * Corre contra la factura real de `facturas-ejemplo/` y contra escenarios simulados
 * (cambios de formato de UPS) para verificar que el parser FALLA RUIDOSAMENTE en vez
 * de cargar números incorrectos en silencio.
 *
 *   cd backend && node scripts/test-parser-factura.js
 *
 * Sale con código 0 si pasan todas, 1 si falla alguna.
 */

const fs = require('fs');
const path = require('path');
const { extraerFacturaUPS, parseImporte } = require('../src/services/factura-ups.service');

const PDF = path.join(__dirname, '..', '..', 'facturas-ejemplo', 'factura_test_ups.pdf');

let ok = 0;
let fail = 0;

function check(nombre, condicion, detalle = '') {
  if (condicion) {
    ok++;
    console.log(`  ✓ ${nombre}`);
  } else {
    fail++;
    console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`);
  }
}

// ── 1. parseImporte: los dos formatos ───────────────────────────────────────

function testParseImporte() {
  console.log('\n1. parseImporte — formato argentino y formato con punto decimal\n');
  const casos = [
    ['1,292,50', 1292.5],
    ['1.292,50', 1292.5],
    ['1,292.50', 1292.5],
    ['13,180,40', 13180.4],
    ['215,34', 215.34],
    ['120.10', 120.1],   // ← el que antes daba 12010
    ['27.65', 27.65],    // ← el que antes daba 2765
    ['-2,50', -2.5],
    ['0,00', 0],
    ['3,159,55', 3159.55],
    ['1.292', 1292],     // 3 dígitos tras el separador → miles
    ['26.00', 26],
    ['500', 500],
  ];
  for (const [entrada, esperado] of casos) {
    const r = parseImporte(entrada);
    check(`"${entrada}" → ${esperado}`, r === esperado, `dio ${r}`);
  }

  console.log('\n   Entradas inválidas → null (antes devolvían 0 en silencio):\n');
  for (const malo of ['abc', '', null, undefined, '12,3456', 'USD 5']) {
    const r = parseImporte(malo);
    check(`${JSON.stringify(malo)} → null`, r === null, `dio ${r}`);
  }
}

// ── 2. La factura real ──────────────────────────────────────────────────────

async function testFacturaReal() {
  console.log('\n2. Factura real (0020-00074402)\n');
  const r = await extraerFacturaUPS(fs.readFileSync(PDF));

  check('lee el número de factura', r.numero_factura === '0020-00074402', r.numero_factura);
  check('lee la fecha', r.fecha_factura === '31/05/2026', r.fecha_factura);
  check('detecta 10 guías', r.guias.length === 10, `detectó ${r.guias.length}`);
  check('ninguna guía sin costo', r.guias.every((g) => g.costo_total != null));
  check('suma de guías (sin percepción) = 3068.33', r.suma_guias === 3068.33, `dio ${r.suma_guias}`);

  // Lo importante: ahora LEE el total del PDF en vez de tenerlo hardcodeado.
  check('lee el total declarado del PDF', r.total_declarado === 3159.55, `dio ${r.total_declarado}`);
  check('lee el subtotal del pie de la factura', r.subtotal_factura === 3068.33, `dio ${r.subtotal_factura}`);
  check('la diferencia es 91.22 (percepción IIBB)', r.diferencia === 91.22, `dio ${r.diferencia}`);

  console.log(`\n   suma guías ${r.suma_guias} · total PDF ${r.total_declarado} · dif ${r.diferencia}`);
  console.log(`   advertencias: ${r.advertencias.length}`);
  for (const a of r.advertencias) console.log(`     · [${a.tipo}] ${a.guia || ''}`);
  return r;
}

// ── 2-bis. Percepción de Ingresos Brutos ────────────────────────────────────
//
// Decisión de negocio del 29/07: la percepción ES COSTO del envío. Se reparte entre las
// guías proporcional a lo que costó cada una.
//
// La prueba que más importa es la última: si la suma de las guías NO cuadra con el
// subtotal del pie, la diferencia no es percepción sino una guía que no se leyó, y
// repartirla ensuciaría el costo de TODOS los envíos de la factura.

async function testPercepcion() {
  console.log('\n2-bis. Percepción de Ingresos Brutos repartida entre las guías\n');
  const r = await extraerFacturaUPS(fs.readFileSync(PDF));
  const conCosto = r.guias.filter((g) => g.costo_total != null);

  check('reparte la percepción', r.percepciones_repartidas === true);
  check('la percepción es 91.22', r.percepciones === 91.22, `dio ${r.percepciones}`);
  check('avisa que la repartió', r.advertencias.some((a) => a.tipo === 'percepcion_repartida'));
  check('ya no avisa de descuadre', !r.advertencias.some((a) => a.tipo === 'total_no_cuadra'));

  check('todas las guías tienen su parte de percepción',
    conCosto.every((g) => typeof g.percepcion === 'number'));

  // el reparto tiene que dar EXACTO, sin centavos perdidos
  const sumaPerc = Math.round(conCosto.reduce((s, g) => s + g.percepcion, 0) * 100) / 100;
  check('las partes suman exactamente la percepción', sumaPerc === 91.22, `sumaron ${sumaPerc}`);

  check('la suma final de las guías da el total de la factura',
    Math.abs(r.suma_guias_final - r.total_declarado) < 0.005,
    `${r.suma_guias_final} vs ${r.total_declarado}`);

  // proporcionalidad: la guía más cara se lleva la parte más grande
  const orden = [...conCosto].sort((a, b) => b.costo_total - a.costo_total);
  check('la guía más cara se lleva la mayor parte de la percepción',
    orden[0].percepcion >= orden[orden.length - 1].percepcion,
    `${orden[0].percepcion} vs ${orden[orden.length - 1].percepcion}`);

  console.log(`\n   ${conCosto.length} guías · percepción ${r.percepciones} · suma final ${r.suma_guias_final}`);

  // ── el caso peligroso ─────────────────────────────────────────────────────
  console.log('\n   Si falta una guía, NO se reparte nada:\n');
  const original = fs.readFileSync(PDF);
  const pdfParse = require('pdf-parse');
  const real = await pdfParse(original);
  // se rompe el importe de una guía para que la suma no cuadre contra el subtotal
  const texto = real.text.replace('       199,10      -177,20        77,25       -68,67', '');
  const mod = { ...real, text: texto };
  const cache = require.cache[require.resolve('pdf-parse')];
  const orig = cache.exports;
  cache.exports = async () => mod;
  delete require.cache[require.resolve('../src/services/factura-ups.service.js')];
  const svc = require('../src/services/factura-ups.service.js');
  const roto = await svc.extraerFacturaUPS(original);
  cache.exports = orig;
  delete require.cache[require.resolve('../src/services/factura-ups.service.js')];

  check('con una guía ilegible NO reparte percepción', roto.percepciones_repartidas === false,
    `repartidas=${roto.percepciones_repartidas}`);
  check('y avisa del descuadre en vez de ensuciar los costos',
    roto.advertencias.some((a) => a.tipo === 'total_no_cuadra'));
}

// ── 3. Escenarios de cambio de formato de UPS ───────────────────────────────
//
// Se parchea pdf-parse en caliente para inyectar texto modificado y ver cómo
// reacciona el parser sin depender de fabricar un PDF.

async function conTextoModificado(transform) {
  const pdfParse = require('pdf-parse');
  const real = await pdfParse(fs.readFileSync(PDF));
  const texto = transform(real.text);

  const key = require.resolve('pdf-parse');
  const original = require.cache[key].exports;
  require.cache[key].exports = async () => ({ text: texto });
  delete require.cache[require.resolve('../src/services/factura-ups.service')];
  const svc = require('../src/services/factura-ups.service');
  try {
    return await svc.extraerFacturaUPS(Buffer.from(''));
  } finally {
    require.cache[key].exports = original;
    delete require.cache[require.resolve('../src/services/factura-ups.service')];
  }
}

// La línea de componentes no siempre trae cuatro importes: cuando la guía tiene
// UNA sola tarifa trae dos ("642,90  -572,18"). Caso REAL: facturas 0020-00075133
// y 0020-00075129 (28/08/2026) — el parser viejo exigía cuatro, dejaba esas guías
// sin neto y, de rebote, la factura ENTERA sin percepciones repartidas (el reparto
// exige que la suma cuadre). Este test convierte todas las líneas a dos importes y
// exige que nada se pierda: el neto viene de su propia línea, no de las columnas.
async function testColumnasDeDos() {
  console.log('\n3. Guía con una sola tarifa: línea de componentes de DOS importes (caso real 75133/75129)\n');
  const base = await extraerFacturaUPS(fs.readFileSync(PDF));
  const r = await conTextoModificado((t) =>
    t.replace(/^(\s*-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)\s*$/gm, '$1 $2')
  );

  check('ninguna guía queda sin neto', r.guias.every((g) => g.neto != null),
    `sin neto: ${r.guias.filter((g) => g.neto == null).map((g) => g.numero_guia).join(', ')}`);
  check('detecta las mismas guías que la factura intacta', r.guias.length === base.guias.length,
    `${r.guias.length} vs ${base.guias.length}`);
  check('la suma de guías no cambia', r.suma_guias === base.suma_guias,
    `${r.suma_guias} vs ${base.suma_guias}`);
  check('las percepciones se siguen repartiendo',
    r.percepciones_repartidas === base.percepciones_repartidas,
    `repartidas=${r.percepciones_repartidas}`);
  check('sin advertencia sin_neto', !r.advertencias.some((a) => a.tipo === 'sin_neto'));
}

// El caso defensivo de siempre: si la línea de componentes desaparece del todo,
// el parser tiene que fallar RUIDOSAMENTE (guía sin costo + advertencia), nunca
// degradar a 0 ni repartir percepciones sobre una suma que no cuadra.
async function testUpsCambiaColumnas() {
  console.log('\n3-bis. La línea de componentes desaparece del todo\n');
  const r = await conTextoModificado((t) =>
    t.replace(/^(\s*-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)\s*$/gm, '')
  );

  const sinCosto = r.guias.filter((g) => g.costo_total == null).length;
  check('NO reporta las guías con costo 0', r.suma_guias === 0 ? sinCosto > 0 : true);
  check(
    'avisa que no pudo leer el neto',
    r.advertencias.some((a) => a.tipo === 'sin_neto'),
    'no hubo advertencia sin_neto'
  );
  check('las guías afectadas quedan con costo_total null, no 0', sinCosto > 0, `sinCosto=${sinCosto}`);
  check('con el descuadre NO reparte percepciones', r.percepciones_repartidas === false,
    `repartidas=${r.percepciones_repartidas}`);
  console.log(`   guías sin costo calculable: ${sinCosto} de ${r.guias.length}`);
  console.log(`   suma: ${r.suma_guias} · advertencias: ${r.advertencias.length}`);
}

// Devuelve [inicio, fin) del bloque COMPLETO de una guía: desde su línea de tracking
// hasta justo antes de la siguiente. Duplicar un bloque parcial haría que la primera
// copia pierda sus cargos y las dos difieran por construcción, no por el parser.
function bloqueDeGuia(lines, guia) {
  const esTracking = (l) => /^1Z\w+\s+[\d.,]+Kg\s/.test(l.trim());
  const inicio = lines.findIndex((l) => l.trim().startsWith(guia));
  if (inicio === -1) throw new Error(`no se encontró la guía ${guia}`);
  let fin = inicio + 1;
  while (fin < lines.length && !esTracking(lines[fin])) fin++;
  return [inicio, fin];
}

async function testGuiaRefacturada() {
  console.log('\n4. UPS re-factura una guía (misma guía, importe distinto)\n');
  const r = await conTextoModificado((t) => {
    const lines = t.split('\n');
    const [ini, fin] = bloqueDeGuia(lines, '1Z327W096790199567');
    const bloque = lines.slice(ini, fin).slice();
    // Se cambia el neto de la copia: es una re-facturación, no un artefacto.
    const netoIdx = bloque.findIndex((l, k) => k > 1 && /^\s*-?[\d.,]+\s*$/.test(l));
    if (netoIdx !== -1) bloque[netoIdx] = '159,99';
    return [...lines.slice(0, fin), ...bloque, ...lines.slice(fin)].join('\n');
  });

  check(
    'avisa de la guía re-facturada',
    r.advertencias.some((a) => a.tipo === 'guia_refacturada'),
    'no avisó'
  );
  const adv = r.advertencias.find((a) => a.tipo === 'guia_refacturada');
  if (adv) console.log(`   ${adv.guia} · montos vistos: ${JSON.stringify(adv.montos)}`);
}

async function testGuiaPaginada() {
  console.log('\n5. La misma guía repetida IDÉNTICA (artefacto de paginado)\n');
  const r = await conTextoModificado((t) => {
    const lines = t.split('\n');
    const [ini, fin] = bloqueDeGuia(lines, '1Z327W096790199567');
    return [...lines.slice(0, fin), ...lines.slice(ini, fin), ...lines.slice(fin)].join('\n');
  });

  check(
    'deduplica sin molestar',
    !r.advertencias.some((a) => a.tipo === 'guia_refacturada'),
    JSON.stringify(r.advertencias.find((a) => a.tipo === 'guia_refacturada')?.montos)
  );
  check('sigue detectando 10 guías', r.guias.length === 10, `detectó ${r.guias.length}`);
  check('la suma no cambia', r.suma_guias === 3068.33, `dio ${r.suma_guias}`);
}

// ── main ────────────────────────────────────────────────────────────────────

(async () => {
  if (!fs.existsSync(PDF)) {
    console.error(`✗ No se encontró la factura de ejemplo: ${PDF}`);
    process.exit(1);
  }

  testParseImporte();
  await testFacturaReal();
  await testPercepcion();
  await testColumnasDeDos();
  await testUpsCambiaColumnas();
  await testGuiaRefacturada();
  await testGuiaPaginada();

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('✗ Error inesperado:', e);
  process.exit(1);
});
