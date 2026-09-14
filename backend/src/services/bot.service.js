/**
 * bot.service.js — el asistente de la oficina (14/09/2026).
 *
 * Idea de Felipe (12/09): un asistente que trabaje sobre la base del sistema — "que arme
 * una cotización, que cargue un pick up, que consulte por alguna guía, cómo viene la
 * venta del día". Plan acordado en IDEAS-COTIZACIONES-Y-BOT.md §G.
 *
 * CÓMO ESTÁ ARMADO
 *
 *   · UN SOLO MOTOR. El modelo (Claude, por la API de Anthropic) recibe el pedido en
 *     lenguaje natural y elige una HERRAMIENTA de la lista de abajo. Cada herramienta
 *     llama a LAS MISMAS RUTAS de la API que usan las pantallas (`/api/envios`,
 *     `/api/dashboard/analitica`, `/api/liquidaciones/cotizar`, `/api/pickups`…), con la
 *     cookie de sesión del usuario que está chateando. Nada se duplica: si el cotizador
 *     cambia, el asistente cambia solo; si el usuario no puede ver el dashboard, el
 *     asistente tampoco (le contesta el mismo 403).
 *
 *   · CONSULTAS LIBRES, ESCRITURAS EN DOS PASOS. Buscar, cotizar o mirar la venta no
 *     tocan la base. Cargar un pickup sí, y por eso va en dos herramientas:
 *     `proponer_pickup` valida y deja la ACCIÓN PENDIENTE guardada en la conversación (no
 *     escribe), y `confirmar_pickup` recién graba cuando la persona dijo que sí. Si no
 *     hay pendiente, confirmar no hace nada. Y en las notas del pickup queda quién lo
 *     pidió ("Cargado por el asistente a pedido de <usuario>").
 *
 *   · LO QUE SE LE MANDA AL MODELO YA VIENE FILTRADO. La ruta de cotizar devuelve costo
 *     y profit (es interna); acá se pasa por LISTA BLANCA antes de que el modelo lo vea,
 *     así el asistente NO puede repetir el margen aunque se lo pidan. Es la misma regla
 *     de la tarjeta del cotizador: lo que se copia a un cliente no puede llevar nuestro
 *     costo. Si algún día hace falta el profit por chat, es una decisión de Felipe y una
 *     herramienta aparte.
 *
 *   · SIN CLAVE, SIN ASISTENTE. `ANTHROPIC_API_KEY` en el `.env` de la raíz. Si falta,
 *     `estado()` lo dice y el panel avisa; no se intenta nada.
 *
 *   · `BOT_MOCK=1`: un motor de mentira, determinista, que reconoce el pedido por
 *     patrones y usa LAS MISMAS herramientas. Es para las tandas: prueban el circuito
 *     entero (mensaje → herramienta → API → respuesta → historial) sin clave, sin red y
 *     sin gastar. Lo que NO prueba es cuán bien entiende el modelo real.
 *
 *   · Las conversaciones quedan en `bot_conversaciones` / `bot_mensajes` con el formato
 *     de mensajes de la API (bloques de texto, tool_use y tool_result), así se puede
 *     retomar una conversación y, cuando llegue Telegram, es el mismo historial.
 */
const { getDb } = require('../db');
const config = require('../config');
const { hoyLocal, hoyLocalMas } = require('../utils/fecha');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MODELO_DEFAULT = 'claude-sonnet-4-5';
/* Cuántas idas y vueltas modelo → herramienta → modelo por UN mensaje de la persona.
   Una consulta normal usa 1 o 2; el tope frena un modelo que se quede en bucle. */
const MAX_VUELTAS = 6;
/* Cuántos mensajes viejos de la conversación viajan con cada pedido. */
const HISTORIAL = 30;

function apiKey() { return (process.env.ANTHROPIC_API_KEY || '').trim(); }
function esMock() { return process.env.BOT_MOCK === '1'; }
function modelo() { return (process.env.BOT_MODELO || '').trim() || MODELO_DEFAULT; }

function estado() {
  return {
    disponible: esMock() || !!apiKey(),
    mock: esMock(),
    modelo: esMock() ? 'mock' : modelo(),
    sin_clave: !esMock() && !apiKey(),
  };
}

/* ── El puente a la API del sistema ────────────────────────────────────────────────
   Cada herramienta llama a la API por HTTP contra el propio servidor, con la cookie de
   la persona. Así los permisos son los de siempre y no hay una segunda puerta. */
function baseInterna() {
  return `http://127.0.0.1:${config.port}`;
}

async function api(cookie, metodo, ruta, body) {
  const r = await fetch(baseInterna() + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let datos = null;
  try { datos = await r.json(); } catch { datos = null; }
  if (!r.ok) {
    const msg = (datos && datos.error) || `HTTP ${r.status}`;
    return { error: msg, status: r.status };
  }
  return datos;
}

const n2 = (v) => (v === null || v === undefined || isNaN(Number(v)) ? null : Math.round(Number(v) * 100) / 100);

/* Facturable con la MISMA regla que el motor y el resumen del cotizador: medio kilo para
   arriba POR BULTO, y después se suman. */
function pesoFacturable(bultos) {
  return Math.round(bultos.reduce((s, b) => {
    const pv = (b.largo || 0) * (b.ancho || 0) * (b.alto || 0) / 5000;
    return s + Math.ceil(Math.max(b.peso_real || 0, pv) * 2) / 2;
  }, 0) * 1000) / 1000;
}

/* Fechas que la gente dice ("hoy", "ayer", "mañana", "este mes") → YYYY-MM-DD. El modelo
   ya recibe la fecha de hoy en el system prompt, pero esto cubre lo que llega crudo. */
function resolverFecha(v) {
  if (!v) return hoyLocal();
  const s = String(v).trim().toLowerCase();
  if (s === 'hoy') return hoyLocal();
  if (s === 'ayer') return hoyLocalMas(-1);
  if (s === 'mañana' || s === 'manana') return hoyLocalMas(1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : hoyLocal().slice(0, 4);
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return s;
}

/* ── Las herramientas ───────────────────────────────────────────────────────────────
   Cada una: `definicion` (lo que ve el modelo) y `ejecutar(args, ctx)` → objeto JSON.
   `ctx` = { cookie, usuario, conversacion }. Devuelven SOLO lo que el modelo puede
   contar; los errores vuelven como { error } para que el modelo los explique. */
const HERRAMIENTAS = {
  buscar_envios: {
    definicion: {
      name: 'buscar_envios',
      description: 'Busca envíos por número de guía (entero o parte) o por nombre de cliente. Devuelve hasta 20, los más nuevos primero, con destino, courier, kilos, venta, estado operativo, semáforo de UPS y si está liquidado.',
      input_schema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Número de guía o nombre (o parte) del cliente' },
          fecha_desde: { type: 'string', description: 'YYYY-MM-DD, opcional' },
          fecha_hasta: { type: 'string', description: 'YYYY-MM-DD, opcional' },
          courier: { type: 'string', enum: ['UPS', 'DHL'], description: 'opcional' },
        },
        required: ['q'],
      },
    },
    async ejecutar(a, ctx) {
      const qs = new URLSearchParams();
      qs.set('q', String(a.q || '').trim());
      if (a.fecha_desde) qs.set('fecha_desde', resolverFecha(a.fecha_desde));
      if (a.fecha_hasta) qs.set('fecha_hasta', resolverFecha(a.fecha_hasta));
      if (a.courier) qs.set('courier', a.courier);
      const r = await api(ctx.cookie, 'GET', '/api/envios?' + qs.toString());
      if (r && r.error) return r;
      const lista = (Array.isArray(r) ? r : []).slice(0, 20).map((e) => ({
        id: e.id,
        guia: e.numero_guia,
        fecha: e.fecha,
        cliente: e.cliente_nombre,
        destino: e.pais_destino,
        courier: e.courier,
        servicio_ups: e.servicio_ups || null,
        tipo: e.tipo_envio,
        bultos: e.cantidad_bultos,
        kg_real: n2(e.peso_real),
        kg_facturable: n2(e.peso_facturable),
        venta_usd: n2(e.total_cobrado),
        estado_operativo: e.estado_operativo || null,
        semaforo: e.tracking_estado || null,
        semaforo_detalle: e.tracking_detalle || null,
        semaforo_fecha: e.tracking_fecha || null,
        liquidado: !!e.liquidado,
        fecha_liquidacion: e.fecha_liquidacion || null,
        no_volo: !!e.no_volo,
      }));
      return { cantidad: lista.length, envios: lista };
    },
  },

  venta_periodo: {
    definicion: {
      name: 'venta_periodo',
      description: 'Venta, kilos, envíos y margen de un período: hoy, ayer, este mes, un rango de fechas. Opcional por courier. Los importes son USD.',
      input_schema: {
        type: 'object',
        properties: {
          periodo: { type: 'string', enum: ['hoy', 'ayer', 'mes', 'anio', '12m', 'rango'], description: '"mes" = el mes en curso' },
          desde: { type: 'string', description: 'YYYY-MM-DD, solo con periodo=rango' },
          hasta: { type: 'string', description: 'YYYY-MM-DD, solo con periodo=rango' },
          courier: { type: 'string', enum: ['UPS', 'DHL'] },
        },
        required: ['periodo'],
      },
    },
    async ejecutar(a, ctx) {
      const qs = new URLSearchParams();
      let etiqueta = a.periodo;
      if (a.periodo === 'hoy' || a.periodo === 'ayer') {
        const d = a.periodo === 'hoy' ? hoyLocal() : hoyLocalMas(-1);
        qs.set('periodo', 'rango'); qs.set('desde', d); qs.set('hasta', d);
      } else if (a.periodo === 'rango') {
        qs.set('periodo', 'rango'); qs.set('desde', resolverFecha(a.desde)); qs.set('hasta', resolverFecha(a.hasta));
      } else {
        qs.set('periodo', a.periodo);
      }
      if (a.courier) qs.set('courier', a.courier);
      const r = await api(ctx.cookie, 'GET', '/api/dashboard/analitica?' + qs.toString());
      if (r && r.error) return r;
      const k = r.kpis || {};
      const ka = r.kpis_ant || {};
      return {
        periodo: (r.periodo && r.periodo.etiqueta) || etiqueta,
        desde: r.periodo && r.periodo.desde,
        hasta: r.periodo && r.periodo.hasta,
        envios: k.envios, bultos: k.bultos,
        kg_facturables: n2(k.kg_fact), kg_reales: n2(k.kg_real),
        venta_usd: n2(k.venta), profit_estimado_usd: n2(k.profit), margen_pct: n2(k.margen_pct),
        sin_liquidar: k.sin_liquidar,
        periodo_anterior: { envios: ka.envios, venta_usd: n2(ka.venta), profit_estimado_usd: n2(ka.profit) },
        top_clientes: (r.top_clientes || []).slice(0, 5).map((c) => ({ cliente: c.cliente || c.nombre, envios: c.envios || c.n, venta_usd: n2(c.venta) })),
        nota: 'La venta es lo cobrado al cliente; el profit es la estimación del sistema (interno, no se le pasa a un cliente).',
      };
    },
  },

  buscar_clientes: {
    definicion: {
      name: 'buscar_clientes',
      description: 'Busca clientes por nombre (o parte). Sirve para conseguir el cliente_id que piden cotizar y proponer_pickup.',
      input_schema: {
        type: 'object',
        properties: { q: { type: 'string', description: 'nombre o parte del nombre' } },
        required: ['q'],
      },
    },
    async ejecutar(a, ctx) {
      const r = await api(ctx.cookie, 'GET', '/api/clientes');
      if (r && r.error) return r;
      const q = String(a.q || '').trim().toLowerCase();
      const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const lista = (Array.isArray(r) ? r : [])
        .filter((c) => !q || norm(c.nombre_nova).includes(norm(q)) || norm(c.nombre).includes(norm(q)))
        .slice(0, 15)
        .map((c) => ({
          id: c.id, nombre: c.nombre_nova || c.nombre, tipo_cobro: c.tipo_cobro,
          direccion_recoleccion: c.direccion_recoleccion || null, localidad: c.localidad || null,
          activo: c.activo !== 0,
        }));
      return { cantidad: lista.length, clientes: lista };
    },
  },

  cotizar: {
    definicion: {
      name: 'cotizar',
      description: 'Cotiza un envío con el motor del sistema y devuelve las opciones (DHL, UPS Expedited, UPS Saver) con el precio de venta y su desglose. Con cliente_id usa la tarifa de ese cliente; sin cliente hace falta profit_pct. NO devuelve costo ni margen.',
      input_schema: {
        type: 'object',
        properties: {
          pais: { type: 'string', description: 'País de destino (exportación) u origen (importación), en español, ej. "Brasil", "Estados Unidos"' },
          tipo: { type: 'string', enum: ['export', 'import'], description: 'export si sale de Argentina (lo más común)' },
          bultos: {
            type: 'array', minItems: 1,
            items: {
              type: 'object',
              properties: {
                peso_real: { type: 'number', description: 'kg' },
                largo: { type: 'number', description: 'cm' }, ancho: { type: 'number' }, alto: { type: 'number' },
              },
              required: ['peso_real'],
            },
          },
          fob: { type: 'number', description: 'Valor declarado en USD, 0 si no se sabe' },
          cliente_id: { type: 'integer' },
          profit_pct: { type: 'number', description: 'Ganancia manual en %, solo sin cliente' },
          contenido: { type: 'string', enum: ['paquete', 'documento'] },
          ddp: { type: 'boolean' },
          servicios: { type: 'array', items: { type: 'string', enum: ['DHL', 'UPS_EXP', 'UPS_SAV'] }, description: 'por defecto los tres' },
        },
        required: ['pais', 'bultos'],
      },
    },
    async ejecutar(a, ctx) {
      const bultos = (a.bultos || []).map((b) => ({
        peso_real: Number(b.peso_real) || 0, largo: Number(b.largo) || 0, ancho: Number(b.ancho) || 0, alto: Number(b.alto) || 0,
      }));
      if (!bultos.length || bultos.every((b) => b.peso_real <= 0 && !(b.largo && b.ancho && b.alto))) {
        return { error: 'Hace falta al menos un bulto con peso o medidas.' };
      }
      if (!a.cliente_id && !(Number(a.profit_pct) > 0)) {
        return { error: 'Sin cliente hace falta el porcentaje de ganancia (profit_pct). Preguntale a la persona para qué cliente es o qué ganancia aplicar.' };
      }
      const pf = pesoFacturable(bultos);
      const servicios = (a.servicios && a.servicios.length) ? a.servicios : ['DHL', 'UPS_EXP', 'UPS_SAV'];
      const opciones = [];
      const avisos = [];
      for (const servicio of servicios) {
        const body = {
          servicio, tipo: a.tipo || 'export', pais: a.pais, pesoFacturable: pf, fob: Number(a.fob) || 0,
          bultos, contenido: a.contenido || 'paquete', ddp: !!a.ddp, fuenteFuel: 'nova',
        };
        if (a.cliente_id) body.cliente_id = Number(a.cliente_id);
        else body.profitPct = Number(a.profit_pct);
        const r = await api(ctx.cookie, 'POST', '/api/liquidaciones/cotizar', body);
        if (r && r.error) { avisos.push(`${servicio}: ${r.error}`); continue; }
        /* LISTA BLANCA: solo lo que se le puede decir a un cliente. La ruta devuelve
           precioBase, profitMonto, utilidad, precio_kg, profit_aplicado…: NADA de eso
           pasa. Solo el precio final, la zona y los adicionales con nombre. */
        opciones.push({
          servicio,
          nombre: servicio === 'DHL' ? 'DHL Express' : servicio === 'UPS_EXP' ? 'UPS Worldwide Expedited' : 'UPS Worldwide Saver',
          zona: r.zona ?? r.zona_aplicada ?? null,
          surge_usd: n2(r.surge) || 0,
          manejo_usd: n2(r.manejo) || 0,
          fuel_pct: n2(r.fuel_aplicado),
          extras: (r.extras || []).map(([nombre, monto]) => ({ nombre, usd: n2(monto) })),
          total_usd: n2(r.precioFinal),
        });
        if (r.tarifa50) avisos.push(`${servicio}: arriba de 50 kg — la guía se emite por la OTRA cuenta de DHL (interno).`);
        if (r.advertencia) avisos.push(`${servicio}: ${r.advertencia}`);
      }
      return {
        pais: a.pais, tipo: a.tipo || 'export', bultos: bultos.length, kg_facturable: pf, fob_usd: Number(a.fob) || 0,
        cliente_id: a.cliente_id || null, opciones, avisos,
        nota: 'Precios de venta en USD. Sin impuestos de nacionalización en destino.',
      };
    },
  },

  pendientes: {
    definicion: {
      name: 'pendientes',
      description: 'Lo que la oficina tiene pendiente hoy: pickups del día y cuáles faltan confirmar, envíos sin liquidar por cliente, y las alertas rojas del panel de salud.',
      input_schema: { type: 'object', properties: { fecha: { type: 'string', description: 'YYYY-MM-DD, por defecto hoy' } } },
    },
    async ejecutar(a, ctx) {
      const f = resolverFecha(a.fecha);
      const out = { fecha: f };
      const p = await api(ctx.cookie, 'GET', `/api/pickups?desde=${f}&hasta=${f}`);
      if (p && !p.error) {
        const lista = Array.isArray(p) ? p : [];
        out.pickups = {
          total: lista.length,
          sin_confirmar: lista.filter((x) => !x.confirmado_ricardo && !x.confirmado_juanqui && !x.en_deposito_at).length,
          en_deposito: lista.filter((x) => !!x.en_deposito_at).length,
          lista: lista.slice(0, 15).map((x) => ({
            id: x.id, cliente: x.cliente_nombre, direccion: x.direccion, horario: `${x.hora_inicio}-${x.hora_fin}`,
            estado: x.estado, recolector: x.recolector || null, tipo: x.tipo_recoleccion,
          })),
        };
      } else out.pickups = { error: p && p.error };
      const l = await api(ctx.cookie, 'GET', '/api/liquidaciones/pendientes');
      if (l && !l.error) {
        const grupos = Array.isArray(l) ? l : [];
        out.sin_liquidar = {
          clientes: grupos.length,
          envios: grupos.reduce((s, g) => s + ((g.envios || []).length), 0),
          total_usd: n2(grupos.reduce((s, g) => s + (Number(g.total_cobrado) || 0), 0)),
          por_cliente: grupos.slice(0, 10).map((g) => ({ cliente: g.cliente_nombre, envios: (g.envios || []).length, usd: n2(g.total_cobrado) })),
        };
      } else out.sin_liquidar = { error: l && l.error };
      const s = await api(ctx.cookie, 'GET', '/api/salud/resumen');
      if (s && !s.error) out.salud = { resumen: s.resumen, rojos: s.rojos, errores: s.errores };
      else out.salud = { error: s && s.error };
      return out;
    },
  },

  proponer_pickup: {
    definicion: {
      name: 'proponer_pickup',
      description: 'PASO 1 de 2 para cargar un pickup (retiro en lo del cliente). NO guarda: valida los datos, deja la carga pendiente y devuelve el resumen para que la persona lo confirme. Si no se conoce la dirección, usa la de recolección del cliente.',
      input_schema: {
        type: 'object',
        properties: {
          cliente_id: { type: 'integer' },
          fecha: { type: 'string', description: 'YYYY-MM-DD (o "hoy"/"mañana")' },
          hora_inicio: { type: 'string', description: 'HH:MM' },
          hora_fin: { type: 'string', description: 'HH:MM' },
          direccion: { type: 'string', description: 'si no se dice, se usa la del cliente' },
          notas: { type: 'string' },
          courier: { type: 'string', enum: ['UPS', 'DHL'] },
          tipo_recoleccion: { type: 'string', enum: ['normal', 'cliente', 'courier', 'cobranza'], description: 'normal = pasa la camioneta' },
        },
        required: ['cliente_id', 'fecha', 'hora_inicio', 'hora_fin'],
      },
    },
    async ejecutar(a, ctx) {
      const c = await api(ctx.cookie, 'GET', `/api/clientes/${Number(a.cliente_id)}`);
      if (!c || c.error) return { error: `No encontré el cliente ${a.cliente_id}.` };
      const hora = (h) => {
        const m = String(h || '').match(/^(\d{1,2})(?::?(\d{2}))?$/);
        return m ? `${m[1].padStart(2, '0')}:${m[2] || '00'}` : null;
      };
      const hi = hora(a.hora_inicio), hf = hora(a.hora_fin);
      if (!hi || !hf) return { error: 'Las horas tienen que ser HH:MM (ej. 14:00 a 17:00).' };
      const direccion = (a.direccion || '').trim() || c.direccion_recoleccion || '';
      if (!direccion) return { error: 'El cliente no tiene dirección de recolección cargada: pedila.' };
      const pendiente = {
        tipo: 'pickup',
        datos: {
          cliente_id: c.id, direccion, fecha: resolverFecha(a.fecha), hora_inicio: hi, hora_fin: hf,
          notas: (a.notas || '').trim() || null, courier: a.courier || null,
          tipo_recoleccion: a.tipo_recoleccion || 'normal',
        },
        cliente_nombre: c.nombre_nova || c.nombre,
        propuesto_en: new Date().toISOString(),
      };
      await guardarPendiente(ctx.conversacion.id, pendiente);
      return {
        pendiente_de_confirmacion: true,
        resumen: { cliente: pendiente.cliente_nombre, ...pendiente.datos },
        instruccion: 'Mostrale el resumen a la persona y preguntale si lo cargás. Solo llamá a confirmar_pickup si dice que sí.',
      };
    },
  },

  confirmar_pickup: {
    definicion: {
      name: 'confirmar_pickup',
      description: 'PASO 2 de 2: graba el pickup que quedó pendiente con proponer_pickup. Llamar SOLO después de que la persona confirmó explícitamente.',
      input_schema: { type: 'object', properties: {} },
    },
    async ejecutar(a, ctx) {
      const pend = await leerPendiente(ctx.conversacion.id);
      if (!pend || pend.tipo !== 'pickup') return { error: 'No hay ningún pickup pendiente de confirmar. Primero hay que proponerlo.' };
      const quien = (ctx.usuario && ctx.usuario.usuario) || 'asistente';
      const marca = `Cargado por el asistente a pedido de ${quien}`;
      const body = { ...pend.datos, notas: pend.datos.notas ? `${pend.datos.notas} · ${marca}` : marca };
      const r = await api(ctx.cookie, 'POST', '/api/pickups', body);
      if (r && r.error) return r;
      await guardarPendiente(ctx.conversacion.id, null);
      return { cargado: true, pickup_id: r.id, cliente: r.cliente_nombre, fecha: r.fecha, horario: `${r.hora_inicio}-${r.hora_fin}`, direccion: r.direccion, estado: r.estado };
    },
  },

  cancelar_pendiente: {
    definicion: {
      name: 'cancelar_pendiente',
      description: 'Descarta la carga pendiente (el pickup propuesto) cuando la persona dice que no.',
      input_schema: { type: 'object', properties: {} },
    },
    async ejecutar(a, ctx) {
      await guardarPendiente(ctx.conversacion.id, null);
      return { cancelado: true };
    },
  },
};

const DEFINICIONES = Object.values(HERRAMIENTAS).map((h) => h.definicion);

function systemPrompt(usuario) {
  return [
    'Sos el asistente interno de Nova Express, un courier internacional de Buenos Aires (DHL y UPS). Hablás con la gente de la oficina, en español rioplatense (vos), corto y directo.',
    `Hoy es ${hoyLocal()}. Usuario: ${(usuario && usuario.usuario) || 'desconocido'}.`,
    'REGLAS:',
    '- Contestás SOLO con lo que devuelven las herramientas. No inventás guías, precios, clientes ni fechas. Si una herramienta devuelve error, lo decís tal cual.',
    '- Importes en USD con dos decimales. Kilos con una coma decimal (14,5 kg). Fechas como 14/09.',
    '- Para cotizar necesitás país, bultos (peso y, si hay, medidas) y cliente o % de ganancia. Si falta algo, preguntá UNA cosa por vez. Devolvé cada opción con su total y, si te lo piden, el desglose. Nunca menciones costo, margen ni profit de una cotización.',
    '- Cargar un pickup es en DOS pasos: primero proponer_pickup (mostrás el resumen y preguntás "¿lo cargo?"), y confirmar_pickup SOLO cuando la persona dice que sí. Si dice que no, cancelar_pendiente.',
    '- Si no sabés el cliente_id, buscalo con buscar_clientes. Si hay varios parecidos, preguntá cuál.',
    '- Sin markdown pesado: texto plano, guiones para listas, nada de tablas.',
  ].join('\n');
}

/* ── Persistencia ───────────────────────────────────────────────────────────────── */
async function crearConversacion(usuario, canal = 'panel') {
  const db = getDb();
  const r = await db.prepare(
    'INSERT INTO bot_conversaciones (usuario_id, usuario, canal) VALUES (?, ?, ?)'
  ).run(usuario.id, usuario.usuario || null, canal);
  return { id: r.lastInsertRowid || r.lastID, usuario_id: usuario.id, canal };
}

async function leerConversacion(id, usuario) {
  const c = await getDb().prepare('SELECT * FROM bot_conversaciones WHERE id = ?').get(id);
  if (!c) return null;
  /* Cada uno ve SUS conversaciones. Admin ve todas (para revisar qué pidió la oficina). */
  if (usuario && c.usuario_id !== usuario.id && usuario.rol !== 'admin') return null;
  return c;
}

async function guardarPendiente(conversacionId, pendiente) {
  await getDb().prepare(
    "UPDATE bot_conversaciones SET accion_pendiente = ?, actualizado_en = datetime('now','localtime') WHERE id = ?"
  ).run(pendiente ? JSON.stringify(pendiente) : null, conversacionId);
}

async function leerPendiente(conversacionId) {
  const c = await getDb().prepare('SELECT accion_pendiente FROM bot_conversaciones WHERE id = ?').get(conversacionId);
  if (!c || !c.accion_pendiente) return null;
  try { return JSON.parse(c.accion_pendiente); } catch { return null; }
}

async function guardarMensaje(conversacionId, rol, contenido) {
  await getDb().prepare(
    'INSERT INTO bot_mensajes (conversacion_id, rol, contenido) VALUES (?, ?, ?)'
  ).run(conversacionId, rol, JSON.stringify(contenido));
  await getDb().prepare(
    "UPDATE bot_conversaciones SET actualizado_en = datetime('now','localtime') WHERE id = ?"
  ).run(conversacionId);
}

async function leerMensajes(conversacionId, limite = HISTORIAL) {
  const filas = await getDb().prepare(
    'SELECT id, rol, contenido, creado_en FROM bot_mensajes WHERE conversacion_id = ? ORDER BY id DESC LIMIT ?'
  ).all(conversacionId, limite);
  return filas.reverse().map((f) => {
    let contenido; try { contenido = JSON.parse(f.contenido); } catch { contenido = String(f.contenido); }
    return { id: f.id, rol: f.rol, contenido, creado_en: f.creado_en };
  });
}

/* Historial en el formato de la API. Una conversación no puede empezar con un tool_result
   huérfano (si el recorte de HISTORIAL cortó justo ahí), así que se descartan los
   mensajes del principio hasta el primer texto de la persona. */
function historialParaApi(mensajes) {
  const arr = mensajes.map((m) => ({ role: m.rol, content: m.contenido }));
  while (arr.length && !(arr[0].role === 'user' && Array.isArray(arr[0].content) && arr[0].content.some((b) => b.type === 'text'))) arr.shift();
  return arr;
}

/* Lo que se muestra en pantalla: solo los textos, con quién y cuándo. Un turno del
   asistente son VARIOS mensajes guardados (el que pide la herramienta, sin texto, y el
   que contesta): acá se juntan en una sola burbuja, con las herramientas que usó. */
function mensajesParaPantalla(mensajes) {
  const out = [];
  let herramientasAcum = [];
  for (const m of mensajes) {
    const bloques = Array.isArray(m.contenido) ? m.contenido : [{ type: 'text', text: String(m.contenido) }];
    const texto = bloques.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const herramientas = bloques.filter((b) => b.type === 'tool_use').map((b) => b.name);
    if (m.rol === 'assistant') {
      herramientasAcum.push(...herramientas);
      if (!texto) continue;
      out.push({ id: m.id, rol: 'assistant', texto, herramientas: herramientasAcum, creado_en: m.creado_en });
      herramientasAcum = [];
    } else if (texto) {
      out.push({ id: m.id, rol: 'user', texto, herramientas: [], creado_en: m.creado_en });
    }
  }
  return out;
}

/* ── El modelo ──────────────────────────────────────────────────────────────────── */
async function llamarModeloReal(system, mensajes) {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey(), 'anthropic-version': API_VERSION },
    body: JSON.stringify({ model: modelo(), max_tokens: 1200, system, tools: DEFINICIONES, messages: mensajes }),
  });
  const datos = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (datos && datos.error && datos.error.message) || `HTTP ${r.status}`;
    const e = new Error('La API del asistente contestó con error: ' + msg);
    e.status = 502;
    throw e;
  }
  return { content: datos.content || [], stop_reason: datos.stop_reason };
}

/* El motor de mentira para las tandas. Reconoce el pedido por patrones y dispara la
   MISMA herramienta que dispararía el modelo; cuando vuelve el resultado, lo cuenta en
   un texto fijo. Determinista a propósito. */
async function llamarModeloMock(system, mensajes, ctx) {
  const ultimo = mensajes[mensajes.length - 1];
  const bloques = Array.isArray(ultimo.content) ? ultimo.content : [{ type: 'text', text: String(ultimo.content) }];
  const tr = bloques.find((b) => b.type === 'tool_result');
  const uso = (name, input) => ({ content: [{ type: 'tool_use', id: 'mock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), name, input }], stop_reason: 'tool_use' });
  const texto = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });

  if (tr) {
    // Vuelve una herramienta: contar lo que trajo, en un texto fijo.
    const prev = mensajes[mensajes.length - 2];
    const tu = (prev && Array.isArray(prev.content) ? prev.content : []).find((b) => b.type === 'tool_use');
    const nombre = tu ? tu.name : '?';
    let res; try { res = JSON.parse(tr.content); } catch { res = tr.content; }
    if (res && res.error) return texto(`[mock] ${nombre}: ${res.error}`);
    switch (nombre) {
      case 'buscar_envios':
        return texto(res.cantidad ? `[mock] Encontré ${res.cantidad} envío(s): ` + res.envios.map((e) => `guía ${e.guia} · ${e.cliente} · ${e.destino} · ${e.courier} · ${e.kg_facturable} kg · USD ${e.venta_usd} · ${e.liquidado ? 'liquidado' : 'sin liquidar'}${e.semaforo ? ' · ' + e.semaforo : ''}`).join(' | ') : '[mock] No encontré envíos con eso.');
      case 'venta_periodo':
        return texto(`[mock] Venta ${res.periodo}: ${res.envios} envíos · ${res.kg_facturables} kg · USD ${res.venta_usd} · profit USD ${res.profit_estimado_usd}`);
      case 'buscar_clientes':
        return texto(res.cantidad ? '[mock] Clientes: ' + res.clientes.map((c) => `${c.nombre} (id ${c.id})`).join(', ') : '[mock] No encontré clientes.');
      case 'cotizar':
        return texto(`[mock] Cotización a ${res.pais}, ${res.kg_facturable} kg facturables: ` + res.opciones.map((o) => `${o.nombre} zona ${o.zona} USD ${o.total_usd}`).join(' · ') + (res.avisos.length ? ' · avisos: ' + res.avisos.join(' / ') : ''));
      case 'pendientes':
        return texto(`[mock] Pendientes ${res.fecha}: pickups ${res.pickups.total} (${res.pickups.sin_confirmar} sin confirmar) · sin liquidar ${res.sin_liquidar.envios} envíos de ${res.sin_liquidar.clientes} clientes (USD ${res.sin_liquidar.total_usd}) · salud rojos ${(res.salud.rojos || []).length}`);
      case 'proponer_pickup':
        return texto(`[mock] Pickup para ${res.resumen.cliente} el ${res.resumen.fecha} de ${res.resumen.hora_inicio} a ${res.resumen.hora_fin} en ${res.resumen.direccion}. ¿Lo cargo?`);
      case 'confirmar_pickup':
        return texto(`[mock] Listo, pickup #${res.pickup_id} cargado para ${res.cliente} el ${res.fecha} ${res.horario}.`);
      case 'cancelar_pendiente':
        return texto('[mock] Cancelado, no cargué nada.');
      default:
        return texto('[mock] ' + JSON.stringify(res).slice(0, 400));
    }
  }

  const t = (bloques.find((b) => b.type === 'text') || {}).text || '';
  const tl = t.toLowerCase();
  const pend = await leerPendiente(ctx.conversacion.id);
  if (pend && /^\s*(s[ií]|dale|confirmo|ok|cargalo|carg[aá]lo)(?![a-záéíóú])/.test(tl)) return uso('confirmar_pickup', {});
  if (pend && /^\s*(no|cancel)/.test(tl)) return uso('cancelar_pendiente', {});
  let m;
  if ((m = t.match(/1Z[0-9A-Z]{16}/i))) return uso('buscar_envios', { q: m[0] });
  if ((m = tl.match(/gu[ií]a\s+([0-9a-z]{4,})/))) return uso('buscar_envios', { q: m[1] });
  if (/pendiente/.test(tl)) { const f = (t.match(/\d{4}-\d{2}-\d{2}/) || [])[0]; return uso('pendientes', f ? { fecha: f } : (/mañana|manana/.test(tl) ? { fecha: 'mañana' } : {})); }
  if (/venta|vendimos|facturamos/.test(tl)) return uso('venta_periodo', { periodo: /ayer/.test(tl) ? 'ayer' : /mes/.test(tl) ? 'mes' : 'hoy', courier: /\bups\b/.test(tl) ? 'UPS' : /\bdhl\b/.test(tl) ? 'DHL' : undefined });
  if (/pickup|retiro/.test(tl)) {
    const cid = (t.match(/cliente\s*(?:id\s*)?#?(\d+)/i) || [])[1];
    const hs = t.match(/(\d{1,2})(?::(\d{2}))?\s*(?:a|-|hasta)\s*(\d{1,2})(?::(\d{2}))?\s*(?:hs|h)?/);
    if (!cid || !hs) return texto('[mock] Para el pickup necesito el cliente (id) y el horario.');
    const dir = (t.match(/\ben\s+(.+?)(?:,|\.|$)/i) || [])[1];
    return uso('proponer_pickup', {
      cliente_id: Number(cid), fecha: /mañana|manana/.test(tl) ? 'mañana' : 'hoy',
      hora_inicio: `${hs[1]}:${hs[2] || '00'}`, hora_fin: `${hs[3]}:${hs[4] || '00'}`,
      direccion: dir || undefined,
    });
  }
  if (/cotiz/.test(tl)) {
    const pais = (t.match(/\ba\s+([A-ZÁÉÍÓÚ][\wáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚ][\wáéíóúñ]+)?)/) || [])[1];
    const kg = t.match(/(\d+(?:[.,]\d+)?)\s*kg/i);
    const med = t.match(/(\d+)\s*[x×]\s*(\d+)\s*[x×]\s*(\d+)/i);
    const cid = (t.match(/cliente\s*(?:id\s*)?#?(\d+)/i) || [])[1];
    const pp = (t.match(/(\d+)\s*%/) || [])[1];
    const fob = (t.match(/fob\s*(\d+)/i) || [])[1];
    if (!pais || !kg) return texto('[mock] Para cotizar necesito país y kilos.');
    return uso('cotizar', {
      pais, tipo: 'export', fob: fob ? Number(fob) : 0,
      bultos: [{ peso_real: Number(kg[1].replace(',', '.')), largo: med ? +med[1] : 0, ancho: med ? +med[2] : 0, alto: med ? +med[3] : 0 }],
      cliente_id: cid ? Number(cid) : undefined, profit_pct: pp ? Number(pp) : undefined,
    });
  }
  if (/cliente/.test(tl)) {
    const q = (t.match(/cliente\s+(.+)$/i) || [])[1] || '';
    return uso('buscar_clientes', { q: q.trim() });
  }
  return texto('[mock] No entendí. Puedo buscar una guía, decirte la venta, cotizar, listar pendientes o cargar un pickup.');
}

/* ── El circuito de un mensaje ─────────────────────────────────────────────────── */
/**
 * @param {{usuario:object, cookie:string, texto:string, conversacion_id?:number, canal?:string}} p
 * @returns {{conversacion_id:number, texto:string, herramientas:string[], pendiente:object|null}}
 */
async function procesarMensaje({ usuario, cookie, texto, conversacion_id, canal = 'panel' }) {
  const est = estado();
  if (!est.disponible) {
    const e = new Error('El asistente no está configurado: falta ANTHROPIC_API_KEY en el .env del servidor.');
    e.status = 503;
    throw e;
  }
  const limpio = String(texto || '').trim();
  if (!limpio) { const e = new Error('Mensaje vacío'); e.status = 400; throw e; }
  if (limpio.length > 2000) { const e = new Error('Mensaje demasiado largo (máx. 2000 caracteres)'); e.status = 400; throw e; }

  let conversacion = conversacion_id ? await leerConversacion(conversacion_id, usuario) : null;
  if (!conversacion) conversacion = await crearConversacion(usuario, canal);
  const ctx = { cookie, usuario, conversacion };

  await guardarMensaje(conversacion.id, 'user', [{ type: 'text', text: limpio }]);
  const system = systemPrompt(usuario);
  const usadas = [];
  let respuestaTexto = '';

  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const mensajes = historialParaApi(await leerMensajes(conversacion.id));
    const salida = esMock() ? await llamarModeloMock(system, mensajes, ctx) : await llamarModeloReal(system, mensajes);
    const content = salida.content || [];
    await guardarMensaje(conversacion.id, 'assistant', content);
    const usos = content.filter((b) => b.type === 'tool_use');
    respuestaTexto = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!usos.length || salida.stop_reason === 'end_turn') break;

    const resultados = [];
    for (const u of usos) {
      const h = HERRAMIENTAS[u.name];
      let res;
      try {
        res = h ? await h.ejecutar(u.input || {}, ctx) : { error: `Herramienta desconocida: ${u.name}` };
      } catch (err) {
        res = { error: 'Falló la herramienta: ' + (err.message || String(err)) };
      }
      usadas.push(u.name);
      resultados.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(res) });
    }
    await guardarMensaje(conversacion.id, 'user', resultados);
  }

  if (!respuestaTexto) respuestaTexto = 'No pude armar una respuesta. Probá de nuevo con otras palabras.';
  return {
    conversacion_id: conversacion.id,
    texto: respuestaTexto,
    herramientas: usadas,
    pendiente: await leerPendiente(conversacion.id),
  };
}

async function listarConversaciones(usuario, limite = 20) {
  const db = getDb();
  const filas = usuario.rol === 'admin'
    ? await db.prepare('SELECT id, usuario, canal, titulo, creado_en, actualizado_en FROM bot_conversaciones ORDER BY actualizado_en DESC LIMIT ?').all(limite)
    : await db.prepare('SELECT id, usuario, canal, titulo, creado_en, actualizado_en FROM bot_conversaciones WHERE usuario_id = ? ORDER BY actualizado_en DESC LIMIT ?').all(usuario.id, limite);
  const out = [];
  for (const c of filas) {
    let titulo = c.titulo;
    if (!titulo) {
      const primero = await db.prepare("SELECT contenido FROM bot_mensajes WHERE conversacion_id = ? AND rol = 'user' ORDER BY id ASC LIMIT 1").get(c.id);
      try { const b = JSON.parse(primero.contenido); titulo = (b.find((x) => x.type === 'text') || {}).text || ''; } catch { titulo = ''; }
      titulo = String(titulo).slice(0, 60);
    }
    out.push({ ...c, titulo });
  }
  return out;
}

module.exports = {
  estado, procesarMensaje, listarConversaciones, leerConversacion, leerMensajes, mensajesParaPantalla,
  HERRAMIENTAS, pesoFacturable, resolverFecha,
};
