const { Router } = require('express');
const { getTracking } = require('../services/ups.service');

const router = Router();

// Guia UPS: "1Z" + 16 alfanumericos (18 en total), case-insensitive.
const UPS_GUIA_REGEX = /^1Z[0-9A-Z]{16}$/i;

function esGuiaUpsValida(guia) {
  return typeof guia === 'string' && UPS_GUIA_REGEX.test(guia.trim());
}

router.get('/ups/:guia', async (req, res, next) => {
  const guia = (req.params.guia || '').trim();

  if (!esGuiaUpsValida(guia)) {
    return res.status(400).json({ error: 'Numero de guia UPS invalido' });
  }

  try {
    const resultado = await getTracking(guia);
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.esGuiaUpsValida = esGuiaUpsValida;
