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
        (nombre, nombre_nova, tipo_cobro, tarifa_especial, cuit, direccion_recoleccion, contacto,
         email, whatsapp, codigo_postal, localidad, tipo_facturacion, tarifa_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nombre,
      data.nombre_nova ?? null,
      tipoCobro,
      tarifa,
      data.cuit ?? null,
      data.direccion_recoleccion ?? null,
      data.contacto ?? null,
      data.email ?? null,
      data.whatsapp ?? null,
      data.codigo_postal ?? null,
      data.localidad ?? null,
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
  // nombre_nova lo controla totalmente el usuario: si la propiedad VIENE en el body
  // (aunque sea vacía) se asigna directo y puede borrarse; si NO viene, se mantiene
  // con COALESCE para no pisar el valor desde llamadores que no lo envían.
  const novaProvisto = Object.prototype.hasOwnProperty.call(data, 'nombre_nova');
  const novaClausula = novaProvisto ? 'nombre_nova = ?' : 'nombre_nova = COALESCE(?, nombre_nova)';
  const novaValor = novaProvisto
    ? ((data.nombre_nova && String(data.nombre_nova).trim()) || null)
    : null;

  // Modo de tarifa: 'porcentaje' (flete + % de ganancia) o 'por_kg' (precio fijo por kilo).
  // Se valida acá porque la columna se agrega por ALTER TABLE y ALTER no admite CHECK.
  const modoProvisto =
    data.modo_tarifa !== undefined && data.modo_tarifa !== null && data.modo_tarifa !== '';
  if (modoProvisto && !['porcentaje', 'por_kg'].includes(data.modo_tarifa)) {
    const e = new Error(`modo_tarifa inválido: ${data.modo_tarifa}. Válidos: porcentaje, por_kg`);
    e.status = 400;
    throw e;
  }

  // Fuel propio del cliente: tiene que poder BORRARSE (volver a usar el de Configuración),
  // así que si la propiedad viene en el body se asigna directo —vacío = NULL— en vez de
  // COALESCE, que nunca dejaría volver a null.
  const fuelProvisto = Object.prototype.hasOwnProperty.call(data, 'fuel_pct_propio');
  const fuelClausula = fuelProvisto
    ? 'fuel_pct_propio = ?'
    : 'fuel_pct_propio = COALESCE(?, fuel_pct_propio)';
  let fuelValor = null;
  if (fuelProvisto && data.fuel_pct_propio !== null && data.fuel_pct_propio !== '') {
    const n = Number(data.fuel_pct_propio);
    if (!Number.isFinite(n) || n < 0) {
      const e = new Error(`fuel_pct_propio inválido: ${data.fuel_pct_propio}`);
      e.status = 400;
      throw e;
    }
    fuelValor = n;
  }

  await db
    .prepare(
      `UPDATE clientes SET
        nombre              = COALESCE(?, nombre),
        ${novaClausula},
        tipo_cobro          = COALESCE(?, tipo_cobro),
        tarifa_especial     = ?,
        activo              = COALESCE(?, activo),
        cuit                = COALESCE(?, cuit),
        direccion_recoleccion = COALESCE(?, direccion_recoleccion),
        contacto            = COALESCE(?, contacto),
        email               = COALESCE(?, email),
        whatsapp            = COALESCE(?, whatsapp),
        codigo_postal       = COALESCE(?, codigo_postal),
        localidad           = COALESCE(?, localidad),
        tipo_facturacion    = COALESCE(?, tipo_facturacion),
        tarifa_pct          = COALESCE(?, tarifa_pct),
        modo_tarifa         = COALESCE(?, modo_tarifa),
        ${fuelClausula},
        updated_at          = datetime('now', 'localtime')
       WHERE id = ?`
    )
    .run(
      nombreNuevo ?? null,
      novaValor,
      data.tipo_cobro ?? null,
      tarifa,
      data.activo !== undefined ? (data.activo ? 1 : 0) : null,
      data.cuit ?? null,
      data.direccion_recoleccion ?? null,
      data.contacto ?? null,
      data.email ?? null,
      data.whatsapp ?? null,
      data.codigo_postal ?? null,
      data.localidad ?? null,
      data.tipo_facturacion ?? null,
      data.tarifa_pct !== undefined ? data.tarifa_pct : null,
      modoProvisto ? data.modo_tarifa : null,
      fuelValor,
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
