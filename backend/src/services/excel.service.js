const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const envioModel = require('../models/envio.model');
const clienteModel = require('../models/cliente.model');
const { hoyLocal } = require('../utils/fecha');
const { normalizarDestino } = require('../utils/paises');
const { calcularPesos, buscarZona, ZONAS_DHL, ZONAS_UPS, ZONAS_UPS_I } = require('./calculos.service');
const { getDb } = require('../db');

// Columnas por posición fija (índice 0-based → col 1 del Excel = índice 0)
const POSITION_MAP = {
  numero_salida:  0,   // col 1
  courier:        1,   // col 2
  fecha:          2,   // col 3
  numero_guia:    3,   // col 4
  tipo_cobro:     4,   // col 5
  cliente:        5,   // col 6
  pais_destino:   6,   // col 7
  bulto:          7,   // col 8
  tipo_envio:     8,   // col 9
  peso_real:      9,   // col 10
  largo:          10,  // col 11
  ancho:          11,  // col 12
  alto:           12,  // col 13
  // col 14 (idx 13): peso volumétrico — se recalcula, no se importa
  // col 15 (idx 14): peso_facturable  — se recalcula a partir de peso/dims
  // cols 16-17 (idx 15-16): sin asignar
  fob:            17,  // col 18 — valor declarado / FOB
  // cols 19-21 (idx 18-20): sin asignar
  flete:          21,  // col 22
  descuento:      22,  // col 23
  seguro:         23,  // col 24
  fuel:           24,  // col 25
  derechos:       25,  // col 26
  adicionales:    26,  // col 27
  otros:          27,  // col 28
  total_cobrado:  28,  // col 29
  profit:         29,  // col 30
  porcentaje:     30,  // col 31
  observaciones:  31,  // col 32
};

function mapRowByPosition(row) {
  const m = {};
  for (const [key, idx] of Object.entries(POSITION_MAP)) {
    m[key] = row[idx] ?? '';
  }
  return m;
}

function isEmptyRow(row) {
  return !row || row.every((c) => c === '' || c === null || c === undefined);
}

// Filas sin guía NI cliente se ignoran silenciosamente (totales, separadores, encabezados)
function isSkippableRow(m) {
  return !String(m.numero_guia ?? '').trim() && !String(m.cliente ?? '').trim();
}

function parseTipoPaquete(val) {
  const s = String(val || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (s.startsWith('m') || s.includes('merc')) return 'm';
  if (s.startsWith('d') || s.includes('doc')) return 'd';
  return null;
}

function parseAsegurado(val) {
  const s = String(val || '').toLowerCase().trim();
  return s === 'si' || s === 'yes' || s === 'x' || s === '1' ? 1 : 0;
}

function parseTipoCobro(val) {
  const s = String(val || '').trim().toUpperCase();
  if (['D', 'S', 'Q', 'CC'].includes(s)) return s;
  return null;
}

function parseCourier(val) {
  const s = String(val || '').toUpperCase();
  if (s.includes('DHL')) return 'DHL';
  if (s.includes('UPS')) return 'UPS';
  return null;
}

// Devuelve null si la celda no dice nada de impo/expo (en la planilla real esa columna
// suele traer el tipo de PAQUETE: "MERCADERIA"/"DOCUMENTO"). El que llama decide el
// fallback — desde el 15/08/2026 es la `direccion` que detectó normalizarDestino, no
// un 'exportacion' fijo: antes una IMPO detectada por el país/observaciones quedaba
// guardada con tipo_envio='exportacion' y el desglose al costo usaba la tabla de expo.
function parseTipo(val) {
  const s = String(val || '').toUpperCase();
  if (s.includes('IMP')) return 'importacion';
  if (s.includes('EXP')) return 'exportacion';
  if (s === 'I') return 'importacion';
  if (s === 'E') return 'exportacion';
  return null;
}

function parseFecha(val) {
  if (!val) return null;
  if (val instanceof Date) {
    // OJO: acá el toISOString() se deja A PROPÓSITO, no es el mismo caso que los "hoy"
    // que se pasaron a hoyLocal(). `val` es una celda de fecha que parseó XLSX, y según
    // cómo la haya construido puede representar medianoche UTC o medianoche local.
    // Con el servidor en -03, la medianoche local cae el MISMO día en UTC, así que
    // toISOString() da el resultado correcto; formatearla con getters locales podría
    // restarle un día si XLSX la armó en UTC. Cambiar esto requiere probarlo contra
    // planillas reales antes de tocarlo.
    return val.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const num = Number(val);
  if (!Number.isNaN(num) && num > 40000) {
    const date = XLSX.SSF.parse_date_code(num);
    if (date) {
      return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
    }
  }
  return s;
}

async function getOrCreateCliente(nombre, tipoCobro) {
  const clientes = await clienteModel.listar();
  const found = clientes.find(
    (c) => c.nombre.toLowerCase() === String(nombre).trim().toLowerCase()
  );
  if (found) return found.id;
  const nuevo = await clienteModel.crear({
    nombre: String(nombre).trim(),
    tipo_cobro: tipoCobro || 'D',
    tarifa_especial: null,
  });
  return nuevo.id;
}

async function importarSalidas(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (data.length < 1) {
    return { importados: 0, errores: [{ fila: 0, error: 'Archivo vacío' }] };
  }

  const resultados = { importados: 0, errores: [], omitidos: 0 };

  // Empezar desde fila 1 para saltear la fila de encabezados (aunque no sea reconocible por nombre).
  // Si el archivo no tiene encabezado, la fila 0 se perderá; en ese caso cambiar a i = 0.
  const startRow = 1;

  const db = getDb();

  // Una sola transacción exterior para toda la importación. Cada fila usa un SAVEPOINT
  // individual para que errores por fila (como duplicados) no aborte el import completo.
  // envioModel.crear no abre su propia transacción cuando no hay bultos, así no hay anidamiento.
  await db.transaction(async () => {
    for (let i = startRow; i < data.length; i++) {
      const row = data[i];

      if (isEmptyRow(row)) continue;

      const m = mapRowByPosition(row);

      if (isSkippableRow(m)) continue;

      try {
        const guia = String(m.numero_guia ?? '').trim().toUpperCase();
        const clienteNombre = String(m.cliente ?? '').trim();

        if (!guia) {
          resultados.errores.push({ fila: i + 1, error: 'Falta número de guía' });
          continue;
        }
        if (!clienteNombre) {
          resultados.errores.push({ fila: i + 1, error: 'Falta nombre de cliente' });
          continue;
        }

        const courier = parseCourier(m.courier) || 'DHL';
        const cliente_id = await getOrCreateCliente(clienteNombre, parseTipoCobro(m.tipo_cobro));
        const observacionesStr = m.observaciones ? String(m.observaciones) : null;
        const { destino, destino_raw, direccion, origen } = normalizarDestino(
          m.pais_destino,
          observacionesStr
        );

        const pesoRealNum = parseFloat(m.peso_real) || 0;
        const largoNum    = parseFloat(m.largo)  || null;
        const anchoNum    = parseFloat(m.ancho)  || null;
        const altoNum     = parseFloat(m.alto)   || null;
        const { pesoVolumetrico, pesoFacturable } = calcularPesos(
          pesoRealNum, [], { largo: largoNum, ancho: anchoNum, alto: altoNum }
        );

        const paisParaZona = direccion === 'impo' ? origen : destino;
        // La zona depende de la DIRECCIÓN, no solo del courier: UPS tiene tabla propia de
        // importación (ZONAS_UPS_I). Antes una impo UPS tomaba la zona de la tabla de expo,
        // y como esa zona queda guardada y después actúa de override en los recálculos, el
        // costo del envío salía de la fila equivocada de la matriz. DHL usa la misma tabla
        // en ambas direcciones.
        const zonaTabla = courier === 'DHL'
          ? ZONAS_DHL
          : (direccion === 'impo' ? ZONAS_UPS_I : ZONAS_UPS);
        const zonaNum      = paisParaZona != null ? buscarZona(zonaTabla, paisParaZona) : undefined;

        const payload = {
          cliente_id,
          fecha: parseFecha(m.fecha) || hoyLocal(),
          courier,
          // Si la celda no dice impo/expo, manda la dirección detectada por el destino y
          // las observaciones: tipo_envio y direccion no pueden contarse historias distintas.
          tipo_envio: parseTipo(m.tipo_envio) || (direccion === 'impo' ? 'importacion' : 'exportacion'),
          // La variante de UPS queda EXPLÍCITA en el envío ("Saver" si la celda del courier
          // lo menciona, si no Expedited). Antes quedaba en NULL y cada recálculo dependía
          // del fallback silencioso a UPS_EXP del modelo.
          servicio_ups: courier === 'UPS'
            ? (/SAV/i.test(String(m.courier)) ? 'UPS_SAV' : 'UPS_EXP')
            : null,
          numero_guia: guia,
          pais_destino: destino,
          destino_raw,
          direccion,
          zona: zonaNum != null ? zonaNum : null,
          cantidad_bultos: 1,
          peso_real:        pesoRealNum,
          largo:            largoNum,
          ancho:            anchoNum,
          alto:             altoNum,
          peso_volumetrico: pesoVolumetrico,
          peso_facturable:  pesoFacturable,
          fob: parseFloat(m.fob) || 0,
          total_cobrado: parseFloat(m.total_cobrado) || 0,
          observaciones: observacionesStr,
          numero_salida: m.numero_salida ? parseInt(m.numero_salida, 10) || null : null,
          bulto: m.bulto ? String(m.bulto).trim() : null,
          tipo_paquete: parseTipoPaquete(m.tipo_envio),
          tipo_cobro: m.tipo_cobro ? String(m.tipo_cobro).trim().toUpperCase() : null,
          // >= 100: la regla del motor y de la tilde automatica es que USD 100 EXACTO paga
          // seguro (calcSeguroUPS cobra 15 desde 100 inclusive). Aca decia > 100 y un FOB de
          // 100 justo importado por planilla quedaba sin asegurar (auditoria 28/08, deuda 38).
          asegurado: parseFloat(m.fob) >= 100 ? 1 : 0,
          flete: parseFloat(m.flete) || null,
          descuento: parseFloat(m.descuento) || null,
          seguro: parseFloat(m.seguro) || null,
          fuel: parseFloat(m.fuel) || null,
          derechos: parseFloat(m.derechos) || null,
          adicionales: parseFloat(m.adicionales) || null,
          otros: parseFloat(m.otros) || null,
          profit: parseFloat(m.profit) || null,
          porcentaje: parseFloat(m.porcentaje) || null,
        };

        await db.exec('SAVEPOINT import_row');
        try {
          await envioModel.crear(payload);
          await db.exec('RELEASE SAVEPOINT import_row');
          resultados.importados++;
        } catch (e) {
          await db.exec('ROLLBACK TO SAVEPOINT import_row');
          await db.exec('RELEASE SAVEPOINT import_row');
          if (e.message && e.message.includes('UNIQUE')) {
            resultados.omitidos++;
          } else {
            resultados.errores.push({ fila: i + 1, error: e.message });
          }
        }
      } catch (e) {
        resultados.errores.push({ fila: i + 1, error: e.message });
      }
    }
  });

  return resultados;
}

const COL_COUNT = 13;
const COL_HEADERS = [
  'FECHA',
  'Nº ENVIO',
  'PAIS',
  'ZONA',
  'T DE ENVIO',
  'PESO',
  'FOB',
  'FLETE',
  'FUEL',
  'DERECHOS',
  'SEGURO',
  'ADICIONAL',
  'TOTAL USD',
];

// Colores Nova (07/09/2026, pedido de Felipe: "logo, colores de Nova y que quede bien bonito"):
// azul Nova #2A3661 para cabeceras y título, naranja Nova #EA6749 para el acento y el total.
const NOVA_VIOLETA = 'FF2A3661';
const NOVA_CORAL = 'FFEA6749';
const NOVA_VIOLETA_SUAVE = 'FFEAF1F8';
const NOVA_GRIS = 'FF6B6478';
const FUENTE = 'Calibri';
const STYLES = {
  title: { font: { name: FUENTE, bold: true, size: 18, color: { argb: NOVA_VIOLETA } } },
  subtitle: { font: { name: FUENTE, bold: true, size: 11, color: { argb: NOVA_CORAL } } },
  meta: { font: { name: FUENTE, size: 10.5, color: { argb: NOVA_GRIS } } },
  metaStrong: { font: { name: FUENTE, size: 10.5, bold: true, color: { argb: NOVA_VIOLETA } } },
  headerFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: NOVA_VIOLETA } },
  headerFont: { name: FUENTE, bold: true, size: 10, color: { argb: 'FFFFFFFF' } },
  rowWhite: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } },
  rowAlt: { type: 'pattern', pattern: 'solid', fgColor: { argb: NOVA_VIOLETA_SUAVE } },
  rowFont: { name: FUENTE, size: 10, color: { argb: 'FF2B2536' } },
  totalFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: NOVA_CORAL } },
  totalFont: { name: FUENTE, bold: true, size: 10.5, color: { argb: 'FFFFFFFF' } },
  subHeaderFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: NOVA_VIOLETA_SUAVE } },
  subHeaderFont: { name: FUENTE, bold: true, size: 10, color: { argb: NOVA_VIOLETA } },
  noteFont: { name: FUENTE, italic: true, size: 9.5, color: { argb: NOVA_GRIS } },
};
const BORDE_SUAVE = { style: 'thin', color: { argb: 'FFDDD8E6' } };
const BORDES = { top: BORDE_SUAVE, bottom: BORDE_SUAVE, left: BORDE_SUAVE, right: BORDE_SUAVE };

// Cómo se cobra el cliente → título del documento y prefijo del archivo. Antes todo salía
// como "DIARIO" aunque el cliente fuera semanal o de cuenta corriente (Felipe, 07/09).
const TIPO_COBRO_LABEL = { D: 'DIARIO', S: 'SEMANAL', Q: 'QUINCENAL', CC: 'CUENTA CORRIENTE' };
function tipoCobroLabel(tipoCobro) {
  return TIPO_COBRO_LABEL[String(tipoCobro || '').toUpperCase()] || 'DIARIO';
}

// Logo Nova para el Excel. Se lee una sola vez; si no está, el documento sale sin logo.
const LOGO_PATH = path.join(__dirname, '..', '..', '..', 'frontend', 'assets', 'logos', 'nova.png');
let logoBuffer = null;
function leerLogo() {
  if (logoBuffer === null) {
    try { logoBuffer = fs.readFileSync(LOGO_PATH); } catch { logoBuffer = false; }
  }
  return logoBuffer || null;
}

const FMT_DATE = 'dd/mm/yyyy';
const FMT_MONEY = '"$"#,##0.00';
const FMT_PESO = '#,##0.00';

function parseFechaExcel(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  const s = String(val).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const dmy = s.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})$/);
  if (dmy) {
    let y = dmy[3];
    if (y.length === 2) y = `20${y}`;
    return new Date(Number(y), Number(dmy[2]) - 1, Number(dmy[1]));
  }
  return null;
}

function formatFechaDisplay(val) {
  const d = parseFechaExcel(val);
  if (!d || Number.isNaN(d.getTime())) return String(val || '');
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function formatPeriodo(desde, hasta) {
  return `${formatFechaDisplay(desde)} – ${formatFechaDisplay(hasta)}`;
}

function tipoEnvioLabel(tipo) {
  if (tipo === 'importacion') return 'IMPORTACION';
  if (tipo === 'exportacion') return 'EXPORTACION';
  return String(tipo || '').toUpperCase();
}

function setCellStyle(cell, { fill, font, numFmt, alignment } = {}) {
  if (fill) cell.fill = fill;
  if (font) cell.font = { ...(cell.font || {}), ...font };
  if (numFmt) cell.numFmt = numFmt;
  if (alignment) cell.alignment = alignment;
}

function autoFitColumns(worksheet, fromRow, toRow) {
  for (let c = 1; c <= COL_COUNT; c++) {
    let maxLen = COL_HEADERS[c - 1].length;
    for (let r = fromRow; r <= toRow; r++) {
      const cell = worksheet.getRow(r).getCell(c);
      let text = '';
      if (cell.value instanceof Date) {
        text = formatFechaDisplay(cell.value);
      } else if (typeof cell.value === 'number') {
        text = cell.numFmt === FMT_MONEY ? `$${cell.value.toFixed(2)}` : cell.value.toFixed(2);
      } else if (cell.value != null) {
        text = String(cell.value);
      }
      maxLen = Math.max(maxLen, text.length);
    }
    worksheet.getColumn(c).width = Math.min(maxLen + 2, 42);
  }
}

async function exportarLiquidacion(liquidacion) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Nova Express';
  const ws = wb.addWorksheet('Liquidacion', {
    views: [{ showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  const tipoLabel = tipoCobroLabel(liquidacion.tipo_cobro);

  // ── Cabecera: logo a la izquierda, título y datos a la derecha ──
  const logo = leerLogo();
  if (logo) {
    const imgId = wb.addImage({ buffer: logo, extension: 'png' });
    // 1050×446 px de origen → se dibuja a 150×64 (misma proporción), pegado arriba a la izquierda.
    ws.addImage(imgId, { tl: { col: 0.15, row: 0.3 }, ext: { width: 150, height: 64 } });
  }
  for (let r = 1; r <= 4; r++) ws.getRow(r).height = 18;

  ws.mergeCells(1, 4, 1, COL_COUNT);
  const titleCell = ws.getCell(1, 4);
  titleCell.value = `LIQUIDACIÓN ${tipoLabel}`;
  titleCell.font = STYLES.title.font;
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(1).height = 26;

  ws.mergeCells(2, 4, 2, COL_COUNT);
  ws.getCell(2, 4).value = 'Nova Express · Courier internacional';
  ws.getCell(2, 4).font = STYLES.subtitle.font;

  const metaRow = (r, label, value) => {
    ws.getCell(r, 4).value = label;
    ws.getCell(r, 4).font = STYLES.meta.font;
    ws.getCell(r, 4).alignment = { horizontal: 'right' };
    ws.mergeCells(r, 5, r, 8);
    ws.getCell(r, 5).value = value;
    ws.getCell(r, 5).font = STYLES.metaStrong.font;
  };
  metaRow(3, 'Cliente', liquidacion.cliente_nombre || '');
  metaRow(4, 'Período', formatPeriodo(liquidacion.periodo_desde, liquidacion.periodo_hasta));
  ws.getCell(3, 10).value = 'Fecha';
  ws.getCell(3, 10).font = STYLES.meta.font;
  ws.getCell(3, 10).alignment = { horizontal: 'right' };
  ws.mergeCells(3, 11, 3, COL_COUNT);
  ws.getCell(3, 11).value = formatFechaDisplay(liquidacion.fecha);
  ws.getCell(3, 11).font = STYLES.metaStrong.font;
  ws.getCell(4, 10).value = 'Cobro';
  ws.getCell(4, 10).font = STYLES.meta.font;
  ws.getCell(4, 10).alignment = { horizontal: 'right' };
  ws.mergeCells(4, 11, 4, COL_COUNT);
  ws.getCell(4, 11).value = tipoLabel.charAt(0) + tipoLabel.slice(1).toLowerCase();
  ws.getCell(4, 11).font = STYLES.metaStrong.font;

  // Línea coral fina debajo de la cabecera.
  ws.getRow(5).height = 6;
  for (let c = 1; c <= COL_COUNT; c++) {
    ws.getCell(5, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NOVA_CORAL } };
  }
  ws.getRow(6).height = 8;

  // ── Tabla principal ──
  const headerRowNum = 7;
  const headerRow = ws.getRow(headerRowNum);
  COL_HEADERS.forEach((label, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = label;
    cell.fill = STYLES.headerFill;
    cell.font = STYLES.headerFont;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = BORDES;
  });
  headerRow.height = 24;

  const totals = { peso: 0, fob: 0, flete: 0, fuel: 0, seguro: 0, adicional: 0, total_usd: 0 };
  const NUM_COLS = [7, 8, 9, 11, 12, 13];

  let dataRowNum = headerRowNum + 1;
  for (let idx = 0; idx < liquidacion.items.length; idx++) {
    const item = liquidacion.items[idx];
    const row = ws.getRow(dataRowNum);
    const rowFill = idx % 2 === 0 ? STYLES.rowWhite : STYLES.rowAlt;

    const fechaCell = row.getCell(1);
    fechaCell.value = parseFechaExcel(item.fecha);
    row.getCell(2).value = item.numero_guia || '';
    row.getCell(3).value = item.pais_destino || '';
    row.getCell(4).value = item.zona || '';
    row.getCell(5).value = tipoEnvioLabel(item.tipo_envio);

    const peso = Number(item.peso_facturable) || 0;
    const fob = Number(item.fob) || 0;
    const flete = Number(item.flete) || 0;
    const fuel = Number(item.fuel) || 0;
    const seguro = Number(item.seguro) || 0;
    const adicional = Number(item.adicional) || 0;
    const totalUsd = Number(item.total_usd) || 0;

    row.getCell(6).value = peso;
    row.getCell(7).value = fob;
    row.getCell(8).value = flete;
    row.getCell(9).value = fuel;
    row.getCell(10).value = '';
    row.getCell(11).value = seguro;
    row.getCell(12).value = adicional;
    row.getCell(13).value = totalUsd;

    for (let c = 1; c <= COL_COUNT; c++) {
      const cell = row.getCell(c);
      setCellStyle(cell, { fill: rowFill, font: STYLES.rowFont });
      cell.border = BORDES;
      cell.alignment = { vertical: 'middle', horizontal: [1, 4, 5].includes(c) ? 'center' : (c === 2 || c === 3) ? 'left' : 'right' };
    }
    fechaCell.numFmt = FMT_DATE;
    row.getCell(6).numFmt = FMT_PESO;
    for (const col of NUM_COLS) row.getCell(col).numFmt = FMT_MONEY;
    row.getCell(13).font = { ...STYLES.rowFont, bold: true };
    row.height = 17;

    totals.peso += peso;
    totals.fob += fob;
    totals.flete += flete;
    totals.fuel += fuel;
    totals.seguro += seguro;
    totals.adicional += adicional;
    totals.total_usd += totalUsd;

    dataRowNum++;
  }

  const totalRow = ws.getRow(dataRowNum);
  ws.mergeCells(dataRowNum, 1, dataRowNum, 5);
  totalRow.getCell(1).value = 'TOTAL';
  totalRow.getCell(6).value = totals.peso;
  totalRow.getCell(7).value = totals.fob;
  totalRow.getCell(8).value = totals.flete;
  totalRow.getCell(9).value = totals.fuel;
  totalRow.getCell(10).value = '';
  totalRow.getCell(11).value = totals.seguro;
  totalRow.getCell(12).value = totals.adicional;
  totalRow.getCell(13).value = totals.total_usd;
  for (let c = 1; c <= COL_COUNT; c++) {
    const cell = totalRow.getCell(c);
    setCellStyle(cell, { fill: STYLES.totalFill, font: STYLES.totalFont });
    cell.alignment = { vertical: 'middle', horizontal: c === 1 ? 'center' : 'right' };
    if (c === 6) cell.numFmt = FMT_PESO;
    if (NUM_COLS.includes(c)) cell.numFmt = FMT_MONEY;
  }
  totalRow.height = 20;

  autoFitColumns(ws, headerRowNum, dataRowNum);
  // La columna de guía y la de país necesitan aire propio (el autofit las deja justas).
  ws.getColumn(2).width = Math.max(ws.getColumn(2).width || 0, 20);
  ws.getColumn(3).width = Math.max(ws.getColumn(3).width || 0, 16);
  ws.getColumn(13).width = Math.max(ws.getColumn(13).width || 0, 13);

  // ── Detalle de adicionales (07/09): qué compone la columna ADICIONAL, guía por guía ──
  // Surge (con su fuel), GoGreen, manejo, remota, derechos, extras manuales… Solo se dibuja
  // si alguna guía tiene algo que desglosar.
  const conDetalle = liquidacion.items.filter((it) => Array.isArray(it.adicional_detalle) && it.adicional_detalle.length);
  let r = dataRowNum + 2;
  if (conDetalle.length) {
    ws.mergeCells(r, 1, r, COL_COUNT);
    ws.getCell(r, 1).value = 'DETALLE DE ADICIONALES';
    ws.getCell(r, 1).font = STYLES.subtitle.font;
    ws.getRow(r).height = 18;
    r++;
    const sub = [['Nº ENVIO', 2, 4], ['CONCEPTO', 5, 11], ['USD', 12, 13]];
    for (const [label, c1, c2] of sub) {
      ws.mergeCells(r, c1, r, c2);
      const cell = ws.getCell(r, c1);
      cell.value = label;
      cell.fill = STYLES.subHeaderFill;
      cell.font = STYLES.subHeaderFont;
      cell.alignment = { horizontal: label === 'USD' ? 'right' : 'left', vertical: 'middle' };
      for (let c = c1; c <= c2; c++) ws.getCell(r, c).border = BORDES;
    }
    r++;
    let n = 0;
    for (const it of conDetalle) {
      for (const d of it.adicional_detalle) {
        const fill = n % 2 === 0 ? STYLES.rowWhite : STYLES.rowAlt;
        ws.mergeCells(r, 2, r, 4);
        ws.mergeCells(r, 5, r, 11);
        ws.mergeCells(r, 12, r, 13);
        ws.getCell(r, 2).value = it.numero_guia || '';
        ws.getCell(r, 5).value = d.label;
        ws.getCell(r, 12).value = Number(d.monto) || 0;
        ws.getCell(r, 12).numFmt = FMT_MONEY;
        ws.getCell(r, 12).alignment = { horizontal: 'right' };
        for (let c = 2; c <= COL_COUNT; c++) {
          setCellStyle(ws.getCell(r, c), { fill, font: STYLES.rowFont });
          ws.getCell(r, c).border = BORDES;
        }
        ws.getRow(r).height = 16;
        r++;
        n++;
      }
    }
    r++;
  }

  ws.mergeCells(r, 1, r, COL_COUNT);
  ws.getCell(r, 1).value = 'Importes en dólares estadounidenses. Gracias por confiar en Nova Express.';
  ws.getCell(r, 1).font = STYLES.noteFont;
  ws.getCell(r, 1).alignment = { horizontal: 'center' };

  return wb.xlsx.writeBuffer();
}

// Nombre del archivo: <COBRO>_<Cliente>Envio<fecha>.xlsx, con el cobro del cliente (antes
// salía siempre "DIARIO_"). Los espacios del cobro van con guion bajo (CUENTA_CORRIENTE).
function nombreArchivoExport(clienteNombre, fecha, tipoCobro) {
  const safe = String(clienteNombre || 'Cliente')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w]/g, '')
    .slice(0, 40);
  const f = (fecha || hoyLocal()).replace(/-/g, '');
  const pref = tipoCobroLabel(tipoCobro).replace(/\s+/g, '_');
  return `${pref}_${safe}Envio${f}.xlsx`;
}

module.exports = {
  importarSalidas,
  exportarLiquidacion,
  tipoCobroLabel,
  nombreArchivoExport,
};
