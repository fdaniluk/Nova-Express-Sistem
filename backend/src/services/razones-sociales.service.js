// Razones sociales por cliente + unir clientes (22/09/2026).
// Ver AUDITORIA-GECOM-Y-REDISENO-COBRANZAS.md y schema.sql (clientes_razones_sociales).
const { getDb } = require('../db');

const soloDigitos = (s) => String(s || '').replace(/\D/g, '');

async function listar(clienteId) {
  const db = getDb();
  return db.prepare(
    `SELECT r.*,
            (SELECT COUNT(*) FROM cc_comprobantes c WHERE c.razon_social_id = r.id AND c.anulado_at IS NULL) AS comprobantes,
            (SELECT ROUND(COALESCE(SUM(CASE WHEN c.tipo IN ('FA','LQ','ND') THEN c.saldo WHEN c.tipo IN ('NC','AC') THEN -c.saldo ELSE 0 END),0),2)
               FROM cc_comprobantes c WHERE c.razon_social_id = r.id AND c.anulado_at IS NULL AND c.libro = 'CF') AS saldo_cf,
            (SELECT ROUND(COALESCE(SUM(CASE WHEN c.tipo IN ('FA','LQ','ND') THEN c.saldo WHEN c.tipo IN ('NC','AC') THEN -c.saldo ELSE 0 END),0),2)
               FROM cc_comprobantes c WHERE c.razon_social_id = r.id AND c.anulado_at IS NULL AND c.libro = 'SF') AS saldo_sf
     FROM clientes_razones_sociales r WHERE r.cliente_id = ? ORDER BY r.principal DESC, r.activa DESC, r.razon_social`
  ).all(clienteId);
}

async function crear(clienteId, { razon_social, cuit = null, condicion_iva = null, es_tercero = 0, principal = 0, nota = null }) {
  const db = getDb();
  if (!razon_social || !String(razon_social).trim()) throw Object.assign(new Error('razon_social es obligatoria'), { status: 400 });
  return db.transaction(async () => {
    if (principal) await db.prepare('UPDATE clientes_razones_sociales SET principal = 0 WHERE cliente_id = ?').run(clienteId);
    const r = await db.prepare(
      'INSERT INTO clientes_razones_sociales (cliente_id, razon_social, cuit, condicion_iva, es_tercero, principal, nota) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(clienteId, String(razon_social).trim(), cuit ? String(cuit).trim() : null, condicion_iva, es_tercero ? 1 : 0, principal ? 1 : 0, nota);
    return db.prepare('SELECT * FROM clientes_razones_sociales WHERE id = ?').get(r.lastInsertRowid);
  });
}

async function editar(id, data) {
  const db = getDb();
  const rs = await db.prepare('SELECT * FROM clientes_razones_sociales WHERE id = ?').get(id);
  if (!rs) throw Object.assign(new Error('Razón social inexistente'), { status: 404 });
  return db.transaction(async () => {
    if (data.principal) await db.prepare('UPDATE clientes_razones_sociales SET principal = 0 WHERE cliente_id = ?').run(rs.cliente_id);
    await db.prepare(
      `UPDATE clientes_razones_sociales SET razon_social = ?, cuit = ?, condicion_iva = ?, es_tercero = ?, principal = ?, activa = ?, nota = ? WHERE id = ?`
    ).run(
      data.razon_social !== undefined ? String(data.razon_social).trim() : rs.razon_social,
      data.cuit !== undefined ? (data.cuit ? String(data.cuit).trim() : null) : rs.cuit,
      data.condicion_iva !== undefined ? data.condicion_iva : rs.condicion_iva,
      data.es_tercero !== undefined ? (data.es_tercero ? 1 : 0) : rs.es_tercero,
      data.principal !== undefined ? (data.principal ? 1 : 0) : rs.principal,
      data.activa !== undefined ? (data.activa ? 1 : 0) : rs.activa,
      data.nota !== undefined ? data.nota : rs.nota,
      id
    );
    return db.prepare('SELECT * FROM clientes_razones_sociales WHERE id = ?').get(id);
  });
}

// Mover una razón social (con todos sus comprobantes) a otro cliente. Es la forma de
// resolver "este perfil del GECOM era de otro cliente" sin unir clientes enteros.
async function moverACliente(id, clienteDestinoId) {
  const db = getDb();
  const rs = await db.prepare('SELECT * FROM clientes_razones_sociales WHERE id = ?').get(id);
  if (!rs) throw Object.assign(new Error('Razón social inexistente'), { status: 404 });
  const dest = await db.prepare('SELECT id FROM clientes WHERE id = ?').get(clienteDestinoId);
  if (!dest) throw Object.assign(new Error('Cliente destino inexistente'), { status: 404 });
  return db.transaction(async () => {
    const n = await db.prepare('UPDATE cc_comprobantes SET cliente_id = ? WHERE razon_social_id = ?').run(clienteDestinoId, id);
    await db.prepare('UPDATE clientes_razones_sociales SET cliente_id = ?, principal = 0 WHERE id = ?').run(clienteDestinoId, id);
    return { movidos: n.changes };
  });
}

// ── Unir clientes ─────────────────────────────────────────────────────────────────
// TODO lo del cliente origen (envíos, liquidaciones, cotizaciones, pickups, cuenta
// corriente, tarifas, direcciones, razones sociales…) pasa al destino; el origen se borra
// y queda el asiento en clientes_uniones. Recorre todas las tablas que tengan cliente_id,
// así no hay que acordarse de agregar una cuando aparezca una tabla nueva. Donde hay una
// clave única por cliente (matriz de profit, tramos, tarifa por kg, vínculos del bot) y el
// destino ya tiene la misma fila, se conserva la del DESTINO y se descarta la del origen.
async function unirClientes(origenId, destinoId, { usuario = null } = {}) {
  const db = getDb();
  origenId = Number(origenId); destinoId = Number(destinoId);
  if (!origenId || !destinoId || origenId === destinoId) throw Object.assign(new Error('Elegí dos clientes distintos'), { status: 400 });
  const origen = await db.prepare('SELECT * FROM clientes WHERE id = ?').get(origenId);
  const destino = await db.prepare('SELECT * FROM clientes WHERE id = ?').get(destinoId);
  if (!origen || !destino) throw Object.assign(new Error('Cliente inexistente'), { status: 404 });

  await db.exec(`CREATE TABLE IF NOT EXISTS clientes_uniones (
    id INTEGER PRIMARY KEY AUTOINCREMENT, origen_id INTEGER NOT NULL, origen_nombre TEXT, origen_cuit TEXT,
    destino_id INTEGER NOT NULL, detalle TEXT, usuario TEXT, fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')))`);

  const tablas = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('clientes', 'clientes_uniones')").all()).map((t) => t.name);
  const detalle = {};
  return db.transaction(async () => {
    for (const t of tablas) {
      const cols = (await db.prepare(`PRAGMA table_info(${t})`).all()).map((c) => c.name);
      if (!cols.includes('cliente_id')) continue;
      const n = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE cliente_id = ?`).get(origenId)).n;
      if (!n) continue;
      try {
        await db.prepare(`UPDATE ${t} SET cliente_id = ? WHERE cliente_id = ?`).run(destinoId, origenId);
        detalle[t] = n;
      } catch (e) {
        // Clave única por cliente: fila por fila; la que choca con una del destino se descarta.
        const ids = await db.prepare(`SELECT rowid AS rid FROM ${t} WHERE cliente_id = ?`).all(origenId);
        let ok = 0, desc = 0;
        for (const { rid } of ids) {
          try { await db.prepare(`UPDATE ${t} SET cliente_id = ? WHERE rowid = ?`).run(destinoId, rid); ok++; }
          catch (e2) { await db.prepare(`DELETE FROM ${t} WHERE rowid = ?`).run(rid); desc++; }
        }
        detalle[t] = `${ok} movidas, ${desc} descartadas (el destino ya las tenía)`;
      }
    }
    // El destino conserva su razón social principal; las del origen quedan como secundarias.
    await db.prepare('UPDATE clientes_razones_sociales SET principal = 0 WHERE cliente_id = ? AND id NOT IN (SELECT id FROM clientes_razones_sociales WHERE cliente_id = ? AND principal = 1 ORDER BY id LIMIT 1)').run(destinoId, destinoId);
    // Datos del origen que el destino no tenía (CUIT, mail, agenda GECOM…): se completan.
    for (const col of ['cuit', 'email', 'whatsapp', 'telefono', 'direccion_recoleccion', 'codigo_postal', 'localidad', 'provincia', 'contacto', 'gecom_agenda_cf', 'gecom_agenda_sf', 'plazo_pago_dias']) {
      if ((destino[col] === null || destino[col] === '') && origen[col] !== null && origen[col] !== '') {
        await db.prepare(`UPDATE clientes SET ${col} = ? WHERE id = ?`).run(origen[col], destinoId);
      }
    }
    await db.prepare('INSERT INTO clientes_uniones (origen_id, origen_nombre, origen_cuit, destino_id, detalle, usuario) VALUES (?, ?, ?, ?, ?, ?)')
      .run(origenId, origen.nombre, origen.cuit, destinoId, JSON.stringify(detalle), usuario);
    await db.prepare('DELETE FROM clientes WHERE id = ?').run(origenId);
    return { origen: origen.nombre, destino: destino.nombre, detalle };
  });
}

module.exports = { listar, crear, editar, moverACliente, unirClientes, soloDigitos };
