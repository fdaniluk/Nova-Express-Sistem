const { getDb } = require('../db');

async function obtenerFuel(courier) {
  return getDb().prepare('SELECT * FROM configuracion WHERE courier = ?').get(courier);
}

async function listarFuel() {
  return getDb().prepare('SELECT * FROM configuracion ORDER BY courier').all();
}

async function actualizarFuel(courier, fuelPctNuevo) {
  const db = getDb();
  const actual = await obtenerFuel(courier);
  if (!actual) {
    throw new Error(`Courier no configurado: ${courier}`);
  }
  const anterior = actual.fuel_pct;
  await db.transaction(async () => {
    await db.prepare(
      `UPDATE configuracion SET fuel_pct = ?, fecha_actualizacion = datetime('now', 'localtime')
       WHERE courier = ?`
    ).run(fuelPctNuevo, courier);
    await db.prepare(
      `INSERT INTO configuracion_historial (courier, fuel_pct_anterior, fuel_pct_nuevo)
       VALUES (?, ?, ?)`
    ).run(courier, anterior, fuelPctNuevo);
  });
  return obtenerFuel(courier);
}

async function historialFuel(courier) {
  const db = getDb();
  if (courier) {
    return db
      .prepare(
        `SELECT * FROM configuracion_historial WHERE courier = ?
         ORDER BY fecha_cambio DESC`
      )
      .all(courier);
  }
  return db
    .prepare('SELECT * FROM configuracion_historial ORDER BY fecha_cambio DESC')
    .all();
}

// Fórmula de ganancia (uso futuro en Control de Facturas):
// ganancia_pct = (precio_venta − costo_facturado) / costo_facturado × 100
// Una guía se marca "a_revisar" cuando ganancia_pct < ganancia_minima_pct del courier.

async function obtenerUmbral(courier) {
  return getDb().prepare('SELECT courier, ganancia_minima_pct FROM configuracion WHERE courier = ?').get(courier);
}

async function listarUmbrales() {
  return getDb().prepare('SELECT courier, ganancia_minima_pct FROM configuracion ORDER BY courier').all();
}

async function actualizarUmbral(courier, pctNuevo) {
  const db = getDb();
  const actual = await obtenerUmbral(courier);
  if (!actual) {
    throw new Error(`Courier no configurado: ${courier}`);
  }
  const anterior = actual.ganancia_minima_pct;
  await db.transaction(async () => {
    await db.prepare(
      `UPDATE configuracion SET ganancia_minima_pct = ? WHERE courier = ?`
    ).run(pctNuevo, courier);
    await db.prepare(
      `INSERT INTO configuracion_ganancia_historial (courier, ganancia_pct_anterior, ganancia_pct_nuevo)
       VALUES (?, ?, ?)`
    ).run(courier, anterior, pctNuevo);
  });
  return obtenerUmbral(courier);
}

async function historialUmbral(courier) {
  const db = getDb();
  if (courier) {
    return db
      .prepare(
        `SELECT * FROM configuracion_ganancia_historial WHERE courier = ?
         ORDER BY fecha_cambio DESC`
      )
      .all(courier);
  }
  return db
    .prepare('SELECT * FROM configuracion_ganancia_historial ORDER BY fecha_cambio DESC')
    .all();
}

// Tolerancias de comparación contra la factura del courier (módulo Control de Facturas /
// Salidas). tolerancia_peso_pct y tolerancia_costo_pct son el desvío máximo aceptable en %.
// Sin historial: son parámetros de configuración simples (a diferencia de fuel/umbral).

const TOLERANCIA_COLS =
  'courier, tolerancia_peso_pct, tolerancia_costo_pct, tolerancia_costo_usd, tolerancia_peso_kg';

async function obtenerTolerancias(courier) {
  return getDb()
    .prepare(`SELECT ${TOLERANCIA_COLS} FROM configuracion WHERE courier = ?`)
    .get(courier);
}

async function listarTolerancias() {
  return getDb()
    .prepare(`SELECT ${TOLERANCIA_COLS} FROM configuracion ORDER BY courier`)
    .all();
}

async function actualizarTolerancias(courier, pesoPct, costoPct, costoUsd, pesoKg) {
  const db = getDb();
  const actual = await obtenerTolerancias(courier);
  if (!actual) {
    throw new Error(`Courier no configurado: ${courier}`);
  }
  await db.prepare(
    `UPDATE configuracion
        SET tolerancia_peso_pct = ?, tolerancia_costo_pct = ?,
            tolerancia_costo_usd = ?, tolerancia_peso_kg = ?
      WHERE courier = ?`
  ).run(pesoPct, costoPct, costoUsd, pesoKg, courier);
  return obtenerTolerancias(courier);
}

// ── FUEL NOVA ───────────────────────────────────────────────────────────────
// El % de combustible que pone Nova, distinto del que nos cobra cada courier. Una sola
// fila (id = 1). Se expone con la misma forma que los otros dos ({courier, fuel_pct, ...})
// para que la pantalla de Configuracion los muestre juntos sin casos especiales.
async function obtenerFuelNova() {
  const fila = await getDb().prepare('SELECT * FROM configuracion_nova WHERE id = 1').get();
  if (!fila) return { courier: 'NOVA', fuel_pct: 0, fecha_actualizacion: null };
  return { courier: 'NOVA', fuel_pct: fila.fuel_pct, fecha_actualizacion: fila.fecha_actualizacion };
}

async function actualizarFuelNova(fuelPctNuevo) {
  const db = getDb();
  const actual = await obtenerFuelNova();
  const anterior = Number(actual.fuel_pct) || 0;
  await db.transaction(async () => {
    await db.prepare(
      `INSERT INTO configuracion_nova (id, fuel_pct, fecha_actualizacion)
       VALUES (1, ?, datetime('now','localtime'))
       ON CONFLICT(id) DO UPDATE SET fuel_pct = excluded.fuel_pct,
                                     fecha_actualizacion = excluded.fecha_actualizacion`
    ).run(fuelPctNuevo);
    await db.prepare(
      `INSERT INTO configuracion_nova_historial (fuel_pct_anterior, fuel_pct_nuevo)
       VALUES (?, ?)`
    ).run(anterior, fuelPctNuevo);
  });
  return obtenerFuelNova();
}

async function historialFuelNova() {
  return getDb()
    .prepare('SELECT * FROM configuracion_nova_historial ORDER BY fecha_cambio DESC')
    .all();
}

// Los TRES fuels juntos, que es lo que consume la pantalla de Configuracion.
async function listarFuelTodos() {
  const porCourier = await listarFuel();
  const nova = await obtenerFuelNova();
  return [nova, ...porCourier];
}

module.exports = {
  obtenerFuel, listarFuel, actualizarFuel, historialFuel,
  obtenerFuelNova, actualizarFuelNova, historialFuelNova, listarFuelTodos,
  obtenerUmbral, listarUmbrales, actualizarUmbral, historialUmbral,
  obtenerTolerancias, listarTolerancias, actualizarTolerancias,
};
