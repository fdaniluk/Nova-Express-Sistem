'use strict';
/**
 * etiqueta-pdf.service.js — la etiqueta térmica como PDF de 4×6 pulgadas EXACTAS.
 *
 * POR QUÉ EXISTE (10/09/2026): la oficina imprime la térmica desde etiqueta.html y en la
 * ventana de imprimir del navegador tiene que acomodar impresora, papel y márgenes cada
 * vez. Un PDF con la página de 4×6 se manda a la Zebra al tamaño justo, sin encabezados
 * del navegador y sin escalar, desde Chrome, Edge o Adobe ("tamaño real").
 *
 * CÓMO: se decodifica el GIF que devolvió UPS (omggif, sin dependencias nativas), se
 * acuesta o se para según haga falta para que quede VERTICAL (4 de ancho × 6 de alto) y se
 * escribe el PDF a mano: una página por bulto, la imagen como XObject RGB comprimido con
 * zlib. No hace falta ninguna librería de PDF.
 */
const zlib = require('zlib');
const { GifReader } = require('omggif');

const PT_W = 288; // 4 in
const PT_H = 432; // 6 in

/** GIF (Buffer) → { width, height, rgb: Buffer } del primer cuadro. */
function decodificarGif(buf) {
  const gr = new GifReader(buf);
  const width = gr.width; const height = gr.height;
  const rgba = Buffer.alloc(width * height * 4, 255);
  gr.decodeAndBlitFrameRGBA(0, rgba);
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    // El fondo transparente del GIF se pinta blanco.
    if (rgba[i + 3] === 0) { rgb[j] = 255; rgb[j + 1] = 255; rgb[j + 2] = 255; } else { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
  }
  return { width, height, rgb };
}

/** Gira 90° en sentido horario una imagen RGB (para pasar de apaisada a vertical). */
function girar90(img) {
  const { width, height, rgb } = img;
  const out = Buffer.alloc(rgb.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      const nx = height - 1 - y; const ny = x;
      const d = (ny * height + nx) * 3;
      out[d] = rgb[s]; out[d + 1] = rgb[s + 1]; out[d + 2] = rgb[s + 2];
    }
  }
  return { width: height, height: width, rgb: out };
}

/** Gira 180° (para el botón "salió cabeza abajo"). */
function girar180(img) {
  const { width, height, rgb } = img;
  const out = Buffer.alloc(rgb.length);
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const s = i * 3; const d = (n - 1 - i) * 3;
    out[d] = rgb[s]; out[d + 1] = rgb[s + 1]; out[d + 2] = rgb[s + 2];
  }
  return { width, height, rgb: out };
}

/**
 * Arma el PDF. `gifsB64`: una etiqueta por bulto. `opts.giro180`: dar vuelta todas.
 * Devuelve un Buffer.
 */
function armarPdfEtiquetas(gifsB64, opts = {}) {
  const imgs = gifsB64.map((b64) => {
    let img = decodificarGif(Buffer.from(b64, 'base64'));
    if (img.width > img.height) img = girar90(img); // apaisada → vertical
    if (opts.giro180) img = girar180(img);
    return img;
  });

  const objetos = []; // strings o Buffers, en orden; el índice+1 es el número de objeto
  const add = (o) => { objetos.push(o); return objetos.length; };

  const catalogo = add(null); // se completa al final
  const paginasObj = add(null);
  const pageIds = [];
  imgs.forEach((img, i) => {
    const flate = zlib.deflateSync(img.rgb);
    const imgId = add(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${flate.length} >>\nstream\n`),
      flate, Buffer.from('\nendstream'),
    ]));
    // La imagen se encaja en la página manteniendo la proporción, centrada.
    const esc = Math.min(PT_W / img.width, PT_H / img.height);
    const w = img.width * esc; const h = img.height * esc;
    const x = (PT_W - w) / 2; const y = (PT_H - h) / 2;
    const contenido = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im${i} Do Q`;
    const contId = add(`<< /Length ${Buffer.byteLength(contenido)} >>\nstream\n${contenido}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${paginasObj} 0 R /MediaBox [0 0 ${PT_W} ${PT_H}] /Resources << /XObject << /Im${i} ${imgId} 0 R >> >> /Contents ${contId} 0 R >>`);
    pageIds.push(pageId);
  });
  objetos[catalogo - 1] = `<< /Type /Catalog /Pages ${paginasObj} 0 R >>`;
  objetos[paginasObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  const partes = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')];
  const offsets = [];
  let pos = partes[0].length;
  objetos.forEach((o, i) => {
    offsets.push(pos);
    const cuerpo = Buffer.isBuffer(o) ? o : Buffer.from(o);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), cuerpo, Buffer.from('\nendobj\n')]);
    partes.push(b); pos += b.length;
  });
  const xref = pos;
  let tabla = `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { tabla += `${String(off).padStart(10, '0')} 00000 n \n`; });
  tabla += `trailer\n<< /Size ${objetos.length + 1} /Root ${catalogo} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  partes.push(Buffer.from(tabla));
  return Buffer.concat(partes);
}

module.exports = { armarPdfEtiquetas, decodificarGif, PT_W, PT_H };
