const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const envioModel = require('../models/envio.model');
const clienteModel = require('../models/cliente.model');

const COLUMN_MAP = {
  cliente: ['CLIENTE', 'Cliente', 'cliente', 'RAZON SOCIAL', 'Razon Social'],
  fecha: ['FECHA', 'Fecha', 'fecha', 'DATE'],
  courier: ['COURIER', 'Courier', 'courier', 'TRANSPORTISTA'],
  tipo_envio: ['T DE ENVIO', 'T. ENVIO', 'TIPO', 'Tipo Envio', 'tipo_envio', 'T ENVIO'],
  numero_guia: ['Nº ENVIO', 'N ENVIO', 'NUMERO GUIA', 'Guia', 'GUIA', 'AWB', 'numero_guia', 'N° ENVIO'],
  pais_destino: ['PAIS', 'País', 'PAIS DESTINO', 'pais_destino', 'DESTINO'],
  zona: ['ZONA', 'Zona', 'zona'],
  cantidad_bultos: ['BULTOS', 'CANT BULTOS', 'cantidad_bultos', 'PIEZAS'],
  peso_real: ['PESO', 'PESO REAL', 'peso_real', 'PESO KG', 'KG'],
  largo: ['LARGO', 'L', 'largo'],
  ancho: ['ANCHO', 'A', 'ancho'],
  alto: ['ALTO', 'H', 'alto', 'ALTO CM'],
  fob: ['FOB', 'fob', 'VALOR FOB', 'VALOR DECLARADO'],
  total_cobrado: ['TOTAL', 'TOTAL USD', 'TOTAL COBRADO', 'total_cobrado', 'IMPORTE'],
  observaciones: ['OBS', 'OBSERVACIONES', 'observaciones', 'NOTAS'],
};

function normalizeHeader(h) {
  return String(h || '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function findColumnKey(header) {
  const norm = normalizeHeader(header);
  for (const [key, aliases] of Object.entries(COLUMN_MAP)) {
    for (const alias of aliases) {
      if (normalizeHeader(alias) === norm) return key;
    }
  }
  return null;
}

function mapRow(headers, row) {
  const mapped = {};
  headers.forEach((h, i) => {
    const key = findColumnKey(h);
    if (key) mapped[key] = row[i];
  });
  return mapped;
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
    return val.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
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

function getOrCreateCliente(nombre) {
  const clientes = clienteModel.listar();
  const found = clientes.find(
    (c) => c.nombre.toLowerCase() === String(nombre).trim().toLowerCase()
  );
  if (found) return found.id;
  const nuevo = clienteModel.crear({
    nombre: String(nombre).trim(),
    tipo_cobro: 'D',
    tarifa_especial: null,
  });
  return nuevo.id;
}

function importarSalidas(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (data.length < 2) {
    return { importados: 0, errores: [{ fila: 0, error: 'Archivo vacío o sin datos' }] };
  }

  const headers = data[0];
  const resultados = { importados: 0, errores: [], omitidos: 0 };

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.every((c) => c === '' || c === null)) continue;

    const m = mapRow(headers, row);
    try {
      if (!m.numero_guia || !m.cliente) {
        resultados.errores.push({ fila: i + 1, error: 'Falta cliente o número de guía' });
        continue;
      }

      const courier = parseCourier(m.courier) || 'DHL';
      const cliente_id = getOrCreateCliente(m.cliente);

      const payload = {
        cliente_id,
        fecha: parseFecha(m.fecha) || new Date().toISOString().slice(0, 10),
        courier,
        tipo_envio: parseTipo(m.tipo_envio),
        numero_guia: String(m.numero_guia).trim(),
        pais_destino: String(m.pais_destino || '—').trim(),
        zona: m.zona ? String(m.zona).trim() : null,
        cantidad_bultos: parseInt(m.cantidad_bultos, 10) || 1,
        peso_real: parseFloat(m.peso_real) || 0,
        largo: parseFloat(m.largo) || null,
        ancho: parseFloat(m.ancho) || null,
        alto: parseFloat(m.alto) || null,
        fob: parseFloat(m.fob) || 0,
        total_cobrado: parseFloat(m.total_cobrado) || 0,
        observaciones: m.observaciones ? String(m.observaciones) : null,
      };

      try {
        envioModel.crear(payload);
        resultados.importados++;
      } catch (e) {
        if (e.message && e.message.includes('UNIQUE')) {
          resultados.omitidos++;
        } else {
          throw e;
        }
      }
    } catch (e) {
      resultados.errores.push({ fila: i + 1, error: e.message });
    }
  }

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
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
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
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w]/g, '')
    .slice(0, 40);
  const f = (fecha || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  return `DIARIO_${safe}Envio${f}.xlsx`;
}

module.exports = {
  importarSalidas,
  exportarLiquidacion,
  nombreArchivoExport,
};
