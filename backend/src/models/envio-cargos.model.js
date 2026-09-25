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
  otro: 'Otro cargo',
};
const LABEL_IMPUESTOS = 'Impuestos de destino (DDP)';

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
    fecha: c.fecha, creado_por: c.creado_por, creado_at: c.creado_at,
    liquidacion_id: c.liquidacion_id, liquidacion_estado: c.liquidacion_estado || null,
    anulado_at: c.anulado_at, anulado_por: c.anulado_por,
    estado: c.anulado_at ? 'anulado' : (c.liquidacion_id ? 'liquidado' : 'pendiente'),
  };
}

const SQL_BASE = `SELECT c.*, l.estado AS liquidacion_estado FROM envio_cargos c LEFT JOIN liquidaciones l ON l.id = c.liquidacion_id`;

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
    `SELECT * FROM envio_cargos WHERE envio_id IN (${envioIds.map(() => '?').join(',')}) AND liquidacion_id IS NULL AND anulado_at IS NULL ORDER BY id`
  ).all(...envioIds);
  for (const r of rows) (out[r.envio_id] = out[r.envio_id] || []).push(mapCargo(r));
  return out;
}

// Pendientes del cliente cuyos envíos YA están liquidados: van a la sección "Cargos de
// envíos anteriores" de la próxima liquidación. Con la guía y la fecha del envío.
async function pendientesAnterioresDeCliente(clienteId, db = getDb()) {
  const rows = await db.prepare(
    `SELECT c.*, e.numero_guia, e.fecha AS envio_fecha, e.liquidacion_id AS liquidacion_original_id
     FROM envio_cargos c JOIN envios e ON e.id = c.envio_id
     WHERE e.cliente_id = ? AND e.liquidado = 1 AND c.liquidacion_id IS NULL AND c.anulado_at IS NULL
     ORDER BY e.fecha, e.numero_guia, c.id`
  ).all(clienteId);
  return rows.map((r) => ({ ...mapCargo(r), numero_guia: r.numero_guia, envio_fecha: r.envio_fecha, liquidacion_original_id: r.liquidacion_original_id }));
}

// Los ya incluidos en una liquidación, separados: los de sus propios envíos (van dentro
// del ítem) y los de envíos anteriores (sección aparte).
async function deLiquidacion(liquidacionId, db = getDb()) {
  const rows = await db.prepare(
    `SELECT c.*, e.numero_guia, e.fecha AS envio_fecha, e.liquidacion_id AS envio_liquidacion_id
     FROM envio_cargos c JOIN envios e ON e.id = c.envio_id
     WHERE c.liquidacion_id = ? AND c.anulado_at IS NULL
     ORDER BY e.fecha, e.numero_guia, c.id`
  ).all(liquidacionId);
  const enItems = [];
  const anteriores = [];
  for (const r of rows) {
    const c = { ...mapCargo(r), numero_guia: r.numero_guia, envio_fecha: r.envio_fecha };
    // Si el envío pertenece a ESTA liquidación (o todavía a ninguna: borrador), el cargo
    // es de sus ítems. Si el envío quedó liquidado en OTRA, es de "envíos anteriores".
    if (r.envio_liquidacion_id && Number(r.envio_liquidacion_id) !== Number(liquidacionId)) {
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
  TIPOS, LABEL_IMPUESTOS, migrar, listarDeEnvio, porEnvios, pendientesDeEnvios, pendientesAnterioresDeCliente,
  deLiquidacion, asignarLiquidacion, liberarDeLiquidacion, pendientesFueraDe, agregar, anular, obtener, registrarImpuestos,
};
