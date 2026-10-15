/**
 * consultas.service.js — el filtro de las consultas de la publicidad (14/10/2026).
 *
 * Felipe pauta en Instagram y la pauta manda a la gente a escribir por WhatsApp. La
 * mayoría de esas consultas no llevan a nada ("escriben por escribir", o piden cosas que
 * Nova no hace), y Felipe las contestaba todas a mano. Acá el asistente hace la PRIMERA
 * PARTE: saluda, hace tres o cuatro preguntas (qué quiere mandar, a dónde, cuánto pesa,
 * si es empresa o particular, si es algo puntual o seguido) y DECIDE:
 *
 *   · derivar → la consulta vale: queda en la pantalla "Consultas" con el resumen, y
 *     el bot se calla. Felipe la contesta desde ahí (por el mismo WhatsApp) o desde su
 *     teléfono. Nada más que escriba la persona lo responde el bot.
 *   · cerrar  → no es para Nova (compra personal del exterior, mudanza, algo que no se
 *     puede mandar, no quiere dar datos…): se despide con amabilidad y queda cerrada.
 *
 * QUIÉN ES EL QUE ESCRIBE. Un teléfono SIN vínculo con un usuario del sistema. Es la
 * audiencia 'prospecto' del motor: no tiene sesión, no tiene cookie y no ve ninguna
 * herramienta de la oficina (ni envíos, ni venta, ni cotizador). Sus tres herramientas
 * (anotar / derivar / cerrar) solo tocan SU consulta. El bot NO da precios ni plazos: eso
 * lo decide Felipe cuando la toma.
 *
 * LAS REGLAS son texto editable desde la pantalla (Configuración → "reglas del filtro"):
 * qué vale y qué no se va a ir afinando con los chats reales, sin tocar código.
 *
 * EL HILO. Una consulta por teléfono mientras esté abierta ('bot', 'derivada' o
 * 'atendida'). Una cerrada hace más de CONSULTA_DIAS días da lugar a una nueva (la gente
 * vuelve a preguntar meses después).
 */
const { getDb } = require('../db');

const CONSULTA_DIAS = 7;        // una cerrada más vieja que esto se reabre como nueva
const HISTORIAL_BOT = 30;
const MAX_TURNOS_BOT = 12;      // después de tantos mensajes sin decidir, se deriva igual

const REGLAS_DEFAULT = [
  'VALE (derivar): alguien que de verdad quiere EXPORTAR algo desde Argentina y tiene un envío concreto en mente: sabe más o menos qué manda, a dónde y cuánto pesa. Vale más si es una empresa o si va a mandar seguido. También vale si pide hablar con una persona después de haber contado qué necesita.',
  'NO VALE (cerrar): particulares que quieren TRAER una compra personal del exterior (ropa, electrónica, repuestos para uso propio); mudanzas o efectos personales; cosas que no se pueden mandar por courier (animales, plantas, dinero, armas, alimentos frescos, líquidos inflamables, baterías sueltas); gente que solo pregunta "cuánto sale" y no dice qué, a dónde ni cuánto pesa después de dos preguntas; mensajes sin sentido o publicidad.',
  'EN DUDA: si no estás seguro, DERIVAR. Es peor perder un cliente que molestar a Felipe con una consulta de más.',
].join('\n');

function ahora() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ── Reglas (texto editable) ───────────────────────────────────────────────────── */
async function leerReglas() {
  const r = await getDb().prepare('SELECT texto FROM consultas_reglas WHERE id = 1').get();
  return (r && r.texto && String(r.texto).trim()) || REGLAS_DEFAULT;
}
async function guardarReglas(texto, usuario) {
  const v = String(texto || '').trim() || REGLAS_DEFAULT;
  await getDb().prepare(
    `INSERT INTO consultas_reglas (id, texto, actualizado_en, usuario) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET texto = excluded.texto, actualizado_en = excluded.actualizado_en, usuario = excluded.usuario`
  ).run(v, ahora(), (usuario && usuario.usuario) || null);
  return leerReglas();
}

/* ── El prompt del filtro ──────────────────────────────────────────────────────── */
function systemPrompt(consulta, reglas) {
  const datos = consulta && consulta.datos ? consulta.datos : {};
  const sabidos = Object.entries(datos).filter(([, v]) => v && v !== 'no_dice').map(([k, v]) => `${k}: ${v}`).join(' · ') || 'nada todavía';
  return [
    'Sos el asistente de Nova Express, un courier internacional de Buenos Aires que trabaja con DHL y UPS. La persona que te escribe vio nuestra publicidad en Instagram y manda un WhatsApp. Hablás en español rioplatense (vos), cálido, corto y natural: mensajes de una o dos líneas, como en WhatsApp. Nada de listas, títulos ni negritas.',
    'TU TRABAJO: hacer la primera parte de la charla y decidir si la consulta se la pasás a Felipe (el dueño, quien cotiza y cierra) o si no es para nosotros.',
    'CÓMO: preguntá de a UNA cosa por mensaje hasta saber (1) qué quiere mandar, (2) desde dónde hacia dónde, (3) peso o tamaño aproximado, (4) si es empresa o particular y (5) si es algo puntual o va a mandar seguido. Si la persona ya contó varias cosas en un mensaje, no las vuelvas a preguntar. Anotá cada dato nuevo con anotar_consulta.',
    'CUANDO TENGAS LO SUFICIENTE (no hace falta tener las 5 cosas si ya está claro), decidí con derivar_consulta o cerrar_consulta y despedite. No sigas preguntando por preguntar.',
    'REGLAS DE QUÉ VALE Y QUÉ NO:',
    reglas || REGLAS_DEFAULT,
    'PROHIBIDO: dar precios, tarifas, plazos de entrega o promesas ("llega en 3 días", "sale alrededor de…"). Si preguntan precio, decí que para cotizar necesitás los datos y que Felipe les pasa el valor. No inventes servicios, requisitos ni documentación. No digas que sos una inteligencia artificial salvo que te lo pregunten; si te lo preguntan, decí que sos el asistente de Nova y que Felipe sigue la charla.',
    'Si la persona pide hablar con alguien o se impacienta y ya contó qué necesita, derivá. Si no contó nada, pedile una vez más qué quiere mandar y si sigue sin decirlo, derivá igual (que lo vea Felipe).',
    `LO QUE YA SABÉS DE ESTA CONSULTA: ${sabidos}.`,
    `Hoy es ${new Date().toISOString().slice(0, 10)}.`,
  ].join('\n');
}

/* ── Las herramientas del prospecto ────────────────────────────────────────────── */
function datosDe(c) { try { return c.datos ? (typeof c.datos === 'string' ? JSON.parse(c.datos) : c.datos) : {}; } catch { return {}; } }

async function anotar(consulta, a) {
  const db = getDb();
  const c = await db.prepare('SELECT * FROM consultas WHERE id = ?').get(consulta.id);
  const datos = datosDe(c);
  const campos = ['nombre', 'que_envia', 'sentido', 'destino', 'peso', 'tipo', 'frecuencia', 'notas'];
  for (const k of campos) if (a[k] !== undefined && a[k] !== null && String(a[k]).trim() && a[k] !== 'no_dice') datos[k] = String(a[k]).trim().slice(0, 300);
  const nombre = datos.nombre || c.nombre;
  await db.prepare('UPDATE consultas SET datos = ?, nombre = ?, actualizado_en = ? WHERE id = ?').run(JSON.stringify(datos), nombre, ahora(), c.id);
  consulta.datos = datos; consulta.nombre = nombre;
  return { anotado: true, datos };
}

async function derivar(consulta, a) {
  const db = getDb();
  await db.prepare("UPDATE consultas SET estado = 'derivada', resumen = ?, motivo = ?, derivada_en = ?, actualizado_en = ?, no_leidos = no_leidos + 1 WHERE id = ? AND estado = 'bot'")
    .run(String(a.resumen || '').slice(0, 1000), String(a.motivo || '').slice(0, 300), ahora(), ahora(), consulta.id);
  consulta.estado = 'derivada';
  return { derivada: true };
}

async function cerrar(consulta, a) {
  const db = getDb();
  await db.prepare("UPDATE consultas SET estado = 'cerrada', resumen = ?, motivo = ?, cerrada_en = ?, actualizado_en = ? WHERE id = ? AND estado = 'bot'")
    .run(String(a.resumen || '').slice(0, 1000), String(a.motivo || '').slice(0, 300), ahora(), ahora(), consulta.id);
  consulta.estado = 'cerrada';
  return { cerrada: true };
}

/* ── El motor de mentira para las tandas (BOT_MOCK=1) ──────────────────────────────
   Determinista: pregunta en orden lo que falta y decide con dos palabras clave. No prueba
   cuán bien entiende el modelo de verdad: prueba el CIRCUITO (anotar, derivar, cerrar,
   silencio, pantalla). */
function mock(ctx, t, tl, uso, texto, tr, nombreHerr, res) {
  if (tr) {
    if (nombreHerr === 'derivar_consulta') return texto('[mock] Perfecto, ya le paso tu consulta a Felipe y te escribe por acá a la brevedad.');
    if (nombreHerr === 'cerrar_consulta') return texto('[mock] Gracias por escribir. Eso no es algo que podamos resolver nosotros. ¡Que andes bien!');
    /* anotar_consulta: seguir preguntando lo que falta */
    const d = (res && res.datos) || {};
    if (!d.que_envia) return texto('[mock] ¿Qué querés mandar?');
    if (!d.destino) return texto('[mock] ¿A qué país va?');
    if (!d.peso) return texto('[mock] ¿Cuánto pesa, más o menos?');
    if (!d.tipo) return texto('[mock] ¿Es para una empresa o sos particular?');
    return uso('derivar_consulta', { resumen: `${d.que_envia} a ${d.destino}, ${d.peso}, ${d.tipo}`, motivo: 'exportación concreta' });
  }
  if (/mudanza|traer|comprar|compré|compre\b/.test(tl)) return uso('cerrar_consulta', { resumen: t.slice(0, 120), motivo: 'fuera de lo que hacemos' });
  if (/hablar con (alguien|una persona|felipe)/.test(tl)) return uso('derivar_consulta', { resumen: t.slice(0, 120), motivo: 'pide una persona' });
  const d = datosDe(ctx.consulta);
  if (!d.que_envia && /^\s*(hola|buenas|buen d[ií]a|info|informaci[oó]n|hi)\b/.test(tl)) return texto('[mock] ¡Hola! Soy el asistente de Nova Express. Contame, ¿qué querés mandar y a dónde?');
  const a = {};
  if (!d.que_envia) a.que_envia = t.slice(0, 120);
  else if (!d.destino) a.destino = t.slice(0, 60);
  else if (!d.peso) a.peso = t.slice(0, 60);
  else if (!d.tipo) a.tipo = /empresa|negocio|pyme|fábrica|fabrica/.test(tl) ? 'empresa' : 'particular';
  if (Object.keys(a).length) return uso('anotar_consulta', a);
  return uso('derivar_consulta', { resumen: JSON.stringify(d), motivo: 'datos completos' });
}

/* ── La entrada: un mensaje de un teléfono sin vínculo ─────────────────────────────
   Lo llama bot-canales.recibirMensaje. Devuelve { respuesta, consulta_id, estado }. Si la
   consulta está derivada o la está atendiendo alguien, el bot se CALLA: guarda el mensaje
   para que se vea en la pantalla y no contesta nada. */
async function consultaAbierta(canal, telefono) {
  const db = getDb();
  const c = await db.prepare(
    `SELECT * FROM consultas WHERE canal = ? AND telefono = ? ORDER BY id DESC LIMIT 1`
  ).get(canal, telefono);
  if (!c) return null;
  if (c.estado !== 'cerrada') return c;
  const cerrada = Date.parse(String(c.cerrada_en || c.actualizado_en).replace(' ', 'T'));
  if (isFinite(cerrada) && (Date.now() - cerrada) < CONSULTA_DIAS * 86400000) return c;   // cerrada hace poco: sigue callada
  return null;
}

async function recibirDeProspecto({ canal, telefono, texto, nombre }) {
  const db = getDb();
  const bot = require('./bot.service');
  let c = await consultaAbierta(canal, telefono);
  if (!c) {
    const conv = await bot.crearConversacion(null, canal);
    const r = await db.prepare(
      `INSERT INTO consultas (canal, telefono, nombre, estado, conversacion_id, datos) VALUES (?, ?, ?, 'bot', ?, '{}')`
    ).run(canal, telefono, (nombre || '').trim() || null, conv.id);
    c = await db.prepare('SELECT * FROM consultas WHERE id = ?').get(r.lastInsertRowid || r.lastID);
  }
  c.datos = datosDe(c);

  /* Derivada, atendida por alguien o cerrada hace poco: el bot no habla. El mensaje queda
     en el hilo para que se vea en la pantalla. */
  if (c.estado !== 'bot') {
    await bot.guardarMensaje(c.conversacion_id, 'user', [{ type: 'text', text: String(texto).trim() }]);
    await db.prepare("UPDATE consultas SET no_leidos = no_leidos + 1, ultimo_mensaje_en = ?, actualizado_en = ? WHERE id = ?").run(ahora(), ahora(), c.id);
    return { respuesta: '', consulta_id: c.id, estado: c.estado, silencio: true };
  }

  /* Freno: demasiados mensajes sin decisión → se deriva igual y que lo vea Felipe. */
  const n = await db.prepare("SELECT COUNT(*) n FROM bot_mensajes WHERE conversacion_id = ? AND rol = 'user'").get(c.conversacion_id);
  if ((n && n.n) >= MAX_TURNOS_BOT) {
    await bot.guardarMensaje(c.conversacion_id, 'user', [{ type: 'text', text: String(texto).trim() }]);
    await derivar(c, { resumen: 'La charla se alargó sin decisión: la mira Felipe.', motivo: 'tope de mensajes' });
    const despedida = 'Te paso con Felipe, que sigue la charla por acá. ¡Gracias!';
    await bot.guardarMensaje(c.conversacion_id, 'assistant', [{ type: 'text', text: despedida }]);
    return { respuesta: despedida, consulta_id: c.id, estado: 'derivada' };
  }

  const reglas = await leerReglas();
  const out = await bot.procesarMensaje({
    usuario: null, cookie: null, texto, conversacion_id: c.conversacion_id, canal,
    audiencia: 'prospecto', consulta: c, reglas,
  });
  await db.prepare('UPDATE consultas SET ultimo_mensaje_en = ?, actualizado_en = ? WHERE id = ?').run(ahora(), ahora(), c.id);
  const fresca = await db.prepare('SELECT estado FROM consultas WHERE id = ?').get(c.id);
  return { respuesta: out.texto, consulta_id: c.id, estado: fresca.estado, herramientas: out.herramientas };
}

/* ── Lo que usa la pantalla ────────────────────────────────────────────────────── */
async function listar({ estado } = {}) {
  const db = getDb();
  const filas = estado && estado !== 'todas'
    ? await db.prepare('SELECT * FROM consultas WHERE estado = ? ORDER BY actualizado_en DESC LIMIT 300').all(estado)
    : await db.prepare('SELECT * FROM consultas ORDER BY actualizado_en DESC LIMIT 300').all();
  return filas.map(publica);
}
function publica(c) {
  return {
    id: c.id, canal: c.canal, telefono: c.telefono, nombre: c.nombre, estado: c.estado,
    datos: datosDe(c), resumen: c.resumen, motivo: c.motivo, no_leidos: c.no_leidos || 0,
    atendida_por: c.atendida_por, creado_en: c.creado_en, actualizado_en: c.actualizado_en,
    derivada_en: c.derivada_en, cerrada_en: c.cerrada_en, ultimo_mensaje_en: c.ultimo_mensaje_en,
    conversacion_id: c.conversacion_id,
  };
}
async function resumen() {
  const db = getDb();
  const r = await db.prepare("SELECT SUM(CASE WHEN estado = 'derivada' THEN 1 ELSE 0 END) derivadas, SUM(no_leidos) no_leidos, SUM(CASE WHEN estado = 'bot' THEN 1 ELSE 0 END) en_bot FROM consultas").get();
  return { derivadas: (r && r.derivadas) || 0, no_leidos: (r && r.no_leidos) || 0, en_bot: (r && r.en_bot) || 0 };
}
async function obtener(id) {
  const db = getDb();
  const c = await db.prepare('SELECT * FROM consultas WHERE id = ?').get(id);
  if (!c) return null;
  const bot = require('./bot.service');
  const mensajes = bot.mensajesParaPantalla(await bot.leerMensajes(c.conversacion_id, 200));
  await db.prepare('UPDATE consultas SET no_leidos = 0 WHERE id = ?').run(id);
  return { ...publica(c), no_leidos: 0, mensajes };
}

/* Una persona de la oficina contesta desde la pantalla: se guarda en el hilo (como
   'assistant', marcado con quién) y se manda por el canal. Pasa a 'atendida': el bot ya
   no habla en esa consulta. */
async function responder(id, usuario, texto) {
  const db = getDb();
  const c = await db.prepare('SELECT * FROM consultas WHERE id = ?').get(id);
  if (!c) { const e = new Error('Consulta inexistente'); e.status = 404; throw e; }
  const limpio = String(texto || '').trim();
  if (!limpio) { const e = new Error('Mensaje vacío'); e.status = 400; throw e; }
  const bot = require('./bot.service');
  const canales = require('./bot-canales.service');
  await bot.guardarMensaje(c.conversacion_id, 'assistant', [{ type: 'text', text: limpio, humano: usuario.usuario || true }]);
  await db.prepare("UPDATE consultas SET estado = CASE WHEN estado = 'cerrada' THEN 'cerrada' ELSE 'atendida' END, atendida_por = ?, actualizado_en = ? WHERE id = ?")
    .run(usuario.usuario || null, ahora(), id);
  const entrega = await canales.enviar(c.canal, c.telefono, limpio);
  return { ok: true, entrega };
}

async function cambiarEstado(id, usuario, estado, motivo) {
  const db = getDb();
  const c = await db.prepare('SELECT * FROM consultas WHERE id = ?').get(id);
  if (!c) { const e = new Error('Consulta inexistente'); e.status = 404; throw e; }
  if (!['bot', 'derivada', 'atendida', 'cerrada'].includes(estado)) { const e = new Error('Estado inválido'); e.status = 400; throw e; }
  const campos = { estado, actualizado_en: ahora() };
  if (estado === 'cerrada') { campos.cerrada_en = ahora(); if (motivo) campos.motivo = String(motivo).slice(0, 300); }
  if (estado === 'derivada') campos.derivada_en = ahora();
  if (estado === 'atendida') campos.atendida_por = usuario.usuario || null;
  const sets = Object.keys(campos).map((k) => `${k} = ?`).join(', ');
  await db.prepare(`UPDATE consultas SET ${sets} WHERE id = ?`).run(...Object.values(campos), id);
  return publica(await db.prepare('SELECT * FROM consultas WHERE id = ?').get(id));
}

module.exports = {
  REGLAS_DEFAULT, CONSULTA_DIAS, MAX_TURNOS_BOT,
  leerReglas, guardarReglas, systemPrompt, anotar, derivar, cerrar, mock,
  recibirDeProspecto, listar, resumen, obtener, responder, cambiarEstado,
};
