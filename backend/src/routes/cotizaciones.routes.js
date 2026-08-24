const { Router } = require('express');
const ctrl = require('../controllers/cotizaciones.controller');

const router = Router();
router.get('/', ctrl.listar);
router.get('/cliente/:clienteId/aceptadas', ctrl.aceptadasDeCliente);
router.get('/:id', ctrl.obtener);
router.post('/', ctrl.crear);
router.post('/:id/aceptar', ctrl.aceptar);
router.patch('/:id/estado', ctrl.cambiarEstado);
router.patch('/:id', ctrl.editar);
router.delete('/:id', ctrl.eliminar);

module.exports = router;
