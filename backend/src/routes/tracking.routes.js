const { Router } = require('express');
const { getTracking } = require('../services/ups.service');

const router = Router();

router.get('/ups/:guia', async (req, res, next) => {
  try {
    const resultado = await getTracking(req.params.guia);
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
