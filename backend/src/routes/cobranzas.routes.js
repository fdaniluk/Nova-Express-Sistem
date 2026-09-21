const { Router } = require('express');
const ctrl = require('../controllers/cobranzas.controller');

const router = Router();
router.get('/saldos', ctrl.saldos);
router.get('/clientes/:id/pendientes', ctrl.pendientes);
router.get('/clientes/:id/historial', ctrl.historial);
router.post('/comprobantes', ctrl.crearComprobante);
router.get('/tipo-cambio', ctrl.listarTC);
router.post('/tipo-cambio', ctrl.guardarTC);

module.exports = router;
