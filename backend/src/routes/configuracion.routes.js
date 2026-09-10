const { Router } = require('express');
const ctrl = require('../controllers/configuracion.controller');
const { requireConfig } = require('../middleware/auth');

const router = Router();

// Los GET quedan con requireAuth (heredado del router padre): Salidas y Envíos
// leen fuel/tolerancias para funcionar. Solo la escritura (PUT) se cierra a quien
// pueda editar config: admin OR editar_config = 1 (ver requireConfig).

router.get('/fuel', ctrl.listarFuel);
router.get('/fuel/historial', ctrl.historialFuel);
router.put('/fuel/:courier', requireConfig, ctrl.actualizarFuel);

router.get('/umbral', ctrl.listarUmbrales);
router.get('/umbral/historial', ctrl.historialUmbral);
router.put('/umbral/:courier', requireConfig, ctrl.actualizarUmbral);

// Fecha desde la que el panel de salud y las bandejas de Facturas controlan (07/09).
// Próximo Nº de proforma (10/09/2026). Lo lee cualquiera (el módulo Guías lo muestra);
// lo cambia quien tiene permiso de configuración.
router.get('/proforma', ctrl.obtenerProforma);
router.put('/proforma', requireConfig, ctrl.actualizarProforma);

router.get('/corte', ctrl.obtenerCorte);
router.put('/corte', requireConfig, ctrl.actualizarCorte);

router.get('/tolerancias', ctrl.listarTolerancias);
router.put('/tolerancias/:courier', requireConfig, ctrl.actualizarTolerancias);

module.exports = router;
