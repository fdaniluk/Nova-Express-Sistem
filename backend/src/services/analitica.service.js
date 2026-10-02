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
const { deriveProfit, profitDoble, costoEstimado, utilidadEnvio, ventaEnvio, compraEnvio, cargosDdp, SUBQUERY_LIQUIDACION, SUBQUERY_CARGOS } = require('../utils/profit');
const { hoyLocal } = require('../utils/fecha');
const { esHabil, habilesEntre } = require('../utils/habiles');
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

// A LA MISMA ALTURA (pedido de Felipe, 29/09/2026): si el período elegido todavía no
// terminó, se compara lo que va (desde el inicio hasta hoy) contra el mismo tramo del
// período de comparación. El 15 de septiembre, "Este mes" se compara contra el 1–15 de
// agosto y no contra agosto entero; si no, el mes en curso siempre viene "en rojo". Lo
// mismo con "Este año" y "Últimos 12 meses": el mes en curso del período anterior se corta
// en el mismo día. Devuelve null si el período ya terminó (no cambia nada).
function clampDia(ym, dia) {
  const ultimo = diasEntre(primerDia(ym), primerDia(addMonths(ym, 1)));
  return `${ym}-${String(Math.min(dia, ultimo)).padStart(2, '0')}`;
}
function compararMismaAltura(desde, hasta, modo, hoy) {
  if (hoy < desde || sumarDias(hoy, 1) >= hasta) return null;
  const hastaHoy = sumarDias(hoy, 1);
  if (modo === 'anio') {
    return { desde: restarAnio(desde), hasta: sumarDias(restarAnio(hoy), 1), modo: 'anio', misma_altura: true, hasta_periodo: hastaHoy };
  }
  // Período de meses enteros (Este mes, Este año, 12 meses): se corre la misma cantidad de
  // meses y se corta en el mismo número de día (el 31 cae en el último día si el mes es
  // más corto).
  if (desde.endsWith('-01') && hasta.endsWith('-01')) {
    const n = mesesEntre(desde, hasta).length;
    const corte = clampDia(addMonths(mesDe(hoy), -n), Number(hoy.slice(8, 10)));
    return { desde: primerDia(addMonths(mesDe(desde), -n)), hasta: sumarDias(corte, 1), modo: 'previo', misma_altura: true, hasta_periodo: hastaHoy };
  }
  // Cualquier otro largo: el mismo largo inmediatamente antes, recortado a lo que va.
  const largo = diasEntre(desde, hasta);
  const d = sumarDias(desde, -largo);
  return { desde: d, hasta: sumarDias(d, diasEntre(desde, hastaHoy)), modo: 'previo', misma_altura: true, hasta_periodo: hastaHoy };
}

// Días hábiles entre dos fechas (la segunda exclusiva): lunes a viernes menos feriados y
// puentes (utils/habiles.js).
function diasHabiles(desde, hasta) {
  return habilesEntre(desde, hasta);
}

// PROYECCIÓN DEL MES EN CURSO (29/09/2026), por ritmo de día hábil: lo acumulado dividido
// por los días hábiles transcurridos (incluido hoy), por los días hábiles del mes.
//
// Por qué este método (análisis de julio, agosto y septiembre 2026, los tres meses que
// tiene el sistema completos): la primera semana NO anticipó el mes. Pesó el 34 %, el 20 %
// y el 30 % de los kilos (según cayeran los pallets grandes de DHL), y agosto, que arrancó
// flojo, terminó siendo el mes más pesado. Al 5º día hábil cualquier método erraba entre
// −40 % y +40 % en kilos y ±15–30 % en envíos; al 10º, el ritmo hábil ya erraba ±10 %, y
// al 15º, ±10 % en kilos y ±3 % en envíos. Proyectar con "cuánto pesó la primera semana en
// los meses anteriores" no mejoró al ritmo simple con tan pocos meses.
//
// Por eso la proyección viaja con su PRECISIÓN HISTÓRICA: se hace la misma cuenta, al
// mismo día hábil, sobre los meses cerrados que tiene el sistema, y se informa cuánto
// erró. Con cada mes que se cierra, el rango se recalcula solo.
function acumuladoPorHabil(envios, desde, hastaExcl) {
  // Para cada día hábil k (1..N) del mes, lo acumulado hasta ese día inclusive. Lo cargado
  // un sábado o un feriado se suma al día hábil anterior (o al primero si cae antes).
  const dias = [];
  for (let d = desde; d < hastaExcl; d = sumarDias(d, 1)) dias.push(d);
  const porDia = new Map();
  for (const e of envios) {
    const k = String(e.fecha).slice(0, 10);
    const a = porDia.get(k) || { envios: 0, kg_fact: 0 };
    a.envios += 1; a.kg_fact += Number(e.peso_facturable) || 0;
    porDia.set(k, a);
  }
  const cum = []; let acc = { envios: 0, kg_fact: 0 };
  for (const d of dias) {
    const v = porDia.get(d);
    if (v) acc = { envios: acc.envios + v.envios, kg_fact: acc.kg_fact + v.kg_fact };
    if (esHabil(d)) cum.push({ ...acc });
    else if (cum.length) cum[cum.length - 1] = { ...acc };
  }
  return { cum, total: acc };
}

function precisionHistorica(historia, habilesPasados, habilesMes) {
  // historia: [{ mes, envios: [...] }] de meses CERRADOS. Solo cuentan meses "de verdad"
  // (30 envíos o más): junio 2026, cuando se empezó a cargar en el sistema, tiene 22 y
  // arrancó a mitad de mes.
  const errores = { envios: [], kg_fact: [] };
  const meses = [];
  for (const h of historia) {
    if (!h.envios || h.envios.length < 30) continue;
    const desde = primerDia(h.mes);
    const { cum, total } = acumuladoPorHabil(h.envios, desde, primerDia(addMonths(h.mes, 1)));
    if (!cum.length) continue;
    // La misma ALTURA del mes, no el mismo número de día: 10 de 22 hábiles en septiembre
    // es el 45 % del mes, que en agosto (20 hábiles) es el día 9.
    const frac = habilesMes ? habilesPasados / habilesMes : 1;
    const k = Math.max(1, Math.min(cum.length, Math.round(frac * cum.length)));
    for (const campo of ['envios', 'kg_fact']) {
      if (!(total[campo] > 0)) continue;
      const proy = (cum[k - 1][campo] / k) * cum.length;
      errores[campo].push(r1(((proy - total[campo]) / total[campo]) * 100));
    }
    meses.push(h.mes);
  }
  if (!meses.length) return null;
  const rango = (l) => (l.length ? { min: Math.min(...l), max: Math.max(...l) } : null);
  return { meses, envios: rango(errores.envios), kg_fact: rango(errores.kg_fact), errores };
}

function proyectarMes(envios, desde, hasta, hoy, mesAnterior, historia = null) {
  const habilesMes = diasHabiles(desde, hasta);
  const habilesPasados = diasHabiles(desde, sumarDias(hoy, 1));
  if (!habilesMes || !habilesPasados) return null;
  const factor = habilesMes / habilesPasados;
  const acc = envios.reduce(sumar, acumulador());
  const proj = (v) => r1(v * factor);
  const dia = Number(hoy.slice(8, 10));
  const ant = mesAnterior ? cerrar(mesAnterior.reduce(sumar, acumulador())) : null;
  const vs = (a, b) => (b ? r1(((a - b) / Math.abs(b)) * 100) : null);
  const precision = historia ? precisionHistorica(historia, habilesPasados, habilesMes) : null;
  // Confianza: la dice la historia (cuánto erró la proyección de KILOS a esta altura en los
  // meses cerrados); sin historia, cuánto del mes pasó.
  let confianza;
  if (habilesPasados >= habilesMes) confianza = 'cerrado';
  else if (precision && precision.kg_fact) {
    const peor = Math.max(Math.abs(precision.kg_fact.min), Math.abs(precision.kg_fact.max));
    confianza = peor <= 10 ? 'alta' : peor <= 25 ? 'media' : 'baja';
  } else confianza = habilesPasados >= 10 ? 'alta' : habilesPasados >= 5 ? 'media' : 'baja';
  // Rango: si en los meses cerrados la proyección a esta altura erró entre −a % y +b %,
  // el total real estuvo entre proy/(1+b) y proy/(1+a). Siempre incluye la proyección
  // misma: con dos o tres meses de historia no hay base para "corregirla".
  const rango = (valor, campo, dec) => {
    const p = precision && precision[campo];
    if (!p || confianza === 'cerrado') return null;
    const f = (x) => (dec === 0 ? Math.round(x) : r1(x));
    const lo = valor / (1 + Math.max(p.max, 0) / 100);
    const hi = valor / (1 + Math.max(Math.min(p.min, 0), -90) / 100);
    return { min: f(lo), max: f(hi) };
  };
  const envProy = Math.round(acc.envios * factor);
  const kgProy = proj(acc.kg_fact);
  return {
    metodo: 'ritmo_habil', dia, habiles_pasados: habilesPasados, habiles_mes: habilesMes,
    avance_pct: r1((habilesPasados / habilesMes) * 100), confianza,
    actual: { envios: acc.envios, kg_fact: r1(acc.kg_fact), venta: r2(acc.venta), profit: r2(acc.profit) },
    sin_venta: acc.sin_venta_n,
    envios: envProy, kg_fact: kgProy, venta: r2(acc.venta * factor), profit: r2(acc.profit * factor),
    rango: { envios: rango(envProy, 'envios', 0), kg_fact: rango(kgProy, 'kg_fact', 1) },
    precision,
    mes_anterior: ant ? { envios: ant.envios, kg_fact: ant.kg_fact, venta: ant.venta, profit: ant.profit } : null,
    vs_mes_anterior: ant ? { envios: vs(acc.envios * factor, ant.envios), kg_fact: vs(acc.kg_fact * factor, ant.kg_fact), venta: vs(acc.venta * factor, ant.venta), profit: vs(acc.profit * factor, ant.profit) } : null,
  };
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
    li.utilidad_usd AS utilidad_liq, li.venta_liq AS venta_liq, cp.cargos_post AS cargos_post, cp.cargos_ddp AS cargos_ddp
  FROM envios e
  JOIN clientes c ON c.id = e.cliente_id
  LEFT JOIN (${SUBQUERY_LIQUIDACION}) li ON li.envio_id = e.id
  LEFT JOIN (${SUBQUERY_CARGOS}) cp ON cp.envio_id = e.id
  WHERE e.fecha >= ? AND e.fecha < ? AND e.no_volo = 0`;

async function leerEnvios(db, desde, hasta, filtros) {
  let sql = SQL_ENVIOS;
  const params = [desde, hasta];
  if (filtros.courier) { sql += ' AND e.courier = ?'; params.push(filtros.courier); }
  if (filtros.tipo) { sql += ' AND e.tipo_envio = ?'; params.push(filtros.tipo); }
  return db.prepare(sql).all(...params);
}

// ── Agregación ─────────────────────────────────────────────────────────────────
// Venta completa del envío (lo cobrado + cargos posteriores): utils/profit.js, la misma de
// Salidas y del Dashboard viejo.
function ventaDe(e) { return ventaEnvio(e); }

// Profit "oficial" de un envío (misma precedencia que el dashboard viejo).
// La misma de Dashboard, Comisiones y el perfil del cliente (utils/profit.js).
function profitOficial(e) {
  return Number(utilidadEnvio(e)) || 0;
}
// Compra "oficial": la real aprobada si existe, si no la estimada.
function compraOficial(e) { return compraEnvio(e); }

function acumulador() { return { envios: 0, bultos: 0, kg_fact: 0, kg_real: 0, venta: 0, compra: 0, profit: 0, sin_venta_n: 0, sin_venta_compra: 0 }; }
// Un envío SIN precio de venta cargado (total 0) cuenta en envíos y kilos, pero su compra
// va aparte (29/09/2026): antes sumaba a Compra y no a Venta ni a Profit, y el dashboard
// mostraba una compra mayor que la venta con un profit positivo (sept-2026: 63 envíos sin
// precio con USD 42k de compra). Se informa en sin_venta para que no quede escondido.
function sumar(acc, e) {
  acc.envios += 1;
  acc.bultos += Number(e.cantidad_bultos) || 1;
  acc.kg_fact += Number(e.peso_facturable) || 0;
  acc.kg_real += Number(e.peso_real) || 0;
  const venta = ventaDe(e);
  const compra = compraOficial(e);
  if (venta > 0) {
    acc.venta += venta;
    acc.compra += compra;
    acc.profit += profitOficial(e);
  } else {
    acc.sin_venta_n += 1;
    acc.sin_venta_compra += compra;
  }
  return acc;
}
function cerrar(acc) {
  return {
    envios: acc.envios, bultos: acc.bultos,
    kg_fact: r1(acc.kg_fact), kg_real: r1(acc.kg_real),
    venta: r2(acc.venta), compra: r2(acc.compra), profit: r2(acc.profit),
    margen_pct: acc.compra > 0 ? r1((acc.profit / acc.compra) * 100) : null,
    sin_venta: { n: acc.sin_venta_n, compra: r2(acc.sin_venta_compra) },
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
  const { desde, hasta: hastaPeriodo, etiqueta } = resolverPeriodo(q);
  let comp = resolverComparacion(desde, hastaPeriodo, q.comparar === 'anio' ? 'anio' : 'previo');
  let hasta = hastaPeriodo;
  // Período en curso: KPIs y comparación a la misma altura (hasta hoy contra el mismo
  // tramo del período anterior), y una proyección del mes entero contra el mes anterior
  // entero.
  // Solo en los períodos predefinidos: un rango elegido a mano se toma tal cual.
  const mismaAltura = etiqueta === 'rango' ? null : compararMismaAltura(desde, hastaPeriodo, comp.modo, hoy);
  if (mismaAltura) { comp = mismaAltura; hasta = mismaAltura.hasta_periodo; }
  const filtros = {
    courier: ['UPS', 'DHL'].includes(String(q.courier || '').toUpperCase()) ? String(q.courier).toUpperCase() : null,
    tipo: ['exportacion', 'importacion'].includes(q.tipo) ? q.tipo : null,
  };
  const [envios, enviosAnt] = await Promise.all([
    leerEnvios(db, desde, hasta, filtros),
    leerEnvios(db, comp.desde, comp.hasta, filtros),
  ]);

  // ── Proyección del mes en curso ──
  // Cuando el período elegido abarca el mes de hoy entero (Este mes, Este año, 12 meses).
  // Los 6 meses anteriores se leen de una vez: el último es "el mes anterior" contra el que
  // se compara, y todos sirven para medir cuánto erró la proyección a esta altura.
  let proyeccion = null;
  const mesHoy = mesDe(hoy);
  if (mismaAltura && desde <= primerDia(mesHoy) && hastaPeriodo >= primerDia(addMonths(mesHoy, 1))) {
    const hist = await leerEnvios(db, primerDia(addMonths(mesHoy, -6)), primerDia(mesHoy), filtros);
    const historia = [];
    for (let i = 6; i >= 1; i--) {
      const m = addMonths(mesHoy, -i);
      historia.push({ mes: m, envios: hist.filter((e) => mesDe(e.fecha) === m) });
    }
    const delMes = envios.filter((e) => mesDe(e.fecha) === mesHoy);
    const mesAnt = historia[historia.length - 1].envios;
    proyeccion = proyectarMes(delMes, primerDia(mesHoy), primerDia(addMonths(mesHoy, 1)), hoy, mesAnt, historia);
    if (proyeccion) proyeccion.mes = mesHoy;
  }

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
    desvios_sin_revisar: { n: desvios.length, usd: r2(desvios.reduce((s, e) => s + (Number(e.costo_facturado) + cargosDdp(e) - costoEstimado(e)), 0)) },
    disputa: { n: disputa.length, usd: r2(disputa.reduce((s, e) => s + (Number(e.costo_facturado) + cargosDdp(e) - costoEstimado(e)), 0)) },
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
    comparacion: { desde: comp.desde, hasta: sumarDias(comp.hasta, -1), modo: comp.modo, misma_altura: !!mismaAltura },
    proyeccion,
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

module.exports = { analitica, resolverPeriodo, resolverComparacion, compararMismaAltura, diasHabiles, proyectarMes, precisionHistorica, acumuladoPorHabil, normalizarPais, mesesEntre };
