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

// ── FECHA DE CORTE DEL CONTROL ──────────────────────────────────────────────
// Desde qué fecha (YYYY-MM-DD) el panel de salud y las bandejas de Facturas destacan
// cosas. Pedido de Felipe (07/09/2026): el sistema se usó a medias hasta agosto, y los
// envíos viejos sin venta o de prueba llenaban "Revisar guías" de diferencias del 100 %.
const FECHA_CORTE_DEFAULT = '2026-09-01';
async function obtenerFechaCorte() {
  const fila = await getDb().prepare('SELECT fecha_corte_control FROM configuracion_nova WHERE id = 1').get();
  const v = fila && fila.fecha_corte_control;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : FECHA_CORTE_DEFAULT;
}

async function actualizarFechaCorte(fecha) {
  const db = getDb();
  await db.prepare(
    `INSERT INTO configuracion_nova (id, fuel_pct, fecha_corte_control)
     VALUES (1, 0, ?)
     ON CONFLICT(id) DO UPDATE SET fecha_corte_control = excluded.fecha_corte_control`
  ).run(fecha);
  return { fecha_corte_control: await obtenerFechaCorte() };
}

// ── NUMERACIÓN DE PROFORMAS ─────────────────────────────────────────────────
// El próximo número que el sistema pone en una proforma cuando la guía se emite con el
// campo vacío (10/09/2026). Si la oficina tipea uno a mano más alto, el contador salta
// para no repetir.
async function obtenerProformaProximo() {
  const fila = await getDb().prepare('SELECT proforma_proximo FROM configuracion_nova WHERE id = 1').get();
  const n = fila ? Number(fila.proforma_proximo) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 1300;
}

async function actualizarProformaProximo(n) {
  const db = getDb();
  await db.prepare(
    `INSERT INTO configuracion_nova (id, fuel_pct, proforma_proximo)
     VALUES (1, 0, ?)
     ON CONFLICT(id) DO UPDATE SET proforma_proximo = excluded.proforma_proximo`
  ).run(n);
  return { proforma_proximo: await obtenerProformaProximo() };
}

// Toma el próximo número (y deja listo el siguiente). Se llama recién cuando UPS ya
// devolvió la guía: una guía rechazada no gasta número.
async function tomarNumeroProforma() {
  const n = await obtenerProformaProximo();
  await actualizarProformaProximo(n + 1);
  return n;
}

// La oficina tipeó un número a mano: si es un entero mayor o igual al próximo Y está
// cerca (hasta 1000 adelante), el contador sigue desde ahí, así el siguiente automático
// no lo repite. Un número lejano (un formato viejo tipo 79122211, o un error de tipeo)
// NO arrastra el contador: se respeta en esa guía y la numeración sigue como estaba.
const SALTO_MAXIMO_PROFORMA = 1000;
async function registrarNumeroProformaManual(valor) {
  const n = Number(String(valor ?? '').trim());
  if (!Number.isInteger(n) || n <= 0) return;
  const prox = await obtenerProformaProximo();
  if (n >= prox && n < prox + SALTO_MAXIMO_PROFORMA) await actualizarProformaProximo(n + 1);
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
  obtenerProformaProximo, actualizarProformaProximo, tomarNumeroProforma, registrarNumeroProformaManual,
  obtenerFuel, listarFuel, actualizarFuel, historialFuel,
  obtenerFuelNova, actualizarFuelNova, historialFuelNova, listarFuelTodos,
  obtenerUmbral, listarUmbrales, actualizarUmbral, historialUmbral,
  obtenerTolerancias, listarTolerancias, actualizarTolerancias,
  obtenerFechaCorte, actualizarFechaCorte, FECHA_CORTE_DEFAULT,
};
