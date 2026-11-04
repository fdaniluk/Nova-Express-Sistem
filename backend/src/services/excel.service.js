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

// cache: Map nombre-en-minúscula → id, armado una vez por importación (antes se listaban
// todos los clientes por CADA fila) y con los dos nombres, el de la ficha y el Nova: con
// solo `nombre` un cliente conocido por su nombre Nova se duplicaba (29/09/2026).
async function getOrCreateCliente(nombre, tipoCobro, cache = null) {
  const clave = String(nombre).trim().toLowerCase();
  if (cache && cache.has(clave)) return cache.get(clave);
  const clientes = cache ? [] : await clienteModel.listar({ todos: 1 });
  const found = clientes.find((c) => String(c.nombre || '').toLowerCase() === clave
    || String(c.nombre_nova || '').toLowerCase() === clave);
  if (found) return found.id;
  const nuevo = await clienteModel.crear({
    nombre: String(nombre).trim(),
    tipo_cobro: tipoCobro || 'D',
    tarifa_especial: null,
  });
  if (cache) cache.set(clave, nuevo.id);
  return nuevo.id;
}

async function cacheClientes() {
  const cache = new Map();
  for (const c of await clienteModel.listar({ todos: 1 })) {
    for (const n of [c.nombre, c.nombre_nova]) {
      const k = String(n || '').trim().toLowerCase();
      if (k && !cache.has(k)) cache.set(k, c.id);
    }
  }
  return cache;
}

async function importarSalidas(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const cacheCli = await cacheClientes();
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
        const cliente_id = await getOrCreateCliente(clienteNombre, parseTipoCobro(m.tipo_cobro), cacheCli);
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
  // Rediseño 04/11: el renglón del envío va sombreado y su desglose en blanco, letra chica gris.
  rowEnvio: { type: 'pattern', pattern: 'solid', fgColor: { argb: NOVA_VIOLETA_SUAVE } },
  desgloseFont: { name: FUENTE, size: 9.5, italic: true, color: { argb: NOVA_GRIS } },
  rowFont: { name: FUENTE, size: 10, color: { argb: 'FF2B2536' } },
  totalFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: NOVA_CORAL } },
  totalFont: { name: FUENTE, bold: true, size: 10.5, color: { argb: 'FFFFFFFF' } },
  subHeaderFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: NOVA_VIOLETA_SUAVE } },
  subHeaderFont: { name: FUENTE, bold: true, size: 10, color: { argb: NOVA_VIOLETA } },
  noteFont: { name: FUENTE, italic: true, size: 9.5, color: { argb: NOVA_GRIS } },
};
// Renglones más marcados (pedido de administración, 22/09/2026): el borde entre filas era
// casi invisible y en el detalle de adicionales no se distinguía dónde terminaba una guía.
const BORDE_SUAVE = { style: 'thin', color: { argb: 'FFC4BDD3' } };
const BORDE_FUERTE = { style: 'medium', color: { argb: NOVA_VIOLETA } };
const BORDES = { top: BORDE_SUAVE, bottom: BORDE_SUAVE, left: BORDE_SUAVE, right: BORDE_SUAVE };

const { armarDocumento, nombreArchivo, tipoCobroLabel } = require('./liquidacion-documento');

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

function setCellStyle(cell, { fill, font, numFmt, alignment } = {}) {
  if (fill) cell.fill = fill;
  if (font) cell.font = { ...(cell.font || {}), ...font };
  if (numFmt) cell.numFmt = numFmt;
  if (alignment) cell.alignment = alignment;
}

// ── Excel de la liquidación (rediseño 04/11/2026) ─────────────────────────────────
// Qué va en cada renglón lo decide liquidacion-documento.js (compartido con el PDF); acá
// solo se dibuja: cabecera con logo, título centrado y recuadro de datos a la derecha;
// envíos sombreados con su desglose en blanco debajo; total en coral; secciones de cargos
// de envíos anteriores y otros conceptos; total de la liquidación en azul.
async function exportarLiquidacion(liquidacion) {
  const doc = armarDocumento(liquidacion);
  const cols = doc.columnas;
  const NCOL = cols.length;
  const idx = {};
  cols.forEach((c, i) => { idx[c.key] = i + 1; });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Nova Express';
  const ws = wb.addWorksheet('Liquidacion', {
    views: [{ showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
  });
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.ancho; });

  // ── Cabecera (04/11, Felipe: "parecido al original": logo grande a la izquierda, título a
  // la izquierda y más chico, datos en dos columnas; el tipo de cobro no es protagonista) ──
  const logo = leerLogo();
  if (logo) {
    const imgId = wb.addImage({ buffer: logo, extension: 'png' });
    // 1050×446 px de origen → 200×85, ocupa las cuatro filas de la cabecera.
    ws.addImage(imgId, { tl: { col: 0.1, row: 0.15 }, ext: { width: 200, height: 85 } });
  }
  for (let r = 1; r <= 4; r++) ws.getRow(r).height = 19;
  const cLab1 = idx.guia + 1;            // rótulos de la izquierda (Cliente / Período)
  const cVal1 = cLab1 + 1;
  const cVal1Fin = idx.peso;
  const cLab2 = idx.flete;               // rótulos de la derecha (Fecha / Liquidación)
  const cVal2 = idx.fuel;
  const cVal2Fin = idx.desglose;
  ws.mergeCells(1, cLab1, 1, cVal2Fin);
  const titleCell = ws.getCell(1, cLab1);
  titleCell.value = doc.cabecera.titulo;
  titleCell.font = { ...STYLES.title.font, size: 14 };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.mergeCells(2, cLab1, 2, cVal2Fin);
  ws.getCell(2, cLab1).value = doc.cabecera.subtitulo;
  ws.getCell(2, cLab1).font = STYLES.subtitle.font;
  ws.getCell(2, cLab1).alignment = { vertical: 'middle', horizontal: 'left' };
  const dato = (r, cLab, cVal, cValFin, label, value) => {
    const lc = ws.getCell(r, cLab);
    lc.value = label;
    lc.font = STYLES.meta.font;
    lc.alignment = { horizontal: 'right', vertical: 'middle' };
    if (cValFin > cVal) ws.mergeCells(r, cVal, r, cValFin);
    const vc = ws.getCell(r, cVal);
    vc.value = value;
    vc.font = STYLES.metaStrong.font;
    vc.alignment = { horizontal: 'left', vertical: 'middle' };
  };
  const [dCliente, dPeriodo, dFecha, dLiq] = doc.cabecera.datos;
  dato(3, cLab1, cVal1, cVal1Fin, dCliente[0], dCliente[1]);
  dato(4, cLab1, cVal1, cVal1Fin, dPeriodo[0], dPeriodo[1]);
  dato(3, cLab2, cVal2, cVal2Fin, dFecha[0], dFecha[1]);
  dato(4, cLab2, cVal2, cVal2Fin, dLiq[0], dLiq[1]);
  // Línea coral fina debajo de la cabecera.
  ws.getRow(5).height = 6;
  for (let c = 1; c <= NCOL; c++) {
    ws.getCell(5, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NOVA_CORAL } };
  }
  ws.getRow(6).height = 8;

  // ── Tabla de envíos ──
  const headerRowNum = 7;
  const headerRow = ws.getRow(headerRowNum);
  cols.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.label;
    cell.fill = STYLES.headerFill;
    cell.font = STYLES.headerFont;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = BORDES;
  });
  headerRow.height = 26;

  const fmtDe = (c) => (c.formato === 'usd' ? FMT_MONEY : c.formato === 'peso' ? FMT_PESO : null);
  let r = headerRowNum + 1;
  for (const fila of doc.filas) {
    const row = ws.getRow(r);
    if (fila.tipo === 'envio') {
      cols.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        const v = fila.celdas[c.key];
        cell.value = v === '' || v == null ? '' : v;
        // La fecha va como fecha de Excel (se puede ordenar/filtrar), no como texto.
        if (c.key === 'fecha' && v) { cell.value = parseFechaExcel(v) || v; cell.numFmt = FMT_DATE; }
        setCellStyle(cell, { fill: STYLES.rowEnvio, font: c.negrita ? { ...STYLES.rowFont, bold: true } : STYLES.rowFont });
        cell.border = BORDES;
        cell.alignment = { vertical: 'middle', horizontal: c.alinear };
        const nf = fmtDe(c);
        if (nf) cell.numFmt = nf;
      });
      row.height = 18;
    } else {
      // Renglón de desglose: en blanco, letra chica en gris; solo desglose + adicional llevan dato.
      cols.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        cell.value = c.key === 'desglose' ? fila.celdas.desglose : c.key === 'adicional' ? fila.celdas.adicional : '';
        setCellStyle(cell, { fill: STYLES.rowWhite, font: STYLES.desgloseFont });
        cell.border = { ...BORDES, top: { style: 'hair', color: { argb: 'FFE3E6EE' } }, bottom: { style: 'hair', color: { argb: 'FFE3E6EE' } } };
        cell.alignment = { vertical: 'middle', horizontal: c.key === 'adicional' ? 'right' : 'left' };
        if (c.key === 'adicional') cell.numFmt = FMT_MONEY;
      });
      row.height = 15;
    }
    r++;
  }
  if (doc.sinEnvios) {
    ws.mergeCells(r, 1, r, NCOL);
    ws.getCell(r, 1).value = 'Sin envíos en este período · ver las secciones de abajo.';
    setCellStyle(ws.getCell(r, 1), { fill: STYLES.rowWhite, font: { ...STYLES.rowFont, italic: true } });
    ws.getCell(r, 1).alignment = { horizontal: 'center', vertical: 'middle' };
    for (let c = 1; c <= NCOL; c++) ws.getCell(r, c).border = BORDES;
    ws.getRow(r).height = 17;
    r++;
  }
  // Total de los envíos (coral).
  ws.mergeCells(r, 1, r, idx.tipo);
  const totalRow = ws.getRow(r);
  totalRow.getCell(1).value = doc.rotuloTotalEnvios;
  for (const key of ['peso', 'flete', 'fuel', 'seguro', 'adicional', 'total']) totalRow.getCell(idx[key]).value = doc.totales[key];
  cols.forEach((c, i) => {
    const cell = totalRow.getCell(i + 1);
    setCellStyle(cell, { fill: STYLES.totalFill, font: STYLES.totalFont });
    cell.alignment = { vertical: 'middle', horizontal: i === 0 ? 'center' : 'right' };
    const nf = fmtDe(c);
    if (nf) cell.numFmt = nf;
  });
  totalRow.height = 21;
  r += 2;

  // ── Secciones: cargos de envíos anteriores / otros conceptos ──
  // Columnas de las secciones: FECHA ENVÍO = 1 · Nº ENVÍO = 2..país · CONCEPTO = zona..desglose · USD = adicional..total.
  const sec = { guiaFin: idx.pais, concIni: idx.zona, concFin: idx.desglose, usdIni: idx.adicional };
  const seccion = (titulo, nota, cabeceras, filas, pintarFila, rotuloTotal, total) => {
    ws.mergeCells(r, 1, r, NCOL);
    ws.getCell(r, 1).value = titulo;
    ws.getCell(r, 1).font = STYLES.subtitle.font;
    ws.getRow(r).height = 18;
    r++;
    ws.mergeCells(r, 1, r, NCOL);
    ws.getCell(r, 1).value = nota;
    ws.getCell(r, 1).font = STYLES.noteFont;
    r++;
    for (const [label, c1, c2, alinear] of cabeceras) {
      if (c2 > c1) ws.mergeCells(r, c1, r, c2);
      const cell = ws.getCell(r, c1);
      cell.value = label;
      cell.fill = STYLES.subHeaderFill;
      cell.font = STYLES.subHeaderFont;
      cell.alignment = { horizontal: alinear, vertical: 'middle' };
      for (let c = c1; c <= c2; c++) ws.getCell(r, c).border = BORDES;
    }
    r++;
    filas.forEach((f, i) => {
      pintarFila(f, i % 2 === 0 ? STYLES.rowWhite : STYLES.rowAlt);
      ws.getRow(r).height = 16;
      r++;
    });
    ws.mergeCells(r, 1, r, sec.usdIni - 1);
    ws.mergeCells(r, sec.usdIni, r, NCOL);
    ws.getCell(r, 1).value = rotuloTotal;
    ws.getCell(r, sec.usdIni).value = total;
    ws.getCell(r, sec.usdIni).numFmt = FMT_MONEY;
    for (let c = 1; c <= NCOL; c++) {
      setCellStyle(ws.getCell(r, c), { fill: STYLES.totalFill, font: STYLES.totalFont });
      ws.getCell(r, c).alignment = { vertical: 'middle', horizontal: 'right' };
    }
    ws.getRow(r).height = 18;
    r++;
  };
  if (doc.anteriores.filas.length) {
    seccion(
      'CARGOS DE ENVÍOS ANTERIORES', doc.anteriores.nota,
      [['FECHA ENVÍO', 1, 1, 'center'], ['Nº ENVÍO', 2, sec.guiaFin, 'left'], ['CONCEPTO', sec.concIni, sec.concFin, 'left'], ['USD', sec.usdIni, NCOL, 'right']],
      doc.anteriores.filas,
      (f, fill) => {
        ws.mergeCells(r, 2, r, sec.guiaFin);
        ws.mergeCells(r, sec.concIni, r, sec.concFin);
        ws.mergeCells(r, sec.usdIni, r, NCOL);
        ws.getCell(r, 1).value = f.fecha_envio;
        ws.getCell(r, 2).value = f.guia;
        ws.getCell(r, sec.concIni).value = f.concepto;
        ws.getCell(r, sec.usdIni).value = f.monto;
        ws.getCell(r, sec.usdIni).numFmt = FMT_MONEY;
        for (let c = 1; c <= NCOL; c++) {
          setCellStyle(ws.getCell(r, c), { fill, font: c === 2 ? { ...STYLES.rowFont, bold: true } : STYLES.rowFont });
          ws.getCell(r, c).border = BORDES;
          ws.getCell(r, c).alignment = { vertical: 'middle', horizontal: c === 1 ? 'center' : c === sec.usdIni ? 'right' : 'left' };
        }
      },
      'TOTAL CARGOS DE ENVÍOS ANTERIORES', doc.anteriores.total,
    );
    r++;
  }
  if (doc.conceptos.filas.length) {
    seccion(
      'OTROS CONCEPTOS', doc.conceptos.nota,
      [['CONCEPTO', 1, sec.usdIni - 1, 'left'], ['USD', sec.usdIni, NCOL, 'right']],
      doc.conceptos.filas,
      (f, fill) => {
        ws.mergeCells(r, 1, r, sec.usdIni - 1);
        ws.mergeCells(r, sec.usdIni, r, NCOL);
        ws.getCell(r, 1).value = f.concepto;
        ws.getCell(r, sec.usdIni).value = f.monto;
        ws.getCell(r, sec.usdIni).numFmt = FMT_MONEY;
        for (let c = 1; c <= NCOL; c++) {
          setCellStyle(ws.getCell(r, c), { fill, font: STYLES.rowFont });
          ws.getCell(r, c).border = BORDES;
          ws.getCell(r, c).alignment = { vertical: 'middle', horizontal: c === sec.usdIni ? 'right' : 'left' };
        }
      },
      'TOTAL OTROS CONCEPTOS', doc.conceptos.total,
    );
    r++;
  }
  if (doc.totalLiquidacion != null) {
    r--;
    ws.mergeCells(r, 1, r, sec.usdIni - 1);
    ws.mergeCells(r, sec.usdIni, r, NCOL);
    ws.getCell(r, 1).value = 'TOTAL LIQUIDACIÓN';
    ws.getCell(r, sec.usdIni).value = doc.totalLiquidacion;
    ws.getCell(r, sec.usdIni).numFmt = FMT_MONEY;
    for (let c = 1; c <= NCOL; c++) {
      setCellStyle(ws.getCell(r, c), { fill: STYLES.headerFill, font: { ...STYLES.totalFont, size: (STYLES.totalFont.size || 10) + 1 } });
      ws.getCell(r, c).alignment = { vertical: 'middle', horizontal: 'right' };
    }
    ws.getRow(r).height = 21;
    r += 2;
  }

  ws.mergeCells(r, 1, r, NCOL);
  ws.getCell(r, 1).value = doc.pie;
  ws.getCell(r, 1).font = STYLES.noteFont;
  ws.getCell(r, 1).alignment = { horizontal: 'center' };

  return wb.xlsx.writeBuffer();
}

function nombreArchivoExport(clienteNombre, fecha, tipoCobro) {
  return nombreArchivo({ cliente_nombre: clienteNombre, fecha, tipo_cobro: tipoCobro }, 'xlsx');
}

module.exports = {
  importarSalidas,
  exportarLiquidacion,
  tipoCobroLabel,
  nombreArchivoExport,
};
