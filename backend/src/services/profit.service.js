const { getDb } = require('../db');

// ── Dominio de la matriz de profit ────────────────────────────────────────────
// Constantes compartidas por servicio + endpoints. Mantener alineadas con los CHECK
// de la tabla profit_overrides (backend/src/db/index.js).

const SERVICIOS = ['DHL', 'UPS_EXP', 'UPS_SAVER'];
const TIPOS = ['export', 'import'];
const ZONAS = [1, 2, 3, 4, 5, 6];

// Cómo se arma el precio de venta del flete de un cliente (clientes.modo_tarifa).
const MODOS_TARIFA = ['porcentaje', 'por_kg'];

// ── Tramos de peso ───────────────────────────────────────────────────────────
//
// Un TRAMO es un intervalo de peso facturable. Toda la tarifa de un cliente —la de
// porcentaje y la de precio por kilo— se apoya en el mismo juego de tramos, así hay una
// sola forma de pensar el peso en todo el sistema.
//
// Límite inferior EXCLUSIVO, superior INCLUSIVO, salvo el primero que incluye el 0.
// El último no tiene tope (max = null).
//
// ⚠️ EL JUEGO NO ES GLOBAL: cada cliente puede tener el suyo (tabla `cliente_tramos`).
//
// Se decidió el 12/08/2026, cuando la oficina confirmó que la tarifa de PIO ALVAREZ corta
// en los 32 kg y no se puede cambiar. Forzarlo a los tramos de 5 en 5 habría significado
// cobrarle otro precio, y meter el 32 como tramo global le habría ensuciado la tabla a los
// otros 90 clientes. Lo que hay que garantizar no es que todos usen los mismos tramos,
// sino que el juego de CADA cliente no tenga huecos, ni tramos pisados, ni bordes
// ambiguos. De eso se ocupa `validarJuegoDeTramos()`.
//
// ⚠️ EL JUEGO POR DEFECTO SON LOS NUEVE DE SIEMPRE, Y NO ES UN DESCUIDO.
//
// El 12/08/2026 esto se desplegó con los tramos de 5 en 5 acá adentro, y cambió precios sin
// que se hubiera migrado un solo dato. El motivo: las 317 filas cargadas están apoyadas en
// los cortes viejos —hay filas con peso_min 30 y 40, ninguna con 35 ni 45— y la resolución
// busca la fila cuyo peso_min sea el del tramo del peso. Un envío de 37 kg pasó a derivar
// el tramo 35-40, no encontró fila, y se cayó al porcentaje general del cliente: 70% se
// convirtió en 50%. Uno de cada diez envíos históricos cae en 35-40 o 45-50 kg.
//
// La regla que sale de eso: EL JUEGO POR DEFECTO TIENE QUE SER EL QUE USAN LOS DATOS.
// Los tramos finos no llegan por acá: llegan por `cliente_tramos`, que es lo que escribe
// `scripts/migrar-tramos.js` cliente por cliente, con un informe de antes/después delante.
// Así desplegar el código nunca cambia un precio — el precio cambia cuando se migra.
//
// `test-datos-viejos.js` es el que sostiene esta regla: carga la matriz sobre los cortes
// viejos, la resuelve con el código de hoy, y falla si algún peso cambia de valor.
//
// El cliente que no tiene tramos propios hereda estos.
const TRAMOS_POR_DEFECTO = [
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

// Los tramos de 5 en 5 hasta 50 que pidió Felipe el 12/08/2026. NO se aplican solos: son
// los que ofrece la pantalla del cliente y los que la migración usa como base para armar
// el juego de cada uno. Un cliente los tiene recién cuando quedaron escritos en
// `cliente_tramos`.
const TRAMOS_SUGERIDOS = [
  { min: 0, max: 5 },
  { min: 5, max: 10 },
  { min: 10, max: 15 },
  { min: 15, max: 20 },
  { min: 20, max: 25 },
  { min: 25, max: 30 },
  { min: 30, max: 35 },
  { min: 35, max: 40 },
  { min: 40, max: 45 },
  { min: 45, max: 50 },
  { min: 50, max: null },
];

// Nombre viejo. Se mantiene para no romper lo que ya lo importaba.
const BANDAS = TRAMOS_POR_DEFECTO;

/**
 * Deriva el tramo que le corresponde a un peso dentro de un juego dado.
 * @param {Array<{min:number,max:number|null}>} tramos juego del cliente.
 * @returns {{min:number, max:number|null}|null} tramo, o null si el peso no es válido.
 */
function derivarTramo(tramos, pesoFacturable) {
  const pf = Number(pesoFacturable);
  if (!Number.isFinite(pf) || pf < 0) return null;
  for (const tramo of tramos) {
    if (tramo.max === null) {
      if (pf > tramo.min) return tramo;
    } else if (tramo.min === 0) {
      if (pf >= 0 && pf <= tramo.max) return tramo;
    } else if (pf > tramo.min && pf <= tramo.max) {
      return tramo;
    }
  }
  return null;
}

/**
 * Deriva el tramo usando el juego POR DEFECTO. Solo para llamadores que no tienen un
 * cliente a mano; los que sí lo tienen usan `derivarTramo` con el juego del cliente.
 * @returns {{min:number, max:number|null}|null} tramo o null si el peso no es válido.
 */
function derivarBanda(pesoFacturable) {
  return derivarTramo(TRAMOS_POR_DEFECTO, pesoFacturable);
}

/**
 * Valida un juego completo de tramos. Esta es la función que sostiene toda la garantía:
 * mientras el juego pase por acá, es imposible que un peso caiga en un hueco, que dos
 * tramos se pisen, o que un borde sea ambiguo.
 *
 * Reglas:
 *   · al menos un tramo
 *   · el primero arranca en 0
 *   · cada tramo empieza EXACTAMENTE donde termina el anterior (sin huecos ni solapes)
 *   · el último es abierto (max = null) y ninguno de los otros lo es
 *   · todos los cortes son números finitos y crecientes
 *
 * @param {Array<{min:number,max:number|null}>} lista
 * @returns {Array<{min:number,max:number|null}>} el juego normalizado y ordenado.
 * @throws {Error} con .status = 400 y un mensaje que dice qué está mal.
 */
function validarJuegoDeTramos(lista) {
  const err = (msg) => {
    const e = new Error(msg);
    e.status = 400;
    return e;
  };

  if (!Array.isArray(lista) || lista.length === 0) {
    throw err('el juego de tramos no puede estar vacío');
  }

  const norm = lista.map((t, i) => {
    const min = Number(t.min ?? t.peso_min);
    const maxCrudo = t.max ?? t.peso_max;
    const max =
      maxCrudo === null || maxCrudo === undefined || maxCrudo === '' ? null : Number(maxCrudo);
    if (!Number.isFinite(min) || min < 0) {
      throw err(`tramo ${i + 1}: "desde" inválido (${t.min ?? t.peso_min})`);
    }
    if (max !== null && (!Number.isFinite(max) || max <= min)) {
      throw err(`tramo ${i + 1}: "hasta" (${max}) tiene que ser mayor que "desde" (${min})`);
    }
    return { min, max };
  });

  norm.sort((a, b) => a.min - b.min);

  if (norm[0].min !== 0) {
    throw err(`el primer tramo tiene que arrancar en 0, arranca en ${norm[0].min}`);
  }

  for (let i = 0; i < norm.length - 1; i += 1) {
    if (norm[i].max === null) {
      throw err(
        `el tramo desde ${norm[i].min} está abierto pero no es el último. ` +
          'Solo el último tramo puede no tener tope.'
      );
    }
    if (norm[i].max !== norm[i + 1].min) {
      const hueco = norm[i].max < norm[i + 1].min;
      throw err(
        hueco
          ? `queda un hueco entre ${norm[i].max} y ${norm[i + 1].min} kg: ningún tramo cubre ese peso`
          : `los tramos se pisan: uno termina en ${norm[i].max} y el siguiente arranca en ${norm[i + 1].min}`
      );
    }
  }

  if (norm[norm.length - 1].max !== null) {
    throw err(
      `el último tramo tiene que quedar abierto (de ${norm[norm.length - 1].min} kg en adelante), ` +
        `si no los envíos de más de ${norm[norm.length - 1].max} kg se quedan sin precio`
    );
  }

  return norm;
}

/**
 * Devuelve el juego de tramos de un cliente: el suyo si lo tiene cargado, el por defecto
 * si no. Es la única puerta de entrada; nadie debe leer `cliente_tramos` por su cuenta.
 * @returns {Promise<Array<{min:number,max:number|null}>>}
 */
async function obtenerTramos(clienteId) {
  const rows = await getDb()
    .prepare('SELECT peso_min, peso_max FROM cliente_tramos WHERE cliente_id = ? ORDER BY peso_min')
    .all(clienteId);
  if (!rows || rows.length === 0) return TRAMOS_POR_DEFECTO;
  return rows.map((r) => ({ min: r.peso_min, max: r.peso_max }));
}

/**
 * Valida y normaliza las coordenadas de un override.
 * Acepta zona (null | 1..6) y un tramo expresado como par peso_min/peso_max, que debe ser
 * (null, null) o coincidir exactamente con un tramo DEL CLIENTE.
 * @param {object} body coordenadas crudas.
 * @param {Array<{min,max}>} [tramos] juego del cliente. Si no se pasa, el por defecto.
 * @returns {{servicio, tipo, zona, peso_min, peso_max}} coordenadas normalizadas.
 * @throws {Error} con .status = 400 ante cualquier coordenada inválida.
 */
function validarCoordenadas({ servicio, tipo, zona, peso_min, peso_max }, tramos = TRAMOS_POR_DEFECTO) {
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
    const tramo = tramos.find((b) => b.min === pesoMinNorm);
    if (!tramo) {
      throw err(
        `tramo inválido: peso_min ${peso_min} no coincide con ningún tramo de este cliente ` +
          `(${tramos.map((b) => b.min).join(', ')})`
      );
    }
    if (tramo.max !== pesoMaxNorm) {
      throw err(
        `tramo inválido: para peso_min ${pesoMinNorm} el peso_max debe ser ${tramo.max === null ? 'vacío' : tramo.max}`
      );
    }
  } else if (maxProvisto) {
    throw err('tramo inválido: peso_max provisto sin peso_min');
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

  const banda = derivarTramo(await obtenerTramos(clienteId), pesoFacturable);
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
  const { servicio, tipo, zona, peso_min, peso_max } = validarCoordenadas(
    body,
    await obtenerTramos(clienteId)
  );

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
  const { servicio, tipo, zona, peso_min } = validarCoordenadas(
    body,
    await obtenerTramos(clienteId)
  );

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
function validarCoordenadasKg({ servicio, tipo, zona, peso_min, peso_max }, tramos = TRAMOS_POR_DEFECTO) {
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

  // ── El rango tiene que ser un tramo DEL CLIENTE (11/08/2026, ampliado el 12/08) ──
  //
  // Antes el rango era libre: cada cliente podía tener 1-3 kg, 2-7 kg, lo que fuera. Eso
  // abría tres agujeros que solo se veían al cobrar:
  //
  //   · HUECOS. Cargar 1-3 kg dejaba a un envío de 4 kg sin precio por kilo. Caía al
  //     porcentaje y salía otro número, sin avisar nada.
  //   · SUPERPUESTOS. Nada impedía cargar 1-10 y después 5-15. El sistema elegía el de
  //     "desde" más alto y dejaba un aviso en la consola del servidor, que no lee nadie.
  //   · LOS BORDES. Los límites eran inclusivos de los dos lados, así que 1-3 y 3-5 —dos
  //     rangos pegados, que parecen perfectos— ya se pisaban en los 3 kg exactos.
  //
  // Exigiendo que el rango sea un tramo del juego del cliente los tres desaparecen de raíz:
  // no se pueden expresar, porque `validarJuegoDeTramos()` ya garantizó que el juego es
  // continuo y sin solapes. Y el peso se piensa igual para el porcentaje y para el kilo.
  const vacio = (v) => v === null || v === undefined || v === '';

  const minProvisto = !vacio(peso_min);
  const maxProvisto = !vacio(peso_max);

  let minNorm = null;
  let maxNorm = null;

  if (minProvisto) {
    minNorm = Number(peso_min);
    const tramo = tramos.find((b) => b.min === minNorm);
    if (!tramo) {
      throw err(
        `tramo inválido: peso_min ${peso_min} no coincide con ningún tramo de este cliente. ` +
          'Válidos: ' +
          tramos.map((b) => (b.max === null ? `${b.min}+` : `${b.min}-${b.max}`)).join(', ')
      );
    }
    maxNorm = tramo.max;
    if (maxProvisto && Number(peso_max) !== tramo.max) {
      throw err(
        `tramo inválido: para peso_min ${minNorm} el peso_max debe ser ` +
          (tramo.max === null ? 'vacío' : tramo.max)
      );
    }
  } else if (maxProvisto) {
    throw err('rango inválido: hay "peso hasta" sin "peso desde"');
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
    .prepare(
      `SELECT modo_tarifa, fuel_pct_propio, tarifa_pct, seguro_pct_propio, seguro_min_propio
         FROM clientes WHERE id = ?`
    )
    .get(clienteId);
  if (!row) return null;
  const modo = MODOS_TARIFA.includes(row.modo_tarifa) ? row.modo_tarifa : 'porcentaje';
  const fuel =
    row.fuel_pct_propio === null || row.fuel_pct_propio === undefined
      ? null
      : Number(row.fuel_pct_propio);
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    modo,
    fuelPctPropio: Number.isFinite(fuel) ? fuel : null,
    tarifaPct: row.tarifa_pct ?? 0,
    seguroPctPropio: num(row.seguro_pct_propio),
    seguroMinPropio: num(row.seguro_min_propio),
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

  // El tramo del peso es UNO SOLO dentro del juego del cliente, así que la fila que aplica
  // se busca por tramo exacto. No hay dos candidatas posibles y el resultado no depende del
  // orden en que estén cargadas. Buscar "la fila que contenga al peso" traería de vuelta la
  // ambigüedad de los bordes: un envío de 5,00 kg está adentro del tramo 0-5 y también toca
  // el borde del 5-10.
  //
  // El camino por contención queda solo para filas viejas, cargadas cuando el rango era
  // libre y que todavía no se migraron. Se resuelven como siempre se resolvieron —no se le
  // cambia el precio a nadie por atrás— pero avisan por consola.
  const tramos = await obtenerTramos(clienteId);
  const tramoDelPeso = derivarTramo(tramos, pf);
  const esTramo = (r) => tramos.some((b) => b.min === r.peso_min);
  const enRango = (rows) => {
    if (tramoDelPeso) {
      const exacta = rows.find((r) => esTramo(r) && r.peso_min === tramoDelPeso.min);
      if (exacta) return exacta;
    }

    const candidatos = rows.filter(
      (r) => !esTramo(r) && Number.isFinite(pf) && pf >= r.peso_min
        && (r.peso_max === null || pf <= r.peso_max)
    );
    if (candidatos.length === 0) return null;
    console.warn(
      `[resolverTarifaKg] rango que no es un tramo del cliente (cliente_id=${clienteId}, ` +
        `${servicio}/${tipo}, zona=${zonaNum}, pf=${pf}): ` +
        `${candidatos.map((c) => `${c.peso_min}-${c.peso_max}`).join(', ')}. ` +
        'Es una carga vieja: conviene rehacerla sobre los tramos del cliente.'
    );
    return candidatos.sort((a, b) => b.peso_min - a.peso_min)[0];
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
 * llamadores (cotizador, alta de envío, endpoint de cotizar).
 *
 * LA REGLA (Felipe, 13/08/2026): el precio por kilo cargado SE COBRA SIEMPRE. Si una
 * fila de tarifa por kilo cubre este peso/zona, ese es el precio, sin importar el modo
 * del cliente; el porcentaje cubre todo lo que no tenga precio por kilo.
 *
 * Si NINGUNA tarifa por kilo cubre ese peso/zona, NO se cobra cero ni se rompe: se cae
 * al porcentaje. En un cliente en modo por_kg eso además devuelve un aviso en
 * `advertencia` (probable agujero de carga); en uno en porcentaje es lo normal.
 *
 * @returns {Promise<{modo, profitPct, precioKg, origen, advertencia}|null>} null si el
 *          cliente no existe.
 */
async function resolverTarifaVenta({ clienteId, servicio, tipo, zona, pesoFacturable }) {
  const info = await obtenerModoCliente(clienteId);
  if (!info) return null;

  // ⚠️ EL PRECIO POR KILO CARGADO SE COBRA SIEMPRE (Felipe, 13/08): "si tiene precio por
  // kilo, paga precio por kilo, independientemente de las otras columnas". El modo del
  // cliente ya NO decide qué tabla gana: si una fila de tarifa por kilo cubre este
  // peso/zona, ese es el precio; el porcentaje cubre todo lo demás. El caso mixto
  // (5-10 kg al 50%, 10-15 kg a precio fijo) queda así de natural.
  //
  // `modo_tarifa` sigue existiendo para una sola cosa: el AVISO. Un cliente en por_kg
  // que cae al porcentaje probablemente tiene un agujero de carga y hay que decirlo; en
  // un cliente en porcentaje, caer al porcentaje es lo normal y no se avisa.
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

  if (info.modo === 'por_kg') {
    const porcentaje = await resolverProfit({ clienteId, servicio, tipo, zona, pesoFacturable });
    // Redacción neutra a propósito. Antes decía "el cliente está en modo precio por kilo
    // PERO no hay tarifa cargada", que sonaba a error de carga. Desde que la pantalla deja
    // cargar un rango para una zona sola, esto también es el caso MIXTO y es deliberado:
    // esa zona se cobra por porcentaje. El sistema no puede distinguir un agujero de una
    // decisión, así que informa el hecho sin acusar a nadie — pero lo sigue mostrando,
    // para que un olvido de carga tampoco pase desapercibido.
    const aviso =
      `${zona ? `La zona ${zona}` : 'Este envío'} no tiene precio por kilo cargado en ` +
      `${servicio} ${tipo} para ${pesoFacturable} kg: se cotizó con el porcentaje de ` +
      `ganancia (${porcentaje.profitPct}%).`;
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
/**
 * Seguro negociado del cliente, en la forma que espera el motor: { pct, min } o null.
 *
 * Devuelve null salvo que el cliente tenga seguro_pct_propio cargado. Sin porcentaje no
 * hay seguro propio posible: un mínimo suelto no define ninguna regla, así que se ignora.
 * El mínimo sí puede venir vacío — significa "sin piso", no "piso cero heredado".
 *
 * @returns {Promise<{pct:number, min:number|null}|null>}
 */
async function resolverSeguroPropio(clienteId) {
  if (!clienteId) return null;
  const info = await obtenerModoCliente(clienteId);
  if (!info || info.seguroPctPropio === null) return null;
  return { pct: info.seguroPctPropio, min: info.seguroMinPropio };
}

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
  const { servicio, tipo, zona, peso_min, peso_max } = validarCoordenadasKg(
    body,
    await obtenerTramos(clienteId)
  );

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
  const { servicio, tipo, zona, peso_min } = validarCoordenadasKg(
    body,
    await obtenerTramos(clienteId)
  );
  const result = await getDb()
    .prepare(
      `DELETE FROM tarifa_kg_overrides
       WHERE cliente_id = ? AND servicio = ? AND tipo = ?
         AND zona IS ? AND peso_min IS ?`
    )
    .run(clienteId, servicio, tipo, zona, peso_min);
  return result.changes > 0;
}

/**
 * Devuelve el juego de tramos de un cliente y si es propio o heredado. Es lo que consume
 * la pantalla del perfil para dibujar las filas de la grilla.
 * @returns {Promise<{propios:boolean, tramos:Array<{min,max}>}>}
 */
async function obtenerTramosCliente(clienteId) {
  const rows = await getDb()
    .prepare('SELECT peso_min, peso_max FROM cliente_tramos WHERE cliente_id = ? ORDER BY peso_min')
    .all(clienteId);
  if (!rows || rows.length === 0) {
    return { propios: false, tramos: TRAMOS_POR_DEFECTO.map((t) => ({ ...t })) };
  }
  return { propios: true, tramos: rows.map((r) => ({ min: r.peso_min, max: r.peso_max })) };
}

/**
 * Reemplaza el juego de tramos de un cliente.
 *
 * ⚠️ No es un guardado inocente: las filas de tarifa ya cargadas se apoyan en el juego
 * viejo. Si el juego nuevo no contiene alguno de los "desde" que hoy están en uso, esas
 * filas quedarían colgadas — cobrando un precio que la pantalla no muestra. Por eso se
 * rechaza el cambio y se dice exactamente qué tramos hay que resolver primero. Preferimos
 * que la oficina borre o rehaga esas filas a mano antes que perderlas en silencio.
 *
 * @param {Array<{min,max}>} lista juego nuevo. Vacío o null = volver al por defecto.
 * @returns {Promise<{propios:boolean, tramos:Array<{min,max}>}>}
 */
async function guardarTramosCliente(clienteId, lista) {
  const db = getDb();

  const volverAlDefecto = !lista || (Array.isArray(lista) && lista.length === 0);
  const nuevos = volverAlDefecto ? TRAMOS_POR_DEFECTO : validarJuegoDeTramos(lista);

  // ⚠️ SE COMPARA EL TRAMO ENTERO, "desde" Y "hasta".
  //
  // Mirar solo el "desde" no alcanza y el 12/08/2026 costó caro. Una fila cargada de 30 a
  // 40 kg sobrevive a un juego que tiene 30-35, porque el 30 coincide — y en silencio pasa
  // a valer solo hasta 35. Los envíos de entre 35 y 40 kg quedan sin precio y se caen al
  // porcentaje general del cliente, con un número que se ve perfectamente razonable.
  // Un tramo es un par: si cualquiera de las dos puntas se mueve, la fila ya no dice lo
  // que decía.
  const enUso = await db
    .prepare(
      `SELECT DISTINCT peso_min, peso_max FROM (
         SELECT peso_min, peso_max FROM profit_overrides    WHERE cliente_id = ? AND peso_min IS NOT NULL
         UNION
         SELECT peso_min, peso_max FROM tarifa_kg_overrides WHERE cliente_id = ? AND peso_min IS NOT NULL
       ) ORDER BY peso_min`
    )
    .all(clienteId, clienteId);

  const mismoTramo = (fila, t) => t.min === fila.peso_min
    && ((t.max === null && fila.peso_max === null) || t.max === fila.peso_max);

  const huerfanos = (enUso || [])
    .filter((fila) => !nuevos.some((t) => mismoTramo(fila, t)))
    .map((fila) => (fila.peso_max === null ? `${fila.peso_min}+` : `${fila.peso_min}-${fila.peso_max}`));

  if (huerfanos.length > 0) {
    const e = new Error(
      `no se puede cambiar los tramos: hay precios cargados en ${huerfanos.join(', ')} kg ` +
        'que el juego nuevo no contempla. Borrá o rehacé esas filas primero, ' +
        'así ningún precio queda cobrándose sin verse.'
    );
    e.status = 409;
    e.huerfanos = huerfanos;
    throw e;
  }

  await db.prepare('DELETE FROM cliente_tramos WHERE cliente_id = ?').run(clienteId);

  if (!volverAlDefecto) {
    for (const t of nuevos) {
      await db
        .prepare('INSERT INTO cliente_tramos (cliente_id, peso_min, peso_max) VALUES (?, ?, ?)')
        .run(clienteId, t.min, t.max);
    }
  }

  return obtenerTramosCliente(clienteId);
}

module.exports = {
  SERVICIOS,
  TIPOS,
  ZONAS,
  BANDAS,
  TRAMOS_POR_DEFECTO,
  TRAMOS_SUGERIDOS,
  MODOS_TARIFA,
  derivarBanda,
  derivarTramo,
  validarJuegoDeTramos,
  obtenerTramos,
  obtenerTramosCliente,
  guardarTramosCliente,
  validarCoordenadas,
  validarCoordenadasKg,
  clienteExiste,
  obtenerModoCliente,
  resolverProfit,
  resolverTarifaKg,
  resolverTarifaVenta,
  resolverFuelPropio,
  resolverSeguroPropio,
  obtenerMatriz,
  obtenerMatrizKg,
  upsertOverride,
  upsertOverrideKg,
  eliminarOverride,
  eliminarOverrideKg,
};
