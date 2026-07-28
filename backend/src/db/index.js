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

// ── Transacciones serializadas ──────────────────────────────────────────────
// Toda la app comparte UNA sola conexión sqlite3 (`rawDb`). BEGIN/COMMIT/ROLLBACK
// son estado global de esa conexión, y los handlers son async: sin una cola, los
// statements de dos requests simultáneos se intercalan DENTRO de la misma
// transacción. Consecuencias reales observadas al reproducirlo:
//
//   · el segundo BEGIN falla con "cannot start a transaction within a transaction";
//   · el ROLLBACK del que falla aborta la transacción del que iba bien, y el
//     usuario que ya recibió 200 OK pierde lo que guardó.
//
// `txQueue` encadena las transacciones: cada llamada espera a que termine la
// anterior antes de emitir su BEGIN. La cola guarda siempre una promesa YA
// resuelta o rechazada-y-atrapada, así que un fallo no la deja envenenada para
// las siguientes.
//
// Nota: esto serializa solo las transacciones, no las lecturas sueltas. Las
// operaciones largas (importación de Excel) hacen esperar a las demás — eso es
// correcto y preferible a perder escrituras. El arreglo de fondo es una conexión
// por request; esto cierra el agujero sin reescribir la capa de acceso.
let txQueue = Promise.resolve();

function transaction(fn) {
  const result = txQueue.then(async () => {
    await run('BEGIN TRANSACTION');
    try {
      const value = await fn();
      await run('COMMIT');
      return value;
    } catch (e) {
      // Si el ROLLBACK también falla (conexión caída, transacción ya abortada por
      // SQLite) no lo dejamos tapar el error original, que es el que explica qué pasó.
      try {
        await run('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[db] ROLLBACK falló tras un error de transacción:', rollbackErr.message);
      }
      throw e;
    }
  });

  // La cola avanza pase lo que pase; el catch acá evita un unhandled rejection
  // y evita que un fallo bloquee a las transacciones siguientes. El error real
  // se propaga por `result`, que es lo que recibe quien llamó.
  txQueue = result.then(
    () => undefined,
    () => undefined
  );

  return result;
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
    ['remota',           'INTEGER DEFAULT 0'],
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
  // Tolerancias de comparación con la factura del courier (módulo Control de Facturas /
  // Salidas). Desvío máximo aceptable en %: si el courier facturó MÁS peso/costo que lo
  // nuestro y el desvío supera la tolerancia, la celda se pinta en rojo. Solo alertamos
  // cuando el desvío va en contra nuestra (facturó de más).
  if (!cols.includes('tolerancia_peso_pct')) {
    await dbApi.exec('ALTER TABLE configuracion ADD COLUMN tolerancia_peso_pct REAL DEFAULT 10');
  }
  if (!cols.includes('tolerancia_costo_pct')) {
    await dbApi.exec('ALTER TABLE configuracion ADD COLUMN tolerancia_costo_pct REAL DEFAULT 10');
  }
  // Segundo disparador del semáforo por MONTO ABSOLUTO (independiente del %): si el desvío
  // en contra nuestra supera estos umbrales en USD/kg, se pinta rojo aunque el % no llegue.
  // Alcanza con superar UNO de los dos (% o absoluto) para pintar. Atrapa el envío grande
  // donde un desvío chico en % es mucha plata.
  if (!cols.includes('tolerancia_costo_usd')) {
    await dbApi.exec('ALTER TABLE configuracion ADD COLUMN tolerancia_costo_usd REAL DEFAULT 50');
  }
  if (!cols.includes('tolerancia_peso_kg')) {
    await dbApi.exec('ALTER TABLE configuracion ADD COLUMN tolerancia_peso_kg REAL DEFAULT 5');
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

// Permisos por usuario. editar_config habilita entrar y guardar en Configuración
// sin ser admin (regla admin OR editar_config); ver middleware requireConfig.
// Idempotente para bases existentes en el VPS; DEFAULT 0 deja a los empleados sin
// acceso hasta que un admin se los otorgue.
async function migrateUsuarios() {
  const cols = (await dbApi.prepare('PRAGMA table_info(usuarios)').all()).map((c) => c.name);
  const toAdd = [
    ['editar_config', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [col, def] of toAdd) {
    if (!cols.includes(col)) {
      await dbApi.exec(`ALTER TABLE usuarios ADD COLUMN ${col} ${def}`);
    }
  }
}

// Registro/log informativo de cobranzas a clientes (módulo Cobranzas). NO se vincula
// con liquidaciones, saldos ni cuenta corriente; es puro asiento. Idempotente para
// bases existentes en el VPS; ver schema.sql para la definición canónica.
async function migrateCobranzas() {
  await dbApi.exec(`
    CREATE TABLE IF NOT EXISTS cobranzas (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id  INTEGER NOT NULL REFERENCES clientes(id),
      fecha       TEXT NOT NULL,
      monto       REAL NOT NULL,
      moneda      TEXT NOT NULL DEFAULT 'ARS' CHECK (moneda IN ('ARS','USD')),
      forma_pago  TEXT NOT NULL CHECK (forma_pago IN ('efectivo','cheque','transferencia','otro')),
      pickup_id   INTEGER REFERENCES pickups(id) ON DELETE SET NULL,
      nota        TEXT,
      usuario     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `);
  await dbApi.exec('CREATE INDEX IF NOT EXISTS idx_cobranzas_cliente ON cobranzas(cliente_id)');
  await dbApi.exec('CREATE INDEX IF NOT EXISTS idx_cobranzas_fecha   ON cobranzas(fecha)');
  await dbApi.exec('CREATE INDEX IF NOT EXISTS idx_cobranzas_pickup  ON cobranzas(pickup_id)');
}

// Índices que faltaban sobre las consultas que ya están en producción. Todos son
// CREATE INDEX IF NOT EXISTS: correr esto de nuevo no hace nada y no cambia ningún
// resultado, solo el plan de ejecución. Verificado con EXPLAIN QUERY PLAN contra la
// base real: sin estos, cada consulta hace un scan completo de la tabla.
//
//   pickups(fecha)              -> pantalla de Operaciones del día y rezagados
//   liquidacion_items(envio_id) -> borrado de envío (el UNIQUE existente arranca por
//                                  liquidacion_id, así que no sirve para buscar por envío)
//   envios(estado_revision)     -> bandeja de revisión de facturas
//   envio_bultos(numero_guia)   -> búsqueda de guía por bulto en multi-bulto
//   cuadrantes(pickup_id)       -> cuadrantes de un pickup
//
// NO se agrega acá el índice único que impediría que un mismo envío entre en dos
// liquidaciones: la base de producción HOY tiene dos casos (envíos 31 y 147, cada uno
// en un borrador y en una confirmada). Crear ese índice ahora haría fallar el arranque
// del servidor. Primero hay que limpiar esos dos borradores; recién después se agrega.
async function migrateIndices() {
  await dbApi.exec('CREATE INDEX IF NOT EXISTS idx_pickups_fecha            ON pickups(fecha)');
  await dbApi.exec('CREATE INDEX IF NOT EXISTS idx_liquidacion_items_envio  ON liquidacion_items(envio_id)');
  await dbApi.exec('CREATE INDEX IF NOT EXISTS idx_envios_estado_revision   ON envios(estado_revision)');
  await dbApi.exec('CREATE INDEX IF NOT EXISTS idx_envio_bultos_guia        ON envio_bultos(numero_guia)');
  await dbApi.exec('CREATE INDEX IF NOT EXISTS idx_cuadrantes_pickup        ON cuadrantes(pickup_id)');

  // Único: una guía no puede aparecer dos veces en el detalle de la MISMA factura.
  // Junto con el INSERT OR IGNORE de facturas.routes.js evita que un reintento deje
  // el ledger con el doble de filas que las que declara la cabecera.
  // Seguro de crear: `factura_guias` está vacía en producción (el módulo no se estrenó).
  // Si alguna vez tuviera duplicados, esta línea haría fallar el arranque — en ese caso
  // hay que limpiarlos primero.
  await dbApi.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_factura_guias_factura_guia ON factura_guias(factura_id, numero_guia)'
  );
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
  await migrateUsuarios();
  await migrateProfitOverrides();
  await migrateFacturaGuias();
  await migrateCobranzas();
  await migrateIndices();
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
