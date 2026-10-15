/**
 * consultas.routes.js — la pantalla "Consultas" (14/10/2026).
 *
 *   GET  /api/consultas?estado=          lista (bot | derivada | atendida | cerrada | todas)
 *   GET  /api/consultas/resumen          contadores para el menú (derivadas, no leídos)
 *   GET  /api/consultas/reglas           el texto de las reglas del filtro
 *   PUT  /api/consultas/reglas           { texto } (solo admin)
 *   POST /api/consultas/simular          { telefono, texto, nombre? } → como si escribiera un
 *                                        prospecto por el canal de prueba (solo admin)
 *   GET  /api/consultas/:id              la consulta con su hilo (marca leída)
 *   POST /api/consultas/:id/responder    { texto } → se guarda y se manda por el canal
 *   POST /api/consultas/:id/estado       { estado, motivo? } → bot | derivada | atendida | cerrada
 *
 * Todo detrás de requireAuth. La entrada de los prospectos NO está acá: entra por el
 * webhook de WhatsApp (bot-webhook.js → bot-canales.recibirMensaje).
 */
const { Router } = require('express');
const consultas = require('../services/consultas.service');
const canales = require('../services/bot-canales.service');
const { requireAdmin } = require('../middleware/auth');

const router = Router();

router.get('/', async (req, res, next) => {
  try { res.json(await consultas.listar({ estado: req.query.estado })); } catch (e) { next(e); }
});
router.get('/resumen', async (req, res, next) => {
  try { res.json(await consultas.resumen()); } catch (e) { next(e); }
});
router.get('/reglas', async (req, res, next) => {
  try { res.json({ texto: await consultas.leerReglas(), por_defecto: consultas.REGLAS_DEFAULT }); } catch (e) { next(e); }
});
router.put('/reglas', requireAdmin, async (req, res, next) => {
  try { res.json({ texto: await consultas.guardarReglas(req.body && req.body.texto, req.usuario) }); } catch (e) { next(e); }
});

/* El simulador: escribe como un prospecto por el canal de prueba. Solo admin, y el
   teléfono NO puede ser uno vinculado a un usuario del sistema (eso sería hacerse pasar
   por alguien de la oficina con sus permisos). */
router.post('/simular', requireAdmin, async (req, res, next) => {
  try {
    const telefono = String((req.body && req.body.telefono) || '').replace(/\D/g, '');
    if (!/^\d{6,15}$/.test(telefono)) return res.status(400).json({ error: 'Teléfono inválido (solo dígitos, 6 a 15)' });
    const { getDb } = require('../db');
    const v = await getDb().prepare("SELECT id FROM bot_vinculos WHERE identificador = ? AND estado = 'activo'").get(telefono);
    if (v) return res.status(409).json({ error: 'Ese teléfono está vinculado a un usuario del sistema: usá otro para simular' });
    const out = await canales.recibirMensaje({ canal: 'prueba', identificador: telefono, texto: req.body.texto, nombre: req.body.nombre, prospecto: true });
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const c = await consultas.obtener(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Consulta inexistente' });
    res.json(c);
  } catch (e) { next(e); }
});
router.post('/:id/responder', async (req, res, next) => {
  try { res.json(await consultas.responder(Number(req.params.id), req.usuario, req.body && req.body.texto)); } catch (e) { next(e); }
});
router.post('/:id/estado', async (req, res, next) => {
  try { res.json(await consultas.cambiarEstado(Number(req.params.id), req.usuario, req.body && req.body.estado, req.body && req.body.motivo)); } catch (e) { next(e); }
});

module.exports = router;
