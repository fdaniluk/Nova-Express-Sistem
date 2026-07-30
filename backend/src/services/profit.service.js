const { getDb } = require('../db');

// ── Dominio de la matriz de profit ────────────────────────────────────────────
// Constantes compartidas por servicio + endpoints. Mantener alineadas con los CHECK
// de la tabla profit_overrides (backend/src/db/index.js).

const SERVICIOS = ['DHL', 'UPS_EXP', 'UPS_SAVER'];
const TIPOS = ['export', 'import'];
const ZONAS = [1, 2, 3, 4, 5, 6];

// Cómo se arma el precio de venta del flete de un cliente (clientes.modo_tarifa).
const MODOS_TARIFA = ['porcentaje', 'por_kg'];

// Bandas de peso fijas, en kg sobre peso facturable.
// Límite inferior exclusivo, superior inclusivo, salvo la primera que incluye 0.
// La banda 50+ no tiene tope (max = null).
const BANDAS = [
  { min: 0, max: 5 },
  { min: 5, max: 10 },
  { min: 10, max: 15 },
  { min: 15, max: 20 },
  { min: 20, max: 25 },
  { min: 25, max: 30 },
  { min: 30, max: 40 },
  { min: 40, max: 50 },
  { min: 50, max: null },
];

/**
 * Deriva la banda de peso desde el peso facturable.
 * @returns {{min:number, max:number|null}|null} banda o null si el peso no es un número válido.
 */
function derivarBanda(pesoFacturable) {
  const pf = Number(pesoFacturable);
  if (!Number.isFinite(pf) || pf < 0) return null;
  for (const banda of BANDAS) {
    if (banda.max === null) {
      if (pf > banda.min) return banda;
    } else if (banda.min === 0) {
      if (pf >= 0 && pf <= banda.max) return banda;
    } else if (pf > banda.min && pf <= banda.max) {
      return banda;
    }
  }
  return null;
}

/**
 * Valida y normaliza las coordenadas de un override.
 * Acepta zona (null | 1..6) y una banda expresada como par peso_min/peso_max, que debe
 * ser (null, null) o coincidir exactamente con una banda definida.
 * @returns {{servicio, tipo, zona, peso_min, peso_max}} coordenadas normalizadas.
 * @throws {Error} con .status = 400 ante cualquier coordenada inválida.
 */
function validarCoordenadas({ servicio, tipo, zona, peso_min, peso_max }) {
  const err = (msg) => {
    const e = new Error(msg);
    e.status = 400;
    return e;
  };

  if (!SERVICIOS.includes(servicio)) {
    throw err(`servicio inválido: ${servicio}. Válidos: ${SERVICIOS.join(', ')}`);
  }
  if (!TIPOS.includes(tipo)) {
    throw err(`tipo inválido: ${tipo}. Válidos: ${TIPOS.join(', ')}`);
  }

  let zonaNorm = null;
  if (zona !== null && zona !== undefined && zona !== '') {
    zonaNorm = Number(zona);
    if (!ZONAS.includes(zonaNorm)) {
      throw err(`zona inválida: ${zona}. Válidas: ${ZONAS.join(', ')} o null`);
    }
  }

  const minProvisto = peso_min !== null && peso_min !== undefined && peso_min !== '';
  const maxProvisto = peso_max !== null && peso_max !== undefined && peso_max !== '';

  let pesoMinNorm = null;
  let pesoMaxNorm = null;
  if (minProvisto) {
    pesoMinNorm = Number(peso_min);
    pesoMaxNorm = maxProvisto ? Number(peso_max) : null;
    const banda = BANDAS.find((b) => b.min === pesoMinNorm);
    if (!banda) {
      throw err(
        `banda inválida: peso_min ${peso_min} no coincide con ninguna banda definida ` +
          `(${BANDAS.map((b) => b.min).join(', ')})`
      );
    }
    if (banda.max !== pesoMaxNorm) {
      throw err(
        `banda inválida: para peso_min ${pesoMinNorm} el peso_max debe ser ${banda.max}`
      );
    }
  } else if (maxProvisto) {
    throw err('banda inválida: peso_max provisto sin peso_min');
  }

  return { servicio, tipo, zona: zonaNorm, peso_min: pesoMinNorm, peso_max: pesoMaxNorm };
}

async function clienteExiste(clienteId) {
  const row = await getDb().prepare('SELECT id FROM clientes WHERE id = ?').get(clienteId);
  return Boolean(row);
}

/**
 * Resuelve el profit aplicable a un envío por precedencia de más específico a más general:
 *   1. celda   → servicio + tipo + zona + banda
 *   2. banda   → servicio + tipo + banda (zona NULL)
 *   3. zona    → servicio + tipo + zona (banda NULL)
 *   4. tabla   → servicio + tipo (zona NULL, banda NULL)
 *   5. cliente → clientes.tarifa_pct
 * @returns {Promise<{profitPct:number, origen:string}|null>} null si el cliente no existe.
 */
async function resolverProfit({ clienteId, servicio, tipo, zona, pesoFacturable }) {
  const db = getDb();

  const cliente = await db
    .prepare('SELECT id, tarifa_pct FROM clientes WHERE id = ?')
    .get(clienteId);
  if (!cliente) return null;

  const banda = derivarBanda(pesoFacturable);
  const zonaNum =
    zona === null || zona === undefined || zona === '' ? null : Number(zona);

  // 1. celda: zona + banda concretas.
  if (zonaNum !== null && banda) {
    const row = await db
      .prepare(
        `SELECT profit_pct FROM profit_overrides
         WHERE cliente_id = ? AND servicio = ? AND tipo = ? AND zona = ? AND peso_min = ?`
      )
      .get(clienteId, servicio, tipo, zonaNum, banda.min);
    if (row) return { profitPct: row.profit_pct, origen: 'celda' };
  }

  // 2. banda entera: misma banda, cualquier zona.
  if (banda) {
    const row = await db
      .prepare(
        `SELECT profit_pct FROM profit_overrides
         WHERE cliente_id = ? AND servicio = ? AND tipo = ? AND zona IS NULL AND peso_min = ?`
      )
      .get(clienteId, servicio, tipo, banda.min);
    if (row) return { profitPct: row.profit_pct, origen: 'banda' };
  }

  // 3. zona entera: misma zona, cualquier banda.
  if (zonaNum !== null) {
    const row = await db
      .prepare(
        `SELECT profit_pct FROM profit_overrides
         WHERE cliente_id = ? AND servicio = ? AND tipo = ? AND zona = ? AND peso_min IS NULL`
      )
      .get(clienteId, servicio, tipo, zonaNum);
    if (row) return { profitPct: row.profit_pct, origen: 'zona' };
  }

  // 4. general de la tabla: servicio + tipo.
  const tablaRow = await db
    .prepare(
      `SELECT profit_pct FROM profit_overrides
       WHERE cliente_id = ? AND servicio = ? AND tipo = ? AND zona IS NULL AND peso_min IS NULL`
    )
    .get(clienteId, servicio, tipo);
  if (tablaRow) return { profitPct: tablaRow.profit_pct, origen: 'tabla' };

  // 5. general del cliente.
  return { profitPct: cliente.tarifa_pct ?? 0, origen: 'cliente' };
}

/**
 * Devuelve el estado de la matriz para un servicio + tipo:
 * el general de tabla (o null) y la lista de overrides de zona/banda/celda.
 */
async function obtenerMatriz(clienteId, servicio, tipo) {
  const db = getDb();

  const rows = await db
    .prepare(
      `SELECT id, zona, peso_min, peso_max, profit_pct
       FROM profit_overrides
       WHERE cliente_id = ? AND servicio = ? AND tipo = ?
       ORDER BY zona IS NOT NULL, zona, peso_min IS NOT NULL, peso_min`
    )
    .all(clienteId, servicio, tipo);

  const tablaRow = rows.find((r) => r.zona === null && r.peso_min === null) || null;
  const overrides = rows
    .filter((r) => !(r.zona === null && r.peso_min === null))
    .map((r) => ({
      id: r.id,
      zona: r.zona,
      peso_min: r.peso_min,
      peso_max: r.peso_max,
      profit_pct: r.profit_pct,
      nivel: r.zona !== null && r.peso_min !== null ? 'celda' : r.peso_min !== null ? 'banda' : 'zona',
    }));

  return {
    servicio,
    tipo,
    general_tabla: tablaRow ? { id: tablaRow.id, profit_pct: tablaRow.profit_pct } : null,
    overrides,
  };
}

/**
 * Upsert de un override. SQLite trata NULLs como distintos en UNIQUE, por lo que el
 * upsert se hace manual: se busca la fila por coordenadas (con IS para los NULL) y se
 * UPDATE-a o INSERT-a según exista.
 */
async function upsertOverride(clienteId, body) {
  const db = getDb();
  const { servicio, tipo, zona, peso_min, peso_max } = validarCoordenadas(body);

  if (body.profit_pct === null || body.profit_pct === undefined || body.profit_pct === '') {
    const e = new Error('profit_pct es obligatorio');
    e.status = 400;
    throw e;
  }
  const profitPct = Number(body.profit_pct);
  if (!Number.isFinite(profitPct)) {
    const e = new Error(`profit_pct inválido: ${body.profit_pct}`);
    e.status = 400;
    throw e;
  }

  const existente = await db
    .prepare(
      `SELECT id FROM profit_overrides
       WHERE cliente_id = ? AND servicio = ? AND tipo = ?
         AND zona IS ? AND peso_min IS ?`
    )
    .get(clienteId, servicio, tipo, zona, peso_min);

  if (existente) {
    await db
      .prepare('UPDATE profit_overrides SET peso_max = ?, profit_pct = ? WHERE id = ?')
      .run(peso_max, profitPct, existente.id);
    return { id: existente.id, servicio, tipo, zona, peso_min, peso_max, profit_pct: profitPct };
  }

  const result = await db
    .prepare(
      `INSERT INTO profit_overrides (cliente_id, servicio, tipo, zona, peso_min, peso_max, profit_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(clienteId, servicio, tipo, zona, peso_min, peso_max, profitPct);

  return {
    id: result.lastInsertRowid,
    servicio,
    tipo,
    zona,
    peso_min,
    peso_max,
    profit_pct: profitPct,
  };
}

/**
 * Borra un override puntual identificado por sus coordenadas.
 * @returns {Promise<boolean>} true si borró una fila.
 */
async function eliminarOverride(clienteId, body) {
  const db = getDb();
  const { servicio, tipo, zona, peso_min } = validarCoordenadas(body);

  const result = await db
    .prepare(
      `DELETE FROM profit_overrides
       WHERE cliente_id = ? AND servicio = ? AND tipo = ?
         AND zona IS ? AND peso_min IS ?`
    )
    .run(clienteId, servicio, tipo, zona, peso_min);

  return result.changes > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tarifa POR KILO (clientes con modo_tarifa = 'por_kg')
//
// Hay clientes cuya tarifa no es un porcentaje sobre el flete del courier sino un precio
// fijo en dólares por kilo, según la zona y el rango de peso. Ejemplo real: de 1 a 10 kg
// paga 5 USD el kilo, así que un envío de 6 kg tiene un flete de venta de 30 USD.
//
// Reglas (definidas con Felipe):
//   · El precio por kilo REEMPLAZA el flete de venta. Nada más. Fuel, seguro, surge, DDP,
//     zona de entrega y demás recargos del courier se calculan y se cobran igual que a
//     cualquier otro cliente.
//   · Los rangos los define cada cliente: no hay bandas fijas como en la matriz de profit.
//   · Los límites son INCLUSIVOS de los dos lados. peso_max vacío = de ahí en adelante.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Valida y normaliza las coordenadas de una tarifa por kilo.
 * A diferencia de validarCoordenadas (matriz de profit), el rango es libre: solo se exige
 * que sea coherente (min >= 0, max > min).
 * @throws {Error} con .status = 400 ante cualquier coordenada inválida.
 */
function validarCoordenadasKg({ servicio, tipo, zona, peso_min, peso_max }) {
  const err = (msg) => {
    const e = new Error(msg);
    e.status = 400;
    return e;
  };

  if (!SERVICIOS.includes(servicio)) {
    throw err(`servicio inválido: ${servicio}. Válidos: ${SERVICIOS.join(', ')}`);
  }
  if (!TIPOS.includes(tipo)) {
    throw err(`tipo inválido: ${tipo}. Válidos: ${TIPOS.join(', ')}`);
  }

  let zonaNorm = null;
  if (zona !== null && zona !== undefined && zona !== '') {
    zonaNorm = Number(zona);
    if (!ZONAS.includes(zonaNorm)) {
      throw err(`zona inválida: ${zona}. Válidas: ${ZONAS.join(', ')} o null`);
    }
  }

  const vacio = (v) => v === null || v === undefined || v === '';

  let minNorm = null;
  let maxNorm = null;
  if (!vacio(peso_min)) {
    minNorm = Number(peso_min);
    if (!Number.isFinite(minNorm) || minNorm < 0) {
      throw err(`peso desde inválido: ${peso_min}`);
    }
  }
  if (!vacio(peso_max)) {
    maxNorm = Number(peso_max);
    if (!Number.isFinite(maxNorm) || maxNorm <= 0) {
      throw err(`peso hasta inválido: ${peso_max}`);
    }
  }
  if (minNorm === null && maxNorm !== null) {
    throw err('rango inválido: hay "peso hasta" sin "peso desde"');
  }
  if (minNorm !== null && maxNorm !== null && maxNorm <= minNorm) {
    throw err(`rango inválido: "hasta" (${maxNorm}) tiene que ser mayor que "desde" (${minNorm})`);
  }

  return { servicio, tipo, zona: zonaNorm, peso_min: minNorm, peso_max: maxNorm };
}

/**
 * Devuelve el modo de tarifa y el fuel propio de un cliente.
 * @returns {Promise<{modo:string, fuelPctPropio:number|null, tarifaPct:number}|null>}
 *          null si el cliente no existe.
 */
async function obtenerModoCliente(clienteId) {
  const row = await getDb()
    .prepare('SELECT modo_tarifa, fuel_pct_propio, tarifa_pct FROM clientes WHERE id = ?')
    .get(clienteId);
  if (!row) return null;
  const modo = MODOS_TARIFA.includes(row.modo_tarifa) ? row.modo_tarifa : 'porcentaje';
  const fuel =
    row.fuel_pct_propio === null || row.fuel_pct_propio === undefined
      ? null
      : Number(row.fuel_pct_propio);
  return {
    modo,
    fuelPctPropio: Number.isFinite(fuel) ? fuel : null,
    tarifaPct: row.tarifa_pct ?? 0,
  };
}

/**
 * Resuelve el precio por kilo aplicable, con la MISMA precedencia que resolverProfit:
 *   1. celda → servicio + tipo + zona + rango que contiene al peso
 *   2. rango → servicio + tipo + rango que contiene al peso (zona NULL)
 *   3. zona  → servicio + tipo + zona (sin rango)
 *   4. tabla → servicio + tipo (sin zona ni rango)
 * @returns {Promise<{precioKg:number, origen:string, peso_min, peso_max}|null>}
 *          null si el cliente no tiene ninguna tarifa por kilo que aplique.
 */
async function resolverTarifaKg({ clienteId, servicio, tipo, zona, pesoFacturable }) {
  const db = getDb();
  const pf = Number(pesoFacturable);
  const zonaNum = zona === null || zona === undefined || zona === '' ? null : Number(zona);

  // El rango es libre, así que puede haber más de una fila que contenga al peso si la
  // oficina cargó rangos superpuestos. Se toma la de "desde" más alto (la más específica)
  // y se avisa por consola, que es un error de carga, no de cálculo.
  const enRango = (rows) => {
    const candidatos = rows.filter(
      (r) => Number.isFinite(pf) && pf >= r.peso_min && (r.peso_max === null || pf <= r.peso_max)
    );
    if (candidatos.length > 1) {
      console.warn(
        `[resolverTarifaKg] rangos superpuestos (cliente_id=${clienteId}, ${servicio}/${tipo}, ` +
          `zona=${zonaNum}, pf=${pf}): ${candidatos.map((c) => `${c.peso_min}-${c.peso_max}`).join(', ')}. ` +
          'Se usa el de "desde" más alto.'
      );
    }
    return candidatos.sort((a, b) => b.peso_min - a.peso_min)[0] || null;
  };

  // 1. celda: zona + rango.
  if (zonaNum !== null && Number.isFinite(pf)) {
    const rows = await db
      .prepare(
        `SELECT peso_min, peso_max, precio_kg FROM tarifa_kg_overrides
         WHERE cliente_id = ? AND servicio = ? AND tipo = ? AND zona = ? AND peso_min IS NOT NULL`
      )
      .all(clienteId, servicio, tipo, zonaNum);
    const hit = enRango(rows);
    if (hit) return { precioKg: hit.precio_kg, origen: 'celda', peso_min: hit.peso_min, peso_max: hit.peso_max };
  }

  // 2. rango para todas las zonas.
  if (Number.isFinite(pf)) {
    const rows = await db
      .prepare(
        `SELECT peso_min, peso_max, precio_kg FROM tarifa_kg_overrides
         WHERE cliente_id = ? AND servicio = ? AND tipo = ? AND zona IS NULL AND peso_min IS NOT NULL`
      )
      .all(clienteId, servicio, tipo);
    const hit = enRango(rows);
    if (hit) return { precioKg: hit.precio_kg, origen: 'banda', peso_min: hit.peso_min, peso_max: hit.peso_max };
  }

  // 3. zona entera, cualquier peso.
  if (zonaNum !== null) {
    const row = await db
      .prepare(
        `SELECT peso_min, peso_max, precio_kg FROM tarifa_kg_overrides
         WHERE cliente_id = ? AND servicio = ? AND tipo = ? AND zona = ? AND peso_min IS NULL`
      )
      .get(clienteId, servicio, tipo, zonaNum);
    if (row) return { precioKg: row.precio_kg, origen: 'zona', peso_min: null, peso_max: null };
  }

  // 4. general de la tabla.
  const tablaRow = await db
    .prepare(
      `SELECT peso_min, peso_max, precio_kg FROM tarifa_kg_overrides
       WHERE cliente_id = ? AND servicio = ? AND tipo = ? AND zona IS NULL AND peso_min IS NULL`
    )
    .get(clienteId, servicio, tipo);
  if (tablaRow) return { precioKg: tablaRow.precio_kg, origen: 'tabla', peso_min: null, peso_max: null };

  return null;
}

/**
 * Resolvedor ÚNICO del precio de venta del flete. Es el que deben usar todos los
 * llamadores (cotizador, alta de envío, endpoint de cotizar): decide solo, según el modo
 * del cliente, si el flete se arma con un % de ganancia o con un precio por kilo.
 *
 * Si el cliente está en modo por_kg pero NINGUNA tarifa por kilo cubre ese peso/zona, NO
 * se cobra cero ni se rompe: se cae al modo porcentaje y se devuelve el aviso en
 * `advertencia` para que la pantalla lo muestre. Un agujero en la matriz es un error de
 * carga que hay que ver, no un envío gratis.
 *
 * @returns {Promise<{modo, profitPct, precioKg, origen, advertencia}|null>} null si el
 *          cliente no existe.
 */
async function resolverTarifaVenta({ clienteId, servicio, tipo, zona, pesoFacturable }) {
  const info = await obtenerModoCliente(clienteId);
  if (!info) return null;

  if (info.modo === 'por_kg') {
    const kg = await resolverTarifaKg({ clienteId, servicio, tipo, zona, pesoFacturable });
    if (kg) {
      return {
        modo: 'por_kg',
        profitPct: 0,
        precioKg: kg.precioKg,
        origen: kg.origen,
        peso_min: kg.peso_min,
        peso_max: kg.peso_max,
        advertencia: null,
      };
    }
    const porcentaje = await resolverProfit({ clienteId, servicio, tipo, zona, pesoFacturable });
    const aviso =
      `El cliente está en modo precio por kilo pero no hay tarifa cargada para ` +
      `${servicio} ${tipo}${zona ? ` zona ${zona}` : ''} con ${pesoFacturable} kg. ` +
      `Se cotizó con el porcentaje de ganancia (${porcentaje.profitPct}%).`;
    console.warn(`[resolverTarifaVenta] cliente_id=${clienteId}: ${aviso}`);
    return {
      modo: 'porcentaje',
      profitPct: porcentaje.profitPct,
      precioKg: null,
      origen: porcentaje.origen,
      advertencia: aviso,
    };
  }

  const porcentaje = await resolverProfit({ clienteId, servicio, tipo, zona, pesoFacturable });
  return {
    modo: 'porcentaje',
    profitPct: porcentaje.profitPct,
    precioKg: null,
    origen: porcentaje.origen,
    advertencia: null,
  };
}

/**
 * Fuel% que le corresponde a un cliente: el propio si tiene, si no null para que el
 * llamador use el de Configuración. No inventa un default acá a propósito: el fuel de
 * config lo resuelve configuracion.model, y este servicio no tiene por qué duplicarlo.
 * @returns {Promise<number|null>}
 */
async function resolverFuelPropio(clienteId) {
  if (!clienteId) return null;
  const info = await obtenerModoCliente(clienteId);
  return info ? info.fuelPctPropio : null;
}

/** Estado de la matriz por kilo para un servicio + tipo. */
async function obtenerMatrizKg(clienteId, servicio, tipo) {
  const rows = await getDb()
    .prepare(
      `SELECT id, zona, peso_min, peso_max, precio_kg
       FROM tarifa_kg_overrides
       WHERE cliente_id = ? AND servicio = ? AND tipo = ?
       ORDER BY zona IS NOT NULL, zona, peso_min IS NOT NULL, peso_min`
    )
    .all(clienteId, servicio, tipo);

  const tablaRow = rows.find((r) => r.zona === null && r.peso_min === null) || null;
  const overrides = rows
    .filter((r) => !(r.zona === null && r.peso_min === null))
    .map((r) => ({
      id: r.id,
      zona: r.zona,
      peso_min: r.peso_min,
      peso_max: r.peso_max,
      precio_kg: r.precio_kg,
      nivel:
        r.zona !== null && r.peso_min !== null ? 'celda' : r.peso_min !== null ? 'banda' : 'zona',
    }));

  return {
    servicio,
    tipo,
    general_tabla: tablaRow ? { id: tablaRow.id, precio_kg: tablaRow.precio_kg } : null,
    overrides,
  };
}

/**
 * Upsert de una tarifa por kilo. Igual que upsertOverride: manual, porque SQLite trata
 * los NULL como distintos en un UNIQUE.
 */
async function upsertOverrideKg(clienteId, body) {
  const db = getDb();
  const { servicio, tipo, zona, peso_min, peso_max } = validarCoordenadasKg(body);

  if (body.precio_kg === null || body.precio_kg === undefined || body.precio_kg === '') {
    const e = new Error('precio_kg es obligatorio');
    e.status = 400;
    throw e;
  }
  const precioKg = Number(body.precio_kg);
  if (!Number.isFinite(precioKg) || precioKg < 0) {
    const e = new Error(`precio_kg inválido: ${body.precio_kg}`);
    e.status = 400;
    throw e;
  }

  const existente = await db
    .prepare(
      `SELECT id FROM tarifa_kg_overrides
       WHERE cliente_id = ? AND servicio = ? AND tipo = ?
         AND zona IS ? AND peso_min IS ?`
    )
    .get(clienteId, servicio, tipo, zona, peso_min);

  if (existente) {
    await db
      .prepare('UPDATE tarifa_kg_overrides SET peso_max = ?, precio_kg = ? WHERE id = ?')
      .run(peso_max, precioKg, existente.id);
    return { id: existente.id, servicio, tipo, zona, peso_min, peso_max, precio_kg: precioKg };
  }

  const result = await db
    .prepare(
      `INSERT INTO tarifa_kg_overrides (cliente_id, servicio, tipo, zona, peso_min, peso_max, precio_kg)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(clienteId, servicio, tipo, zona, peso_min, peso_max, precioKg);

  return {
    id: result.lastInsertRowid,
    servicio,
    tipo,
    zona,
    peso_min,
    peso_max,
    precio_kg: precioKg,
  };
}

/** Borra una tarifa por kilo puntual. @returns {Promise<boolean>} true si borró. */
async function eliminarOverrideKg(clienteId, body) {
  const { servicio, tipo, zona, peso_min } = validarCoordenadasKg(body);
  const result = await getDb()
    .prepare(
      `DELETE FROM tarifa_kg_overrides
       WHERE cliente_id = ? AND servicio = ? AND tipo = ?
         AND zona IS ? AND peso_min IS ?`
    )
    .run(clienteId, servicio, tipo, zona, peso_min);
  return result.changes > 0;
}

module.exports = {
  SERVICIOS,
  TIPOS,
  ZONAS,
  BANDAS,
  MODOS_TARIFA,
  derivarBanda,
  validarCoordenadas,
  validarCoordenadasKg,
  clienteExiste,
  obtenerModoCliente,
  resolverProfit,
  resolverTarifaKg,
  resolverTarifaVenta,
  resolverFuelPropio,
  obtenerMatriz,
  obtenerMatrizKg,
  upsertOverride,
  upsertOverrideKg,
  eliminarOverride,
  eliminarOverrideKg,
};
