/**
 * cierre.service.js — el Excel de las salidas de un período, para archivar fuera del sistema.
 *
 * POR QUÉ EXISTE
 * Es la última capa de respaldo, y la más difícil de matar. Las copias a OneDrive sirven si
 * se rompe algo del sistema; este archivo sirve incluso si se pierden el sistema, el VPS,
 * OneDrive y GitHub todos juntos, porque es una planilla que abre cualquiera en cualquier
 * computadora sin depender de nada nuestro.
 *
 * La oficina ya hace algo parecido: todos los viernes mandan la hoja de salidas de la semana
 * por WhatsApp. Esto formaliza esa costumbre y le agrega lo que le falta: que el archivo diga
 * qué período cubre, que salga siempre completo (y no "lo que quedó filtrado en pantalla"), y
 * que quede asentado que se hizo.
 *
 * DOS DECISIONES QUE IMPORTAN
 *
 *  1. El Excel se arma ACÁ, en el servidor. El botón que ya existía en Salidas lo armaba en
 *     el navegador con una librería que se baja de un CDN en cada uso: sin internet, o con
 *     ese dominio bloqueado, el botón no hacía nada. Para un respaldo, quedarse sin él
 *     justo el día que hay problemas de red es exactamente el peor momento.
 *
 *  2. Las filas salen de listarSalidas(), la MISMA función que dibuja la pantalla. No hay
 *     una consulta paralela para el Excel: si algún día cambia una columna, cambia en los
 *     dos lados o en ninguno.
 */

const ExcelJS = require('exceljs');
const { hoyLocal } = require('../utils/fecha');

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Las mismas columnas, en el mismo orden y con los mismos títulos que venía sacando el
// botón de Salidas. La oficina ya conoce esta planilla; no es momento de estrenar formato.
// Las columnas, en el mismo orden y con los mismos títulos que ve la oficina en pantalla.
//
// El 5º dato es el ÁMBITO, y es lo que hace que un envío de tres bultos salga bien:
//   'bulto' → la celda tiene un valor PROPIO en cada renglón (medidas, peso, guía)
//   'envio' → la celda va SOLO en el primer renglón del envío y en blanco en los demás
// Es exactamente lo que hace la pantalla (el helper `env()` de salidas.js), y no es
// cosmético: si los importes se repitieran en cada bulto, la fila de TOTALES contaría el
// mismo flete tres veces y la planilla mentiría.
const COLUMNAS = [
  ['# Salida', '_num_sal', 'entero', 10, 'envio'],
  ['Courier', 'courier', 'texto', 10, 'envio'],
  ['Fecha', 'fecha', 'fecha', 12, 'envio'],
  ['Guía', '_guia', 'texto', 20, 'bulto'],
  ['Cobro', 'tipo_cobro', 'texto', 10, 'envio'],
  ['Cliente', 'cliente_nombre', 'texto', 26, 'envio'],
  ['Destino', 'destino', 'texto', 20, 'envio'],
  ['Dest. original', 'destino_raw', 'texto', 18, 'envio'],
  ['Dirección', 'direccion', 'texto', 12, 'envio'],
  ['Bulto', '_bulto', 'texto', 8, 'bulto'],
  ['Tipo', 'tipo_paquete', 'texto', 8, 'envio'],
  ['Largo (cm)', '_largo', 'medida', 10, 'bulto'],
  ['Ancho (cm)', '_ancho', 'medida', 10, 'bulto'],
  ['Alto (cm)', '_alto', 'medida', 10, 'bulto'],
  ['Peso (kg)', '_peso', 'peso', 11, 'bulto'],
  ['Vol. (kg)', '_vol', 'peso', 11, 'bulto'],
  ['P. Fact (kg)', 'peso_facturable', 'peso', 12, 'envio'],
  ['FOB (USD)', 'valor_declarado', 'plata', 12, 'envio'],
  ['Asegurado', '_asegurado', 'texto', 11, 'envio'],
  ['Flete (USD)', 'flete', 'plata', 12, 'envio'],
  ['Dscto (USD)', 'descuento', 'plata', 12, 'envio'],
  ['Seguro (USD)', 'seguro', 'plata', 12, 'envio'],
  ['Fuel (USD)', 'fuel', 'plata', 12, 'envio'],
  ['Derechos (USD)', 'derechos', 'plata', 13, 'envio'],
  ['Adic. (USD)', 'adicionales', 'plata', 12, 'envio'],
  ['Otros (USD)', 'otros', 'plata', 12, 'envio'],
  ['Total (USD)', 'total', 'plata', 13, 'envio'],
  ['Compra Total (USD)', 'compra_total', 'plata', 15, 'envio'],
  ['Profit (USD)', 'profit', 'plata', 12, 'envio'],
  ['% Profit', 'porcentaje', 'peso', 10, 'envio'],
  ['Costo UPS (USD)', 'costo_facturado', 'plata', 14, 'envio'],
  ['Dif Costo %', '_dif_costo', 'peso', 12, 'envio'],
  ['Peso UPS (kg)', '_peso_ups', 'peso', 13, 'envio'],
  ['Dif Peso %', '_dif_peso', 'peso', 12, 'envio'],
  ['Revisión', '_revision', 'texto', 12, 'envio'],
  ['Estado', '_estado', 'texto', 16, 'envio'],
  ['Observaciones', 'observaciones', 'texto', 32, 'envio'],
];

// Las columnas que se suman abajo de todo. Un total al pie es lo que hace que la planilla
// sirva para controlar contra otra cosa sin tener que armar la fórmula a mano.
// Las columnas que se suman abajo de todo. `_peso` y `_vol` son de ámbito bulto: suman
// renglón por renglón y el total da el peso del envío, porque el peso del envío ES la suma
// de sus bultos (verificado sobre los 93 multibulto de producción, 28/08/2026). El resto
// son de ámbito envío: como solo tienen valor en el primer renglón, se suman una vez sola
// sin necesidad de contar nada aparte.
const SUMABLES = new Set(['_peso', '_vol', 'peso_facturable', 'valor_declarado', 'flete',
  'descuento', 'seguro', 'fuel', 'derechos', 'adicionales', 'otros', 'total',
  'compra_total', 'profit']);

const FMT_PLATA = '#,##0.00';
const FMT_PESO = '#,##0.00';
const FMT_MEDIDA = '#,##0';   // las medidas van en cm enteros, como en la pantalla
const FMT_ENTERO = '0';       // el # de salida: número pelado, para que Excel lo ordene bien
const FMT_FECHA = 'dd/mm/yyyy';

// ── Períodos ────────────────────────────────────────────────────────────────
// Nada de toISOString(): devuelve UTC y después de las 21:00 hora de Buenos Aires
// adelanta un día. Ver utils/fecha.js, que es donde está contada esa historia.

function ultimoDiaDelMes(anio, mes) {
  return new Date(anio, mes, 0).getDate(); // mes 1-12, día 0 del siguiente = último de este
}

/** 'YYYY-MM' → { tipo:'mes', desde, hasta, etiqueta } */
function rangoDelMes(mesStr) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(mesStr || '').trim());
  if (!m) return null;
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12) return null;
  const p = (n) => String(n).padStart(2, '0');
  return {
    tipo: 'mes',
    desde: `${anio}-${p(mes)}-01`,
    hasta: `${anio}-${p(mes)}-${p(ultimoDiaDelMes(anio, mes))}`,
    etiqueta: `${MESES[mes - 1]} de ${anio}`,
  };
}

/**
 * Semana de lunes a domingo que contiene la fecha de referencia.
 *
 * Si la semana todavía no terminó, el "hasta" se corta en hoy: el archivo tiene que decir
 * el período que REALMENTE cubre. Que en la oficina lo bajen un viernes no puede producir
 * un archivo que dice ir hasta el domingo.
 */
function rangoDeLaSemana(refStr) {
  const ref = refStr ? new Date(`${refStr}T12:00:00`) : new Date();
  if (Number.isNaN(ref.getTime())) return null;
  const dow = ref.getDay();                    // 0 = domingo
  const aLunes = dow === 0 ? -6 : 1 - dow;
  const lunes = new Date(ref);
  lunes.setDate(lunes.getDate() + aLunes);
  const domingo = new Date(lunes);
  domingo.setDate(domingo.getDate() + 6);
  const hoy = hoyLocal();
  const finReal = hoyLocal(domingo) > hoy ? hoy : hoyLocal(domingo);
  return {
    tipo: 'semana',
    desde: hoyLocal(lunes),
    hasta: finReal,
    etiqueta: `semana del ${fmtDia(hoyLocal(lunes))} al ${fmtDia(finReal)}`,
  };
}

/** Rango a mano, para cuando piden un período raro. */
function rangoLibre(desde, hasta) {
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
  if (!ok(desde) || !ok(hasta) || desde > hasta) return null;
  return { tipo: 'rango', desde, hasta, etiqueta: `${fmtDia(desde)} al ${fmtDia(hasta)}` };
}

function fmtDia(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '');
}

/**
 * Nombre del archivo. Tiene que decir el período SIN abrirlo: en una carpeta con dos años
 * de cierres, un archivo llamado "historial-envios-06-08-2026" no sirve para nada.
 *   mes    → Nova-salidas-2026-07-julio.xlsx
 *   semana → Nova-salidas-semana-2026-07-27_al_2026-08-02.xlsx
 */
function nombreArchivo(rango) {
  if (rango.tipo === 'mes') {
    const [anio, mes] = rango.desde.split('-');
    return `Nova-salidas-${anio}-${mes}-${MESES[Number(mes) - 1]}.xlsx`;
  }
  if (rango.tipo === 'semana') return `Nova-salidas-semana-${rango.desde}_al_${rango.hasta}.xlsx`;
  return `Nova-salidas-${rango.desde}_al_${rango.hasta}.xlsx`;
}

// ── El Excel ────────────────────────────────────────────────────────────────

function difPct(facturado, base) {
  if (facturado === null || facturado === undefined) return null;
  if (base === null || base === undefined || Number(base) === 0) return null;
  return Math.round((Number(facturado) - Number(base)) / Number(base) * 10000) / 100;
}

// Mismo texto que la columna Estado de la pantalla (estadoLabel en salidas.js).
function estadoLabel(e, hoy) {
  // NO VOLO gana sobre cualquier otro estado: es la leyenda que la oficina venia
  // escribiendo a mano en la planilla.
  if (e.no_volo) return 'NO VOLO';
  if (e.liquidado) return 'Liquidado';
  const f = new Date(e.fecha);
  const t = new Date(hoy);
  const dias = e.fecha ? Math.max(0, Math.round((t - f) / 86400000)) : 0;
  return `Pendiente · ${dias}d`;
}

// Estado de revisión contra la factura del courier. Mismo criterio que la columna
// Revisión de la pantalla: sin factura cruzada no hay nada que revisar.
const REVISION_LABEL = {
  revisado_ok: 'Aprobada',
  a_revisar: 'A revisar',
  reclamar: 'En reclamo',
  pendiente: 'Pendiente',
};

/**
 * El valor de una celda.
 *
 * @param {Object} e     el envío
 * @param {String} campo la clave de COLUMNAS
 * @param {String} hoy   fecha local (para la antigüedad del estado)
 * @param {Object} b     el bulto de ESTE renglón (nunca null: el envío de un solo bulto
 *                       trae uno sintético armado con sus propios campos)
 * @param {Number} nb    cuántos bultos tiene el envío (para el "1/3")
 * @param {Number} idx   posición del bulto (0-based), por si no trae numero_bulto
 */
function valorDe(e, campo, hoy, b = {}, nb = 1, idx = 0) {
  // Los campos del bulto caen a los del envío cuando el bulto no los tiene: es el mismo
  // fallback que hace la pantalla para el envío de un solo bulto.
  const delBulto = (campoBulto, campoEnvio) => {
    const v = b[campoBulto];
    return v !== undefined && v !== null ? v : (e[campoEnvio] ?? null);
  };

  switch (campo) {
    // El número que la oficina llama "el envío 27": correlativo del MES, no la columna
    // `numero_salida` de la base, que está vacía en 346 de 347 envíos (nadie la carga) y
    // era la que dejaba la planilla sin números.
    case '_num_sal': return e.num_sal_mes ?? e.num_sal ?? null;
    // La guía del bulto si la tiene PROPIA (los multibulto de UPS traen una por caja);
    // si la hereda del envío se escribe solo en el primer renglón. Repetir diez veces el
    // mismo número en un envío de diez cajas no agrega nada y ensucia la planilla que se
    // archiva — se vio al mirar el Excel de una semana real (28/08).
    case '_guia':
      if (b.numero_guia) return b.numero_guia;
      return idx === 0 ? (e.numero_guia || null) : null;
    case '_bulto': return `${b.numero_bulto ?? (idx + 1)}/${nb}`;
    case '_largo': return delBulto('largo', 'largo');
    case '_ancho': return delBulto('ancho', 'ancho');
    case '_alto': return delBulto('alto', 'alto');
    case '_peso': return delBulto('peso_real', 'peso');
    case '_vol': return delBulto('peso_volumetrico', 'peso_volumetrico');
    case '_asegurado': return e.asegurado ? 'Sí' : 'No';
    case '_estado': return estadoLabel(e, hoy);
    case '_revision':
      if (e.costo_facturado == null) return '';
      return REVISION_LABEL[e.estado_revision] || 'Pendiente';
    case '_dif_costo': return e.costo_facturado != null ? difPct(e.costo_facturado, e.compra_total) : null;
    case '_peso_ups': return e.costo_facturado != null ? (e.peso_facturado ?? null) : null;
    case '_dif_peso': return e.costo_facturado != null ? difPct(e.peso_facturado, e.peso_facturable) : null;
    default: {
      const v = e[campo];
      return v === undefined ? null : v;
    }
  }
}

/**
 * @param {Array} filas    lo que devuelve listarSalidas()
 * @param {Object} rango   { tipo, desde, hasta, etiqueta }
 * @param {String} usuario quién lo bajó (va impreso en la planilla)
 * @returns {Promise<Buffer>}
 */
async function construirExcel(filas, rango, usuario) {
  const hoy = hoyLocal();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Nova Express';
  const ws = wb.addWorksheet('Salidas', { views: [{ state: 'frozen', ySplit: 6 }] });

  ws.mergeCells(1, 1, 1, COLUMNAS.length);
  const titulo = ws.getCell(1, 1);
  titulo.value = 'Nova Express — Salidas del período';
  titulo.font = { name: 'Calibri', size: 16, bold: true };

  ws.getCell(2, 1).value = `Período: ${rango.etiqueta} (${fmtDia(rango.desde)} a ${fmtDia(rango.hasta)})`;
  ws.getCell(3, 1).value = `Emitido: ${fmtDia(hoy)}${usuario ? ` por ${usuario}` : ''}`;
  const noVolaron = filas.filter((f) => f.no_volo).length;
  // Cuántos ENVÍOS y cuántos RENGLONES: desde que cada bulto tiene el suyo, los dos
  // números son distintos y conviene decirlo, para que nadie cuente filas creyendo que
  // cuenta envíos.
  const totalBultos = filas.reduce(
    (acc, f) => acc + Math.max(1, (f.bultos && f.bultos.length) || 1), 0);
  const detalleBultos = totalBultos > filas.length
    ? ` en ${totalBultos} renglón(es), uno por bulto`
    : '';
  ws.getCell(4, 1).value = noVolaron === 0
    ? `${filas.length} envío(s)${detalleBultos}`
    : `${filas.length} envío(s)${detalleBultos} — ${noVolaron} marcado(s) NO VOLO, en rojo, que NO suman en el total`;
  // Aviso de lectura: en un período normal hay envíos cargados sin precio de venta
  // todavía. Su COSTO igual suma en Compra Total, así que al pie la compra puede quedar
  // MUY por encima de la venta y parecer una pérdida enorme que no existe. Decirlo acá es
  // más barato que explicarlo cada vez (visto al mirar la planilla real: 24 de 31 envíos
  // de esa semana no tenían venta cargada).
  const sinVenta = filas.filter((f) => !f.no_volo && !(Number(f.total) > 0)).length;
  if (sinVenta > 0) {
    ws.getCell(5, 1).value = `${sinVenta} envío(s) todavía sin precio de venta cargado: su costo `
      + 'suma en Compra Total, pero no aportan a Total ni a Profit.';
  }
  for (const f of [2, 3, 4, 5]) ws.getCell(f, 1).font = { name: 'Calibri', size: 10, color: { argb: 'FF555555' } };

  const FILA_ENC = 6;
  const enc = ws.getRow(FILA_ENC);
  COLUMNAS.forEach(([label], i) => {
    const c = enc.getCell(i + 1);
    c.value = label;
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { bottom: { style: 'thin', color: { argb: 'FF999999' } } };
  });
  enc.height = 26;
  COLUMNAS.forEach(([, , , ancho], i) => { ws.getColumn(i + 1).width = ancho; });

  const totales = new Map();
  let fila = FILA_ENC + 1;

  for (let idx = 0; idx < filas.length; idx++) {
    const e = filas[idx];
    // NO VOLO: renglon pintado y AFUERA de la fila de totales, igual que lo hacia la
    // oficina a mano en el Excel. Los numeros se dejan a la vista (no se borran: son el
    // registro de lo que se habia cargado), pero no suman: la planilla tiene que poder
    // usarse como estadistica del mes sin restar nada de cabeza.
    const noVolo = Boolean(e.no_volo);
    // El zebrado va POR ENVÍO, no por renglón: los tres bultos de un envío comparten
    // color y se leen como una unidad, igual que en la pantalla.
    const fondo = noVolo
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3E0E0' } }
      : idx % 2 === 0
        ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }
        : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F5FA' } };

    // UN RENGLÓN POR BULTO, como en la pantalla. `bultos` siempre trae al menos uno: el
    // envío de un solo bulto llega con uno sintético armado desde sus propios campos
    // (ver bultosDe() en salidas.routes.js). Antes salía una sola fila por envío con las
    // medidas del envío, así que de un envío de tres cajas la planilla mostraba una.
    const bultos = (Array.isArray(e.bultos) && e.bultos.length > 0) ? e.bultos : [{}];

    bultos.forEach((b, iB) => {
      const esPrimero = iB === 0;
      const row = ws.getRow(fila);

      COLUMNAS.forEach(([, campo, tipo, , ambito], i) => {
        const celda = row.getCell(i + 1);
        // Las columnas del ENVÍO solo se escriben en su primer renglón: repetirlas por
        // bulto duplicaría los importes en la fila de TOTALES.
        const escribe = ambito === 'bulto' || esPrimero;
        const v = escribe ? valorDe(e, campo, hoy, b, bultos.length, iB) : null;

        if (tipo === 'fecha' && v) {
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
          celda.value = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : v;
          celda.numFmt = FMT_FECHA;
        } else if (tipo === 'plata' || tipo === 'peso' || tipo === 'medida' || tipo === 'entero') {
          celda.value = (v === null || v === '' || v === undefined) ? null : Number(v);
          celda.numFmt = tipo === 'plata' ? FMT_PLATA
            : tipo === 'medida' ? FMT_MEDIDA
              : tipo === 'entero' ? FMT_ENTERO : FMT_PESO;
        } else {
          celda.value = (v === null || v === undefined) ? '' : v;
        }
        celda.fill = fondo;
        celda.font = noVolo
          ? { name: 'Calibri', size: 10, italic: true, color: { argb: 'FF8C2F26' } }
          : { name: 'Calibri', size: 10 };
        // Las celdas de ámbito envío ya vienen en null cuando no es el primer renglón,
        // así que la condición de número alcanza para no sumar nada dos veces.
        if (!noVolo && SUMABLES.has(campo) && typeof celda.value === 'number') {
          totales.set(campo, (totales.get(campo) || 0) + celda.value);
        }
      });
      fila++;
    });
  }

  // Fila de totales. Va aunque no haya ninguna fila: un cierre vacío es un dato, no un error.
  const tot = ws.getRow(fila);
  COLUMNAS.forEach(([, campo, tipo], i) => {
    const c = tot.getCell(i + 1);
    if (i === 0) c.value = 'TOTAL';
    else if (SUMABLES.has(campo)) {
      c.value = Math.round((totales.get(campo) || 0) * 100) / 100;
      c.numFmt = tipo === 'plata' ? FMT_PLATA : (tipo === 'medida' ? FMT_MEDIDA : FMT_PESO);
    }
    c.font = { name: 'Calibri', size: 10, bold: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF5' } };
    c.border = { top: { style: 'thin', color: { argb: 'FF1F3864' } } };
  });

  // Filtros en el encabezado: la planilla se archiva, pero también se consulta.
  ws.autoFilter = {
    from: { row: FILA_ENC, column: 1 },
    to: { row: Math.max(FILA_ENC, fila - 1), column: COLUMNAS.length },
  };

  return wb.xlsx.writeBuffer();
}

module.exports = {
  rangoDelMes, rangoDeLaSemana, rangoLibre, nombreArchivo, construirExcel,
  COLUMNAS, MESES,
};
