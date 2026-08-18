const router = require('express').Router();
const ctrl = require('../controllers/liquidaciones.controller');

router.get('/pendientes', ctrl.pendientes);
router.post('/preview', ctrl.preview);
router.post('/', ctrl.crear);
router.post('/cotizar', ctrl.cotizar);
router.patch('/:id/confirmar', ctrl.confirmar);
router.delete('/:id', ctrl.eliminar);
router.get('/:id', ctrl.obtener);
router.get('/:id/export', ctrl.exportar);
router.get('/', ctrl.listar);

module.exports = router;
