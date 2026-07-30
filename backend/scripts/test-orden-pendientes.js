#!/usr/bin/env node
/**
 * test-orden-pendientes.js — la lista de pendientes de liquidar sale en orden alfabético.
 *
 * Tenía DOS errores encadenados, y el segundo tapaba al primero:
 *
 *  1. La consulta ordenaba por `c.nombre` (la razón social) pero la pantalla muestra
 *     `nombre_nova`. Para los clientes donde difieren —"POLO TOP" se muestra como
 *     "GONZALO DE URQUIZA"— el orden parecía arbitrario.
 *
 *  2. Y sobre todo: el agrupado por cliente usaba un objeto común con el cliente_id de
 *     clave. JavaScript reordena solo las claves que parecen números, así que
 *     `Object.values()` devolvía los grupos por cliente_id y tiraba el ORDER BY. La lista
 *     salía ordenada por el número interno de cliente, que no le dice nada a nadie.
 *
 *   cd backend && npm run test-orden-pendientes
 */

const path = require('path');

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}

(async () => {
  const { initDb, getDb } = require('../src/db');
  await initDb();
  const db = getDb();
  const envioModel = require('../src/models/envio.model');

  console.log('\n1. Los pendientes salen en orden alfabético\n');

  const grupos = await envioModel.listarPendientesPorCliente({});
  check('hay grupos para revisar', grupos.length > 0, `${grupos.length}`);

  const nombres = grupos.map((g) => g.cliente_nombre || '');
  const ordenados = [...nombres].sort((a, b) =>
    a.localeCompare(b, 'es', { sensitivity: 'base' }));

  const desordenados = nombres.filter((n, i) => n !== ordenados[i]);
  check('la lista viene alfabética', desordenados.length === 0,
    `${desordenados.length} fuera de lugar · empieza en: ${nombres.slice(0, 5).join(' | ')}`);

  console.log('\n   ' + nombres.slice(0, 8).join('\n   ') + '\n');

  // El agrupado NO puede volver a caer en un objeto con cliente_id de clave: si lo hiciera,
  // el orden sería por id. Se comprueba que los ids NO vengan de menor a mayor (con
  // 30+ clientes es imposible que coincida por casualidad).
  console.log('2. El orden NO es por número interno de cliente\n');

  const ids = grupos.map((g) => g.cliente_id);
  const porId = [...ids].sort((a, b) => a - b);
  const iguales = ids.every((v, i) => v === porId[i]);
  check('los grupos no vienen ordenados por cliente_id', !iguales || grupos.length < 3,
    `ids: ${ids.slice(0, 8).join(', ')}`);

  // ── el nombre que se ordena es el que se muestra ────────────────────────────
  console.log('\n3. Se ordena por el nombre que se ve, no por la razón social\n');

  const distintos = await db.prepare(`
    SELECT nombre, nombre_nova FROM clientes
    WHERE nombre_nova IS NOT NULL AND nombre_nova <> '' AND nombre_nova <> nombre
  `).all();
  check('hay clientes cuyo nombre visible difiere de la razón social',
    distintos.length > 0, `${distintos.length}`);
  if (distintos.length) {
    console.log(`   ej: razón social "${distintos[0].nombre}" se muestra como "${distintos[0].nombre_nova}"`);
  }

  // ninguno de los nombres devueltos puede ser una razón social que tenga nombre_nova
  const razonesSociales = new Set(distintos.map((c) => c.nombre));
  const filtrados = nombres.filter((n) => razonesSociales.has(n));
  check('la lista muestra el nombre visible, nunca la razón social',
    filtrados.length === 0, filtrados.join(', '));

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
