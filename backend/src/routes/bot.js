/**
 * bot.js — las rutas del asistente de la oficina (14/09/2026).
 *
 *   GET  /api/bot/estado                 ¿está configurado? (clave, modelo, mock)
 *   POST /api/bot/mensaje                { texto, conversacion_id? } → { conversacion_id, texto, herramientas, pendiente }
 *   GET  /api/bot/conversaciones         las últimas del usuario (admin: de todos)
 *   GET  /api/bot/conversaciones/:id     los mensajes de una, listos para pantalla
 *
 * Todo va detrás de requireAuth (routes/index.js). El asistente llama a la API con LA
 * MISMA cookie del usuario, así que no puede hacer nada que el usuario no pueda hacer
 * desde las pantallas. El detalle está en services/bot.service.js.
 */
const { Router } = require('express');
const bot = require('../services/bot.service');

const router = Router();

router.get('/estado', (req, res) => {
  res.json(bot.estado());
});

router.post('/mensaje', async (req, res, next) => {
  try {
    const { texto, conversacion_id, canal } = req.body || {};
    const out = await bot.procesarMensaje({
      usuario: req.usuario,
      cookie: req.headers.cookie || '',
      texto,
      conversacion_id: conversacion_id ? Number(conversacion_id) : null,
      canal: canal === 'telegram' ? 'telegram' : 'panel',
    });
    res.json(out);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/conversaciones', async (req, res, next) => {
  try {
    res.json(await bot.listarConversaciones(req.usuario));
  } catch (err) { next(err); }
});

router.get('/conversaciones/:id', async (req, res, next) => {
  try {
    const c = await bot.leerConversacion(Number(req.params.id), req.usuario);
    if (!c) return res.status(404).json({ error: 'Conversación no encontrada' });
    const mensajes = bot.mensajesParaPantalla(await bot.leerMensajes(c.id, 200));
    let pendiente = null;
    try { pendiente = c.accion_pendiente ? JSON.parse(c.accion_pendiente) : null; } catch { pendiente = null; }
    res.json({ id: c.id, usuario: c.usuario, canal: c.canal, creado_en: c.creado_en, pendiente, mensajes });
  } catch (err) { next(err); }
});

module.exports = router;
