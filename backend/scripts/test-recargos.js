#!/usr/bin/env node
/**
 * test-recargos.js — verifica los recargos de UPS y DHL contra los tarifarios oficiales.
 *
 * Fuentes:
 *   · UPS Guía de Tarifas y Servicios Argentina 2026 (vigente 21-dic-2025)
 *   · UPS Cargo Extraordinario por Incremento de Volumen (surge), vigente 24-may-2026
 *   · UPS International Processing Fee, vigente 8-sep-2025
 *   · DHL — Servicios opcionales y recargos (mydhl.express.dhl)
 *
 *   cd backend && npm run test-recargos
 */

const core = require('../../shared/cotizador/cotizador-core.js');

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const cerca = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;

// ── 1. Surge fee ────────────────────────────────────────────────────────────
console.log('\n1. Surge fee UPS (USD por kg de peso facturable)\n');

const surge = (pais, tipo) => core.getSurge(pais, tipo, 1);

check('export ISMEA (Egipto) = 2.95', cerca(surge('Egipto', 'export'), 2.95), surge('Egipto', 'export'));
check('export Israel = 3.30', cerca(surge('Israel', 'export'), 3.30), surge('Israel', 'export'));
check('export E.A.U. = 3.30', cerca(surge('Emiratos Árabes Unidos', 'export'), 3.30));
check('export EE.UU. = 0.50', cerca(surge('Estados Unidos', 'export'), 0.50));
check('export India = 0.50 (India solo tiene fila en importación)',
  cerca(surge('India', 'export'), 0.50), surge('India', 'export'));

check('import ISMEA (Pakistán) = 2.95', cerca(surge('Pakistán', 'import'), 2.95));
check('import E.A.U. = 3.30', cerca(surge('Emiratos Árabes Unidos', 'import'), 3.30));
check('import India = 1.45', cerca(surge('India', 'import'), 1.45));
check('import China = 0.70', cerca(surge('China', 'import'), 0.70), surge('China', 'import'));
check('import Hong Kong = 0.70', cerca(surge('Hong Kong', 'import'), 0.70));
check('import Macao = 0.70', cerca(surge('Macao', 'import'), 0.70));
check('import resto del mundo = 0.50', cerca(surge('Brasil', 'import'), 0.50));

// UPS eliminó el surge de las importaciones desde Israel el 24-may-2026
check('import Israel = 0.50 (UPS lo eliminó en mayo 2026)',
  cerca(surge('Israel', 'import'), 0.50), surge('Israel', 'import'));

// ISMEA es taxativo: los 14 del comunicado, ni uno más
const ISMEA_OFICIAL = ['Afganistán', 'Arabia Saudita', 'Bahréin', 'Bangladesh', 'Egipto',
  'Irak', 'Jordania', 'Kuwait', 'Líbano', 'Nepal', 'Omán', 'Pakistán', 'Qatar', 'Sri Lanka'];
check('ISMEA tiene exactamente los 14 países del comunicado',
  core.ISMEA.size === 14 && ISMEA_OFICIAL.every((p) => core.ISMEA.has(p)),
  `${core.ISMEA.size} países`);

// los que sobraban antes ahora pagan la tarifa común
for (const p of ['Marruecos', 'Kenia', 'Argelia', 'Túnez', 'Georgia', 'Kazajistán', 'Irán']) {
  check(`${p} paga 0.50 y no 2.95`, cerca(surge(p, 'export'), 0.50), surge(p, 'export'));
}
// los que faltaban ahora pagan la cara
for (const p of ['Bangladesh', 'Nepal', 'Sri Lanka']) {
  check(`${p} paga 2.95`, cerca(surge(p, 'export'), 2.95), surge(p, 'export'));
}

// el surge se cobra por kg
check('el surge escala con el peso (10 kg a Egipto = 29.50)',
  cerca(core.getSurge('Egipto', 'export', 10), 29.50));

// ── 2. IPF ──────────────────────────────────────────────────────────────────
console.log('\n2. International Processing Fee (2.50 USD por envío)\n');

const base = { pf: 5, fob: 0, fuelPct: 0, profitPct: 0, bultosProc: [] };
const feeDe = (pais, tipo) => core.cotizarServicio('UPS_EXP', { ...base, pais, tipo }).feeUSA;

check('exportación a EE.UU. paga 2.50', cerca(feeDe('Estados Unidos', 'export'), 2.50));
check('exportación a Canadá NO paga', cerca(feeDe('Canadá', 'export'), 0), feeDe('Canadá', 'export'));
check('exportación a Alemania NO paga', cerca(feeDe('Alemania', 'export'), 0));
check('importación desde EE.UU. NO paga', cerca(feeDe('Estados Unidos', 'import'), 0));

// ── 3. Extras dimensionales UPS ─────────────────────────────────────────────
console.log('\n3. Manejo adicional y Paquete de Mayor Tamaño (UPS)\n');

const bulto = (l, a, h, pr, pf) => ({ dims: [l, a, h].sort((x, y) => y - x), pr, ...(pf !== undefined ? { pf } : {}) });
const dim = (...bs) => core.calcUPSDimExtras(bs);

let r = dim(bulto(50, 40, 30, 30));
check('bulto de 30 kg paga manejo adicional', r.manejoCount === 1);

r = dim(bulto(121, 40, 30, 10));
check('lado de 121 cm NO paga manejo (el umbral es 122)', r.manejoCount === 0, JSON.stringify(r));
r = dim(bulto(123, 40, 30, 10));
check('lado de 123 cm sí paga manejo', r.manejoCount === 1);
// ojo con dos cosas: dims viaja ordenado de mayor a menor (el "segundo lado" es d[1]
// después de ordenar), y el bulto no tiene que disparar Paquete de Mayor Tamaño, porque
// ese anula el manejo. 100×80×10 → segundo lado 80 (>76) y contorno 280 (<300).
r = dim(bulto(100, 80, 10, 10));
check('segundo lado de 80 cm paga manejo', r.manejoCount === 1, JSON.stringify(r));

// contorno = mayor + 2×segundo + 2×menor
r = dim(bulto(140, 60, 40, 10));   // 140 + 120 + 80 = 340 → mayor tamaño
check('contorno de 340 cm cobra Paquete de Mayor Tamaño', cerca(r.contornoExtra, 120.10), r.contornoExtra);
check('y NO cobra manejo adicional además', r.manejoCount === 0, `manejo=${r.manejoCount}`);
// 140×60×40 / 5000 = 67.2 kg volumétrico → ya factura más de 40, no hay nada que sumar
check('si el bulto ya factura más de 40 kg no se suma nada', cerca(r.minPesoExtra, 0), r.minPesoExtra);

// bulto largo y finito: contorno alto pero poco volumen (260×15×12 / 5000 = 9.36 kg)
const VOL_FINITO = 260 * 15 * 12 / 5000;
r = dim(bulto(260, 15, 12, 5));    // 260 + 30 + 24 = 314 → mayor tamaño
check('bulto voluminoso y liviano se lleva al mínimo de 40 kg',
  r.minPesoAplicado === true && cerca(r.minPesoExtra, 40 - VOL_FINITO), r.minPesoExtra);

r = dim(bulto(300, 60, 40, 10));   // 300 + 120 + 80 = 500 → excede el máximo
check('contorno de 500 cm avisa que no se puede enviar', r.contornoWarn === true);
check('y no cobra el recargo de mayor tamaño', cerca(r.contornoExtra, 0));

// El mínimo tiene que llegar a la TARIFA, no quedarse en el cálculo de extras.
// pf del envío = peso facturable del bulto = max(real, volumétrico) = 9.36 kg.
const chico = core.cotizarServicio('UPS_EXP', { ...base, pais: 'Estados Unidos', tipo: 'export',
  pf: VOL_FINITO, bultosProc: [bulto(260, 15, 12, 5)] });
check('el flete se cotiza con el mínimo de 40 kg, no con los 9.36 reales',
  cerca(chico.pf, 40), `pf=${chico.pf}`);

const sinMinimo = core.cotizarServicio('UPS_EXP', { ...base, pais: 'Estados Unidos', tipo: 'export',
  pf: VOL_FINITO, bultosProc: [bulto(60, 40, 30, 9.36)] });
check('y el flete sube de verdad contra el mismo peso sin el mínimo',
  chico.fleteBase > sinMinimo.fleteBase,
  `${sinMinimo.fleteBase.toFixed(2)} → ${chico.fleteBase.toFixed(2)}`);

// ── 4. Recargos DHL ─────────────────────────────────────────────────────────
console.log('\n4. Recargos DHL\n');

const dhl = (...bs) => core.calcDHLExtras(bs);

r = dhl(bulto(50, 40, 30, 80));
check('pieza de más de 70 kg paga sobrepeso (125)', cerca(r.sobrepesoTotal, 125));
check('y no paga pieza no convencional', cerca(r.noConvencionalTotal, 0));

r = dhl(bulto(110, 40, 30, 10));
check('pieza de más de 100 cm paga exceso de tamaño (23)', cerca(r.excesoTotal, 23));
check('y no paga pieza no convencional', cerca(r.noConvencionalTotal, 0));

r = dhl(bulto(50, 40, 30, 30));
check('pieza de 30 kg paga pieza no convencional (23)', cerca(r.noConvencionalTotal, 23), r.noConvencionalTotal);
r = dhl(bulto(50, 40, 30, 24));
check('pieza de 24 kg no paga nada', cerca(r.noConvencionalTotal, 0) && cerca(r.excesoTotal, 0));
r = dhl(bulto(50, 40, 30, 70));
check('pieza de exactamente 70 kg paga no convencional, no sobrepeso',
  cerca(r.noConvencionalTotal, 23) && cerca(r.sobrepesoTotal, 0));

r = dhl(bulto(50, 40, 30, 30), bulto(50, 40, 30, 40), bulto(20, 20, 20, 5));
check('cobra una vez por cada pieza (2 de 3)', cerca(r.noConvencionalTotal, 46), r.noConvencionalTotal);

// el cargo tiene que aparecer en el desglose que ve la oficina
const envioDHL = core.cotizarServicio('DHL', { ...base, pais: 'Estados Unidos', tipo: 'export',
  pf: 30, bultosProc: [bulto(50, 40, 30, 30)] });
check('el desglose muestra la línea de pieza no convencional',
  envioDHL.extras.some(([n]) => /no convencional/i.test(n)),
  JSON.stringify(envioDHL.extras.map((e) => e[0])));

// ── 5. Entrega residencial ──────────────────────────────────────────────────
console.log('\n5. Entrega residencial\n');

const conRes = core.cotizarServicio('UPS_EXP', { ...base, pais: 'Estados Unidos', tipo: 'export',
  residencial: true });
const filaRes = conRes.extras.find(([n]) => /residencial/i.test(n));
check('la entrega residencial internacional cobra 5.65', filaRes && cerca(filaRes[1], 5.65),
  filaRes ? String(filaRes[1]) : 'no aparece');

// ── 6. Lo que ya estaba bien no se movió ────────────────────────────────────
console.log('\n6. Regresión: lo que ya estaba bien\n');

// El MONTO de `remota:true` no cambió; sí cambió la etiqueta, que ahora dice "Área
// extendida" porque es la tarifa que ese flag venía cobrando. Lo que importa es la plata.
check('el recargo de zona de DHL sigue en 40 / 0.80 por kg', (() => {
  const e = core.cotizarServicio('DHL', { ...base, pais: 'Estados Unidos', tipo: 'export', pf: 100, remota: true });
  const f = e.extras.find(([n]) => /remota|extendida/i.test(n));
  return f && cerca(f[1], 80);
})());

check('el recargo de zona de UPS sigue en 42.15 / 0.92 por kg', (() => {
  const e = core.cotizarServicio('UPS_EXP', { ...base, pais: 'Estados Unidos', tipo: 'export', pf: 100, remota: true });
  const f = e.extras.find(([n]) => /remota|extendida/i.test(n));
  return f && cerca(f[1], 92);
})());

check('DDP sigue en 24.05 en los dos couriers', (() => {
  const a = core.cotizarServicio('DHL', { ...base, pais: 'Estados Unidos', tipo: 'export', ddp: true });
  const b = core.cotizarServicio('UPS_EXP', { ...base, pais: 'Estados Unidos', tipo: 'export', ddp: true });
  return [a, b].every((e) => { const f = e.extras.find(([n]) => /DDP/i.test(n)); return f && cerca(f[1], 24.05); });
})());

check('el manejo adicional sigue costando 27.65', (() => {
  const e = core.cotizarServicio('UPS_EXP', { ...base, pais: 'Estados Unidos', tipo: 'export',
    pf: 30, bultosProc: [bulto(50, 40, 30, 30)] });
  const f = e.extras.find(([n]) => /manejo/i.test(n));
  return f && cerca(f[1], 27.65);
})());

check('el surge sigue entrando antes del combustible', (() => {
  const e = core.cotizarServicio('UPS_EXP', { ...base, pais: 'Egipto', tipo: 'export', pf: 10, fuelPct: 30 });
  // subtotal = flete con ganancia + surge ; fuel = 30% de ese subtotal
  return cerca(e.fuelMonto, e.subtotalConSurge * 0.30) && e.surge > 0;
})());

check('el subtotal de un envío a EE.UU. es flete×(1+ganancia) + surge', (() => {
  const e = core.cotizarServicio('UPS_EXP', { ...base, pais: 'Estados Unidos', tipo: 'export',
    pf: 5, fuelPct: 30, profitPct: 100, bultosProc: [bulto(30, 20, 20, 5)] });
  // El IPF ya NO entra acá: pasa a costo, va como extra después del fuel.
  const esperado = e.fleteBase * 2 + 2.50;   // surge 0.50 × 5 kg
  return cerca(e.subtotalConSurge, esperado, 0.01);
})());

// ── 6-bis. El IPF pasa a costo ──────────────────────────────────────────────
console.log('\n6-bis. El IPF no lleva ganancia ni combustible\n');

{
  const e = core.cotizarServicio('UPS_EXP', { ...base, pais: 'Estados Unidos', tipo: 'export',
    pf: 5, fuelPct: 32, profitPct: 120 });
  const f = (e.extras || []).find(([n]) => /procesamiento internacional/i.test(n));
  check('el IPF aparece como línea propia en el desglose', !!f,
    JSON.stringify((e.extras || []).map((x) => x[0])));
  check('y son 2.50 exactos, sin margen ni fuel encima', f && cerca(f[1], 2.50),
    f ? String(f[1]) : '-');
  check('la ganancia se calcula solo sobre el flete de tabla',
    cerca(e.conGan, e.fleteBase * 2.2, 0.01), `conGan ${e.conGan} vs ${e.fleteBase * 2.2}`);

  // el mismo envío a un destino sin IPF: la única diferencia tiene que ser 2.50
  const sinIpf = core.cotizarServicio('UPS_EXP', { ...base, pais: 'Canadá', tipo: 'export',
    pf: 5, fuelPct: 32, profitPct: 120 });
  check('un envío a EE.UU. cuesta exactamente 2.50 más que el mismo a Canadá',
    cerca(e.total - sinIpf.total, 2.50, 0.02),
    `${e.total.toFixed(2)} − ${sinIpf.total.toFixed(2)} = ${(e.total - sinIpf.total).toFixed(2)}`);
}

// ── 7. Zona de entrega: extendida y remota son DOS cargos ───────────────────
console.log('\n7. Área extendida vs área remota (UPS)\n');

const zonaDe = (servicio, pais, entrega, pf = 20) => {
  const r = core.cotizarServicio(servicio, { ...base, pais, tipo: 'export', pf, entrega });
  const f = (r.extras || []).find(([n]) => /remota|extendida/i.test(n));
  return f ? { label: f[0], monto: f[1] } : null;
};

check('normal no cobra recargo de zona', zonaDe('UPS_EXP', 'Estados Unidos', 'normal') === null);
check('extendida cobra 42.15 o 0.92/kg, el mayor',
  cerca(zonaDe('UPS_EXP', 'Estados Unidos', 'extendida').monto, 42.15));
check('extendida con 60 kg cobra 0.92/kg (55.20)',
  cerca(zonaDe('UPS_EXP', 'Estados Unidos', 'extendida', 60).monto, 55.20),
  String(zonaDe('UPS_EXP', 'Estados Unidos', 'extendida', 60).monto));
check('remota a EE.UU. cobra 5.86 por envío',
  cerca(zonaDe('UPS_EXP', 'Estados Unidos', 'remota').monto, 5.86),
  String(zonaDe('UPS_EXP', 'Estados Unidos', 'remota').monto));
check('remota a EE.UU. no escala con el peso',
  cerca(zonaDe('UPS_EXP', 'Estados Unidos', 'remota', 200).monto, 5.86));
check('remota al resto del mundo cobra la de extendida',
  cerca(zonaDe('UPS_EXP', 'Brasil', 'remota').monto, 42.15));
check('DHL tiene un solo cargo de zona: 40 o 0.80/kg',
  cerca(zonaDe('DHL', 'Brasil', 'extendida').monto, 40)
  && cerca(zonaDe('DHL', 'Brasil', 'remota').monto, 40));
check('DHL con 100 kg cobra 0.80/kg (80.00)',
  cerca(zonaDe('DHL', 'Brasil', 'remota', 100).monto, 80));

// COMPATIBILIDAD: esto es lo que protege a los envíos ya cargados
console.log('\n8. Compatibilidad: los envíos ya cargados no cambian de precio\n');

for (const [servicio, esperado] of [['UPS_EXP', 42.15], ['DHL', 40]]) {
  const viejo = core.cotizarServicio(servicio, { ...base, pais: 'Estados Unidos', tipo: 'export', pf: 20, remota: true });
  const f = (viejo.extras || []).find(([n]) => /remota|extendida/i.test(n));
  check(`${servicio}: un envío viejo con solo remota:true sigue pagando ${esperado}`,
    f && cerca(f[1], esperado), f ? `${f[0]} = ${f[1]}` : 'no cobró nada');
}
const sinNada = core.cotizarServicio('UPS_EXP', { ...base, pais: 'Estados Unidos', tipo: 'export', pf: 20 });
check('sin remota ni entrega no cobra nada de zona',
  !(sinNada.extras || []).some(([n]) => /remota|extendida/i.test(n)));

console.log('\n' + '─'.repeat(60));
console.log(`${ok} pasaron · ${fail} fallaron`);
process.exit(fail === 0 ? 0 : 1);
