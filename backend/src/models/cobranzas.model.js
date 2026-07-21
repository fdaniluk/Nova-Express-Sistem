const { getDb } = require('../db');

// Nombre a mostrar del cliente: preferimos nombre_nova (alias interno) y caemos a la
// razón social (clientes.nombre) si no hay alias. NULLIF cubre el nombre_nova vacío.
const CLIENTE_NOMBRE = "COALESCE(NULLIF(c.nombre_nova, ''), c.nombre)";

async function listar({ cliente_id, desde, hasta } = {}) {
  const db = getDb();
  let sql = `
    SELECT
      co.*,
      ${CLIENTE_NOMBRE} AS cliente_nombre
    FROM cobranzas co
    JOIN clientes c ON c.id = co.cliente_id
    WHERE 1=1`;
  const params = [];
  if (cliente_id !== undefined && cliente_id !== null && cliente_id !== '') {
    sql += ' AND co.cliente_id = ?';
    params.push(cliente_id);
  }
  if (desde) {
    sql += ' AND co.fecha >= ?';
    params.push(desde);
  }
  if (hasta) {
    sql += ' AND co.fecha <= ?';
    params.push(hasta);
  }
  sql += ' ORDER BY co.fecha DESC, co.id DESC';
  return db.prepare(sql).all(...params);
}

async function obtenerPorId(id) {
  const db = getDb();
  return db
    .prepare(
      `SELECT co.*, ${CLIENTE_NOMBRE} AS cliente_nombre
       FROM cobranzas co
       JOIN clientes c ON c.id = co.cliente_id
       WHERE co.id = ?`
    )
    .get(id);
}

async function crear(data) {
  const db = getDb();
  const result = await db
    .prepare(
      `INSERT INTO cobranzas
        (cliente_id, fecha, monto, moneda, forma_pago, pickup_id, nota, usuario)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.cliente_id,
      data.fecha,
      data.monto,
      data.moneda,
      data.forma_pago,
      data.pickup_id ?? null,
      data.nota ?? null,
      data.usuario ?? null
    );
  return obtenerPorId(result.lastInsertRowid);
}

async function actualizar(id, data) {
  const db = getDb();
  const actual = await obtenerPorId(id);
  if (!actual) return null;
  // pickup_id/nota son opcionales: si la propiedad viene en el body se asigna directo
  // (permite blanquear), si no viene se mantiene con COALESCE.
  const pickupProvisto = Object.prototype.hasOwnProperty.call(data, 'pickup_id');
  const notaProvista = Object.prototype.hasOwnProperty.call(data, 'nota');
  await db
    .prepare(
      `UPDATE cobranzas SET
        cliente_id = COALESCE(?, cliente_id),
        fecha      = COALESCE(?, fecha),
        monto      = COALESCE(?, monto),
        moneda     = COALESCE(?, moneda),
        forma_pago = COALESCE(?, forma_pago),
        pickup_id  = ${pickupProvisto ? '?' : 'pickup_id'},
        nota       = ${notaProvista ? '?' : 'nota'}
       WHERE id = ?`
    )
    .run(
      data.cliente_id ?? null,
      data.fecha ?? null,
      data.monto ?? null,
      data.moneda ?? null,
      data.forma_pago ?? null,
      ...(pickupProvisto ? [data.pickup_id ?? null] : []),
      ...(notaProvista ? [data.nota ?? null] : []),
      id
    );
  return obtenerPorId(id);
}

async function eliminar(id) {
  const db = getDb();
  const result = await db.prepare('DELETE FROM cobranzas WHERE id = ?').run(id);
  return result.changes > 0;
}

module.exports = { listar, obtenerPorId, crear, actualizar, eliminar };
