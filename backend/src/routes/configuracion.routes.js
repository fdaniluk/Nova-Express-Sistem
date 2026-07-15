const { Router } = require('express');
const ctrl = require('../controllers/configuracion.controller');
const { requireAdmin } = require('../middleware/auth');

const router = Router();

// Los GET quedan con requireAuth (heredado del router padre): Salidas y Envíos
// leen fuel/tolerancias para funcionar. Solo la escritura (PUT) se cierra a admin.

router.get('/fuel', ctrl.listarFuel);
router.get('/fuel/historial', ctrl.historialFuel);
router.put('/fuel/:courier', requireAdmin, ctrl.actualizarFuel);

router.get('/umbral', ctrl.listarUmbrales);
router.get('/umbral/historial', ctrl.historialUmbral);
router.put('/umbral/:courier', requireAdmin, ctrl.actualizarUmbral);

router.get('/tolerancias', ctrl.listarTolerancias);
router.put('/tolerancias/:courier', requireAdmin, ctrl.actualizarTolerancias);

module.exports = router;
