// Costos de la empresa (08/10/2026). Ver services/costos.service.js.
// Dos niveles: cualquier empleado logueado carga y ve los gastos del día a día (categorías
// de oficina); con ver_costos (o admin) se ve y se maneja todo. El filtro lo hace el
// servicio con req.usuario; acá solo se protege lo que es exclusivo de dirección.
const { Router } = require('express');
const { requireCostos } = require('../middleware/auth');
const S = require('../services/costos.service');

const router = Router();

const mesDe = (q) => {
  if (q.mes) return String(q.mes);
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// El mes completo (o solo los gastos del día a día si no hay permiso).
router.get('/', async (req, res, next) => {
  try { res.json(await S.resumenMes(mesDe(req.query || {}), req.usuario)); } catch (e) { next(e); }
});

router.get('/categorias', async (req, res, next) => {
  try {
    const todo = S.puedeTodo(req.usuario);
    res.json(await S.listarCategorias({ soloOficina: !todo, incluirInactivas: todo && req.query.todas === '1' }));
  } catch (e) { next(e); }
});
router.post('/categorias', requireCostos, async (req, res, next) => {
  try { res.status(201).json(await S.crearCategoria(req.body || {})); } catch (e) { next(e); }
});
router.put('/categorias/:id', requireCostos, async (req, res, next) => {
  try { res.json(await S.editarCategoria(Number(req.params.id), req.body || {})); } catch (e) { next(e); }
});

// Dólar del mes (solo dirección lo cambia; todos pueden leerlo).
router.get('/tc', async (req, res, next) => {
  try { res.json(await S.tipoCambioMes(mesDe(req.query || {}))); } catch (e) { next(e); }
});
router.put('/tc', requireCostos, async (req, res, next) => {
  try { res.json(await S.guardarTipoCambioMes(String((req.body || {}).mes || ''), (req.body || {}).tc, req.usuario)); } catch (e) { next(e); }
});

// Copiar los fijos del mes anterior.
router.post('/traer-fijos', requireCostos, async (req, res, next) => {
  try { res.json(await S.traerFijos(String((req.body || {}).mes || mesDe({})), req.usuario)); } catch (e) { next(e); }
});

// Serie para el Dashboard.
router.get('/serie', requireCostos, async (req, res, next) => {
  try { res.json(await S.seriePorMes(String(req.query.desde || ''), String(req.query.hasta || ''))); } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try { res.status(201).json(await S.crearCosto(req.body || {}, req.usuario)); } catch (e) { next(e); }
});
router.put('/:id', async (req, res, next) => {
  try { res.json(await S.editarCosto(Number(req.params.id), req.body || {}, req.usuario)); } catch (e) { next(e); }
});
router.delete('/:id', async (req, res, next) => {
  try { res.json(await S.eliminarCosto(Number(req.params.id), req.usuario)); } catch (e) { next(e); }
});
router.post('/:id/confirmar', requireCostos, async (req, res, next) => {
  try { res.json(await S.confirmarCosto(Number(req.params.id), req.usuario, req.body || {})); } catch (e) { next(e); }
});

module.exports = router;
