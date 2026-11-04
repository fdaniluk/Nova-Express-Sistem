// Cargos posteriores de un envío (25/09/2026). Pedido de Felipe: poder agregar extracargos
// desde Salidas una vez que el envío ya está cargado, y que los impuestos DDP que factura
// UPS meses después se le cobren al cliente solos.
//
// Regla (confirmada por Felipe):
//   · Si el envío todavía NO está en una liquidación confirmada, el cargo entra en la
//     liquidación del envío como una línea más de su Adicional (con su nombre).
//   · Si el envío YA está liquidado, el cargo queda PENDIENTE y aparece automáticamente en
//     la próxima liquidación que se le haga al cliente, en la sección "Cargos de envíos
//     anteriores" (guía, fecha del envío, concepto, importe), en pantalla y en el Excel.
//
// Todo cargo va AL COSTO: no lleva profit. La utilidad del envío no cambia.
//
// Tabla envio_cargos: liquidacion_id NULL = pendiente; con valor = ya incluido en esa
// liquidación (borrador o confirmada; si el borrador se borra, vuelve a NULL).
// anulado_at = la oficina lo dio de baja (solo se puede mientras está pendiente).
//
// Cargos SIN envío (30/10/2026, pedido de Felipe): llega un extracargo de una guía que no
// está en el sistema (de antes de arrancar, o cargada por afuera). Se carga a mano al
// CLIENTE (envio_id NULL, cliente_id, nº de guía como texto, PDF del courier opcional) y
// entra en la próxima liquidación del cliente dentro de "Cargos de envíos anteriores",
// igual que los cargos de envíos ya liquidados. Al costo, anulable mientras está pendiente.
const { getDb } = require('../db');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const ahora = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });

// Tipos que ofrece Salidas. "otro" lleva el nombre que escriba la oficina.
const TIPOS = {
  manejo: 'Cargo por manejo',
  sobrepeso: 'Sobrepeso',
  mayor_tamano: 'Paquete de mayor tamaño',
  remota: 'Área remota',
  residencial: 'Entrega residencial',
  ddp: 'Impuestos de destino (DDP)',
  // Diferencia de fuel (04/11/2026, pedido de Felipe): UPS facturó más combustible que el
  // calculado. En la liquidación NO va como extracargo (el cliente leería que se le cobró el
  // fuel dos veces): se suma a la columna FUEL del envío. Si el envío ya estaba liquidado,
  // va en "Cargos de envíos anteriores" como cualquier cargo tardío.
  fuel: 'Diferencia de fuel',
  otro: 'Otro cargo',
};
const LABEL_IMPUESTOS = 'Impuestos de destino (DDP)';

// ¿Es un cargo de fuel? Por tipo, o por nombre para los que la oficina cargó como "Otro"
// con el nombre "Fuel" antes de que existiera el tipo.
function esFuel(c) {
  if (!c) return false;
  if (c.tipo === 'fuel') return true;
  return /^\s*(diferencia\s+(de\s+)?)?(fuel|combustible)\b/i.test(String(c.label || ''));
}

// dd/mm/aaaa para los rótulos de cara al cliente.
function fechaCorta(f) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(f || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(f || '');
}

// Rótulo completo del cargo (05/10/2026, pedido de Felipe): en la liquidación y en el
// Excel tiene que quedar claro QUÉ cargo es, de QUÉ envío y de CUÁNDO, tanto si entra en
// el detalle de un envío de la misma liquidación como si va en "Cargos de envíos
// anteriores". Ej.: "Sobrepeso · informado el 15/08/2026 · envío 1Z… del 12/07/2026".
function rotulo(c, { conEnvio = false } = {}) {
  let t = c.label || 'Cargo';
  if (c.fecha) t += ` · informado el ${fechaCorta(c.fecha)}`;
  if (conEnvio && c.numero_guia) t += ` · envío ${c.numero_guia}${c.envio_fecha ? ' del ' + fechaCorta(c.envio_fecha) : ''}`;
  return t;
}

// Columnas de la tabla (la versión 30/10: envio_id puede ser NULL para los cargos sin envío).
const DDL_ENVIO_CARGOS = (nombre) => `
    CREATE TABLE IF NOT EXISTS ${nombre} (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      envio_id       INTEGER REFERENCES envios(id) ON DELETE CASCADE,
      cliente_id     INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
      guia_texto     TEXT,
      adjunto_nombre TEXT,
      adjunto        BLOB,
      tipo           TEXT NOT NULL,
      label          TEXT NOT NULL,
      monto          REAL NOT NULL,
      origen         TEXT NOT NULL DEFAULT 'manual' CHECK (origen IN ('manual','impuestos_ddp')),
      fecha          TEXT NOT NULL,
      creado_por     TEXT,
      creado_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      liquidacion_id INTEGER REFERENCES liquidaciones(id) ON DELETE SET NULL,
      anulado_at     TEXT,
      anulado_por    TEXT,
      CHECK (envio_id IS NOT NULL OR cliente_id IS NOT NULL)
    )`;

async function migrar(db = getDb()) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS envio_cargos (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      envio_id       INTEGER NOT NULL REFERENCES envios(id) ON DELETE CASCADE,
      tipo           TEXT NOT NULL,
      label          TEXT NOT NULL,
      monto          REAL NOT NULL,
      origen         TEXT NOT NULL DEFAULT 'manual' CHECK (origen IN ('manual','impuestos_ddp')),
      fecha          TEXT NOT NULL,
      creado_por     TEXT,
      creado_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      liquidacion_id INTEGER REFERENCES liquidaciones(id) ON DELETE SET NULL,
      anulado_at     TEXT,
      anulado_por    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_envio_cargos_envio ON envio_cargos(envio_id);
    CREATE INDEX IF NOT EXISTS idx_envio_cargos_liq ON envio_cargos(liquidacion_id);
  `);
  // 30/10: envio_id pasa a admitir NULL (cargos sin envío) y se agregan cliente_id,
  // guia_texto y el adjunto. SQLite no cambia un NOT NULL con ALTER: se rehace la tabla
  // copiando las filas (los ids se conservan: las liquidaciones los referencian).
  const cols = await db.prepare('PRAGMA table_info(envio_cargos)').all();
  const envioCol = cols.find((c) => c.name === 'envio_id');
  if (envioCol && envioCol.notnull) {
    await db.exec(`
      ${DDL_ENVIO_CARGOS('envio_cargos_v2')};
      INSERT INTO envio_cargos_v2 (id, envio_id, tipo, label, monto, origen, fecha, creado_por, creado_at, liquidacion_id, anulado_at, anulado_por)
        SELECT id, envio_id, tipo, label, monto, origen, fecha, creado_por, creado_at, liquidacion_id, anulado_at, anulado_por FROM envio_cargos;
      DROP TABLE envio_cargos;
      ALTER TABLE envio_cargos_v2 RENAME TO envio_cargos;
      CREATE INDEX IF NOT EXISTS idx_envio_cargos_envio ON envio_cargos(envio_id);
      CREATE INDEX IF NOT EXISTS idx_envio_cargos_liq ON envio_cargos(liquidacion_id);
      CREATE INDEX IF NOT EXISTS idx_envio_cargos_cliente ON envio_cargos(cliente_id);
    `);
  }
  // Una sola vez: los envíos que ya tenían impuestos DDP facturados (entrega 1 de DDP)
  // pasan a tener su cargo pendiente, así entran en la próxima liquidación del cliente.
  // Si alguno ya se le cobró al cliente por afuera, la oficina lo anula desde Salidas.
  await db.exec(`CREATE TABLE IF NOT EXISTS migraciones_una_vez (clave TEXT PRIMARY KEY, hecho_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))`);
  const hecho = await db.prepare("SELECT 1 FROM migraciones_una_vez WHERE clave = 'envio_cargos_impuestos'").get();
  if (!hecho) {
    await db.prepare(
      `INSERT INTO envio_cargos (envio_id, tipo, label, monto, origen, fecha, creado_por)
       SELECT e.id, 'ddp', ?, e.impuestos_facturados, 'impuestos_ddp', COALESCE(e.impuestos_fecha, date('now','localtime')), 'sistema'
       FROM envios e
       WHERE e.impuestos_facturados IS NOT NULL AND e.impuestos_facturados > 0
         AND NOT EXISTS (SELECT 1 FROM envio_cargos c WHERE c.envio_id = e.id AND c.origen = 'impuestos_ddp')`
    ).run(LABEL_IMPUESTOS);
    await db.prepare("INSERT INTO migraciones_una_vez (clave) VALUES ('envio_cargos_impuestos')").run();
  }
}

function mapCargo(c) {
  return {
    id: c.id, envio_id: c.envio_id, tipo: c.tipo, label: c.label, monto: r2(c.monto), origen: c.origen,
    // Cargo sin envío (30/10): a qué cliente, qué guía dijo la oficina y si tiene PDF.
    sin_envio: !c.envio_id, cliente_id: c.cliente_id || null, guia_texto: c.guia_texto || null,
    adjunto_nombre: c.adjunto_nombre || null,
    fecha: c.fecha, creado_por: c.creado_por, creado_at: c.creado_at,
    liquidacion_id: c.liquidacion_id, liquidacion_estado: c.liquidacion_estado || null,
    anulado_at: c.anulado_at, anulado_por: c.anulado_por,
    estado: c.anulado_at ? 'anulado' : (c.liquidacion_id ? 'liquidado' : 'pendiente'),
  };
}

// Sin el BLOB del adjunto: se pide aparte (adjuntoDe).
const COLS = 'c.id, c.envio_id, c.cliente_id, c.guia_texto, c.adjunto_nombre, c.tipo, c.label, c.monto, c.origen, c.fecha, c.creado_por, c.creado_at, c.liquidacion_id, c.anulado_at, c.anulado_por';
const SQL_BASE = `SELECT ${COLS}, l.estado AS liquidacion_estado FROM envio_cargos c LEFT JOIN liquidaciones l ON l.id = c.liquidacion_id`;

async function listarDeEnvio(envioId, db = getDb()) {
  const rows = await db.prepare(`${SQL_BASE} WHERE c.envio_id = ? ORDER BY c.id`).all(envioId);
  return rows.map(mapCargo);
}

// Todos los cargos de una lista de envíos, agrupados por envío (para la grilla de Salidas).
async function porEnvios(envioIds, db = getDb()) {
  const out = new Map();
  if (!envioIds.length) return out;
  const LOTE = 500;
  for (let i = 0; i < envioIds.length; i += LOTE) {
    const ids = envioIds.slice(i, i + LOTE);
    const rows = await db.prepare(`${SQL_BASE} WHERE c.envio_id IN (${ids.map(() => '?').join(',')}) ORDER BY c.id`).all(...ids);
    for (const r of rows) {
      if (!out.has(r.envio_id)) out.set(r.envio_id, []);
      out.get(r.envio_id).push(mapCargo(r));
    }
  }
  return out;
}

// Pendientes (sin liquidación y sin anular) de estos envíos → { envio_id: [cargos] }.
async function pendientesDeEnvios(envioIds, db = getDb()) {
  const out = {};
  if (!envioIds || !envioIds.length) return out;
  const rows = await db.prepare(
    `SELECT ${COLS} FROM envio_cargos c WHERE envio_id IN (${envioIds.map(() => '?').join(',')}) AND liquidacion_id IS NULL AND anulado_at IS NULL ORDER BY id`
  ).all(...envioIds);
  for (const r of rows) (out[r.envio_id] = out[r.envio_id] || []).push(mapCargo(r));
  return out;
}

// Pendientes del cliente cuyos envíos YA están liquidados: van a la sección "Cargos de
// envíos anteriores" de la próxima liquidación. Con la guía y la fecha del envío.
async function pendientesAnterioresDeCliente(clienteId, db = getDb()) {
  // Los cargos sin envío (30/10) entran acá también: su "guía" es el texto que tipeó la
  // oficina y su "fecha de envío" es la fecha del cargo.
  const rows = await db.prepare(
    `SELECT c.id, c.envio_id, c.cliente_id, c.guia_texto, c.adjunto_nombre, c.tipo, c.label, c.monto, c.origen, c.fecha, c.creado_por, c.creado_at, c.liquidacion_id, c.anulado_at, c.anulado_por,
            COALESCE(e.numero_guia, c.guia_texto) AS numero_guia, COALESCE(e.fecha, c.fecha) AS envio_fecha, e.pais_destino, e.liquidacion_id AS liquidacion_original_id
     FROM envio_cargos c LEFT JOIN envios e ON e.id = c.envio_id
     WHERE ((c.envio_id IS NULL AND c.cliente_id = ?) OR (e.cliente_id = ? AND e.liquidado = 1))
       AND c.liquidacion_id IS NULL AND c.anulado_at IS NULL
     ORDER BY COALESCE(e.fecha, c.fecha), COALESCE(e.numero_guia, c.guia_texto), c.id`
  ).all(clienteId, clienteId);
  return rows.map((r) => ({ ...mapCargo(r), numero_guia: r.numero_guia, envio_fecha: r.envio_fecha, pais_destino: r.pais_destino, liquidacion_original_id: r.liquidacion_original_id }));
}

// Los ya incluidos en una liquidación, separados: los de sus propios envíos (van dentro
// del ítem) y los de envíos anteriores (sección aparte).
async function deLiquidacion(liquidacionId, db = getDb()) {
  const rows = await db.prepare(
    `SELECT c.id, c.envio_id, c.cliente_id, c.guia_texto, c.adjunto_nombre, c.tipo, c.label, c.monto, c.origen, c.fecha, c.creado_por, c.creado_at, c.liquidacion_id, c.anulado_at, c.anulado_por,
            COALESCE(e.numero_guia, c.guia_texto) AS numero_guia, COALESCE(e.fecha, c.fecha) AS envio_fecha, e.pais_destino, e.liquidacion_id AS envio_liquidacion_id
     FROM envio_cargos c LEFT JOIN envios e ON e.id = c.envio_id
     WHERE c.liquidacion_id = ? AND c.anulado_at IS NULL
     ORDER BY COALESCE(e.fecha, c.fecha), COALESCE(e.numero_guia, c.guia_texto), c.id`
  ).all(liquidacionId);
  const enItems = [];
  const anteriores = [];
  for (const r of rows) {
    const c = { ...mapCargo(r), numero_guia: r.numero_guia, envio_fecha: r.envio_fecha, pais_destino: r.pais_destino };
    // Si el envío pertenece a ESTA liquidación (o todavía a ninguna: borrador), el cargo
    // es de sus ítems. Si el envío quedó liquidado en OTRA, es de "envíos anteriores".
    if (!r.envio_id) {
      anteriores.push(c);
    } else if (r.envio_liquidacion_id && Number(r.envio_liquidacion_id) !== Number(liquidacionId)) {
      c.liquidacion_original_id = r.envio_liquidacion_id;
      anteriores.push(c);
    } else {
      enItems.push(c);
    }
  }
  return { enItems, anteriores };
}

async function asignarLiquidacion(ids, liquidacionId, db = getDb()) {
  if (!ids.length) return;
  await db.prepare(`UPDATE envio_cargos SET liquidacion_id = ? WHERE id IN (${ids.map(() => '?').join(',')}) AND liquidacion_id IS NULL`).run(liquidacionId, ...ids);
}

async function liberarDeLiquidacion(liquidacionId, db = getDb()) {
  await db.prepare('UPDATE envio_cargos SET liquidacion_id = NULL WHERE liquidacion_id = ?').run(liquidacionId);
}

// ¿Hay cargos pendientes que un borrador no tiene? Se usa al confirmar: si después de armar
// el borrador entró un cargo (de sus envíos o de un envío anterior del cliente), no se
// confirma sin que la oficina lo vea: hay que recalcular la vista previa.
async function pendientesFueraDe(liquidacionId, clienteId, envioIds, db = getDb()) {
  const propios = await pendientesDeEnvios(envioIds, db);
  const anteriores = await pendientesAnterioresDeCliente(clienteId, db);
  const lista = [];
  for (const [envioId, cs] of Object.entries(propios)) {
    for (const c of cs) lista.push({ ...c, envio_id: Number(envioId) });
  }
  return lista.concat(anteriores);
}

// ── Alta / baja desde Salidas ─────────────────────────────────────────────────────────
async function agregar(envioId, { tipo, label, monto, fecha }, usuario) {
  const db = getDb();
  const envio = await db.prepare('SELECT id, numero_guia, no_volo FROM envios WHERE id = ?').get(envioId);
  if (!envio) throw err('Envío inexistente', 404);
  if (envio.no_volo) throw err('El envío está marcado como "no voló": no se le pueden agregar cargos');
  tipo = String(tipo || 'otro').trim();
  if (!TIPOS[tipo]) throw err('Tipo de cargo inválido');
  label = String(label || '').trim();
  if (tipo === 'otro' && !label) throw err('Escribí el nombre del cargo');
  if (!label) label = TIPOS[tipo];
  monto = r2(monto);
  if (!(monto > 0)) throw err('El importe tiene que ser mayor a cero');
  const f = /^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')) ? fecha : ahora().slice(0, 10);
  const r = await db.prepare(
    `INSERT INTO envio_cargos (envio_id, tipo, label, monto, origen, fecha, creado_por) VALUES (?, ?, ?, ?, 'manual', ?, ?)`
  ).run(envioId, tipo, label, monto, f, usuario ? usuario.usuario : null);
  return obtener(r.lastInsertRowid, db);
}

// ── Cargo sin envío, al cliente (30/10/2026) ──────────────────────────────────────────
const MAX_ADJUNTO = 8 * 1024 * 1024;
async function agregarSuelto(clienteId, { tipo, label, monto, fecha, guia_texto, adjunto_nombre, adjunto }, usuario) {
  const db = getDb();
  const cli = await db.prepare('SELECT id FROM clientes WHERE id = ?').get(clienteId);
  if (!cli) throw err('Cliente inexistente', 404);
  tipo = String(tipo || 'otro').trim();
  if (!TIPOS[tipo]) throw err('Tipo de cargo inválido');
  label = String(label || '').trim();
  if (tipo === 'otro' && !label) throw err('Escribí el nombre del cargo (qué cobró el courier)');
  if (!label) label = TIPOS[tipo];
  if (label.length > 120) throw err('El concepto es demasiado largo (máx. 120)');
  monto = r2(monto);
  if (!(monto > 0)) throw err('El importe tiene que ser mayor a cero');
  const f = /^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')) ? fecha : ahora().slice(0, 10);
  const guia = String(guia_texto || '').trim().slice(0, 40) || null;
  let blob = null;
  let nombre = null;
  if (adjunto && adjunto.length) {
    if (adjunto.length > MAX_ADJUNTO) throw err('El PDF es demasiado grande (máx. 8 MB)');
    if (adjunto.slice(0, 5).toString('latin1') !== '%PDF-') throw err('El adjunto tiene que ser un PDF');
    blob = adjunto;
    nombre = String(adjunto_nombre || 'cargo.pdf').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'cargo.pdf';
  }
  const r = await db.prepare(
    `INSERT INTO envio_cargos (envio_id, cliente_id, guia_texto, adjunto_nombre, adjunto, tipo, label, monto, origen, fecha, creado_por)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`
  ).run(clienteId, guia, nombre, blob, tipo, label, monto, f, usuario ? usuario.usuario : null);
  return obtener(r.lastInsertRowid, db);
}

// Todos los cargos sin envío de un cliente (pendientes, liquidados y anulados), los últimos primero.
async function listarSueltosDeCliente(clienteId, db = getDb()) {
  const rows = await db.prepare(`${SQL_BASE} WHERE c.envio_id IS NULL AND c.cliente_id = ? ORDER BY c.id DESC LIMIT 300`).all(clienteId);
  return rows.map(mapCargo);
}

async function adjuntoDe(id, db = getDb()) {
  const r = await db.prepare('SELECT adjunto_nombre, adjunto FROM envio_cargos WHERE id = ?').get(id);
  return r && r.adjunto ? { nombre: r.adjunto_nombre || 'cargo.pdf', pdf: r.adjunto } : null;
}

async function obtener(id, db = getDb()) {
  const c = await db.prepare(`${SQL_BASE} WHERE c.id = ?`).get(id);
  return c ? mapCargo(c) : null;
}

// Baja: solo mientras está pendiente. Si ya está en un borrador, primero hay que sacarlo
// del borrador (recalcular); si está en una confirmada, ya se le cobró al cliente.
async function anular(id, usuario) {
  const db = getDb();
  const c = await obtener(id, db);
  if (!c) throw err('Cargo inexistente', 404);
  if (c.anulado_at) return c;
  if (c.liquidacion_id) {
    throw err(c.liquidacion_estado === 'confirmada'
      ? `Ese cargo ya está en la liquidación #${c.liquidacion_id}, que está confirmada: no se puede anular.`
      : `Ese cargo está en el borrador #${c.liquidacion_id}. Borrá o recalculá ese borrador y después anulalo.`, 409);
  }
  await db.prepare('UPDATE envio_cargos SET anulado_at = ?, anulado_por = ? WHERE id = ? AND liquidacion_id IS NULL').run(ahora(), usuario ? usuario.usuario : null, id);
  return obtener(id, db);
}

// ── Impuestos DDP (lo llama facturas /cargar) ─────────────────────────────────────────
// Un cargo de impuestos por envío. Si ya existe y está pendiente, se actualiza el monto
// (factura recargada con "sobreescribir"). Si ya se liquidó, no se toca: se avisa.
async function registrarImpuestos(db, envioId, monto, fecha) {
  monto = r2(monto);
  const existente = await db.prepare(`SELECT * FROM envio_cargos WHERE envio_id = ? AND origen = 'impuestos_ddp' AND anulado_at IS NULL ORDER BY id DESC LIMIT 1`).get(envioId);
  if (existente) {
    if (existente.liquidacion_id) {
      return { accion: Math.abs(r2(existente.monto) - monto) < 0.005 ? 'sin_cambios' : 'ya_liquidado', cargo_id: existente.id, liquidacion_id: existente.liquidacion_id };
    }
    await db.prepare('UPDATE envio_cargos SET monto = ?, fecha = ? WHERE id = ?').run(monto, fecha, existente.id);
    return { accion: 'actualizado', cargo_id: existente.id };
  }
  if (!(monto > 0)) return { accion: 'sin_cambios' };
  const r = await db.prepare(
    `INSERT INTO envio_cargos (envio_id, tipo, label, monto, origen, fecha, creado_por) VALUES (?, 'ddp', ?, ?, 'impuestos_ddp', ?, 'factura UPS')`
  ).run(envioId, LABEL_IMPUESTOS, monto, fecha);
  return { accion: 'creado', cargo_id: r.lastInsertRowid };
}

module.exports = {
  TIPOS, LABEL_IMPUESTOS, rotulo, fechaCorta, esFuel, migrar, listarDeEnvio, porEnvios, pendientesDeEnvios, pendientesAnterioresDeCliente,
  deLiquidacion, asignarLiquidacion, liberarDeLiquidacion, pendientesFueraDe, agregar, anular, obtener, registrarImpuestos,
  agregarSuelto, listarSueltosDeCliente, adjuntoDe,
};
