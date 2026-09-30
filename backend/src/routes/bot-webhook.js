/**
 * bot-webhook.js — la puerta por donde entran los mensajes de Telegram y WhatsApp
 * (15/09/2026).
 *
 * Es el ÚNICO grupo de rutas del asistente que va SIN sesión: del otro lado hay un
 * servidor de Meta o de Telegram, no una persona logueada. Por eso todo lo que entra acá
 * se trata como desconocido:
 *
 *   · si el canal no tiene su token cargado en el `.env`, la ruta ni escucha (404): un
 *     webhook apagado no puede ser una puerta;
 *   · Telegram tiene que traer el secreto (en la URL o en su cabecera), que es lo único
 *     que prueba que el mensaje viene de Telegram y no de cualquiera;
 *   · el número que escribe no alcanza para nada: si no tiene un vínculo activo, lo único
 *     que recibe es "no te tengo vinculado" (ver bot-canales.service.js);
 *   · se contesta 200 SIEMPRE y rápido. Si devolvemos error, Telegram y Meta reintentan el
 *     mismo mensaje una y otra vez, y el asistente terminaría contestando cinco veces lo
 *     mismo (y gastando cinco veces).
 */
const { Router } = require('express');
const canales = require('../services/bot-canales.service');

const crypto = require('crypto');

const router = Router();

const hayTelegram = () => !!(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const hayWhatsapp = () => !!((process.env.WHATSAPP_TOKEN || '').trim() && (process.env.WHATSAPP_PHONE_ID || '').trim());

/* Se atiende DESPUÉS de contestarle al canal: el modelo puede tardar unos segundos y
   Telegram/Meta cortan la espera y reintentan. */
function atenderAparte(datos) {
  setImmediate(() => {
    canales.atender(datos).catch((e) => console.error('[bot-webhook]', e && e.message));
  });
}

// ── Telegram ───────────────────────────────────────────────────────────────────────
router.post('/telegram/:secreto?', (req, res) => {
  if (!hayTelegram()) return res.status(404).json({ error: 'Canal no configurado' });
  const esperado = (process.env.TELEGRAM_WEBHOOK_SECRETO || '').trim();
  const trae = req.params.secreto || req.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!esperado || trae !== esperado) return res.status(403).json({ error: 'Secreto inválido' });

  const msg = (req.body && (req.body.message || req.body.edited_message)) || null;
  const texto = msg && msg.text;
  const chatId = msg && msg.chat && msg.chat.id;
  if (texto && chatId) {
    const de = msg.from || {};
    atenderAparte({
      canal: 'telegram', identificador: String(chatId), texto,
      nombre: [de.first_name, de.last_name].filter(Boolean).join(' ') || de.username || null,
    });
  }
  res.json({ ok: true });
});

// ── WhatsApp (Meta Cloud API) ──────────────────────────────────────────────────────
/* Meta verifica el webhook una vez, con un GET y un token que elige uno. */
router.get('/whatsapp', (req, res) => {
  const esperado = (process.env.WHATSAPP_VERIFY_TOKEN || '').trim();
  if (esperado && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === esperado) {
    return res.status(200).send(String(req.query['hub.challenge'] || ''));
  }
  res.sendStatus(403);
});

/* Firma de Meta (29/09/2026): cada POST trae X-Hub-Signature-256 = HMAC-SHA256 del body
   crudo con el "App Secret" de la aplicación. Sin eso, cualquiera que sepa un número
   vinculado podía mandarle órdenes al asistente en nombre de esa persona. Si el secreto no
   está en el .env (WHATSAPP_APP_SECRET) se avisa en el log una vez y se sigue como antes,
   para no apagar el canal de golpe. */
let avisoSinSecreto = false;
function firmaWhatsappOk(req) {
  const secreto = (process.env.WHATSAPP_APP_SECRET || '').trim();
  if (!secreto) {
    if (!avisoSinSecreto) { avisoSinSecreto = true; console.warn('[bot-webhook whatsapp] WHATSAPP_APP_SECRET no está en el .env: no se verifica la firma de Meta'); }
    return true;
  }
  const cab = String(req.get('x-hub-signature-256') || '');
  if (!cab.startsWith('sha256=') || !req.rawBody) return false;
  const esperado = crypto.createHmac('sha256', secreto).update(req.rawBody).digest('hex');
  const a = Buffer.from(cab.slice(7), 'hex'); const b = Buffer.from(esperado, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/whatsapp', (req, res) => {
  if (!hayWhatsapp()) return res.status(404).json({ error: 'Canal no configurado' });
  if (!firmaWhatsappOk(req)) return res.status(403).json({ error: 'Firma inválida' });
  try {
    const entradas = (req.body && req.body.entry) || [];
    for (const e of entradas) {
      for (const c of (e.changes || [])) {
        const v = c.value || {};
        const perfiles = v.contacts || [];
        for (const m of (v.messages || [])) {
          if (m.type !== 'text' || !m.text || !m.text.body) continue;
          const perfil = perfiles.find((p) => p.wa_id === m.from);
          atenderAparte({
            canal: 'whatsapp', identificador: m.from, texto: m.text.body,
            nombre: (perfil && perfil.profile && perfil.profile.name) || null,
          });
        }
      }
    }
  } catch (err) {
    console.error('[bot-webhook whatsapp]', err && err.message);
  }
  res.json({ ok: true });
});

module.exports = router;
