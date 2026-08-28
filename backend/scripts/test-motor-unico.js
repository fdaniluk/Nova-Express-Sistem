#!/usr/bin/env node
/**
 * test-motor-unico.js — controla que haya UN SOLO motor de tarifas.
 *
 * La regla del sistema: las tarifas de DHL y UPS, las zonas y todas las reglas de recargo
 * viven en UN archivo, `shared/cotizador/cotizador-core.js`. Todo lo que cotice —el
 * cotizador manual, Cargar envío, Salidas, el liquidador— tiene que dar el mismo número
 * porque todos leen de ahí. Cuando cambian las tarifas se toca ese archivo y listo.
 *
 * Esta prueba falla si alguien vuelve a escribir un número de tarifa fuera del motor.
 * Ya pasó antes: había una copia del GoGreen y otra del seguro dando vueltas.
 *
 *   cd backend && npm run test-motor-unico
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const CORE = path.join(RAIZ, 'shared', 'cotizador', 'cotizador-core.js');
const core = require(CORE);

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '\n      ' + detalle : ''}`); }
}

// Recorre el código del sistema, salteando dependencias, pruebas y el propio motor.
function archivos() {
  const out = [];
  const saltar = new Set(['node_modules', '.git', 'database', 'facturas-ejemplo', '_to_delete', 'scripts']);
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!saltar.has(e.name)) walk(path.join(dir, e.name)); continue; }
      if (!/\.(js|html)$/.test(e.name)) continue;
      const p = path.join(dir, e.name);
      if (p === CORE) continue;
      out.push(p);
    }
  })(RAIZ);
  return out;
}

const ARCHIVOS = archivos();
const rel = (p) => path.relative(RAIZ, p).replace(/\\/g, '/');

// ── 1. Ningún número de tarifa suelto fuera del motor ───────────────────────
console.log('\n1. Números de tarifa fuera del motor\n');

// Cada regla: el valor tal como se escribiría en código, y qué representa.
const VALORES = [
  ['0.98', 'GoGreen de DHL (por kg)'],
  ['27.65', 'manejo adicional UPS'],
  ['120.10', 'paquete de mayor tamaño UPS'],
  ['24.05', 'DDP'],
  ['42.15', 'área remota UPS'],
  ['17.50', 'mínimo del seguro DHL'],
  ['2.95', 'surge ISMEA'],
  ['3.30', 'surge Israel y E.A.U.'],
  ['6.00', 'entrega residencial UPS (6.00 desde el 28/08: es lo que factura UPS)'],
];

const sospechas = [];
for (const p of ARCHIVOS) {
  const txt = fs.readFileSync(p, 'utf8');
  const lineas = txt.split(/\r?\n/);
  for (const [valor, quees] of VALORES) {
    const re = new RegExp(`(^|[^\\w.])${valor.replace('.', '\\.')}([^\\w]|$)`);
    lineas.forEach((linea, i) => {
      // los comentarios no ejecutan nada
      const sinComentario = linea.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (re.test(sinComentario)) {
        sospechas.push(`${rel(p)}:${i + 1}  ${valor} (${quees})  →  ${linea.trim().slice(0, 90)}`);
      }
    });
  }
}
check(`ningún valor de tarifa aparece fuera de cotizador-core.js (${ARCHIVOS.length} archivos revisados)`,
  sospechas.length === 0, sospechas.slice(0, 8).join('\n      '));

// ── 2. Una sola copia del motor ─────────────────────────────────────────────
console.log('\n2. Una sola copia del motor\n');

const copias = ARCHIVOS.filter((p) => {
  const t = fs.readFileSync(p, 'utf8');
  return /function\s+cotizarServicio\s*\(/.test(t) || /const\s+DHL_E_PKG\s*=/.test(t);
});
check('no hay un segundo archivo que redefina el motor o sus tablas',
  copias.length === 0, copias.map(rel).join('\n      '));

const refs = ARCHIVOS.filter((p) => /cotizador-core/.test(fs.readFileSync(p, 'utf8')));
console.log(`      lo usan: ${refs.map(rel).join(', ')}`);

// ── 3. Las pantallas piden la MISMA versión del motor ───────────────────────
console.log('\n3. Cache busting del motor\n');

const versiones = new Map();
for (const p of ARCHIVOS.filter((f) => f.endsWith('.html'))) {
  const t = fs.readFileSync(p, 'utf8');
  const m = t.match(/cotizador-core\.js\?v=([\w.-]+)/);
  if (m) {
    if (!versiones.has(m[1])) versiones.set(m[1], []);
    versiones.get(m[1]).push(rel(p));
  }
}
check('todas las pantallas piden la misma versión del motor',
  versiones.size <= 1,
  [...versiones.entries()].map(([v, fs_]) => `?v=${v} → ${fs_.join(', ')}`).join('\n      '));

// ── 4. Los cuatro caminos dan el MISMO número ───────────────────────────────
console.log('\n4. El mismo envío cotizado por los cuatro caminos\n');

const { cotizarEnvio, desglosarCosto } = require('../src/services/calculos.service');

const CASOS = [
  { nombre: 'UPS export 5 kg a EE.UU.',      servicio: 'UPS_EXP', pais: 'Estados Unidos', tipo: 'export', pf: 5 },
  { nombre: 'DHL export 0.5 kg documento',   servicio: 'DHL',     pais: 'Brasil',         tipo: 'export', pf: 0.5, contenido: 'documento' },
  { nombre: 'DHL export 76.88 kg a Kenia',   servicio: 'DHL',     pais: 'Kenia',          tipo: 'export', pf: 76.88 },
  { nombre: 'DHL import 60 kg de China',     servicio: 'DHL',     pais: 'China',          tipo: 'import', pf: 60 },
  { nombre: 'UPS Saver export 12 kg a España', servicio: 'UPS_SAVER', pais: 'España',     tipo: 'export', pf: 12 },
];

for (const c of CASOS) {
  const comun = {
    pais: c.pais, tipo: c.tipo, fob: 500, fuelPct: 30,
    bultosProc: [], bultos: [], contenido: c.contenido || 'paquete',
  };
  // camino 1: el motor directo (lo que corre en el navegador del cotizador)
  const motor = core.cotizarServicio(c.servicio, { ...comun, pf: c.pf, profitPct: 0 });
  // camino 2: el wrapper del backend que usa el endpoint /cotizar del liquidador
  const wrapper = cotizarEnvio({ ...comun, servicio: c.servicio, pesoFacturable: c.pf, profitPct: 0 });
  // camino 3: el desglose que se congela al dar de alta un envío y al recalcular en Salidas
  const desglose = desglosarCosto({ ...comun, servicio: c.servicio, pesoFacturable: c.pf });

  const a = Math.round(motor.total * 100) / 100;
  const b = wrapper.precioBase;
  const d = Math.round(desglose.total * 100) / 100;
  check(`${c.nombre}: los tres caminos dan ${a.toFixed(2)}`,
    Math.abs(a - b) <= 0.02 && Math.abs(a - d) <= 0.02,
    `motor ${a.toFixed(2)} · liquidador ${Number(b).toFixed(2)} · alta/Salidas ${d.toFixed(2)}`);
}

// ── 4-bis. Lo mismo, pero CON BULTOS ────────────────────────────────────────
// Compartir el archivo del motor no alcanza: hay que mandarle los mismos datos. Acá estaba
// escondida una divergencia de USD 102 por bulto — el cotizador le pasaba el peso facturable
// de cada bulto y el backend no, así que un bulto liviano pero enorme cobraba sobrepeso en
// una pantalla y exceso de tamaño en la otra.
console.log('\n4-bis. El mismo envío con bultos, por el cotizador y por el backend\n');

const BULTOS = [
  { nombre: 'liviano y enorme (10 kg reales, 80 kg por volumen)', l: 100, a: 100, h: 40, pr: 10 },
  { nombre: 'pesado de verdad (80 kg reales)',                    l: 50,  a: 40,  h: 30, pr: 80 },
  { nombre: 'común',                                              l: 40,  a: 40,  h: 40, pr: 10 },
  { nombre: 'lado largo de 110 cm',                               l: 110, a: 40,  h: 30, pr: 12 },
  { nombre: 'no convencional DHL (30 kg)',                        l: 50,  a: 40,  h: 30, pr: 30 },
  { nombre: 'contorno de 340 cm (mayor tamaño UPS)',              l: 140, a: 60,  h: 40, pr: 10 },
];

for (const servicio of ['DHL', 'UPS_EXP']) {
  for (const b of BULTOS) {
    const vol = (b.l * b.a * b.h) / 5000;
    const pf = Math.max(b.pr, vol);
    const dims = [b.l, b.a, b.h].sort((x, y) => y - x);
    const comun = { pais: 'Brasil', tipo: 'export', fob: 300, fuelPct: 30 };
    // el cotizador, que corre el motor en el navegador y manda pf por bulto
    const front = core.cotizarServicio(servicio, {
      ...comun, pf, profitPct: 0, bultosProc: [{ dims, pr: b.pr, pf }],
    });
    // el backend, que arma los bultos con mkBultosProc
    const back = desglosarCosto({
      ...comun, servicio, pesoFacturable: pf,
      bultos: [{ largo: b.l, ancho: b.a, alto: b.h, peso_real: b.pr }],
    });
    check(`${servicio} · ${b.nombre}`,
      front && back && Math.abs(front.total - back.total) <= 0.02,
      front && back
        ? `cotizador ${front.total.toFixed(2)} · backend ${back.total.toFixed(2)} · dif ${(front.total - back.total).toFixed(2)}`
        : 'una de las dos no cotizó');
  }
}

// ── 4-ter. El peso facturable se redondea POR BULTO ─────────────────────────
// Regla del 20/08/2026, y mueve plata: se redondea CADA bulto a medio kilo para arriba y
// después se suman. Antes se sumaba crudo y se redondeaba el total, que da menos. El
// cambio salió de las facturas: los couriers nos cobran por bulto, así que con el criterio
// viejo cotizábamos por debajo de lo que después nos facturaban.
console.log('\n4-ter. El peso facturable se redondea por bulto\n');

const { calcularPesos } = require(path.join(RAIZ, 'backend', 'src', 'services', 'calculos.service'));
const caja = (pr, l = 10, a = 10, h = 10) => ({ peso_real: pr, largo: l, ancho: a, alto: h });

const CASOS_PESO = [
  { que: 'tres cajas de 4,2 / 4,3 / 4,4 kg dan 13,5 y no 13',
    bultos: [caja(4.2), caja(4.3), caja(4.4)], espera: 13.5 },
  { que: 'un solo bulto de 4,2 kg se cobra 4,5', bultos: [caja(4.2)], espera: 4.5 },
  { que: 'los pesos que ya caen justo no se mueven', bultos: [caja(5), caja(5)], espera: 10 },
  { que: 'manda el volumétrico cuando es mayor (caja de 1 kg y 100×100×40)',
    bultos: [caja(1, 100, 100, 40)], espera: 80 },
  { que: 'un volumétrico con decimales también redondea (60×40×30 = 14,4 kg → 14,5)',
    bultos: [caja(1, 60, 40, 30)], espera: 14.5 },
];
for (const c of CASOS_PESO) {
  const r = calcularPesos(0, c.bultos);
  check(c.que, Math.abs(r.pesoFacturable - c.espera) < 1e-9,
    `dio ${r.pesoFacturable}, esperaba ${c.espera}`);
}
// El envío SIN PESAR tiene que seguir dando 0: es la marca de "todavía no se pesó" y hay
// media docena de reglas colgadas de eso (no congela costo, no se puede liquidar).
check('un envío sin pesar sigue dando 0 y no medio kilo',
  calcularPesos(0, [], {}).pesoFacturable === 0);

// El cotizador de pantalla tiene su propia copia de la cuenta (corre en el navegador):
// si queda con la fórmula vieja, la pantalla y el backend cobran distinto.
const COT = path.join(RAIZ, 'frontend', 'pages', 'cotizador.html');
const cot = fs.readFileSync(COT, 'utf8');
check('el cotizador de pantalla redondea por bulto igual que el backend',
  /const pf=Math\.ceil\(Math\.max\(b\.pr,pvRaw\)\*2\)\/2/.test(cot),
  'no se encontró el redondeo por bulto en cotizador.html');

// ── 5. El profit se resuelve en un solo lugar ───────────────────────────────
console.log('\n5. Resolución del profit\n');

const resolutores = ARCHIVOS.filter((p) => /function\s+resolverProfit|resolverProfit\s*[:=]\s*(async\s*)?\(/.test(fs.readFileSync(p, 'utf8')));
check('la escala celda → banda → zona → tabla → cliente se resuelve en un solo archivo',
  resolutores.length === 1,
  resolutores.map(rel).join('\n      '));
console.log(`      vive en: ${resolutores.map(rel).join(', ') || '(no encontrado)'}`);

console.log('\n' + '─'.repeat(60));
console.log(`${ok} pasaron · ${fail} fallaron`);
process.exit(fail === 0 ? 0 : 1);
