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

module.exports = { obtenerFuel, listarFuel, actualizarFuel, historialFuel };
