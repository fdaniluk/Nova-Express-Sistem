// Perfiles de remitente por cliente (08/09/2026, pedido de Felipe: "hay clientes que
// cambian el nombre o algo de quien envía; todo tiene que poder cargarse un perfil
// totalmente nuevo adentro").
//
// El perfil PRINCIPAL es la ficha del cliente (razón social, CUIT, dirección de
// recolección, CP, localidad, provincia, teléfono, contacto, mail): no se duplica, se
// lee de `clientes`. Los otros viven en `remitentes`. Todo el sistema (guía UPS,
// proforma, envío) trabaja con la forma única que devuelve resolver().
const { getDb } = require('../db');

const CAMPOS = ['nombre', 'cuit', 'direccion', 'codigo_postal', 'ciudad', 'provincia', 'telefono', 'contacto', 'email'];

/** La ficha del cliente con la forma de un remitente. */
function desdeCliente(c) {
  if (!c) return null;
  return {
    id: null,
    principal: true,
    cliente_id: c.id,
    nombre: c.nombre,
    cuit: c.cuit || null,
    direccion: c.direccion_recoleccion || null,
    codigo_postal: c.codigo_postal || null,
    ciudad: c.localidad || null,
    provincia: c.provincia || null,
    telefono: c.telefono || c.whatsapp || null,
    contacto: c.contacto || null,
    email: c.email || null,
    activo: 1,
  };
}

function desdeFila(r) {
  if (!r) return null;
  return { ...r, principal: false };
}

/**
 * Devuelve el remitente a usar: la fila de `remitentes` si remitenteId viene y es del
 * cliente, o la ficha del cliente si es null. Si viene un id que no es del cliente,
 * devuelve null (el que llama decide el error).
 */
async function resolver(cliente, remitenteId) {
  if (!cliente) return null;
  if (!remitenteId) return desdeCliente(cliente);
  const r = await getDb()
    .prepare('SELECT * FROM remitentes WHERE id = ? AND cliente_id = ?')
    .get(remitenteId, cliente.id);
  return r ? desdeFila(r) : null;
}

/** Ficha del cliente + perfiles activos (o todos con `todos`), la ficha primero. */
async function listar(cliente, { todos = false } = {}) {
  const rows = await getDb()
    .prepare(
      `SELECT * FROM remitentes WHERE cliente_id = ? ${todos ? '' : 'AND activo = 1'}
       ORDER BY ultimo_uso DESC, nombre COLLATE NOCASE`
    )
    .all(cliente.id);
  return [desdeCliente(cliente), ...rows.map(desdeFila)];
}

function limpiar(body) {
  const out = {};
  for (const c of CAMPOS) {
    if (body[c] === undefined) continue;
    const v = String(body[c] ?? '').trim();
    out[c] = v || null;
  }
  return out;
}

async function crear(clienteId, body) {
  const db = getDb();
  const d = limpiar(body);
  if (!d.nombre) {
    const err = new Error('El nombre del remitente es obligatorio');
    err.status = 400;
    throw err;
  }
  const cols = CAMPOS.filter((c) => d[c] !== undefined);
  const result = await db
    .prepare(`INSERT INTO remitentes (cliente_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
    .run(clienteId, ...cols.map((c) => d[c]));
  return desdeFila(await db.prepare('SELECT * FROM remitentes WHERE id = ?').get(result.lastInsertRowid));
}

async function actualizar(clienteId, id, body) {
  const db = getDb();
  const actual = await db.prepare('SELECT * FROM remitentes WHERE id = ? AND cliente_id = ?').get(id, clienteId);
  if (!actual) return null;
  const d = limpiar(body);
  if (d.nombre === null) {
    const err = new Error('El nombre del remitente es obligatorio');
    err.status = 400;
    throw err;
  }
  const cols = CAMPOS.filter((c) => d[c] !== undefined);
  if (body.activo !== undefined) { cols.push('activo'); d.activo = body.activo ? 1 : 0; }
  if (cols.length) {
    await db
      .prepare(`UPDATE remitentes SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => d[c]), actual.id);
  }
  return desdeFila(await db.prepare('SELECT * FROM remitentes WHERE id = ?').get(actual.id));
}

async function desactivar(clienteId, id) {
  const db = getDb();
  const actual = await db.prepare('SELECT id FROM remitentes WHERE id = ? AND cliente_id = ?').get(id, clienteId);
  if (!actual) return false;
  await db.prepare('UPDATE remitentes SET activo = 0 WHERE id = ?').run(actual.id);
  return true;
}

async function tocar(id) {
  if (!id) return;
  await getDb().prepare("UPDATE remitentes SET ultimo_uso = datetime('now', 'localtime') WHERE id = ?").run(id);
}

module.exports = { CAMPOS, desdeCliente, resolver, listar, crear, actualizar, desactivar, tocar };
