const { Router } = require('express');
const clientesRoutes = require('./clientes.routes');
const tarifarioRoutes = require('./tarifario.routes');
const enviosRoutes = require('./envios.routes');
const cotizacionesRoutes = require('./cotizaciones.routes');
const liquidacionesRoutes = require('./liquidaciones.routes');
const configuracionRoutes = require('./configuracion.routes');
const dashboardRoutes = require('./dashboard');
const saludRoutes = require('./salud');
const clienteDireccionesRoutes = require('./cliente-direcciones');
const pickupsRoutes = require('./pickups');
const operacionesRoutes = require('./operaciones');
const salidasRoutes = require('./salidas.routes');
const trackingRoutes = require('./tracking.routes');
const facturasRoutes = require('./facturas.routes');
const cobranzasRoutes = require('./cobranzas.routes');
const authRoutes = require('./auth.routes');
const usuariosRoutes = require('./usuarios.routes');
const { requireAuth, requireDashboard, requireSalud, requireAdmin } = require('../middleware/auth');

const router = Router();

// Rutas públicas (sin autenticación)
router.get('/health', (req, res) => res.json({ ok: true, service: 'nova-express-api' }));
router.use('/auth', authRoutes);

// A partir de acá todo requiere sesión válida
router.use(requireAuth);

// Dashboard requiere además ver_dashboard=1
router.use('/dashboard', requireDashboard, dashboardRoutes);

// Panel de salud: admin OR ver_salud=1. Solo lectura, no escribe nada.
router.use('/salud', requireSalud, saludRoutes);

// Resto de rutas protegidas
router.use('/clientes', clientesRoutes);
router.use('/tarifario', tarifarioRoutes);
router.use('/clientes/:id/direcciones', clienteDireccionesRoutes);
router.use('/envios', enviosRoutes);
router.use('/cotizaciones', cotizacionesRoutes);
router.use('/salidas', salidasRoutes);
router.use('/liquidaciones', liquidacionesRoutes);
router.use('/configuracion', configuracionRoutes);
router.use('/pickups', pickupsRoutes);
router.use('/operaciones', operacionesRoutes);
router.use('/tracking', trackingRoutes);
router.use('/facturas', facturasRoutes);
router.use('/cobranzas', cobranzasRoutes);
router.use('/usuarios', requireAdmin, usuariosRoutes);

module.exports = router;
