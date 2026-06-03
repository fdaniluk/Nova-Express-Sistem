const { Router } = require('express');
const clientesRoutes = require('./clientes.routes');
const enviosRoutes = require('./envios.routes');
const liquidacionesRoutes = require('./liquidaciones.routes');
const configuracionRoutes = require('./configuracion.routes');
const dashboardRoutes = require('./dashboard');
const clienteDireccionesRoutes = require('./cliente-direcciones');
const pickupsRoutes = require('./pickups');
const operacionesRoutes = require('./operaciones');
const salidasRoutes = require('./salidas.routes');
const trackingRoutes = require('./tracking.routes');
const facturasRoutes = require('./facturas.routes');

const router = Router();

router.use('/clientes', clientesRoutes);
router.use('/clientes/:id/direcciones', clienteDireccionesRoutes);
router.use('/envios', enviosRoutes);
router.use('/salidas', salidasRoutes);
router.use('/liquidaciones', liquidacionesRoutes);
router.use('/configuracion', configuracionRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/pickups', pickupsRoutes);
router.use('/operaciones', operacionesRoutes);
router.use('/tracking', trackingRoutes);
router.use('/facturas', facturasRoutes);

router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'nova-express-api' });
});

module.exports = router;
