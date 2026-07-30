-- Nova Express — Esquema completo (SQLite)
-- Este archivo refleja el estado real de la base de datos incluyendo
-- todas las columnas que antes se agregaban vía migraciones en db/index.js.

PRAGMA foreign_keys = ON;

-- Clientes
CREATE TABLE IF NOT EXISTS clientes (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre               TEXT NOT NULL UNIQUE,
  nombre_nova          TEXT,
  tipo_cobro           TEXT NOT NULL CHECK (tipo_cobro IN ('D', 'S', 'Q', 'CC')),
  tarifa_especial      TEXT,
  activo               INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  cuit                 TEXT,
  direccion_recoleccion TEXT,
  contacto             TEXT,
  email                TEXT,
  whatsapp             TEXT,
  codigo_postal        TEXT,
  localidad            TEXT,
  tipo_facturacion     TEXT DEFAULT 'Responsable inscripto',
  tarifa_pct           REAL DEFAULT 0
);

-- Configuración por courier (fuel y umbrales de negocio)
CREATE TABLE IF NOT EXISTS configuracion (
  courier              TEXT PRIMARY KEY CHECK (courier IN ('DHL', 'UPS')),
  fuel_pct             REAL NOT NULL,
  fecha_actualizacion  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  ganancia_minima_pct  REAL DEFAULT 20,
  -- Desvío máximo aceptable (%) al comparar contra la factura del courier: si facturó
  -- MÁS peso/costo que lo nuestro y el desvío supera la tolerancia, se pinta en rojo.
  tolerancia_peso_pct  REAL DEFAULT 10,
  tolerancia_costo_pct REAL DEFAULT 10,
  -- Segundo disparador del semáforo por MONTO ABSOLUTO (USD/kg), independiente del %.
  -- Alcanza con superar UNO de los dos umbrales (% o absoluto) para pintar rojo.
  tolerancia_costo_usd REAL DEFAULT 50,
  tolerancia_peso_kg   REAL DEFAULT 5
);

CREATE TABLE IF NOT EXISTS configuracion_historial (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  courier          TEXT NOT NULL CHECK (courier IN ('DHL', 'UPS')),
  fuel_pct_anterior REAL NOT NULL,
  fuel_pct_nuevo   REAL NOT NULL,
  fecha_cambio     TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS configuracion_ganancia_historial (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  courier                 TEXT NOT NULL CHECK (courier IN ('DHL', 'UPS')),
  ganancia_pct_anterior   REAL NOT NULL,
  ganancia_pct_nuevo      REAL NOT NULL,
  fecha_cambio            TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Liquidaciones (cabecera) — antes de envios por FK opcional
CREATE TABLE IF NOT EXISTS liquidaciones (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id     INTEGER NOT NULL,
  periodo_desde  TEXT NOT NULL,
  periodo_hasta  TEXT NOT NULL,
  fecha          TEXT NOT NULL DEFAULT (date('now', 'localtime')),
  total          REAL NOT NULL DEFAULT 0,
  estado         TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'confirmada')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (cliente_id) REFERENCES clientes(id)
);

-- Envíos
CREATE TABLE IF NOT EXISTS envios (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id          INTEGER NOT NULL,
  fecha               TEXT NOT NULL,
  courier             TEXT NOT NULL CHECK (courier IN ('DHL', 'UPS')),
  tipo_envio          TEXT NOT NULL CHECK (tipo_envio IN ('exportacion', 'importacion')),
  numero_guia         TEXT NOT NULL,
  pais_destino        TEXT NOT NULL,
  zona                TEXT,
  cantidad_bultos     INTEGER NOT NULL DEFAULT 1,
  peso_real           REAL NOT NULL,
  largo               REAL,
  ancho               REAL,
  alto                REAL,
  peso_volumetrico    REAL NOT NULL DEFAULT 0,
  peso_facturable     REAL NOT NULL DEFAULT 0,
  fob                 REAL NOT NULL DEFAULT 0,
  total_cobrado       REAL NOT NULL DEFAULT 0,
  observaciones       TEXT,
  liquidado           INTEGER NOT NULL DEFAULT 0,
  fecha_liquidacion   TEXT,
  liquidacion_id      INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  -- Operaciones
  estado_operativo    TEXT DEFAULT 'pendiente',
  check_datos         INTEGER DEFAULT 0,
  check_guia          INTEGER DEFAULT 0,
  check_proforma      INTEGER DEFAULT 0,
  check_despachado    INTEGER DEFAULT 0,
  titulo              TEXT,
  -- Salidas
  numero_salida       INTEGER,
  bulto               TEXT,
  tipo_paquete        TEXT,
  asegurado           INTEGER DEFAULT 0,
  ddp                 INTEGER DEFAULT 0,
  remota              INTEGER DEFAULT 0,
  entrega             TEXT,
  flete               REAL,
  descuento           REAL,
  seguro              REAL,
  fuel                REAL,
  fuel_pct            REAL,
  derechos            REAL,
  adicionales         REAL,
  otros               REAL,
  profit              REAL,
  porcentaje          REAL,
  extras_json         TEXT,
  destino_raw         TEXT,
  direccion           TEXT DEFAULT 'expo',
  -- Flag "envío número 0": 1 = envío raro que se muestra con #Sal 0, va arriba de
  -- todos y no consume número correlativo. El renumerado es del frontend; acá solo
  -- persiste el flag.
  num_sal_cero        INTEGER DEFAULT 0,
  -- Control de Facturas
  costo_facturado     REAL,
  peso_facturado      REAL,
  courier_facturado   TEXT,
  fecha_facturado     TEXT,
  estado_revision     TEXT,
  servicio_ups        TEXT,
  FOREIGN KEY (cliente_id) REFERENCES clientes(id),
  FOREIGN KEY (liquidacion_id) REFERENCES liquidaciones(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_envios_numero_guia ON envios(numero_guia);

-- Dimensiones por bulto (opcional, para múltiples bultos)
CREATE TABLE IF NOT EXISTS envio_bultos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  envio_id         INTEGER NOT NULL,
  numero_bulto     INTEGER NOT NULL,
  peso_real        REAL,
  largo            REAL NOT NULL,
  ancho            REAL NOT NULL,
  alto             REAL NOT NULL,
  peso_volumetrico REAL NOT NULL DEFAULT 0,
  numero_guia      TEXT,
  estado_caja      TEXT,
  FOREIGN KEY (envio_id) REFERENCES envios(id) ON DELETE CASCADE,
  UNIQUE (envio_id, numero_bulto)
);

-- Líneas de liquidación por envío
CREATE TABLE IF NOT EXISTS liquidacion_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  liquidacion_id   INTEGER NOT NULL,
  envio_id         INTEGER NOT NULL,
  flete            REAL NOT NULL DEFAULT 0,
  fuel             REAL NOT NULL DEFAULT 0,
  seguro           REAL NOT NULL DEFAULT 0,
  adicional        REAL NOT NULL DEFAULT 0,
  total_usd        REAL NOT NULL DEFAULT 0,
  fuel_pct_usado   REAL NOT NULL,
  precio_cotizado  REAL,
  profit_pct       REAL,
  utilidad_usd     REAL,
  servicio_cotizado TEXT,
  FOREIGN KEY (liquidacion_id) REFERENCES liquidaciones(id) ON DELETE CASCADE,
  FOREIGN KEY (envio_id) REFERENCES envios(id),
  UNIQUE (liquidacion_id, envio_id)
);

-- Cargos adicionales por envío (en liquidación o pendientes)
CREATE TABLE IF NOT EXISTS cargos_adicionales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  envio_id       INTEGER NOT NULL,
  liquidacion_id INTEGER,
  descripcion    TEXT NOT NULL,
  monto          REAL NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (envio_id) REFERENCES envios(id) ON DELETE CASCADE,
  FOREIGN KEY (liquidacion_id) REFERENCES liquidaciones(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_envios_cliente    ON envios(cliente_id);
CREATE INDEX IF NOT EXISTS idx_envios_fecha      ON envios(fecha);
CREATE INDEX IF NOT EXISTS idx_envios_liquidado  ON envios(liquidado);
CREATE INDEX IF NOT EXISTS idx_liquidaciones_cliente ON liquidaciones(cliente_id);

-- Direcciones adicionales de recolección por cliente
CREATE TABLE IF NOT EXISTS cliente_direcciones (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  direccion  TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- Pickups / retiros
CREATE TABLE IF NOT EXISTS pickups (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id       INTEGER NOT NULL REFERENCES clientes(id),
  cliente_nombre   TEXT NOT NULL,
  direccion        TEXT NOT NULL,
  fecha            TEXT NOT NULL,
  hora_inicio      TEXT NOT NULL,
  hora_fin         TEXT NOT NULL,
  notas            TEXT,
  created_at       TEXT DEFAULT (datetime('now','localtime')),
  estado           TEXT DEFAULT 'pendiente',
  check_datos         INTEGER DEFAULT 0,
  check_guia          INTEGER DEFAULT 0,
  check_proforma      INTEGER DEFAULT 0,
  check_despachado    INTEGER DEFAULT 0,
  courier             TEXT,
  confirmado_ricardo  TEXT,
  confirmado_juanqui  TEXT,
  en_deposito_at      TEXT,
  recolector          TEXT,
  visto_juanqui_at    TEXT,
  tiene_cobro         INTEGER DEFAULT 0,
  tipo_recoleccion    TEXT DEFAULT 'normal',
  titulo              TEXT,
  llevar_plata             INTEGER DEFAULT 0,
  mostrar_en_operaciones   INTEGER DEFAULT 1
);

-- Cuadrantes: "envíos manuales" que operaciones crea copiando el cliente de un
-- envío existente, para trackear por separado un segundo envío del mismo cliente
-- en un mismo pickup. Persisten, tienen los 4 checks y se arrastran como rezagados.
CREATE TABLE IF NOT EXISTS cuadrantes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id        INTEGER NOT NULL REFERENCES clientes(id),
  envio_origen_id   INTEGER REFERENCES envios(id),
  pickup_id         INTEGER REFERENCES pickups(id),
  titulo            TEXT,
  fecha             TEXT NOT NULL,
  check_datos       INTEGER DEFAULT 0,
  check_guia        INTEGER DEFAULT 0,
  check_proforma    INTEGER DEFAULT 0,
  check_despachado  INTEGER DEFAULT 0,
  estado_operativo  TEXT DEFAULT 'en_deposito',
  created_at        TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_cuadrantes_fecha  ON cuadrantes(fecha);

-- Historial de facturas cargadas (módulo Control de Facturas)
CREATE TABLE IF NOT EXISTS facturas_cargadas (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  courier               TEXT NOT NULL DEFAULT 'UPS',
  numero_factura        TEXT,
  fecha_factura         TEXT,
  fecha_carga           TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  cantidad_guias        INTEGER NOT NULL DEFAULT 0,
  guias_cruzadas        INTEGER NOT NULL DEFAULT 0,
  guias_no_encontradas  INTEGER NOT NULL DEFAULT 0,
  usuario               TEXT DEFAULT NULL
);

-- Detalle por guía de cada factura cargada (módulo Control de Facturas).
-- Persiste lo que UPS facturó por guía: peso, neto, recargos desglosados y costo
-- total. envio_id es NULL cuando la guía no matcheó ningún envío del sistema
-- (guías "no encontradas"), que igual quedan registradas para revisión.
CREATE TABLE IF NOT EXISTS factura_guias (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  factura_id      INTEGER REFERENCES facturas_cargadas(id) ON DELETE CASCADE,
  envio_id        INTEGER REFERENCES envios(id) ON DELETE SET NULL,
  numero_guia     TEXT NOT NULL,
  pais            TEXT,
  peso_facturado  REAL,
  neto            REAL,
  total_recargos  REAL,
  percepcion      REAL,
  costo_total     REAL,
  cargos_json     TEXT,   -- [{ "nombre": ..., "monto": ... }, ...] desglose de recargos UPS
  encontrada      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_factura_guias_factura ON factura_guias(factura_id);
CREATE INDEX IF NOT EXISTS idx_factura_guias_envio   ON factura_guias(envio_id);
CREATE INDEX IF NOT EXISTS idx_factura_guias_guia    ON factura_guias(numero_guia);

-- Cobranzas: registro/log informativo de la plata que se levanta de los clientes.
-- NO se vincula con liquidaciones, saldos ni cuenta corriente; es puro asiento para
-- tener trazabilidad de lo cobrado. pickup_id es opcional (si la cobranza vino de un
-- pickup) y queda en NULL si el pickup se borra. La moneda no se mezcla: ARS y USD se
-- totalizan por separado a nivel de reporte.
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
);

CREATE INDEX IF NOT EXISTS idx_cobranzas_cliente ON cobranzas(cliente_id);
CREATE INDEX IF NOT EXISTS idx_cobranzas_fecha   ON cobranzas(fecha);
CREATE INDEX IF NOT EXISTS idx_cobranzas_pickup  ON cobranzas(pickup_id);

-- Índices sobre las consultas más calientes (ver migrateIndices() en db/index.js).
-- Sin estos, la pantalla de Operaciones del día, el borrado de un envío y la bandeja
-- de revisión de facturas hacen un scan completo de su tabla en cada request.
CREATE INDEX IF NOT EXISTS idx_pickups_fecha           ON pickups(fecha);
CREATE INDEX IF NOT EXISTS idx_liquidacion_items_envio ON liquidacion_items(envio_id);
CREATE INDEX IF NOT EXISTS idx_envios_estado_revision  ON envios(estado_revision);
CREATE INDEX IF NOT EXISTS idx_envio_bultos_guia       ON envio_bultos(numero_guia);
CREATE INDEX IF NOT EXISTS idx_cuadrantes_pickup       ON cuadrantes(pickup_id);

-- Una guía no puede repetirse dentro del detalle de la misma factura.
CREATE UNIQUE INDEX IF NOT EXISTS uq_factura_guias_factura_guia ON factura_guias(factura_id, numero_guia);

-- Matriz de profit por cliente. Cada fila es un override sobre el escalar
-- clientes.tarifa_pct, resuelto por precedencia celda > banda > zona > tabla > cliente
-- (ver services/profit.service.js). La banda se guarda como par numérico peso_min/peso_max
-- (ej 5 y 10; la banda 50+ es peso_min 50, peso_max NULL). zona/peso_min NULL modelan
-- los niveles menos específicos. UNIQUE por las coordenadas para poder upsertear.
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
);

CREATE INDEX IF NOT EXISTS idx_profit_overrides_cliente ON profit_overrides(cliente_id);

-- Fuel inicial DHL y UPS al 39.5%
INSERT OR IGNORE INTO configuracion (courier, fuel_pct) VALUES ('DHL', 39.5);
INSERT OR IGNORE INTO configuracion (courier, fuel_pct) VALUES ('UPS', 39.5);

-- Autenticación
CREATE TABLE IF NOT EXISTS usuarios (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario        TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  rol            TEXT NOT NULL DEFAULT 'empleado' CHECK(rol IN ('admin','empleado')),
  ver_dashboard  INTEGER NOT NULL DEFAULT 0,
  editar_config  INTEGER NOT NULL DEFAULT 0,
  activo         INTEGER NOT NULL DEFAULT 1,
  creado_en      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sesiones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT UNIQUE NOT NULL,
  usuario_id  INTEGER NOT NULL,
  creado_en   TEXT DEFAULT (datetime('now')),
  expira_en   TEXT NOT NULL,
  FOREIGN KEY(usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);
