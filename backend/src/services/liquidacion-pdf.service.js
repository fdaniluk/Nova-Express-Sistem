'use strict';
// PDF de la liquidación (04/11/2026, pedido de Felipe: "que te dé la opción de sacarlas en
// Excel o en PDF"). Mismo documento que el Excel (liquidacion-documento.js), dibujado con
// pdfkit (JavaScript puro, sin Chrome ni dependencias del sistema). A4 apaisado; si la
// tabla no entra en una hoja, sigue en la siguiente con la cabecera de la tabla repetida.
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { armarDocumento } = require('./liquidacion-documento');

const AZUL = '#2A3661';
const CORAL = '#EA6749';
const SUAVE = '#EAF1F8';
const GRIS = '#6B6478';
const TEXTO = '#2B2536';
const BORDE = '#C4BDD3';
const BORDE_FINO = '#E3E6EE';

const LOGO_PATH = path.join(__dirname, '..', '..', '..', 'frontend', 'assets', 'logos', 'nova.png');
let logoBuffer = null;
function leerLogo() {
  if (logoBuffer === null) {
    try { logoBuffer = fs.readFileSync(LOGO_PATH); } catch { logoBuffer = false; }
  }
  return logoBuffer || null;
}

// "$1.294,76" (formato argentino, como lo ve el cliente en el Excel).
function usd(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const neg = v < 0;
  const [ent, dec] = Math.abs(v).toFixed(2).split('.');
  const miles = ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}$${miles},${dec}`;
}
function kg(n) {
  const [ent, dec] = (Math.round((Number(n) || 0) * 100) / 100).toFixed(2).split('.');
  return `${ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
}

async function exportarLiquidacionPdf(liquidacion) {
  const doc = armarDocumento(liquidacion);
  const pdf = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, info: { Title: doc.cabecera.titulo, Author: 'Nova Express' } });
  const chunks = [];
  pdf.on('data', (c) => chunks.push(c));
  const listo = new Promise((resolve, reject) => { pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });

  const M = 28;
  const ANCHO = pdf.page.width - M * 2;
  const ALTO_PAG = pdf.page.height - M;
  let y = M;

  // Anchos de columna proporcionales al ancho de página.
  const cols = doc.columnas;
  const sumaPdf = cols.reduce((s, c) => s + c.pdf, 0);
  const anchos = cols.map((c) => (c.pdf / sumaPdf) * ANCHO);
  const xDe = (i) => M + anchos.slice(0, i).reduce((s, a) => s + a, 0);
  const idx = {};
  cols.forEach((c, i) => { idx[c.key] = i; });

  // Un texto más ancho que su celda se recorta con "…" (pdfkit, con lineBreak:false, lo
  // dejaría salirse de la celda o lo partiría si se pide ellipsis).
  const recortar = (t, w) => {
    if (pdf.widthOfString(t) <= w) return t;
    let s = t;
    while (s.length > 1 && pdf.widthOfString(s + '…') > w) s = s.slice(0, -1);
    return s + '…';
  };
  const texto = (t, x, yy, w, { align = 'left', size = 8.5, bold = false, italic = false, color = TEXTO } = {}) => {
    pdf.font(bold ? (italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : (italic ? 'Helvetica-Oblique' : 'Helvetica'))
      .fontSize(size).fillColor(color);
    pdf.text(recortar(String(t ?? ''), Math.max(w - 6, 1)), x + 3, yy, { width: Math.max(w - 6, 1), align, lineBreak: false });
  };
  const rect = (x, yy, w, h, fill, stroke) => {
    if (fill) pdf.rect(x, yy, w, h).fill(fill);
    if (stroke) pdf.rect(x, yy, w, h).lineWidth(0.5).stroke(stroke);
  };

  // ── Cabecera ──
  const logo = leerLogo();
  if (logo) pdf.image(logo, M, y, { width: 118 });
  const dAncho = 250;
  const dX = M + ANCHO - dAncho;
  const tX = M + 130;
  const tW = dX - tX - 10;
  texto(doc.cabecera.titulo, tX, y + 10, tW, { align: 'center', size: 17, bold: true, color: AZUL });
  texto(doc.cabecera.subtitulo, tX, y + 32, tW, { align: 'center', size: 9.5, bold: true, color: CORAL });
  const dAltoFila = 14;
  const dAlto = doc.cabecera.datos.length * dAltoFila + 10;
  rect(dX, y, dAncho, dAlto, '#FAFAFC', BORDE);
  doc.cabecera.datos.forEach(([label, value], i) => {
    const yy = y + 5 + i * dAltoFila;
    texto(label, dX, yy, 78, { align: 'right', size: 8.5, color: GRIS });
    texto(value, dX + 82, yy, dAncho - 86, { size: 8.5, bold: true, color: AZUL });
  });
  y += Math.max(dAlto, 56) + 10;
  rect(M, y, ANCHO, 3, CORAL);
  y += 12;

  // ── Tabla de envíos ──
  const ALTO_CAB = 22;
  const ALTO_FILA = 17;
  const ALTO_SUB = 13;
  const cabeceraTabla = () => {
    rect(M, y, ANCHO, ALTO_CAB, AZUL);
    cols.forEach((c, i) => {
      // Un rótulo que no entra en su columna se parte en dos líneas por el espacio del medio.
      pdf.font('Helvetica-Bold').fontSize(7);
      const partes = c.label.split(' ');
      if (pdf.widthOfString(c.label) > anchos[i] - 6 && partes.length > 1) {
        const mitad = Math.ceil(partes.length / 2);
        texto(partes.slice(0, mitad).join(' '), xDe(i), y + 3, anchos[i], { align: 'center', size: 7, bold: true, color: '#FFFFFF' });
        texto(partes.slice(mitad).join(' '), xDe(i), y + 11, anchos[i], { align: 'center', size: 7, bold: true, color: '#FFFFFF' });
      } else {
        texto(c.label, xDe(i), y + 7, anchos[i], { align: 'center', size: 7, bold: true, color: '#FFFFFF' });
      }
      pdf.rect(xDe(i), y, anchos[i], ALTO_CAB).lineWidth(0.5).stroke(BORDE);
    });
    y += ALTO_CAB;
  };
  const nuevaPagina = () => { pdf.addPage(); y = M; };
  const asegurar = (h) => { if (y + h > ALTO_PAG) { nuevaPagina(); cabeceraTabla(); } };
  cabeceraTabla();

  for (const fila of doc.filas) {
    if (fila.tipo === 'envio') {
      asegurar(ALTO_FILA);
      rect(M, y, ANCHO, ALTO_FILA, SUAVE);
      cols.forEach((c, i) => {
        const v = fila.celdas[c.key];
        const t = c.formato === 'usd' ? usd(v) : c.formato === 'peso' ? kg(v) : v;
        texto(t, xDe(i), y + 5, anchos[i], { align: c.alinear, size: 8.5, bold: !!c.negrita });
        pdf.rect(xDe(i), y, anchos[i], ALTO_FILA).lineWidth(0.5).stroke(BORDE);
      });
      y += ALTO_FILA;
    } else {
      asegurar(ALTO_SUB);
      cols.forEach((c, i) => {
        // La flecha ↳ no existe en la fuente estándar del PDF: se dibuja con ›.
        if (c.key === 'desglose') texto(String(fila.celdas.desglose).replace('↳', '›'), xDe(i), y + 3, anchos[i], { size: 7.8, italic: true, color: GRIS });
        if (c.key === 'adicional') texto(usd(fila.celdas.adicional), xDe(i), y + 3, anchos[i], { align: 'right', size: 7.8, italic: true, color: GRIS });
        pdf.rect(xDe(i), y, anchos[i], ALTO_SUB).lineWidth(0.4).stroke(BORDE_FINO);
      });
      y += ALTO_SUB;
    }
  }
  if (doc.sinEnvios) {
    asegurar(ALTO_FILA);
    rect(M, y, ANCHO, ALTO_FILA, null, BORDE);
    texto('Sin envíos en este período · ver las secciones de abajo.', M, y + 5, ANCHO, { align: 'center', italic: true });
    y += ALTO_FILA;
  }
  asegurar(ALTO_FILA + 2);
  rect(M, y, ANCHO, ALTO_FILA + 2, CORAL);
  texto(doc.rotuloTotalEnvios, M, y + 6, xDe(idx.tipo + 1) - M, { align: 'center', bold: true, color: '#FFFFFF' });
  for (const key of ['peso', 'flete', 'fuel', 'seguro', 'adicional', 'total']) {
    const i = idx[key];
    texto(key === 'peso' ? kg(doc.totales[key]) : usd(doc.totales[key]), xDe(i), y + 6, anchos[i], { align: 'right', bold: true, color: '#FFFFFF' });
  }
  y += ALTO_FILA + 2 + 14;

  // ── Secciones ──
  const seccion = (titulo, nota, cabeceras, filas, pintar, rotuloTotal, total) => {
    asegurar(60);
    texto(titulo, M, y, ANCHO, { size: 9, bold: true, color: CORAL });
    y += 13;
    texto(nota, M, y, ANCHO, { size: 7.8, italic: true, color: GRIS });
    y += 14;
    rect(M, y, ANCHO, 16, SUAVE, BORDE);
    for (const [label, x, w, align] of cabeceras) texto(label, x, y + 4, w, { align, size: 7.5, bold: true, color: AZUL });
    y += 16;
    filas.forEach((f, i) => {
      if (y + 16 > ALTO_PAG) nuevaPagina();
      rect(M, y, ANCHO, 16, i % 2 === 0 ? '#FFFFFF' : SUAVE, BORDE);
      pintar(f);
      y += 16;
    });
    if (y + 18 > ALTO_PAG) nuevaPagina();
    rect(M, y, ANCHO, 18, CORAL);
    texto(rotuloTotal, M, y + 5, ANCHO - 110, { align: 'right', bold: true, color: '#FFFFFF' });
    texto(usd(total), M + ANCHO - 110, y + 5, 110, { align: 'right', bold: true, color: '#FFFFFF' });
    y += 18;
  };
  const xUsd = M + ANCHO - 110;
  if (doc.anteriores.filas.length) {
    const xGuia = M + 70; const xConc = M + 200;
    seccion('CARGOS DE ENVÍOS ANTERIORES', doc.anteriores.nota,
      [['FECHA ENVÍO', M, 70, 'center'], ['Nº ENVÍO', xGuia, 130, 'left'], ['CONCEPTO', xConc, xUsd - xConc, 'left'], ['USD', xUsd, 110, 'right']],
      doc.anteriores.filas,
      (f) => {
        texto(f.fecha_envio, M, y + 4, 70, { align: 'center' });
        texto(f.guia, xGuia, y + 4, 130, { bold: true });
        texto(f.concepto, xConc, y + 4, xUsd - xConc);
        texto(usd(f.monto), xUsd, y + 4, 110, { align: 'right' });
      },
      'TOTAL CARGOS DE ENVÍOS ANTERIORES', doc.anteriores.total);
    y += 12;
  }
  if (doc.conceptos.filas.length) {
    seccion('OTROS CONCEPTOS', doc.conceptos.nota,
      [['CONCEPTO', M, xUsd - M, 'left'], ['USD', xUsd, 110, 'right']],
      doc.conceptos.filas,
      (f) => {
        texto(f.concepto, M, y + 4, xUsd - M);
        texto(usd(f.monto), xUsd, y + 4, 110, { align: 'right' });
      },
      'TOTAL OTROS CONCEPTOS', doc.conceptos.total);
    y += 12;
  }
  if (doc.totalLiquidacion != null) {
    y -= 12;
    if (y + 20 > ALTO_PAG) nuevaPagina();
    rect(M, y, ANCHO, 20, AZUL);
    texto('TOTAL LIQUIDACIÓN', M, y + 5, ANCHO - 110, { align: 'right', size: 10, bold: true, color: '#FFFFFF' });
    texto(usd(doc.totalLiquidacion), xUsd, y + 5, 110, { align: 'right', size: 10, bold: true, color: '#FFFFFF' });
    y += 20 + 14;
  }

  if (y + 14 > ALTO_PAG) nuevaPagina();
  texto(doc.pie, M, y + 4, ANCHO, { align: 'center', size: 8, italic: true, color: GRIS });

  pdf.end();
  return listo;
}

module.exports = { exportarLiquidacionPdf, usd };
