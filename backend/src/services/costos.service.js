/**
 * costos.service.js — Costos de la empresa (08/10/2026).
 *
 * Lo que cuesta tener Nova Express abierta, mes por mes: sueldos, alquiler, servicios,
 * Ingresos Brutos (sale solo de las facturas del courier), insumos, combustible… Es el
 * módulo que Felipe quiere para Marcelo: "utilidad de envíos − costos = lo que queda".
 *
 * Reglas (Felipe, 08/10):
 *   · Lista fija de categorías + las que se agregan a mano. Cada una dice si la puede
 *     cargar la oficina (`oficina = 1`: gastos del día a día) o solo dirección.
 *   · Cada costo se carga EN LA MONEDA EN QUE SE PAGA (ARS o USD). Para ver todo junto
 *     se convierte con el DÓLAR DEL MES: el elegido a mano para ese mes o, si no, el
 *     promedio de los tipos de cambio que Cobranzas carga en cc_tipo_cambio.
 *   · Registro mensual. Los costos "fijos" se copian al mes siguiente como "por
 *     confirmar"; se confirman con el monto real cuando llega la factura.
 *   · Lo que carga un empleado entra "por confirmar". Confirma quien tiene ver_costos.
 *   · Un empleado sin ver_costos ve y edita SOLO los gastos del día a día de las
 *     categorías de oficina, y nunca totales ni resultado neto.
 *   · Ingresos Brutos es automático: es la suma de `facturas_cargadas.percepciones` del
 *     mes (por fecha de factura). No se carga ni se edita; la fila la arma este servicio.
 */
const { getDb } = require('../db');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MES_RE = /^\d{4}-\d{2}$/;

function err(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

function mesAnterior(mes) {
  const [y, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function ultimoDia(mes) {
  const [y, m] = mes.split('-').map(Number);
  return `${mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
function validarMes(mes) {
  if (!MES_RE.test(String(mes || ''))) throw err(`mes inválido: ${mes} (se espera YYYY-MM)`);
  return mes;
}

function puedeTodo(usuario) {
  return !!usuario && (usuario.rol === 'admin' || Number(usuario.ver_costos) === 1);
}

// ── Dólar del mes ──────────────────────────────────────────────────────────────────────
// 1. el que se eligió a mano para ese mes (costos_meses);
// 2. el promedio de los tipos de cambio cargados en Cobranzas dentro del mes;
// 3. el último cargado antes de que termine el mes;
// 4. nada: los costos en pesos no se pueden pasar a dólares y se avisa.
async function tipoCambioMes(mes) {
  const db = getDb();
  const manual = await db.prepare('SELECT tc, tc_fuente FROM costos_meses WHERE mes = ?').get(mes);
  if (manual && Number(manual.tc) > 0) return { tc: Number(manual.tc), tc_fuente: manual.tc_fuente || 'manual', manual: true };
  const prom = await db.prepare(
    `SELECT AVG(COALESCE(venta, promedio)) AS tc, COUNT(*) AS n FROM cc_tipo_cambio
     WHERE fecha >= ? AND fecha <= ? AND COALESCE(venta, promedio) > 0`
  ).get(`${mes}-01`, ultimoDia(mes));
  if (prom && Number(prom.tc) > 0) return { tc: r2(prom.tc), tc_fuente: `promedio de Cobranzas (${prom.n} día${prom.n === 1 ? '' : 's'})`, manual: false };
  const ult = await db.prepare(
    'SELECT fecha, venta, promedio FROM cc_tipo_cambio WHERE fecha <= ? AND COALESCE(venta, promedio) > 0 ORDER BY fecha DESC LIMIT 1'
  ).get(ultimoDia(mes));
  if (ult) return { tc: r2(ult.venta || ult.promedio), tc_fuente: `último de Cobranzas (${ult.fecha})`, manual: false };
  return { tc: null, tc_fuente: 'sin cargar', manual: false };
}

async function guardarTipoCambioMes(mes, tc, usuario) {
  validarMes(mes);
  const db = getDb();
  if (tc === null || tc === '' || tc === undefined) {
    await db.prepare('DELETE FROM costos_meses WHERE mes = ?').run(mes);
    return tipoCambioMes(mes);
  }
  const n = Number(tc);
  if (!(n > 0)) throw err('El dólar del mes tiene que ser un número mayor a 0');
  await db.prepare(
    `INSERT INTO costos_meses (mes, tc, tc_fuente, actualizado_en) VALUES (?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(mes) DO UPDATE SET tc = excluded.tc, tc_fuente = excluded.tc_fuente, actualizado_en = excluded.actualizado_en`
  ).run(mes, n, `a mano${usuario && usuario.usuario ? ` (${usuario.usuario})` : ''}`);
  return tipoCambioMes(mes);
}

// ── Categorías ─────────────────────────────────────────────────────────────────────────
async function listarCategorias({ soloOficina = false, incluirInactivas = false } = {}) {
  const db = getDb();
  const rows = await db.prepare('SELECT * FROM costos_categorias ORDER BY orden, nombre').all();
  return rows.filter((c) => (incluirInactivas || c.activa) && (!soloOficina || (c.oficina && !c.automatica)));
}

async function crearCategoria({ nombre, oficina = 0, orden = null }) {
  const n = String(nombre || '').trim();
  if (!n) throw err('La categoría necesita un nombre');
  const db = getDb();
  const ya = await db.prepare('SELECT id, activa FROM costos_categorias WHERE LOWER(nombre) = LOWER(?)').get(n);
  if (ya) {
    if (!ya.activa) { await db.prepare('UPDATE costos_categorias SET activa = 1 WHERE id = ?').run(ya.id); return db.prepare('SELECT * FROM costos_categorias WHERE id = ?').get(ya.id); }
    throw err('Ya hay una categoría con ese nombre', 409);
  }
  const max = await db.prepare('SELECT COALESCE(MAX(orden), 0) AS m FROM costos_categorias WHERE automatica IS NULL').get();
  const r = await db.prepare('INSERT INTO costos_categorias (nombre, orden, oficina) VALUES (?, ?, ?)').run(n, orden ?? (max.m + 10), oficina ? 1 : 0);
  return db.prepare('SELECT * FROM costos_categorias WHERE id = ?').get(r.lastInsertRowid || r.lastID);
}

async function editarCategoria(id, { nombre, oficina, activa, orden }) {
  const db = getDb();
  const cat = await db.prepare('SELECT * FROM costos_categorias WHERE id = ?').get(id);
  if (!cat) throw err('Categoría inexistente', 404);
  if (cat.automatica && (nombre !== undefined || oficina !== undefined)) throw err('Las categorías automáticas no se editan');
  const campos = [];
  const vals = [];
  if (nombre !== undefined) { const n = String(nombre).trim(); if (!n) throw err('La categoría necesita un nombre'); campos.push('nombre = ?'); vals.push(n); }
  if (oficina !== undefined) { campos.push('oficina = ?'); vals.push(oficina ? 1 : 0); }
  if (activa !== undefined) { campos.push('activa = ?'); vals.push(activa ? 1 : 0); }
  if (orden !== undefined) { campos.push('orden = ?'); vals.push(Number(orden) || 100); }
  if (campos.length) await db.prepare(`UPDATE costos_categorias SET ${campos.join(', ')} WHERE id = ?`).run(...vals, id);
  return db.prepare('SELECT * FROM costos_categorias WHERE id = ?').get(id);
}

// ── Ingresos Brutos del mes (automático) ─────────────────────────────────────────────
async function iibbDelMes(mes) {
  const db = getDb();
  const r = await db.prepare(
    `SELECT COALESCE(SUM(percepciones), 0) AS total, COUNT(*) AS n,
            SUM(CASE WHEN courier = 'DHL' THEN 1 ELSE 0 END) AS dhl
     FROM facturas_cargadas WHERE COALESCE(percepciones, 0) <> 0 AND substr(fecha_factura, 1, 7) = ?`
  ).get(mes);
  return { total: r2(r.total), facturas: r.n || 0, ups: (r.n || 0) - (r.dhl || 0), dhl: r.dhl || 0 };
}

// ── Costos ─────────────────────────────────────────────────────────────────────────────
function validarCosto(b, categoria) {
  const detalle = String(b.detalle || '').trim();
  if (!detalle) throw err('Falta el detalle del costo');
  const monto = Number(b.monto);
  if (!(monto > 0)) throw err('El monto tiene que ser mayor a 0');
  const moneda = String(b.moneda || '').toUpperCase();
  if (!['ARS', 'USD'].includes(moneda)) throw err("La moneda tiene que ser 'ARS' o 'USD'");
  if (!categoria || !categoria.activa) throw err('Categoría inexistente o dada de baja');
  if (categoria.automatica) throw err(`"${categoria.nombre}" la llena el sistema: no se carga a mano`);
  return { detalle, monto: r2(monto), moneda };
}

async function crearCosto(b, usuario) {
  const db = getDb();
  const mes = validarMes(b.mes);
  const cat = await db.prepare('SELECT * FROM costos_categorias WHERE id = ?').get(Number(b.categoria_id));
  const v = validarCosto(b, cat);
  const todo = puedeTodo(usuario);
  if (!todo && !cat.oficina) throw err(`"${cat.nombre}" la carga dirección, no la oficina`, 403);
  // Lo que carga un empleado queda por confirmar; lo de dirección entra confirmado.
  const estado = todo ? 'confirmado' : 'por_confirmar';
  const r = await db.prepare(
    `INSERT INTO costos (mes, categoria_id, detalle, monto, moneda, fijo, estado, nota, creado_por, confirmado_por, confirmado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(mes, cat.id, v.detalle, v.monto, v.moneda, todo && b.fijo ? 1 : 0, estado, b.nota ? String(b.nota).trim() : null,
    usuario ? usuario.id : null, estado === 'confirmado' && usuario ? usuario.id : null, estado === 'confirmado' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null);
  return obtenerCosto(r.lastInsertRowid || r.lastID);
}

async function obtenerCosto(id) {
  return getDb().prepare(
    `SELECT c.*, k.nombre AS categoria, k.oficina AS categoria_oficina, u.usuario AS creado_por_nombre, cu.usuario AS confirmado_por_nombre
     FROM costos c JOIN costos_categorias k ON k.id = c.categoria_id
     LEFT JOIN usuarios u ON u.id = c.creado_por LEFT JOIN usuarios cu ON cu.id = c.confirmado_por WHERE c.id = ?`
  ).get(id);
}

// Un empleado solo toca lo suyo de las categorías de oficina y mientras esté por confirmar.
async function costoEditablePor(id, usuario) {
  const c = await obtenerCosto(id);
  if (!c) throw err('Costo inexistente', 404);
  if (puedeTodo(usuario)) return c;
  if (!c.categoria_oficina || c.estado !== 'por_confirmar' || (usuario && c.creado_por !== usuario.id)) {
    throw err('Ese costo ya está confirmado o no es tuyo: lo edita dirección', 403);
  }
  return c;
}

async function editarCosto(id, b, usuario) {
  const db = getDb();
  const c = await costoEditablePor(id, usuario);
  const cat = await db.prepare('SELECT * FROM costos_categorias WHERE id = ?').get(b.categoria_id !== undefined ? Number(b.categoria_id) : c.categoria_id);
  const v = validarCosto({ detalle: b.detalle ?? c.detalle, monto: b.monto ?? c.monto, moneda: b.moneda ?? c.moneda }, cat);
  if (!puedeTodo(usuario) && !cat.oficina) throw err(`"${cat.nombre}" la carga dirección, no la oficina`, 403);
  const mes = b.mes !== undefined ? validarMes(b.mes) : c.mes;
  await db.prepare(
    'UPDATE costos SET mes = ?, categoria_id = ?, detalle = ?, monto = ?, moneda = ?, fijo = ?, nota = ? WHERE id = ?'
  ).run(mes, cat.id, v.detalle, v.monto, v.moneda, puedeTodo(usuario) ? (b.fijo !== undefined ? (b.fijo ? 1 : 0) : c.fijo) : c.fijo, b.nota !== undefined ? (b.nota ? String(b.nota).trim() : null) : c.nota, id);
  return obtenerCosto(id);
}

async function eliminarCosto(id, usuario) {
  await costoEditablePor(id, usuario);
  await getDb().prepare('DELETE FROM costos WHERE id = ?').run(id);
  return { ok: true };
}

async function confirmarCosto(id, usuario, { monto } = {}) {
  if (!puedeTodo(usuario)) throw err('Confirma quien tiene permiso de costos', 403);
  const db = getDb();
  const c = await obtenerCosto(id);
  if (!c) throw err('Costo inexistente', 404);
  const m = monto !== undefined && monto !== null && monto !== '' ? Number(monto) : c.monto;
  if (!(m > 0)) throw err('El monto tiene que ser mayor a 0');
  await db.prepare(
    "UPDATE costos SET estado = 'confirmado', monto = ?, confirmado_por = ?, confirmado_en = datetime('now','localtime') WHERE id = ?"
  ).run(r2(m), usuario.id, id);
  return obtenerCosto(id);
}

// Copia al mes pedido los costos FIJOS del mes anterior que todavía no estén copiados.
// Entran "por confirmar" para que se les ponga el monto real. Idempotente: un fijo ya
// copiado (mismo origen_id en el mes) no se duplica.
async function traerFijos(mes, usuario) {
  validarMes(mes);
  if (!puedeTodo(usuario)) throw err('Traer los fijos lo hace quien tiene permiso de costos', 403);
  const db = getDb();
  const ant = mesAnterior(mes);
  const fijos = await db.prepare("SELECT * FROM costos WHERE mes = ? AND fijo = 1 AND estado = 'confirmado'").all(ant);
  let copiados = 0;
  for (const f of fijos) {
    const raiz = f.origen_id || f.id;
    const ya = await db.prepare('SELECT 1 FROM costos WHERE mes = ? AND (origen_id = ? OR id = ?)').get(mes, raiz, raiz);
    if (ya) continue;
    await db.prepare(
      `INSERT INTO costos (mes, categoria_id, detalle, monto, moneda, fijo, estado, nota, origen_id, creado_por)
       VALUES (?, ?, ?, ?, ?, 1, 'por_confirmar', ?, ?, ?)`
    ).run(mes, f.categoria_id, f.detalle, f.monto, f.moneda, f.nota, raiz, usuario.id);
    copiados++;
  }
  return { mes, desde: ant, copiados, fijos: fijos.length };
}

// ── Lectura del mes ────────────────────────────────────────────────────────────────────
function convertir(monto, moneda, tc) {
  if (moneda === 'USD') return { usd: r2(monto), ars: tc ? r2(monto * tc) : null };
  return { ars: r2(monto), usd: tc ? r2(monto / tc) : null };
}

/**
 * Todo lo que la pantalla necesita para un mes. Con `usuario` sin permiso devuelve SOLO
 * los gastos del día a día (categorías de oficina) y sin totales.
 */
async function resumenMes(mes, usuario) {
  validarMes(mes);
  const db = getDb();
  const todo = puedeTodo(usuario);
  const { tc, tc_fuente, manual } = await tipoCambioMes(mes);
  const cats = await listarCategorias({ incluirInactivas: true });
  const rows = await db.prepare(
    `SELECT c.*, k.nombre AS categoria, k.oficina AS categoria_oficina, k.orden AS categoria_orden,
            u.usuario AS creado_por_nombre, cu.usuario AS confirmado_por_nombre
     FROM costos c JOIN costos_categorias k ON k.id = c.categoria_id
     LEFT JOIN usuarios u ON u.id = c.creado_por LEFT JOIN usuarios cu ON cu.id = c.confirmado_por
     WHERE c.mes = ? ORDER BY k.orden, k.nombre, c.estado DESC, c.id`
  ).all(mes);
  const visibles = todo ? rows : rows.filter((r) => r.categoria_oficina);
  const costos = visibles.map((r) => ({ ...r, ...convertir(r.monto, r.moneda, tc) }));

  // Ingresos Brutos: fila automática (solo dirección la ve).
  let iibb = null;
  if (todo) {
    const catIibb = cats.find((c) => c.automatica === 'iibb');
    const i = await iibbDelMes(mes);
    if (catIibb && i.total > 0) {
      iibb = {
        id: null, mes, categoria_id: catIibb.id, categoria: catIibb.nombre, categoria_orden: catIibb.orden, automatica: 'iibb',
        detalle: `Percepción de Ingresos Brutos · ${i.facturas} factura${i.facturas === 1 ? '' : 's'}${i.dhl ? ` (${i.ups} UPS + ${i.dhl} DHL)` : ' UPS'}`,
        monto: i.total, moneda: 'USD', fijo: 0, estado: 'confirmado', ...convertir(i.total, 'USD', tc),
      };
      costos.push(iibb);
    }
  }

  const porCategoria = {};
  for (const c of costos) {
    const k = porCategoria[c.categoria_id] || (porCategoria[c.categoria_id] = { categoria_id: c.categoria_id, categoria: c.categoria, orden: c.categoria_orden, automatica: c.automatica || null, oficina: c.categoria_oficina ? 1 : 0, n: 0, por_confirmar: 0, ars: 0, usd: 0, usd_total: 0, sin_tc: false });
    k.n++;
    if (c.estado === 'por_confirmar') k.por_confirmar++;
    if (c.moneda === 'ARS') k.ars = r2(k.ars + c.monto); else k.usd = r2(k.usd + c.monto);
    if (c.usd == null) k.sin_tc = true; else k.usd_total = r2(k.usd_total + c.usd);
  }
  const categorias = Object.values(porCategoria).sort((a, b) => a.orden - b.orden || a.categoria.localeCompare(b.categoria));

  const base = { mes, tc, tc_fuente, tc_manual: manual, puede_todo: todo, costos, categorias,
    categorias_disponibles: cats.filter((c) => c.activa && !c.automatica && (todo || c.oficina)),
    por_confirmar: costos.filter((c) => c.estado === 'por_confirmar').length };
  if (!todo) return base;

  const tot = { ars: 0, usd: 0, usd_total: 0, ars_total: 0, sin_tc: 0, n: costos.length };
  for (const c of costos) {
    if (c.moneda === 'ARS') tot.ars = r2(tot.ars + c.monto); else tot.usd = r2(tot.usd + c.monto);
    if (c.usd == null) tot.sin_tc++; else tot.usd_total = r2(tot.usd_total + c.usd);
    if (c.ars == null) tot.sin_tc++; else tot.ars_total = r2(tot.ars_total + c.ars);
  }
  for (const k of categorias) k.pct = tot.usd_total > 0 && !k.sin_tc ? Math.round((k.usd_total / tot.usd_total) * 100) : null;

  // Utilidad de los envíos del mes: la MISMA del Dashboard (analitica.service → utils/profit).
  const analitica = require('./analitica.service');
  const a = await analitica.analitica({ periodo: 'rango', desde: `${mes}-01`, hasta: ultimoDia(mes) });
  const utilidad = r2(a.kpis.profit);
  const resultado = tc || tot.ars === 0 ? r2(utilidad - tot.usd_total) : null;

  // El mes anterior, para comparar.
  const ant = mesAnterior(mes);
  const tcAnt = await tipoCambioMes(ant);
  const rowsAnt = await db.prepare('SELECT monto, moneda FROM costos WHERE mes = ?').all(ant);
  const iibbAnt = await iibbDelMes(ant);
  let antUsd = iibbAnt.total; let antSinTc = false;
  for (const r of rowsAnt) { const v = convertir(r.monto, r.moneda, tcAnt.tc); if (v.usd == null) antSinTc = true; else antUsd = r2(antUsd + v.usd); }

  return {
    ...base,
    iibb,
    totales: { ...tot, utilidad_envios: utilidad, envios: a.kpis.envios, resultado_neto: resultado,
      resultado_pct: resultado != null && utilidad > 0 ? Math.round((resultado / utilidad) * 100) : null,
      mes_anterior: { mes: ant, usd_total: antSinTc ? null : r2(antUsd), variacion_pct: !antSinTc && antUsd > 0 && !tot.sin_tc ? Math.round(((tot.usd_total - antUsd) / antUsd) * 100) : null } },
  };
}

/** Serie por mes para el Dashboard: costos en USD y utilidad, de `desde` a `hasta` (YYYY-MM). */
async function seriePorMes(desde, hasta) {
  validarMes(desde); validarMes(hasta);
  const db = getDb();
  const meses = [];
  for (let m = desde; m <= hasta; m = siguienteMes(m)) meses.push(m);
  const out = [];
  for (const m of meses) {
    const { tc } = await tipoCambioMes(m);
    const rows = await db.prepare('SELECT monto, moneda, categoria_id, estado FROM costos WHERE mes = ?').all(m);
    const iibb = await iibbDelMes(m);
    let usd = iibb.total; let sinTc = false; let porConfirmar = 0;
    for (const r of rows) {
      if (r.estado === 'por_confirmar') porConfirmar++;
      const v = convertir(r.monto, r.moneda, tc); if (v.usd == null) sinTc = true; else usd = r2(usd + v.usd);
    }
    // por_confirmar (09/10, Dashboard): cuántos renglones del mes esperan revisión de dirección.
    out.push({ mes: m, costos_usd: sinTc ? null : r2(usd), sin_tc: sinTc, n: rows.length + (iibb.total ? 1 : 0), por_confirmar: porConfirmar });
  }
  return out;
}
function siguienteMes(mes) {
  const [y, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

module.exports = {
  puedeTodo, tipoCambioMes, guardarTipoCambioMes, listarCategorias, crearCategoria, editarCategoria,
  iibbDelMes, crearCosto, editarCosto, eliminarCosto, confirmarCosto, traerFijos, resumenMes, seriePorMes,
  mesAnterior, siguienteMes, ultimoDia,
};
