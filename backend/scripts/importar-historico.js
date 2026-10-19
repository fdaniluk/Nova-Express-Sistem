#!/usr/bin/env node
/**
 * importar-historico.js — carga las planillas SALIDAS (una hoja por mes, dic-2023 en
 * adelante) en envios_historicos, para que el Dashboard tenga más que los meses del sistema.
 *
 *   cd backend && node scripts/importar-historico.js --archivo=/ruta/SALIDAS.xlsx [--desde=2024-10] [--grabar]
 *
 * Sin --grabar solo muestra la vista previa: cuántos envíos por mes, a qué cliente del
 * sistema va cada nombre de la planilla, cuáles quedan afuera y por qué. Con --grabar
 * escribe, en una transacción. Se puede correr las veces que haga falta: borra lo que
 * había en envios_historicos y lo vuelve a cargar (la planilla es la verdad).
 *
 * Reglas (pedido de Felipe, 16/10/2026):
 *   · Con --resto, los envíos cuyo cliente no está en el sistema van a un cliente comodín
 *     "Clientes históricos (sin ficha)" (se crea si no existe): así los totales por mes quedan
 *     completos y comparables con los del sistema (16/10: sin eso, los meses viejos quedaban
 *     ~8 % abajo y el crecimiento se inflaba). Sin --resto quedan afuera.
 *   · Solo clientes que YA existen en el sistema. El nombre de la planilla (apodos, con
 *     errores de tipeo) se cruza con clientes.nombre / nombre_nova, y lo que no cierra solo
 *     se resuelve en scripts/historico-alias.json ("nombre de la planilla": id de cliente,
 *     o null para dejarlo afuera a propósito). Lo que no está en ningún lado queda afuera y
 *     se lista en la vista previa.
 *   · Una guía que también está en `envios` (el sistema) se importa igual: en el Dashboard manda
 *     la planilla; el resto del sistema no cambia.
 *   · NO VOLÓ queda afuera. Filas sin venta y sin compra quedan afuera.
 *   · Los cargos posteriores (sección de arriba de cada hoja: "ddp 25,76", "residential 6")
 *     se suman al envío de esa guía como cargos_post (al costo, sin profit).
 *   · Los bultos "1 de 3 / 2 de 3 / 3 de 3" son un envío con 3 bultos: kg real y vol se
 *     suman; el facturable es la columna FACT de la primera fila si está, si no la suma.
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const ROOT = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { initDb, getDb } = require('../src/db');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const ARCHIVO = args.archivo ? path.resolve(process.cwd(), String(args.archivo)) : null;
const DESDE = args.desde ? `${args.desde}-01` : '2023-12-01';
const HASTA_ARG = args.hasta ? String(args.hasta) : null; // YYYY-MM inclusive
const GRABAR = !!args.grabar;
const RESTO = !!args.resto;
const NOMBRE_RESTO = 'Clientes históricos (sin ficha)';
const ALIAS_PATH = path.join(__dirname, 'historico-alias.json');
if (!ARCHIVO || !fs.existsSync(ARCHIVO)) { console.error('Falta --archivo=/ruta/SALIDAS.xlsx'); process.exit(1); }

const COURIERS = { UPS: 'UPS', DHL: 'DHL', FX: 'FEDEX', FEDEX: 'FEDEX', FEX: 'FEDEX' };
const TIPOS_COBRO = new Set(['D', 'S', 'Q', 'CC', 'M', 'ST']);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') { const n = Number(v.trim().replace(',', '.')); return Number.isFinite(n) ? n : null; }
  return null;
};
const txt = (v) => (v == null ? '' : String(v).trim());
const esFecha = (v) => v instanceof Date && !Number.isNaN(v.getTime());
// La fecha de la celda viene como Date en la zona del proceso (xlsx la arma así): se toma el
// día local tal cual, sin pasar por UTC.
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(sin cargo|s\/c|srl|s\.r\.l\.?|sa|s\.a\.?)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const guiaNorm = (g) => txt(g).toUpperCase().replace(/\s+/g, '');

// ── Leer la planilla ───────────────────────────────────────────────────────────
// La planilla es la verdad (Felipe, 19/10/2026): lo que suma la oficina por hoja tiene que
// dar igual en el Dashboard. Por eso:
//   · el MES del envío es el de la HOJA (la fila con fecha 2025 en la hoja MAYO 2026 es un
//     año mal tipeado; la de marzo en la hoja ABRIL la oficina la cuenta en abril);
//   · los kilos facturables son la columna de la planilla tal cual (si está vacía, se
//     calculan por bulto);
//   · NO VOLÓ se busca en cualquier celda de la fila;
//   · los bultos de una guía se juntan aunque "2 de 2" venga antes que "1 de 2" (pasaba y
//     el envío quedaba sin venta).
const MESES = { ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6, JULIO: 7, AGOSTO: 8, SEPTIEMBRE: 9, SETIEMBRE: 9, OCTUBRE: 10, NOVIEMBRE: 11, DICIEMBRE: 12 };
function mesDeHoja(nombre) {
  const m = nombre.trim().toUpperCase().match(/^([A-ZÑ]+)\s+(\d{4})$/);
  if (!m || !MESES[m[1]]) return null;
  return `${m[2]}-${String(MESES[m[1]]).padStart(2, '0')}`;
}
const ultimoDia = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

function leerPlanilla(archivo) {
  const wb = XLSX.readFile(archivo, { cellDates: true });
  const envios = new Map(); // guia|mes → envío
  const cargos = [];        // { guia, monto, detalle }
  let duplicados = 0, sinDatos = 0;
  for (const nombre of wb.SheetNames) {
    const mesHoja = mesDeHoja(nombre);
    if (!mesHoja) continue;
    const filas = XLSX.utils.sheet_to_json(wb.Sheets[nombre], { header: 1, raw: true, defval: null });
    const conFecha = filas.filter((r) => esFecha(r[2]));
    const conCourier = conFecha.filter((r) => COURIERS[txt(r[1]).toUpperCase()]);
    if (!conCourier.length) continue;
    // Layout nuevo (col E = tipo de cobro) o viejo (sin esa columna): corre todo una columna.
    const conTipo = conCourier.filter((r) => TIPOS_COBRO.has(txt(r[4]).toUpperCase())).length;
    const o = conTipo > conCourier.length / 2 ? 1 : 0;
    const I = { cliente: 4 + o, pais: 5 + o, bulto: 6 + o, real: 8 + o, vol: 12 + o, fact: 13 + o };
    // FLETE por cabecera; la venta está dos columnas a la izquierda.
    let flete = null;
    for (const r of filas) { const j = r.findIndex((c) => typeof c === 'string' && c.trim().toUpperCase() === 'FLETE'); if (j >= 0) { flete = j; break; } }
    const I_VENTA = flete != null ? flete - 2 : 19;
    const I_COSTO = flete != null ? flete : 21;
    for (const r of conFecha) {
      const guia = guiaNorm(r[3]);
      const real = num(r[I.real]); const vol = num(r[I.vol]); const fact = num(r[I.fact]);
      const venta = num(r[I_VENTA]);
      const esEnvio = COURIERS[txt(r[1]).toUpperCase()] && (real != null || vol != null || fact != null || venta != null);
      if (!esEnvio) {
        // Sección de arriba de la hoja: cargos posteriores de guías ya despachadas ("ddp 25,76",
        // "residential 6"), con o sin courier y sin kilos. El monto es el número final del texto.
        const detalle = [txt(r[6]), txt(r[5]), txt(r[7])].find((t) => /\d\s*$/.test(t) && !/^\d+\s*de\s*\d+$/i.test(t)) || '';
        const m = detalle.match(/(-?\d+(?:[.,]\d+)?)\s*$/);
        if (guia && m) cargos.push({ guia, monto: num(m[1]) || 0, detalle });
        else sinDatos++;
        continue;
      }
      // Fecha: el mes de la hoja con el día de la fila.
      const d = iso(r[2]);
      const dia = Math.min(Number(d.slice(8, 10)), ultimoDia(mesHoja));
      const fecha = `${mesHoja}-${String(dia).padStart(2, '0')}`;
      const bulto = txt(r[I.bulto]).toLowerCase();
      const mb = bulto.match(/(\d+)\s*de\s*(\d+)/);
      const cabecera = !mb || Number(mb[1]) === 1;
      const noVolo = r.slice(0, 36).some((c) => typeof c === 'string' && /NO VOL[OÓ]/i.test(c));
      const clave = `${guia || 'SINGUIA-' + fecha + '-' + txt(r[I.cliente])}|${mesHoja}`;
      let e = envios.get(clave);
      if (e && cabecera && e.tiene_cabecera) { duplicados++; continue; }
      if (!e) {
        e = { guia, fecha, mes: mesHoja, courier: COURIERS[txt(r[1]).toUpperCase()], hoja: nombre.trim(), tiene_cabecera: false,
          tipo_cobro: null, cliente_excel: '', pais: '', fact_col: null, fact_sum: 0, real: 0, vol: 0, bultos: 0, venta: 0,
          flete: null, descuento: null, seguro: null, fuel: null, derechos: null, adicionales: null, otros: null, no_volo: false, cargos_post: 0 };
        envios.set(clave, e);
      }
      if (cabecera || !e.cliente_excel) {
        const costo = (j) => num(r[I_COSTO + j]);
        Object.assign(e, {
          fecha, tiene_cabecera: e.tiene_cabecera || cabecera,
          tipo_cobro: o ? txt(r[4]).toUpperCase() || null : null,
          cliente_excel: txt(r[I.cliente]).toLowerCase().replace(/\s+/g, ' ') || e.cliente_excel,
          pais: txt(r[I.pais]).toLowerCase() || e.pais,
          fact_col: fact != null ? fact : e.fact_col, venta: venta != null ? venta : e.venta,
          flete: costo(0), descuento: costo(1), seguro: costo(2), fuel: costo(3), derechos: costo(4), adicionales: costo(5), otros: costo(6),
        });
      }
      if (noVolo) e.no_volo = true;
      e.real += real || 0; e.vol += vol || 0;
      e.fact_sum += Math.ceil(Math.max(real || 0, vol || 0) * 2) / 2;
      e.bultos += 1;
    }
  }
  const lista = [...envios.values()].map((e) => {
    delete e._dup;
    delete e.tiene_cabecera;
    e.fact = e.fact_col != null && e.fact_col > 0 ? e.fact_col : e.fact_sum;
    return e;
  });
  // Cargos posteriores → al envío de esa guía (el más reciente si la guía se repite).
  const porGuia = new Map();
  for (const e of lista) if (e.guia) { const p = porGuia.get(e.guia); if (!p || p.fecha < e.fecha) porGuia.set(e.guia, e); }
  let cargosSinEnvio = 0;
  for (const c of cargos) { const e = porGuia.get(c.guia); if (e) e.cargos_post = r2(e.cargos_post + c.monto); else cargosSinEnvio++; }
  return { lista, duplicados, sinDatos, cargos: cargos.length, cargosSinEnvio };
}

// ── Cruce de clientes ──────────────────────────────────────────────────────────
function armarCruce(clientes, alias) {
  const porNombre = new Map();
  for (const c of clientes) for (const k of [normalizar(c.nombre), normalizar(c.nombre_nova)]) if (k && !porNombre.has(k)) porNombre.set(k, c.id);
  const ids = new Set(clientes.map((c) => c.id));
  return (nombreExcel) => {
    if (Object.prototype.hasOwnProperty.call(alias, nombreExcel)) {
      const v = alias[nombreExcel];
      return v == null ? { id: null, como: 'alias: afuera' } : ids.has(v) ? { id: v, como: 'alias' } : { id: null, como: `alias apunta a cliente inexistente ${v}` };
    }
    const k = normalizar(nombreExcel);
    if (!k) return { id: null, como: 'sin nombre' };
    if (porNombre.has(k)) return { id: porNombre.get(k), como: 'nombre' };
    const sinExportalo = k.replace(/^exportalo\s+/, '');
    if (sinExportalo !== k && porNombre.has(sinExportalo)) return { id: porNombre.get(sinExportalo), como: 'nombre' };
    // "cueros priority", "cavalier impo prealerta", "fernando gomez exporta simple": el
    // cliente más lo que se le agregó en la planilla.
    const pelado = sinExportalo.replace(/\b(priority|prealerta|pre alerta|exporta simple|express|saver|economy)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (pelado !== sinExportalo && porNombre.has(pelado)) return { id: porNombre.get(pelado), como: 'nombre' };
    // Único cliente que contiene el nombre (o al revés), con 4+ letras para no acertar de casualidad.
    if (pelado.length >= 4) {
      const cands = new Set();
      for (const [k, id] of porNombre) if (k.includes(pelado) || (k.length >= 4 && pelado.includes(k))) cands.add(id);
      if (cands.size === 1) return { id: [...cands][0], como: 'parecido' };
    }
    return { id: null, como: 'sin match' };
  };
}

(async () => {
  await initDb();
  const db = getDb();
  const alias = fs.existsSync(ALIAS_PATH) ? JSON.parse(fs.readFileSync(ALIAS_PATH, 'utf8')) : {};
  const clientes = await db.prepare('SELECT id, nombre, nombre_nova FROM clientes').all();
  const nombreDe = new Map(clientes.map((c) => [c.id, c.nombre]));
  const cruzar = armarCruce(clientes, alias);
  // Guías que también están en el sistema: se importan igual, y para el Dashboard manda la
  // planilla (19/10/2026, Felipe: "las salidas son la biblia"); el envío del sistema con esa
  // guía deja de contarse en la analítica (SQL_SIN_REEMPLAZO en analitica.service.js). Salidas,
  // Liquidaciones y Cobranzas no cambian. Acá solo se informa cuántas son.
  const enSistema = new Set((await db.prepare("SELECT numero_guia FROM envios WHERE numero_guia IS NOT NULL AND numero_guia <> '' AND no_volo = 0").all()).map((r) => guiaNorm(r.numero_guia)));
  // Hasta dónde se importa: el mes pasado (el mes en curso es del sistema; en la planilla
  // todavía no tiene los costos), salvo que se pida --hasta=YYYY-MM.
  const mesPasado = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; })();
  const hastaExcl = (() => { const [y, m] = (HASTA_ARG || mesPasado).split('-').map(Number); return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`; })();
  const hoy = new Date().toISOString().slice(0, 10);
  const { lista, duplicados, sinDatos, cargos, cargosSinEnvio } = leerPlanilla(ARCHIVO);
  const afuera = { fecha: 0, no_volo: 0, vacio: 0, reemplaza: 0, sin_cliente: new Map() };
  let restoId = (clientes.find((c) => c.nombre === NOMBRE_RESTO) || {}).id || null;
  if (RESTO && !restoId) {
    if (GRABAR) {
      const r = await db.prepare("INSERT INTO clientes (nombre, tipo_cobro) VALUES (?, 'D')").run(NOMBRE_RESTO);
      restoId = r.lastInsertRowid; nombreDe.set(restoId, NOMBRE_RESTO);
    } else { restoId = -1; nombreDe.set(-1, `${NOMBRE_RESTO} (se crea al grabar)`); }
  }
  const aGrabar = [];
  const porCliente = new Map();
  for (const e of lista.sort((a, b) => (a.fecha < b.fecha ? -1 : 1))) {
    if (e.fecha < DESDE || e.fecha >= hastaExcl) { afuera.fecha++; continue; }
    if (e.no_volo) { afuera.no_volo++; continue; }
    const compra = (e.flete || 0) - (e.descuento || 0) + (e.seguro || 0) + (e.fuel || 0) + (e.derechos || 0) + (e.adicionales || 0) + (e.otros || 0);
    if (!e.venta && !compra && !e.fact) { afuera.vacio++; continue; }
    if (e.guia && enSistema.has(e.guia)) afuera.reemplaza++;
    let { id, como } = cruzar(e.cliente_excel);
    if (!id) {
      const s = afuera.sin_cliente.get(e.cliente_excel) || { n: 0, venta: 0, como };
      s.n++; s.venta = r2(s.venta + e.venta); afuera.sin_cliente.set(e.cliente_excel, s);
      if (!RESTO) continue;
      id = restoId;
    }
    const pc = porCliente.get(id) || { n: 0, venta: 0, nombres: new Set() };
    pc.n++; pc.venta = r2(pc.venta + e.venta); pc.nombres.add(e.cliente_excel); porCliente.set(id, pc);
    aGrabar.push({ ...e, cliente_id: id, compra, tipo_envio: /\bimpo\b/.test(e.cliente_excel) ? 'importacion' : 'exportacion' });
  }

  // ── Vista previa ──
  console.log(`\nPlanilla: ${ARCHIVO}`);
  console.log(`Envíos leídos: ${lista.length} (bultos agrupados; ${duplicados} filas repetidas; ${cargos} cargos posteriores, ${cargosSinEnvio} sin envío; ${sinDatos} filas sin datos)`);
  console.log(`Período: desde ${DESDE} hasta ${hastaExcl} (exclusivo)${HASTA_ARG ? '' : ' — el mes en curso es del sistema'}`);
  console.log(`Afuera: ${afuera.fecha} fuera del período · ${afuera.no_volo} NO VOLÓ · ${afuera.vacio} sin venta ni compra`);
  console.log(`También están en el sistema (misma guía): ${afuera.reemplaza} — en el Dashboard manda la planilla`);
  const sinCli = [...afuera.sin_cliente.entries()].sort((a, b) => b[1].n - a[1].n);
  const sinCliN = sinCli.reduce((s, [, v]) => s + v.n, 0);
  console.log(`Sin cliente en el sistema: ${sinCliN} envíos en ${sinCli.length} nombres (${RESTO ? `van al cliente "${NOMBRE_RESTO}"` : 'quedan afuera; con --resto van a un cliente comodín'}):`);
  for (const [n, v] of sinCli.slice(0, 40)) console.log(`   ${String(v.n).padStart(4)}  ${n.padEnd(40)} venta ${v.venta}${v.como !== 'sin match' ? '  (' + v.como + ')' : ''}`);
  if (sinCli.length > 40) console.log(`   … y ${sinCli.length - 40} nombres más con pocos envíos`);
  console.log(`\nA grabar: ${aGrabar.length} envíos de ${porCliente.size} clientes`);
  const porMes = new Map();
  for (const e of aGrabar) { const m = e.fecha.slice(0, 7); const a = porMes.get(m) || { n: 0, kg: 0, venta: 0, compra: 0 }; a.n++; a.kg += e.fact; a.venta += e.venta; a.compra += e.compra; porMes.set(m, a); }
  console.log('   mes       envíos   kg fact     venta    compra   margen');
  for (const [m, a] of [...porMes.entries()].sort()) console.log(`   ${m}   ${String(a.n).padStart(5)}  ${String(Math.round(a.kg)).padStart(8)}  ${String(Math.round(a.venta)).padStart(8)}  ${String(Math.round(a.compra)).padStart(8)}  ${a.compra ? Math.round(((a.venta - a.compra) / a.compra) * 100) + '%' : '-'}`);
  console.log('\nClientes (los 25 con más envíos):');
  for (const [id, v] of [...porCliente.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 25)) console.log(`   ${String(v.n).padStart(4)}  ${String(nombreDe.get(id)).padEnd(34)} ← ${[...v.nombres].join(', ')}`);

  if (!GRABAR) { console.log('\n(vista previa; para grabar agregá --grabar)'); process.exit(0); }
  await db.transaction(async () => {
    await db.prepare('DELETE FROM envios_historicos').run();
    const ins = db.prepare(`INSERT OR IGNORE INTO envios_historicos
      (cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, tipo_cobro, cantidad_bultos, peso_real, peso_volumetrico, peso_facturable,
       total_cobrado, flete, descuento, seguro, fuel, derechos, adicionales, otros, cargos_post, cliente_excel, hoja)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const e of aGrabar) {
      await ins.run(e.cliente_id, e.fecha, e.courier, e.tipo_envio, e.guia || null, e.pais || null, e.tipo_cobro, e.bultos || 1,
        r2(e.real), r2(e.vol), r2(e.fact), r2(e.venta), e.flete, e.descuento, e.seguro, e.fuel, e.derechos, e.adicionales, e.otros, r2(e.cargos_post), e.cliente_excel, e.hoja);
    }
  });
  const n = await db.prepare('SELECT COUNT(*) AS n FROM envios_historicos').get();
  console.log(`\nGrabados ${n.n} envíos históricos.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
