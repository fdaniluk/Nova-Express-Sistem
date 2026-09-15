/**
 * bot-canales.service.js — el asistente por teléfono (15/09/2026).
 *
 * El motor del asistente (bot.service.js) no sabe por dónde le hablan: recibe un texto y
 * devuelve otro. Este archivo es la puerta de los CANALES — hoy el de prueba, mañana
 * Telegram y WhatsApp — y se ocupa de tres cosas que el motor no hace:
 *
 *   1. QUIÉN ES EL QUE ESCRIBE. Un mensaje de WhatsApp trae un número, no una sesión. Sin
 *      un VÍNCULO activo (ese número atado a un usuario del sistema) el asistente NO
 *      contesta nada útil: no alcanza con conocer el número del bot. La vinculación es
 *      con un código de una sola vez que la persona saca del panel y manda por el canal.
 *
 *   2. CON QUÉ PERMISOS TRABAJA. Las herramientas del motor llaman a la API del sistema
 *      con una cookie de sesión. Para un mensaje de teléfono se abre una SESIÓN EFÍMERA
 *      del usuario vinculado (minutos), se usa y se borra. Así el que escribe por WhatsApp
 *      puede exactamente lo mismo que puede en las pantallas, ni más ni menos, y no hay
 *      una segunda puerta con permisos propios. La sesión se borra SIEMPRE, aunque el
 *      mensaje falle.
 *
 *   3. EL HILO. Por teléfono nadie elige "conversación": se sigue la última de ese canal
 *      si es reciente (6 h) y, si no, se abre una nueva. Eso hace que "sí" siga
 *      significando lo que tiene que significar cuando confirma un pickup.
 *
 * EL CANAL DE PRUEBA. `canal: 'prueba'` no manda nada a ningún lado: guarda la respuesta y
 * la devuelve. El panel lo usa para escribir COMO SI fuera el teléfono, por el mismo
 * camino exacto que va a usar WhatsApp (misma función `recibirMensaje`). Lo que se prueba
 * hoy es lo que va a correr después; lo único distinto es el último paso, el de entregar.
 *
 * LO QUE VIENE (pedido de Felipe, 15/09): que un día el que escriba sea un CLIENTE, para
 * ver su estado de cuenta y pagar. Por eso el vínculo ya tiene `audiencia`
 * ('interno' | 'cliente') y `cliente_id`, y el motor filtra las herramientas por audiencia.
 * Hoy solo se crean vínculos internos; el día que se abra a clientes, las herramientas que
 * ellos pueden usar son otras (las suyas, nunca las de la oficina) y se marcan ahí.
 */
const crypto = require('crypto');
const { getDb } = require('../db');
const bot = require('./bot.service');

/* Cuánto dura el código de vinculación. Corto a propósito: es una llave. */
const CODIGO_MINUTOS = 15;
/* Cuánto dura la sesión que se abre para atender UN mensaje. */
const SESION_MINUTOS = 5;
/* Si el último mensaje del canal es más viejo que esto, se abre hilo nuevo. */
const HILO_HORAS = 6;
/* Tope de mensajes por vínculo y por hora: un freno, no una política. */
const TOPE_HORA = 60;

const CANALES = ['prueba', 'telegram', 'whatsapp'];

function ahora() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function enMinutos(min) {
  const d = new Date(Date.now() + min * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* El teléfono de WhatsApp llega en formatos distintos según de dónde venga (con o sin +,
   con el 9 argentino o sin él). Se guarda solo dígitos para que "+54 9 11 6500-2047" y
   "5491165002047" sean el mismo teléfono. */
function normalizar(canal, identificador) {
  const s = String(identificador || '').trim();
  if (canal === 'whatsapp') return s.replace(/\D/g, '');
  return s;
}

function estadoCanales() {
  return {
    prueba: true,
    telegram: !!(process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    whatsapp: !!((process.env.WHATSAPP_TOKEN || '').trim() && (process.env.WHATSAPP_PHONE_ID || '').trim()),
  };
}

/* ── Vínculos ─────────────────────────────────────────────────────────────────────── */

async function crearCodigo(usuario, { canal = 'telegram', etiqueta = '' } = {}) {
  if (!CANALES.includes(canal)) { const e = new Error('Canal desconocido'); e.status = 400; throw e; }
  const db = getDb();
  /* Un código pendiente por usuario y canal: pedir otro reemplaza el anterior, así no
     quedan llaves sueltas dando vueltas. */
  await db.prepare("UPDATE bot_vinculos SET estado = 'baja', baja_en = ? WHERE usuario_id = ? AND canal = ? AND estado = 'pendiente'")
    .run(ahora(), usuario.id, canal);
  const codigo = String(crypto.randomInt(100000, 1000000));
  const vence = enMinutos(CODIGO_MINUTOS);
  const r = await db.prepare(
    `INSERT INTO bot_vinculos (canal, usuario_id, usuario, audiencia, etiqueta, codigo, codigo_vence_en, estado)
     VALUES (?, ?, ?, 'interno', ?, ?, ?, 'pendiente')`
  ).run(canal, usuario.id, usuario.usuario || null, (etiqueta || '').trim() || null, codigo, vence);
  return { id: r.lastInsertRowid || r.lastID, canal, codigo, vence_en: vence, minutos: CODIGO_MINUTOS };
}

async function listarVinculos(usuario) {
  const db = getDb();
  const filas = usuario.rol === 'admin'
    ? await db.prepare("SELECT * FROM bot_vinculos WHERE estado <> 'baja' ORDER BY id DESC").all()
    : await db.prepare("SELECT * FROM bot_vinculos WHERE usuario_id = ? AND estado <> 'baja' ORDER BY id DESC").all(usuario.id);
  return filas.map((v) => ({
    id: v.id, canal: v.canal, etiqueta: v.etiqueta, estado: v.estado, usuario: v.usuario,
    /* El identificador se muestra recortado: es el teléfono de una persona. */
    identificador: v.identificador ? (v.canal === 'whatsapp' ? '…' + String(v.identificador).slice(-4) : v.identificador) : null,
    codigo: v.estado === 'pendiente' ? v.codigo : null,
    codigo_vence_en: v.estado === 'pendiente' ? v.codigo_vence_en : null,
    vinculado_en: v.vinculado_en, ultimo_uso_en: v.ultimo_uso_en,
  }));
}

async function darDeBaja(id, usuario) {
  const db = getDb();
  const v = await db.prepare('SELECT * FROM bot_vinculos WHERE id = ?').get(id);
  if (!v || (v.usuario_id !== usuario.id && usuario.rol !== 'admin')) return false;
  await db.prepare("UPDATE bot_vinculos SET estado = 'baja', baja_en = ? WHERE id = ?").run(ahora(), id);
  return true;
}

/* ── La sesión efímera ────────────────────────────────────────────────────────────── */
async function abrirSesion(usuarioId) {
  const token = crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await getDb().prepare('INSERT INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?,?,?)')
    .run(hash, usuarioId, new Date(Date.now() + SESION_MINUTOS * 60000).toISOString());
  return { token, hash, cookie: `nova_session=${token}` };
}
async function cerrarSesion(hash) {
  try { await getDb().prepare('DELETE FROM sesiones WHERE token_hash = ?').run(hash); } catch { /* best effort */ }
}

/* ── El hilo del canal ────────────────────────────────────────────────────────────── */
async function conversacionDelCanal(vinculo) {
  const db = getDb();
  const c = await db.prepare(
    `SELECT id, actualizado_en FROM bot_conversaciones
      WHERE usuario_id = ? AND canal = ? ORDER BY id DESC LIMIT 1`
  ).get(vinculo.usuario_id, vinculo.canal);
  if (!c) return null;
  const visto = Date.parse(String(c.actualizado_en).replace(' ', 'T'));
  if (!isFinite(visto)) return c.id;
  return (Date.now() - visto) < HILO_HORAS * 3600000 ? c.id : null;
}

async function topeSuperado(vinculoId) {
  const db = getDb();
  const r = await db.prepare(
    `SELECT COUNT(*) n FROM bot_mensajes m
       JOIN bot_conversaciones c ON c.id = m.conversacion_id
      WHERE c.id IN (SELECT id FROM bot_conversaciones WHERE usuario_id = (SELECT usuario_id FROM bot_vinculos WHERE id = ?))
        AND m.rol = 'user' AND m.creado_en >= datetime('now','localtime','-1 hour')`
  ).get(vinculoId);
  return (r && r.n) > TOPE_HORA;
}

/* ── La entrada ───────────────────────────────────────────────────────────────────────
   TODO mensaje que llega de un canal pasa por acá: el webhook de Telegram, el de WhatsApp
   y el simulador del panel. Es a propósito: lo que se prueba es el camino de verdad.

   @returns {{respuesta:string, vinculado:boolean, conversacion_id?:number}}
*/
async function recibirMensaje({ canal, identificador, texto, nombre }) {
  if (!CANALES.includes(canal)) { const e = new Error('Canal desconocido'); e.status = 400; throw e; }
  const id = normalizar(canal, identificador);
  const limpio = String(texto || '').trim();
  if (!id) { const e = new Error('Falta el identificador del canal'); e.status = 400; throw e; }
  if (!limpio) return { respuesta: '', vinculado: false, ignorado: true };

  const db = getDb();
  const vinculo = await db.prepare("SELECT * FROM bot_vinculos WHERE canal = ? AND identificador = ? AND estado = 'activo'")
    .get(canal, id);

  /* ── Sin vínculo: solo se acepta un código de vinculación ───────────────────────── */
  if (!vinculo) {
    const posible = limpio.replace(/\D/g, '');
    if (/^\d{6}$/.test(posible)) {
      const pend = await db.prepare(
        "SELECT * FROM bot_vinculos WHERE codigo = ? AND canal = ? AND estado = 'pendiente'"
      ).get(posible, canal);
      if (!pend) return { respuesta: 'Ese código no sirve. Pedí uno nuevo desde el sistema, en Asistente → Teléfonos.', vinculado: false };
      if (String(pend.codigo_vence_en) < ahora()) {
        await db.prepare("UPDATE bot_vinculos SET estado = 'baja', baja_en = ? WHERE id = ?").run(ahora(), pend.id);
        return { respuesta: `Ese código venció (duran ${CODIGO_MINUTOS} minutos). Pedí uno nuevo desde el sistema.`, vinculado: false };
      }
      /* Si ese teléfono ya estaba atado a otro usuario, se da de baja el anterior: el
         código lo sacó alguien que entró al sistema con su clave, así que manda el nuevo. */
      await db.prepare("UPDATE bot_vinculos SET estado = 'baja', baja_en = ? WHERE canal = ? AND identificador = ? AND estado = 'activo'")
        .run(ahora(), canal, id);
      await db.prepare(
        "UPDATE bot_vinculos SET identificador = ?, estado = 'activo', vinculado_en = ?, codigo = NULL, codigo_vence_en = NULL, etiqueta = COALESCE(NULLIF(etiqueta,''), ?) WHERE id = ?"
      ).run(id, ahora(), (nombre || '').trim() || null, pend.id);
      return {
        respuesta: `Listo, quedaste vinculado como ${pend.usuario || 'usuario del sistema'}. Escribime lo que necesites: una guía, la venta del día, una cotización o un pickup.`,
        vinculado: true, recien_vinculado: true,
      };
    }
    return {
      respuesta: 'No te tengo vinculado, así que no puedo responderte. Entrá al sistema, andá a Asistente → Teléfonos, sacá un código y mandámelo por acá.',
      vinculado: false,
    };
  }

  /* ── Con vínculo: se atiende con SU usuario y SUS permisos ──────────────────────── */
  if (await topeSuperado(vinculo.id)) {
    return { respuesta: 'Muchos mensajes seguidos. Esperá un rato y seguimos.', vinculado: true, frenado: true };
  }
  const usuario = await db.prepare('SELECT id, usuario, rol FROM usuarios WHERE id = ?').get(vinculo.usuario_id);
  if (!usuario) return { respuesta: 'Tu usuario del sistema ya no existe. Pedile a un administrador que lo revise.', vinculado: false };

  const sesion = await abrirSesion(usuario.id);
  try {
    const conversacion_id = await conversacionDelCanal(vinculo);
    const out = await bot.procesarMensaje({
      usuario, cookie: sesion.cookie, texto: limpio, conversacion_id, canal: vinculo.canal,
      audiencia: vinculo.audiencia || 'interno',
    });
    await db.prepare('UPDATE bot_vinculos SET ultimo_uso_en = ? WHERE id = ?').run(ahora(), vinculo.id);
    return { respuesta: out.texto, vinculado: true, conversacion_id: out.conversacion_id, herramientas: out.herramientas, pendiente: out.pendiente };
  } finally {
    await cerrarSesion(sesion.hash);
  }
}

/* ── La salida ────────────────────────────────────────────────────────────────────────
   Entregar por el canal. El de prueba no entrega nada (la respuesta ya vuelve por la
   pantalla). Telegram y WhatsApp quedan escritos y apagados: sin token no se llama a
   nadie. Cuando Felipe tenga el número de WhatsApp aprobado por Meta, esto es lo único
   que se enciende. */
async function enviar(canal, identificador, texto) {
  if (canal === 'prueba') return { entregado: false, motivo: 'canal de prueba' };
  if (canal === 'telegram') {
    const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!token) return { entregado: false, motivo: 'sin TELEGRAM_BOT_TOKEN' };
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: identificador, text: texto }),
    });
    return { entregado: r.ok, status: r.status };
  }
  if (canal === 'whatsapp') {
    const token = (process.env.WHATSAPP_TOKEN || '').trim();
    const phoneId = (process.env.WHATSAPP_PHONE_ID || '').trim();
    if (!token || !phoneId) return { entregado: false, motivo: 'sin WHATSAPP_TOKEN / WHATSAPP_PHONE_ID' };
    /* Respuesta dentro de la ventana de servicio de 24 h: mensaje de texto común, que en
       la plataforma de Meta no se cobra. Las plantillas (que sí se cobran) no se usan. */
    const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: identificador, type: 'text', text: { body: texto } }),
    });
    return { entregado: r.ok, status: r.status };
  }
  return { entregado: false, motivo: 'canal desconocido' };
}

/* Recibir + contestar por el mismo canal. Es lo que usan los webhooks. */
async function atender({ canal, identificador, texto, nombre }) {
  const out = await recibirMensaje({ canal, identificador, texto, nombre });
  if (out.respuesta) await enviar(canal, normalizar(canal, identificador), out.respuesta);
  return out;
}

module.exports = {
  CANALES, CODIGO_MINUTOS, HILO_HORAS, TOPE_HORA,
  estadoCanales, crearCodigo, listarVinculos, darDeBaja,
  recibirMensaje, enviar, atender, normalizar,
};
