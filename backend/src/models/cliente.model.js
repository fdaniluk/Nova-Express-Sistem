const { getDb } = require('../db');

function mapCliente(c) {
  if (!c) return c;
  return { ...c, razon_social: c.nombre };
}

/* Resumen de la matriz de cada cliente, en la misma consulta (17/09/2026). Antes la lista
   mostraba `tarifa_pct` pelado y para saber si el cliente tenía celdas propias o precio por
   kilo hacían falta 12 pedidos. Con esto la pantalla puede decir "75 %", "75 % + matriz" o
   "por kilo" sin preguntar nada más. */
const RESUMEN_TARIFAS_SQL = `
  (SELECT COUNT(*) FROM profit_overrides    po WHERE po.cliente_id = c.id) AS matriz_celdas,
  (SELECT COUNT(*) FROM tarifa_kg_overrides tk WHERE tk.cliente_id = c.id) AS kg_celdas,
  (SELECT COUNT(*) FROM cliente_tramos      ct WHERE ct.cliente_id = c.id) AS tramos_propios`;

/* Lo que se puede ver del texto que llega por query string: "0", "false" y "no" son NO.
   Antes `params.push(activo ? 1 : 0)` con la cadena '0' (truthy) devolvía los ACTIVOS. */
function aBooleano(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  return !['0', 'false', 'no'].includes(String(v).trim().toLowerCase());
}

async function listar({ activo, todos } = {}) {
  const db = getDb();
  let sql = `SELECT c.*, ${RESUMEN_TARIFAS_SQL} FROM clientes c WHERE 1=1`;
  const params = [];
  const act = aBooleano(activo);
  if (act !== undefined) {
    sql += ' AND c.activo = ?';
    params.push(act ? 1 : 0);
  } else if (!aBooleano(todos)) {
    // Sin filtro, la lista trae SOLO los activos: un cliente desactivado no tiene que
    // aparecer en ningún selector del sistema. La pantalla de Clientes pide ?todos=1.
    sql += ' AND c.activo = 1';
  }
  sql += ' ORDER BY c.nombre COLLATE NOCASE';
  const rows = await db.prepare(sql).all(...params);
  return rows.map(mapCliente);
}

async function buscarPorId(id) {
  const row = await getDb().prepare(`SELECT c.*, ${RESUMEN_TARIFAS_SQL} FROM clientes c WHERE c.id = ?`).get(id);
  return mapCliente(row);
}

const TIPOS_COBRO = ['D', 'S', 'Q', 'CC'];
const TIPOS_FACTURACION = ['Responsable inscripto', 'Monotributista', 'Exento', 'Consumidor final'];
const TIPOS_CAMBIO = ['venta', 'promedio'];

function error400(msg) { const e = new Error(msg); e.status = 400; return e; }

/* Validaciones comunes al alta y a la edición. Antes un tipo_cobro inválido rompía el CHECK
   de SQLite con un 500 pelado y una tarifa negativa entraba sin chistar. */
function validar(data, { alta = false } = {}) {
  if (data.tipo_cobro !== undefined && data.tipo_cobro !== null && !TIPOS_COBRO.includes(data.tipo_cobro)) {
    throw error400(`Tipo de cobro inválido: ${data.tipo_cobro}. Válidos: D, S, Q, CC`);
  }
  if (data.tipo_facturacion !== undefined && data.tipo_facturacion !== null && data.tipo_facturacion !== ''
      && !TIPOS_FACTURACION.includes(data.tipo_facturacion)) {
    throw error400(`Tipo de facturación inválido: ${data.tipo_facturacion}`);
  }
  if (data.tarifa_pct !== undefined && data.tarifa_pct !== null && data.tarifa_pct !== '') {
    const n = Number(data.tarifa_pct);
    if (!Number.isFinite(n) || n < 0) throw error400(`% de tarifa inválido: ${data.tarifa_pct}`);
  }
  if (data.plazo_pago_dias !== undefined && data.plazo_pago_dias !== null && data.plazo_pago_dias !== '') {
    const n = Number(data.plazo_pago_dias);
    if (!Number.isInteger(n) || n < 0) throw error400(`Plazo de pago inválido: ${data.plazo_pago_dias} (días enteros, 0 o más)`);
  }
  if (data.tipo_cambio !== undefined && data.tipo_cambio !== null && data.tipo_cambio !== '' && !TIPOS_CAMBIO.includes(data.tipo_cambio)) {
    throw error400(`Tipo de cambio inválido: ${data.tipo_cambio}. Válidos: venta, promedio`);
  }
  if (data.email && String(data.email).trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.email).trim())) {
    throw error400(`Email inválido: ${data.email}`);
  }
  if (alta) {
    const nombre = String(data.razon_social || data.nombre || '').trim();
    if (!nombre) throw error400('La razón social es obligatoria');
  }
}

/* Texto que puede quedar vacío: '' o solo espacios → NULL. */
const txt = (v) => (v === undefined || v === null ? null : (String(v).trim() || null));

async function crear(data) {
  validar(data, { alta: true });
  const db = getDb();
  const nombre = String(data.razon_social || data.nombre).trim();
  const tipoCobro = data.tipo_cobro || 'CC';
  const tarifa = data.tarifa_especial ? JSON.stringify(data.tarifa_especial) : null;
  const result = await db
    .prepare(
      `INSERT INTO clientes
        (nombre, nombre_nova, tipo_cobro, tarifa_especial, cuit, direccion_recoleccion, contacto,
         email, whatsapp, codigo_postal, localidad, tipo_facturacion, tarifa_pct, telefono, provincia,
         plazo_pago_dias, tipo_cambio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nombre,
      txt(data.nombre_nova),
      tipoCobro,
      tarifa,
      txt(data.cuit),
      txt(data.direccion_recoleccion),
      txt(data.contacto),
      txt(data.email),
      txt(data.whatsapp),
      txt(data.codigo_postal),
      txt(data.localidad),
      txt(data.tipo_facturacion) || 'Responsable inscripto',
      data.tarifa_pct === '' || data.tarifa_pct == null ? 0 : Number(data.tarifa_pct),
      txt(data.telefono),
      txt(data.provincia),
      data.plazo_pago_dias === '' || data.plazo_pago_dias == null ? null : Number(data.plazo_pago_dias),
      txt(data.tipo_cambio) || 'venta'
    );
  return buscarPorId(result.lastInsertRowid);
}

/* Campos de texto que la oficina tiene que poder VACIAR (17/09/2026). Antes iban con
   COALESCE(?, col): si cargaste mal un CUIT o un mail podías cambiarlo pero nunca borrarlo.
   Regla: si la propiedad VIENE en el body se asigna directo ('' → NULL); si no viene, se
   mantiene. Es el mismo criterio que ya tenía nombre_nova. */
const TEXTO_VACIABLE = ['cuit', 'direccion_recoleccion', 'contacto', 'email', 'whatsapp',
  'codigo_postal', 'localidad', 'telefono', 'provincia'];

async function actualizar(id, data) {
  validar(data);
  const db = getDb();
  const actual = await buscarPorId(id);
  if (!actual) return null;
  const textoClausulas = [];
  const textoValores = [];
  for (const col of TEXTO_VACIABLE) {
    const provisto = Object.prototype.hasOwnProperty.call(data, col);
    textoClausulas.push(provisto ? `${col} = ?` : `${col} = COALESCE(?, ${col})`);
    textoValores.push(provisto ? txt(data[col]) : null);
  }
  const plazoProvisto = Object.prototype.hasOwnProperty.call(data, 'plazo_pago_dias');
  const plazoValor = plazoProvisto && data.plazo_pago_dias !== '' && data.plazo_pago_dias !== null
    ? Number(data.plazo_pago_dias) : null;
  const tarifa =
    data.tarifa_especial !== undefined
      ? data.tarifa_especial ? JSON.stringify(data.tarifa_especial) : null
      : actual.tarifa_especial;
  const nombreNuevo = txt(data.razon_social !== undefined ? data.razon_social : data.nombre);
  // nombre_nova lo controla totalmente el usuario: si la propiedad VIENE en el body
  // (aunque sea vacía) se asigna directo y puede borrarse; si NO viene, se mantiene
  // con COALESCE para no pisar el valor desde llamadores que no lo envían.
  const novaProvisto = Object.prototype.hasOwnProperty.call(data, 'nombre_nova');
  const novaClausula = novaProvisto ? 'nombre_nova = ?' : 'nombre_nova = COALESCE(?, nombre_nova)';
  const novaValor = novaProvisto
    ? ((data.nombre_nova && String(data.nombre_nova).trim()) || null)
    : null;

  // Modo de tarifa: 'porcentaje' (flete + % de ganancia) o 'por_kg' (precio fijo por kilo).
  // Se valida acá porque la columna se agrega por ALTER TABLE y ALTER no admite CHECK.
  const modoProvisto =
    data.modo_tarifa !== undefined && data.modo_tarifa !== null && data.modo_tarifa !== '';
  if (modoProvisto && !['porcentaje', 'por_kg'].includes(data.modo_tarifa)) {
    const e = new Error(`modo_tarifa inválido: ${data.modo_tarifa}. Válidos: porcentaje, por_kg`);
    e.status = 400;
    throw e;
  }

  // Fuel propio del cliente: tiene que poder BORRARSE (volver a usar el de Configuración),
  // así que si la propiedad viene en el body se asigna directo —vacío = NULL— en vez de
  // COALESCE, que nunca dejaría volver a null.
  const fuelProvisto = Object.prototype.hasOwnProperty.call(data, 'fuel_pct_propio');
  const fuelClausula = fuelProvisto
    ? 'fuel_pct_propio = ?'
    : 'fuel_pct_propio = COALESCE(?, fuel_pct_propio)';
  let fuelValor = null;
  if (fuelProvisto && data.fuel_pct_propio !== null && data.fuel_pct_propio !== '') {
    const n = Number(data.fuel_pct_propio);
    if (!Number.isFinite(n) || n < 0) {
      const e = new Error(`fuel_pct_propio inválido: ${data.fuel_pct_propio}`);
      e.status = 400;
      throw e;
    }
    fuelValor = n;
  }

  // Seguro propio del cliente: mismo criterio que el fuel, tiene que poder borrarse para
  // volver a la escala del courier. Se valida cada campo por separado porque el mínimo
  // puede existir sin porcentaje mientras la oficina está cargando, y al revés.
  const seguroCampos = [
    ['seguro_pct_propio', Object.prototype.hasOwnProperty.call(data, 'seguro_pct_propio')],
    ['seguro_min_propio', Object.prototype.hasOwnProperty.call(data, 'seguro_min_propio')],
  ];
  const seguroClausulas = [];
  const seguroValores = [];
  for (const [col, provisto] of seguroCampos) {
    seguroClausulas.push(provisto ? `${col} = ?` : `${col} = COALESCE(?, ${col})`);
    let valor = null;
    if (provisto && data[col] !== null && data[col] !== '') {
      const n = Number(data[col]);
      if (!Number.isFinite(n) || n < 0) {
        const e = new Error(`${col} inválido: ${data[col]}`);
        e.status = 400;
        throw e;
      }
      valor = n;
    }
    seguroValores.push(valor);
  }

  await db
    .prepare(
      `UPDATE clientes SET
        nombre              = COALESCE(?, nombre),
        ${novaClausula},
        tipo_cobro          = COALESCE(?, tipo_cobro),
        tarifa_especial     = ?,
        activo              = COALESCE(?, activo),
        ${textoClausulas.join(',\n        ')},
        tipo_facturacion    = COALESCE(?, tipo_facturacion),
        tarifa_pct          = COALESCE(?, tarifa_pct),
        modo_tarifa         = COALESCE(?, modo_tarifa),
        ${plazoProvisto ? 'plazo_pago_dias = ?' : 'plazo_pago_dias = COALESCE(?, plazo_pago_dias)'},
        tipo_cambio         = COALESCE(?, tipo_cambio),
        ${fuelClausula},
        ${seguroClausulas.join(',\n        ')},
        updated_at          = datetime('now', 'localtime')
       WHERE id = ?`
    )
    .run(
      nombreNuevo ?? null,
      novaValor,
      data.tipo_cobro ?? null,
      tarifa,
      data.activo !== undefined ? (aBooleano(data.activo) ? 1 : 0) : null,
      ...textoValores,
      txt(data.tipo_facturacion),
      data.tarifa_pct !== undefined && data.tarifa_pct !== '' && data.tarifa_pct !== null ? Number(data.tarifa_pct) : null,
      modoProvisto ? data.modo_tarifa : null,
      plazoValor,
      txt(data.tipo_cambio),
      fuelValor,
      ...seguroValores,
      id
    );
  return buscarPorId(id);
}

/* Qué tiene el cliente en el sistema (para decidir si se puede borrar o solo desactivar). */
async function dependencias(id) {
  const db = getDb();
  const tablas = [['envios', 'envíos'], ['guias', 'guías'], ['liquidaciones', 'liquidaciones'],
    ['pickups', 'pickups'], ['cobranzas', 'cobranzas'], ['cotizaciones', 'cotizaciones'],
    ['tarifario_emitidos', 'tarifarios emitidos']];
  const out = {};
  for (const [tabla, rotulo] of tablas) {
    try {
      const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE cliente_id = ?`).get(id);
      if (r && r.n > 0) out[rotulo] = r.n;
    } catch { /* la tabla puede no existir en una base vieja */ }
  }
  return out;
}

/* Eliminar solo si el cliente no dejó rastro. Si tiene historial, la respuesta es 409 con
   la lista y la pantalla ofrece DESACTIVAR (lo conserva todo, lo saca de los selectores).
   Antes solo se contaban los envíos y un cliente con guías o pickups reventaba con un 500
   por la clave foránea. */
async function eliminar(id) {
  const db = getDb();
  const deps = await dependencias(id);
  const claves = Object.keys(deps);
  if (claves.length) {
    const err = new Error(`No se puede eliminar: el cliente tiene ${claves.map((k) => `${deps[k]} ${k}`).join(', ')}. Podés desactivarlo.`);
    err.status = 409;
    err.dependencias = deps;
    throw err;
  }
  const result = await db.prepare('DELETE FROM clientes WHERE id = ?').run(id);
  return result.changes > 0;
}

function parseTarifa(cliente) {
  if (!cliente) return cliente;
  if (cliente.tarifa_especial) {
    try {
      cliente.tarifa_especial = JSON.parse(cliente.tarifa_especial);
    } catch {
      cliente.tarifa_especial = null;
    }
  }
  return cliente;
}

module.exports = { listar, buscarPorId, crear, actualizar, eliminar, dependencias, parseTarifa, TIPOS_COBRO, TIPOS_FACTURACION };
