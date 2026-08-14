const { Router } = require('express');
const ctrl = require('../controllers/clientes.controller');
const profitCtrl = require('../controllers/profit.controller');
const tarifarioCtrl = require('../controllers/tarifario.controller');

const router = Router();
router.get('/', ctrl.listar);
router.post('/', ctrl.crear);
router.get('/:id/perfil', ctrl.perfil);

// Matriz de profit por cliente (ver services/profit.service.js).
router.get('/:id/profit-matrix', profitCtrl.getMatrix);
router.put('/:id/profit-matrix', profitCtrl.putOverride);
router.delete('/:id/profit-matrix', profitCtrl.deleteOverride);
router.get('/:id/profit-resolve', profitCtrl.resolve);

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
router.put('/:id/tramos', profitCtrl.putTramos);

router.get('/:id', ctrl.buscarPorId);
router.put('/:id', ctrl.actualizar);
router.delete('/:id', ctrl.eliminar);

module.exports = router;
