const { Router } = require('express');
const ctrl = require('../controllers/clientes.controller');
const profitCtrl = require('../controllers/profit.controller');

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

router.get('/:id', ctrl.buscarPorId);
router.put('/:id', ctrl.actualizar);
router.delete('/:id', ctrl.eliminar);

module.exports = router;
