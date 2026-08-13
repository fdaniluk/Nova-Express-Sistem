/**
 * tarifario.service.js — el tarifario que se le manda AL CLIENTE.
 *
 * ═══ QUÉ ES ═══
 *
 * Una grilla de precios de VENTA por peso y destino, para mandarle al cliente por mail o
 * por WhatsApp. Es, en palabras de Felipe, una carta de presentación: se usa sobre todo
 * con clientes nuevos.
 *
 * ═══ LAS REGLAS QUE LO DEFINEN (Felipe, 13/08/2026) ═══
 *
 *  1. TODO SALE EN NÚMEROS. El cliente nunca ve un porcentaje: "¿para qué querría ver un
 *     porcentaje un cliente si él no entiende los porcentajes?". Si el cliente cobra por
 *     porcentaje, se toma la tarifa del courier, se le suma su profit y se pasa a número.
 *     Si cobra por kilo, es precio × kilos. La celda siempre es plata.
 *  2. EL FUEL NO VIAJA. Cambia todos los meses; un tarifario impreso con fuel adentro
 *     nace vencido. Va en las notas, y solo si se pide.
 *  3. NI COSTOS NI MÁRGENES. Nunca. Ni en el JSON que sale de acá.
 *  4. LA CELDA ES EL FLETE DE VENTA Y NADA MÁS: sin fuel, sin seguro, sin GoGreen, sin
 *     surge, sin recargos por zona remota. Todo eso va en el cuadro de notas.
 *
 * ═══ POR QUÉ NO CALCULA NADA POR SU CUENTA ═══
 *
 * Cada celda es una cotización simulada que pasa por `resolverTarifaVenta()` —el único
 * decisor de precio de venta del sistema— y por `cotizarServicio()` —el motor—. Es la
 * regla del motor único: si el tarifario tuviera su propia fórmula, el día que cambie una
 * tarifa habría dos lugares para tocar y el papel que firmó el cliente diría un número que
 * el sistema no cobra.
 *
 * ═══ EL PROBLEMA DE LAS ZONAS EN EL TARIFARIO COMBINADO ═══
 *
 * Las zonas de DHL y las de UPS NO son las mismas: Estados Unidos es zona 3 en DHL y zona 2
 * en UPS; Colombia al revés. De 17 países medidos, 6 caen distinto. Entonces una columna
 * "zona 3" que mezcle los dos couriers no significa nada.
 *
 * Solución: el tarifario usa SIEMPRE el mapa de zonas de DHL como mapa de Nova (es el que
 * conoce la oficina y el que se le explica al cliente en el bloque de destinos), y cuando
 * se combinan servicios, para cada zona de Nova se miran TODAS las zonas en las que caen
 * sus países en el otro courier. Ver `zonasEquivalentes()`.
 */

const path = require('path');
const {
  cotizarServicio, ZONAS_DHL, ZONAS_UPS, ZONAS_UPS_I,
} = require(path.join(__dirname, '../../../shared/cotizador/cotizador-core'));
const profitService = require('./profit.service');
const clienteModel = require('../models/cliente.model');
const { getDb } = require('../db');

/** Los seis destinos del tarifario. El número es la zona de DHL, que es el mapa de Nova. */
const DESTINOS = [
  { zona: 1, nombre: 'Mercosur',                  ejemplos: 'Brasil · Chile · Uruguay · Paraguay · Bolivia' },
  { zona: 2, nombre: 'Resto Sudamérica y Caribe', ejemplos: 'Colombia · Ecuador · Perú · Centroamérica · Caribe' },
  { zona: 3, nombre: 'Norteamérica',              ejemplos: 'EE.UU. · Canadá · México' },
  { zona: 4, nombre: 'Europa',                    ejemplos: 'Unión Europea · Reino Unido · Suiza' },
  { zona: 5, nombre: 'Asia',                      ejemplos: 'China · Japón · India · Sudeste asiático' },
  { zona: 6, nombre: 'Resto del mundo',           ejemplos: 'África · Oceanía · Medio Oriente' },
];

const SERVICIOS = {
  DHL:       { label: 'DHL Express Worldwide', matriz: 'DHL' },
  UPS_EXP:   { label: 'UPS Worldwide Expedited', matriz: 'UPS_EXP' },
  UPS_SAVER: { label: 'UPS Worldwide Saver', matriz: 'UPS_SAVER' },
};

/** El servicio tal como lo espera el motor (la matriz de profit usa UPS_SAVER). */
function servicioMotor(servicio) {
  return servicio === 'UPS_SAVER' ? 'UPS_SAVER' : servicio;
}

/**
 * Para una zona de Nova (= zona de DHL) y un servicio, en qué zonas de ESE servicio caen
 * los países que la componen. Para DHL siempre devuelve la misma; para UPS puede devolver
 * dos o tres, porque UPS zonifica distinto.
 */
function zonasEquivalentes(zonaNova, servicio, tipo) {
  if (servicio === 'DHL') return [zonaNova];
  const mapaUps = tipo === 'import' ? ZONAS_UPS_I : ZONAS_UPS;
  const set = new Set();
  for (const [pais, z] of Object.entries(ZONAS_DHL)) {
    if (Number(z) !== Number(zonaNova)) continue;
    const zu = mapaUps[pais];
    if (zu) set.add(Number(zu));
  }
  // Si ningún país de esa zona existe en el mapa del otro courier, se cae a la misma zona:
  // es preferible un número aproximado a un guion en el tarifario.
  return set.size ? [...set].sort((a, b) => a - b) : [zonaNova];
}

/**
 * Los pesos del tarifario. `paso` puede ser un número (0.5, 1, 5, 10) o 'auto', que sigue
 * la granularidad real de la tabla del courier: de a 0,5 hasta 30 kg y de a 1 arriba.
 *
 * Arriba de 30 kg la tabla de DHL es de a 1 kg, así que poner medios kilos ahí repite el
 * mismo precio en dos renglones seguidos y el tarifario queda mal.
 */
function armarPesos({ desde = 0.5, hasta = 50, paso = 'auto' }) {
  const d = Math.max(0.5, Number(desde) || 0.5);
  const h = Number(hasta) || 50;
  const pesos = [];
  if (paso === 'auto' || paso === null || paso === undefined) {
    for (let p = d; p <= Math.min(h, 30) + 1e-9; p += 0.5) pesos.push(redondear(p));
    for (let p = Math.max(31, Math.ceil(d)); p <= h + 1e-9; p += 1) pesos.push(redondear(p));
  } else {
    const s = Number(paso);
    if (!Number.isFinite(s) || s <= 0) throw badRequest('El paso tiene que ser un número mayor que cero.');
    for (let p = d; p <= h + 1e-9; p += s) pesos.push(redondear(p));
  }
  if (!pesos.length) throw badRequest('El rango de pesos quedó vacío.');
  if (pesos.length > 700) throw badRequest(`El rango pedido da ${pesos.length} filas. Achicá el rango o agrandá el paso.`);
  return pesos;
}

function redondear(n) { return Math.round(n * 100) / 100; }

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

/**
 * LOS CORTES DE PRECIO DEL CLIENTE.
 *
 * Un tarifario de 0 a 200 kg con tres servicios son miles de celdas, y preguntarle a
 * `resolverTarifaVenta()` por cada una es lo que hacía que la vista previa tardara diez
 * segundos. Pero la tarifa NO cambia kilo a kilo: cambia en los bordes de los tramos del
 * cliente y en los de sus filas de precio por kilo (las viejas, de rango libre, cortan
 * donde se les cargó: 20-32, 32,5+, 25+...).
 *
 * Entonces se juntan TODOS esos bordes y se pregunta una vez por intervalo. Dentro de un
 * intervalo la respuesta es la misma por definición, porque no hay ninguna fila que empiece
 * ni termine ahí adentro. Sigue decidiendo `resolverTarifaVenta()`: esto solo evita
 * repetirle la misma pregunta.
 */
async function cortesDelCliente(clienteId) {
  const tramos = await profitService.obtenerTramos(clienteId);
  const bordes = new Set([0]);
  for (const t of tramos) {
    if (t.min !== null && t.min !== undefined) bordes.add(Number(t.min));
    if (t.max !== null && t.max !== undefined) bordes.add(Number(t.max));
  }
  const filas = await getDb()
    .prepare('SELECT DISTINCT peso_min, peso_max FROM tarifa_kg_overrides WHERE cliente_id = ?')
    .all(clienteId) || [];
  for (const f of filas) {
    if (f.peso_min !== null && f.peso_min !== undefined) bordes.add(Number(f.peso_min));
    if (f.peso_max !== null && f.peso_max !== undefined) bordes.add(Number(f.peso_max));
  }
  return [...bordes].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
}

/** En qué intervalo entre cortes cae este peso. Es la clave de la memoria. */
function intervaloDe(cortes, peso) {
  let i = 0;
  while (i < cortes.length && peso > cortes[i]) i += 1;
  return i;
}

/**
 * El precio de venta de UNA celda: un peso, una zona, un servicio.
 *
 * Devuelve SOLO el flete de venta (`conGan` del motor). Ni fuel —va en cero a propósito—,
 * ni seguro —el fob va en cero, así que el motor no lo agrega—, ni recargos dimensionales
 * —no hay bultos—. Eso es exactamente lo que tiene que decir un tarifario.
 */
async function precioCelda({ clienteId, servicio, tipo, zona, peso, contenido, memo, cortes }) {
  const clave = `${servicio}|${tipo}|${zona}|${intervaloDe(cortes, peso)}`;
  let tarifa;
  if (memo.has(clave)) {
    tarifa = memo.get(clave);
  } else {
    tarifa = await profitService.resolverTarifaVenta({
      clienteId,
      servicio: SERVICIOS[servicio].matriz,
      tipo,
      zona,
      pesoFacturable: peso,
      // Sin esto, un tarifario de un cliente por kilo con huecos escupe un warning por
      // celda: cientos de líneas de log por cada PDF generado.
      avisar: false,
    });
    memo.set(clave, tarifa);
  }
  const r = cotizarServicio(servicioMotor(servicio), {
    tipo,
    pf: peso,
    zonaOverride: zona,
    fuelPct: 0,
    fob: 0,
    bultosProc: [],
    contenido: contenido === 'documento' ? 'documento' : 'paquete',
    profitPct: tarifa ? tarifa.profitPct : 0,
    precioKgVenta: tarifa ? tarifa.precioKg : null,
  });
  if (!r) return null;
  return redondear(r.conGan);
}

/**
 * Una fila: el peso y el precio de cada destino.
 *
 * `base` decide qué hacer cuando hay más de un servicio seleccionado y el tarifario NO los
 * nombra (el caso que describió Felipe: le manda el de UPS Expedited y después despacha por
 * donde le conviene):
 *   'alto'  → el más caro de los seleccionados. Por defecto, porque es el único que no lo
 *             puede dejar cobrando menos de lo que prometió.
 *   'bajo'  → el más barato, para pelear un cliente.
 *   'medio' → el del medio.
 */
function elegirBase(valores, base) {
  const v = valores.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!v.length) return null;
  if (base === 'bajo') return v[0];
  if (base === 'medio') return v[Math.floor((v.length - 1) / 2)];
  return v[v.length - 1];
}

/**
 * Arma el tarifario completo.
 *
 * Cuando `combinar` es false devuelve una tabla por servicio (el caso "el cliente pidió
 * UPS Expedited" y el caso comparativa). Cuando es true devuelve UNA tabla sin nombre de
 * servicio, con la base de precios elegida.
 */
async function generarTarifario({
  clienteId,
  servicios = ['DHL'],
  tipo = 'export',
  desde = 0.5,
  hasta = 50,
  paso = 'auto',
  combinar = false,
  base = 'alto',
  documentos = true,
}) {
  const cliente = await clienteModel.buscarPorId(clienteId);
  if (!cliente) {
    const e = new Error(`No existe el cliente ${clienteId}`);
    e.status = 404;
    throw e;
  }
  const elegidos = (Array.isArray(servicios) ? servicios : [servicios])
    .map((s) => String(s).toUpperCase())
    .filter((s) => SERVICIOS[s]);
  if (!elegidos.length) throw badRequest('Hay que elegir al menos un servicio.');
  if (tipo !== 'export' && tipo !== 'import') throw badRequest('El tipo tiene que ser export o import.');

  const pesos = armarPesos({ desde, hasta, paso });
  // Documentos: solo DHL y solo hasta 2 kg. Arriba de eso el motor ya cobra tarifa de
  // paquete, así que una tabla de documentos más larga estaría mintiendo.
  const pesosDoc = documentos && elegidos.includes('DHL') && tipo === 'export'
    ? [0.5, 1, 1.5, 2].filter((p) => p >= Number(desde) - 1e-9)
    : [];

  const cortes = await cortesDelCliente(clienteId);
  const memo = new Map();

  async function armarFilas(lista, contenido, servs) {
    const filas = [];
    for (const peso of lista) {
      const celdas = [];
      for (const d of DESTINOS) {
        const valores = [];
        for (const servicio of servs) {
          for (const zonaServicio of zonasEquivalentes(d.zona, servicio, tipo)) {
            // eslint-disable-next-line no-await-in-loop
            valores.push(await precioCelda({
              clienteId, servicio, tipo, zona: zonaServicio, peso, contenido, memo, cortes,
            }));
          }
        }
        celdas.push(elegirBase(valores, base));
      }
      filas.push({ peso, precios: celdas });
    }
    return filas;
  }

  const tablas = [];
  if (combinar || elegidos.length === 1) {
    if (pesosDoc.length) {
      tablas.push({
        titulo: 'Documentos (USD)',
        servicio: combinar ? null : elegidos[0],
        filas: await armarFilas(pesosDoc, 'documento', elegidos),
      });
    }
    tablas.push({
      titulo: 'Paquetes (USD)',
      servicio: combinar ? null : elegidos[0],
      filas: await armarFilas(pesos, 'paquete', elegidos),
    });
  } else {
    // Comparativa: una tabla por servicio, cada una con su nombre.
    for (const servicio of elegidos) {
      if (servicio === 'DHL' && pesosDoc.length) {
        // eslint-disable-next-line no-await-in-loop
        tablas.push({ titulo: 'Documentos (USD)', servicio, filas: await armarFilas(pesosDoc, 'documento', [servicio]) });
      }
      // eslint-disable-next-line no-await-in-loop
      tablas.push({ titulo: 'Paquetes (USD)', servicio, filas: await armarFilas(pesos, 'paquete', [servicio]) });
    }
  }

  return {
    cliente: { id: cliente.id, nombre: cliente.nombre },
    tipo,
    servicios: elegidos,
    combinar: Boolean(combinar),
    base: combinar ? base : null,
    rango: { desde: pesos[0], hasta: pesos[pesos.length - 1], paso },
    destinos: DESTINOS,
    tablas,
    etiquetas: elegidos.map((s) => SERVICIOS[s].label),
  };
}

module.exports = {
  generarTarifario, DESTINOS, SERVICIOS, armarPesos, zonasEquivalentes, elegirBase,
};
