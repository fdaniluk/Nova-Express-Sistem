/**
 * publico.controller.js — lo que ve el CLIENTE por su link de cotización, sin sesión.
 *
 * ═══ LA REGLA QUE SOSTIENE ESTE ARCHIVO ═══
 *
 * Todo lo que sale de acá viaja a un navegador que NO es de la oficina. Por eso la
 * respuesta se arma por LISTA BLANCA: se copian a mano los campos que el cliente puede
 * ver (los mismos que la imagen de la cotización), y jamás se hace `...resultado` de un
 * objeto del motor. El motor devuelve fleteBase (el costo), modoVenta y precioKgVenta
 * (el precio negociado): cualquiera de esos tres en la respuesta es la fuga del margen
 * que se cerró el 20/08, ahora por la puerta pública. Hay un test que escanea la
 * respuesta entera contra una lista de palabras prohibidas.
 *
 * El cálculo pasa por cotizacion.service (fuel y tarifa del cliente resueltos como si
 * cotizara la oficina) y por el MISMO motor: el link no puede dar un precio distinto
 * del que daría la oficina. Eso también lo fija un test.
 */
const linkModel = require('../models/cotizador-link.model');
const cotizacionService = require('../services/cotizacion.service');
const { calcularPesos, canonizarPais } = require('../services/calculos.service');
const {
  cotizarServicio, ZONAS_DHL, ZONAS_UPS, ZONAS_UPS_I,
} = require('../../../shared/cotizador/cotizador-core');

const NOMBRE_CORTO = { 'DHL': 'DHL', 'UPS_EXP': 'UPS W.E', 'UPS_SAV': 'UPS W.S' };
const NOMBRE_LARGO = {
  'DHL': 'DHL Express Worldwide',
  'UPS_EXP': 'UPS Worldwide Expedited',
  'UPS_SAV': 'UPS Worldwide Saver',
};

/* Con `nombrar = 0` el link va "a secas", como el tarifario sin nombrar: las tarjetas
   dicen "Opción 1/2/3" y los renglones se limpian de toda marca. Es LA MISMA regla del
   tarifario: "Seguro DHL" abajo de un título genérico es nombrar el servicio igual.
   GoGreen también se renombra — es un producto DHL con nombre y apellido. */
function anonimizarExtra(nombre) {
  return String(nombre)
    .replace(/^GoGreen.*$/i, 'Recargo ambiental')
    .replace(/\s*\((DHL|UPS[^)]*)\)/gi, '')
    .replace(/\b(DHL|UPS)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function respuestaDeError(res, motivo) {
  // 404 para lo que no existe; 410 para lo que existió y ya no; 429 para el tope.
  if (motivo === 'no-existe') return res.status(404).json({ error: 'Este link no existe.' });
  if (motivo === 'tope') {
    return res.status(429).json({
      error: 'Este link alcanzó el máximo de cotizaciones por hoy. Escribinos por WhatsApp al +54 9 11 6500-2047.',
    });
  }
  const texto = motivo === 'vencido'
    ? 'Este link de cotización venció. Pedinos uno nuevo por WhatsApp al +54 9 11 6500-2047.'
    : 'Este link de cotización fue dado de baja. Escribinos por WhatsApp al +54 9 11 6500-2047.';
  return res.status(410).json({ error: texto });
}

/** GET /api/publico/cotizador/:codigo — lo mínimo para armar la pantalla. */
async function abrir(req, res, next) {
  try {
    const v = await linkModel.validarParaUso(req.params.codigo);
    if (!v.ok) return respuestaDeError(res, v.motivo);
    const { link } = v;

    // El saludo. Con cliente, su nombre "de fantasía" si existe.
    let nombre = link.nombre || null;
    if (link.cliente_id) {
      const c = await require('../db').getDb()
        .prepare("SELECT COALESCE(NULLIF(nombre_nova,''), nombre) AS n FROM clientes WHERE id = ?")
        .get(link.cliente_id);
      if (c) nombre = c.n;
    }

    // La lista de países se manda desde el servidor para que la página pública no
    // cargue el motor (el motor lleva las tarifas DE COSTO adentro).
    const paises = [...new Set([
      ...Object.keys(ZONAS_DHL), ...Object.keys(ZONAS_UPS), ...Object.keys(ZONAS_UPS_I),
    ])].sort((a, b) => a.localeCompare(b, 'es'));

    // El fuel de HOY, resuelto como para la oficina (cliente → config del courier). Se
    // manda para PRECARGAR el cuadrito editable de la página: el fuel cambia seguido y
    // el cliente tiene que poder poner el vigente que le pasemos.
    const servicios = linkModel.serviciosDe(link.couriers);
    const fuelHoy = await cotizacionService.resolverFuel({
      clienteId: link.cliente_id || null,
      servicio: servicios[0],
    });

    res.json({
      nombre,
      vence_en: link.vence_en,
      // Con nombrar=0 los servicios no viajan ni acá: la página no puede decir lo que
      // no sabe.
      servicios: link.nombrar ? servicios.map((sv) => NOMBRE_CORTO[sv]) : [],
      cuantos: servicios.length,
      fuel: Math.round((fuelHoy.fuelPct || 0) * 100) / 100,
      paises,
    });
  } catch (e) { next(e); }
}

/** POST /api/publico/cotizador/:codigo/cotizar — el número, por lista blanca. */
async function cotizar(req, res, next) {
  try {
    const v = await linkModel.validarParaUso(req.params.codigo);
    if (!v.ok) return respuestaDeError(res, v.motivo);
    const { link } = v;

    const b = req.body || {};
    const pais = String(b.pais || '').slice(0, 60);
    const tipo = b.tipo === 'import' ? 'import' : 'export';
    const valor = Math.max(0, Number(b.valor) || 0);
    // El fuel que cargó el cliente en el cuadrito (precargado con el de hoy). Se acota a
    // [0, 100]: es un porcentaje de combustible, no un campo libre.
    const fuelCliente = Number.isFinite(Number(b.fuel)) && b.fuel !== null && b.fuel !== ''
      ? Math.min(100, Math.max(0, Number(b.fuel)))
      : null;
    const bultos = Array.isArray(b.bultos) ? b.bultos.slice(0, 50) : [];

    if (!pais) return res.status(400).json({ error: 'Elegí el país de destino.' });
    const limpios = bultos
      .map((x) => ({
        peso_real: Number(x.pr) || 0,
        largo: Number(x.l) || 0,
        ancho: Number(x.a) || 0,
        alto: Number(x.al) || 0,
      }))
      .filter((x) => x.peso_real > 0 && x.largo > 0 && x.ancho > 0 && x.alto > 0);
    if (!limpios.length) {
      return res.status(400).json({ error: 'Cargá al menos un bulto con peso y medidas.' });
    }

    // El MISMO redondeo por bulto que usa la oficina (calcularPesos).
    const pesoReal = limpios.reduce((s, x) => s + x.peso_real, 0);
    const { pesoVolumetrico, pesoFacturable } = calcularPesos(pesoReal, limpios);

    const opciones = [];
    for (const servicio of linkModel.serviciosDe(link.couriers)) {
      // cotizacion.service resuelve fuel y tarifa EXACTAMENTE como para la oficina:
      // con cliente, su profit o su precio por kilo; sin cliente, el profit del link.
      const entrada = await cotizacionService.normalizarEntrada({
        cliente_id: link.cliente_id || undefined,
        profitPct: link.cliente_id ? undefined : (link.profit_pct || 0),
        profitManual: link.cliente_id ? undefined : true,
        servicio,
        tipo,
        pais,
        pesoFacturable,
        fob: valor,
        bultos: limpios,
        contenido: 'paquete',
      });
      const r = cotizarServicio(servicio, {
        pais: canonizarPais(pais) || pais,
        tipo,
        pf: pesoFacturable,
        fob: valor,
        fuelPct: fuelCliente !== null ? fuelCliente : entrada.fuelPct,
        profitPct: entrada.profitPct,
        bultosProc: limpios.map((x, i) => ({
          num: i + 1, pr: x.peso_real,
          pv: (x.largo * x.ancho * x.alto) / 5000,
          pf: Math.ceil(Math.max(x.peso_real, (x.largo * x.ancho * x.alto) / 5000) * 2) / 2,
          l: x.largo, a: x.ancho, al: x.alto,
          dims: [x.largo, x.ancho, x.alto].sort((m, n) => n - m),
        })),
        zonaOverride: entrada.zona,
        contenido: 'paquete',
        precioKgVenta: entrada.precioKgVenta,
        seguroPropio: entrada.seguroPropio,
      });
      if (!r) continue;

      /* LISTA BLANCA. Ver el comentario de arriba: nada del motor pasa entero. */
      const i = opciones.length + 1;
      opciones.push({
        servicio: link.nombrar ? NOMBRE_LARGO[servicio] : `Opción ${i}`,
        corto: link.nombrar ? NOMBRE_CORTO[servicio] : `Opción ${i}`,
        zona: r.zona,
        flete: Math.round(r.conGan * 100) / 100,
        surge: Math.round((r.surgeAmt || 0) * 100) / 100,
        subtotal: Math.round(r.subtotalConSurge * 100) / 100,
        fuel_pct: fuelCliente !== null ? fuelCliente : entrada.fuelPct,
        fuel_monto: Math.round(r.fuelMonto * 100) / 100,
        extras: (r.extras || []).map(([n, m]) => [
          link.nombrar ? n : anonimizarExtra(n),
          Math.round(m * 100) / 100,
        ]),
        total: Math.round(r.total * 100) / 100,
      });
    }

    if (!opciones.length) {
      return res.status(404).json({ error: `No tenemos tarifa para ${pais} en este servicio.` });
    }

    await linkModel.registrarConsulta(link.id);
    res.json({
      peso_real: Math.round(pesoReal * 10) / 10,
      peso_volumetrico: Math.round(pesoVolumetrico * 10) / 10,
      peso_facturable: pesoFacturable,
      bultos: limpios.length,
      valor_declarado: valor,
      tipo,
      pais,
      vence_en: link.vence_en,
      opciones,
    });
  } catch (e) { next(e); }
}

module.exports = { abrir, cotizar };
