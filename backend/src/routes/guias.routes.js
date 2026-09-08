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

// Hoja para imprimir la etiqueta: ?formato=a4 (una por hoja, tamaño real 4×6 pulgadas
// centrado, en UNA hoja — no las dos que saca la página de UPS) o ?formato=termica
// (página de 4×6 para la impresora de etiquetas).
router.get('/:id/etiqueta.html', async (req, res, next) => {
  try {
    const row = await guias.etiqueta(req.params.id);
    if (!row) return res.status(404).send('La guía no tiene etiqueta');
    const lista = JSON.parse(row.etiqueta_gif);
    const termica = String(req.query.formato || 'a4') === 'termica';
    const pagina = termica ? 'size: 4in 6in; margin: 0;' : 'size: A4 portrait; margin: 10mm;';
    const imgs = lista.map((b64, i) => `
      <div class="pag">
        <img src="data:image/gif;base64,${b64}" alt="Etiqueta ${i + 1}" onload="if (this.naturalWidth > this.naturalHeight) this.classList.add('apaisada')">
      </div>`).join('');
    res.type('html').send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<title>Etiqueta ${esc(row.numero_guia || '')}</title>
<style>
  @page { ${pagina} }
  body { margin: 0; background: #eee; font-family: Arial, sans-serif; }
  .barra { position: sticky; top: 0; background: #1f2a44; color: #fff; padding: 8px 14px; font-size: 13px; display: flex; gap: 12px; align-items: center; }
  .barra button { background: #f26a4b; color: #fff; border: 0; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; }
  .barra a { color: #fff; }
  .pag { background: #fff; margin: 12px auto; display: flex; align-items: center; justify-content: center;
         ${termica ? 'width: 4in; height: 6in;' : 'width: 190mm; height: 277mm;'} page-break-after: always; }
  /* La etiqueta de UPS suele venir apaisada (6×4): si es más ancha que alta se rota
     para que quede en tamaño real 4×6; si ya viene vertical, se deja como está. */
  .pag img { width: 4in; height: auto; max-height: ${termica ? '6in' : '7in'}; object-fit: contain; image-rendering: crisp-edges; }
  .pag img.apaisada { height: 4in; width: auto; max-width: ${termica ? '6in' : '7in'}; transform: rotate(90deg); }
  @media print { .barra { display: none; } body { background: #fff; } .pag { margin: 0; } }
</style></head>
<body>
<div class="barra">
  <button onclick="window.print()">Imprimir</button>
  <span>Etiqueta ${esc(row.numero_guia || '')} · ${lista.length} bulto(s) · ${termica ? 'térmica 4×6' : 'A4'}${row.entorno === 'test' ? ' · PRUEBA (no válida para despachar)' : ''}</span>
  <a href="?formato=${termica ? 'a4' : 'termica'}">${termica ? 'ver en A4' : 'ver para térmica'}</a>
</div>
${imgs}
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
