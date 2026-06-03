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

module.exports = { obtenerFuel, listarFuel, actualizarFuel, historialFuel, obtenerUmbral, listarUmbrales, actualizarUmbral, historialUmbral };
