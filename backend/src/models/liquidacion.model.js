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

// Liquidación = documento de cara al cliente: LEE los valores ya guardados del envío y
// los presenta de forma que el desglose cierre EXACTO en total_cobrado. NO recotiza: no
// llama al motor cotizarEnvio, no usa descomponerPrecioBase, no lee clientes.tarifa_pct,
// no aplica ningún profit. El profit ya está incluido en total_cobrado (lo cargó el dueño)
// y no se expone al cliente.
//
// Detalle del dato: las columnas flete/fuel/seguro/adicionales del envío se congelan en el
// alta con desglosarCosto(profitPct:0) → son el COSTO base y suman MENOS que total_cobrado
// (la diferencia es el profit). Por eso no se pueden leer tal cual para el desglose cliente.
// Criterio (definido por el dueño): seguro y adicionales (cargos itemizados reales) se
// muestran tal cual; flete+fuel balancean el resto para que la suma = total_cobrado.
async function calcularItem(envio, adicional = 0) {
  // Fuel% del desglose: si el envío tiene fuel_pct propio (congelado al cargarlo) se usa ESE
  // y NO se lee config (un envío viejo se liquida con el fuel de su época, no con el de hoy).
  // Si es NULL (envíos previos a la columna), se cae al reparto proporcional con el fuel de
  // config, que es la conducta histórica que ya cerraba en total_cobrado.
  let fuelPct;
  if (envio.fuel_pct !== null && envio.fuel_pct !== undefined) {
    fuelPct = envio.fuel_pct;
  } else {
    const fuelCfg = await configuracionModel.obtenerFuel(envio.courier);
    fuelPct = fuelCfg?.fuel_pct ?? 0;
  }
  const fuelDecimal = fuelPct / 100;

  // Adicional manual de la fila (input ADICIONAL USD): EXTRA que el dueño agrega a mano en
  // esta liquidación, encima de lo cobrado. No está incluido en total_cobrado → se suma.
  const adicManual = redondear2(adicional);

  // Valores guardados que se muestran tal cual (forman parte de total_cobrado):
  const totalCobrado = redondear2(envio.total_cobrado || 0);
  const seguro = redondear2(envio.seguro || 0);
  // Adicionales itemizados guardados (surge en extras_json, derechos, otros). desglosarCosto
  // deja derechos/otros en 0; se suman por robustez ante datos viejos. NO se duplican con el
  // adicional manual: ese es un cargo aparte que se agrega aparte.
  const adicGuardado = redondear2(
    (envio.adicionales || 0) + (envio.derechos || 0) + (envio.otros || 0)
  );

  // flete+fuel balancean el resto del total cobrado, respetando la proporción de fuel.
  // No se recotiza ni se aplica profit: el profit ya está dentro de total_cobrado.
  const base = redondear2(totalCobrado - seguro - adicGuardado);
  const flete = redondear2(base / (1 + fuelDecimal));
  const fuel = redondear2(base - flete);

  // Columna Adicional de cara al cliente: cargos guardados + extra manual de la fila.
  const adicionalItem = redondear2(adicGuardado + adicManual);
  // Total = lo que el cliente pagó + el extra manual agregado en esta liquidación.
  // Invariante: flete + fuel + seguro + adicionalItem = total_cobrado + adicManual = totalUsd.
  const totalUsd = redondear2(totalCobrado + adicManual);

  // Servicio para columnas internas/persistencia (no se muestra al cliente).
  const servicioCotizado = envio.courier === 'DHL' ? 'DHL' : (envio.servicio_ups || null);

  // Métricas internas (NO se muestran al cliente: ni en el preview ni en el Excel). Se siguen
  // calculando y persistiendo para no romper el schema de liquidacion_items y para uso interno.
  // costoBase = desglose al costo congelado en el alta; utilidad = lo cobrado − costo.
  const costoBase = redondear2(
    (envio.flete || 0) + (envio.fuel || 0) + (envio.seguro || 0) +
    (envio.adicionales || 0) + (envio.derechos || 0) + (envio.otros || 0) -
    (envio.descuento || 0)
  );
  const utilidadUsd = redondear2(totalCobrado - costoBase);
  const profitPct = costoBase > 0 ? redondear2((utilidadUsd / costoBase) * 100) : null;

  return {
    envio_id: envio.id,
    flete,
    fuel,
    seguro,
    adicional: adicionalItem,
    total_usd: totalUsd,
    fuel_pct_usado: fuelPct,
    precio_cotizado: totalCobrado,
    profit_pct: profitPct,     // interno: no se muestra al cliente
    utilidad_usd: utilidadUsd, // interno: no se muestra al cliente
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

  // `cotizaciones` se sigue aceptando para no romper la API y el botón manual "Cotizar"
  // por fila, pero la liquidación YA NO recotiza: el desglose se arma leyendo lo guardado
  // en el envío (ver calcularItem). El flujo automático de preview no depende del cotizador.
  void cotizaciones;

  const items = await Promise.all(
    envios.map((e) => calcularItem(e, cargoMap[e.id] || 0))
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
      `SELECT l.*, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre, c.tipo_cobro
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
    SELECT l.*, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre, c.tipo_cobro,
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
  migrarColumnas,
  preview,
  crear,
  confirmar,
  buscarPorId,
  listar,
  calcularItem,
  cotizarEnvio,
};
