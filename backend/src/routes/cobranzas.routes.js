const { Router } = require('express');
const ctrl = require('../controllers/cobranzas.controller');

const router = Router();
router.get('/', ctrl.listar);
router.post('/', ctrl.crear);
router.patch('/:id', ctrl.actualizar);
router.delete('/:id', ctrl.eliminar);

module.exports = router;
