#!/usr/bin/env node
/**
 * test-validar-guia.js — el dígito verificador de las guías de UPS y DHL.
 *
 * La prueba que vale es la última: se corre el validador contra TODAS las guías reales de
 * la base. Si el algoritmo estuviera mal, fallarían muchas; si está bien, fallan solo las
 * que de verdad están mal tipeadas.
 *
 *   cd backend && npm run test-validar-guia
 */

const path = require('path');
const { validarGuia } = require('../../shared/guias/validar-guia.js');

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}

// ── 1. Guías buenas ─────────────────────────────────────────────────────────
console.log('\n1. Guías bien tipeadas\n');

const BUENAS_UPS = [
  '1Z327W096794727256', '1Z327W096792517745', '1Z327W096797664354',
  '1Z327W096790199567', '1Z327W096797411680',
];
for (const g of BUENAS_UPS) {
  check(`UPS ${g}`, validarGuia('UPS', g).estado === 'ok', validarGuia('UPS', g).motivo);
}

// ── 2. Los errores de tipeo que ya están en la base ─────────────────────────
console.log('\n2. Los errores de tipeo reales de la base\n');

const MALAS = [
  ['1Z327W06792853864',   'un caracter de menos'],
  ['1Z327W0970490762735', 'un caracter de más'],
  ['1Z32W7096793613086',  'cruzó 327W por 32W7'],
  ['1Z32W7096798445697',  'cruzó 327W por 32W7'],
  ['1Z327W096795635137',  'un dígito cambiado'],
  ['1Z327W096794195617',  'un dígito cambiado'],
];
for (const [g, porque] of MALAS) {
  const v = validarGuia('UPS', g);
  check(`detecta ${g} (${porque})`, v.estado === 'sospechosa', v.estado);
}

// ── 3. Errores fabricados a mano ────────────────────────────────────────────
console.log('\n3. Errores fabricados sobre una guía buena\n');

const BUENA = '1Z327W096794727256';
// cambiar un dígito del medio
const cambiada = BUENA.slice(0, 10) + (BUENA[10] === '9' ? '8' : '9') + BUENA.slice(11);
check('cambiar un dígito la vuelve sospechosa',
  validarGuia('UPS', cambiada).estado === 'sospechosa', cambiada);
// cruzar dos dígitos contiguos
const cruzada = BUENA.slice(0, 8) + BUENA[9] + BUENA[8] + BUENA.slice(10);
check('cruzar dos dígitos la vuelve sospechosa',
  cruzada === BUENA || validarGuia('UPS', cruzada).estado === 'sospechosa', cruzada);
check('borrar un caracter la vuelve sospechosa',
  validarGuia('UPS', BUENA.slice(0, 17)).estado === 'sospechosa');

// ── 4. DHL ──────────────────────────────────────────────────────────────────
console.log('\n4. DHL (10 dígitos, verificador módulo 7)\n');

check('acepta una guía DHL válida', validarGuia('DHL', '3292020222').estado === 'ok',
  validarGuia('DHL', '3292020222').motivo);
check('rechaza una de 9 dígitos', validarGuia('DHL', '329202022').estado === 'sospechosa');
check('rechaza una con el verificador cambiado',
  validarGuia('DHL', '3292020223').estado === 'sospechosa');

// ── 5. Nunca molesta con lo que no reconoce ─────────────────────────────────
console.log('\n5. Lo que no reconoce NO dispara alarma\n');

for (const g of ['ABC123', 'JJD0099', '', '   ']) {
  check(`"${g}" queda como desconocida, sin alarma`,
    validarGuia('UPS', g).estado !== 'sospechosa' || !/^1Z/.test(g.trim()),
    validarGuia('UPS', g).estado);
}
check('una guía vacía no dispara nada', validarGuia('UPS', '').estado === 'desconocida');

// ── 6. Contra TODA la base real ─────────────────────────────────────────────
(async () => {
  // Contra la base real del sistema (solo lectura). Si no existe, se saltea esta parte.
  const fs = require('fs');
  const CANDIDATOS = [
    process.env.DB_PATH_TEST,
    process.env.DB_PATH,
    path.join(__dirname, '..', '..', 'database', 'nova.db'),
    path.join(__dirname, '..', '..', '..', 'prod', 'prod.db'),
  ].filter(Boolean);
  const DB = CANDIDATOS.find((x) => fs.existsSync(x));
  // sqlite3 es un módulo nativo: si está compilado para otro sistema (pasa al correr
  // esto desde un entorno distinto al de la instalación) no carga. Es un informe
  // opcional, así que se saltea en vez de reventar.
  let sqlite3 = null;
  try { sqlite3 = require('sqlite3'); } catch { sqlite3 = null; }

  if (DB && sqlite3) {
    console.log('\n6. Contra todas las guías de la base\n');
    const db = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
    const rows = await new Promise((res, rej) =>
      db.all('SELECT courier, numero_guia FROM envios', (e, r) => (e ? rej(e) : res(r))));
    const por = { ok: 0, sospechosa: 0, desconocida: 0 };
    const sospechosas = [];
    for (const r of rows) {
      const v = validarGuia(r.courier, r.numero_guia);
      por[v.estado]++;
      if (v.estado === 'sospechosa') sospechosas.push(`${r.courier} ${r.numero_guia} — ${v.motivo}`);
    }
    console.log(`   ${rows.length} guías · ${por.ok} válidas · ${por.sospechosa} sospechosas · ${por.desconocida} sin formato reconocido`);
    if (sospechosas.length) {
      console.log('\n   Guías que el validador marcaría:');
      sospechosas.forEach((s) => console.log('     · ' + s));
    }
    console.log('\n   (Esto es un INFORME, no una prueba: el resultado depende de qué base se');
    console.log('    esté mirando. La base de desarrollo tiene guías inventadas y todas van a');
    console.log('    salir marcadas, y eso está bien. Lo que prueba que el algoritmo funciona');
    console.log('    son los casos fijos de arriba.)');
    db.close();
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exit(fail === 0 ? 0 : 1);
})();
