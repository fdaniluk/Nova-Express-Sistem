const { Router } = require('express');
const clientesRoutes = require('./clientes.routes');
const enviosRoutes = require('./envios.routes');
const liquidacionesRoutes = require('./liquidaciones.routes');
const configuracionRoutes = require('./configuracion.routes');
const dashboardRoutes = require('./dashboard');

const router = Router();

router.use('/clientes', clientesRoutes);
router.use('/envios', enviosRoutes);
router.use('/liquidaciones', liquidacionesRoutes);
router.use('/configuracion', configuracionRoutes);
router.use('/dashboard', dashboardRoutes);

router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'nova-express-api' });
});

module.exports = router;
