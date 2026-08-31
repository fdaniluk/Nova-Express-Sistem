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

// Una pasada del semáforo automático A PEDIDO (el job corre solo cada 4 horas; esto es
// para no esperar: después de cargar las salidas del día, o probando). Devuelve el
// resumen de la pasada. Requiere credenciales UPS en el servidor, como el job.
router.post('/refrescar', async (req, res, next) => {
  try {
    if (!(process.env.UPS_CLIENT_ID || '').trim()) {
      return res.status(503).json({ error: 'El servidor no tiene credenciales UPS configuradas' });
    }
    const { getDb } = require('../db');
    const { refrescarSemaforo } = require('../services/tracking-auto.service');
    const resumen = await refrescarSemaforo(getDb());
    res.json(resumen);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.esGuiaUpsValida = esGuiaUpsValida;
