const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const envioModel = require('../models/envio.model');
const clienteModel = require('../models/cliente.model');
const { hoyLocal } = require('../utils/fecha');
const { normalizarDestino } = require('../utils/paises');
const { calcularPesos, buscarZona, ZONAS_DHL, ZONAS_UPS } = require('./calculos.service');
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

function parseTipo(val) {
  const s = String(val || '').toUpperCase();
  if (s.includes('IMP')) return 'importacion';
  if (s.includes('EXP')) return 'exportacion';
  if (s === 'I') return 'importacion';
  if (s === 'E') return 'exportacion';
  return 'exportacion';
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
        const zonaTabla    = courier === 'DHL' ? ZONAS_DHL : ZONAS_UPS;
        const zonaNum      = paisParaZona != null ? buscarZona(zonaTabla, paisParaZona) : undefined;

        const payload = {
          cliente_id,
          fecha: parseFecha(m.fecha) || hoyLocal(),
          courier,
          tipo_envio: parseTipo(m.tipo_envio),
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
          asegurado: parseFloat(m.fob) > 100 ? 1 : 0,
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

const STYLES = {
  title: { font: { bold: true, size: 16, color: { argb: 'FF1A2F4A' } } },
  meta: { font: { size: 11 } },
  headerFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2F4A' } },
  headerFont: { bold: true, color: { argb: 'FFFFFFFF' } },
  rowWhite: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } },
  rowAlt: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } },
  totalFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFDE7' } },
  totalFont: { bold: true },
};

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
  const ws = wb.addWorksheet('Liquidacion', { views: [{ showGridLines: true }] });

  ws.mergeCells(1, 1, 1, COL_COUNT);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = 'Nova Express';
  titleCell.font = STYLES.title.font;
  titleCell.alignment = { vertical: 'middle' };

  ws.getCell(2, 1).value = `Cliente: ${liquidacion.cliente_nombre || ''}`;
  ws.getCell(2, 1).font = STYLES.meta.font;
  ws.getCell(3, 1).value = `Período: ${formatPeriodo(
    liquidacion.periodo_desde,
    liquidacion.periodo_hasta
  )}`;
  ws.getCell(3, 1).font = STYLES.meta.font;
  ws.getCell(4, 1).value = `Fecha: ${formatFechaDisplay(liquidacion.fecha)}`;
  ws.getCell(4, 1).font = STYLES.meta.font;

  const headerRowNum = 6;
  const headerRow = ws.getRow(headerRowNum);
  COL_HEADERS.forEach((label, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = label;
    cell.fill = STYLES.headerFill;
    cell.font = STYLES.headerFont;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  headerRow.height = 22;

  const totals = {
    peso: 0,
    fob: 0,
    flete: 0,
    fuel: 0,
    seguro: 0,
    adicional: 0,
    total_usd: 0,
  };

  let dataRowNum = headerRowNum + 1;
  for (let idx = 0; idx < liquidacion.items.length; idx++) {
    const item = liquidacion.items[idx];
    const row = ws.getRow(dataRowNum);
    const rowFill = idx % 2 === 0 ? STYLES.rowWhite : STYLES.rowAlt;

    const fechaCell = row.getCell(1);
    fechaCell.value = parseFechaExcel(item.fecha);
    setCellStyle(fechaCell, { fill: rowFill, numFmt: FMT_DATE });

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

    setCellStyle(row.getCell(6), { fill: rowFill, numFmt: FMT_PESO });
    for (const col of [7, 8, 9, 11, 12, 13]) {
      setCellStyle(row.getCell(col), { fill: rowFill, numFmt: FMT_MONEY });
    }
    setCellStyle(row.getCell(10), { fill: rowFill });
    for (const col of [2, 3, 4, 5]) {
      setCellStyle(row.getCell(col), { fill: rowFill });
    }

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
    setCellStyle(cell, {
      fill: STYLES.totalFill,
      font: STYLES.totalFont,
    });
    if (c === 6) cell.numFmt = FMT_PESO;
    if ([7, 8, 9, 11, 12, 13].includes(c)) cell.numFmt = FMT_MONEY;
  }

  autoFitColumns(ws, headerRowNum, dataRowNum);

  return wb.xlsx.writeBuffer();
}

function nombreArchivoExport(clienteNombre, fecha) {
  const safe = String(clienteNombre || 'Cliente')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w]/g, '')
    .slice(0, 40);
  const f = (fecha || hoyLocal()).replace(/-/g, '');
  return `DIARIO_${safe}Envio${f}.xlsx`;
}

module.exports = {
  importarSalidas,
  exportarLiquidacion,
  nombreArchivoExport,
};
