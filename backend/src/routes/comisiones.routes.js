const { Router } = require('express');
const ctrl = require('../controllers/comisiones.controller');

// Montado con requireAdmin en routes/index.js: comisiones las ven solo los admin.
const router = Router();
router.get('/vendedores', ctrl.vendedores);
router.post('/vendedores', ctrl.crearVendedor);
router.put('/vendedores/:id', ctrl.editarVendedor);
router.get('/clientes', ctrl.clientes);
router.get('/clientes/:id/historial', ctrl.historial);
router.put('/clientes/:id', ctrl.asignar);
router.delete('/clientes/:id/vigente', ctrl.deshacer);
router.get('/meses', ctrl.meses);
router.get('/resumen.xlsx', ctrl.excel);
router.get('/resumen', ctrl.resumen);
router.get('/detalle', ctrl.detalle);

module.exports = router;
