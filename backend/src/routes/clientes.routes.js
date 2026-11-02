const { Router } = require('express');
const ctrl = require('../controllers/clientes.controller');
const profitCtrl = require('../controllers/profit.controller');
const tarifarioCtrl = require('../controllers/tarifario.controller');
const rsCtrl = require('../controllers/razones-sociales.controller');
const { requireAdmin } = require('../middleware/auth');

const router = Router();
router.get('/', ctrl.listar);
// Antes de /:id, si no Express lo toma como un id.
router.get('/duplicados', requireAdmin, rsCtrl.duplicados);
router.post('/', ctrl.crear);
router.get('/:id/perfil', ctrl.perfil);

// Matriz de profit por cliente (ver services/profit.service.js).
router.get('/:id/profit-matrix', profitCtrl.getMatrix);
router.put('/:id/profit-matrix/bulk', profitCtrl.putMatrizMasiva);
router.put('/:id/profit-matrix', profitCtrl.putOverride);
router.delete('/:id/profit-matrix/todo', profitCtrl.vaciarMatriz);
router.delete('/:id/profit-matrix', profitCtrl.deleteOverride);
router.get('/:id/profit-resolve', profitCtrl.resolve);
// Aumento de tarifa en bloque (20/10/2026): general + matrices + precio por kilo, con deshacer.
router.post('/:id/tarifa-aumento/preview', profitCtrl.aumentoPreview);
router.post('/:id/tarifa-aumento/:aid/revertir', profitCtrl.aumentoRevertir);
router.post('/:id/tarifa-aumento', profitCtrl.aumentoAplicar);
router.get('/:id/tarifa-aumento', profitCtrl.aumentoHistorial);

// Tarifa en USD por kilo, para los clientes con modo_tarifa = 'por_kg'.
router.get('/:id/tarifa-kg', profitCtrl.getMatrixKg);
router.put('/:id/tarifa-kg', profitCtrl.putOverrideKg);
router.delete('/:id/tarifa-kg', profitCtrl.deleteOverrideKg);

// El tarifario que se le manda AL CLIENTE (ver services/tarifario.service.js).
// El .xlsx va PRIMERO: si no, Express lo toma como id y nunca llega.
// `emitir` genera la grilla Y la registra en tarifario_emitidos; `emitidos` lista lo que
// se le mandó a este cliente. La emisión completa se lee por /api/tarifario/emitidos/:id.
router.get('/:id/tarifario.xlsx', tarifarioCtrl.excel);
router.get('/:id/tarifario', tarifarioCtrl.obtener);
router.post('/:id/tarifario/emitir', tarifarioCtrl.emitir);
router.get('/:id/tarifario/emitidos', tarifarioCtrl.emitidos);

// Tramos de peso del cliente. Los usan las DOS matrices, la de porcentaje y la de kilo.
router.get('/:id/tramos', profitCtrl.getTramos);
router.put('/:id/tramos/paso', profitCtrl.putPasoTramos);
router.put('/:id/tramos', profitCtrl.putTramos);

// Razones sociales del cliente (varios CUIT / facturar a un tercero) y unir clientes duplicados.
router.get('/razones-sociales/:rid', (req, res) => res.status(405).end());
router.put('/razones-sociales/:rid', rsCtrl.editar);
router.post('/razones-sociales/:rid/mover', requireAdmin, rsCtrl.mover);
router.get('/:id/razones-sociales', rsCtrl.listar);
router.post('/:id/razones-sociales', rsCtrl.crear);
router.post('/:id/unir/preview', requireAdmin, rsCtrl.unirPreview);
router.post('/:id/unir', requireAdmin, rsCtrl.unir);

// Cargos sin envío (30/10/2026): extracargos de guías que no están en el sistema, cargados
// a mano al cliente; entran en su próxima liquidación como "cargos de envíos anteriores".
// El alta va en multipart (campo `pdf` opcional) o en JSON.
const multer = require('multer');
const cargosModel = require('../models/envio-cargos.model');
const subirPdf = (req, res, next) => {
  if (!/multipart\/form-data/i.test(req.headers['content-type'] || '')) return next();
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } }).single('pdf')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'El PDF pesa más de 8 MB.' });
    return res.status(400).json({ error: `No se pudo recibir el archivo: ${err.message}` });
  });
};
router.get('/:id/cargos', async (req, res, next) => {
  try { res.json(await cargosModel.listarSueltosDeCliente(parseInt(req.params.id, 10))); } catch (e) { next(e); }
});
router.post('/:id/cargos', subirPdf, async (req, res, next) => {
  try {
    const b = req.body || {};
    const cargo = await cargosModel.agregarSuelto(parseInt(req.params.id, 10), {
      tipo: b.tipo, label: b.label, monto: b.monto, fecha: b.fecha, guia_texto: b.guia_texto,
      adjunto: req.file ? req.file.buffer : null, adjunto_nombre: req.file ? req.file.originalname : null,
    }, req.usuario);
    res.status(201).json(cargo);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});
router.delete('/:id/cargos/:cargoId', async (req, res, next) => {
  try {
    const c = await cargosModel.obtener(parseInt(req.params.cargoId, 10));
    if (!c || c.envio_id || Number(c.cliente_id) !== parseInt(req.params.id, 10)) return res.status(404).json({ error: 'Cargo inexistente' });
    res.json(await cargosModel.anular(c.id, req.usuario));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});
router.get('/:id/cargos/:cargoId/adjunto', async (req, res, next) => {
  try {
    const c = await cargosModel.obtener(parseInt(req.params.cargoId, 10));
    if (!c || Number(c.cliente_id) !== parseInt(req.params.id, 10)) return res.status(404).json({ error: 'Cargo inexistente' });
    const a = await cargosModel.adjuntoDe(c.id);
    if (!a) return res.status(404).json({ error: 'Ese cargo no tiene PDF adjunto' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(a.nombre)}"`);
    res.send(a.pdf);
  } catch (e) { next(e); }
});

router.get('/:id', ctrl.buscarPorId);
router.put('/:id', ctrl.actualizar);
router.put('/:id/activo', ctrl.activar);
router.delete('/:id', ctrl.eliminar);

module.exports = router;
