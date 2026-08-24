const { Router } = require('express');
const ctrl = require('../controllers/cotizador-links.controller');

const router = Router();
router.get('/cliente/:clienteId', ctrl.listarDeCliente);
router.post('/', ctrl.crear);
router.post('/:id/baja', ctrl.darDeBaja);

module.exports = router;
