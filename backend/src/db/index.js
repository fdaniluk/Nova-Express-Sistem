const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const config = require('../config');

let rawDb;
let dbApi;

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    rawDb.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastInsertRowid: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    rawDb.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    rawDb.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    rawDb.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function prepare(sql) {
  return {
    run: (...params) => run(sql, params),
    get: (...params) => get(sql, params),
    all: (...params) => all(sql, params),
  };
}

async function transaction(fn) {
  await run('BEGIN TRANSACTION');
  try {
    const result = await fn();
    await run('COMMIT');
    return result;
  } catch (e) {
    await run('ROLLBACK');
    throw e;
  }
}

function buildDbApi() {
  return {
    prepare,
    transaction,
    exec,
    pragma: (value) => exec(`PRAGMA ${value}`),
  };
}

async function initDb() {
  if (rawDb) return dbApi;

  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  rawDb = await new Promise((resolve, reject) => {
    const instance = new sqlite3.Database(config.dbPath, (err) => {
      if (err) reject(err);
      else resolve(instance);
    });
  });

  dbApi = buildDbApi();
  await dbApi.pragma('journal_mode = WAL');
  await dbApi.pragma('foreign_keys = ON');
  await initSchema();
  return dbApi;
}

function getDb() {
  if (!dbApi) {
    throw new Error('Base de datos no inicializada. Ejecutá initDb() antes de usar getDb().');
  }
  return dbApi;
}

async function migrateClientes() {
  const existingCols = (await dbApi.prepare('PRAGMA table_info(clientes)').all()).map((c) => c.name);
  const toAdd = [
    ['cuit',                  'TEXT'],
    ['direccion_recoleccion', 'TEXT'],
    ['contacto',              'TEXT'],
    ['email',                 'TEXT'],
    ['whatsapp',              'TEXT'],
    ['codigo_postal',         'TEXT'],
    ['tipo_facturacion',      "TEXT DEFAULT 'Responsable inscripto'"],
    ['tarifa_pct',            'REAL DEFAULT 0'],
  ];
  for (const [col, def] of toAdd) {
    if (!existingCols.includes(col)) {
      await dbApi.exec(`ALTER TABLE clientes ADD COLUMN ${col} ${def}`);
    }
  }
}

async function initSchema() {
  const schema = fs.readFileSync(config.schemaPath, 'utf8');
  await dbApi.exec(schema);
  await migrateClientes();
  await seedIfEmpty();
}

async function seedIfEmpty() {
  const row = await dbApi.prepare('SELECT COUNT(*) AS n FROM clientes').get();
  if (row.n === 0) {
    await dbApi
      .prepare(`INSERT INTO clientes (nombre, tipo_cobro) VALUES ('Cliente Demo', 'D')`)
      .run();
  }
}

function closeDb() {
  return new Promise((resolve, reject) => {
    if (!rawDb) {
      resolve();
      return;
    }
    rawDb.close((err) => {
      if (err) reject(err);
      else {
        rawDb = null;
        dbApi = null;
        resolve();
      }
    });
  });
}

module.exports = { initDb, getDb, closeDb };
