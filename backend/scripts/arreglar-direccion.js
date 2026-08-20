#!/usr/bin/env node
/**
 * arreglar-direccion.js — corrección puntual, UNA vez, con informe.
 *
 * Qué corrige: envíos donde tipo_envio y direccion se contradicen (sección 1 de
 * revisar-envios.js). La causa era el alta manual: el formulario no manda direccion y el
 * modelo la dejaba en 'expo' aunque el tipo fuera importación. El motor cotizó BIEN (usa
 * tipo_envio); lo que quedaba mal era la columna Dir. de Salidas y el Excel del cierre.
 *
 * Qué hace: pone direccion = la que corresponde al tipo_envio ('importacion' → 'impo',
 * 'exportacion' → 'expo'). Se confía en tipo_envio porque lo eligió una persona al cargar;
 * direccion la puso un default del código. NO toca precios, costos, zonas ni ningún otro
 * campo. Imprime cada envío que cambia. Correrlo de nuevo no hace nada (idempotente).
 *
 * En el VPS: cd /root/Nova-Express-Sistem/backend && node scripts/arreglar-direccion.js
 */

const path = require('path');
const sqlite3 = require('sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'database', 'nova.db');

function open(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, (err) => (err ? reject(err) : resolve(db)));
  });
}
function all(db, sql, p = []) {
  return new Promise((resolve, reject) => db.all(sql, p, (e, r) => (e ? reject(e) : resolve(r))));
}
function run(db, sql, p = []) {
  return new Promise((resolve, reject) => db.run(sql, p, function cb(e) { return e ? reject(e) : resolve(this); }));
}
const close = (db) => new Promise((resolve) => db.close(() => resolve()));

async function main() {
  console.log('ARREGLO DE direccion ← tipo_envio');
  console.log(`base: ${DB_PATH}`);
  const db = await open(DB_PATH);

  const mal = await all(db, `
    SELECT e.id, e.numero_guia, e.fecha, e.tipo_envio, e.direccion,
           COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente
    FROM envios e JOIN clientes c ON c.id = e.cliente_id
    WHERE (e.tipo_envio = 'importacion' AND COALESCE(e.direccion,'expo') <> 'impo')
       OR (e.tipo_envio = 'exportacion' AND COALESCE(e.direccion,'expo') <> 'expo')`);

  if (mal.length === 0) {
    console.log('✓ Nada que corregir: tipo_envio y direccion coinciden en todos los envíos.');
    await close(db);
    return;
  }

  console.log(`\nSe corrigen ${mal.length} envío${mal.length === 1 ? '' : 's'}:`);
  for (const e of mal) {
    const nueva = e.tipo_envio === 'importacion' ? 'impo' : 'expo';
    console.log(`  · #${e.id} ${e.numero_guia} · ${e.fecha} · ${e.cliente} · direccion ${e.direccion} → ${nueva}`);
  }

  const r = await run(db, `
    UPDATE envios
    SET direccion = CASE WHEN tipo_envio = 'importacion' THEN 'impo' ELSE 'expo' END,
        updated_at = datetime('now', 'localtime')
    WHERE (tipo_envio = 'importacion' AND COALESCE(direccion,'expo') <> 'impo')
       OR (tipo_envio = 'exportacion' AND COALESCE(direccion,'expo') <> 'expo')`);

  console.log(`\n✓ Listo: ${r.changes} fila${r.changes === 1 ? '' : 's'} corregida${r.changes === 1 ? '' : 's'}. No se tocó ningún precio.`);
  await close(db);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
