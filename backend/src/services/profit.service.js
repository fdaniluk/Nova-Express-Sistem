const { getDb } = require('../db');

// ── Dominio de la matriz de profit ────────────────────────────────────────────
// Constantes compartidas por servicio + endpoints. Mantener alineadas con los CHECK
// de la tabla profit_overrides (backend/src/db/index.js).

const SERVICIOS = ['DHL', 'UPS_EXP', 'UPS_SAVER'];
const TIPOS = ['export', 'import'];
const ZONAS = [1, 2, 3, 4, 5, 6];

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

module.exports = {
  SERVICIOS,
  TIPOS,
  ZONAS,
  BANDAS,
  derivarBanda,
  validarCoordenadas,
  clienteExiste,
  resolverProfit,
  obtenerMatriz,
  upsertOverride,
  eliminarOverride,
};
