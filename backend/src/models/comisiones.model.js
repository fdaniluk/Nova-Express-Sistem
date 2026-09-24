// Comisiones por vendedor (24/09/2026). Decisiones de Felipe:
//   · base = UTILIDAD del envío (misma función que el Dashboard: utilidadEnvio);
//   · momento = cuando el envío SALE (envios.fecha, no_volo = 0);
//   · el cambio de vendedor es histórico por fecha (clientes_vendedores.desde/hasta);
//   · % por vendedor, con excepción opcional por cliente (clientes_vendedores.comision_pct).
// "Nova Express" es la casa (es_casa = 1): sus clientes no generan comisión.
const { getDb } = require('../db');
const { utilidadEnvio } = require('../utils/profit');

const DESDE_SIEMPRE = '2000-01-01';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ── Vendedores ───────────────────────────────────────────────────────────────────
async function listarVendedores() {
  return getDb().prepare(
    `SELECT v.*, u.usuario AS usuario_nombre,
            (SELECT COUNT(*) FROM clientes_vendedores cv WHERE cv.vendedor_id = v.id AND cv.hasta IS NULL) AS clientes
     FROM vendedores v LEFT JOIN usuarios u ON u.id = v.usuario_id
     ORDER BY v.es_casa, v.activo DESC, v.nombre COLLATE NOCASE`
  ).all();
}
async function crearVendedor({ nombre, comision_pct = 0, usuario_id = null }) {
  const db = getDb();
  if (!nombre || !String(nombre).trim()) throw err('El nombre es obligatorio');
  const pct = Number(comision_pct);
  if (!(pct >= 0 && pct <= 100)) throw err('El % tiene que estar entre 0 y 100');
  const r = await db.prepare('INSERT INTO vendedores (nombre, comision_pct, usuario_id) VALUES (?, ?, ?)').run(String(nombre).trim(), pct, usuario_id || null);
  return db.prepare('SELECT * FROM vendedores WHERE id = ?').get(r.lastInsertRowid);
}
async function editarVendedor(id, data) {
  const db = getDb();
  const v = await db.prepare('SELECT * FROM vendedores WHERE id = ?').get(id);
  if (!v) throw err('Vendedor inexistente', 404);
  const nombre = data.nombre !== undefined ? String(data.nombre).trim() : v.nombre;
  if (!nombre) throw err('El nombre es obligatorio');
  const pct = data.comision_pct !== undefined ? Number(data.comision_pct) : v.comision_pct;
  if (!(pct >= 0 && pct <= 100)) throw err('El % tiene que estar entre 0 y 100');
  const activo = data.activo !== undefined ? (data.activo ? 1 : 0) : v.activo;
  const usuario_id = data.usuario_id !== undefined ? (data.usuario_id || null) : v.usuario_id;
  await db.prepare('UPDATE vendedores SET nombre = ?, comision_pct = ?, activo = ?, usuario_id = ? WHERE id = ?').run(nombre, pct, activo, usuario_id, id);
  return db.prepare('SELECT * FROM vendedores WHERE id = ?').get(id);
}

// ── Asignaciones cliente → vendedor ──────────────────────────────────────────────
async function clientesConVendedor() {
  return getDb().prepare(
    `SELECT c.id AS cliente_id, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente, c.nombre AS razon_social,
            c.tipo_cobro, c.activo,
            cv.id AS asignacion_id, cv.vendedor_id, v.nombre AS vendedor, v.es_casa, cv.desde, cv.comision_pct AS pct_cliente,
            v.comision_pct AS pct_vendedor,
            (SELECT COUNT(*) FROM clientes_vendedores h WHERE h.cliente_id = c.id) AS cambios,
            (SELECT COUNT(*) FROM envios e WHERE e.cliente_id = c.id AND e.no_volo = 0 AND e.fecha >= date('now','localtime','start of month','-2 months')) AS envios_3m
     FROM clientes c
     LEFT JOIN clientes_vendedores cv ON cv.cliente_id = c.id AND cv.hasta IS NULL
     LEFT JOIN vendedores v ON v.id = cv.vendedor_id
     ORDER BY cliente COLLATE NOCASE`
  ).all();
}

async function historialCliente(clienteId) {
  return getDb().prepare(
    `SELECT cv.*, v.nombre AS vendedor FROM clientes_vendedores cv JOIN vendedores v ON v.id = cv.vendedor_id
     WHERE cv.cliente_id = ? ORDER BY cv.desde DESC, cv.id DESC`
  ).all(clienteId);
}

// Asigna (o reasigna) el vendedor de un cliente a partir de `desde`. La asignación
// vigente anterior se cierra en esa fecha. Si `desde` es anterior o igual al inicio de la
// vigente, se reemplaza la vigente (no queda un rango vacío).
async function asignar(clienteId, { vendedor_id, desde = null, comision_pct = null, usuario = null }) {
  const db = getDb();
  const cliente = await db.prepare('SELECT id FROM clientes WHERE id = ?').get(clienteId);
  if (!cliente) throw err('Cliente inexistente', 404);
  const v = await db.prepare('SELECT * FROM vendedores WHERE id = ?').get(vendedor_id);
  if (!v) throw err('Vendedor inexistente', 404);
  if (!v.activo) throw err('Ese vendedor está inactivo');
  if (desde && !/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw err('desde inválida (YYYY-MM-DD)');
  if (comision_pct != null && comision_pct !== '' && !(Number(comision_pct) >= 0 && Number(comision_pct) <= 100)) throw err('El % tiene que estar entre 0 y 100');
  const pct = comision_pct === '' || comision_pct == null ? null : Number(comision_pct);
  const vigente = await db.prepare('SELECT * FROM clientes_vendedores WHERE cliente_id = ? AND hasta IS NULL').get(clienteId);
  const d = desde || (vigente ? hoy() : DESDE_SIEMPRE);
  return db.transaction(async () => {
    if (vigente) {
      if (d <= vigente.desde) {
        await db.prepare('UPDATE clientes_vendedores SET vendedor_id = ?, desde = ?, comision_pct = ?, usuario = ? WHERE id = ?').run(v.id, d, pct, usuario, vigente.id);
        return db.prepare('SELECT * FROM clientes_vendedores WHERE id = ?').get(vigente.id);
      }
      if (vigente.vendedor_id === v.id && vigente.comision_pct === pct) return vigente; // nada cambió
      await db.prepare('UPDATE clientes_vendedores SET hasta = ? WHERE id = ?').run(d, vigente.id);
    }
    const r = await db.prepare('INSERT INTO clientes_vendedores (cliente_id, vendedor_id, desde, comision_pct, usuario) VALUES (?, ?, ?, ?, ?)').run(clienteId, v.id, d, pct, usuario);
    return db.prepare('SELECT * FROM clientes_vendedores WHERE id = ?').get(r.lastInsertRowid);
  });
}

// Deshace la asignación vigente: vuelve a quedar vigente la anterior (si había).
async function deshacerVigente(clienteId) {
  const db = getDb();
  const vigente = await db.prepare('SELECT * FROM clientes_vendedores WHERE cliente_id = ? AND hasta IS NULL').get(clienteId);
  if (!vigente) throw err('El cliente no tiene vendedor asignado', 404);
  return db.transaction(async () => {
    await db.prepare('DELETE FROM clientes_vendedores WHERE id = ?').run(vigente.id);
    const prev = await db.prepare('SELECT id FROM clientes_vendedores WHERE cliente_id = ? ORDER BY desde DESC, id DESC LIMIT 1').get(clienteId);
    if (prev) await db.prepare('UPDATE clientes_vendedores SET hasta = NULL WHERE id = ?').run(prev.id);
    return { deshecha: vigente.id, vigente: prev ? prev.id : null };
  });
}

function hoy() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── Resumen del período ──────────────────────────────────────────────────────────
function rangoMes(mes) {
  if (!/^\d{4}-\d{2}$/.test(mes)) throw err('mes inválido (YYYY-MM)');
  const [y, m] = mes.split('-').map(Number);
  const desde = `${mes}-01`;
  const hasta = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { desde, hasta };
}

// Envíos del período con su vendedor resuelto por fecha. Misma consulta base que el
// Dashboard (utilidad_liq de la liquidación confirmada, costo real si está aprobado).
async function enviosDelPeriodo(desde, hasta) {
  const db = getDb();
  const envios = await db.prepare(
    `SELECT e.id, e.fecha, e.numero_guia, e.courier, e.tipo_envio, e.pais_destino, e.peso_facturable,
            e.total_cobrado AS total, e.flete, e.descuento, e.seguro, e.fuel, e.derechos, e.adicionales, e.otros,
            e.profit, e.porcentaje, e.estado_revision, e.costo_facturado, e.liquidado,
            c.id AS cliente_id, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente,
            li.utilidad_usd AS utilidad_liq, li.venta_liq
     FROM envios e JOIN clientes c ON c.id = e.cliente_id
     LEFT JOIN (SELECT envio_id, SUM(utilidad_usd) AS utilidad_usd, SUM(total_usd) AS venta_liq
                FROM liquidacion_items WHERE liquidacion_id IN (SELECT id FROM liquidaciones WHERE estado = 'confirmada')
                GROUP BY envio_id) li ON li.envio_id = e.id
     WHERE e.fecha >= ? AND e.fecha < ? AND e.no_volo = 0
     ORDER BY e.fecha, e.id`
  ).all(desde, hasta);
  const asignaciones = await db.prepare(
    `SELECT cv.*, v.nombre AS vendedor, v.es_casa, v.comision_pct AS pct_vendedor
     FROM clientes_vendedores cv JOIN vendedores v ON v.id = cv.vendedor_id`
  ).all();
  const porCliente = new Map();
  for (const a of asignaciones) { if (!porCliente.has(a.cliente_id)) porCliente.set(a.cliente_id, []); porCliente.get(a.cliente_id).push(a); }
  const resolver = (clienteId, fecha) => (porCliente.get(clienteId) || []).find((a) => a.desde <= fecha && (a.hasta == null || a.hasta > fecha)) || null;

  return envios.map((row) => {
    const a = resolver(row.cliente_id, row.fecha);
    const { profit_real } = require('../utils/profit').deriveProfit(row);
    const utilidad = r2(utilidadEnvio(row));
    const venta = r2(row.venta_liq != null ? row.venta_liq : row.total);
    const pct = a ? (a.es_casa ? 0 : (a.comision_pct != null ? a.comision_pct : a.pct_vendedor)) : 0;
    return {
      id: row.id, fecha: row.fecha, numero_guia: row.numero_guia, courier: row.courier, tipo_envio: row.tipo_envio,
      pais_destino: row.pais_destino, cliente_id: row.cliente_id, cliente: row.cliente,
      venta, utilidad, pct, comision: r2(utilidad * pct / 100),
      fuente: profit_real ? 'real' : (row.utilidad_liq != null ? 'liquidación' : 'estimada'),
      vendedor_id: a ? a.vendedor_id : null, vendedor: a ? a.vendedor : null, es_casa: a ? a.es_casa : 0,
      pct_origen: a ? (a.es_casa ? 'casa' : (a.comision_pct != null ? 'cliente' : 'vendedor')) : 'sin asignar',
    };
  });
}

async function resumen(mes) {
  const { desde, hasta } = rangoMes(mes);
  const envios = await enviosDelPeriodo(desde, hasta);
  const vendedores = await listarVendedores();
  const grupos = new Map(); // vendedor_id (null = sin asignar) → acumulado
  const nuevo = (id, nombre, es_casa, pct) => ({ vendedor_id: id, vendedor: nombre, es_casa, pct, envios: 0, venta: 0, utilidad: 0, comision: 0, clientes: new Map() });
  for (const v of vendedores) grupos.set(v.id, nuevo(v.id, v.nombre, v.es_casa, v.comision_pct));
  grupos.set(null, nuevo(null, 'Sin asignar', 0, 0));
  for (const e of envios) {
    const g = grupos.get(e.vendedor_id) || grupos.get(null);
    g.envios++; g.venta += e.venta; g.utilidad += e.utilidad; g.comision += e.comision;
    let c = g.clientes.get(e.cliente_id);
    if (!c) { c = { cliente_id: e.cliente_id, cliente: e.cliente, pct: e.pct, pct_origen: e.pct_origen, envios: 0, venta: 0, utilidad: 0, comision: 0 }; g.clientes.set(e.cliente_id, c); }
    c.envios++; c.venta += e.venta; c.utilidad += e.utilidad; c.comision += e.comision;
  }
  const fin = (g) => ({ ...g, venta: r2(g.venta), utilidad: r2(g.utilidad), comision: r2(g.comision),
    clientes: [...g.clientes.values()].map((c) => ({ ...c, venta: r2(c.venta), utilidad: r2(c.utilidad), comision: r2(c.comision) })).sort((a, b) => b.utilidad - a.utilidad) });
  const lista = [...grupos.values()].filter((g) => g.vendedor_id !== null && (g.envios > 0 || vendedores.find((v) => v.id === g.vendedor_id && v.activo))).map(fin);
  const sin = fin(grupos.get(null));
  const total = envios.reduce((a, e) => ({ envios: a.envios + 1, venta: a.venta + e.venta, utilidad: a.utilidad + e.utilidad, comision: a.comision + e.comision }), { envios: 0, venta: 0, utilidad: 0, comision: 0 });
  return { mes, desde, hasta, vendedores: lista, sin_asignar: sin, total: { envios: total.envios, venta: r2(total.venta), utilidad: r2(total.utilidad), comision: r2(total.comision) } };
}

async function detalle(mes, vendedorId) {
  const { desde, hasta } = rangoMes(mes);
  const envios = await enviosDelPeriodo(desde, hasta);
  if (vendedorId === 'sin') return envios.filter((e) => e.vendedor_id == null);
  if (vendedorId != null) return envios.filter((e) => String(e.vendedor_id) === String(vendedorId));
  return envios;
}

async function mesesDisponibles() {
  return (await getDb().prepare("SELECT DISTINCT strftime('%Y-%m', fecha) AS mes FROM envios WHERE no_volo = 0 ORDER BY mes DESC").all()).map((r) => r.mes);
}

module.exports = { listarVendedores, crearVendedor, editarVendedor, clientesConVendedor, historialCliente, asignar, deshacerVigente, resumen, detalle, mesesDisponibles, DESDE_SIEMPRE };
