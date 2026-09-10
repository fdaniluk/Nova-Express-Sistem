// Analítica del Dashboard (rediseño 10/09/2026 — DASHBOARD-REDISENO.md).
//
// UNA sola respuesta con todo lo que la pantalla pinta: KPIs con comparación, series por
// mes, mix de couriers, top de clientes, destinos, estimado vs real, margen, plata en la
// calle y ritmo. Se leen los envíos del período (y los del período de comparación) una
// vez y se agrega en memoria: son cientos de filas, no miles.
//
// Reglas que NO cambian respecto del dashboard viejo:
//   · NO VOLÓ queda afuera de todo (es para lo que existe la marca).
//   · El profit de cada envío sale de utils/profit.js, la MISMA función que Salidas:
//     estimado = venta − compra estimada (desglose congelado); real = venta − costo
//     facturado por el courier. Para los KPIs se usa la precedencia de siempre
//     (real aprobado > liquidación confirmada > estimado). Para "estimado vs real" se usan
//     los dos por separado (profitDoble).
//   · La venta es la de la liquidación confirmada si existe (venta_liq), si no
//     total_cobrado.
const { getDb } = require('../db');
const { deriveProfit, profitDoble, costoEstimado } = require('../utils/profit');
const { hoyLocal } = require('../utils/fecha');
const configuracionModel = require('../models/configuracion.model');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

// ── Fechas ────────────────────────────────────────────────────────────────────
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function mesDe(fecha) { return String(fecha || '').slice(0, 7); }
function primerDia(ym) { return `${ym}-01`; }
// Lista de meses YYYY-MM entre desde y hasta (hasta exclusivo).
function mesesEntre(desde, hasta) {
  const out = [];
  let m = mesDe(desde);
  const fin = mesDe(hasta);
  const finInclusive = hasta.endsWith('-01') ? addMonths(fin, -1) : fin;
  while (m <= finInclusive && out.length < 60) { out.push(m); m = addMonths(m, 1); }
  return out;
}
function diasEntre(a, b) {
  return Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);
}
function sumarDias(fecha, n) {
  const d = new Date(`${fecha}T12:00:00`); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function restarAnio(fecha) {
  const [y, m, d] = fecha.split('-');
  return `${Number(y) - 1}-${m}-${d}`;
}

/**
 * Resuelve el período pedido. `periodo`: 'mes' (este mes), '12m' (últimos 12 meses
 * completos + el actual), 'anio' (este año), 'rango' (desde/hasta a mano, hasta INCLUSIVO
 * en la query → se convierte a exclusivo). Devuelve { desde, hasta } con hasta exclusivo.
 */
function resolverPeriodo(q) {
  const hoy = hoyLocal();
  const mesHoy = mesDe(hoy);
  const p = String(q.periodo || '12m');
  if (p === 'mes') return { desde: primerDia(mesHoy), hasta: primerDia(addMonths(mesHoy, 1)), etiqueta: 'este mes' };
  if (p === 'anio') return { desde: `${hoy.slice(0, 4)}-01-01`, hasta: primerDia(addMonths(mesHoy, 1)), etiqueta: 'este año' };
  if (p === 'rango' && /^\d{4}-\d{2}-\d{2}$/.test(q.desde || '') && /^\d{4}-\d{2}-\d{2}$/.test(q.hasta || '')) {
    return { desde: q.desde, hasta: sumarDias(q.hasta, 1), etiqueta: 'rango' };
  }
  // 12 meses: los 11 anteriores completos + el actual.
  return { desde: primerDia(addMonths(mesHoy, -11)), hasta: primerDia(addMonths(mesHoy, 1)), etiqueta: 'últimos 12 meses' };
}

// El período contra el que se compara: 'previo' = el mismo largo inmediatamente anterior;
// 'anio' = las mismas fechas del año pasado. Elegible (pedido de Felipe, 10/09).
function resolverComparacion(desde, hasta, modo) {
  if (modo === 'anio') return { desde: restarAnio(desde), hasta: restarAnio(hasta), modo: 'anio' };
  const largo = diasEntre(desde, hasta);
  return { desde: sumarDias(desde, -largo), hasta: desde, modo: 'previo' };
}

// ── Lectura ────────────────────────────────────────────────────────────────────
const SQL_ENVIOS = `
  SELECT
    e.id, e.fecha, e.courier, e.tipo_envio, e.pais_destino, e.cliente_id,
    c.nombre AS cliente_nombre, c.nombre_nova AS cliente_nombre_nova,
    e.cantidad_bultos, e.peso_real, e.peso_facturable, e.peso_facturado,
    e.total_cobrado AS total,
    e.flete, e.descuento, e.seguro, e.fuel, e.derechos, e.adicionales, e.otros,
    e.profit, e.porcentaje,
    e.estado_revision, e.costo_facturado, e.fecha_facturado,
    e.liquidado, e.fecha_liquidacion, e.created_at,
    li.utilidad_usd AS utilidad_liq, li.venta_liq AS venta_liq
  FROM envios e
  JOIN clientes c ON c.id = e.cliente_id
  LEFT JOIN (
    SELECT envio_id, SUM(utilidad_usd) AS utilidad_usd, SUM(total_usd) AS venta_liq
    FROM liquidacion_items
    WHERE liquidacion_id IN (SELECT id FROM liquidaciones WHERE estado = 'confirmada')
    GROUP BY envio_id
  ) li ON li.envio_id = e.id
  WHERE e.fecha >= ? AND e.fecha < ? AND e.no_volo = 0`;

async function leerEnvios(db, desde, hasta, filtros) {
  let sql = SQL_ENVIOS;
  const params = [desde, hasta];
  if (filtros.courier) { sql += ' AND e.courier = ?'; params.push(filtros.courier); }
  if (filtros.tipo) { sql += ' AND e.tipo_envio = ?'; params.push(filtros.tipo); }
  return db.prepare(sql).all(...params);
}

// ── Agregación ─────────────────────────────────────────────────────────────────
function ventaDe(e) { return e.venta_liq != null ? Number(e.venta_liq) : (Number(e.total) || 0); }

// Profit "oficial" de un envío (misma precedencia que el dashboard viejo).
function profitOficial(e) {
  const { profit, profit_real } = deriveProfit(e);
  if (profit_real) return profit;
  if (e.utilidad_liq != null) return Number(e.utilidad_liq);
  return profit == null ? 0 : profit;
}
// Compra "oficial": la real aprobada si existe, si no la estimada.
function compraOficial(e) {
  if (e.estado_revision === 'revisado_ok' && e.costo_facturado != null) return Number(e.costo_facturado);
  return costoEstimado(e);
}

function acumulador() { return { envios: 0, bultos: 0, kg_fact: 0, kg_real: 0, venta: 0, compra: 0, profit: 0 }; }
function sumar(acc, e) {
  acc.envios += 1;
  acc.bultos += Number(e.cantidad_bultos) || 1;
  acc.kg_fact += Number(e.peso_facturable) || 0;
  acc.kg_real += Number(e.peso_real) || 0;
  acc.venta += ventaDe(e);
  acc.compra += compraOficial(e);
  acc.profit += profitOficial(e);
  return acc;
}
function cerrar(acc) {
  return {
    envios: acc.envios, bultos: acc.bultos,
    kg_fact: r1(acc.kg_fact), kg_real: r1(acc.kg_real),
    venta: r2(acc.venta), compra: r2(acc.compra), profit: r2(acc.profit),
    margen_pct: acc.compra > 0 ? r1((acc.profit / acc.compra) * 100) : null,
  };
}

// "Estados Unidos" / "estados unidos" / "ESTADOS UNIDOS" son el mismo país.
function normalizarPais(p) {
  const orig = String(p || '').trim().replace(/\s+/g, ' ');
  const clave = orig.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!clave) return { clave: '', nombre: '—' };
  // Para mostrar: cada palabra con mayúscula inicial, conservando los acentos que traiga.
  const nombre = orig.toLowerCase().split(' ').map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
  return { clave, nombre };
}

function variacion(actual, anterior) {
  if (anterior == null || anterior === 0) return null;
  return r1(((actual - anterior) / Math.abs(anterior)) * 100);
}

/**
 * Arma la analítica completa.
 * q: { periodo, desde, hasta, courier, tipo, comparar, top }
 */
async function analitica(q = {}) {
  const db = getDb();
  const hoy = hoyLocal();
  const { desde, hasta, etiqueta } = resolverPeriodo(q);
  const comp = resolverComparacion(desde, hasta, q.comparar === 'anio' ? 'anio' : 'previo');
  const filtros = {
    courier: ['UPS', 'DHL'].includes(String(q.courier || '').toUpperCase()) ? String(q.courier).toUpperCase() : null,
    tipo: ['exportacion', 'importacion'].includes(q.tipo) ? q.tipo : null,
  };
  const [envios, enviosAnt] = await Promise.all([
    leerEnvios(db, desde, hasta, filtros),
    leerEnvios(db, comp.desde, comp.hasta, filtros),
  ]);

  // ── KPIs ──
  const kpis = cerrar(envios.reduce(sumar, acumulador()));
  const kpisAnt = cerrar(enviosAnt.reduce(sumar, acumulador()));
  const sinLiquidar = envios.filter((e) => !e.liquidado);
  kpis.sin_liquidar = {
    n: sinLiquidar.length,
    usd: r2(sinLiquidar.reduce((s, e) => s + ventaDe(e), 0)),
    mas_30: sinLiquidar.filter((e) => diasEntre(e.fecha, hoy) > 30).length,
  };
  const variaciones = {};
  for (const k of ['envios', 'kg_fact', 'venta', 'compra', 'profit']) variaciones[k] = variacion(kpis[k], kpisAnt[k]);
  variaciones.margen_pts = kpis.margen_pct != null && kpisAnt.margen_pct != null ? r1(kpis.margen_pct - kpisAnt.margen_pct) : null;

  // ── Series por mes (período y comparación alineada mes a mes) ──
  const meses = mesesEntre(desde, hasta);
  const porMes = new Map(meses.map((m) => [m, acumulador()]));
  for (const e of envios) { const a = porMes.get(mesDe(e.fecha)); if (a) sumar(a, e); }
  const mesesAnt = mesesEntre(comp.desde, comp.hasta);
  const porMesAnt = new Map(mesesAnt.map((m) => [m, acumulador()]));
  for (const e of enviosAnt) { const a = porMesAnt.get(mesDe(e.fecha)); if (a) sumar(a, e); }
  // La serie anterior se alinea por posición: el mes i del período contra el mes i del
  // período de comparación (en 'anio' es el mismo mes del año pasado).
  const serie = (mapa, lista, campo) => lista.map((m) => r2((mapa.get(m) || acumulador())[campo]));
  const series = {
    meses,
    meses_ant: mesesAnt,
    kg: serie(porMes, meses, 'kg_fact'), envios: serie(porMes, meses, 'envios'),
    venta: serie(porMes, meses, 'venta'), profit: serie(porMes, meses, 'profit'), compra: serie(porMes, meses, 'compra'),
    kg_ant: serie(porMesAnt, mesesAnt, 'kg_fact'), envios_ant: serie(porMesAnt, mesesAnt, 'envios'),
    venta_ant: serie(porMesAnt, mesesAnt, 'venta'), profit_ant: serie(porMesAnt, mesesAnt, 'profit'),
  };

  // ── Mix de couriers por mes ──
  const mix = { UPS: { venta: [], envios: [], kg: [] }, DHL: { venta: [], envios: [], kg: [] } };
  for (const m of meses) {
    for (const c of ['UPS', 'DHL']) {
      const acc = envios.filter((e) => mesDe(e.fecha) === m && e.courier === c).reduce(sumar, acumulador());
      mix[c].venta.push(r2(acc.venta)); mix[c].envios.push(acc.envios); mix[c].kg.push(r1(acc.kg_fact));
    }
  }
  const mixTotal = { UPS: cerrar(envios.filter((e) => e.courier === 'UPS').reduce(sumar, acumulador())), DHL: cerrar(envios.filter((e) => e.courier === 'DHL').reduce(sumar, acumulador())) };

  // ── Top clientes ──
  const porCliente = new Map();
  for (const e of envios) {
    if (!porCliente.has(e.cliente_id)) porCliente.set(e.cliente_id, { id: e.cliente_id, nombre: e.cliente_nombre_nova || e.cliente_nombre, acc: acumulador() });
    sumar(porCliente.get(e.cliente_id).acc, e);
  }
  const porClienteAnt = new Map();
  for (const e of enviosAnt) {
    if (!porClienteAnt.has(e.cliente_id)) porClienteAnt.set(e.cliente_id, acumulador());
    sumar(porClienteAnt.get(e.cliente_id), e);
  }
  const clientes = [...porCliente.values()].map((c) => {
    const a = cerrar(c.acc);
    const ant = porClienteAnt.has(c.id) ? cerrar(porClienteAnt.get(c.id)) : null;
    return {
      id: c.id, nombre: c.nombre, ...a,
      part_venta_pct: kpis.venta > 0 ? r1((a.venta / kpis.venta) * 100) : 0,
      part_kg_pct: kpis.kg_fact > 0 ? r1((a.kg_fact / kpis.kg_fact) * 100) : 0,
      part_profit_pct: kpis.profit > 0 ? r1((a.profit / kpis.profit) * 100) : 0,
      part_envios_pct: kpis.envios > 0 ? r1((a.envios / kpis.envios) * 100) : 0,
      var_venta: ant ? variacion(a.venta, ant.venta) : null,
      var_kg: ant ? variacion(a.kg_fact, ant.kg_fact) : null,
      var_profit: ant ? variacion(a.profit, ant.profit) : null,
      var_envios: ant ? variacion(a.envios, ant.envios) : null,
    };
  }).sort((x, y) => y.venta - x.venta);

  // ── Destinos ──
  const porPais = new Map();
  for (const e of envios) {
    const { clave, nombre } = normalizarPais(e.pais_destino);
    if (!porPais.has(clave)) porPais.set(clave, { pais: nombre, acc: acumulador() });
    sumar(porPais.get(clave).acc, e);
  }
  const paises = [...porPais.values()].map((p) => ({ pais: p.pais, envios: p.acc.envios, kg: r1(p.acc.kg_fact), venta: r2(p.acc.venta) }))
    .sort((a, b) => b.envios - a.envios);

  // ── Estimado vs real: por mes, con cobertura (qué parte del mes tiene factura cruzada) ──
  const real = meses.map((m) => {
    const del = envios.filter((e) => mesDe(e.fecha) === m);
    const conFactura = del.filter((e) => e.costo_facturado != null);
    let compraEst = 0, compraReal = 0, profitEst = 0, profitReal = 0, kgFact = 0, kgReal = 0, aprobadas = 0;
    for (const e of conFactura) {
      const d = profitDoble(e);
      compraEst += d.compra_estimada || 0;
      compraReal += Number(e.costo_facturado) || 0;
      profitEst += d.profit_estimado || 0;
      profitReal += d.profit_real_monto || 0;
      kgFact += Number(e.peso_facturable) || 0;
      kgReal += Number(e.peso_facturado) || 0;
      if (e.estado_revision === 'revisado_ok') aprobadas += 1;
    }
    return {
      mes: m, guias: del.length, cruzadas: conFactura.length, aprobadas,
      cobertura_pct: del.length ? r1((conFactura.length / del.length) * 100) : 0,
      compra_est: r2(compraEst), compra_real: r2(compraReal),
      profit_est: r2(profitEst), profit_real: r2(profitReal),
      kg_fact: r1(kgFact), kg_real: r1(kgReal),
    };
  }).filter((x) => x.cruzadas > 0);

  // ── Margen por mes ──
  const margen = meses.map((m) => {
    const a = porMes.get(m);
    return { mes: m, pct: a && a.compra > 0 ? r1((a.profit / a.compra) * 100) : null };
  });
  const objetivo = await configuracionModel.obtenerMargenObjetivo();

  // ── Plata en la calle (global, no del período: es lo que hay que resolver HOY) ──
  const todos = await db.prepare(`${SQL_ENVIOS}`).all('0000-01-01', '9999-12-31');
  const sinLiqTodos = todos.filter((e) => !e.liquidado);
  const desvios = todos.filter((e) => e.estado_revision === 'a_revisar' && e.costo_facturado != null);
  const disputa = todos.filter((e) => e.estado_revision === 'reclamar' && e.costo_facturado != null);
  const corte = await configuracionModel.obtenerFechaCorte();
  const sinFactura = todos.filter((e) => e.costo_facturado == null && e.courier === 'UPS' && e.fecha >= corte && diasEntre(e.fecha, hoy) > 45);
  const plata = {
    sin_liquidar: { n: sinLiqTodos.length, usd: r2(sinLiqTodos.reduce((s, e) => s + ventaDe(e), 0)) },
    desvios_sin_revisar: { n: desvios.length, usd: r2(desvios.reduce((s, e) => s + (Number(e.costo_facturado) - costoEstimado(e)), 0)) },
    disputa: { n: disputa.length, usd: r2(disputa.reduce((s, e) => s + (Number(e.costo_facturado) - costoEstimado(e)), 0)) },
    sin_factura: { n: sinFactura.length, usd: r2(sinFactura.reduce((s, e) => s + costoEstimado(e), 0)) },
  };

  // ── Ritmo ──
  const ritmoDe = (lista, d1, d2) => {
    const semanas = Math.max(1, diasEntre(d1, d2 > hoy ? sumarDias(hoy, 1) : d2) / 7);
    const n = lista.length;
    const kg = lista.reduce((s, e) => s + (Number(e.peso_facturable) || 0), 0);
    const venta = lista.reduce((s, e) => s + ventaDe(e), 0);
    const liq = lista.filter((e) => e.liquidado && e.fecha_liquidacion);
    const dias = liq.length ? liq.reduce((s, e) => s + Math.max(0, diasEntre(e.fecha, String(e.fecha_liquidacion).slice(0, 10))), 0) / liq.length : null;
    return {
      envios_semana: r1(n / semanas),
      kg_envio: n ? r1(kg / n) : 0,
      venta_envio: n ? r2(venta / n) : 0,
      dias_liquidacion: dias == null ? null : r1(dias),
    };
  };
  const nuevos = await db.prepare('SELECT COUNT(*) AS n FROM clientes WHERE date(created_at) >= ? AND date(created_at) < ?').get(desde, hasta);
  const nuevosAnt = await db.prepare('SELECT COUNT(*) AS n FROM clientes WHERE date(created_at) >= ? AND date(created_at) < ?').get(comp.desde, comp.hasta);
  const ritmo = { ...ritmoDe(envios, desde, hasta), clientes_nuevos: nuevos.n || 0, ant: { ...ritmoDe(enviosAnt, comp.desde, comp.hasta), clientes_nuevos: nuevosAnt.n || 0 } };

  return {
    generado_en: hoy,
    periodo: { desde, hasta_exclusivo: hasta, hasta: sumarDias(hasta, -1), etiqueta, meses },
    comparacion: { desde: comp.desde, hasta: sumarDias(comp.hasta, -1), modo: comp.modo },
    filtros,
    kpis, kpis_ant: kpisAnt, variaciones,
    series, mix, mix_total: mixTotal,
    top_clientes: clientes, clientes_activos: clientes.length,
    paises,
    real,
    margen: { meses: margen, objetivo_pct: objetivo },
    plata,
    ritmo,
  };
}

module.exports = { analitica, resolverPeriodo, resolverComparacion, normalizarPais, mesesEntre };
