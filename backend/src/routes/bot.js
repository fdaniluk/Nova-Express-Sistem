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
const canales = require('../services/bot-canales.service');

const router = Router();

router.get('/estado', (req, res) => {
  res.json({ ...bot.estado(), canales: canales.estadoCanales() });
});

/* ── Teléfonos vinculados ──────────────────────────────────────────────────────────
   El código sale de acá (de una persona con sesión) y viaja por el canal. Es lo que ata
   un teléfono a un usuario: sin eso, el asistente no le contesta a nadie por Telegram ni
   por WhatsApp. */
router.get('/vinculos', async (req, res, next) => {
  try { res.json(await canales.listarVinculos(req.usuario)); } catch (err) { next(err); }
});

router.post('/vinculos', async (req, res, next) => {
  try {
    const { canal, etiqueta } = req.body || {};
    res.status(201).json(await canales.crearCodigo(req.usuario, { canal, etiqueta }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/vinculos/:id', async (req, res, next) => {
  try {
    const ok = await canales.darDeBaja(Number(req.params.id), req.usuario);
    if (!ok) return res.status(404).json({ error: 'Vínculo no encontrado' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* El simulador del panel: escribe COMO SI fuera el teléfono, por el mismo camino que van
   a usar Telegram y WhatsApp (canales.recibirMensaje). Lo único que no pasa es el último
   paso, el de entregar el mensaje: la respuesta vuelve por la pantalla.

   ⚠ El canal y el identificador NO se toman del pedido: son siempre el canal 'prueba' y el
   teléfono simulado de QUIEN está logueado. Si se aceptaran del body, cualquiera con
   sesión podría escribir haciéndose pasar por el teléfono vinculado de otro —y contestaría
   con los permisos de ese otro. El simulador es para probarse a uno mismo. */
router.post('/simular', async (req, res, next) => {
  try {
    const out = await canales.recibirMensaje({
      canal: 'prueba',
      identificador: `sim-${req.usuario.id}`,
      texto: (req.body || {}).texto,
    });
    res.json(out);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
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
