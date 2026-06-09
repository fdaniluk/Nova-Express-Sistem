const { getDb } = require('../db');
const configuracionModel = require('./configuracion.model');
const envioModel = require('./envio.model');
const { calcularFleteFuel, redondear2, cotizarEnvio, calcularSeguro, calcSeguroDHL } = require('../services/calculos.service');

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

// Descompone cot.precioBase (resultado de cotizarEnvio con profitPct=0) en flete/fuel/seguro
// para poblar las columnas de liquidacion_items manteniendo flete+fuel+seguro = precioBase.
//
// UPS: precioBase = (fleteBase + surge) * (1 + fuel%) + manejo + seguro
//   → flete = fleteBase + surge + manejo (surge y manejo combinados con flete)
//   → fuel  = aplicado sobre (fleteBase + surge)
//   → seguro = calcularSeguro(fob)
//
// DHL: precioBase = fleteBase * (1 + fuel%) + seguroDHL + goGreen
//   → flete  = fleteBase (tarifa tabla pura)
//   → fuel   = aplicado sobre flete
//   → seguro = seguroDHL + goGreen combinados
function descomponerPrecioBase(cot, envio, fuelPct) {
  const fuelDecimal = fuelPct / 100;
  const pf = envio.peso_facturable || 0;

  if (envio.courier === 'DHL') {
    const goGreen = redondear2(pf * 0.98);
    const seguroDHL = calcSeguroDHL(envio.fob || 0).monto;
    const seguro = redondear2(seguroDHL + goGreen);
    const fleteConFuel = redondear2(cot.precioBase - seguro);
    const flete = redondear2(fleteConFuel / (1 + fuelDecimal));
    const fuel = redondear2(fleteConFuel - flete);
    return { flete, fuel, seguro };
  }

  // UPS (EXP o SAV): precioBase = (fleteBase + surge) * (1+fuel%) + manejo + seguro
  const seguro = calcularSeguro(envio.fob || 0);
  const manejo = cot.manejo || 0;
  const fleteConFuel = redondear2(cot.precioBase - seguro - manejo);
  const fleteConSurge = redondear2(fleteConFuel / (1 + fuelDecimal));
  const fuel = redondear2(fleteConFuel - fleteConSurge);
  // Manejo se agrega al flete para mantener flete+fuel+seguro = precioBase
  return { flete: redondear2(fleteConSurge + manejo), fuel, seguro };
}

async function calcularItem(envio, adicional = 0, cotizacion = null) {
  const fuelCfg = await configuracionModel.obtenerFuel(envio.courier);
  const fuelPct = fuelCfg?.fuel_pct ?? 0;
  const adic = redondear2(adicional);

  // Leer tarifa_pct del cliente, igual que hace el cotizador al seleccionar un cliente.
  // Fallback 20%: coincide con el value="20" hardcodeado en los inputs del cotizador cuando
  // el cliente no tiene tarifa configurada (tarifa_pct null o 0).
  const db = getDb();
  const clienteRow = await db.prepare('SELECT tarifa_pct FROM clientes WHERE id = ?').get(envio.cliente_id);
  const tarifaPct = (clienteRow?.tarifa_pct > 0) ? clienteRow.tarifa_pct : 20;

  // Suposición: courier 'UPS' → UPS Expedited (no hay columna que distinga EXP/SAV en envios).
  // Suposición: tipo_envio 'exportacion' → 'export'; cualquier otro → 'import'.
  const servicio = envio.courier === 'DHL' ? 'DHL' : 'UPS_EXP';
  const tipo = (envio.tipo_envio || '').toLowerCase().includes('import') ? 'import' : 'export';

  // Cotizamos con la tarifa del cliente para obtener el precio completo (igual que el cotizador).
  // cot.precioBase = flete+surge+fuel+manejo+seguro sin profit; cot.precioFinal incluye tarifaPct.
  const bultos = envio.peso_real != null
    ? [{ pesoReal: envio.peso_real, largo: envio.largo, ancho: envio.ancho, alto: envio.alto }]
    : [];
  const cot = cotizarEnvio({
    pais: envio.pais_destino,
    tipo,
    servicio,
    pesoFacturable: envio.peso_facturable || 0,
    fob: envio.fob || 0,
    fuelPct,
    profitPct: tarifaPct,
    zonaOverride: envio.zona,
    bultos,
  });

  let flete, fuel, seguro, totalUsd;
  let precioCotizado, profitPctUsado, utilidadUsd, servicioCotizado;

  if (cot) {
    // descomponerPrecioBase usa cot.precioBase (sin profit) para flete/fuel/seguro.
    ({ flete, fuel, seguro } = descomponerPrecioBase(cot, envio, fuelPct));

    if (cotizacion) {
      // Cotización manual del usuario: su precio y profit tienen precedencia.
      totalUsd = redondear2(cotizacion.precioFinal + adic);
      precioCotizado = cotizacion.precioFinal;
      profitPctUsado = cotizacion.profitPct;
      utilidadUsd = cotizacion.utilidad;
      servicioCotizado = cotizacion.servicio;
    } else {
      // Auto: precio final = precioBase × (1 + tarifaPct%), igual que el cotizador.
      totalUsd = redondear2(cot.precioFinal + adic);
      precioCotizado = cot.precioFinal;
      profitPctUsado = tarifaPct;
      utilidadUsd = cot.utilidad;
      servicioCotizado = cot.servicio;
    }
  } else {
    // Fallback: el país no figura en las tablas de tarifas → comportamiento anterior.
    const d = calcularFleteFuel(envio.total_cobrado, envio.fob || 0, fuelPct);
    flete = d.flete;
    fuel = d.fuel;
    seguro = d.seguro;
    totalUsd = redondear2(flete + fuel + seguro + adic);
    precioCotizado = cotizacion?.precioFinal ?? null;
    profitPctUsado = cotizacion?.profitPct ?? null;
    utilidadUsd = cotizacion?.utilidad ?? null;
    servicioCotizado = cotizacion?.servicio ?? null;
  }

  return {
    envio_id: envio.id,
    flete,
    fuel,
    seguro,
    adicional: adic,
    total_usd: totalUsd,
    fuel_pct_usado: fuelPct,
    precio_cotizado: precioCotizado,
    profit_pct: profitPctUsado,
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
