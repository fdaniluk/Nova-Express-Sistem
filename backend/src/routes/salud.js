// Panel de salud. Un solo endpoint de SOLO LECTURA que corre todos los chequeos.
// Toda la lógica vive en services/salud.service.js; acá solo está la ruta.
//
// El permiso es `ver_salud`, con la misma regla que el resto: el admin siempre puede,
// los demás necesitan el flag (se otorga desde Usuarios). Se separó de `ver_dashboard`
// porque son dos cosas distintas: el dashboard es la plata que se hizo, esto es lo que
// está roto.

const { Router } = require('express');
const { correrChequeos } = require('../services/salud.service');

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    res.json(await correrChequeos());
  } catch (err) {
    next(err);
  }
});

// Solo el semáforo, para la franja del Dashboard. Corre los mismos chequeos pero
// devuelve únicamente los conteos y los títulos de lo que está en rojo: la franja no
// necesita el detalle y así no se arrastra un payload grande en cada carga del
// Dashboard.
router.get('/resumen', async (req, res, next) => {
  try {
    const r = await correrChequeos();
    res.json({
      generado_en: r.generado_en,
      resumen: r.resumen,
      rojos: r.chequeos.filter((c) => c.severidad === 'rojo').map((c) => ({ id: c.id, titulo: c.titulo, cantidad: c.cantidad })),
      errores: r.chequeos.filter((c) => c.severidad === 'error').map((c) => ({ id: c.id, titulo: c.titulo })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
