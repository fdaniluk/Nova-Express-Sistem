/**
 * cotizacion.model.js — las cotizaciones guardadas y su estado.
 *
 * POR QUÉ EXISTE (caso Asaplast, 30/07/2026)
 * Se cotizó una caja por 14 kg facturables, el cliente aceptó y pagó ESE precio, la caja
 * llegó y midió 10, y el cotizador automático de Salidas recalculó y guardó el precio de
 * 10 kg. El envío quedó bien cargado —las medidas reales son las que factura el courier—
 * pero la plata registrada dejó de ser la plata cobrada. En palabras de Felipe: *"no es
 * que pierdo plata, pero hay plata que se pierde en el sistema"*.
 *
 * Hasta hoy el cotizador no persistía NADA. Este modelo guarda la cotización tal cual se
 * emitió, para que después el envío pueda decir de dónde salió su precio.
 *
 * LO QUE SE CONGELA Y POR QUÉ
 * `entrada` y `opciones` son JSON. Adentro va todo lo que hace falta para reconstruir la
 * cotización aunque mañana cambie el fuel, el profit del cliente o el tarifario: el fuel
 * usado y de dónde salió, el profit aplicado, el precio por kilo y el modo del cliente,
 * la zona, y los bultos con sus medidas. Sin esa foto, dentro de un mes nadie puede
 * explicar por qué esa cotización decía ese número.
 */
const { getDb } = require('../db');

const CLIENTE_NOMBRE = "COALESCE(NULLIF(c.nombre_nova, ''), c.nombre)";

const ESTADOS = ['emitida', 'aceptada', 'rechazada', 'vencida'];

/* El SELECT de siempre: la cotización más el nombre actual del cliente. Se usa LEFT JOIN
   porque una cotización puede ser para alguien que todavía no es cliente (cliente_id
   NULL), y en ese caso el nombre sale de cliente_nombre. */
const SELECT_BASE = `
  SELECT q.*,
         COALESCE(${CLIENTE_NOMBRE}, q.cliente_nombre) AS cliente_nombre_actual
    FROM cotizaciones q
    LEFT JOIN clientes c ON c.id = q.cliente_id`;

/** El próximo número de cotización. Correlativo propio, arranca en 1. */
async function proximoNumero() {
  const db = getDb();
  const row = await db.prepare('SELECT MAX(numero) AS n FROM cotizaciones').get();
  return ((row && row.n) || 0) + 1;
}

/* Vencer las que se pasaron de fecha. Se hace al leer y no con una tarea de fondo: el
   sistema no tiene scheduler, y una cotización vencida que sigue figurando como
   "aceptada" es exactamente el problema que esto viene a evitar. Solo toca las que
   están en 'emitida': una ACEPTADA no se vence sola —el cliente ya pagó ese precio—,
   vencerla sería borrar el acuerdo. */
async function vencerLasQueCorresponda() {
  const db = getDb();
  await db
    .prepare(
      `UPDATE cotizaciones
          SET estado = 'vencida', actualizado_en = datetime('now','localtime')
        WHERE estado = 'emitida'
          AND vence_en IS NOT NULL
          AND vence_en < date('now','localtime')`
    )
    .run();
}

async function listar({ cliente_id, estado, desde, hasta, limite } = {}) {
  await vencerLasQueCorresponda();
  const db = getDb();
  let sql = `${SELECT_BASE} WHERE 1=1`;
  const params = [];
  if (cliente_id !== undefined && cliente_id !== null && cliente_id !== '') {
    sql += ' AND q.cliente_id = ?';
    params.push(cliente_id);
  }
  if (estado) {
    sql += ' AND q.estado = ?';
    params.push(estado);
  }
  if (desde) { sql += ' AND date(q.creado_en) >= ?'; params.push(desde); }
  if (hasta) { sql += ' AND date(q.creado_en) <= ?'; params.push(hasta); }
  sql += ' ORDER BY q.creado_en DESC, q.id DESC';
  if (limite) { sql += ' LIMIT ?'; params.push(Number(limite)); }
  const filas = await db.prepare(sql).all(...params);
  /* La lista NO devuelve `entrada` ni `opciones` enteras. Son dos motivos: pesan (traen
     el desglose completo de cada servicio) y, sobre todo, adentro va NUESTRO COSTO y el
     profit aplicado. La lista se usa en pantallas y el día que exista el link para el
     cliente (punto A del doc de ideas) esto no puede estar viajando de más. Se manda
     solo el resumen: qué servicios tenía y por cuánto. El detalle sale por /:id. */
  return filas.map((f) => {
    const { entrada, opciones, ...resto } = f;
    let resumen = [];
    try {
      resumen = JSON.parse(opciones || '[]').map((o) => ({ servicio: o.servicio, total: o.total }));
    } catch { resumen = []; }
    return { ...resto, opciones_resumen: resumen };
  });
}

async function obtener(id) {
  await vencerLasQueCorresponda();
  const db = getDb();
  return db.prepare(`${SELECT_BASE} WHERE q.id = ?`).get(id);
}

/**
 * Las cotizaciones ACEPTADAS de un cliente que todavía no se usaron en ningún envío.
 * Es lo que Salidas necesita para preguntar "¿esta caja es la de la cotización #12?".
 */
async function aceptadasSinUsar(clienteId) {
  await vencerLasQueCorresponda();
  const db = getDb();
  return db
    .prepare(
      `${SELECT_BASE}
        WHERE q.cliente_id = ? AND q.estado = 'aceptada' AND q.envio_id IS NULL
        ORDER BY q.creado_en DESC`
    )
    .all(clienteId);
}

/**
 * LAS COTIZACIONES RECIENTES DE UN CLIENTE — el panel de Cargar envío y de Salidas.
 *
 * POR QUÉ EXISTE (idea de Felipe, 25/08/2026)
 * La lista de cotizaciones guardadas vivía abajo del cotizador, y ahí no le sirve a nadie:
 * *"pocas veces uno va a volver al perfil del cliente para ver una cotización"*. El momento
 * en que hace falta es OTRO — cuando administración está cargando el envío y tiene que
 * saber qué se le cotizó a esa persona. Con el destino, las medidas y el peso a la vista,
 * la oficina reconoce el envío de un vistazo (*"se ve que es este"*) y se lleva el precio.
 *
 * DOS REGLAS QUE LO SOSTIENEN
 *  1. Solo salen las marcadas con `viaja_al_cliente`. El cotizador se usa para tantear y
 *     un historial lleno de tanteos no deja reconocer nada. La tilde arranca APAGADA.
 *  2. NO se devuelve `entrada` ni `opciones` enteras: adentro va nuestro costo y el profit.
 *     Se manda solo lo que sirve para reconocer el envío (medidas de los bultos) y el
 *     precio de cada servicio. Mismo criterio que `listar()`.
 *
 * La ventana es de días CORRIDOS, no mes calendario (pedido textual: "los últimos treinta
 * días, no mes calendario").
 */
async function recientesDeCliente(clienteId, dias = 30) {
  await vencerLasQueCorresponda();
  const db = getDb();
  const n = Number.isFinite(Number(dias)) && Number(dias) > 0 ? Math.min(Number(dias), 365) : 30;
  const filas = await db
    .prepare(
      `${SELECT_BASE}
        WHERE q.cliente_id = ?
          AND q.viaja_al_cliente = 1
          AND date(q.creado_en) >= date('now','localtime','-' || ? || ' days')
        ORDER BY q.creado_en DESC, q.id DESC`
    )
    .all(clienteId, n);

  return filas.map((f) => {
    const { entrada, opciones, ...resto } = f;
    let bultos = [];
    let precios = [];
    try {
      const e = JSON.parse(entrada || '{}');
      // Solo las medidas y los pesos. Del resto de `entrada` (ganancia, fuel, arancel)
      // no va nada: es cocina nuestra.
      bultos = Array.isArray(e.bultos)
        ? e.bultos.map((b) => ({ pr: b.pr, l: b.l, a: b.a, al: b.al, pv: b.pv, pf: b.pf }))
        : [];
    } catch { bultos = []; }
    try {
      /* Solo las opciones TILDADAS. Cotizar DHL + UPS rápido + UPS lento y mandarle una
         sola al cliente es lo normal; si subieran las tres, el panel mostraría tres
         precios para un envío que se cotizó a uno (pedido de Felipe, 26/08). */
      precios = JSON.parse(opciones || '[]')
        .filter((o) => o && o.viaja)
        .map((o) => ({ servicio: o.servicio, total: o.total, pf: o.pf, zona: o.zona }));
    } catch { precios = []; }
    return { ...resto, bultos, opciones_resumen: precios };
  })
    /* Una cotización sin ninguna opción tildada no tiene nada que mostrar. Puede pasar si
       alguien destildó todo antes de guardar: se guarda igual (es el respaldo) pero no
       ensucia el panel. */
    .filter((q) => q.opciones_resumen.length > 0);
}

async function anotarHistorial(cotizacionId, accion, antes, despues, usuario) {
  const db = getDb();
  await db
    .prepare(
      `INSERT INTO cotizacion_historial
         (cotizacion_id, accion, antes, despues, usuario_id, usuario)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      cotizacionId,
      accion,
      antes == null ? null : JSON.stringify(antes),
      despues == null ? null : JSON.stringify(despues),
      (usuario && usuario.id) || null,
      (usuario && usuario.usuario) || null
    );
}

async function historial(cotizacionId) {
  return getDb()
    .prepare('SELECT * FROM cotizacion_historial WHERE cotizacion_id = ? ORDER BY id ASC')
    .all(cotizacionId);
}

async function crear(data, usuario) {
  const db = getDb();
  const numero = await proximoNumero();

  /* QUÉ VIAJA AL HISTORIAL DEL CLIENTE (26/08/2026).
     La marca es POR OPCIÓN: la tilde "Guardar" vive en cada tarjeta del cotizador. La
     cotización se guarda SIEMPRE entera —es el respaldo de lo que se le mandó al cliente
     y de ahí sale el precio al aceptar— pero al panel de Cargar envío y de Salidas suben
     solo las opciones tildadas.
     `viaja_al_cliente` es el resumen a nivel cotización: sirve para que la consulta del
     panel filtre en SQL sin abrir el JSON de cada fila.
     Compatibilidad: si NINGUNA opción trae la marca (un cliente viejo de la API), manda
     el flag suelto y se aplica a todas. */
  const ops = Array.isArray(data.opciones) ? data.opciones : [];
  const marcadaPorOpcion = ops.some((o) => o && o.viaja !== undefined);
  const viaja = marcadaPorOpcion ? ops.some((o) => o && o.viaja) : Boolean(data.viaja_al_cliente);
  const opciones = marcadaPorOpcion
    ? ops
    : ops.map((o) => ({ ...o, viaja: viaja ? 1 : 0 }));
  const res = await db
    .prepare(
      `INSERT INTO cotizaciones
         (numero, cliente_id, cliente_nombre, estado, pais, tipo_envio, contenido, zona,
          peso_facturable, cantidad_bultos, valor_declarado, entrada, opciones,
          vence_en, usuario_id, usuario, notas, viaja_al_cliente)
       VALUES (?, ?, ?, 'emitida', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      numero,
      data.cliente_id ?? null,
      data.cliente_nombre ?? null,
      data.pais,
      data.tipo_envio,
      data.contenido ?? null,
      data.zona ?? null,
      data.peso_facturable ?? 0,
      data.cantidad_bultos ?? 1,
      data.valor_declarado ?? 0,
      JSON.stringify(data.entrada ?? {}),
      JSON.stringify(opciones),
      data.vence_en ?? null,
      (usuario && usuario.id) || null,
      (usuario && usuario.usuario) || null,
      data.notas ?? null,
      viaja ? 1 : 0
    );
  const id = res.lastInsertRowid;
  await anotarHistorial(id, 'emitida', null, { numero, peso_facturable: data.peso_facturable }, usuario);
  return obtener(id);
}

/**
 * Marca la cotización como ACEPTADA por el cliente.
 * `servicio` es cuál de las opciones eligió; el total sale de esa opción, NO de lo que
 * mande el navegador: el precio acordado no puede depender de un número tipeado.
 */
async function aceptar(id, servicio, usuario) {
  const db = getDb();
  const antes = await obtener(id);
  if (!antes) return null;

  const opciones = JSON.parse(antes.opciones || '[]');
  const elegida = opciones.find((o) => o.servicio === servicio);
  if (!elegida) return { error: 'La cotización no tiene una opción para ese servicio' };

  await db
    .prepare(
      `UPDATE cotizaciones
          SET estado = 'aceptada', servicio_aceptado = ?, total_acordado = ?,
              aceptada_por_id = ?, aceptada_por = ?,
              aceptada_en = datetime('now','localtime'),
              actualizado_en = datetime('now','localtime')
        WHERE id = ?`
    )
    .run(
      servicio,
      elegida.total,
      (usuario && usuario.id) || null,
      (usuario && usuario.usuario) || null,
      id
    );
  await anotarHistorial(
    id, 'aceptada',
    { estado: antes.estado, servicio_aceptado: antes.servicio_aceptado, total_acordado: antes.total_acordado },
    { estado: 'aceptada', servicio_aceptado: servicio, total_acordado: elegida.total },
    usuario
  );
  return obtener(id);
}

async function cambiarEstado(id, estado, usuario) {
  if (!ESTADOS.includes(estado)) return { error: 'Estado inválido' };
  const db = getDb();
  const antes = await obtener(id);
  if (!antes) return null;
  await db
    .prepare(
      `UPDATE cotizaciones
          SET estado = ?, actualizado_en = datetime('now','localtime')
        WHERE id = ?`
    )
    .run(estado, id);
  await anotarHistorial(id, estado, { estado: antes.estado }, { estado }, usuario);
  return obtener(id);
}

/**
 * Editar una cotización ACEPTADA (el cliente negoció). Se permite —fue decisión de
 * Felipe— pero nunca en silencio: cada cambio deja la foto anterior en el historial.
 * Solo se toca la plata acordada y las notas: las medidas y el desglose son la foto de
 * lo que se emitió y no se reescriben.
 */
async function editarAcordado(id, { total_acordado, notas, vence_en }, usuario) {
  const db = getDb();
  const antes = await obtener(id);
  if (!antes) return null;
  const nuevoTotal = total_acordado === undefined ? antes.total_acordado : total_acordado;
  const nuevasNotas = notas === undefined ? antes.notas : notas;
  const nuevoVence = vence_en === undefined ? antes.vence_en : vence_en;
  await db
    .prepare(
      `UPDATE cotizaciones
          SET total_acordado = ?, notas = ?, vence_en = ?,
              actualizado_en = datetime('now','localtime')
        WHERE id = ?`
    )
    .run(nuevoTotal, nuevasNotas, nuevoVence, id);
  await anotarHistorial(
    id, 'editada',
    { total_acordado: antes.total_acordado, notas: antes.notas, vence_en: antes.vence_en },
    { total_acordado: nuevoTotal, notas: nuevasNotas, vence_en: nuevoVence },
    usuario
  );
  return obtener(id);
}

/** Ata la cotización al envío que finalmente se cargó (o la suelta con envioId null). */
async function atarAEnvio(id, envioId, usuario) {
  const db = getDb();
  const antes = await obtener(id);
  if (!antes) return null;
  await db
    .prepare(
      `UPDATE cotizaciones
          SET envio_id = ?, actualizado_en = datetime('now','localtime')
        WHERE id = ?`
    )
    .run(envioId ?? null, id);
  await anotarHistorial(id, 'atada-a-envio', { envio_id: antes.envio_id }, { envio_id: envioId ?? null }, usuario);
  return obtener(id);
}

async function eliminar(id) {
  const db = getDb();
  const res = await db.prepare('DELETE FROM cotizaciones WHERE id = ?').run(id);
  return (res.changes ?? 0) > 0;
}

module.exports = {
  ESTADOS,
  listar,
  obtener,
  aceptadasSinUsar,
  recientesDeCliente,
  crear,
  aceptar,
  cambiarEstado,
  editarAcordado,
  atarAEnvio,
  historial,
  eliminar,
  proximoNumero,
  vencerLasQueCorresponda,
};
