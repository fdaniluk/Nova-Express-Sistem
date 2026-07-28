#!/usr/bin/env node
/**
 * check-schema.js — compara la base viva (database/nova.db) contra el archivo
 * database/schema/schema.sql y reporta cualquier desvío.
 *
 * Por qué existe: los cambios de esquema se aplican en runtime desde
 * backend/src/db/index.js (ALTER TABLE ADD COLUMN idempotentes y CREATE TABLE
 * IF NOT EXISTS). Eso funciona, pero no toca schema.sql, así que el archivo se
 * desincroniza en silencio. Cuando eso pasa, una instalación limpia desde
 * schema.sql NO reproduce la base real — que es exactamente lo que pasó con
 * profit_overrides (la matriz de márgenes) y envio_bultos.numero_guia.
 *
 * Uso:
 *   npm run check-schema          # desde backend/
 *   DB_PATH=/otra/base.db npm run check-schema
 *
 * Sale con código 0 si están sincronizados, 1 si hay desvío. Es de solo lectura:
 * no modifica ni la base ni el schema.
 *
 * Cuando reporta un desvío, el arreglo es a mano: llevar a schema.sql lo que la
 * base ya tiene (schema.sql debe reflejar el estado real, no al revés).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'database', 'nova.db');
const SCHEMA_PATH = path.join(ROOT, 'database', 'schema', 'schema.sql');

// --- helpers de promesa sobre la API de callbacks de sqlite3 ---------------

function open(file, mode) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, mode, (err) => (err ? reject(err) : resolve(db)));
  });
}

function all(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

// --- lectura de estructura -------------------------------------------------

async function tablas(db) {
  const rows = await all(
    db,
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`
  );
  return rows.map((r) => r.name);
}

async function indices(db) {
  const rows = await all(
    db,
    `SELECT name FROM sqlite_master
      WHERE type = 'index' AND sql IS NOT NULL
      ORDER BY name`
  );
  return rows.map((r) => r.name);
}

// Firma de columna: tipo + notnull + default. Ignora el orden de las columnas a
// propósito: ALTER TABLE ADD COLUMN siempre agrega al final, así que el orden
// entre la base y schema.sql difiere de forma legítima y no es un desvío real.
async function columnas(db, tabla) {
  const rows = await all(db, `PRAGMA table_info(${tabla})`);
  const m = new Map();
  for (const r of rows) {
    m.set(r.name, `${(r.type || '').toUpperCase()}|notnull=${r.notnull}|default=${r.dflt_value}`);
  }
  return m;
}

// --- main ------------------------------------------------------------------

async function main() {
  for (const [etiqueta, file] of [['base', DB_PATH], ['schema', SCHEMA_PATH]]) {
    if (!fs.existsSync(file)) {
      console.error(`✗ No se encontró el archivo de ${etiqueta}: ${file}`);
      process.exit(1);
    }
  }

  const real = await open(DB_PATH, sqlite3.OPEN_READONLY);

  // schema.sql se materializa en una base temporal descartable. No se usa
  // ':memory:' para que un schema.sql que falle a mitad deje algo inspeccionable
  // y para no depender del modo memoria del driver.
  const tmp = path.join(os.tmpdir(), `nova-schema-check-${process.pid}.db`);
  fs.rmSync(tmp, { force: true });
  const ref = await open(tmp, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);

  const desvios = [];

  try {
    try {
      await exec(ref, fs.readFileSync(SCHEMA_PATH, 'utf8'));
    } catch (err) {
      console.error(`✗ schema.sql no se ejecuta limpio: ${err.message}`);
      process.exitCode = 1;
      return;
    }

    const [tReal, tRef] = [await tablas(real), await tablas(ref)];
    const setRef = new Set(tRef);
    const setReal = new Set(tReal);

    for (const t of tReal) {
      if (!setRef.has(t)) desvios.push(`tabla "${t}" existe en la base y falta en schema.sql`);
    }
    for (const t of tRef) {
      if (!setReal.has(t)) desvios.push(`tabla "${t}" está en schema.sql y no existe en la base`);
    }

    for (const t of tReal.filter((x) => setRef.has(x))) {
      const [cReal, cRef] = [await columnas(real, t), await columnas(ref, t)];
      for (const [col, firma] of cReal) {
        if (!cRef.has(col)) {
          desvios.push(`${t}.${col} existe en la base y falta en schema.sql`);
        } else if (cRef.get(col) !== firma) {
          desvios.push(`${t}.${col} difiere — base: ${firma} · schema.sql: ${cRef.get(col)}`);
        }
      }
      for (const col of cRef.keys()) {
        if (!cReal.has(col)) {
          desvios.push(`${t}.${col} está en schema.sql y no existe en la base`);
        }
      }
    }

    const [iReal, iRef] = [await indices(real), await indices(ref)];
    const iSetRef = new Set(iRef);
    const iSetReal = new Set(iReal);
    for (const i of iReal) {
      if (!iSetRef.has(i)) desvios.push(`índice "${i}" existe en la base y falta en schema.sql`);
    }
    for (const i of iRef) {
      if (!iSetReal.has(i)) desvios.push(`índice "${i}" está en schema.sql y no existe en la base`);
    }

    console.log(`base:   ${DB_PATH}`);
    console.log(`schema: ${SCHEMA_PATH}`);
    console.log(`tablas: ${tReal.length} en la base · ${tRef.length} en schema.sql\n`);

    if (desvios.length === 0) {
      console.log('✓ schema.sql refleja la base. Sin desvíos.');
    } else {
      console.log(`✗ ${desvios.length} desvío(s):\n`);
      for (const d of desvios) console.log(`  · ${d}`);
      console.log('\nArreglo: llevar a schema.sql lo que la base ya tiene.');
      process.exitCode = 1;
    }
  } finally {
    await close(real);
    await close(ref);
    fs.rmSync(tmp, { force: true });
  }
}

main().catch((err) => {
  console.error('✗ Error inesperado:', err);
  process.exit(1);
});
