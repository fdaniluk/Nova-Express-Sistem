// Modelo del documento de la liquidación (04/11/2026, rediseño pedido por Felipe).
//
// Un solo armado para el Excel y el PDF: acá se decide QUÉ va en cada renglón y en qué
// columna; excel.service.js y liquidacion-pdf.service.js solo lo dibujan. Reglas:
//   · Un solo formato (el que la oficina llamaba "detallado" y ajustó a mano): sin FOB ni
//     DERECHOS; el desglose del Adicional va debajo de cada envío, en la columna
//     "Desglose de adicional" pegada a ADICIONAL, con el importe en la columna ADICIONAL.
//   · DESTINATARIO aparece solo si algún envío lo tiene (Felipe, 04/11).
//   · Filas: el envío sombreado, sus renglones de desglose en blanco.
//   · Las diferencias de fuel ya vienen sumadas en la columna FUEL del ítem (modelo), así
//     que acá no se desglosan: el cliente no tiene que leer "fuel" dos veces.
//   · Los cargos de envíos anteriores y los otros conceptos siguen en sus secciones.
const { hoyLocal } = require('../utils/fecha');

const TIPO_COBRO_LABEL = { D: 'DIARIO', S: 'SEMANAL', Q: 'QUINCENAL', CC: 'CUENTA CORRIENTE' };
function tipoCobroLabel(tipoCobro) {
  return TIPO_COBRO_LABEL[String(tipoCobro || '').toUpperCase()] || 'DIARIO';
}
function capitalizar(s) { return s.charAt(0) + s.slice(1).toLowerCase(); }

function fechaCorta(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return `${String(val.getDate()).padStart(2, '0')}/${String(val.getMonth() + 1).padStart(2, '0')}/${val.getFullYear()}`;
  }
  const s = String(val).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const dmy = s.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})$/);
  if (dmy) return `${dmy[1].padStart(2, '0')}/${dmy[2].padStart(2, '0')}/${dmy[3].length === 2 ? '20' + dmy[3] : dmy[3]}`;
  return s;
}

function tipoEnvioLabel(tipo) {
  if (tipo === 'importacion') return 'IMPORTACIÓN';
  if (tipo === 'exportacion') return 'EXPORTACIÓN';
  return String(tipo || '').toUpperCase();
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Columnas de la tabla de envíos, en orden. `ancho` en caracteres de Excel; `pdf` en puntos.
const COLUMNAS_BASE = [
  { key: 'fecha', label: 'FECHA', ancho: 11, pdf: 58, alinear: 'center' },
  { key: 'guia', label: 'Nº ENVÍO', ancho: 20, pdf: 100, alinear: 'left' },
  { key: 'destinatario', label: 'DESTINATARIO', ancho: 18, pdf: 80, alinear: 'left', opcional: true },
  { key: 'pais', label: 'PAÍS', ancho: 20, pdf: 104, alinear: 'left' },
  { key: 'zona', label: 'ZONA', ancho: 6, pdf: 32, alinear: 'center' },
  { key: 'tipo', label: 'TIPO', ancho: 13, pdf: 82, alinear: 'center' },
  { key: 'peso', label: 'PESO (kg)', ancho: 10, pdf: 48, alinear: 'right', formato: 'peso' },
  { key: 'flete', label: 'FLETE', ancho: 11, pdf: 56, alinear: 'right', formato: 'usd' },
  { key: 'fuel', label: 'FUEL', ancho: 10, pdf: 52, alinear: 'right', formato: 'usd' },
  { key: 'seguro', label: 'SEGURO', ancho: 10, pdf: 50, alinear: 'right', formato: 'usd' },
  { key: 'desglose', label: 'DESGLOSE DE ADICIONAL', ancho: 24, pdf: 96, alinear: 'left' },
  { key: 'adicional', label: 'ADICIONAL', ancho: 11, pdf: 56, alinear: 'right', formato: 'usd' },
  { key: 'total', label: 'TOTAL USD', ancho: 12, pdf: 62, alinear: 'right', formato: 'usd', negrita: true },
];

// "Sobrepeso · informado el 15/08/2026 · envío a Reino Unido, cobrado en la liquidación #45"
function conceptoCargoAnterior(c) {
  let t = c.label || 'Cargo';
  if (c.fecha) t += ` · informado el ${fechaCorta(c.fecha)}`;
  if (c.sin_envio) return `${t} · envío no cargado en el sistema`;
  const envio = [c.pais_destino ? `envío a ${c.pais_destino}` : 'envío', c.liquidacion_original_id ? `cobrado en la liquidación #${c.liquidacion_original_id}` : ''].filter(Boolean).join(', ');
  return `${t} · ${envio}`;
}

function armarDocumento(liq) {
  const items = Array.isArray(liq.items) ? liq.items : [];
  const conDestinatario = items.some((it) => String(it.destinatario_nombre || '').trim() !== '');
  const columnas = COLUMNAS_BASE.filter((c) => !c.opcional || (c.key === 'destinatario' && conDestinatario));
  const tipoLabel = tipoCobroLabel(liq.tipo_cobro);

  const cabecera = {
    titulo: `LIQUIDACIÓN ${tipoLabel}`,
    subtitulo: 'Nova Express · Courier internacional',
    datos: [
      ['Cliente', liq.cliente_nombre || ''],
      ['Período', `${fechaCorta(liq.periodo_desde)} – ${fechaCorta(liq.periodo_hasta)}`],
      ['Fecha', fechaCorta(liq.fecha || hoyLocal())],
      ['Liquidación', `${liq.id ? `Nº ${liq.id} · ` : ''}${capitalizar(tipoLabel)}`],
    ],
  };

  const totales = { peso: 0, flete: 0, fuel: 0, seguro: 0, adicional: 0, total: 0 };
  const filas = [];
  for (const it of items) {
    const celdas = {
      fecha: fechaCorta(it.fecha),
      guia: it.numero_guia || '',
      destinatario: it.destinatario_nombre || '',
      pais: it.pais_destino || '',
      zona: it.zona != null ? String(it.zona) : '',
      tipo: tipoEnvioLabel(it.tipo_envio),
      peso: r2(it.peso_facturable),
      flete: r2(it.flete),
      fuel: r2(it.fuel),
      seguro: r2(it.seguro),
      desglose: '',
      adicional: r2(it.adicional),
      total: r2(it.total_usd),
    };
    filas.push({ tipo: 'envio', celdas });
    for (const d of (Array.isArray(it.adicional_detalle) ? it.adicional_detalle : [])) {
      filas.push({ tipo: 'desglose', celdas: { desglose: `↳ ${d.label}`, adicional: r2(d.monto) } });
    }
    totales.peso += celdas.peso;
    totales.flete += celdas.flete;
    totales.fuel += celdas.fuel;
    totales.seguro += celdas.seguro;
    totales.adicional += celdas.adicional;
    totales.total += celdas.total;
  }
  for (const k of Object.keys(totales)) totales[k] = r2(totales[k]);

  const anteriores = (Array.isArray(liq.cargos_anteriores) ? liq.cargos_anteriores : []).map((c) => ({
    fecha_envio: fechaCorta(c.envio_fecha),
    guia: c.numero_guia || '',
    concepto: conceptoCargoAnterior(c),
    monto: r2(c.monto),
  }));
  const conceptos = (Array.isArray(liq.conceptos) ? liq.conceptos : []).map((c) => ({ concepto: c.concepto || '', monto: r2(c.monto) }));
  const totalAnteriores = r2(anteriores.reduce((s, c) => s + c.monto, 0));
  const totalConceptos = r2(conceptos.reduce((s, c) => s + c.monto, 0));
  const haySecciones = anteriores.length > 0 || conceptos.length > 0;

  return {
    cabecera,
    columnas,
    filas,
    sinEnvios: items.length === 0,
    totales,
    rotuloTotalEnvios: haySecciones ? 'TOTAL ENVÍOS' : 'TOTAL',
    anteriores: {
      filas: anteriores,
      total: totalAnteriores,
      nota: items.length
        ? 'Cargos que el courier informó después de liquidado el envío (impuestos de destino, sobrepeso, área remota, etc.).'
        : 'Esta liquidación no incluye envíos: son únicamente cargos que el courier informó después de liquidado cada envío (impuestos de destino, sobrepeso, área remota, etc.).',
    },
    conceptos: {
      filas: conceptos,
      total: totalConceptos,
      nota: 'Gastos pagados por Nova Express por cuenta del cliente u otros conceptos acordados, que se suman a esta liquidación.',
    },
    totalLiquidacion: haySecciones ? r2(totales.total + totalAnteriores + totalConceptos) : null,
    pie: 'Importes en dólares estadounidenses. Gracias por confiar en Nova Express.',
  };
}

// Nombre del archivo: <COBRO>_<Cliente>Envio<fecha>.<ext>
function nombreArchivo(liq, ext = 'xlsx') {
  const safe = String(liq.cliente_nombre || 'Cliente')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w]/g, '')
    .slice(0, 40);
  const f = String(liq.fecha || hoyLocal()).replace(/-/g, '');
  const pref = tipoCobroLabel(liq.tipo_cobro).replace(/\s+/g, '_');
  return `${pref}_${safe}Envio${f}.${ext}`;
}

module.exports = { armarDocumento, nombreArchivo, tipoCobroLabel, fechaCorta, conceptoCargoAnterior, COLUMNAS_BASE };
