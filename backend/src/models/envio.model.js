const { getDb } = require('../db');
const { calcularPesos, pesoVolumetricoBulto } = require('../services/calculos.service');

function mapEnvio(row) {
  if (!row) return null;
  return {
    ...row,
    liquidado: Boolean(row.liquidado),
  };
}

async function getBultos(envioId) {
  return getDb()
    .prepare('SELECT * FROM envio_bultos WHERE envio_id = ? ORDER BY numero_bulto')
    .all(envioId);
}

async function saveBultos(envioId, bultos) {
  const db = getDb();
  await db.prepare('DELETE FROM envio_bultos WHERE envio_id = ?').run(envioId);
  const insert = db.prepare(
    `INSERT INTO envio_bultos (envio_id, numero_bulto, peso_real, largo, ancho, alto, peso_volumetrico)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < bultos.length; i++) {
    const b = bultos[i];
    const pv = pesoVolumetricoBulto(b.largo, b.ancho, b.alto);
    await insert.run(
      envioId,
      b.numero_bulto ?? i + 1,
      b.peso_real ?? null,
      b.largo,
      b.ancho,
      b.alto,
      Math.round(pv * 1000) / 1000
    );
  }
}

function buildPesos(data) {
  const bultos = data.bultos || [];
  return calcularPesos(data.peso_real, bultos, {
    largo: data.largo,
    ancho: data.ancho,
    alto: data.alto,
  });
}

async function buscarPorId(id) {
  const row = await getDb()
    .prepare(
      `SELECT e.*, c.nombre AS cliente_nombre, c.tipo_cobro
       FROM envios e
       JOIN clientes c ON c.id = e.cliente_id
       WHERE e.id = ?`
    )
    .get(id);
  if (!row) return null;
  const envio = mapEnvio(row);
  envio.bultos = await getBultos(id);
  return envio;
}

async function listar(filtros = {}) {
  const db = getDb();
  let sql = `
    SELECT e.*, c.nombre AS cliente_nombre, c.tipo_cobro
    FROM envios e
    JOIN clientes c ON c.id = e.cliente_id
    WHERE 1=1`;
  const params = [];

  if (filtros.cliente_id) {
    sql += ' AND e.cliente_id = ?';
    params.push(filtros.cliente_id);
  }
  if (filtros.fecha_desde) {
    sql += ' AND e.fecha >= ?';
    params.push(filtros.fecha_desde);
  }
  if (filtros.fecha_hasta) {
    sql += ' AND e.fecha <= ?';
    params.push(filtros.fecha_hasta);
  }
  if (filtros.courier) {
    sql += ' AND e.courier = ?';
    params.push(filtros.courier);
  }
  if (filtros.tipo_envio) {
    sql += ' AND e.tipo_envio = ?';
    params.push(filtros.tipo_envio);
  }
  if (filtros.liquidado !== undefined && filtros.liquidado !== '') {
    sql += ' AND e.liquidado = ?';
    params.push(filtros.liquidado === 'true' || filtros.liquidado === '1' ? 1 : 0);
  }
  if (filtros.q) {
    sql += ' AND (e.numero_guia LIKE ? OR c.nombre LIKE ?)';
    const term = `%${filtros.q}%`;
    params.push(term, term);
  }

  sql += ' ORDER BY e.fecha DESC, e.id DESC';
  const rows = await db.prepare(sql).all(...params);
  return rows.map(mapEnvio);
}

async function crear(data) {
  const db = getDb();
  const { pesoVolumetrico, pesoFacturable } = buildPesos(data);
  const hasBultos = data.bultos && data.bultos.length > 0;

  const doInsert = async () => {
    const result = await db
      .prepare(
        `INSERT INTO envios (
          cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, destino_raw, direccion, zona,
          cantidad_bultos, peso_real, largo, ancho, alto,
          peso_volumetrico, peso_facturable, fob, total_cobrado, observaciones,
          numero_salida, bulto, tipo_paquete, asegurado,
          flete, descuento, seguro, fuel, derechos, adicionales, otros, profit, porcentaje
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.cliente_id,
        data.fecha,
        data.courier,
        data.tipo_envio,
        data.numero_guia,
        data.pais_destino,
        data.destino_raw ?? null,
        data.direccion ?? 'expo',
        data.zona || null,
        data.cantidad_bultos || 1,
        data.peso_real,
        data.largo ?? null,
        data.ancho ?? null,
        data.alto ?? null,
        pesoVolumetrico,
        pesoFacturable,
        data.fob ?? 0,
        data.total_cobrado ?? 0,
        data.observaciones || null,
        data.numero_salida ?? null,
        data.bulto ?? null,
        data.tipo_paquete ?? null,
        data.asegurado ?? 0,
        data.flete ?? null,
        data.descuento ?? null,
        data.seguro ?? null,
        data.fuel ?? null,
        data.derechos ?? null,
        data.adicionales ?? null,
        data.otros ?? null,
        data.profit ?? null,
        data.porcentaje ?? null
      );
    const envioId = result.lastInsertRowid;
    if (hasBultos) await saveBultos(envioId, data.bultos);
    return envioId;
  };

  // Solo abre una transacción propia cuando hay bultos (múltiples escrituras que deben ser atómicas).
  // Sin bultos, un INSERT único ya es atómico en SQLite y puede ejecutarse dentro de
  // una transacción externa (como la de importarSalidas) sin anidar BEGIN.
  const id = hasBultos ? await db.transaction(doInsert) : await doInsert();
  return buscarPorId(id);
}

async function actualizar(id, data) {
  const db = getDb();
  const actual = await buscarPorId(id);
  if (!actual) return null;
  if (actual.liquidado && !data.forzar) {
    const err = new Error('No se puede editar un envío ya liquidado');
    err.status = 400;
    throw err;
  }

  const merged = { ...actual, ...data, peso_real: data.peso_real ?? actual.peso_real };
  const bultos =
    data.bultos !== undefined ? data.bultos : actual.bultos?.length ? actual.bultos : [];
  const { pesoVolumetrico, pesoFacturable } = buildPesos({
    peso_real: merged.peso_real,
    bultos,
    largo: data.largo ?? actual.largo,
    ancho: data.ancho ?? actual.ancho,
    alto: data.alto ?? actual.alto,
  });

  await db.transaction(async () => {
    await db.prepare(
      `UPDATE envios SET
        cliente_id = ?, fecha = ?, courier = ?, tipo_envio = ?,
        numero_guia = ?, pais_destino = ?, zona = ?,
        cantidad_bultos = ?, peso_real = ?, largo = ?, ancho = ?, alto = ?,
        peso_volumetrico = ?, peso_facturable = ?,
        fob = ?, total_cobrado = ?, observaciones = ?,
        updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    ).run(
      data.cliente_id ?? actual.cliente_id,
      data.fecha ?? actual.fecha,
      data.courier ?? actual.courier,
      data.tipo_envio ?? actual.tipo_envio,
      data.numero_guia ?? actual.numero_guia,
      data.pais_destino ?? actual.pais_destino,
      data.zona !== undefined ? data.zona : actual.zona,
      data.cantidad_bultos ?? actual.cantidad_bultos,
      merged.peso_real,
      data.largo !== undefined ? data.largo : actual.largo,
      data.ancho !== undefined ? data.ancho : actual.ancho,
      data.alto !== undefined ? data.alto : actual.alto,
      pesoVolumetrico,
      pesoFacturable,
      data.fob ?? actual.fob,
      data.total_cobrado ?? actual.total_cobrado,
      data.observaciones !== undefined ? data.observaciones : actual.observaciones,
      id
    );
    if (data.bultos !== undefined) {
      if (data.bultos.length > 0) await saveBultos(id, data.bultos);
      else await db.prepare('DELETE FROM envio_bultos WHERE envio_id = ?').run(id);
    }
  });
  return buscarPorId(id);
}

async function listarPendientesPorCliente(filtros = {}) {
  const db = getDb();
  let sql = `
    SELECT e.*, c.nombre AS cliente_nombre, c.tipo_cobro, c.id AS cliente_id
    FROM envios e
    JOIN clientes c ON c.id = e.cliente_id
    WHERE e.liquidado = 0`;
  const params = [];

  if (filtros.cliente_id) {
    sql += ' AND e.cliente_id = ?';
    params.push(filtros.cliente_id);
  }
  if (filtros.fecha_desde) {
    sql += ' AND e.fecha >= ?';
    params.push(filtros.fecha_desde);
  }
  if (filtros.fecha_hasta) {
    sql += ' AND e.fecha <= ?';
    params.push(filtros.fecha_hasta);
  }
  if (filtros.courier) {
    sql += ' AND e.courier = ?';
    params.push(filtros.courier);
  }
  if (filtros.tipo_cobro) {
    sql += ' AND c.tipo_cobro = ?';
    params.push(filtros.tipo_cobro);
  }

  sql += ' ORDER BY c.nombre COLLATE NOCASE, e.fecha';
  const rows = (await db.prepare(sql).all(...params)).map(mapEnvio);

  const grupos = {};
  for (const row of rows) {
    const key = row.cliente_id;
    if (!grupos[key]) {
      grupos[key] = {
        cliente_id: row.cliente_id,
        cliente_nombre: row.cliente_nombre,
        tipo_cobro: row.tipo_cobro,
        envios: [],
        total_cobrado: 0,
      };
    }
    grupos[key].envios.push(row);
    grupos[key].total_cobrado += row.total_cobrado || 0;
  }
  return Object.values(grupos);
}

async function marcarLiquidados(envioIds, liquidacionId, fechaLiquidacion) {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE envios SET liquidado = 1, fecha_liquidacion = ?, liquidacion_id = ?,
      updated_at = datetime('now', 'localtime')
     WHERE id = ? AND liquidado = 0`
  );
  for (const id of envioIds) {
    await stmt.run(fechaLiquidacion, liquidacionId, id);
  }
}

module.exports = {
  buscarPorId,
  listar,
  crear,
  actualizar,
  listarPendientesPorCliente,
  marcarLiquidados,
  getBultos,
};
