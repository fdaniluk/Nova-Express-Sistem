// Aumento de tarifa de un cliente (20/10/2026, pedido de Felipe).
//
// Marcelo está subiendo las tarifas cliente por cliente ("a este 7 %, a este 10 %"). Tocar
// el % general del cliente no alcanzaba: la mayoría ya tiene celdas propias en la matriz y
// precios por kilo, y el general no las pisa (y está bien que no las pise). Esto aplica UN
// porcentaje a todo lo que define el precio de venta del cliente, de una sola vez:
//
//   · clientes.tarifa_pct           (el % general)
//   · profit_overrides              (las celdas de % de las tres matrices, export e import)
//   · tarifa_kg_overrides           (los precios por kilo)
//
// QUÉ SIGNIFICA "SUBIR LA TARIFA 10 %": que el PRECIO DE VENTA del flete suba 10 %. Es lo
// que Marcelo le dice al cliente. Por eso:
//   · un precio por kilo pasa de 12,00 a 13,20 (× 1,10);
//   · un % de ganancia NO pasa de 50 a 60, sino de 50 a 65: el precio es flete × (1 + 50 %)
//     y tiene que quedar en flete × 1,50 × 1,10 = flete × 1,65. Sumarle 10 puntos al % solo
//     habría subido el precio un 6,7 %, y el cliente al que se le avisó "10 %" pagaría otra
//     cosa. La vista previa muestra las dos columnas (antes → después) para que se vea.
//
// Lo que NO toca: tramos, fuel propio, seguro propio (son costos y cortes, no precio), ni
// los envíos ya cargados (el precio de un envío queda como se cobró).
//
// Cada aumento aplicado queda registrado en tarifa_aumentos con la foto de antes y después,
// y el último se puede deshacer (restaura exactamente los valores de antes).
const { getDb } = require('../db');
const { SERVICIOS, TIPOS } = require('./profit.service');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function error400(msg) { const e = new Error(msg); e.status = 400; return e; }

// Valida el pedido: % entre -50 y +200 (negativo = bajar), distinto de 0; tablas = lista de
// { servicio, tipo } o null (todas).
function normalizarPedido(body = {}) {
  const pct = Number(body.pct);
  if (!Number.isFinite(pct) || pct === 0) throw error400('El porcentaje tiene que ser un número distinto de 0');
  if (pct < -50 || pct > 200) throw error400('El porcentaje tiene que estar entre -50 y 200');
  const general = body.general !== false;
  const kg = body.kg !== false;
  let tablas = null;
  if (Array.isArray(body.tablas)) {
    tablas = body.tablas.map((t) => ({ servicio: String(t.servicio || ''), tipo: String(t.tipo || '') }));
    for (const t of tablas) {
      if (!SERVICIOS.includes(t.servicio) || !TIPOS.includes(t.tipo)) throw error400(`Tabla inválida: ${t.servicio} ${t.tipo}`);
    }
  }
  return { pct, general, kg, tablas };
}

const nuevoPct = (p, factor) => r2(((1 + (Number(p) || 0) / 100) * factor - 1) * 100);
const nuevoKg = (precio, factor) => r2((Number(precio) || 0) * factor);
const tablaIncluida = (tablas, servicio, tipo) => !tablas || tablas.some((t) => t.servicio === servicio && t.tipo === tipo);

/**
 * Arma la vista previa: qué cambiaría y a qué valor. No escribe nada.
 */
async function previsualizar(clienteId, body) {
  const db = getDb();
  const cliente = await db.prepare('SELECT id, nombre, tarifa_pct FROM clientes WHERE id = ?').get(clienteId);
  if (!cliente) return null;
  const { pct, general, kg, tablas } = normalizarPedido(body);
  const factor = 1 + pct / 100;

  const filasPct = (await db.prepare(
    `SELECT id, servicio, tipo, zona, peso_min, peso_max, profit_pct FROM profit_overrides
     WHERE cliente_id = ? ORDER BY servicio, tipo, zona IS NOT NULL, zona, peso_min IS NOT NULL, peso_min`
  ).all(clienteId)).filter((f) => tablaIncluida(tablas, f.servicio, f.tipo))
    .map((f) => ({ ...f, antes: f.profit_pct, despues: nuevoPct(f.profit_pct, factor) }));
  const filasKg = kg ? (await db.prepare(
    `SELECT id, servicio, tipo, zona, peso_min, peso_max, precio_kg FROM tarifa_kg_overrides
     WHERE cliente_id = ? ORDER BY servicio, tipo, zona IS NOT NULL, zona, peso_min IS NOT NULL, peso_min`
  ).all(clienteId)).filter((f) => tablaIncluida(tablas, f.servicio, f.tipo))
    .map((f) => ({ ...f, antes: f.precio_kg, despues: nuevoKg(f.precio_kg, factor) })) : [];

  const generalAntes = Number(cliente.tarifa_pct) || 0;
  const cambiaGeneral = general && generalAntes > 0;
  // Resumen por tabla, para los tildes de la pantalla.
  const porTabla = [];
  for (const servicio of SERVICIOS) {
    for (const tipo of TIPOS) {
      const nPct = filasPct.filter((f) => f.servicio === servicio && f.tipo === tipo).length;
      const nKg = filasKg.filter((f) => f.servicio === servicio && f.tipo === tipo).length;
      porTabla.push({ servicio, tipo, celdas_pct: nPct, celdas_kg: nKg, incluida: tablaIncluida(tablas, servicio, tipo) });
    }
  }
  return {
    cliente: { id: cliente.id, nombre: cliente.nombre },
    pct, factor,
    general: { incluido: general, antes: generalAntes, despues: cambiaGeneral ? nuevoPct(generalAntes, factor) : generalAntes, cambia: cambiaGeneral },
    filas_pct: filasPct,
    filas_kg: filasKg,
    por_tabla: porTabla,
    total_cambios: (cambiaGeneral ? 1 : 0) + filasPct.length + filasKg.length,
  };
}

/**
 * Aplica el aumento en una transacción y lo deja registrado. Devuelve la foto aplicada.
 */
async function aplicar(clienteId, body, usuario) {
  const db = getDb();
  const prev = await previsualizar(clienteId, body);
  if (!prev) return null;
  if (!prev.total_cambios) throw error400('No hay nada que aumentar: el cliente no tiene % general, celdas ni precios por kilo en lo elegido');
  return db.transaction(async () => {
    if (prev.general.cambia) {
      await db.prepare('UPDATE clientes SET tarifa_pct = ? WHERE id = ?').run(prev.general.despues, clienteId);
    }
    for (const f of prev.filas_pct) {
      const r = await db.prepare('UPDATE profit_overrides SET profit_pct = ? WHERE id = ? AND cliente_id = ? AND profit_pct = ?').run(f.despues, f.id, clienteId, f.antes);
      if (!r.changes) throw new Error(`La celda ${f.servicio} ${f.tipo} z${f.zona ?? '-'} ${f.peso_min ?? '-'} cambió mientras se aplicaba; no se grabó nada`);
    }
    for (const f of prev.filas_kg) {
      const r = await db.prepare('UPDATE tarifa_kg_overrides SET precio_kg = ? WHERE id = ? AND cliente_id = ? AND precio_kg = ?').run(f.despues, f.id, clienteId, f.antes);
      if (!r.changes) throw new Error(`El precio por kilo ${f.servicio} ${f.tipo} z${f.zona ?? '-'} ${f.peso_min ?? '-'} cambió mientras se aplicaba; no se grabó nada`);
    }
    const detalle = JSON.stringify({
      general: prev.general,
      filas_pct: prev.filas_pct.map((f) => ({ id: f.id, servicio: f.servicio, tipo: f.tipo, zona: f.zona, peso_min: f.peso_min, peso_max: f.peso_max, antes: f.antes, despues: f.despues })),
      filas_kg: prev.filas_kg.map((f) => ({ id: f.id, servicio: f.servicio, tipo: f.tipo, zona: f.zona, peso_min: f.peso_min, peso_max: f.peso_max, antes: f.antes, despues: f.despues })),
    });
    const ins = await db.prepare(
      `INSERT INTO tarifa_aumentos (cliente_id, pct, cambios, usuario_id, usuario, detalle) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(clienteId, prev.pct, prev.total_cambios, usuario ? usuario.id : null, usuario ? usuario.usuario : null, detalle);
    return { ...prev, aumento_id: ins.lastInsertRowid };
  });
}

/** Historial de aumentos del cliente, el más nuevo primero. */
async function historial(clienteId) {
  const rows = await getDb().prepare(
    `SELECT id, pct, cambios, usuario, creado_en, revertido_en, revertido_por FROM tarifa_aumentos
     WHERE cliente_id = ? ORDER BY id DESC LIMIT 20`
  ).all(clienteId);
  return rows;
}

/**
 * Deshace un aumento: restaura los valores de antes. Solo el ÚLTIMO aumento no revertido del
 * cliente, y solo si cada valor sigue siendo el que dejó el aumento (si alguien lo tocó a
 * mano después, se avisa y no se toca nada).
 */
async function revertir(clienteId, aumentoId, usuario) {
  const db = getDb();
  const a = await db.prepare('SELECT * FROM tarifa_aumentos WHERE id = ? AND cliente_id = ?').get(aumentoId, clienteId);
  if (!a) return null;
  if (a.revertido_en) throw error400('Ese aumento ya fue deshecho');
  const ultimo = await db.prepare('SELECT id FROM tarifa_aumentos WHERE cliente_id = ? AND revertido_en IS NULL ORDER BY id DESC LIMIT 1').get(clienteId);
  if (!ultimo || ultimo.id !== a.id) throw error400('Solo se puede deshacer el último aumento del cliente');
  const d = JSON.parse(a.detalle);
  return db.transaction(async () => {
    const fallas = [];
    if (d.general && d.general.cambia) {
      const r = await db.prepare('UPDATE clientes SET tarifa_pct = ? WHERE id = ? AND tarifa_pct = ?').run(d.general.antes, clienteId, d.general.despues);
      if (!r.changes) fallas.push(`el % general ya no es ${d.general.despues}`);
    }
    for (const f of d.filas_pct || []) {
      const r = await db.prepare('UPDATE profit_overrides SET profit_pct = ? WHERE id = ? AND cliente_id = ? AND profit_pct = ?').run(f.antes, f.id, clienteId, f.despues);
      if (!r.changes) fallas.push(`celda ${f.servicio} ${f.tipo} z${f.zona ?? '-'} ${f.peso_min ?? '-'} kg`);
    }
    for (const f of d.filas_kg || []) {
      const r = await db.prepare('UPDATE tarifa_kg_overrides SET precio_kg = ? WHERE id = ? AND cliente_id = ? AND precio_kg = ?').run(f.antes, f.id, clienteId, f.despues);
      if (!r.changes) fallas.push(`precio por kilo ${f.servicio} ${f.tipo} z${f.zona ?? '-'} ${f.peso_min ?? '-'} kg`);
    }
    if (fallas.length) {
      throw error400(`No se deshizo nada: ${fallas.length} valor(es) cambiaron después del aumento (${fallas.slice(0, 3).join('; ')}${fallas.length > 3 ? '…' : ''}). Corregilos a mano desde la matriz.`);
    }
    await db.prepare(`UPDATE tarifa_aumentos SET revertido_en = datetime('now','localtime'), revertido_por = ? WHERE id = ?`).run(usuario ? usuario.usuario : null, a.id);
    return { id: a.id, pct: a.pct, cambios: a.cambios, revertido: true };
  });
}

module.exports = { previsualizar, aplicar, historial, revertir, nuevoPct, nuevoKg };
