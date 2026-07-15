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
    ['nombre_nova',           'TEXT'],
    ['cuit',                  'TEXT'],
    ['direccion_recoleccion', 'TEXT'],
    ['contacto',              'TEXT'],
    ['email',                 'TEXT'],
    ['whatsapp',              'TEXT'],
    ['codigo_postal',         'TEXT'],
    ['localidad',             'TEXT'],
    ['tipo_facturacion',      "TEXT DEFAULT 'Responsable inscripto'"],
    ['tarifa_pct',            'REAL DEFAULT 0'],
  ];
  for (const [col, def] of toAdd) {
    if (!existingCols.includes(col)) {
      await dbApi.exec(`ALTER TABLE clientes ADD COLUMN ${col} ${def}`);
    }
  }
}

async function migratePickups() {
  const cols = (await dbApi.prepare('PRAGMA table_info(pickups)').all()).map((c) => c.name);
  const toAdd = [
    ['estado',          "TEXT DEFAULT 'pendiente'"],
    ['check_datos',     'INTEGER DEFAULT 0'],
    ['check_guia',      'INTEGER DEFAULT 0'],
    ['check_proforma',  'INTEGER DEFAULT 0'],
    ['check_despachado','INTEGER DEFAULT 0'],
    ['courier',            'TEXT'],
    ['confirmado_ricardo', 'TEXT'],
    ['confirmado_juanqui', 'TEXT'],
    ['en_deposito_at',     'TEXT'],
    ['recolector',         'TEXT'],
    ['visto_juanqui_at',   'TEXT'],
    ['tiene_cobro',        'INTEGER DEFAULT 0'],
    ['tipo_recoleccion',   "TEXT DEFAULT 'normal'"],
    ['titulo',             'TEXT'],
    ['llevar_plata',          'INTEGER DEFAULT 0'],
    ['mostrar_en_operaciones','INTEGER DEFAULT 1'],
  ];
  for (const [col, def] of toAdd) {
    if (!cols.includes(col)) {
      await dbApi.exec(`ALTER TABLE pickups ADD COLUMN ${col} ${def}`);
    }
  }

  // Pickups anteriores: confirmado_juanqui implicaba "en depósito" en el viejo modelo.
  // Los backfilleamos para que no queden como "en_camioneta" sin haber llegado a depósito.
  await dbApi.exec(`
    UPDATE pickups
    SET en_deposito_at = confirmado_juanqui, estado = 'en_deposito'
    WHERE confirmado_juanqui IS NOT NULL AND en_deposito_at IS NULL
  `);
}

async function migrateEnvios() {
  const cols = (await dbApi.prepare('PRAGMA table_info(envios)').all()).map((c) => c.name);
  const toAdd = [
    ['estado_operativo', "TEXT DEFAULT 'pendiente'"],
    ['check_datos',      'INTEGER DEFAULT 0'],
    ['check_guia',       'INTEGER DEFAULT 0'],
    ['check_proforma',   'INTEGER DEFAULT 0'],
    ['check_despachado', 'INTEGER DEFAULT 0'],
    // Nota/título operativo editable por envío (consistente con cuadrantes.titulo).
    // Persiste para que los envíos arrastrados de un día a otro no pierdan la nota.
    ['titulo',           'TEXT'],
    // Columnas módulo Salidas
    ['numero_salida',    'INTEGER'],
    ['bulto',            'TEXT'],
    ['tipo_paquete',     'TEXT'],
    ['asegurado',        'INTEGER DEFAULT 0'],
    ['ddp',              'INTEGER DEFAULT 0'],
    ['flete',            'REAL'],
    ['descuento',        'REAL'],
    ['seguro',           'REAL'],
    ['fuel',             'REAL'],
    ['fuel_pct',         'REAL'],
    ['derechos',         'REAL'],
    ['adicionales',      'REAL'],
    ['otros',            'REAL'],
    ['profit',           'REAL'],
    ['porcentaje',       'REAL'],
    // Desglose de extras por tipo (array reconciliado JSON; ver desglosarCosto)
    ['extras_json',      'TEXT'],
    ['destino_raw',      'TEXT'],
    ['direccion',        "TEXT DEFAULT 'expo'"],
    // Flag "envío número 0": 1 = envío raro que se muestra con #Sal 0, va arriba de
    // todos y no consume número correlativo. El renumerado es del frontend.
    ['num_sal_cero',     'INTEGER DEFAULT 0'],
    // Columnas módulo Control de Facturas
    ['costo_facturado',  'REAL'],
    ['peso_facturado',   'REAL'],
    ['courier_facturado','TEXT'],
    ['fecha_facturado',  'TEXT'],
    ['estado_revision',  'TEXT'],
    ['servicio_ups',     'TEXT'],
  ];
  for (const [col, def] of toAdd) {
    if (!cols.includes(col)) {
      await dbApi.exec(`ALTER TABLE envios ADD COLUMN ${col} ${def}`);
    }
  }
}

async function migrateEnvioBultos() {
  const cols = (await dbApi.prepare('PRAGMA table_info(envio_bultos)').all()).map((c) => c.name);
  const toAdd = [
    ['numero_guia', 'TEXT'],
    // Semáforo de estado de caja por bulto: 'rojo' | 'amarillo' | 'verde' | NULL.
    // NULL se interpreta como rojo (nunca escaneada) en la lectura; sin DEFAULT.
    ['estado_caja', 'TEXT'],
  ];
  for (const [col, def] of toAdd) {
    if (!cols.includes(col)) {
      await dbApi.exec(`ALTER TABLE envio_bultos ADD COLUMN ${col} ${def}`);
    }
  }
}

async function migrateCuadrantes() {
  const cols = (await dbApi.prepare('PRAGMA table_info(cuadrantes)').all()).map((c) => c.name);
  const toAdd = [
    // Vínculo opcional a un pickup standalone (mutuamente excluyente con envio_origen_id).
    // SQLite no permite agregar FK por ALTER; basta la columna INTEGER.
    ['pickup_id', 'INTEGER'],
  ];
  for (const [col, def] of toAdd) {
    if (!cols.includes(col)) {
      await dbApi.exec(`ALTER TABLE cuadrantes ADD COLUMN ${col} ${def}`);
    }
  }
}

async function migrateConfiguracion() {
  const cols = (await dbApi.prepare('PRAGMA table_info(configuracion)').all()).map((c) => c.name);
  if (!cols.includes('ganancia_minima_pct')) {
    await dbApi.exec('ALTER TABLE configuracion ADD COLUMN ganancia_minima_pct REAL DEFAULT 20');
  }
}

// Matriz de profit por cliente. Cada fila es un override sobre el escalar
// clientes.tarifa_pct, resuelto por precedencia celda > banda > zona > tabla > cliente
// (ver services/profit.service.js). La banda se guarda como par numérico peso_min/peso_max
// (ej 5 y 10; la banda 50+ es peso_min 50, peso_max NULL). zona/peso_min NULL modelan
// los niveles menos específicos. UNIQUE por las coordenadas para poder upsertear.
async function migrateProfitOverrides() {
  await dbApi.exec(`
    CREATE TABLE IF NOT EXISTS profit_overrides (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      servicio   TEXT NOT NULL CHECK (servicio IN ('DHL', 'UPS_EXP', 'UPS_SAVER')),
      tipo       TEXT NOT NULL CHECK (tipo IN ('export', 'import')),
      zona       INTEGER CHECK (zona IS NULL OR (zona BETWEEN 1 AND 6)),
      peso_min   REAL,
      peso_max   REAL,
      profit_pct REAL NOT NULL,
      UNIQUE (cliente_id, servicio, tipo, zona, peso_min)
    )
  `);
  await dbApi.exec(
    'CREATE INDEX IF NOT EXISTS idx_profit_overrides_cliente ON profit_overrides(cliente_id)'
  );
}

// Detalle por guía de cada factura UPS cargada (módulo Control de Facturas).
// Idempotente para bases existentes en el VPS; ver schema.sql para la definición
// canónica y la explicación de cada columna.
async function migrateFacturaGuias() {
  await dbApi.exec(`
    CREATE TABLE IF NOT EXISTS factura_guias (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      factura_id      INTEGER REFERENCES facturas_cargadas(id) ON DELETE CASCADE,
      envio_id        INTEGER REFERENCES envios(id) ON DELETE SET NULL,
      numero_guia     TEXT NOT NULL,
      pais            TEXT,
      peso_facturado  REAL,
      neto            REAL,
      total_recargos  REAL,
      costo_total     REAL,
      cargos_json     TEXT,
      encontrada      INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);
  await dbApi.exec('CREATE INDEX IF NOT EXISTS idx_factura_guias_factura ON factura_guias(factura_id)');
  await dbApi.exec('CREATE INDEX IF NOT EXISTS idx_factura_guias_envio   ON factura_guias(envio_id)');
  await dbApi.exec('CREATE INDEX IF NOT EXISTS idx_factura_guias_guia    ON factura_guias(numero_guia)');
}

async function initSchema() {
  const schema = fs.readFileSync(config.schemaPath, 'utf8');
  await dbApi.exec(schema);
  await migrateClientes();
  await migratePickups();
  await migrateEnvios();
  await migrateEnvioBultos();
  await migrateCuadrantes();
  await migrateConfiguracion();
  await migrateProfitOverrides();
  await migrateFacturaGuias();
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
