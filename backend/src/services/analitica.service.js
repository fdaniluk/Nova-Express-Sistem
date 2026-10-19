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
const { deriveProfit, profitDoble, costoEstimado, utilidadEnvio, ventaEnvio, compraEnvio, cargosPost, cargosDdp, SUBQUERY_LIQUIDACION, SUBQUERY_CARGOS } = require('../utils/profit');
const { hoyLocal } = require('../utils/fecha');
const { esHabil, habilesEntre } = require('../utils/habiles');
const { bandaCalibrada, CALIBRACION } = require('../utils/calibracion-proyeccion');
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
  // Meses enteros (Este mes, Este año, 12 meses, o un rango del 1 al último día): se
  // corre la misma cantidad de meses. Antes se restaba la misma cantidad de DÍAS, y
  // septiembre (30 días) se comparaba contra el 2–31 de agosto (14/10, lo vio Felipe).
  if (desde.endsWith('-01') && hasta.endsWith('-01')) {
    const n = mesesEntre(desde, hasta).length;
    return { desde: primerDia(addMonths(mesDe(desde), -n)), hasta: desde, modo: 'previo' };
  }
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

// PROYECCIÓN DEL MES EN CURSO.
//
// 29/09/2026: ritmo por día hábil (lo del mes / hábiles pasados × hábiles del mes), con solo
// jul–sep 2026 para medirlo.
// 15/10/2026: con 34 meses de planillas (dic-2023 → sep-2026) se midió de verdad. La primera
// semana pesó entre el 12 % y el 39 % del mes: NO anticipa el mes. El ritmo simple erraba
// 23 % en kilos al 5º hábil (peor mes 64 %). Gana la MEZCLA: el ritmo ponderado por cuánto
// del mes pasó, más el promedio de los 3 meses anteriores por el resto:
//     proyección = w · ritmo + (1 − w) · promedio últimos 3 meses,  w = hábiles pasados / hábiles del mes
// Error medio en kilos: 15 % al 5º hábil, 9 % al 10º, 7 % al 15º (vs 23 / 11 / 7 del ritmo).
// Perfil histórico de la primera semana, mismo mes del año anterior, estacionalidad y base de
// 6 meses: ninguno mejoró (ver utils/calibracion-proyeccion.js).
//
// La PRECISIÓN ("entre A y B" y la etiqueta) sale de esa medición de 34 meses (tabla fija por
// altura del mes) mientras el sistema no tenga 6+ meses cerrados propios; después se mide
// sola con precisionHistorica, con el mismo método, y se recalcula con cada mes que cierra.
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
  // historia: [{ mes, envios: [...] }] de meses CERRADOS, en orden. Solo cuentan meses "de
  // verdad" (30 envíos o más): junio 2026, cuando se empezó a cargar, tiene 22 y arrancó a
  // mitad de mes. Se mide el método real (la mezcla), así que cada mes evaluado necesita
  // los 3 anteriores completos para la base.
  const errores = { envios: [], kg_fact: [] };
  const meses = [];
  const validos = historia.filter((h) => h.envios && h.envios.length >= 30);
  const totalDe = (h) => acumuladoPorHabil(h.envios, primerDia(h.mes), primerDia(addMonths(h.mes, 1))).total;
  for (let i = 3; i < validos.length; i++) {
    const h = validos[i];
    const base = validos.slice(i - 3, i);
    // Los 3 anteriores tienen que ser los 3 meses inmediatamente previos (sin huecos).
    if (base.some((b, j) => b.mes !== addMonths(h.mes, j - 3))) continue;
    const desde = primerDia(h.mes);
    const { cum, total } = acumuladoPorHabil(h.envios, desde, primerDia(addMonths(h.mes, 1)));
    if (!cum.length) continue;
    const frac = habilesMes ? habilesPasados / habilesMes : 1;
    const k = Math.max(1, Math.min(cum.length, Math.round(frac * cum.length)));
    const w = k / cum.length;
    const bases = base.map(totalDe);
    for (const campo of ['envios', 'kg_fact']) {
      if (!(total[campo] > 0)) continue;
      const ritmo = (cum[k - 1][campo] / k) * cum.length;
      const prom = bases.reduce((a, b) => a + b[campo], 0) / bases.length;
      const proy = w * ritmo + (1 - w) * prom;
      errores[campo].push(r1(((proy - total[campo]) / total[campo]) * 100));
    }
    meses.push(h.mes);
  }
  if (!meses.length) return null;
  const rango = (l) => (l.length ? { min: Math.min(...l), max: Math.max(...l) } : null);
  return { meses, envios: rango(errores.envios), kg_fact: rango(errores.kg_fact), errores, origen: 'sistema' };
}

function proyectarMes(envios, desde, hasta, hoy, mesAnterior, historia = null) {
  const habilesMes = diasHabiles(desde, hasta);
  const habilesPasados = diasHabiles(desde, sumarDias(hoy, 1));
  if (!habilesMes || !habilesPasados) return null;
  const w = Math.min(1, habilesPasados / habilesMes);
  const factor = habilesMes / habilesPasados;
  const acc = envios.reduce(sumar, acumulador());
  const dia = Number(hoy.slice(8, 10));
  const ant = mesAnterior ? cerrar(mesAnterior.reduce(sumar, acumulador())) : null;
  const vs = (a, b) => (b ? r1(((a - b) / Math.abs(b)) * 100) : null);
  // Base: los 3 meses cerrados inmediatamente anteriores (con 30+ envíos). Sin los 3, la
  // proyección es el ritmo solo (como antes) y se dice.
  const cerrados = (historia || []).filter((h) => h.envios && h.envios.length >= 30);
  const ultimos3 = cerrados.slice(-3);
  const mesActual = desde.slice(0, 7);
  const baseOk = ultimos3.length === 3 && ultimos3.every((h, j) => h.mes === addMonths(mesActual, j - 3));
  const base = baseOk ? ultimos3.map((h) => cerrar(h.envios.reduce(sumar, acumulador()))) : null;
  const prom = (campo) => base.reduce((a, b) => a + (Number(b[campo]) || 0), 0) / base.length;
  const proyectar = (campo) => {
    const ritmo = (Number(acc[campo]) || 0) * factor;
    if (!base || w >= 1) return ritmo;
    return w * ritmo + (1 - w) * prom(campo);
  };
  const metodo = base && w < 1 ? 'mezcla' : 'ritmo_habil';
  // Precisión: la propia del sistema cuando ya midió 6+ meses; si no, la calibración fija
  // de las planillas (34 meses).
  const propia = historia ? precisionHistorica(historia, habilesPasados, habilesMes) : null;
  const frac = habilesPasados / habilesMes;
  const calib = metodo === 'mezcla' ? {
    meses: [], n: CALIBRACION.meses, origen: 'planillas', desde: CALIBRACION.desde, hasta: CALIBRACION.hasta,
    envios: bandaCalibrada('envios', frac), kg_fact: bandaCalibrada('kg_fact', frac), venta: bandaCalibrada('venta', frac),
  } : null;
  const precision = propia && propia.meses.length >= 6 ? propia : (calib || propia);
  let confianza;
  if (habilesPasados >= habilesMes) confianza = 'cerrado';
  else if (precision && precision.kg_fact) {
    // Con la calibración se usa el error medio; con la medición propia (pocos meses), el peor.
    const medida = precision.kg_fact.mape != null ? precision.kg_fact.mape : Math.max(Math.abs(precision.kg_fact.min), Math.abs(precision.kg_fact.max));
    confianza = medida <= 10 ? 'alta' : medida <= 25 ? 'media' : 'baja';
  } else confianza = habilesPasados >= 10 ? 'alta' : habilesPasados >= 5 ? 'media' : 'baja';
  // Rango: si a esta altura la proyección erró entre −a % y +b %, el real estuvo entre
  // proy/(1+b) y proy/(1+a). Siempre incluye la proyección misma.
  const rango = (valor, campo, dec) => {
    const p = precision && precision[campo];
    if (!p || confianza === 'cerrado') return null;
    const f = (x) => (dec === 0 ? Math.round(x) : dec === 1 ? r1(x) : r2(x));
    const lo = valor / (1 + Math.max(p.max, 0) / 100);
    const hi = valor / (1 + Math.max(Math.min(p.min, 0), -90) / 100);
    return { min: f(lo), max: f(hi) };
  };
  const envProy = Math.round(proyectar('envios'));
  const kgProy = r1(proyectar('kg_fact'));
  const ventaProy = r2(proyectar('venta'));
  const profitProy = r2(proyectar('profit'));
  return {
    metodo, dia, habiles_pasados: habilesPasados, habiles_mes: habilesMes,
    avance_pct: r1((habilesPasados / habilesMes) * 100), confianza,
    actual: { envios: acc.envios, kg_fact: r1(acc.kg_fact), venta: r2(acc.venta), profit: r2(acc.profit) },
    ritmo: { envios: Math.round(acc.envios * factor), kg_fact: r1(acc.kg_fact * factor), venta: r2(acc.venta * factor), profit: r2(acc.profit * factor) },
    base: base ? { meses: ultimos3.map((h) => h.mes), envios: r1(prom('envios')), kg_fact: r1(prom('kg_fact')), venta: r2(prom('venta')), profit: r2(prom('profit')) } : null,
    peso_ritmo_pct: r1(w * 100),
    sin_venta: acc.sin_venta_n,
    envios: envProy, kg_fact: kgProy, venta: ventaProy, profit: profitProy,
    rango: { envios: rango(envProy, 'envios', 0), kg_fact: rango(kgProy, 'kg_fact', 1), venta: rango(ventaProy, 'venta', 2) },
    precision,
    mes_anterior: ant ? { envios: ant.envios, kg_fact: ant.kg_fact, venta: ant.venta, profit: ant.profit } : null,
    vs_mes_anterior: ant ? { envios: vs(envProy, ant.envios), kg_fact: vs(kgProy, ant.kg_fact), venta: vs(ventaProy, ant.venta), profit: vs(profitProy, ant.profit) } : null,
  };
}

// ── Lectura ────────────────────────────────────────────────────────────────────
const SQL_ENVIOS = `
  SELECT
    e.id, e.fecha, e.courier, e.tipo_envio, e.pais_destino, e.cliente_id, e.numero_guia,
    c.nombre AS cliente_nombre, c.nombre_nova AS cliente_nombre_nova,
    e.cantidad_bultos, e.peso_real, e.peso_volumetrico, e.peso_facturable, e.peso_facturado,
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

// HISTÓRICOS (16/10/2026): los envíos de las planillas de antes del sistema
// (envios_historicos, cargados con scripts/importar-historico.js) entran a la analítica con
// la misma forma que un envío sin factura cruzada: venta = total_cobrado, compra = desglose
// estimado, profit derivado. id negativo para que no choque con un envío real; liquidado = 1
// (en el mundo viejo ya se cobraron) y sin fecha de liquidación (no entran en "días hasta
// liquidar"). "Plata en la calle" NO los mira: es lo que hay que resolver hoy.
const SQL_HISTORICOS = `
  SELECT
    -h.id AS id, h.fecha, h.courier, h.tipo_envio, h.pais_destino, h.cliente_id, h.numero_guia,
    c.nombre AS cliente_nombre, c.nombre_nova AS cliente_nombre_nova,
    h.cantidad_bultos, h.peso_real, h.peso_volumetrico, h.peso_facturable, NULL AS peso_facturado,
    h.total_cobrado AS total,
    h.flete, h.descuento, h.seguro, h.fuel, h.derechos, h.adicionales, h.otros,
    NULL AS profit, NULL AS porcentaje,
    NULL AS estado_revision, NULL AS costo_facturado, NULL AS fecha_facturado,
    COALESCE(e2.liquidado, 1) AS liquidado, e2.fecha_liquidacion AS fecha_liquidacion, h.importado_at AS created_at,
    NULL AS utilidad_liq, NULL AS venta_liq, h.cargos_post AS cargos_post, 0 AS cargos_ddp,
    1 AS historico
  FROM envios_historicos h
  JOIN clientes c ON c.id = h.cliente_id
  LEFT JOIN envios e2 ON e2.id = (SELECT MIN(x.id) FROM envios x WHERE x.no_volo = 0 AND UPPER(REPLACE(x.numero_guia, ' ', '')) = h.numero_guia)
  WHERE h.fecha >= ? AND h.fecha < ?`;

// Un envío del sistema cuya guía está en la planilla: para la analítica manda la planilla
// (19/10/2026, Felipe: las salidas son la biblia y el Dashboard tiene que dar igual que los
// resúmenes de la oficina). Solo acá: en Salidas y en "plata en la calle" el envío del sistema
// sigue siendo el que es. El histórico hereda liquidado/fecha_liquidacion del envío del sistema
// (SQL_HISTORICOS), así "sin liquidar" sigue diciendo la verdad.
const SQL_SIN_REEMPLAZO = ` AND NOT (e.numero_guia IS NOT NULL
  AND EXISTS (SELECT 1 FROM envios_historicos h2 WHERE h2.numero_guia = UPPER(REPLACE(e.numero_guia, ' ', ''))))`;

async function leerEnvios(db, desde, hasta, filtros) {
  let sql = SQL_ENVIOS + SQL_SIN_REEMPLAZO;
  let sqlH = SQL_HISTORICOS;
  const params = [desde, hasta];
  if (filtros.courier) { sql += ' AND e.courier = ?'; sqlH += ' AND h.courier = ?'; params.push(filtros.courier); }
  if (filtros.tipo) { sql += ' AND e.tipo_envio = ?'; sqlH += ' AND h.tipo_envio = ?'; params.push(filtros.tipo); }
  const [propios, historicos] = await Promise.all([db.prepare(sql).all(...params), db.prepare(sqlH).all(...params)]);
  return historicos.length ? propios.concat(historicos) : propios;
}

// ── Agregación ─────────────────────────────────────────────────────────────────
// VENTA y COMPRA del Dashboard van SIN los cargos posteriores (19/10/2026, Felipe: tiene que
// dar igual que el resumen de la oficina, que suma la columna de venta y la de compra de la
// planilla). Los cargos (manejo, sobrepeso, impuestos DDP…) se cobran al cliente y se pagan
// al courier por el mismo monto: el profit no cambia, y se informan aparte (cargos_post).
// Salidas sigue mostrando la Venta Total con cargos (utils/profit.js no cambia).
function ventaDe(e) { return r2(ventaEnvio(e) - cargosPost(e)); }
// La venta COMPLETA, con cargos: es lo que hay que cobrar (sin liquidar, plata en la calle).
function ventaConCargos(e) { return ventaEnvio(e); }

// Profit "oficial" de un envío (misma precedencia que el dashboard viejo).
// La misma de Dashboard, Comisiones y el perfil del cliente (utils/profit.js).
function profitOficial(e) {
  return Number(utilidadEnvio(e)) || 0;
}
// Compra "oficial": la real aprobada si existe, si no la estimada; sin los cargos posteriores
// (compraEnvio los trae adentro en las dos ramas: en la estimada vía costoEstimado y en la real
// porque la factura del courier los incluye y los DDP se suman aparte).
function compraOficial(e) { return r2(compraEnvio(e) - cargosPost(e)); }

function acumulador() { return { envios: 0, bultos: 0, kg_fact: 0, kg_real: 0, venta: 0, compra: 0, profit: 0, cargos: 0, sin_venta_n: 0, sin_venta_compra: 0 }; }
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
  acc.cargos += cargosPost(e);
  // Un histórico (planilla) sin venta es un envío sin cargo de verdad (cortesía, reenvío):
  // su compra y su profit negativo cuentan, como en la planilla y en el resumen de la
  // oficina. "Sin precio afuera" es solo para envíos del sistema cargados sin cotizar todavía.
  if (venta > 0 || e.historico) {
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
    cargos_post: r2(acc.cargos),
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
  // Un rango a mano que termina en el futuro (ej. 1 al 31 del mes en curso) también se
  // corta en hoy y se compara a la misma altura: si no, el mes a medias se comparaba contra
  // el anterior entero (todo en rojo) y desaparecía la proyección (Marcelo, 15/10).
  // Un rango ya cerrado no se toca: compararMismaAltura devuelve null.
  const mismaAltura = compararMismaAltura(desde, hastaPeriodo, comp.modo, hoy);
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
    // 10 meses atrás: los 3 últimos son la base de la mezcla, y para medir la precisión
    // propia (6+ meses evaluados, cada uno con sus 3 anteriores) hacen falta 9.
    const hist = await leerEnvios(db, primerDia(addMonths(mesHoy, -10)), primerDia(mesHoy), filtros);
    const historia = [];
    for (let i = 10; i >= 1; i--) {
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
    usd: r2(sinLiquidar.reduce((s, e) => s + ventaConCargos(e), 0)),
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
    venta: serie(porMes, meses, 'venta'), profit: serie(porMes, meses, 'profit'), compra: serie(porMes, meses, 'compra'), cargos: serie(porMes, meses, 'cargos'),
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
    sin_liquidar: { n: sinLiqTodos.length, usd: r2(sinLiqTodos.reduce((s, e) => s + ventaConCargos(e), 0)) },
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
  // Cliente nuevo = su PRIMER envío (que voló) cae en el período. Antes se miraba la fecha
  // de alta de la ficha, y la carga masiva de tarifarios del 28/09 creó ~100 fichas de
  // golpe: septiembre decía "102 clientes nuevos" (14/10).
  // Los históricos cuentan: si no, cuando se cargan las planillas todos los clientes de
  // siempre parecen nuevos en el mes en que el sistema arrancó.
  const SQL_NUEVOS = `SELECT COUNT(*) AS n FROM (
      SELECT cliente_id, MIN(fecha) AS primera FROM (
        SELECT cliente_id, fecha FROM envios WHERE no_volo = 0
        UNION ALL SELECT cliente_id, fecha FROM envios_historicos
      ) GROUP BY cliente_id
    ) WHERE primera >= ? AND primera < ?`;
  const nuevos = await db.prepare(SQL_NUEVOS).get(desde, hasta);
  const nuevosAnt = await db.prepare(SQL_NUEVOS).get(comp.desde, comp.hasta);
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

// ── El detalle de un KPI (15/10/2026, pedido de Felipe) ────────────────────────
// Tocar una tarjeta del Dashboard tiene que mostrar DE QUÉ está hecho ese número: la lista
// de envíos que lo componen, con el mismo período y los mismos filtros, más cómo se reparte
// por courier y por cliente. Mismas funciones que los KPIs (sumar / cerrar), así el detalle
// no puede decir otra cosa que la tarjeta.
const KPIS_DETALLE = ['envios', 'kg_fact', 'compra', 'venta', 'profit', 'sin_liquidar', 'sin_venta'];
const TOPE_FILAS = 1500;
async function detalle(q = {}) {
  const kpi = KPIS_DETALLE.includes(q.kpi) ? q.kpi : 'envios';
  const db = getDb();
  const hoy = hoyLocal();
  const { desde, hasta: hastaPeriodo, etiqueta } = resolverPeriodo(q);
  // Período en curso: hasta hoy, como los KPIs (misma altura).
  const corte = compararMismaAltura(desde, hastaPeriodo, 'previo', hoy);
  const hasta = corte ? corte.hasta_periodo : hastaPeriodo;
  const filtros = { courier: q.courier || '', tipo: q.tipo || '' };
  const todos = await leerEnvios(db, desde, hasta, filtros);
  const conVenta = (e) => ventaDe(e) > 0;
  const envios = todos.filter((e) => {
    if (kpi === 'sin_liquidar') return !e.liquidado;
    if (kpi === 'sin_venta') return !conVenta(e);
    if (kpi === 'compra' || kpi === 'venta' || kpi === 'profit') return conVenta(e);
    return true;
  });
  // Cada tarjeta muestra SU número (15/10, pedido de Felipe: tres botones no pueden llevar a
  // la misma tabla): la fila lleva todo lo que cada detalle necesita y el orden de fábrica
  // es el del KPI (los kilos del más pesado al más liviano, la compra de mayor a menor…).
  const fila = (e) => {
    const venta = ventaDe(e); const compra = compraOficial(e); const profit = venta > 0 ? profitOficial(e) : null;
    return {
      id: e.id, fecha: e.fecha, guia: e.numero_guia, cliente: e.cliente_nombre, cliente_id: e.cliente_id,
      courier: e.courier, tipo: e.tipo_envio, destino: normalizarPais(e.pais_destino).nombre, bultos: Number(e.cantidad_bultos) || 1,
      kg_fact: r1(Number(e.peso_facturable) || 0), kg_real: r1(Number(e.peso_real) || 0), kg_vol: r1(Number(e.peso_volumetrico) || 0),
      total: r2(Number(e.total) || 0), cargos_post: r2(cargosPost(e)), venta: r2(venta), venta_total: r2(ventaConCargos(e)),
      compra: r2(compra), compra_origen: e.costo_facturado != null ? 'real' : 'estimado',
      profit: profit == null ? null : r2(profit), margen_pct: profit != null && compra > 0 ? r1((profit / compra) * 100) : null,
      liquidado: !!e.liquidado, dias: diasEntre(e.fecha, hoy),
      historico: !!e.historico,
    };
  };
  const porCourier = {};
  for (const c of ['UPS', 'DHL']) porCourier[c] = cerrar(envios.filter((e) => e.courier === c).reduce(sumar, acumulador()));
  const porTipo = {};
  for (const t of ['exportacion', 'importacion']) porTipo[t] = cerrar(envios.filter((e) => e.tipo_envio === t).reduce(sumar, acumulador()));
  const porCliente = new Map();
  for (const e of envios) {
    const k = e.cliente_id;
    if (!porCliente.has(k)) porCliente.set(k, { cliente_id: k, cliente: e.cliente_nombre, acc: acumulador() });
    sumar(porCliente.get(k).acc, e);
  }
  const metrica = kpi === 'sin_liquidar' ? 'venta' : kpi === 'sin_venta' ? 'envios' : kpi;
  const clientes = [...porCliente.values()].map((c) => ({ cliente_id: c.cliente_id, cliente: c.cliente, ...cerrar(c.acc) }))
    .sort((a, b) => (b[metrica] || 0) - (a[metrica] || 0));
  const totales = cerrar(envios.reduce(sumar, acumulador()));
  if (kpi === 'sin_venta') { totales.compra = totales.sin_venta.compra; }
  const compraReal = envios.filter((e) => e.costo_facturado != null);
  totales.compra_real = { n: compraReal.length, usd: r2(compraReal.reduce((s, e) => s + compraOficial(e), 0)) };
  totales.cargos_post = r2(envios.reduce((s, e) => s + (Number(e.cargos_post) || 0), 0));
  const filas = envios.map(fila);
  const porFecha = (a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : b.id - a.id);
  const ORDEN = { kg_fact: 'kg_fact', compra: 'compra', venta: 'venta', profit: 'profit' };
  const orden = ORDEN[kpi] ? (a, b) => ((b[ORDEN[kpi]] || 0) - (a[ORDEN[kpi]] || 0)) || porFecha(a, b) : porFecha;
  filas.sort(orden);
  return {
    kpi, periodo: { desde, hasta: sumarDias(hasta, -1), etiqueta }, filtros,
    totales, por_courier: porCourier, por_tipo: porTipo, por_cliente: clientes.slice(0, 10), clientes_n: clientes.length,
    filas: filas.slice(0, TOPE_FILAS),
    filas_total: envios.length, truncado: envios.length > TOPE_FILAS,
  };
}

module.exports = { analitica, detalle, resolverPeriodo, resolverComparacion, compararMismaAltura, diasHabiles, proyectarMes, precisionHistorica, acumuladoPorHabil, normalizarPais, mesesEntre };
