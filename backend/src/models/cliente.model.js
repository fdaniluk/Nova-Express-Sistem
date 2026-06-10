const { getDb } = require('../db');

function mapCliente(c) {
  if (!c) return c;
  return { ...c, razon_social: c.nombre };
}

async function listar({ activo } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM clientes WHERE 1=1';
  const params = [];
  if (activo !== undefined) {
    sql += ' AND activo = ?';
    params.push(activo ? 1 : 0);
  }
  sql += ' ORDER BY nombre COLLATE NOCASE';
  const rows = await db.prepare(sql).all(...params);
  return rows.map(mapCliente);
}

async function buscarPorId(id) {
  const row = await getDb().prepare('SELECT * FROM clientes WHERE id = ?').get(id);
  return mapCliente(row);
}

async function crear(data) {
  const db = getDb();
  const nombre = data.razon_social || data.nombre;
  const tipoCobro = data.tipo_cobro || 'CC';
  const tarifa = data.tarifa_especial ? JSON.stringify(data.tarifa_especial) : null;
  const result = await db
    .prepare(
      `INSERT INTO clientes
        (nombre, tipo_cobro, tarifa_especial, cuit, direccion_recoleccion, contacto,
         email, whatsapp, codigo_postal, tipo_facturacion, tarifa_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nombre,
      tipoCobro,
      tarifa,
      data.cuit ?? null,
      data.direccion_recoleccion ?? null,
      data.contacto ?? null,
      data.email ?? null,
      data.whatsapp ?? null,
      data.codigo_postal ?? null,
      data.tipo_facturacion ?? 'Responsable inscripto',
      data.tarifa_pct ?? 0
    );
  return buscarPorId(result.lastInsertRowid);
}

async function actualizar(id, data) {
  const db = getDb();
  const actual = await buscarPorId(id);
  if (!actual) return null;
  const tarifa =
    data.tarifa_especial !== undefined
      ? data.tarifa_especial ? JSON.stringify(data.tarifa_especial) : null
      : actual.tarifa_especial;
  const nombreNuevo = data.razon_social !== undefined ? data.razon_social : data.nombre;
  await db
    .prepare(
      `UPDATE clientes SET
        nombre              = COALESCE(?, nombre),
        tipo_cobro          = COALESCE(?, tipo_cobro),
        tarifa_especial     = ?,
        activo              = COALESCE(?, activo),
        cuit                = COALESCE(?, cuit),
        direccion_recoleccion = COALESCE(?, direccion_recoleccion),
        contacto            = COALESCE(?, contacto),
        email               = COALESCE(?, email),
        whatsapp            = COALESCE(?, whatsapp),
        codigo_postal       = COALESCE(?, codigo_postal),
        tipo_facturacion    = COALESCE(?, tipo_facturacion),
        tarifa_pct          = COALESCE(?, tarifa_pct),
        updated_at          = datetime('now', 'localtime')
       WHERE id = ?`
    )
    .run(
      nombreNuevo ?? null,
      data.tipo_cobro ?? null,
      tarifa,
      data.activo !== undefined ? (data.activo ? 1 : 0) : null,
      data.cuit ?? null,
      data.direccion_recoleccion ?? null,
      data.contacto ?? null,
      data.email ?? null,
      data.whatsapp ?? null,
      data.codigo_postal ?? null,
      data.tipo_facturacion ?? null,
      data.tarifa_pct !== undefined ? data.tarifa_pct : null,
      id
    );
  return buscarPorId(id);
}

async function eliminar(id) {
  const db = getDb();
  const row = await db.prepare('SELECT COUNT(*) AS n FROM envios WHERE cliente_id = ?').get(id);
  if (row.n > 0) {
    const err = new Error('No se puede eliminar: el cliente tiene envíos registrados');
    err.status = 400;
    throw err;
  }
  const result = await db.prepare('DELETE FROM clientes WHERE id = ?').run(id);
  return result.changes > 0;
}

function parseTarifa(cliente) {
  if (!cliente) return cliente;
  if (cliente.tarifa_especial) {
    try {
      cliente.tarifa_especial = JSON.parse(cliente.tarifa_especial);
    } catch {
      cliente.tarifa_especial = null;
    }
  }
  return cliente;
}

module.exports = { listar, buscarPorId, crear, actualizar, eliminar, parseTarifa };
