/**
 * cotizacion.service.js — el ÚNICO lugar donde se arman los datos de entrada del motor.
 *
 * ═══ POR QUÉ EXISTE ═══
 *
 * La regla número uno del sistema es que todos los cotizadores den el mismo número. El
 * motor (shared/cotizador/cotizador-core.js) ya era uno solo, y eso está bien. El problema
 * nunca estuvo en el motor: estuvo en lo que cada pantalla le mandaba.
 *
 * Cada pantalla armaba los parámetros por su cuenta, y se fueron desviando de a una:
 *
 *   · Cargar envío no mandaba `contenido` → un documento DHL de 0,5 kg salía hasta 60%
 *     más caro que en el cotizador manual. (Arreglado caso por caso.)
 *   · Cargar envío no mandaba `ddp` → el envío se cargaba sin el cargo. (Idem.)
 *   · "Calcular venta" de Salidas mandaba fuel 0 cuando el envío no tenía fuel congelado
 *     —los envíos viejos lo tienen vacío— y sugería el precio SIN combustible. En un envío
 *     de 30 kg eran USD 89 de menos. (07/08/2026, lo encontró la oficina.)
 *   · La precarga del profit en Cargar envío preguntaba SIN el país. Sin país no hay zona,
 *     y sin zona no encuentra la celda de la matriz: mostraba el 75% general del cliente
 *     mientras el sistema cobraba el 70% de la celda. (Idem.)
 *
 * Son cuatro versiones del mismo error. Arreglarlos de a uno no sirve: el quinto ya está
 * esperando. La única forma de que no vuelva a pasar es que las pantallas NO armen los
 * datos — que manden lo que saben y que la resolución de todo lo demás pase por acá.
 *
 * ═══ LAS CADENAS DE RESOLUCIÓN ═══
 *
 * FUEL (combustible). Desde el 07/08/2026 hay TRES fuels configurables —Nova, DHL y UPS—
 * y quien carga el envío elige cuál se aplica en un desplegable. Esa elección manda sobre
 * todo lo demás y queda guardada en el envío (columna `fuel_origen`), para que dentro de un
 * mes se pueda explicar por qué ese envío tiene ese porcentaje.
 *
 * Sin elección expresa, la cadena de siempre, de mayor a menor precedencia:
 *   1. El fuel propio del CLIENTE, si tiene uno negociado. Es lo que se le cobra a él,
 *      distinto de lo que nos cobra el courier.
 *   2. El fuel congelado del ENVÍO, si se cotiza sobre un envío existente. Un envío de mayo
 *      se recotiza con el fuel de mayo, no con el de hoy.
 *   3. El fuel de CONFIGURACIÓN del courier. Es el paso que faltaba y el que causó el bug:
 *      sin él, un envío sin fuel congelado cotizaba en 0.
 *   4. Cero, solo si no hay ninguna configuración cargada.
 *
 * ZONA: la manda el PAÍS. La zona suelta solo se usa cuando el país no resuelve ninguna
 * (país escrito raro, o cotización a mano sin país). Es la regla que ya aplicaba buscarZona;
 * lo que se agrega es que TODOS los caminos la usen igual, incluido el resolvedor de profit.
 *
 * PROFIT: lo decide resolverTarifaVenta con la zona YA resuelta. Ese detalle es el que
 * fallaba: preguntar el profit sin zona devuelve otro número que el que se termina
 * cobrando, y las dos cosas se muestran en pantallas distintas.
 */

const { getDb } = require('../db');
const profitService = require('./profit.service');
const configuracionModel = require('../models/configuracion.model');
const {
  buscarZona, ZONAS_DHL, ZONAS_UPS, ZONAS_UPS_I,
} = require('./calculos.service');

const SERVICIOS_UPS = ['UPS_EXP', 'UPS_SAV'];

/** 'DHL' | 'UPS_EXP' | 'UPS_SAV' → el courier al que le corresponde la config de fuel. */
function courierDe(servicio) {
  return servicio === 'DHL' ? 'DHL' : 'UPS';
}

/** El servicio tal como lo espera la matriz de profit (UPS_SAV se llama UPS_SAVER ahí). */
function servicioMatriz(servicio) {
  return servicio === 'UPS_SAV' ? 'UPS_SAVER' : servicio;
}

function normalizarServicio(servicio, courier) {
  // EL COURIER MANDA. Si el modal pasó el envío a DHL, el servicio es DHL aunque el envío
  // siga guardando su servicio_ups viejo; el servicio solo elige la variante de UPS.
  // Al revés —quedarse con el servicio guardado— cotizaría por UPS un envío que el usuario
  // acaba de pasar a DHL.
  if (courier) {
    if (String(courier).toUpperCase() === 'DHL') return 'DHL';
    return SERVICIOS_UPS.includes(servicio) ? servicio : 'UPS_EXP';
  }
  if (servicio === 'DHL' || SERVICIOS_UPS.includes(servicio)) return servicio;
  return 'UPS_EXP';
}

function normalizarTipo(tipo, tipoEnvio) {
  if (tipo === 'import' || tipo === 'export') return tipo;
  return String(tipoEnvio || '').toLowerCase().includes('import') ? 'import' : 'export';
}

/**
 * Resuelve la zona con la MISMA regla en todos lados: manda el país; la zona suelta es
 * el respaldo. Se expone aparte porque el resolvedor de profit también la necesita, y
 * que use otra regla es exactamente el bug que estamos cerrando.
 */
function resolverZona({ servicio, tipo, pais, zona }) {
  const mapa = servicio === 'DHL' ? ZONAS_DHL : (tipo === 'import' ? ZONAS_UPS_I : ZONAS_UPS);
  return buscarZona(mapa, pais, zona);
}

/**
 * El fuel que corresponde, con toda la cadena. `fuelEnvio` es el congelado del envío y
 * `fuelBody` el que mandó la pantalla; los dos son opcionales.
 *
 * Se distingue "no vino" (null/undefined) de "vino en cero". Un 0 explícito es una
 * decisión de quien cotiza y se respeta; un vacío NO puede terminar en 0 por descuido,
 * que es justamente lo que pasaba.
 */
async function resolverFuel({ clienteId, fuelEnvio, fuelBody, fuentePedida, origenGuardado, servicio }) {
  // 1. FUENTE PEDIDA EXPRESAMENTE. Si quien carga el envío eligió una del desplegable,
  //    manda esa y no se discute. Es una decisión de una persona sobre un envío concreto.
  const fuente = String(fuentePedida || '').toLowerCase();

  if (fuente === 'manual') {
    // "A mano": el número lo escribió alguien. Un 0 acá es deliberado y se respeta.
    const n = Number(fuelBody);
    return { fuelPct: Number.isFinite(n) ? n : 0, origen: 'manual' };
  }
  if (fuente === 'nova') {
    const nova = await leerFuelNova();
    return { fuelPct: nova, origen: 'nova' };
  }
  if (fuente === 'dhl' || fuente === 'ups') {
    return { fuelPct: await leerFuelCourier(fuente.toUpperCase()), origen: fuente };
  }
  if (fuente === 'cliente') {
    const propio = clienteId ? await profitService.resolverFuelPropio(clienteId) : null;
    if (propio !== null && propio !== undefined) return { fuelPct: Number(propio), origen: 'cliente' };
    // Pidieron el del cliente y el cliente no tiene: se sigue la cadena en vez de cobrar 0.
  }

  // 2. Sin fuente pedida, la cadena de siempre.
  if (clienteId) {
    const propio = await profitService.resolverFuelPropio(clienteId);
    if (propio !== null && propio !== undefined) {
      return { fuelPct: Number(propio), origen: 'cliente' };
    }
  }
  if (fuelEnvio !== null && fuelEnvio !== undefined && fuelEnvio !== '') {
    // Se usa el porcentaje CONGELADO del envio, pero se informa de donde habia salido
    // ('nova', 'dhl', ...) en vez de un 'envio' que no explica nada.
    return { fuelPct: Number(fuelEnvio), origen: origenGuardado || 'envio' };
  }
  if (fuelBody !== null && fuelBody !== undefined && fuelBody !== '') {
    return { fuelPct: Number(fuelBody), origen: 'body' };
  }
  const pctCourier = await leerFuelCourier(courierDe(servicio));
  if (pctCourier !== null) return { fuelPct: pctCourier, origen: 'configuracion' };
  return { fuelPct: 0, origen: 'sin_fuel' };
}

/** El % de Nova. Devuelve 0 si nunca se cargó — y el panel de salud lo marca. */
async function leerFuelNova() {
  try {
    const fila = await configuracionModel.obtenerFuelNova();
    return Number(fila && fila.fuel_pct) || 0;
  } catch (e) {
    console.error('[cotizacion] no se pudo leer el Fuel Nova:', e.message);
    return 0;
  }
}

/** El % que nos cobra un courier, de Configuración. null si no hay fila. */
async function leerFuelCourier(courier) {
  try {
    const filas = await configuracionModel.listarFuel();
    const cfg = (filas || []).find((f) => f.courier === courier);
    if (cfg && cfg.fuel_pct !== null && cfg.fuel_pct !== undefined) return Number(cfg.fuel_pct);
  } catch (e) {
    console.error('[cotizacion] no se pudo leer el fuel de configuración:', e.message);
  }
  return null;
}

/**
 * Trae de la base todo lo que define la cotización de un envío ya cargado. Con esto la
 * pantalla de Salidas no tiene que armar nada: manda el id y el servidor sabe el resto.
 */
async function leerEnvio(envioId) {
  const db = getDb();
  return db.prepare(`
    SELECT e.id, e.cliente_id, e.courier, e.servicio_ups, e.tipo_envio, e.pais_destino,
           e.zona, e.fob, e.fuel_pct, e.fuel_origen, e.tipo_paquete, e.ddp, e.proteccion_doc, e.entrega,
           e.remota, e.peso_real, e.largo, e.ancho, e.alto, e.peso_facturable
    FROM envios e WHERE e.id = ?`).get(envioId);
}

/**
 * EL NORMALIZADOR. Recibe lo que mandó cualquier pantalla —o un envio_id— y devuelve el
 * juego COMPLETO de parámetros del motor, con todo resuelto y con la trazabilidad de de
 * dónde salió cada cosa (los `*_origen`, que son lo que se muestra en pantalla).
 *
 * Todos los caminos que devuelven un precio tienen que pasar por acá. Si mañana aparece
 * una pantalla nueva y arma los parámetros por su cuenta, vuelve el problema.
 */
async function normalizarEntrada(crudo = {}) {
  const c = { ...crudo };

  // ── Envío existente: sus datos son la base, y lo que mande la pantalla los pisa ─────
  // (la pantalla de Salidas edita peso, país y courier antes de pedir el precio).
  let envio = null;
  if (c.envio_id) {
    envio = await leerEnvio(c.envio_id);
    if (!envio) {
      const err = new Error(`No existe el envío ${c.envio_id}`);
      err.status = 404;
      throw err;
    }
  }

  const tomar = (delBody, delEnvio) => (delBody !== undefined && delBody !== null && delBody !== ''
    ? delBody
    : (envio ? delEnvio : undefined));

  const courier = tomar(c.courier, envio && envio.courier);
  const servicio = normalizarServicio(
    c.servicio !== undefined && c.servicio !== null && c.servicio !== ''
      ? c.servicio
      : (envio ? envio.servicio_ups : undefined),
    courier,
  );
  const tipo = normalizarTipo(c.tipo, envio && envio.tipo_envio);
  const pais = tomar(c.pais, envio && envio.pais_destino) || null;
  const clienteId = tomar(c.cliente_id, envio && envio.cliente_id) || null;

  const zona = resolverZona({
    servicio, tipo, pais, zona: tomar(c.zona, envio && envio.zona),
  });

  const pesoFacturable = Number(tomar(c.pesoFacturable, envio && envio.peso_facturable)) || 0;
  const fob = Number(tomar(c.fob, envio && envio.fob)) || 0;

  let bultos = Array.isArray(c.bultos) ? c.bultos : null;
  if (!bultos && envio) {
    bultos = [{
      peso_real: envio.peso_real, largo: envio.largo, ancho: envio.ancho, alto: envio.alto,
    }];
  }

  const boolDe = (delBody, delEnvio) => (delBody !== undefined && delBody !== null
    ? Boolean(delBody)
    : Boolean(envio ? delEnvio : false));

  const ddp = boolDe(c.ddp, envio && envio.ddp);
  const proteccionDoc = boolDe(c.proteccionDoc, envio && envio.proteccion_doc);
  const entrega = tomar(c.entrega, envio && envio.entrega)
    || (boolDe(c.remota, envio && envio.remota) ? 'extendida' : 'normal');
  const contenido = (c.contenido !== undefined && c.contenido !== null && c.contenido !== '')
    ? (c.contenido === 'documento' ? 'documento' : 'paquete')
    : ((envio && envio.tipo_paquete === 'd') ? 'documento' : 'paquete');

  // ── Fuel ───────────────────────────────────────────────────────────────────────────
  // `fuenteFuel` es lo que eligió la persona en el desplegable de Cargar envío
  // ('nova' | 'dhl' | 'ups' | 'cliente' | 'manual'). Si el envío ya existe y no viene una
  // nueva, se respeta la que quedó guardada: recotizar un envío no le puede cambiar de
  // dónde sale el fuel sin que nadie lo pida.
  // OJO: la fuente sale SOLO del body, nunca de la guardada en el envio. Si se
  // re-resolviera la guardada, un envio de mayo con "Fuel Nova" se recotizaria con el Nova
  // de HOY y cambiar ese porcentaje reescribiria el pasado. El envio conserva su
  // porcentaje congelado; lo que se recupera de la columna es solo la ETIQUETA, para poder
  // decir de donde habia salido.
  const fuentePedida = c.fuenteFuel;
  const fuel = await resolverFuel({
    clienteId,
    fuelEnvio: envio ? envio.fuel_pct : undefined,
    fuelBody: c.fuelPct,
    fuentePedida,
    origenGuardado: envio ? envio.fuel_origen : null,
    servicio,
  });

  // ── Profit ─────────────────────────────────────────────────────────────────────────
  // Con la zona YA resuelta: es la corrección de fondo del bug del 70 vs 75.
  let profitPct = Number(c.profitPct) || 0;
  let profitOrigen = 'body';
  let precioKgVenta = null;
  let modoVenta = 'porcentaje';
  let advertencia = null;

  if (c.profitManual === true) {
    profitOrigen = 'manual';
  } else if (clienteId) {
    const resuelto = await profitService.resolverTarifaVenta({
      clienteId,
      servicio: servicioMatriz(servicio),
      tipo,
      zona,
      pesoFacturable,
    });
    if (resuelto) {
      profitPct = resuelto.profitPct;
      profitOrigen = resuelto.origen;
      precioKgVenta = resuelto.precioKg;
      modoVenta = resuelto.modo;
      advertencia = resuelto.advertencia;
    } else {
      console.warn(`[cotizacion] cliente_id=${clienteId} inexistente; se usa el profitPct del body`);
    }
  }

  const seguroPropio = clienteId ? await profitService.resolverSeguroPropio(clienteId) : null;

  return {
    // Para el motor
    pais, tipo, servicio, pesoFacturable, fob,
    fuelPct: fuel.fuelPct, profitPct, zona, bultos: bultos || [],
    ddp, proteccionDoc, entrega, contenido, precioKgVenta, seguroPropio,
    // Para mostrar y para auditar de dónde salió cada número
    cliente_id: clienteId,
    envio_id: envio ? envio.id : null,
    profit_origen: profitOrigen,
    fuel_origen: fuel.origen,
    modo_venta: modoVenta,
    precio_kg_aplicado: precioKgVenta,
    advertencia,
  };
}

module.exports = {
  normalizarEntrada, resolverZona, resolverFuel, servicioMatriz, courierDe, leerEnvio,
};
