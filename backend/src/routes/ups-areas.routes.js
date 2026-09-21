// GET /api/ups-areas/buscar?pais=Argentina&cp=1917&ciudad=  → { zona, recargo, etiqueta, ... }
const { Router } = require('express');
const svc = require('../services/ups-areas.service');

const router = Router();
router.get('/buscar', async (req, res, next) => {
  try {
    const { pais, cp, ciudad } = req.query;
    if (!pais) return res.status(400).json({ error: 'pais es obligatorio' });
    if (!cp && !ciudad) return res.status(400).json({ error: 'cp o ciudad es obligatorio' });
    res.json(await svc.buscarArea({ pais, cp, ciudad }));
  } catch (e) { next(e); }
});
router.get('/resumen', async (req, res, next) => {
  try { res.json(await svc.resumen()); } catch (e) { next(e); }
});
module.exports = router;
