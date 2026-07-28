#!/usr/bin/env node
/**
 * test-cotizador-documento.js
 *
 * Verifica que el cotizador de "Cargar envío" (backend: cotizarEnvio / desglosarCosto)
 * y el cotizador manual (frontend: cotizarServicio del core) den el MISMO número.
 *
 * El bug: Cargar envío guardaba el tipo de paquete pero nunca se lo pasaba al motor, así
 * que cotizaba y congelaba el costo con la tabla de mercadería incluso en documentos. DHL
 * tiene tarifa propia de documento hasta 2 kg → las dos pantallas diferían hasta 60%.
 *
 *   cd backend && node scripts/test-cotizador-documento.js
 *
 * Sale 0 si pasan todas, 1 si falla alguna.
 */

const core = require('../../shared/cotizador/cotizador-core');
const { cotizarEnvio, desglosarCosto, contenidoDe } = require('../src/services/calculos.service');

const FUEL = { DHL: 29.75, UPS: 35.25 };

let ok = 0;
let fail = 0;

function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}

// El cotizador manual: llama directo al core desde el navegador.
function manual({ servicio, pais, tipo, pf, fob, profitPct, contenido }) {
  const fuelPct = servicio === 'DHL' ? FUEL.DHL : FUEL.UPS;
  const r = core.cotizarServicio(servicio, {
    pais, tipo, pf, fob, fuelPct, profitPct, bultosProc: [], contenido,
  });
  return r ? Math.round(r.total * 100) / 100 : null;
}

// Cargar envío: pasa por el backend.
function alta({ servicio, pais, tipo, pf, fob, profitPct, contenido }) {
  const fuelPct = servicio === 'DHL' ? FUEL.DHL : FUEL.UPS;
  const r = cotizarEnvio({
    pais, tipo, servicio, pesoFacturable: pf, fob, fuelPct, profitPct, bultos: [], contenido,
  });
  return r ? r.precioFinal : null;
}

// ── 1. contenidoDe: el mapeo de la columna tipo_paquete ─────────────────────

console.log('\n1. contenidoDe(tipo_paquete)\n');
check('"d" → documento', contenidoDe('d') === 'documento', contenidoDe('d'));
check('"D" → documento', contenidoDe('D') === 'documento', contenidoDe('D'));
check('"m" → paquete', contenidoDe('m') === 'paquete', contenidoDe('m'));
check('null → paquete (default seguro)', contenidoDe(null) === 'paquete', contenidoDe(null));
check('undefined → paquete', contenidoDe(undefined) === 'paquete', contenidoDe(undefined));
check('"" → paquete', contenidoDe('') === 'paquete', contenidoDe(''));

// ── 2. Las dos pantallas tienen que coincidir ───────────────────────────────

const PAISES = ['Estados Unidos', 'España', 'Colombia', 'Brasil', 'Alemania', 'Chile'];
const PESOS = [0.5, 1, 1.5, 2, 2.5, 5];
const PROFITS = [0, 70, 120, 180];

console.log('\n2. Cargar envío vs. cotizador manual — mismo número en TODOS los casos\n');
let comparados = 0;
let difs = 0;
for (const pais of PAISES) {
  for (const servicio of ['DHL', 'UPS_EXP', 'UPS_SAVER']) {
    for (const tipo of ['export', 'import']) {
      for (const pf of PESOS) {
        for (const profitPct of PROFITS) {
          for (const contenido of ['paquete', 'documento']) {
            const args = { servicio, pais, tipo, pf, fob: 0, profitPct, contenido };
            const m = manual(args);
            const a = alta(args);
            if (m === null && a === null) continue;
            comparados++;
            if (m === null || a === null || Math.abs(m - a) > 0.01) {
              difs++;
              if (difs <= 5) {
                console.log(`  ✗ ${servicio} ${tipo} ${pais} ${pf}kg ${profitPct}% ${contenido}: manual=${m} alta=${a}`);
              }
            }
          }
        }
      }
    }
  }
}
check(`${comparados} combinaciones comparadas, 0 diferencias`, difs === 0, `${difs} difieren`);

// ── 3. Los casos concretos que reportó la oficina ──────────────────────────

console.log('\n3. Los dos casos reportados\n');
const casos = [
  ['Kasdorf · EEUU · DHL · 120%', { servicio: 'DHL', pais: 'Estados Unidos', tipo: 'export', pf: 0.5, fob: 0, profitPct: 120 }],
  ['Cremona · Colombia · DHL · 180%', { servicio: 'DHL', pais: 'Colombia', tipo: 'export', pf: 0.5, fob: 0, profitPct: 180 }],
];
for (const [nombre, base] of casos) {
  const doc = { ...base, contenido: 'documento' };
  const pkg = { ...base, contenido: 'paquete' };
  const aDoc = alta(doc), mDoc = manual(doc);
  const aPkg = alta(pkg);
  check(`${nombre} — documento: coinciden ($${aDoc})`, Math.abs(aDoc - mDoc) < 0.01, `alta=${aDoc} manual=${mDoc}`);
  check(`${nombre} — documento sale más barato que mercadería`, aDoc < aPkg, `doc=${aDoc} pkg=${aPkg}`);
  console.log(`     documento $${aDoc}  ·  mercadería $${aPkg}  ·  antes cobraban $${aPkg}`);
}

// ── 4. No se rompió nada de mercadería (regresión) ─────────────────────────

console.log('\n4. Regresión: sin `contenido` el resultado es el histórico (mercadería)\n');
let regr = 0;
for (const pais of PAISES) {
  for (const servicio of ['DHL', 'UPS_EXP']) {
    for (const pf of PESOS) {
      const sin = cotizarEnvio({ pais, tipo: 'export', servicio, pesoFacturable: pf, fob: 0,
        fuelPct: servicio === 'DHL' ? FUEL.DHL : FUEL.UPS, profitPct: 70, bultos: [] });
      const conPkg = alta({ servicio, pais, tipo: 'export', pf, fob: 0, profitPct: 70, contenido: 'paquete' });
      if (!sin && conPkg === null) continue;
      if (!sin || Math.abs(sin.precioFinal - conPkg) > 0.01) regr++;
    }
  }
}
check('omitir `contenido` da lo mismo que mandar "paquete"', regr === 0, `${regr} difieren`);

// ── 5. El costo congelado también usa la tabla correcta ───────────────────

console.log('\n5. El costo congelado (profit 0) también distingue documento\n');
const cDoc = desglosarCosto({ pais: 'Estados Unidos', tipo: 'export', servicio: 'DHL',
  pesoFacturable: 0.5, fob: 0, fuelPct: FUEL.DHL, bultos: [], contenido: 'documento' });
const cPkg = desglosarCosto({ pais: 'Estados Unidos', tipo: 'export', servicio: 'DHL',
  pesoFacturable: 0.5, fob: 0, fuelPct: FUEL.DHL, bultos: [], contenido: 'paquete' });
check('el costo de documento es menor al de mercadería', cDoc.total < cPkg.total, `doc=${cDoc.total} pkg=${cPkg.total}`);
console.log(`     costo documento $${cDoc.total}  ·  costo mercadería $${cPkg.total}`);
console.log('     (antes se congelaba siempre el de mercadería → utilidad mal calculada)');

console.log('\n' + '─'.repeat(60));
console.log(`${ok} pasaron · ${fail} fallaron`);
process.exit(fail === 0 ? 0 : 1);
