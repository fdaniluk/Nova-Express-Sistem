const { getDb } = require('../db');
const { calcularPesos, pesoVolumetricoBulto, desglosarCosto, contenidoDe } = require('../services/calculos.service');
const configuracionModel = require('./configuracion.model');

function mapEnvio(row) {
  if (!row) return null;
  return {
    ...row,
    liquidado: Boolean(row.liquidado),
  };
}

async function getBultos(envioId) {
  return getDb()
    .prepare('SELECT * FROM envio_bultos WHERE envio_id = ? ORDER BY numero_bulto')
    .all(envioId);
}

async function saveBultos(envioId, bultos) {
  const db = getDb();
  await db.prepare('DELETE FROM envio_bultos WHERE envio_id = ?').run(envioId);
  const insert = db.prepare(
    `INSERT INTO envio_bultos (envio_id, numero_bulto, peso_real, largo, ancho, alto, peso_volumetrico)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < bultos.length; i++) {
    const b = bultos[i];
    const pv = pesoVolumetricoBulto(b.largo, b.ancho, b.alto);
    // Un bulto pesado pero sin medir guarda las medidas en 0 (la tabla las exige NOT
    // NULL): volumétrico 0, factura por su peso real. Antes el frontend directamente lo
    // descartaba con el peso adentro (defecto 4 de AUDITORIA-NUMEROS.md).
    await insert.run(
      envioId,
      b.numero_bulto ?? i + 1,
      b.peso_real ?? null,
      Number(b.largo) || 0,
      Number(b.ancho) || 0,
      Number(b.alto) || 0,
      Math.round(pv * 1000) / 1000
    );
  }
}

function buildPesos(data) {
  const bultos = data.bultos || [];
  return calcularPesos(data.peso_real, bultos, {
    largo: data.largo,
    ancho: data.ancho,
    alto: data.alto,
  });
}

async function buscarPorId(id) {
  const row = await getDb()
    .prepare(
      `SELECT e.*, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre, c.tipo_cobro
       FROM envios e
       JOIN clientes c ON c.id = e.cliente_id
       WHERE e.id = ?`
    )
    .get(id);
  if (!row) return null;
  const envio = mapEnvio(row);
  envio.bultos = await getBultos(id);
  return envio;
}

async function listar(filtros = {}) {
  const db = getDb();
  let sql = `
    SELECT e.*, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre, c.tipo_cobro
    FROM envios e
    JOIN clientes c ON c.id = e.cliente_id
    WHERE 1=1`;
  const params = [];

  if (filtros.cliente_id) {
    sql += ' AND e.cliente_id = ?';
    params.push(filtros.cliente_id);
  }
  if (filtros.fecha_desde) {
    sql += ' AND e.fecha >= ?';
    params.push(filtros.fecha_desde);
  }
  if (filtros.fecha_hasta) {
    sql += ' AND e.fecha <= ?';
    params.push(filtros.fecha_hasta);
  }
  if (filtros.courier) {
    sql += ' AND e.courier = ?';
    params.push(filtros.courier);
  }
  if (filtros.tipo_envio) {
    sql += ' AND e.tipo_envio = ?';
    params.push(filtros.tipo_envio);
  }
  if (filtros.liquidado !== undefined && filtros.liquidado !== '') {
    sql += ' AND e.liquidado = ?';
    params.push(filtros.liquidado === 'true' || filtros.liquidado === '1' ? 1 : 0);
  }
  if (filtros.q) {
    sql += ' AND (e.numero_guia LIKE ? OR c.nombre LIKE ? OR c.nombre_nova LIKE ?)';
    const term = `%${filtros.q}%`;
    params.push(term, term, term);
  }

  sql += ' ORDER BY e.fecha DESC, e.id DESC';
  const rows = await db.prepare(sql).all(...params);
  return rows.map(mapEnvio);
}

// ¿Este envío todavía no fue pesado?
//
// Hay clientes cuyos envíos no pasan por el depósito (Kasdorf y parecidos): se les manda la
// guía, la imprimen y despachan, y los pesos y medidas reales llegan dias después. Esos
// envíos se cargan igual el mismo día, sin pesar.
//
// El marcador es el peso facturable en 0. No hace falta una columna nueva: un envío real no
// puede pesar cero, y peso_real es NOT NULL en la base, así que 0 es el único valor posible
// para "todavía no lo sé". Cambiar esa columna a NULL obligaría a reconstruir la tabla de
// envíos entera, que es mucho riesgo para lo que aporta.
function sinPesar(pesoFacturable) {
  return !(Number(pesoFacturable) > 0);
}

// Calcula el desglose AL COSTO (profit 0) congelado al alta, usando el mismo motor
// que el cotizador y el liquidador. El fuel% es el autoritativo de config (no el del
// cliente). Devuelve null si el país no figura en las tablas y no hay zona manual.
//
// También devuelve null si el envío está SIN PESAR. Antes no: con peso 0 el motor
// devolvía el flete mínimo de la tabla (USD 21,90 en UPS zona 2, el renglón de 0,5 kg) y
// ese número quedaba guardado como si fuera el costo real. Entre que se carga el envío y
// llegan los pesos, esa plata inventada se sumaba en Salidas, en el dashboard y en la
// utilidad. Sin peso no hay costo: las columnas quedan vacías hasta que se pese.
async function calcularDesgloseAlCosto(data, pesoFacturable) {
  if (sinPesar(pesoFacturable)) return null;
  const courier = data.courier;
  const servicio = courier === 'DHL'
    ? 'DHL'
    : (data.servicio_ups === 'UPS_SAV' || data.servicio_ups === 'UPS_EXP')
      ? data.servicio_ups
      : 'UPS_EXP'; // fallback si no vino la variante
  const tipo = (data.tipo_envio || '').toLowerCase().includes('import') ? 'import' : 'export';

  // Fuel% por envío. Desde el 07/08/2026 quien carga elige la FUENTE en un desplegable
  // ('nova' | 'dhl' | 'ups' | 'cliente' | 'manual'), y el predeterminado es Nova. La
  // decisión de qué porcentaje corresponde NO se toma acá: la toma resolverFuel() en
  // cotizacion.service.js, que es el único lugar del sistema que resuelve el fuel. Si se
  // decidiera también acá, en dos meses las dos copias dirían cosas distintas — que es
  // exactamente como nacieron los cuatro errores de cotización de esta semana.
  //
  // El porcentaje se congela en envios.fuel_pct y la fuente en envios.fuel_origen.
  const { resolverFuel } = require('../services/cotizacion.service');
  const fuelResuelto = await resolverFuel({
    clienteId: data.cliente_id,
    fuelBody: data.fuel_pct,
    fuentePedida: data.fuel_origen,
    servicio: courier === 'DHL' ? 'DHL' : (data.servicio_ups || 'UPS_EXP'),
  });
  const fuelPct = fuelResuelto.fuelPct;
  const fuelOrigen = fuelResuelto.origen;

  // Mismo conjunto de bultos que usó buildPesos para el peso facturable:
  // si vienen bultos, son el set completo; si no, el bulto único de los campos primarios.
  const bultos = (data.bultos && data.bultos.length)
    ? data.bultos.map(b => ({ pesoReal: b.peso_real, largo: b.largo, ancho: b.ancho, alto: b.alto }))
    : [{ pesoReal: data.peso_real, largo: data.largo, ancho: data.ancho, alto: data.alto }];

  const resultado = desglosarCosto({
    pais: data.pais_destino,
    tipo,
    servicio,
    pesoFacturable,
    fob: data.fob || 0,
    fuelPct,
    zonaOverride: data.zona,
    bultos,
    remota: data.remota ? true : false,
    // Zona de entrega ('extendida' | 'remota'). Si el envío es viejo y solo tiene el flag
    // `remota`, el motor lo lee como 'extendida', que es la tarifa que ya se le cobró.
    entrega: data.entrega ?? null,
    ddp: data.ddp ? true : false,
    // Protección de Documentos de DHL (USD 7,50). Sin esta línea el cargo se pierde al
    // congelar el costo y reaparece como descuadre al conciliar contra la factura.
    proteccionDoc: data.proteccion_doc ? true : false,
    // Tipo de paquete → tarifa de documento de DHL (hasta 2 kg). Sin esto el costo se
    // congelaba siempre con la tabla de mercadería, aunque el envío estuviera marcado
    // como documento, y la utilidad de esos envíos quedaba mal calculada.
    contenido: contenidoDe(data.tipo_paquete),
  });

  // El desglose viaja con la FUENTE del fuel pegada, para que `crear` la persista sin
  // tener que volver a resolverla. Si `desglosarCosto` no devolvió nada (país que el motor
  // no reconoce) no hay costo que congelar y tampoco fuente que guardar.
  if (resultado) resultado.fuel_origen = fuelOrigen;
  return resultado;
}

// Seguro DE VENTA congelado (auditoría 15/08/2026, sospecha "el seguro negociado no se
// congela"). La columna `seguro` es el COSTO: la escala de lista del courier, congelada
// por calcularDesgloseAlCosto. Pero si el cliente tiene seguro propio negociado
// (clientes.seguro_pct_propio), lo que se le COBRA por asegurar es otro número, y hasta
// ahora no quedaba escrito en ningún lado: el Excel de la liquidación descomponía la venta
// con la escala de lista. Esta función saca la foto del monto negociado al alta (y al
// editar fob/cliente/courier). Devuelve null si el cliente no tiene seguro propio: el
// desglose de venta cae a `seguro`, que es el comportamiento de siempre.
async function calcularSeguroVenta(clienteId, courier, fob) {
  // require adentro para no armar un ciclo de módulos (profit.service es grande).
  const { resolverSeguroPropio } = require('../services/profit.service');
  const propio = await resolverSeguroPropio(clienteId);
  if (!propio) return null;
  const { calcSeguroDHL, calcSeguroUPS } = require('../../../shared/cotizador/cotizador-core');
  const calc = courier === 'DHL' ? calcSeguroDHL : calcSeguroUPS;
  return calc(Number(fob) || 0, propio).monto;
}

async function crear(data) {
  const db = getDb();
  const { pesoVolumetrico, pesoFacturable } = buildPesos(data);
  const hasBultos = data.bultos && data.bultos.length > 0;

  // Desglose al costo (profit 0) congelado al momento del alta.
  const desglose = await calcularDesgloseAlCosto(data, pesoFacturable);
  // Seguro de venta negociado (solo clientes con seguro propio; null para el resto).
  const seguroVenta = await calcularSeguroVenta(data.cliente_id, data.courier, data.fob);

  const doInsert = async () => {
    const result = await db
      .prepare(
        `INSERT INTO envios (
          cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, destino_raw, direccion, zona,
          cantidad_bultos, peso_real, largo, ancho, alto,
          peso_volumetrico, peso_facturable, fob, total_cobrado, observaciones,
          numero_salida, bulto, tipo_paquete, asegurado, ddp, proteccion_doc, remota, entrega,
          flete, descuento, seguro, fuel, fuel_pct, fuel_origen, derechos, adicionales, otros, profit, porcentaje,
          extras_json, servicio_ups, num_sal_cero, seguro_venta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.cliente_id,
        data.fecha,
        data.courier,
        data.tipo_envio,
        String(data.numero_guia ?? '').trim().toUpperCase() || null,
        data.pais_destino,
        data.destino_raw ?? null,
        // Si el alta no trae direccion (el formulario de Cargar envío no la manda), se
        // deriva del tipo de envío en vez de caer siempre en 'expo': una impo cargada a
        // mano quedaba con tipo_envio='importacion' pero direccion='expo', y Salidas y el
        // Excel del cierre la mostraban como exportación (revisar-envios, sección 1).
        data.direccion ?? (data.tipo_envio === 'importacion' ? 'impo' : 'expo'),
        data.zona || null,
        data.cantidad_bultos || 1,
        data.peso_real,
        data.largo ?? null,
        data.ancho ?? null,
        data.alto ?? null,
        pesoVolumetrico,
        pesoFacturable,
        data.fob ?? 0,
        data.total_cobrado ?? 0,
        data.observaciones || null,
        data.numero_salida ?? null,
        data.bulto ?? null,
        data.tipo_paquete ?? null,
        data.asegurado ?? 0,
        data.ddp ?? 0,
        data.proteccion_doc ?? 0,
        data.remota ?? 0,
        data.entrega ?? null,
        desglose ? desglose.flete : (data.flete ?? null),
        desglose ? desglose.descuento : (data.descuento ?? null),
        desglose ? desglose.seguro : (data.seguro ?? null),
        desglose ? desglose.fuel : (data.fuel ?? null),
        desglose ? desglose.fuel_pct : (data.fuel_pct ?? null),
        (desglose && desglose.fuel_origen) ?? data.fuel_origen ?? null,
        desglose ? desglose.derechos : (data.derechos ?? null),
        desglose ? desglose.adicionales : (data.adicionales ?? null),
        desglose ? desglose.otros : (data.otros ?? null),
        data.profit ?? null,
        data.porcentaje ?? null,
        desglose && desglose.extras && desglose.extras.length ? JSON.stringify(desglose.extras) : null,
        data.courier === 'UPS' ? (data.servicio_ups ?? null) : null,
        // "Sin numerar" (salida 0): desde el 14/08 se puede marcar ya en el alta, en vez
        // de cargar el envío y después entrar a Salidas a corregirlo.
        data.num_sal_cero ? 1 : 0,
        seguroVenta
      );
    const envioId = result.lastInsertRowid;
    if (hasBultos) await saveBultos(envioId, data.bultos);
    return envioId;
  };

  // Solo abre una transacción propia cuando hay bultos (múltiples escrituras que deben ser atómicas).
  // Sin bultos, un INSERT único ya es atómico en SQLite y puede ejecutarse dentro de
  // una transacción externa (como la de importarSalidas) sin anidar BEGIN.
  const id = hasBultos ? await db.transaction(doInsert) : await doInsert();
  return buscarPorId(id);
}

async function actualizar(id, data) {
  const db = getDb();
  const actual = await buscarPorId(id);
  if (!actual) return null;
  // Sin escape hatch: antes existía un flag `data.forzar` que salteaba este freno.
  // No lo usaba ningún archivo del frontend, pero cualquiera que mandara
  // {"forzar": true} por PUT /api/envios/:id podía cambiarle el cliente y la fecha
  // a un envío ya liquidado, dejando un liquidacion_items de una liquidación
  // confirmada apuntando a otro cliente. Se elimina.
  if (actual.liquidado) {
    const err = new Error('No se puede editar un envío ya liquidado');
    err.status = 400;
    throw err;
  }

  const merged = { ...actual, ...data, peso_real: data.peso_real ?? actual.peso_real };
  const bultos =
    data.bultos !== undefined ? data.bultos : actual.bultos?.length ? actual.bultos : [];
  const { pesoVolumetrico, pesoFacturable } = buildPesos({
    peso_real: merged.peso_real,
    bultos,
    largo: data.largo ?? actual.largo,
    ancho: data.ancho ?? actual.ancho,
    alto: data.alto ?? actual.alto,
  });

  // ── Recálculo del costo al editar ────────────────────────────────────────────
  //
  // Antes esto NO se hacía: se actualizaban el peso, el país y el courier, pero las
  // columnas de costo (flete, seguro, fuel, adicionales, extras_json) quedaban con el
  // número del alta. Editar un envío de 5 kg a 50 kg dejaba el costo de 5 kg y una
  // utilidad fantasma. Además tipo_paquete, asegurado, ddp y la zona de entrega ni
  // siquiera se guardaban: tildarlos en la edición no hacía nada.
  //
  // Solo se recalcula si cambió algo que MUEVE el precio. Una edición de observaciones
  // o del número de guía no puede recotizar: el costo quedó congelado con la tarifa y
  // el fuel del día del alta, y recalcularlo por una nota lo movería sin motivo.
  const CAMPOS_QUE_MUEVEN_EL_COSTO = [
    'peso_real', 'largo', 'ancho', 'alto', 'bultos', 'cantidad_bultos',
    'pais_destino', 'zona', 'courier', 'tipo_envio', 'servicio_ups',
    'fob', 'fuel_pct', 'fuel_origen', 'tipo_paquete', 'asegurado', 'ddp', 'proteccion_doc', 'remota', 'entrega',
  ];
  const cambioElCosto = CAMPOS_QUE_MUEVEN_EL_COSTO.some((c) => {
    if (data[c] === undefined) return false;
    if (c === 'bultos') return true;
    return String(data[c] ?? '') !== String(actual[c] ?? '');
  });

  let desglose = null;
  if (cambioElCosto) {
    // El fuel se toma del envío (el congelado en su alta) salvo que la edición lo cambie:
    // un envío de mayo se recalcula con el fuel de mayo, no con el de hoy.
    desglose = await calcularDesgloseAlCosto({
      ...merged,
      bultos: bultos.length ? bultos : undefined,
      fuel_pct: data.fuel_pct !== undefined ? data.fuel_pct : actual.fuel_pct,
      fuel_origen: data.fuel_origen !== undefined ? data.fuel_origen : actual.fuel_origen,
    }, pesoFacturable);
  }

  // El seguro de venta negociado se recalcula SIEMPRE en la edición (la consulta es
  // barata y el envío no está liquidado): depende de cliente, courier y fob, y cualquiera
  // de los tres puede haber cambiado. Si el cliente ya no tiene seguro propio queda NULL,
  // que es "usar la escala de lista", el comportamiento de siempre.
  const seguroVenta = await calcularSeguroVenta(
    data.cliente_id ?? actual.cliente_id,
    data.courier ?? actual.courier,
    data.fob ?? actual.fob
  );

  // Si la edición dejó al envío SIN PESAR (le sacaron los pesos), las columnas de costo
  // tienen que quedar vacías, no conservar el número viejo. Con el COALESCE de siempre se
  // quedarían con el costo del peso anterior, que ya no corresponde a nada.
  const limpiarCosto = cambioElCosto && sinPesar(pesoFacturable);
  const costoSet = limpiarCosto
    ? `flete = ?, descuento = ?, seguro = ?, fuel = ?,
        derechos = ?, adicionales = ?, otros = ?, extras_json = ?`
    : `flete = COALESCE(?, flete), descuento = COALESCE(?, descuento),
        seguro = COALESCE(?, seguro), fuel = COALESCE(?, fuel),
        derechos = COALESCE(?, derechos), adicionales = COALESCE(?, adicionales),
        otros = COALESCE(?, otros), extras_json = COALESCE(?, extras_json)`;

  // Si la edición CAMBIA el tipo de envío y no trae direccion explícita, la direccion lo
  // sigue (misma regla que el alta). Si el tipo no se toca, la direccion tampoco: lo que
  // haya elegido la oficina en el modal de Salidas se respeta.
  const cambiaTipo = data.tipo_envio !== undefined
    && String(data.tipo_envio) !== String(actual.tipo_envio);
  const direccionNueva = data.direccion !== undefined
    ? data.direccion
    : (cambiaTipo ? (data.tipo_envio === 'importacion' ? 'impo' : 'expo') : actual.direccion);

  await db.transaction(async () => {
    await db.prepare(
      `UPDATE envios SET
        cliente_id = ?, fecha = ?, courier = ?, tipo_envio = ?, direccion = ?,
        numero_guia = ?, pais_destino = ?, zona = ?,
        cantidad_bultos = ?, peso_real = ?, largo = ?, ancho = ?, alto = ?,
        peso_volumetrico = ?, peso_facturable = ?,
        fob = ?, total_cobrado = ?, observaciones = ?,
        servicio_ups = ?, fuel_pct = ?,
        tipo_paquete = ?, asegurado = ?, ddp = ?, proteccion_doc = ?, remota = ?, entrega = ?,
        num_sal_cero = ?,
        seguro_venta = ?,
        ${costoSet},
        updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    ).run(
      data.cliente_id ?? actual.cliente_id,
      data.fecha ?? actual.fecha,
      data.courier ?? actual.courier,
      data.tipo_envio ?? actual.tipo_envio,
      direccionNueva ?? 'expo',
      String(data.numero_guia ?? actual.numero_guia ?? '').trim().toUpperCase() || actual.numero_guia,
      data.pais_destino ?? actual.pais_destino,
      data.zona !== undefined ? data.zona : actual.zona,
      data.cantidad_bultos ?? actual.cantidad_bultos,
      merged.peso_real,
      data.largo !== undefined ? data.largo : actual.largo,
      data.ancho !== undefined ? data.ancho : actual.ancho,
      data.alto !== undefined ? data.alto : actual.alto,
      pesoVolumetrico,
      pesoFacturable,
      data.fob ?? actual.fob,
      data.total_cobrado ?? actual.total_cobrado,
      data.observaciones !== undefined ? data.observaciones : actual.observaciones,
      (data.courier ?? actual.courier) === 'UPS' ? (data.servicio_ups !== undefined ? data.servicio_ups : actual.servicio_ups) : null,
      desglose ? desglose.fuel_pct : (data.fuel_pct !== undefined ? data.fuel_pct : actual.fuel_pct),
      data.tipo_paquete !== undefined ? data.tipo_paquete : actual.tipo_paquete,
      data.asegurado !== undefined ? (data.asegurado ? 1 : 0) : actual.asegurado,
      data.ddp !== undefined ? (data.ddp ? 1 : 0) : actual.ddp,
      data.proteccion_doc !== undefined ? (data.proteccion_doc ? 1 : 0) : actual.proteccion_doc,
      data.remota !== undefined ? (data.remota ? 1 : 0) : actual.remota,
      data.entrega !== undefined ? data.entrega : actual.entrega,
      data.num_sal_cero !== undefined ? (data.num_sal_cero ? 1 : 0) : actual.num_sal_cero,
      seguroVenta,
      // Los ocho de abajo son siempre los mismos parámetros; lo que cambia es el SQL de
      // arriba. Sin recálculo van todos NULL y el COALESCE deja la columna como estaba;
      // con el envío sin pesar, esos mismos NULL la vacían.
      desglose ? desglose.flete : null,
      desglose ? desglose.descuento : null,
      desglose ? desglose.seguro : null,
      desglose ? desglose.fuel : null,
      desglose ? desglose.derechos : null,
      desglose ? desglose.adicionales : null,
      desglose ? desglose.otros : null,
      desglose && desglose.extras && desglose.extras.length ? JSON.stringify(desglose.extras) : null,
      id
    );
    if (data.bultos !== undefined) {
      if (data.bultos.length > 0) await saveBultos(id, data.bultos);
      else await db.prepare('DELETE FROM envio_bultos WHERE envio_id = ?').run(id);
    }
  });
  return buscarPorId(id);
}

async function listarPendientesPorCliente(filtros = {}) {
  const db = getDb();
  let sql = `
    SELECT e.*, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre, c.tipo_cobro, c.id AS cliente_id
    FROM envios e
    JOIN clientes c ON c.id = e.cliente_id
    -- NO VOLO: un envio que no salio no se le factura al cliente, asi que ni siquiera
    -- aparece en la lista de pendientes de liquidar. Si algun dia sale, se desmarca y
    -- vuelve a la lista solo.
    WHERE e.liquidado = 0 AND e.no_volo = 0`;
  const params = [];

  if (filtros.cliente_id) {
    sql += ' AND e.cliente_id = ?';
    params.push(filtros.cliente_id);
  }
  if (filtros.fecha_desde) {
    sql += ' AND e.fecha >= ?';
    params.push(filtros.fecha_desde);
  }
  if (filtros.fecha_hasta) {
    sql += ' AND e.fecha <= ?';
    params.push(filtros.fecha_hasta);
  }
  if (filtros.courier) {
    sql += ' AND e.courier = ?';
    params.push(filtros.courier);
  }
  if (filtros.tipo_cobro) {
    sql += ' AND c.tipo_cobro = ?';
    params.push(filtros.tipo_cobro);
  }

  // Se ordena por el MISMO nombre que se muestra en pantalla. Antes ordenaba por
  // `c.nombre` (la razón social) y mostraba `nombre_nova`: para los clientes donde los
  // dos difieren —"POLO TOP" se muestra como "GONZALO DE URQUIZA"— la lista parecía
  // desordenada al azar.
  sql += " ORDER BY COALESCE(NULLIF(c.nombre_nova,''), c.nombre) COLLATE NOCASE, e.fecha";
  const rows = (await db.prepare(sql).all(...params)).map(mapEnvio);

  // Map y NO un objeto común: las claves de un objeto que parecen números las reordena
  // JavaScript de menor a mayor, así que `Object.values()` devolvía los grupos por
  // cliente_id y tiraba a la basura el ORDER BY alfabético de la consulta. La lista de
  // pendientes salía ordenada por el número interno de cliente, que no significa nada
  // para el que la mira. Map respeta el orden en que se van agregando.
  const grupos = new Map();
  for (const row of rows) {
    const key = row.cliente_id;
    if (!grupos.has(key)) {
      grupos.set(key, {
        cliente_id: row.cliente_id,
        cliente_nombre: row.cliente_nombre,
        tipo_cobro: row.tipo_cobro,
        envios: [],
        total_cobrado: 0,
      });
    }
    const g = grupos.get(key);
    g.envios.push(row);
    g.total_cobrado += row.total_cobrado || 0;
  }
  return [...grupos.values()];
}

async function marcarLiquidados(envioIds, liquidacionId, fechaLiquidacion) {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE envios SET liquidado = 1, fecha_liquidacion = ?, liquidacion_id = ?,
      updated_at = datetime('now', 'localtime')
     WHERE id = ? AND liquidado = 0`
  );
  for (const id of envioIds) {
    await stmt.run(fechaLiquidacion, liquidacionId, id);
  }
}

module.exports = {
  buscarPorId,
  listar,
  crear,
  actualizar,
  listarPendientesPorCliente,
  marcarLiquidados,
  getBultos,
  buildPesos,
  calcularDesgloseAlCosto,
  calcularSeguroVenta,
};
