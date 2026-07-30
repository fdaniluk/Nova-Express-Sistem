const { getDb } = require('../db');
const { calcularPesos, pesoVolumetricoBulto, desglosarCosto, contenidoDe } = require('../services/calculos.service');
const configuracionModel = require('./configuracion.model');

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
      `SELECT e.*, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre, c.tipo_cobro
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
    SELECT e.*, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre, c.tipo_cobro
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
    sql += ' AND (e.numero_guia LIKE ? OR c.nombre LIKE ? OR c.nombre_nova LIKE ?)';
    const term = `%${filtros.q}%`;
    params.push(term, term, term);
  }

  sql += ' ORDER BY e.fecha DESC, e.id DESC';
  const rows = await db.prepare(sql).all(...params);
  return rows.map(mapEnvio);
}

// Calcula el desglose AL COSTO (profit 0) congelado al alta, usando el mismo motor
// que el cotizador y el liquidador. El fuel% es el autoritativo de config (no el del
// cliente). Devuelve null si el país no figura en las tablas y no hay zona manual.
async function calcularDesgloseAlCosto(data, pesoFacturable) {
  const courier = data.courier;
  const servicio = courier === 'DHL'
    ? 'DHL'
    : (data.servicio_ups === 'UPS_SAV' || data.servicio_ups === 'UPS_EXP')
      ? data.servicio_ups
      : 'UPS_EXP'; // fallback si no vino la variante
  const tipo = (data.tipo_envio || '').toLowerCase().includes('import') ? 'import' : 'export';

  // Fuel% por envío: si el usuario lo editó en Cargar envío viene en data.fuel_pct y manda;
  // si no, se precarga el autoritativo de config del courier. El valor usado se congela en
  // la columna envios.fuel_pct (lo devuelve desglosarCosto como fuel_pct).
  const fuelCfg = await configuracionModel.obtenerFuel(courier);
  const fuelOverride = data.fuel_pct;
  const fuelPct = (fuelOverride !== undefined && fuelOverride !== null && fuelOverride !== '')
    ? Number(fuelOverride)
    : (fuelCfg?.fuel_pct ?? 0);

  // Mismo conjunto de bultos que usó buildPesos para el peso facturable:
  // si vienen bultos, son el set completo; si no, el bulto único de los campos primarios.
  const bultos = (data.bultos && data.bultos.length)
    ? data.bultos.map(b => ({ pesoReal: b.peso_real, largo: b.largo, ancho: b.ancho, alto: b.alto }))
    : [{ pesoReal: data.peso_real, largo: data.largo, ancho: data.ancho, alto: data.alto }];

  return desglosarCosto({
    pais: data.pais_destino,
    tipo,
    servicio,
    pesoFacturable,
    fob: data.fob || 0,
    fuelPct,
    zonaOverride: data.zona,
    bultos,
    remota: data.remota ? true : false,
    // Zona de entrega ('extendida' | 'remota'). Si el envío es viejo y solo tiene el flag
    // `remota`, el motor lo lee como 'extendida', que es la tarifa que ya se le cobró.
    entrega: data.entrega ?? null,
    ddp: data.ddp ? true : false,
    // Tipo de paquete → tarifa de documento de DHL (hasta 2 kg). Sin esto el costo se
    // congelaba siempre con la tabla de mercadería, aunque el envío estuviera marcado
    // como documento, y la utilidad de esos envíos quedaba mal calculada.
    contenido: contenidoDe(data.tipo_paquete),
  });
}

async function crear(data) {
  const db = getDb();
  const { pesoVolumetrico, pesoFacturable } = buildPesos(data);
  const hasBultos = data.bultos && data.bultos.length > 0;

  // Desglose al costo (profit 0) congelado al momento del alta.
  const desglose = await calcularDesgloseAlCosto(data, pesoFacturable);

  const doInsert = async () => {
    const result = await db
      .prepare(
        `INSERT INTO envios (
          cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, destino_raw, direccion, zona,
          cantidad_bultos, peso_real, largo, ancho, alto,
          peso_volumetrico, peso_facturable, fob, total_cobrado, observaciones,
          numero_salida, bulto, tipo_paquete, asegurado, ddp, remota, entrega,
          flete, descuento, seguro, fuel, fuel_pct, derechos, adicionales, otros, profit, porcentaje,
          extras_json, servicio_ups
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.cliente_id,
        data.fecha,
        data.courier,
        data.tipo_envio,
        String(data.numero_guia ?? '').trim().toUpperCase() || null,
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
        data.ddp ?? 0,
        data.remota ?? 0,
        data.entrega ?? null,
        desglose ? desglose.flete : (data.flete ?? null),
        desglose ? desglose.descuento : (data.descuento ?? null),
        desglose ? desglose.seguro : (data.seguro ?? null),
        desglose ? desglose.fuel : (data.fuel ?? null),
        desglose ? desglose.fuel_pct : (data.fuel_pct ?? null),
        desglose ? desglose.derechos : (data.derechos ?? null),
        desglose ? desglose.adicionales : (data.adicionales ?? null),
        desglose ? desglose.otros : (data.otros ?? null),
        data.profit ?? null,
        data.porcentaje ?? null,
        desglose && desglose.extras && desglose.extras.length ? JSON.stringify(desglose.extras) : null,
        data.courier === 'UPS' ? (data.servicio_ups ?? null) : null
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
  // Sin escape hatch: antes existía un flag `data.forzar` que salteaba este freno.
  // No lo usaba ningún archivo del frontend, pero cualquiera que mandara
  // {"forzar": true} por PUT /api/envios/:id podía cambiarle el cliente y la fecha
  // a un envío ya liquidado, dejando un liquidacion_items de una liquidación
  // confirmada apuntando a otro cliente. Se elimina.
  if (actual.liquidado) {
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

  // ── Recálculo del costo al editar ────────────────────────────────────────────
  //
  // Antes esto NO se hacía: se actualizaban el peso, el país y el courier, pero las
  // columnas de costo (flete, seguro, fuel, adicionales, extras_json) quedaban con el
  // número del alta. Editar un envío de 5 kg a 50 kg dejaba el costo de 5 kg y una
  // utilidad fantasma. Además tipo_paquete, asegurado, ddp y la zona de entrega ni
  // siquiera se guardaban: tildarlos en la edición no hacía nada.
  //
  // Solo se recalcula si cambió algo que MUEVE el precio. Una edición de observaciones
  // o del número de guía no puede recotizar: el costo quedó congelado con la tarifa y
  // el fuel del día del alta, y recalcularlo por una nota lo movería sin motivo.
  const CAMPOS_QUE_MUEVEN_EL_COSTO = [
    'peso_real', 'largo', 'ancho', 'alto', 'bultos', 'cantidad_bultos',
    'pais_destino', 'zona', 'courier', 'tipo_envio', 'servicio_ups',
    'fob', 'fuel_pct', 'tipo_paquete', 'asegurado', 'ddp', 'remota', 'entrega',
  ];
  const cambioElCosto = CAMPOS_QUE_MUEVEN_EL_COSTO.some((c) => {
    if (data[c] === undefined) return false;
    if (c === 'bultos') return true;
    return String(data[c] ?? '') !== String(actual[c] ?? '');
  });

  let desglose = null;
  if (cambioElCosto) {
    // El fuel se toma del envío (el congelado en su alta) salvo que la edición lo cambie:
    // un envío de mayo se recalcula con el fuel de mayo, no con el de hoy.
    desglose = await calcularDesgloseAlCosto({
      ...merged,
      bultos: bultos.length ? bultos : undefined,
      fuel_pct: data.fuel_pct !== undefined ? data.fuel_pct : actual.fuel_pct,
    }, pesoFacturable);
  }

  await db.transaction(async () => {
    await db.prepare(
      `UPDATE envios SET
        cliente_id = ?, fecha = ?, courier = ?, tipo_envio = ?,
        numero_guia = ?, pais_destino = ?, zona = ?,
        cantidad_bultos = ?, peso_real = ?, largo = ?, ancho = ?, alto = ?,
        peso_volumetrico = ?, peso_facturable = ?,
        fob = ?, total_cobrado = ?, observaciones = ?,
        servicio_ups = ?, fuel_pct = ?,
        tipo_paquete = ?, asegurado = ?, ddp = ?, remota = ?, entrega = ?,
        flete = COALESCE(?, flete), descuento = COALESCE(?, descuento),
        seguro = COALESCE(?, seguro), fuel = COALESCE(?, fuel),
        derechos = COALESCE(?, derechos), adicionales = COALESCE(?, adicionales),
        otros = COALESCE(?, otros), extras_json = COALESCE(?, extras_json),
        updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    ).run(
      data.cliente_id ?? actual.cliente_id,
      data.fecha ?? actual.fecha,
      data.courier ?? actual.courier,
      data.tipo_envio ?? actual.tipo_envio,
      String(data.numero_guia ?? actual.numero_guia ?? '').trim().toUpperCase() || actual.numero_guia,
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
      (data.courier ?? actual.courier) === 'UPS' ? (data.servicio_ups !== undefined ? data.servicio_ups : actual.servicio_ups) : null,
      desglose ? desglose.fuel_pct : (data.fuel_pct !== undefined ? data.fuel_pct : actual.fuel_pct),
      data.tipo_paquete !== undefined ? data.tipo_paquete : actual.tipo_paquete,
      data.asegurado !== undefined ? (data.asegurado ? 1 : 0) : actual.asegurado,
      data.ddp !== undefined ? (data.ddp ? 1 : 0) : actual.ddp,
      data.remota !== undefined ? (data.remota ? 1 : 0) : actual.remota,
      data.entrega !== undefined ? data.entrega : actual.entrega,
      // COALESCE en el SQL: si no hubo recálculo van todos NULL y la columna no se toca.
      desglose ? desglose.flete : null,
      desglose ? desglose.descuento : null,
      desglose ? desglose.seguro : null,
      desglose ? desglose.fuel : null,
      desglose ? desglose.derechos : null,
      desglose ? desglose.adicionales : null,
      desglose ? desglose.otros : null,
      desglose && desglose.extras && desglose.extras.length ? JSON.stringify(desglose.extras) : null,
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
    SELECT e.*, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre, c.tipo_cobro, c.id AS cliente_id
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

  // Se ordena por el MISMO nombre que se muestra en pantalla. Antes ordenaba por
  // `c.nombre` (la razón social) y mostraba `nombre_nova`: para los clientes donde los
  // dos difieren —"POLO TOP" se muestra como "GONZALO DE URQUIZA"— la lista parecía
  // desordenada al azar.
  sql += " ORDER BY COALESCE(NULLIF(c.nombre_nova,''), c.nombre) COLLATE NOCASE, e.fecha";
  const rows = (await db.prepare(sql).all(...params)).map(mapEnvio);

  // Map y NO un objeto común: las claves de un objeto que parecen números las reordena
  // JavaScript de menor a mayor, así que `Object.values()` devolvía los grupos por
  // cliente_id y tiraba a la basura el ORDER BY alfabético de la consulta. La lista de
  // pendientes salía ordenada por el número interno de cliente, que no significa nada
  // para el que la mira. Map respeta el orden en que se van agregando.
  const grupos = new Map();
  for (const row of rows) {
    const key = row.cliente_id;
    if (!grupos.has(key)) {
      grupos.set(key, {
        cliente_id: row.cliente_id,
        cliente_nombre: row.cliente_nombre,
        tipo_cobro: row.tipo_cobro,
        envios: [],
        total_cobrado: 0,
      });
    }
    const g = grupos.get(key);
    g.envios.push(row);
    g.total_cobrado += row.total_cobrado || 0;
  }
  return [...grupos.values()];
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
  buildPesos,
  calcularDesgloseAlCosto,
};
