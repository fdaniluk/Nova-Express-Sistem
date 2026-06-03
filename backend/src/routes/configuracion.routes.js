const { Router } = require('express');
const ctrl = require('../controllers/configuracion.controller');

const router = Router();

router.get('/fuel', ctrl.listarFuel);
router.get('/fuel/historial', ctrl.historialFuel);
router.put('/fuel/:courier', ctrl.actualizarFuel);

router.get('/umbral', ctrl.listarUmbrales);
router.get('/umbral/historial', ctrl.historialUmbral);
router.put('/umbral/:courier', ctrl.actualizarUmbral);

module.exports = router;
