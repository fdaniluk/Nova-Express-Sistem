const { getDb } = require('../db');
const configuracionModel = require('./configuracion.model');
const envioModel = require('./envio.model');
const { calcularFleteFuel, redondear2, cotizarEnvio } = require('../services/calculos.service');

// Migración automática: agrega columnas nuevas si no existen
async function migrarColumnas() {
  const db = getDb();
  const rows = await db.prepare("PRAGMA table_info(liquidacion_items)").all();
  const cols = rows.map(c => c.name);
  if (!cols.includes('precio_cotizado')) {
    await db.prepare("ALTER TABLE liquidacion_items ADD COLUMN precio_cotizado REAL").run();
  }
  if (!cols.includes('profit_pct')) {
    await db.prepare("ALTER TABLE liquidacion_items ADD COLUMN profit_pct REAL").run();
  }
  if (!cols.includes('utilidad_usd')) {
    await db.prepare("ALTER TABLE liquidacion_items ADD COLUMN utilidad_usd REAL").run();
  }
  if (!cols.includes('servicio_cotizado')) {
    await db.prepare("ALTER TABLE liquidacion_items ADD COLUMN servicio_cotizado TEXT").run();
  }
}

migrarColumnas().catch(() => {});

async function calcularItem(envio, adicional = 0, cotizacion = null) {
  const fuelCfg = await configuracionModel.obtenerFuel(envio.courier);
  const fuelPct = fuelCfg?.fuel_pct ?? 0;
  const { seguro, flete, fuel } = calcularFleteFuel(
    envio.total_cobrado,
    envio.fob,
    fuelPct
  );
  const adic = redondear2(adicional);
  const totalUsd = redondear2(flete + fuel + seguro + adic);

  // Datos del cotizador (opcionales)
  const precioCotizado = cotizacion?.precioFinal ?? null;
  const profitPct = cotizacion?.profitPct ?? null;
  const utilidadUsd = cotizacion?.utilidad ?? null;
  const servicioCotizado = cotizacion?.servicio ?? null;

  return {
    envio_id: envio.id,
    flete,
    fuel,
    seguro,
    adicional: adic,
    total_usd: totalUsd,
    fuel_pct_usado: fuelPct,
    precio_cotizado: precioCotizado,
    profit_pct: profitPct,
    utilidad_usd: utilidadUsd,
    servicio_cotizado: servicioCotizado,
    envio,
  };
}

async function preview({ cliente_id, envio_ids, cargos = [], cotizaciones = [] }) {
  const db = getDb();
  const placeholders = envio_ids.map(() => '?').join(',');
  const envios = await db
    .prepare(
      `SELECT * FROM envios
       WHERE id IN (${placeholders}) AND cliente_id = ? AND liquidado = 0`
    )
    .all(...envio_ids, cliente_id);

  if (envios.length !== envio_ids.length) {
    const err = new Error('Algunos envíos no existen, no pertenecen al cliente o ya están liquidados');
    err.status = 400;
    throw err;
  }

  const cargoMap = {};
  for (const c of cargos) {
    cargoMap[c.envio_id] = (cargoMap[c.envio_id] || 0) + (Number(c.monto) || 0);
  }

  // Mapa de cotizaciones por envio_id
  const cotizacionMap = {};
  for (const cot of cotizaciones) {
    cotizacionMap[cot.envio_id] = cot;
  }

  const items = await Promise.all(
    envios.map((e) => calcularItem(e, cargoMap[e.id] || 0, cotizacionMap[e.id] || null))
  );
  const total = redondear2(items.reduce((s, i) => s + i.total_usd, 0));
  const utilidadTotal = redondear2(items.reduce((s, i) => s + (i.utilidad_usd || 0), 0));
  return { items, total, utilidad_total: utilidadTotal, cantidad: items.length };
}

async function crear({ cliente_id, periodo_desde, periodo_hasta, envio_ids, cargos = [], cotizaciones = [], confirmar = false }) {
  await migrarColumnas();
  const previewData = await preview({ cliente_id, envio_ids, cargos, cotizaciones });
  const db = getDb();

  const id = await db.transaction(async () => {
    const liqResult = await db
      .prepare(
        `INSERT INTO liquidaciones (cliente_id, periodo_desde, periodo_hasta, total, estado)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        cliente_id,
        periodo_desde,
        periodo_hasta,
        previewData.total,
        confirmar ? 'confirmada' : 'borrador'
      );
    const liquidacionId = liqResult.lastInsertRowid;

    const insertItem = db.prepare(
      `INSERT INTO liquidacion_items
        (liquidacion_id, envio_id, flete, fuel, seguro, adicional, total_usd, fuel_pct_usado,
         precio_cotizado, profit_pct, utilidad_usd, servicio_cotizado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertCargo = db.prepare(
      `INSERT INTO cargos_adicionales (envio_id, liquidacion_id, descripcion, monto) 
       VALUES (?, ?, ?, ?)`
    );

    const cargoByEnvio = {};
    for (const c of cargos) {
      if (!cargoByEnvio[c.envio_id]) cargoByEnvio[c.envio_id] = [];
      cargoByEnvio[c.envio_id].push(c);
    }

    for (const item of previewData.items) {
      await insertItem.run(
        liquidacionId,
        item.envio_id,
        item.flete,
        item.fuel,
        item.seguro,
        item.adicional,
        item.total_usd,
        item.fuel_pct_usado,
        item.precio_cotizado,
        item.profit_pct,
        item.utilidad_usd,
        item.servicio_cotizado
      );
      const list = cargoByEnvio[item.envio_id] || [];
      for (const c of list) {
        await insertCargo.run(item.envio_id, liquidacionId, c.descripcion || 'Adicional', c.monto);
      }
      if (item.adicional > 0 && list.length === 0) {
        await insertCargo.run(item.envio_id, liquidacionId, 'Cargo adicional', item.adicional);
      }
    }

    if (confirmar) {
      const fecha = new Date().toISOString().slice(0, 10);
      await envioModel.marcarLiquidados(envio_ids, liquidacionId, fecha);
    }

    return liquidacionId;
  });

  return buscarPorId(id);
}

async function confirmar(id) {
  const db = getDb();
  const liq = await buscarPorId(id);
  if (!liq) return null;
  if (liq.estado === 'confirmada') {
    const err = new Error('La liquidación ya está confirmada');
    err.status = 400;
    throw err;
  }

  const envioIds = liq.items.map((i) => i.envio_id);
  const fecha = new Date().toISOString().slice(0, 10);

  await db.transaction(async () => {
    await db.prepare(
      `UPDATE liquidaciones SET estado = 'confirmada', updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    ).run(id);
    await envioModel.marcarLiquidados(envioIds, id, fecha);
  });
  return buscarPorId(id);
}

async function buscarPorId(id) {
  const db = getDb();
  const liq = await db
    .prepare(
      `SELECT l.*, c.nombre AS cliente_nombre, c.tipo_cobro
       FROM liquidaciones l
       JOIN clientes c ON c.id = l.cliente_id
       WHERE l.id = ?`
    )
    .get(id);
  if (!liq) return null;

  const items = await db
    .prepare(
      `SELECT li.*, e.numero_guia, e.fecha, e.pais_destino, e.zona, e.tipo_envio,
              e.peso_facturable, e.fob, e.courier, e.total_cobrado
       FROM liquidacion_items li
       JOIN envios e ON e.id = li.envio_id
       WHERE li.liquidacion_id = ?
       ORDER BY e.fecha, e.numero_guia`
    )
    .all(id);

  const cargos = await db
    .prepare('SELECT * FROM cargos_adicionales WHERE liquidacion_id = ?')
    .all(id);

  return { ...liq, items, cargos };
}

async function listar(filtros = {}) {
  const db = getDb();
  let sql = `
    SELECT l.*, c.nombre AS cliente_nombre, c.tipo_cobro,
           (SELECT COUNT(*) FROM liquidacion_items WHERE liquidacion_id = l.id) AS cantidad_envios
    FROM liquidaciones l
    JOIN clientes c ON c.id = l.cliente_id
    WHERE 1=1`;
  const params = [];

  if (filtros.cliente_id) {
    sql += ' AND l.cliente_id = ?';
    params.push(filtros.cliente_id);
  }
  if (filtros.fecha_desde) {
    sql += ' AND l.fecha >= ?';
    params.push(filtros.fecha_desde);
  }
  if (filtros.fecha_hasta) {
    sql += ' AND l.fecha <= ?';
    params.push(filtros.fecha_hasta);
  }
  if (filtros.estado) {
    sql += ' AND l.estado = ?';
    params.push(filtros.estado);
  }

  sql += ' ORDER BY l.fecha DESC, l.id DESC';
  return db.prepare(sql).all(...params);
}

module.exports = {
  preview,
  crear,
  confirmar,
  buscarPorId,
  listar,
  calcularItem,
  cotizarEnvio,
};
