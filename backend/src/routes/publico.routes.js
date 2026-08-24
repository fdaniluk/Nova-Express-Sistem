/**
 * publico.routes.js — las ÚNICAS rutas de la API sin sesión, aparte de /auth y /health.
 * Se montan ANTES de requireAuth en routes/index.js, a propósito y a la vista: si algún
 * día alguien agrega una ruta acá, que le pese. Solo cotizan; no leen ni escriben nada
 * más de la base que el propio link.
 */
const { Router } = require('express');
const ctrl = require('../controllers/publico.controller');

const router = Router();
router.get('/cotizador/:codigo', ctrl.abrir);
router.post('/cotizador/:codigo/cotizar', ctrl.cotizar);

module.exports = router;
