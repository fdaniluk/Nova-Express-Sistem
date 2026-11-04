// Lector de la proforma Excel de la oficina (03/11/2026, punto 4 del lote de la oficina).
//
// Las proformas que mandan los clientes tienen todas el mismo esquema (COMMERCIAL INVOICE,
// Nº y DATE arriba a la derecha, Shipper a la izquierda y Consignee a la derecha, tabla
// Quantity / Description of goods / Unit value / Total value, TOTAL USD al pie) pero cada
// una con su acomodo: la tabla arranca en otra fila, el "Nº:" está en otra celda, el HS code
// viene dentro de la descripción ("Pant (100% Polyester) Woven - For Woman 6204.62")…
// Por eso NO se lee por posiciones fijas: se buscan los rótulos y se lee desde ahí.
//
// Devuelve { numero, fecha, consignee, shipper, items[], total, avisos[] }. Solo lectura.
const ExcelJS = require('exceljs');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const txt = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.result !== undefined) return txt(v.result);
    if (v.text) return String(v.text);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(v);
};
const limpio = (v) => txt(v).replace(/\s+/g, ' ').trim();
const num = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v.result !== undefined) return num(v.result);
  const s = String(v).trim().replace(/[^\d,.-]/g, '');
  if (!s) return null;
  // "1.234,56" → 1234.56 · "1,5" → 1.5 · "60" → 60
  const n = s.includes(',') && s.includes('.') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// Fecha en cualquiera de las formas que vienen: Date, "21-10-26", "23/10/2026", "2026-10-16".
function fechaIso(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = limpio(v).replace(/^DATE\s*:?\s*/i, '');
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

// Partida arancelaria dentro de la descripción: "… 6104.43", "… 6104.62.00", "… HS 610443".
// Se saca del texto y va a su campo. Un número suelto de 6 a 10 dígitos al final también.
function separarHs(descripcion) {
  const d = limpio(descripcion);
  let m = /\b(?:HS\s*(?:CODE)?\s*:?\s*)?(\d{4}\.\d{2}(?:\.\d{2,4})?)\b/i.exec(d);
  if (!m) m = /\b(?:HS\s*(?:CODE)?\s*:?\s*)(\d{6,10})\b/i.exec(d);
  if (!m) m = /\s(\d{6,10})\s*$/.exec(d);
  if (!m) return { descripcion: d, hs: null };
  return { descripcion: d.replace(m[0], ' ').replace(/\s+/g, ' ').replace(/[\s\-–,:]+$/, '').trim(), hs: m[1] };
}

// Bloque Shipper / Consignee: desde la celda con el rótulo, hacia abajo, pares "Rótulo:" valor.
const CAMPOS_PARTE = [
  [/^address/i, 'direccion'], [/^(cp|zip|postal)/i, 'codigo_postal'], [/^city/i, 'ciudad'], [/^country/i, 'pais'],
  [/^(phone|tel)/i, 'telefono'], [/^(mail|e-?mail)/i, 'email'], [/^contact/i, 'contacto'], [/^(cuit|cuil|tax)/i, 'cuit'],
];
function leerParte(hoja, fila, col, hastaFila) {
  const parte = {};
  // "Shipper: Orange wings SRL" en una sola celda, o el valor en la celda de al lado.
  const valorDe = (f) => {
    const t = limpio(hoja.getCell(f, col).value);
    const propio = /:/.test(t) ? t.replace(/^[^:]*:\s*/, '').trim() : '';
    return propio || limpio(hoja.getCell(f, col + 1).value);
  };
  parte.nombre = valorDe(fila);
  const extra = [];
  for (let f = fila + 1; f < hastaFila; f++) {
    const t = limpio(hoja.getCell(f, col).value);
    const der = limpio(hoja.getCell(f, col + 1).value);
    if (!t && !der) continue;
    const campo = CAMPOS_PARTE.find(([re]) => re.test(t));
    if (campo) {
      const v = valorDe(f);
      if (v && !parte[campo[1]]) parte[campo[1]] = v;
    } else if (!t && der) {
      // Segunda línea del nombre (ej. "Casablanca Polo LTD" debajo de la persona de contacto).
      extra.push(der);
    } else if (t && !/:\s*$/.test(t) && !/:/.test(t)) {
      extra.push(der ? `${t} ${der}` : t);
    }
  }
  if (extra.length) parte.nombre = [parte.nombre, ...extra].filter(Boolean).join(' / ');
  return parte;
}

async function leer(buffer, nombreArchivo = '') {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (e) {
    const err = new Error(`No se pudo leer "${nombreArchivo || 'el archivo'}" como Excel (.xlsx): ${e.message}`);
    err.status = 422;
    throw err;
  }
  const avisos = [];
  // La hoja con la tabla: la primera que tenga "Quantity" / "Cantidad" y "Description".
  let hoja = null; let filaCab = null; let cols = null;
  for (const ws of wb.worksheets) {
    ws.eachRow((row, rowNumber) => {
      if (filaCab) return;
      const celdas = [];
      row.eachCell({ includeEmpty: false }, (c, colNumber) => celdas.push({ col: colNumber, t: limpio(c.value) }));
      const q = celdas.find((c) => /^(quantity|cantidad(es)?|qty)\b/i.test(c.t));
      const d = celdas.find((c) => /description|descripci/i.test(c.t));
      if (q && d) {
        hoja = ws; filaCab = rowNumber;
        const u = celdas.find((c) => /unit|unitario/i.test(c.t));
        const t = celdas.find((c) => /total/i.test(c.t));
        const h = celdas.find((c) => /\bhs\b|ncm|tariff|partida|arancel/i.test(c.t));
        cols = { cantidad: q.col, descripcion: d.col, unitario: u ? u.col : null, total: t ? t.col : null, hs: h ? h.col : null };
      }
    });
    if (filaCab) {
      // Los rótulos de valor a veces están solo en la fila de abajo, en castellano
      // ("USD Unitario" / "USD total"): se miran ahí si en la cabecera no estaban.
      const sub = ws.getRow(filaCab + 1);
      sub.eachCell({ includeEmpty: false }, (c, colNumber) => {
        const t = limpio(c.value);
        if (!cols.unitario && /unit|unitario/i.test(t)) cols.unitario = colNumber;
        if (!cols.total && /total/i.test(t)) cols.total = colNumber;
        if (!cols.hs && /\bhs\b|ncm|tariff|partida|arancel/i.test(t)) cols.hs = colNumber;
      });
      break;
    }
  }
  if (!hoja) {
    const err = new Error('No encontré la tabla de la proforma (una fila con "Quantity" o "Cantidad" y "Description").');
    err.status = 422;
    throw err;
  }

  // Nº y fecha: en cualquier celda de arriba de la tabla.
  let numero = null; let fecha = null; let titulo = null;
  let shipper = null; let consignee = null;
  for (let f = 1; f < filaCab; f++) {
    const row = hoja.getRow(f);
    row.eachCell({ includeEmpty: false }, (c, colNumber) => {
      const t = limpio(c.value);
      if (!t) return;
      if (!titulo && /invoice|packing list|proforma/i.test(t) && t.length < 40) titulo = t.toUpperCase();
      const mN = /^(?:n[º°o]|nro|no|number|invoice\s*(?:n[º°o]|no|#)?)\s*[:.#]?\s*([A-Za-z0-9\-\/]+)\s*$/i.exec(t);
      if (!numero && mN) numero = mN[1];
      else if (!numero && /^n[º°o]\s*:?\s*$/i.test(t)) numero = limpio(hoja.getCell(f, colNumber + 1).value) || null;
      if (!fecha && /^date/i.test(t)) fecha = fechaIso(c.value) || fechaIso(hoja.getCell(f, colNumber + 1).value);
      if (!fecha && c.value instanceof Date) fecha = fechaIso(c.value);
      if (!shipper && /^shipper/i.test(t)) shipper = leerParte(hoja, f, colNumber, filaCab);
      if (!consignee && /^consignee/i.test(t)) consignee = leerParte(hoja, f, colNumber, filaCab);
    });
  }

  // Renglones: desde la cabecera hacia abajo hasta TOTAL (o hasta que se corten).
  const items = [];
  const ultima = hoja.lastRow ? hoja.lastRow.number : filaCab;
  let total = null; let vacias = 0;
  for (let f = filaCab + 1; f <= ultima; f++) {
    const cant = hoja.getCell(f, cols.cantidad).value;
    const desc = limpio(hoja.getCell(f, cols.descripcion).value);
    const rowTxt = [];
    hoja.getRow(f).eachCell({ includeEmpty: false }, (c) => rowTxt.push(limpio(c.value)));
    const esTotal = rowTxt.some((t) => /^total\b/i.test(t));
    if (esTotal) {
      const nums = [];
      hoja.getRow(f).eachCell({ includeEmpty: false }, (c) => { const n = num(c.value); if (n != null && !/^total/i.test(limpio(c.value))) nums.push(n); });
      total = nums.length ? r2(nums[nums.length - 1]) : null;
      break;
    }
    // Subcabecera en castellano ("Cantidades · Descripción de mercadería …"): se saltea.
    if (/^(cantidad|cantidades|descripci)/i.test(limpio(cant)) || /^descripci/i.test(desc)) continue;
    const cantidad = num(cant);
    if (cantidad == null && !desc) { vacias++; if (vacias >= 6 && items.length) break; continue; }
    if (cantidad == null || !desc) {
      // "ORIGIN: ARGENTINA", "Manufacturer:" y similares no son renglones.
      if (desc && !/origin|manufacturer|cuit|made in/i.test(desc) && cantidad == null && items.length === 0) continue;
      continue;
    }
    vacias = 0;
    const unitario = cols.unitario ? num(hoja.getCell(f, cols.unitario).value) : null;
    const tot = cols.total ? num(hoja.getCell(f, cols.total).value) : null;
    const { descripcion, hs: hsEnTexto } = separarHs(desc);
    const hsCol = cols.hs ? limpio(hoja.getCell(f, cols.hs).value).replace(/\s+/g, '') : '';
    const valor_unitario = unitario != null ? r2(unitario) : (tot != null && cantidad ? r2(tot / cantidad) : 0);
    items.push({ cantidad, descripcion, valor_unitario, hs: hsCol || hsEnTexto || null, total: tot != null ? r2(tot) : r2(cantidad * valor_unitario) });
  }
  if (!items.length) avisos.push('La tabla está pero no encontré renglones con cantidad y descripción.');
  const suma = r2(items.reduce((s, it) => s + it.cantidad * it.valor_unitario, 0));
  if (total != null && Math.abs(suma - total) > 0.011) avisos.push(`Los renglones suman USD ${suma.toFixed(2)} y el TOTAL de la hoja dice USD ${total.toFixed(2)}: revisá antes de pedir la guía.`);
  items.forEach((it, i) => {
    if (!Number.isInteger(it.cantidad)) avisos.push(`Renglón ${i + 1}: cantidad ${it.cantidad} no es entera (UPS pide enteros).`);
    if (it.descripcion.length > 105) avisos.push(`Renglón ${i + 1}: la descripción tiene ${it.descripcion.length} letras; UPS imprime hasta 105 (se recorta).`);
  });
  return { numero, fecha, titulo, shipper, consignee, items, total: total != null ? total : suma, suma, avisos };
}

module.exports = { leer, separarHs, fechaIso };
