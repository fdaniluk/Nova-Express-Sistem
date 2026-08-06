const { Router } = require('express');
const { getDb } = require('../db');
const { buildPesos, calcularDesgloseAlCosto } = require('../models/envio.model');
const { pesoVolumetricoBulto } = require('../services/calculos.service');
const { deriveProfit } = require('../utils/profit');
const { descomponerVenta } = require('../utils/desgloseVenta');
const configuracionModel = require('../models/configuracion.model');
const cierreService = require('../services/cierre.service');
const { hoyLocal } = require('../utils/fecha');
const { requireCierre } = require('../middleware/auth');

const router = Router();

// Parsea el desglose de extras persistido (envios.extras_json). Envíos viejos o
// importados tienen NULL → array vacío. JSON corrupto tampoco rompe la fila.
function parseExtras(json) {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Estados válidos del semáforo de caja por bulto. NULL/'' limpia el estado (se
// interpreta como rojo en la lectura). Normaliza un valor recibido por la API:
//   - undefined  → { ok: true, value: undefined }  (el campo no vino; no tocar)
//   - null / ''  → { ok: true, value: null }        (limpiar el estado)
//   - rojo/amarillo/verde (case-insensitive, trim) → { ok: true, value }
//   - cualquier otro → { ok: false }                (rechazar con 400)
const ESTADOS_CAJA = ['rojo', 'amarillo', 'verde'];

function normalizarEstadoCaja(raw) {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '') return { ok: true, value: null };
  const v = String(raw).trim().toLowerCase();
  if (ESTADOS_CAJA.includes(v)) return { ok: true, value: v };
  return { ok: false, value: undefined };
}

// El listado de Salidas, sin Express de por medio. Lo usan DOS cosas: el GET que dibuja
// la pantalla y el cierre de período, que arma el Excel. Vivía entero adentro del
// handler; se sacó afuera para que la planilla que se archiva no pueda desviarse nunca de
// lo que la oficina ve en pantalla — si algún día cambia una columna, cambia en los dos
// lados o en ninguno.
async function listarSalidas({ desde, hasta } = {}) {
  const db = getDb();
  let sql = `
    SELECT
      e.id,
      e.numero_salida,
      e.courier,
      e.fecha,
      e.numero_guia,
      e.pais_destino        AS destino,
      e.destino_raw,
      e.direccion,
      e.bulto,
      e.tipo_paquete,
      e.tipo_envio,
      e.cantidad_bultos,
      e.peso_real           AS peso,
      e.largo,
      e.ancho,
      e.alto,
      e.peso_volumetrico,
      e.peso_facturable,
      e.asegurado,
      e.remota,
      e.entrega,
      e.ddp,
      e.proteccion_doc,
      e.zona,
      e.servicio_ups,
      e.fob                 AS valor_declarado,
      e.flete,
      e.descuento,
      e.seguro,
      e.fuel,
      e.fuel_pct,
      e.derechos,
      e.adicionales,
      e.otros,
      e.extras_json,
      e.total_cobrado       AS total,
      e.profit,
      e.porcentaje,
      e.observaciones,
      e.estado_revision,
      e.costo_facturado,
      e.peso_facturado,
      e.courier_facturado,
      e.fecha_facturado,
      e.num_sal_cero,
      e.liquidado,
      e.fecha_liquidacion,
      e.liquidacion_id,
      e.created_at,
      c.id                  AS cliente_id,
      COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre,
      c.tipo_cobro,
      li.venta_liq          AS venta_liq
    FROM envios e
    JOIN clientes c ON c.id = e.cliente_id
    -- Venta congelada de la liquidación confirmada (total_usd = total_cobrado + adicional
    -- manual). La consume deriveProfit para la rama de costo real: cuando el envío está
    -- liquidado, el costo real se resta contra ESTA venta (la completa), no contra
    -- total_cobrado. Pre-agregado por envío para no duplicar filas. SOLO lectura.
    LEFT JOIN (
      SELECT envio_id, SUM(total_usd) AS venta_liq
      FROM liquidacion_items
      WHERE liquidacion_id IN (SELECT id FROM liquidaciones WHERE estado = 'confirmada')
      GROUP BY envio_id
    ) li ON li.envio_id = e.id
    WHERE 1=1`;

  const params = [];

  if (desde) {
    sql += ' AND e.fecha >= ?';
    params.push(desde);
  }
  if (hasta) {
    sql += ' AND e.fecha <= ?';
    params.push(hasta);
  }

  sql += ' ORDER BY e.fecha DESC, e.id DESC';

  const rows = await db.prepare(sql).all(...params);

  // Número correlativo de salida (num_sal): se calcula al vuelo sobre TODOS los
  // envíos en orden cronológico de carga (id ASC), NO sobre el subconjunto filtrado.
  // Es global y estable: el id más bajo es 1, el siguiente 2, etc. Filtrar por fecha
  // no renumera nada. No se persiste: al borrar un envío los números se recalculan
  // solos sin huecos en el próximo request.
  const numSalPorEnvio = new Map();
  const todosLosIds = await db.prepare('SELECT id FROM envios ORDER BY id ASC').all();
  todosLosIds.forEach((r, i) => numSalPorEnvio.set(r.id, i + 1));

  // Bultos por envío: una sola query (sin N+1) y se indexan en memoria por envio_id.
  const bultosPorEnvio = new Map();
  const envioIds = rows.map((r) => r.id);
  if (envioIds.length > 0) {
    const placeholders = envioIds.map(() => '?').join(', ');
    const bultoRows = await db
      .prepare(`
        SELECT id, envio_id, numero_bulto, peso_real, largo, ancho, alto, peso_volumetrico, numero_guia, estado_caja
        FROM envio_bultos
        WHERE envio_id IN (${placeholders})
        ORDER BY envio_id, numero_bulto`)
      .all(...envioIds);
    for (const b of bultoRows) {
      if (!bultosPorEnvio.has(b.envio_id)) bultosPorEnvio.set(b.envio_id, []);
      bultosPorEnvio.get(b.envio_id).push({
        id: b.id,
        numero_bulto: b.numero_bulto,
        peso_real: b.peso_real,
        largo: b.largo,
        ancho: b.ancho,
        alto: b.alto,
        peso_volumetrico: b.peso_volumetrico,
        numero_guia: b.numero_guia,
        estado_caja: b.estado_caja ?? null,
      });
    }
  }

  // Recargos facturados por envío: el desglose (cargos_json) de lo que el courier facturó
  // por esa guía. Puede haber VARIAS filas por envío si la factura se recargó; nos quedamos
  // con la MÁS RECIENTE (mayor id). Una sola query (sin N+1), indexada por envio_id igual
  // que bultosPorEnvio. Sin factura cargada → el envío no está en el mapa → array vacío.
  const recargosPorEnvio = new Map();
  if (envioIds.length > 0) {
    const placeholders = envioIds.map(() => '?').join(', ');
    // ORDER BY id ASC: al iterar, la fila de mayor id (más reciente) sobrescribe y gana.
    const guiaRows = await db
      .prepare(`
        SELECT envio_id, cargos_json
        FROM factura_guias
        WHERE envio_id IN (${placeholders})
        ORDER BY id ASC`)
      .all(...envioIds);
    for (const g of guiaRows) {
      recargosPorEnvio.set(g.envio_id, parseExtras(g.cargos_json));
    }
  }

  // Devuelve el array de bultos del envío. Multi-bulto: filas reales (id no nulo).
  // Bulto único (sin filas en envio_bultos): un bulto sintético (id null) armado
  // desde los campos primarios del propio envío.
  const bultosDe = (row) => {
    const reales = bultosPorEnvio.get(row.id);
    if (reales && reales.length > 0) return reales;
    return [{
      id: null,
      numero_bulto: 1,
      peso_real: row.peso,
      largo: row.largo,
      ancho: row.ancho,
      alto: row.alto,
      peso_volumetrico: row.peso_volumetrico,
      numero_guia: null,
      // Bulto único sin fila propia: nunca tiene estado materializado. NULL = rojo en
      // la lectura. Para fijarle estado el front llama al endpoint que materializa la fila.
      estado_caja: null,
    }];
  };

  // Fuel% para el desglose de venta: mismo criterio que liquidacion.model → calcularItem.
  // Si el envío tiene fuel_pct propio (congelado) se usa ESE; si es NULL se cae a la config
  // vigente del courier (fuelCfg?.fuel_pct ?? 0). Se lee la config UNA vez (sin N+1) y se
  // indexa por courier; la lectura por courier equivale a obtenerFuel(courier).
  const fuelCfgRows = await configuracionModel.listarFuel();
  const fuelCfgPorCourier = new Map(fuelCfgRows.map((r) => [r.courier, r.fuel_pct]));
  const resolverFuelPct = (row) => {
    if (row.fuel_pct !== null && row.fuel_pct !== undefined) return row.fuel_pct;
    return fuelCfgPorCourier.has(row.courier) ? (fuelCfgPorCourier.get(row.courier) ?? 0) : 0;
  };

  // Desglose de venta (SOLO lectura): descompone total_cobrado en flete/fuel/seguro/adicional
  // con el helper compartido de la Etapa 1, usando el fuel_pct resuelto arriba. Va a nivel
  // envío (no por bulto). total_cobrado falsy (0/null) → sin venta cargada → null.
  const ventaDesgloseDe = (row) => {
    if (!row.total) return null;
    return descomponerVenta({
      total_cobrado: row.total,
      seguro: row.seguro,
      adicionales: row.adicionales,
      derechos: row.derechos,
      otros: row.otros,
      fuel_pct: resolverFuelPct(row),
    });
  };

  // Profit/porcentaje/compra_total derivados AL VUELO por deriveProfit (utils/profit.js),
  // la MISMA función que agrega el Dashboard, para que coincidan al centavo.
  const result = rows.map((row) => ({
    id: row.id,
    num_sal: numSalPorEnvio.get(row.id),
    numero_salida: row.numero_salida,
    courier: row.courier,
    fecha: row.fecha,
    numero_guia: row.numero_guia,
    tipo_cobro: row.tipo_cobro,
    cliente_id: row.cliente_id,
    cliente_nombre: row.cliente_nombre,
    destino: row.destino,
    destino_raw: row.destino_raw,
    direccion: row.direccion || (row.tipo_envio === 'importacion' ? 'impo' : 'expo'),
    bulto: row.bulto,
    tipo_paquete: row.tipo_paquete,
    cantidad_bultos: row.cantidad_bultos,
    peso: row.peso,
    largo: row.largo,
    ancho: row.ancho,
    alto: row.alto,
    peso_volumetrico: row.peso_volumetrico,
    peso_facturable: row.peso_facturable,
    asegurado: Boolean(row.asegurado),
    remota: Boolean(row.remota),
    // Envío viejo (sin `entrega`): su flag `remota` equivalía a la tarifa de extendida.
    entrega: row.entrega || (row.remota ? 'extendida' : 'normal'),
    ddp: Boolean(row.ddp),
    proteccion_doc: Boolean(row.proteccion_doc),
    zona: row.zona,
    servicio_ups: row.servicio_ups,
    valor_declarado: row.valor_declarado,
    flete: row.flete,
    descuento: row.descuento,
    seguro: row.seguro,
    fuel: row.fuel,
    derechos: row.derechos,
    adicionales: row.adicionales,
    otros: row.otros,
    extras: parseExtras(row.extras_json),
    total: row.total,
    venta_desglose: ventaDesgloseDe(row),
    ...deriveProfit(row),
    observaciones: row.observaciones,
    estado_revision: row.estado_revision ?? null,
    // Datos de lo que el courier facturó por este envío (módulo Control de Facturas).
    // Los escalares viven en la propia fila de envios; recargos_facturados es el desglose
    // de la factura MÁS RECIENTE cruzada a este envío (array vacío si no hay factura).
    costo_facturado: row.costo_facturado ?? null,
    peso_facturado: row.peso_facturado ?? null,
    courier_facturado: row.courier_facturado ?? null,
    fecha_facturado: row.fecha_facturado ?? null,
    recargos_facturados: recargosPorEnvio.get(row.id) ?? [],
    num_sal_cero: Boolean(row.num_sal_cero),
    liquidado: Boolean(row.liquidado),
    fecha_liquidacion: row.fecha_liquidacion,
    bultos: bultosDe(row),
  }));

  return result;
}

router.get('/', async (req, res, next) => {
  try {
    res.json(await listarSalidas(req.query));
  } catch (err) {
    next(err);
  }
});

// ── Cierre de período ───────────────────────────────────────────────────────
// Baja el Excel de las salidas de un mes o una semana para archivarlo fuera del sistema.
// Es la última capa de respaldo: una planilla que abre cualquiera, en cualquier máquina,
// sin depender del sistema, del VPS ni de ninguna cuenta nuestra.
//
// Queda asentado en la tabla `cierres` que se hizo, quién y cuántas filas tenía. El
// archivo NO se guarda del lado del servidor a propósito: guardarlo acá sería otra copia
// en el mismo lugar, que es justo lo que este mecanismo viene a evitar.
//
// Va ANTES de cualquier ruta con :id, para que 'exportar' no se lea como un id.
router.get('/exportar', requireCierre, async (req, res, next) => {
  try {
    const { tipo, mes, semana, desde, hasta } = req.query || {};
    let rango = null;
    if (tipo === 'mes' || mes) rango = cierreService.rangoDelMes(mes || hoyLocal().slice(0, 7));
    else if (tipo === 'semana') rango = cierreService.rangoDeLaSemana(semana);
    else if (desde && hasta) rango = cierreService.rangoLibre(desde, hasta);

    if (!rango) {
      return res.status(400).json({
        error: 'Período inválido. Se espera tipo=mes&mes=AAAA-MM, tipo=semana, o desde y hasta.',
      });
    }

    const filas = await listarSalidas({ desde: rango.desde, hasta: rango.hasta });
    const usuario = req.usuario ? req.usuario.usuario : null;
    const buffer = await cierreService.construirExcel(filas, rango, usuario);

    // El asiento no puede voltear la descarga: si falla el INSERT, el archivo igual sale.
    // Perder el registro es molesto; perder el cierre del mes por eso sería absurdo.
    try {
      await getDb()
        .prepare('INSERT INTO cierres (tipo, desde, hasta, filas, usuario_id, usuario) VALUES (?,?,?,?,?,?)')
        .run(rango.tipo, rango.desde, rango.hasta, filas.length,
          req.usuario ? req.usuario.id : null, usuario);
    } catch (e) {
      console.error('[cierres] no se pudo asentar el cierre:', e.message);
    }

    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${cierreService.nombreArchivo(rango)}"`);
    res.setHeader('X-Nova-Filas', String(filas.length));
    res.send(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
});

// Los últimos cierres hechos. Lo usa la pantalla para mostrar de cuándo es el último, y
// es la misma fuente que mira el panel de salud.
router.get('/cierres', requireCierre, async (req, res, next) => {
  try {
    const filas = await getDb()
      .prepare(`SELECT id, tipo, desde, hasta, filas, usuario, creado_en
                FROM cierres ORDER BY id DESC LIMIT 24`)
      .all();
    res.json(filas);
  } catch (err) {
    next(err);
  }
});

// Recálculo SOLO-CÁLCULO del desglose al editar desde el modal de Salidas. NO persiste
// nada: el frontend muestra el resultado y, si el usuario guarda, lo manda al PATCH (que
// persiste lo recibido, ver más abajo). Reusa el MISMO motor y armado de inputs que el alta
// (buildPesos + calcularDesgloseAlCosto de envio.model.js).
// El modal edita peso/medidas, país y courier: esos tres viajan en el body y GANAN sobre lo
// guardado (país y courier son opcionales por compatibilidad; si no vienen, se usa el del
// envío). Si el país efectivo cambió respecto al guardado se ignora la zona guardada (era un
// override del país viejo) y se re-resuelve desde el país nuevo. El resto (tipo, servicio_ups,
// fob) sale del envío; el fuel% queda congelado del envío (no del config actual).
// Body: { peso_real, largo, alto, ancho, bultos?: [...], pais_destino?, courier? }
//   - bulto único: campos sueltos (peso_real/largo/ancho/alto), sin array bultos.
//   - multi-bulto: array bultos; el peso facturable sale de los bultos.
// Responde: { flete, seguro, fuel, adicionales, total, peso_facturable, peso_volumetrico, zona }
router.post('/:id/recalcular', async (req, res, next) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

    const envio = await db.prepare('SELECT * FROM envios WHERE id = ?').get(id);
    if (!envio) return res.status(404).json({ error: 'Envío no encontrado' });

    const body = req.body || {};

    // pais_destino y courier ahora son editables en el modal, así que el recálculo debe
    // usar lo que el usuario tiene en pantalla (body), no lo guardado. Ambos son OPCIONALES:
    // si no vienen, se cae al valor del envío (compatibilidad con quien hoy no los manda).
    const courierEfectivo = body.courier ?? envio.courier;
    const paisEfectivo = body.pais_destino ?? envio.pais_destino;

    // Validación espejo del PATCH: valores inválidos revientan feo en el motor.
    if (body.courier != null && body.courier !== 'DHL' && body.courier !== 'UPS') {
      return res.status(400).json({ error: "El courier debe ser exactamente 'DHL' o 'UPS'." });
    }
    if (body.pais_destino != null && String(body.pais_destino).trim() === '') {
      return res.status(400).json({ error: 'El país de destino no puede estar vacío.' });
    }

    // servicio_ups NO se edita en el modal: si el courier efectivo es UPS hace falta el
    // guardado para resolver tarifa. Sin él, cortamos con un mensaje claro en castellano en
    // vez de dejar que el motor explote con un error críptico.
    if (courierEfectivo === 'UPS' && !envio.servicio_ups) {
      return res.status(400).json({
        error: 'El envío no tiene servicio UPS guardado: no se puede recalcular con courier UPS. '
          + 'Cargá el servicio UPS desde el alta/edición y volvé a intentar.',
      });
    }

    // Bultos: los del modal si vinieron; si no, los GUARDADOS del envío. Antes, cuando el
    // body no traía bultos se usaba una lista vacía y el peso salía de los campos sueltos
    // —que tampoco venían—, así que un recálculo que solo cambiaba el DDP o el país perdía
    // el peso y devolvía cualquier cosa. Mismo criterio que remota/ddp/entrega: del modal si
    // vino, del envío si no.
    const bultos = (Array.isArray(body.bultos) && body.bultos.length > 0)
      ? body.bultos.map((b) => ({
          peso_real: b.peso_real,
          largo: b.largo,
          ancho: b.ancho,
          alto: b.alto,
        }))
      : (await db
          .prepare('SELECT peso_real, largo, ancho, alto FROM envio_bultos WHERE envio_id = ? ORDER BY numero_bulto')
          .all(id));

    // ZONA: la zona guardada es un override atado al país viejo. Si el país efectivo cambió
    // respecto al guardado, usarla daría una tarifa equivocada: pasamos null para que el
    // motor la resuelva desde el país nuevo (si no resuelve, cae al 422 de abajo). Si el
    // país no cambió, se respeta la zona guardada (pudo ser un override manual válido).
    const paisCambio = String(paisEfectivo ?? '').trim() !== String(envio.pais_destino ?? '').trim();

    // Inputs editados (peso/medidas/bultos, país, courier) + inputs no editables del envío.
    const data = {
      courier: courierEfectivo,
      servicio_ups: envio.servicio_ups,
      tipo_envio: envio.tipo_envio,
      pais_destino: paisEfectivo,
      fob: envio.fob,
      zona: paisCambio ? null : envio.zona,
      // Área remota: recargo que ya vive en el desglose guardado. Si NO se re-aplica acá,
      // el primer recálculo lo borra en silencio (mismo bug que país/courier). Viene del
      // modal (body.remota); si no vino, se lee del envío para no perderlo nunca.
      remota: body.remota != null ? body.remota : envio.remota,
      // Zona de entrega: igual criterio que remota y ddp — del modal si vino, del envío
      // si no. Sin `entrega`, un envío viejo cae en 'extendida' y no cambia de precio.
      entrega: body.entrega != null ? body.entrega : envio.entrega,
      // DDP: exactamente el mismo caso que `remota`, y se había quedado afuera. Sin esta
      // línea `data.ddp` llega undefined -> false, y el primer "Recalcular" borra el cargo
      // DDP en silencio: la utilidad del envío queda inflada por ese monto.
      ddp: body.ddp != null ? body.ddp : envio.ddp,
      // Protección de documentos de DHL: mismo criterio que el DDP. Sin esta línea el
      // primer "Recalcular" borraría los 7,50 en silencio.
      proteccion_doc: body.proteccion_doc != null ? body.proteccion_doc : envio.proteccion_doc,
      // Mercadería o documento: en DHL selecciona la tabla de documento (hasta 2 kg). Se
      // toma del modal si vino y si no del envío, igual que remota y ddp. Sin esto, un
      // recálculo sobre un documento lo re-costeaba como mercadería.
      tipo_paquete: body.tipo_paquete != null ? body.tipo_paquete : envio.tipo_paquete,
      // Fuel% congelado del envío: el recálculo respeta el guardado (no el de config actual).
      fuel_pct: envio.fuel_pct,
      // Peso y medidas: del modal si el campo vino en el body, del envío si no. `undefined`
      // es "no lo mandaron" y `null` es "lo borraron a propósito", y son cosas distintas:
      // borrar el peso tiene que dejar el envío sin pesar, pero no mandarlo no puede
      // borrarlo por accidente.
      peso_real: body.peso_real !== undefined ? body.peso_real : envio.peso_real,
      largo: body.largo !== undefined ? body.largo : envio.largo,
      ancho: body.ancho !== undefined ? body.ancho : envio.ancho,
      alto: body.alto !== undefined ? body.alto : envio.alto,
      bultos,
    };

    const { pesoVolumetrico, pesoFacturable } = buildPesos(data);

    // Envío SIN PESAR: no es un error de país, es que todavía no se sabe cuánto pesa. Se
    // devuelve el desglose vacío en vez de un 422, para que el modal muestre los campos en
    // blanco y no un cartel rojo que no ayuda. Es el estado normal de los envíos de los
    // clientes cuyos paquetes no pasan por el depósito, entre que salen y llegan los pesos.
    if (!(Number(pesoFacturable) > 0)) {
      return res.json({
        flete: null, seguro: null, fuel: null, fuel_pct: envio.fuel_pct,
        adicionales: null, extras: [], total: null,
        peso_facturable: pesoFacturable, peso_volumetrico: pesoVolumetrico,
        zona: envio.zona, sin_pesar: true,
      });
    }

    const desglose = await calcularDesgloseAlCosto(data, pesoFacturable);
    if (!desglose) {
      return res.status(422).json({
        error: `No se pudo calcular el desglose: el país "${String(paisEfectivo ?? '').trim()}" `
          + 'no resuelve una zona reconocida por el motor.',
      });
    }

    res.json({
      flete: desglose.flete,
      seguro: desglose.seguro,
      fuel: desglose.fuel,
      fuel_pct: desglose.fuel_pct,
      adicionales: desglose.adicionales,
      extras: desglose.extras || [],
      total: desglose.total,
      peso_facturable: pesoFacturable,
      peso_volumetrico: pesoVolumetrico,
      zona: desglose.zona,
    });
  } catch (err) {
    next(err);
  }
});

// Campos editables desde la vista Salidas.
// Bloqueados (solo): liquidado, liquidacion_id.
// fecha/cliente_id/courier/pais_destino/num_sal_cero se validan más abajo antes de
// persistir; además, en envíos liquidados fecha y cliente_id quedan congelados (409).
const SALIDAS_EDITABLE = [
  'fecha', 'cliente_id', 'courier', 'pais_destino', 'num_sal_cero',
  'numero_guia', 'numero_salida', 'bulto', 'tipo_paquete', 'asegurado', 'remota', 'entrega', 'ddp', 'proteccion_doc', 'direccion',
  'peso_real', 'largo', 'ancho', 'alto', 'peso_facturable', 'peso_volumetrico',
  'flete', 'descuento', 'seguro', 'fuel', 'fuel_pct', 'derechos', 'adicionales', 'otros',
  'total_cobrado', 'profit', 'porcentaje', 'observaciones', 'extras_json',
];

// Fecha en formato ISO estricto YYYY-MM-DD y que sea un día de calendario real.
function esFechaValida(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

router.patch('/:id', async (req, res, next) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

    const existing = await db.prepare('SELECT * FROM envios WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Envío no encontrado' });

    const picked = {};
    for (const field of SALIDAS_EDITABLE) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        picked[field] = req.body[field];
      }
    }

    // extras_json: el front lo manda como ARRAY (el desglose por tipo ya reconciliado)
    // y SOLO después de un Recalcular. Se persiste serializado. Si el campo no vino en
    // el body nunca entra a `picked` (whitelist) → el UPDATE no lo incluye y la columna
    // conserva su valor previo (no se pisa con NULL). Si vino pero no es un array, se
    // descarta el campo: dato inválido no debe romper ni sobrescribir el desglose guardado.
    if (Object.prototype.hasOwnProperty.call(picked, 'extras_json')) {
      if (Array.isArray(picked.extras_json)) {
        picked.extras_json = JSON.stringify(picked.extras_json);
      } else {
        delete picked.extras_json;
      }
    }

    // Bultos editados (multi-bulto): se persisten aparte del UPDATE plano de envios.
    // Cada bulto se identifica por su id (fila de envio_bultos). El bulto sintético del
    // bulto único no tiene fila (id null) y se ignora: su peso/medidas viajan en `picked`.
    const bultosEdit = (Array.isArray(req.body.bultos) ? req.body.bultos : [])
      .filter((b) => b && b.id != null);

    if (Object.keys(picked).length === 0 && bultosEdit.length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    if (picked.numero_guia !== undefined) {
      picked.numero_guia = String(picked.numero_guia ?? '').trim().toUpperCase() || picked.numero_guia;
    }

    // numero_guia es UNIQUE: validar que no exista en otro envío
    if (picked.numero_guia !== undefined && picked.numero_guia !== existing.numero_guia) {
      if (!picked.numero_guia) {
        return res.status(400).json({ error: 'El número de guía no puede estar vacío' });
      }
      const dupe = await db
        .prepare('SELECT id FROM envios WHERE numero_guia = ? AND id != ?')
        .get(picked.numero_guia, id);
      if (dupe) {
        return res.status(409).json({ error: `Ya existe un envío con la guía "${picked.numero_guia}"` });
      }
    }

    // FRENO DE SEGURIDAD para envíos ya liquidados: cambiar el cliente descuadra una
    // liquidación confirmada y cambiar la fecha puede sacar el envío del período
    // liquidado. Ambos quedan congelados (409); el resto de los campos sí se pueden
    // editar aunque el envío esté liquidado. Solo se rechaza si el valor CAMBIA.
    if (existing.liquidado) {
      const cambiaCliente = Object.prototype.hasOwnProperty.call(picked, 'cliente_id')
        && Number(picked.cliente_id) !== Number(existing.cliente_id);
      const cambiaFecha = Object.prototype.hasOwnProperty.call(picked, 'fecha')
        && picked.fecha !== existing.fecha;
      if (cambiaCliente) {
        return res.status(409).json({
          error: 'El envío está liquidado: no se puede cambiar el cliente (descuadraría una liquidación confirmada).',
        });
      }
      if (cambiaFecha) {
        return res.status(409).json({
          error: 'El envío está liquidado: no se puede cambiar la fecha (podría sacarlo del período liquidado).',
        });
      }
    }

    // Validación de los campos recién destrabados. Sin esto, un valor inválido rompe
    // con un error crudo de SQLite (CHECK de courier, FK de cliente_id) o corrompe la fila.
    if (Object.prototype.hasOwnProperty.call(picked, 'fecha') && !esFechaValida(picked.fecha)) {
      return res.status(400).json({ error: 'La fecha debe tener formato YYYY-MM-DD válido.' });
    }
    if (Object.prototype.hasOwnProperty.call(picked, 'courier')
        && picked.courier !== 'DHL' && picked.courier !== 'UPS') {
      return res.status(400).json({ error: "El courier debe ser exactamente 'DHL' o 'UPS'." });
    }
    // Regla de negocio: los documentos van unicamente por DHL. Se evalua el resultado
    // final (lo que viene en el body + lo que ya estaba), porque la edicion es parcial.
    {
      const tipoFinal = Object.prototype.hasOwnProperty.call(picked, 'tipo_paquete')
        ? picked.tipo_paquete : existing.tipo_paquete;
      const courierFinal = Object.prototype.hasOwnProperty.call(picked, 'courier')
        ? picked.courier : existing.courier;
      const esDoc = String(tipoFinal ?? '').trim().toLowerCase() === 'd';
      const cur = String(courierFinal ?? '').trim().toUpperCase();
      if (esDoc && cur && cur !== 'DHL') {
        return res.status(400).json({
          error: `Los documentos se envian unicamente por DHL (se recibio ${cur}).`,
        });
      }
    }
    if (Object.prototype.hasOwnProperty.call(picked, 'cliente_id')) {
      const cli = await db.prepare('SELECT id FROM clientes WHERE id = ?').get(picked.cliente_id);
      if (!cli) {
        return res.status(400).json({ error: `No existe un cliente con id ${picked.cliente_id}.` });
      }
    }
    if (Object.prototype.hasOwnProperty.call(picked, 'pais_destino')
        && String(picked.pais_destino ?? '').trim() === '') {
      return res.status(400).json({ error: 'El país de destino no puede estar vacío.' });
    }
    if (Object.prototype.hasOwnProperty.call(picked, 'num_sal_cero')
        && picked.num_sal_cero !== 0 && picked.num_sal_cero !== 1) {
      return res.status(400).json({ error: 'num_sal_cero debe ser 0 o 1.' });
    }

    // ZONA: si cambia el país, re-resolver la zona con la MISMA lógica del alta
    // (calcularDesgloseAlCosto → motor). La zona la resuelve el motor desde el país; el
    // POST /:id/recalcular posterior toma pais/zona ya guardados, así que dejarla al día
    // acá basta. Se pasa SIN zona override para que el resultado refleje solo lo que
    // resuelve el país nuevo: si no resuelve (país desconocido y sin zona manual),
    // calcularDesgloseAlCosto devuelve null → NO se pisa la zona vieja y se avisa al front.
    let avisoZona;
    if (Object.prototype.hasOwnProperty.call(picked, 'pais_destino')
        && String(picked.pais_destino).trim() !== String(existing.pais_destino ?? '').trim()) {
      const desgloseZona = await calcularDesgloseAlCosto({
        courier: picked.courier ?? existing.courier,
        servicio_ups: existing.servicio_ups,
        tipo_envio: existing.tipo_envio,
        pais_destino: picked.pais_destino,
        fob: existing.fob,
        fuel_pct: existing.fuel_pct,
        tipo_paquete: existing.tipo_paquete,
        zona: undefined,
        peso_real: existing.peso_real,
        largo: existing.largo,
        ancho: existing.ancho,
        alto: existing.alto,
      }, existing.peso_facturable);
      if (desgloseZona) {
        picked.zona = desgloseZona.zona;
      } else {
        avisoZona = `El país "${String(picked.pais_destino).trim()}" no resuelve una zona automática; `
          + 'se conservó la zona anterior. Verificá la zona manualmente.';
      }
    }

    // El save persiste lo recibido: NO recalcula el motor ni pisa los costos del payload
    // (el usuario pudo ajustarlos a mano tras Recalcular). El único derivado es el
    // peso_volumetrico por bulto, geometría pura (mismo cálculo que saveBultos del alta).
    await db.transaction(async () => {
      if (Object.keys(picked).length > 0) {
        const setClauses = Object.keys(picked).map((f) => `${f} = ?`).join(', ');
        const values = [...Object.values(picked), id];
        await db
          .prepare(`UPDATE envios SET ${setClauses}, updated_at = datetime('now', 'localtime') WHERE id = ?`)
          .run(...values);
      }

      for (const b of bultosEdit) {
        const pv = Math.round(pesoVolumetricoBulto(b.largo, b.ancho, b.alto) * 1000) / 1000;
        await db
          .prepare(
            `UPDATE envio_bultos
               SET peso_real = ?, largo = ?, ancho = ?, alto = ?, peso_volumetrico = ?
             WHERE id = ? AND envio_id = ?`
          )
          .run(b.peso_real ?? null, b.largo ?? null, b.ancho ?? null, b.alto ?? null, pv, b.id, id);
      }
    });

    const respuesta = { ok: true };
    if (avisoZona) respuesta.aviso_zona = avisoZona;
    res.json(respuesta);
  } catch (err) {
    next(err);
  }
});

// Edita un bulto REAL individual (una fila de envio_bultos). Update PARCIAL: actualiza
// solo los campos que vienen en el body, sin pisar los demás.
//   - numero_guia: guías reasignadas (p. ej. UPS) cargadas tal cual. No se valida
//     unicidad: el cruce de facturas todavía usa la guía del envío. Vacío → NULL,
//     para que el frontend vuelva a usar la guía del envío como fallback.
//   - estado_caja: semáforo de caja ('rojo'|'amarillo'|'verde'|NULL para limpiar).
// Para un envío de bulto único (sintético, sin fila) el front NO tiene id de bulto:
// usa PATCH /salidas/envios/:envioId/estado-bulto-unico, que materializa la fila.
router.patch('/bultos/:id', async (req, res, next) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

    const tieneGuia = Object.prototype.hasOwnProperty.call(req.body, 'numero_guia');
    const tieneEstado = Object.prototype.hasOwnProperty.call(req.body, 'estado_caja');
    if (!tieneGuia && !tieneEstado) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    const sets = [];
    const values = [];

    if (tieneGuia) {
      const numeroGuia = String(req.body.numero_guia ?? '').trim().toUpperCase() || null;
      sets.push('numero_guia = ?');
      values.push(numeroGuia);
    }

    if (tieneEstado) {
      const estado = normalizarEstadoCaja(req.body.estado_caja);
      if (!estado.ok) {
        return res.status(400).json({ error: "estado_caja inválido (use 'rojo', 'amarillo', 'verde' o vacío)" });
      }
      sets.push('estado_caja = ?');
      values.push(estado.value);
    }

    values.push(id);
    const result = await db
      .prepare(`UPDATE envio_bultos SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Bulto no encontrado' });
    }

    const bulto = await db
      .prepare('SELECT id, envio_id, numero_bulto, numero_guia, estado_caja FROM envio_bultos WHERE id = ?')
      .get(id);

    res.json(bulto);
  } catch (err) {
    next(err);
  }
});

// Fija el estado_caja de un envío de UN bulto que todavía NO tiene fila en envio_bultos
// (bulto sintético: el GET lo arma al vuelo con id null, por eso el front no tiene id).
// Materializa la fila del bulto 1 copiando peso/medidas/peso_volumetrico/numero_guia del
// envío y le setea el estado. Tras esto el bulto pasa a ser real y futuras ediciones van
// por PATCH /bultos/:id. Si el envío YA tiene bultos reales, 409: este endpoint es solo
// para el caso de bulto único sintético.
router.patch('/envios/:envioId/estado-bulto-unico', async (req, res, next) => {
  try {
    const db = getDb();
    const envioId = parseInt(req.params.envioId, 10);
    if (!Number.isFinite(envioId)) return res.status(400).json({ error: 'ID inválido' });

    if (!Object.prototype.hasOwnProperty.call(req.body, 'estado_caja')) {
      return res.status(400).json({ error: 'Falta estado_caja' });
    }
    const estado = normalizarEstadoCaja(req.body.estado_caja);
    if (!estado.ok) {
      return res.status(400).json({ error: "estado_caja inválido (use 'rojo', 'amarillo', 'verde' o vacío)" });
    }

    const envio = await db
      .prepare('SELECT id, numero_guia, peso_real, largo, ancho, alto, peso_volumetrico FROM envios WHERE id = ?')
      .get(envioId);
    if (!envio) return res.status(404).json({ error: 'Envío no encontrado' });

    const existentes = await db
      .prepare('SELECT COUNT(*) AS n FROM envio_bultos WHERE envio_id = ?')
      .get(envioId);
    if (existentes.n > 0) {
      return res.status(409).json({
        error: 'El envío ya tiene bultos reales; use PATCH /salidas/bultos/:id con el id del bulto',
      });
    }

    // Materializar el bulto 1 desde los campos del envío (espejo del bulto sintético del
    // GET). largo/ancho/alto son NOT NULL en envio_bultos: si el envío no los tiene, se
    // guardan como 0 (envío sin medidas; se pueden corregir editando el bulto).
    const result = await db
      .prepare(
        `INSERT INTO envio_bultos
           (envio_id, numero_bulto, peso_real, largo, ancho, alto, peso_volumetrico, numero_guia, estado_caja)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        envioId,
        envio.peso_real ?? null,
        envio.largo ?? 0,
        envio.ancho ?? 0,
        envio.alto ?? 0,
        envio.peso_volumetrico ?? 0,
        envio.numero_guia ?? null,
        estado.value,
      );

    const bulto = await db
      .prepare('SELECT id, envio_id, numero_bulto, numero_guia, estado_caja FROM envio_bultos WHERE id = ?')
      .get(result.lastInsertRowid);

    res.status(201).json(bulto);
  } catch (err) {
    next(err);
  }
});

// Borra un envío entero, incluso si está liquidado.
// envio_bultos y cargos_adicionales se van solos por ON DELETE CASCADE.
// liquidacion_items es RESTRICT: hay que sacar sus filas a mano antes de borrar el
// envío, y mantener consistente el liquidaciones.total (snapshot, no se recalcula solo).
// Si el envío era el único de su liquidación, la liquidación queda vacía y se borra.
router.delete('/:id', async (req, res, next) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

    const existing = await db.prepare('SELECT id FROM envios WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Envío no encontrado' });

    await db.transaction(async () => {
      // Normalmente a lo sumo un item por envío, pero manejamos varios por robustez.
      const items = await db
        .prepare('SELECT id, liquidacion_id, total_usd FROM liquidacion_items WHERE envio_id = ?')
        .all(id);

      // Liquidaciones tocadas por este envío: candidatas a quedar vacías.
      const liquidacionesAfectadas = new Set();

      for (const item of items) {
        // El total de la liquidación es un snapshot: le restamos el aporte de este item.
        await db
          .prepare('UPDATE liquidaciones SET total = ROUND(total - ?, 2) WHERE id = ?')
          .run(item.total_usd, item.liquidacion_id);
        await db
          .prepare('DELETE FROM liquidacion_items WHERE id = ?')
          .run(item.id);
        liquidacionesAfectadas.add(item.liquidacion_id);
      }

      // Borramos el envío ANTES de tocar las liquidaciones: envios.liquidacion_id
      // todavía referencia la liquidación (FK RESTRICT), así que la liquidación no
      // puede borrarse mientras el envío exista. envio_bultos y cargos_adicionales
      // se van solos por ON DELETE CASCADE.
      await db.prepare('DELETE FROM envios WHERE id = ?').run(id);

      // Recién ahora, sin el envío refiriéndolas, borramos las liquidaciones vacías.
      for (const liquidacionId of liquidacionesAfectadas) {
        const restantes = await db
          .prepare('SELECT COUNT(*) AS n FROM liquidacion_items WHERE liquidacion_id = ?')
          .get(liquidacionId);
        if (restantes.n === 0) {
          await db.prepare('DELETE FROM liquidaciones WHERE id = ?').run(liquidacionId);
        }
      }
    });

    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
