// /api/guias — módulo Guías (etapa 2, 08/09/2026). Ver GUIAS-UPS.md.
const { Router } = require('express');
const guias = require('../models/guias.model');
const ups = require('../services/ups-shipping.service');
const proforma = require('../services/proforma.service');

const router = Router();

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

router.get('/configuracion', (req, res) => {
  const c = ups.configuracion();
  // Sin el secreto ni el .env completo: solo lo que la pantalla necesita mostrar.
  res.json({
    entorno: c.entorno,
    cuenta: c.cuenta,
    mock: c.mock,
    shipper_completo: c.shipper_completo,
    shipper_nombre: c.shipper.nombre,
    servicios: Object.entries(ups.SERVICIO_NOMBRE).map(([codigo, nombre]) => ({ codigo, nombre, ups: ups.SERVICIO_CODIGO[codigo] })),
  });
});

router.get('/pendientes', async (req, res, next) => {
  try {
    const lista = await guias.pendientes();
    res.json(lista.map((g) => ({ ...g, envio: guias.comoEnvio(g) })));
  } catch (e) {
    next(e);
  }
});

router.get('/', async (req, res, next) => {
  try {
    res.json(await guias.listar(req.query));
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const usuario = req.usuario ? req.usuario.usuario : null;
    const r = await guias.emitir(req.body || {}, usuario);
    if (r.errores) {
      const status = r.tipo === 'ups' ? 502 : 400;
      return res.status(status).json({
        error: r.tipo === 'ups' ? 'UPS rechazó la guía' : 'Faltan datos para pedir la guía',
        errores: r.errores,
        ups_status: r.status || null,
      });
    }
    res.status(201).json(r.guia);
  } catch (e) {
    next(e);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const g = await guias.buscarPorId(req.params.id);
    if (!g) return res.status(404).json({ error: 'Guía no encontrada' });
    res.json({ ...g, envio: guias.comoEnvio(g) });
  } catch (e) {
    next(e);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const g = await guias.actualizar(req.params.id, req.body || {});
    if (!g) return res.status(404).json({ error: 'Guía no encontrada' });
    res.json(g);
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.post('/:id/anular', async (req, res, next) => {
  try {
    const r = await guias.anular(req.params.id, req.body?.nota);
    if (!r) return res.status(404).json({ error: 'Guía no encontrada' });
    if (r.errores) return res.status(502).json({ error: 'UPS no aceptó la anulación', errores: r.errores });
    res.json(r.guia);
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

// Etiqueta cruda (primer bulto, o ?bulto=N) para descargar / abrir.
router.get('/:id/etiqueta.gif', async (req, res, next) => {
  try {
    const row = await guias.etiqueta(req.params.id);
    if (!row) return res.status(404).send('La guía no tiene etiqueta');
    const lista = JSON.parse(row.etiqueta_gif);
    const i = Math.max(0, (Number(req.query.bulto) || 1) - 1);
    const b64 = lista[i] || lista[0];
    res.type('image/gif').send(Buffer.from(b64, 'base64'));
  } catch (e) {
    next(e);
  }
});

// Hoja para imprimir la etiqueta (rehecha el 10/09/2026 con la guía impresa que mandó
// Felipe — LISTA-OFICINA-10-09.md, B2/B3):
//   ?formato=termica → SOLO la etiqueta, página de 4×6 pulgadas, vertical, para la impresora
//                      de etiquetas (es la foto de la térmica de la oficina).
//   ?formato=a4      → la hoja que imprime la oficina desde UPS CampusShip: A4 vertical con
//                      las instrucciones de UPS arriba (firma del shipper y fecha), la línea
//                      "DOBLAR AQUÍ" al medio y la etiqueta APAISADA en la mitad de abajo. Se
//                      dobla por la línea: de un lado la guía, del otro las leyendas.
//   Una página por bulto en los dos formatos. El botón "Girar" da vuelta la etiqueta 180°
//   si la impresora la saca cabeza abajo (se recuerda en el navegador).
router.get('/:id/etiqueta.html', async (req, res, next) => {
  try {
    const row = await guias.etiqueta(req.params.id);
    if (!row) return res.status(404).send('La guía no tiene etiqueta');
    const lista = JSON.parse(row.etiqueta_gif);
    const termica = String(req.query.formato || 'a4') === 'termica';
    const pagina = termica ? 'size: 4in 6in; margin: 0;' : 'size: A4 portrait; margin: 12mm 14mm;';
    const instrucciones = `
      <div class="instr">
        <h2>Nova Express · Guía UPS ${esc(row.numero_guia || '')}</h2>
        <ol>
          <li><b>Asegúrese de que no haya otras etiquetas de envío o de rastreo adjuntas a su paquete.</b> Seleccione el botón Imprimir del cuadro de diálogo que aparece. Nota: si el navegador no admite esta función, seleccione Imprimir en el menú Archivo para imprimir la etiqueta.</li>
          <li><b>Factura de la aduana</b> – Se requieren 3 copias de una factura de aduanas con los datos completos para los envíos con valor comercial.</li>
          <li><b>Doble la etiqueta impresa por la línea continua que aparece abajo.</b> Coloque la etiqueta en una bolsa plástica de UPS. Si no tiene una bolsa plástica, pegue la etiqueta doblada usando cinta adhesiva transparente por encima de toda la etiqueta.</li>
          <li><b>Recolección e instalaciones para dejar paquetes</b><br>Clientes con recolección diaria: tengan listos sus envíos para el repartidor como de costumbre.<br>Para programar una recolección o para buscar una ubicación UPS, seleccione Programar una recolección o Buscar ubicaciones en el panel de navegación lateral de la ficha Envío.</li>
          <li>Para indicar su aceptación del idioma original del acuerdo con UPS tal como aparece en la página de pago de confirmación, y para autorizar a UPS a actuar como agente para el control de exportación y con finalidades de aduanas, <b>firme y feche aquí:</b></li>
        </ol>
        <div class="firma">
          <div><b>Shipper's Signature</b><span class="raya"></span></div>
          <div><b>Date of Shipment</b><span class="raya"></span></div>
        </div>
        <div class="doblar"><span>DOBLAR AQUÍ</span></div>
      </div>`;
    const paginas = lista.map((b64, i) => `
      <div class="pag">
        ${termica ? '' : instrucciones}
        <div class="etq"><img src="data:image/gif;base64,${b64}" alt="Etiqueta ${i + 1}" onload="orientar(this)"></div>
      </div>`).join('');
    res.type('html').send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<title>Etiqueta ${esc(row.numero_guia || '')}</title>
<style>
  @page { ${pagina} }
  * { box-sizing: border-box; }
  body { margin: 0; background: #eee; font-family: Arial, Helvetica, sans-serif; color: #111; }
  .barra { position: sticky; top: 0; z-index: 2; background: #1f2a44; color: #fff; padding: 8px 14px; font-size: 13px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .barra button { background: #f26a4b; color: #fff; border: 0; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; }
  .barra button.sec { background: #3b4a6b; }
  .barra a { color: #fff; }
  .pag { background: #fff; margin: 12px auto; position: relative; page-break-after: always; overflow: hidden;
         ${termica ? 'width: 4in; height: 6in;' : 'width: 182mm; height: 273mm; padding: 0;'} }
  .pag:last-child { page-break-after: auto; }
  /* ── Térmica: la etiqueta ocupa toda la página de 4×6, vertical. ── */
  ${termica ? `
  .etq { width: 4in; height: 6in; display: flex; align-items: center; justify-content: center; }
  .etq img { width: 4in; height: 6in; object-fit: contain; image-rendering: crisp-edges; }
  /* El GIF de UPS suele venir apaisado (6×4, texto de costado): se gira para que quede
     vertical como en la impresora de la oficina. */
  .etq img.apaisada { width: 6in; height: 4in; transform: rotate(90deg); }
  ` : `
  /* ── A4: instrucciones arriba, doblez al medio, etiqueta apaisada abajo (como la hoja de
     UPS CampusShip que imprime la oficina). ── */
  .instr { height: 136mm; font-size: 8.6pt; line-height: 1.3; position: relative; }
  .instr h2 { font-size: 9.5pt; margin: 0 0 3mm; }
  .instr ol { margin: 0; padding-left: 5mm; }
  .instr li { margin-bottom: 2.2mm; }
  .firma { display: flex; gap: 40mm; margin-top: 14mm; font-size: 8.6pt; }
  .firma > div { display: flex; flex-direction: column; gap: 2mm; min-width: 60mm; }
  .firma .raya { display: block; height: 0; }
  .doblar { position: absolute; left: 0; right: 0; bottom: 0; border-bottom: 1px solid #555; font-size: 8pt; }
  .doblar span { position: absolute; left: 2mm; bottom: 1mm; }
  /* La etiqueta se acuesta en un marco de 6×4 pulgadas, arriba a la izquierda de la mitad
     de abajo (como la imprime UPS). La imagen se centra en el marco y se gira alrededor de
     su centro, así el marco y la imagen girada coinciden. */
  .etq { width: 6in; height: 4in; margin: 8mm 0 0 2mm; display: flex; align-items: center; justify-content: center; }
  .etq img { width: 6in; height: 4in; object-fit: contain; image-rendering: crisp-edges; }
  /* GIF vertical (4×6) → se gira 90° para acostarlo. GIF apaisado (6×4) → ya está acostado. */
  .etq img.vertical { width: 4in; height: 6in; transform: rotate(-90deg); }
  `}
  /* "Girar": 180° más, por si la impresora la saca cabeza abajo. */
  .pag.girada .etq img { transform: rotate(180deg); }
  .pag.girada .etq img.apaisada { transform: rotate(270deg); }
  .pag.girada .etq img.vertical { transform: rotate(90deg); }
  @media print { .barra { display: none; } body { background: #fff; } .pag { margin: 0; box-shadow: none; } }
</style>
<script>
  /* Va en el <head>: las imágenes son data: y disparan onload antes de que corra un script
     puesto al final del body (la primera etiqueta quedaba sin girar). */
  var CLAVE = 'nova.etiqueta.girada.${termica ? 'termica' : 'a4'}';
  function orientar(img) {
    var apaisada = img.naturalWidth > img.naturalHeight;
    img.classList.add(apaisada ? 'apaisada' : 'vertical');
  }
  function aplicarGiro() {
    var g = false; try { g = localStorage.getItem(CLAVE) === '1'; } catch (e) {}
    document.querySelectorAll('.pag').forEach(function (p) { p.classList.toggle('girada', g); });
  }
  function girar() {
    var g = false; try { g = localStorage.getItem(CLAVE) === '1'; } catch (e) {}
    try { localStorage.setItem(CLAVE, g ? '0' : '1'); } catch (e) {}
    aplicarGiro();
  }
  document.addEventListener('DOMContentLoaded', aplicarGiro);
</script>
</head>
<body>
<div class="barra">
  <button onclick="window.print()">Imprimir</button>
  <button class="sec" onclick="girar()" title="Si sale cabeza abajo, girarla 180°">↻ Girar</button>
  <span>Etiqueta ${esc(row.numero_guia || '')} · ${lista.length} bulto(s) · ${termica ? 'térmica 4×6 (solo la etiqueta)' : 'hoja A4 para doblar (instrucciones + etiqueta)'}${row.entorno === 'test' ? ' · PRUEBA (no válida para despachar)' : ''}</span>
  <a href="?formato=${termica ? 'a4' : 'termica'}">${termica ? 'ver la hoja A4' : 'ver para la térmica'}</a>
</div>
${paginas}
</body></html>`);
  } catch (e) {
    next(e);
  }
});

router.get('/:id/proforma', async (req, res, next) => {
  try {
    const p = await proforma.armarProformaGuia(req.params.id);
    if (!p) return res.status(404).json({ error: 'Guía no encontrada' });
    res.json(p);
  } catch (e) {
    next(e);
  }
});

router.get('/:id/proforma.html', async (req, res, next) => {
  try {
    const p = await proforma.armarProformaGuia(req.params.id);
    if (!p) return res.status(404).send('Guía no encontrada');
    res.type('html').send(proforma.renderHtml(p));
  } catch (e) {
    next(e);
  }
});

module.exports = router;
