/**
 * vaciar-salidas.js — Vaciado COMPLETO del módulo Salidas en producción.
 *
 * Borra envios, envio_bultos (por CASCADE), cargos_adicionales, liquidaciones y
 * liquidacion_items. NO toca clientes, pickups ni cuadrantes (a estos últimos
 * sólo les desvincula envio_origen_id de forma defensiva).
 *
 * Hace un BACKUP automático ANTES de tocar nada. Si el backup falla, ABORTA.
 *
 * IMPORTANTE: asume que el server está APAGADO (pm2 stop) al ejecutarlo.
 * No arranca ni apaga pm2 por su cuenta.
 *
 * Uso desde el VPS (en /root/Nova-Express-Sistem):
 *   pm2 stop all
 *   node backend/scripts/vaciar-salidas.js
 *   pm2 start all
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

// Misma resolución de dbPath que la app (honra DB_PATH del .env).
const config = require('../src/config');

const DB_PATH = config.dbPath;
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');

// Tablas que deben quedar VACÍAS al terminar.
const TABLAS_VACIAR = [
  'envios',
  'envio_bultos',
  'cargos_adicionales',
  'liquidaciones',
  'liquidacion_items',
];

// Tablas que NO se tocan: el conteo debe quedar IDÉNTICO antes/después.
const TABLAS_INTACTAS = ['clientes', 'pickups', 'cuadrantes'];

const TODAS = [...TABLAS_VACIAR, ...TABLAS_INTACTAS];

// ---- Helpers sqlite3 promisificados (sin pasar por initDb: evitamos migraciones/seed) ----
let db;

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function abrir() {
  return new Promise((resolve, reject) => {
    const instance = new sqlite3.Database(DB_PATH, (err) => (err ? reject(err) : resolve(instance)));
  });
}

function cerrar() {
  return new Promise((resolve) => {
    if (!db) return resolve();
    db.close(() => resolve());
  });
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function contar(tabla) {
  const row = await get(`SELECT COUNT(*) AS n FROM ${tabla}`);
  return row.n;
}

async function snapshotConteos() {
  const out = {};
  for (const t of TODAS) out[t] = await contar(t);
  return out;
}

function imprimirConteos(titulo, conteos) {
  console.log(`\n=== ${titulo} ===`);
  for (const t of TODAS) {
    console.log(`  ${t.padEnd(20)} ${conteos[t]}`);
  }
}

// ---- BACKUP (WAL-safe): VACUUM INTO con fallback a checkpoint + copia ----
async function hacerBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const destPath = path.join(BACKUP_DIR, `nova_PRE_VACIADO_SALIDAS_${timestamp()}.db`);

  try {
    // VACUUM INTO genera un archivo único y consistente con el WAL ya integrado.
    await exec(`VACUUM INTO '${destPath.replace(/\\/g, '/')}'`);
  } catch (vacuumErr) {
    console.error(`[backup] VACUUM INTO falló (${vacuumErr.message}); usando fallback checkpoint + copia...`);
    await get('PRAGMA wal_checkpoint(TRUNCATE)');
    await fs.promises.copyFile(DB_PATH, destPath);
  }

  // Verificación: el backup tiene que existir y no estar vacío.
  if (!fs.existsSync(destPath)) {
    throw new Error(`El backup no se creó en ${destPath}`);
  }
  const { size } = fs.statSync(destPath);
  if (size <= 0) {
    throw new Error(`El backup quedó vacío (0 bytes) en ${destPath}`);
  }

  console.log(`[backup] OK → ${destPath} (${(size / 1024).toFixed(1)} KB)`);
  return destPath;
}

// ---- BORRADO transaccional ----
async function vaciar() {
  await run('BEGIN');
  try {
    let r;
    r = await run('DELETE FROM liquidacion_items');
    console.log(`  - liquidacion_items: ${r.changes} filas borradas`);

    r = await run('DELETE FROM cargos_adicionales');
    console.log(`  - cargos_adicionales: ${r.changes} filas borradas`);

    r = await run('UPDATE cuadrantes SET envio_origen_id = NULL WHERE envio_origen_id IS NOT NULL');
    console.log(`  - cuadrantes desvinculados (envio_origen_id = NULL): ${r.changes}`);

    r = await run('DELETE FROM envios'); // arrastra envio_bultos por CASCADE
    console.log(`  - envios: ${r.changes} filas borradas (envio_bultos por CASCADE)`);

    r = await run('DELETE FROM liquidaciones');
    console.log(`  - liquidaciones: ${r.changes} filas borradas`);

    await run('COMMIT');
    console.log('  COMMIT OK');
  } catch (e) {
    console.error('  ERROR durante el borrado → ROLLBACK');
    try {
      await run('ROLLBACK');
    } catch (rbErr) {
      console.error('  (además falló el ROLLBACK):', rbErr.message);
    }
    throw e;
  }
}

// ---- Verificación final ----
function verificar(antes, despues) {
  let ok = true;

  console.log('\n=== VERIFICACIÓN ===');

  for (const t of TABLAS_VACIAR) {
    if (despues[t] === 0) {
      console.log(`  OK   ${t.padEnd(20)} quedó en 0`);
    } else {
      ok = false;
      console.log(`  ###  ERROR: ${t} NO quedó en 0 (tiene ${despues[t]})`);
    }
  }

  for (const t of TABLAS_INTACTAS) {
    if (despues[t] === antes[t]) {
      console.log(`  OK   ${t.padEnd(20)} intacto (${despues[t]})`);
    } else {
      ok = false;
      console.log(`  ###  ERROR: ${t} CAMBIÓ (antes ${antes[t]} → ahora ${despues[t]}) — NO debería haber cambiado`);
    }
  }

  return ok;
}

async function main() {
  console.log('======================================================');
  console.log(' VACIADO MÓDULO SALIDAS — Nova Express');
  console.log(` DB: ${DB_PATH}`);
  console.log('======================================================');

  if (!fs.existsSync(DB_PATH)) {
    console.error(`ABORTADO: no existe la base de datos en ${DB_PATH}`);
    process.exit(1);
  }

  db = await abrir();
  await exec('PRAGMA foreign_keys = ON');

  // 1) BACKUP PRIMERO. Si falla, abortamos sin tocar datos.
  console.log('\n[1/5] Creando backup...');
  let backupPath;
  try {
    backupPath = await hacerBackup();
  } catch (err) {
    console.error('\nABORTADO: el backup falló, NO se tocó ningún dato.');
    console.error(err);
    await cerrar();
    process.exit(1);
  }

  // 2) Conteos ANTES.
  console.log('\n[2/5] Conteos ANTES de borrar...');
  const antes = await snapshotConteos();
  imprimirConteos('CONTEOS ANTES', antes);

  // 3) Borrado transaccional.
  console.log('\n[3/5] Ejecutando borrado (transacción)...');
  try {
    await vaciar();
  } catch (err) {
    console.error('\nABORTADO: el borrado falló y se hizo ROLLBACK. La base quedó como estaba.');
    console.error(`Backup disponible en: ${backupPath}`);
    console.error(err);
    await cerrar();
    process.exit(1);
  }

  // 4) Conteos DESPUÉS + verificación.
  console.log('\n[4/5] Conteos DESPUÉS de borrar...');
  const despues = await snapshotConteos();
  imprimirConteos('CONTEOS DESPUÉS', despues);

  const ok = verificar(antes, despues);

  // Integramos el WAL al archivo principal para dejar la DB limpia antes de cerrar.
  try {
    await get('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (e) {
    console.error('(aviso) no se pudo hacer checkpoint final del WAL:', e.message);
  }

  await cerrar();

  // 5) Resultado final.
  console.log('\n[5/5] FINALIZADO.');
  console.log('======================================================');
  console.log(` Backup creado en: ${backupPath}`);
  if (ok) {
    console.log(' RESULTADO: OK — vaciado completo y tablas intactas verificadas.');
    console.log('======================================================');
    process.exit(0);
  } else {
    console.log(' RESULTADO: ### REVISAR — hubo diferencias inesperadas (ver ERRORES arriba).');
    console.log(` Para restaurar: copiar el backup sobre ${DB_PATH}`);
    console.log('======================================================');
    process.exit(2);
  }
}

main().catch(async (err) => {
  console.error('\nERROR no controlado:', err);
  await cerrar();
  process.exit(1);
});
