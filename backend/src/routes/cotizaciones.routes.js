const { Router } = require('express');
const ctrl = require('../controllers/cotizaciones.controller');

const router = Router();
router.get('/', ctrl.listar);
router.get('/cliente/:clienteId/aceptadas', ctrl.aceptadasDeCliente);
// Las de los últimos N días (30 por defecto) marcadas para el historial del cliente:
// el panel que Cargar envío y Salidas muestran para reconocer el envío.
router.get('/cliente/:clienteId/recientes', ctrl.recientesDeCliente);
router.get('/:id', ctrl.obtener);
router.post('/', ctrl.crear);
router.post('/:id/aceptar', ctrl.aceptar);
router.patch('/:id/estado', ctrl.cambiarEstado);
// Qué opciones viajan al historial del cliente (el botón "Guardar este precio").
router.patch('/:id/marcas', ctrl.marcas);
router.patch('/:id', ctrl.editar);
router.delete('/:id', ctrl.eliminar);

module.exports = router;
