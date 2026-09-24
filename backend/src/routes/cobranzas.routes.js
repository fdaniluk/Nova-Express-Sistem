const { Router } = require('express');
const multer = require('multer');
const ctrl = require('../controllers/cobranzas.controller');
const { requireConfirmarPagos } = require('../middleware/auth');

const router = Router();
// Comprobantes de pago (foto o PDF): en memoria y a disco desde el modelo.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 10 } });
router.get('/saldos', ctrl.saldos);
router.get('/clientes/:id/pendientes', ctrl.pendientes);
router.get('/clientes/:id/historial', ctrl.historial);
router.post('/comprobantes', ctrl.crearComprobante);
router.get('/tipo-cambio', ctrl.listarTC);
router.post('/tipo-cambio', ctrl.guardarTC);

// Pagos (entrega 3, 24/09/2026)
router.post('/pagos', upload.any(), ctrl.cargarPago);
router.get('/pagos/bandeja', requireConfirmarPagos, ctrl.bandejaPagos);
router.get('/pagos/:id', ctrl.obtenerPago);
router.post('/pagos/:id/confirmar', requireConfirmarPagos, ctrl.confirmarPago);
router.post('/pagos/:id/eliminar', ctrl.eliminarPago);
router.get('/clientes/:id/pagos', ctrl.pagosCliente);
router.get('/adjuntos/:valorId', ctrl.adjunto);

// Pagos que entraron solos (Mercado Pago; después Galicia). El sistema sugiere, la oficina
// revisa y pasa (POST /pagos con entrante_id), Marcelo aprueba.
router.get('/entrantes', ctrl.listarEntrantes);
router.post('/entrantes/sincronizar', ctrl.sincronizarEntrantes);
router.get('/entrantes/:id/sugerencia', ctrl.sugerenciaEntrante);
router.post('/entrantes/:id/cliente', ctrl.clienteEntrante);
router.post('/entrantes/:id/descartar', ctrl.descartarEntrante);
router.post('/entrantes/:id/reabrir', ctrl.reabrirEntrante);

module.exports = router;
