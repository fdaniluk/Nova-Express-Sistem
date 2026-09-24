// Razones sociales por cliente + unir clientes (22/09/2026).
// Ver AUDITORIA-GECOM-Y-REDISENO-COBRANZAS.md y schema.sql (clientes_razones_sociales).
const { getDb } = require('../db');

const soloDigitos = (s) => String(s || '').replace(/\D/g, '');

async function listar(clienteId) {
  const db = getDb();
  return db.prepare(
    `SELECT r.*,
            (SELECT COUNT(*) FROM cc_comprobantes c WHERE c.razon_social_id = r.id AND c.anulado_at IS NULL) AS comprobantes,
            (SELECT ROUND(COALESCE(SUM(CASE WHEN c.tipo IN ('FA','LQ','ND') THEN c.saldo WHEN c.tipo IN ('NC','AC') THEN -c.saldo ELSE 0 END),0),2)
               FROM cc_comprobantes c WHERE c.razon_social_id = r.id AND c.anulado_at IS NULL AND c.libro = 'CF') AS saldo_cf,
            (SELECT ROUND(COALESCE(SUM(CASE WHEN c.tipo IN ('FA','LQ','ND') THEN c.saldo WHEN c.tipo IN ('NC','AC') THEN -c.saldo ELSE 0 END),0),2)
               FROM cc_comprobantes c WHERE c.razon_social_id = r.id AND c.anulado_at IS NULL AND c.libro = 'SF') AS saldo_sf
     FROM clientes_razones_sociales r WHERE r.cliente_id = ? ORDER BY r.principal DESC, r.activa DESC, r.razon_social`
  ).all(clienteId);
}

async function crear(clienteId, { razon_social, cuit = null, condicion_iva = null, es_tercero = 0, principal = 0, nota = null }) {
  const db = getDb();
  if (!razon_social || !String(razon_social).trim()) throw Object.assign(new Error('razon_social es obligatoria'), { status: 400 });
  return db.transaction(async () => {
    if (principal) await db.prepare('UPDATE clientes_razones_sociales SET principal = 0 WHERE cliente_id = ?').run(clienteId);
    const r = await db.prepare(
      'INSERT INTO clientes_razones_sociales (cliente_id, razon_social, cuit, condicion_iva, es_tercero, principal, nota) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(clienteId, String(razon_social).trim(), cuit ? String(cuit).trim() : null, condicion_iva, es_tercero ? 1 : 0, principal ? 1 : 0, nota);
    return db.prepare('SELECT * FROM clientes_razones_sociales WHERE id = ?').get(r.lastInsertRowid);
  });
}

async function editar(id, data) {
  const db = getDb();
  const rs = await db.prepare('SELECT * FROM clientes_razones_sociales WHERE id = ?').get(id);
  if (!rs) throw Object.assign(new Error('Razón social inexistente'), { status: 404 });
  return db.transaction(async () => {
    if (data.principal) await db.prepare('UPDATE clientes_razones_sociales SET principal = 0 WHERE cliente_id = ?').run(rs.cliente_id);
    await db.prepare(
      `UPDATE clientes_razones_sociales SET razon_social = ?, cuit = ?, condicion_iva = ?, es_tercero = ?, principal = ?, activa = ?, nota = ? WHERE id = ?`
    ).run(
      data.razon_social !== undefined ? String(data.razon_social).trim() : rs.razon_social,
      data.cuit !== undefined ? (data.cuit ? String(data.cuit).trim() : null) : rs.cuit,
      data.condicion_iva !== undefined ? data.condicion_iva : rs.condicion_iva,
      data.es_tercero !== undefined ? (data.es_tercero ? 1 : 0) : rs.es_tercero,
      data.principal !== undefined ? (data.principal ? 1 : 0) : rs.principal,
      data.activa !== undefined ? (data.activa ? 1 : 0) : rs.activa,
      data.nota !== undefined ? data.nota : rs.nota,
      id
    );
    return db.prepare('SELECT * FROM clientes_razones_sociales WHERE id = ?').get(id);
  });
}

// Mover una razón social (con todos sus comprobantes) a otro cliente. Es la forma de
// resolver "este perfil del GECOM era de otro cliente" sin unir clientes enteros.
async function moverACliente(id, clienteDestinoId) {
  const db = getDb();
  const rs = await db.prepare('SELECT * FROM clientes_razones_sociales WHERE id = ?').get(id);
  if (!rs) throw Object.assign(new Error('Razón social inexistente'), { status: 404 });
  const dest = await db.prepare('SELECT id FROM clientes WHERE id = ?').get(clienteDestinoId);
  if (!dest) throw Object.assign(new Error('Cliente destino inexistente'), { status: 404 });
  return db.transaction(async () => {
    const n = await db.prepare('UPDATE cc_comprobantes SET cliente_id = ? WHERE razon_social_id = ?').run(clienteDestinoId, id);
    await db.prepare('UPDATE clientes_razones_sociales SET cliente_id = ?, principal = 0 WHERE id = ?').run(clienteDestinoId, id);
    return { movidos: n.changes };
  });
}

// ── Unir clientes ─────────────────────────────────────────────────────────────────
// TODO lo del cliente origen (envíos, liquidaciones, cotizaciones, pickups, cuenta
// corriente, tarifas, direcciones, razones sociales…) pasa al destino; el origen se borra
// y queda el asiento en clientes_uniones. Recorre todas las tablas que tengan cliente_id,
// así no hay que acordarse de agregar una cuando aparezca una tabla nueva. Donde hay una
// clave única por cliente (matriz de profit, tramos, tarifa por kg, vínculos del bot) y el
// destino ya tiene la misma fila, se conserva la del DESTINO y se descarta la del origen.
async function unirClientes(origenId, destinoId, { usuario = null } = {}) {
  const db = getDb();
  origenId = Number(origenId); destinoId = Number(destinoId);
  if (!origenId || !destinoId || origenId === destinoId) throw Object.assign(new Error('Elegí dos clientes distintos'), { status: 400 });
  const origen = await db.prepare('SELECT * FROM clientes WHERE id = ?').get(origenId);
  const destino = await db.prepare('SELECT * FROM clientes WHERE id = ?').get(destinoId);
  if (!origen || !destino) throw Object.assign(new Error('Cliente inexistente'), { status: 404 });

  await db.exec(`CREATE TABLE IF NOT EXISTS clientes_uniones (
    id INTEGER PRIMARY KEY AUTOINCREMENT, origen_id INTEGER NOT NULL, origen_nombre TEXT, origen_cuit TEXT,
    destino_id INTEGER NOT NULL, detalle TEXT, usuario TEXT, fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')))`);

  const tablas = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('clientes', 'clientes_uniones')").all()).map((t) => t.name);
  const detalle = {};
  return db.transaction(async () => {
    for (const t of tablas) {
      const cols = (await db.prepare(`PRAGMA table_info(${t})`).all()).map((c) => c.name);
      if (!cols.includes('cliente_id')) continue;
      const n = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE cliente_id = ?`).get(origenId)).n;
      if (!n) continue;
      try {
        await db.prepare(`UPDATE ${t} SET cliente_id = ? WHERE cliente_id = ?`).run(destinoId, origenId);
        detalle[t] = n;
      } catch (e) {
        // Clave única por cliente: fila por fila; la que choca con una del destino se descarta.
        const ids = await db.prepare(`SELECT rowid AS rid FROM ${t} WHERE cliente_id = ?`).all(origenId);
        let ok = 0, desc = 0;
        for (const { rid } of ids) {
          try { await db.prepare(`UPDATE ${t} SET cliente_id = ? WHERE rowid = ?`).run(destinoId, rid); ok++; }
          catch (e2) { await db.prepare(`DELETE FROM ${t} WHERE rowid = ?`).run(rid); desc++; }
        }
        detalle[t] = `${ok} movidas, ${desc} descartadas (el destino ya las tenía)`;
      }
    }
    // El destino conserva su razón social principal; las del origen quedan como secundarias.
    await db.prepare('UPDATE clientes_razones_sociales SET principal = 0 WHERE cliente_id = ? AND id NOT IN (SELECT id FROM clientes_razones_sociales WHERE cliente_id = ? AND principal = 1 ORDER BY id LIMIT 1)').run(destinoId, destinoId);
    // Datos del origen que el destino no tenía (CUIT, mail, agenda GECOM…): se completan.
    for (const col of ['cuit', 'email', 'whatsapp', 'telefono', 'direccion_recoleccion', 'codigo_postal', 'localidad', 'provincia', 'contacto', 'gecom_agenda_cf', 'gecom_agenda_sf', 'plazo_pago_dias']) {
      if ((destino[col] === null || destino[col] === '') && origen[col] !== null && origen[col] !== '') {
        await db.prepare(`UPDATE clientes SET ${col} = ? WHERE id = ?`).run(origen[col], destinoId);
      }
    }
    await db.prepare('INSERT INTO clientes_uniones (origen_id, origen_nombre, origen_cuit, destino_id, detalle, usuario) VALUES (?, ?, ?, ?, ?, ?)')
      .run(origenId, origen.nombre, origen.cuit, destinoId, JSON.stringify(detalle), usuario);
    await db.prepare('DELETE FROM clientes WHERE id = ?').run(origenId);
    return { origen: origen.nombre, destino: destino.nombre, detalle };
  });
}


// ── Vista previa de la unión ──────────────────────────────────────────────────────
// Lo mismo que unirClientes pero sin escribir: cuenta qué tiene cada cliente en cada
// tabla, para que el admin vea qué se mueve antes de confirmar.
const TABLAS_LEGIBLES = {
  envios: 'envíos', liquidaciones: 'liquidaciones', cotizaciones: 'cotizaciones', pickups: 'pickups',
  cc_comprobantes: 'movimientos de cuenta corriente', cc_recibos: 'recibos', cc_cheques: 'cheques', cc_reclamos: 'reclamos',
  clientes_razones_sociales: 'razones sociales', cliente_direcciones: 'direcciones', remitentes: 'remitentes', destinatarios: 'destinatarios',
  profit_overrides: 'celdas de la matriz de tarifas', cliente_tramos: 'tramos de peso', tarifa_kg_overrides: 'precios por kilo',
  cotizador_links: 'links de cotización', tarifario_emitidos: 'tarifarios emitidos', cobros_pickup: 'cobros en pickup',
};
async function previewUnion(origenId, destinoId) {
  const db = getDb();
  origenId = Number(origenId); destinoId = Number(destinoId);
  if (!origenId || !destinoId || origenId === destinoId) throw Object.assign(new Error('Elegí dos clientes distintos'), { status: 400 });
  const origen = await db.prepare('SELECT * FROM clientes WHERE id = ?').get(origenId);
  const destino = await db.prepare('SELECT * FROM clientes WHERE id = ?').get(destinoId);
  if (!origen || !destino) throw Object.assign(new Error('Cliente inexistente'), { status: 404 });
  const tablas = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('clientes', 'clientes_uniones')").all()).map((t) => t.name);
  const filas = [];
  for (const t of tablas) {
    const cols = (await db.prepare(`PRAGMA table_info(${t})`).all()).map((c) => c.name);
    if (!cols.includes('cliente_id')) continue;
    const o = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE cliente_id = ?`).get(origenId)).n;
    const d = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE cliente_id = ?`).get(destinoId)).n;
    if (o || d) filas.push({ tabla: t, nombre: TABLAS_LEGIBLES[t] || t, origen: o, destino: d });
  }
  const saldo = async (id) => db.prepare(
    `SELECT ROUND(COALESCE(SUM(CASE WHEN libro='CF' AND tipo IN ('FA','LQ','ND') THEN saldo WHEN libro='CF' THEN -saldo END),0),2) AS cf,
            ROUND(COALESCE(SUM(CASE WHEN libro='SF' AND tipo IN ('FA','LQ','ND') THEN saldo WHEN libro='SF' THEN -saldo END),0),2) AS sf
     FROM cc_comprobantes WHERE cliente_id = ? AND anulado_at IS NULL`).get(id);
  // Campos del origen que el destino tiene vacíos y se van a completar.
  const completa = {};
  for (const col of ['cuit', 'email', 'whatsapp', 'telefono', 'direccion_recoleccion', 'codigo_postal', 'localidad', 'provincia', 'contacto', 'plazo_pago_dias']) {
    if ((destino[col] === null || destino[col] === '') && origen[col] !== null && origen[col] !== '') completa[col] = origen[col];
  }
  const pick = (c, s) => ({ id: c.id, nombre: c.nombre, nombre_nova: c.nombre_nova, cuit: c.cuit, tipo_cobro: c.tipo_cobro, activo: c.activo, saldo_cf: s.cf, saldo_sf: s.sf });
  return { origen: pick(origen, await saldo(origenId)), destino: pick(destino, await saldo(destinoId)), filas, completa };
}

// ── Posibles duplicados ───────────────────────────────────────────────────────────
// Pares de clientes que parecen el mismo: mismo CUIT (solo dígitos) o mismo nombre
// normalizado (sin tildes, sin puntuación, sin "SA/SRL/S.A."). Es una sugerencia; decide
// una persona.
function claveNombre(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(s\.?a\.?|s\.?r\.?l\.?|sas|srl|sa)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
async function posiblesDuplicados() {
  const db = getDb();
  const cs = await db.prepare('SELECT id, nombre, nombre_nova, cuit, activo, tipo_cobro FROM clientes ORDER BY id').all();
  const pares = new Map();
  const add = (a, b, motivo) => {
    const k = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
    if (!pares.has(k)) pares.set(k, { a, b, motivos: [] });
    pares.get(k).motivos.push(motivo);
  };
  const porCuit = new Map();
  const claves = cs.map((c) => ({ c, ks: [...new Set([claveNombre(c.nombre), claveNombre(c.nombre_nova)].map((k) => k.replace(/\s+/g, '')).filter((k) => k.length >= 5))] }));
  for (const c of cs) {
    const cu = soloDigitos(c.cuit);
    if (cu.length >= 11) { if (porCuit.has(cu)) add(porCuit.get(cu), c, 'mismo CUIT'); else porCuit.set(cu, c); }
  }
  // Nombres: iguales, o uno contenido en el otro ("Polo Top" / "polotop", "Les Gants" /
  // "Les gants carpincho", "Chini" / "Chini/Battlo"). Es una sugerencia, no un veredicto.
  for (let i = 0; i < claves.length; i++) {
    for (let j = i + 1; j < claves.length; j++) {
      const a = claves[i], b = claves[j];
      let motivo = null;
      for (const ka of a.ks) for (const kb of b.ks) {
        if (ka === kb) motivo = 'mismo nombre';
        else if (!motivo && (ka.includes(kb) || kb.includes(ka))) motivo = 'nombre parecido';
      }
      if (motivo) add(a.c, b.c, motivo);
    }
  }
  const orden = { 'mismo CUIT': 0, 'mismo nombre': 1, 'nombre parecido': 2 };
  return [...pares.values()].map((p) => ({ ...p, motivo: [...new Set(p.motivos)].join(' y ') }))
    .sort((x, y) => Math.min(...x.motivos.map((m) => orden[m])) - Math.min(...y.motivos.map((m) => orden[m])));
}

module.exports = { listar, crear, editar, moverACliente, unirClientes, previewUnion, posiblesDuplicados, soloDigitos };
