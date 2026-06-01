const { Router } = require('express');
const ctrl = require('../controllers/clientes.controller');

const router = Router();
router.get('/', ctrl.listar);
router.post('/', ctrl.crear);
router.get('/:id/perfil', ctrl.perfil);
router.get('/:id', ctrl.buscarPorId);
router.put('/:id', ctrl.actualizar);
router.delete('/:id', ctrl.eliminar);

module.exports = router;
