// Cruce de guías facturadas "sin envío" con envíos cargados después (03/11/2026).
//
// Caso de la oficina: se carga la factura de DHL, una guía no está en el sistema (queda en
// Facturas → "Sin envío"), después se carga ese envío a mano en Salidas… y los datos de la
// factura (costo, peso, recargos, impuestos DDP) no le llegaban: había que recargar el PDF.
// Acá se cruza con lo que la factura YA dejó guardado en factura_guias, sin volver a leer
// nada. Dos entradas:
//   · paraEnvio(envioId): al crear un envío o cambiarle la guía (automático, best-effort).
//   · pendientes(): el botón "Cruzar con Salidas" de Facturas → Sin envío (barre todo).
// Misma regla que la carga: el envío entra 'pendiente' (la oficina decide con ✓/✕), y
// una factura de impuestos DDP va a su columna y registra el cargo posterior.
const { getDb } = require('../db');
const cargosModel = require('../models/envio-cargos.model');
const { hoyLocal } = require('../utils/fecha');

function normalizarGuia(g) { return String(g ?? '').trim().toUpperCase(); }

// Filas de factura_guias sin envío que coinciden con esta guía, con su cabecera. La más
// reciente primero: si la misma factura se recargó, manda la última carga.
async function filasSinEnvioDe(db, numeroGuia) {
  return db.prepare(`
    SELECT fg.id, fg.factura_id, fg.numero_guia, fg.peso_facturado, fg.costo_total,
           f.courier, f.fecha_factura, COALESCE(f.tipo, 'flete') AS tipo
      FROM factura_guias fg JOIN facturas_cargadas f ON f.id = fg.factura_id
     WHERE fg.encontrada = 0 AND fg.envio_id IS NULL AND UPPER(TRIM(fg.numero_guia)) = ?
     ORDER BY fg.id DESC`).all(normalizarGuia(numeroGuia));
}

async function recontarFactura(db, facturaId) {
  await db.prepare(`
    UPDATE facturas_cargadas
       SET guias_cruzadas = (SELECT COUNT(*) FROM factura_guias WHERE factura_id = ? AND encontrada = 1),
           guias_no_encontradas = (SELECT COUNT(*) FROM factura_guias WHERE factura_id = ? AND encontrada = 0)
     WHERE id = ?`).run(facturaId, facturaId, facturaId);
}

// Cruza las filas pendientes de UNA guía con su envío. Devuelve qué hizo.
async function cruzarEnvio(db, envio) {
  const filas = await filasSinEnvioDe(db, envio.numero_guia);
  if (!filas.length) return null;
  const hoy = hoyLocal();
  const hecho = { envio_id: envio.id, numero_guia: envio.numero_guia, flete: null, impuestos: null, filas: filas.length };
  let fleteAplicado = false;
  let impuestosAplicados = false;
  for (const fg of filas) {
    if (fg.tipo === 'impuestos') {
      if (!impuestosAplicados && fg.costo_total != null) {
        await db.prepare(`UPDATE envios SET impuestos_facturados = ?, impuestos_fecha = ?, impuestos_factura_id = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`)
          .run(fg.costo_total, fg.fecha_factura || hoy, fg.factura_id, envio.id);
        await cargosModel.registrarImpuestos(db, envio.id, fg.costo_total, fg.fecha_factura || hoy);
        impuestosAplicados = true;
        hecho.impuestos = fg.costo_total;
      }
    } else if (!fleteAplicado && fg.costo_total != null) {
      // Si el envío ya tiene factura cruzada (otra carga), no se pisa: solo se ata la fila.
      if (envio.costo_facturado == null) {
        await db.prepare(`
          UPDATE envios
             SET costo_facturado = ?, peso_facturado = ?, courier_facturado = ?, fecha_facturado = ?,
                 estado_revision = 'pendiente', updated_at = datetime('now', 'localtime')
           WHERE id = ?`).run(fg.costo_total, fg.peso_facturado ?? null, fg.courier, fg.fecha_factura || hoy, envio.id);
        hecho.flete = fg.costo_total;
      }
      fleteAplicado = true;
    }
    await db.prepare('UPDATE factura_guias SET envio_id = ?, encontrada = 1 WHERE id = ?').run(envio.id, fg.id);
    await recontarFactura(db, fg.factura_id);
  }
  return hecho;
}

// Entrada automática: después de crear un envío o cambiarle la guía. Nunca rompe la
// operación que lo llamó: si algo falla, se loguea y la guía sigue en "Sin envío" para
// cruzarla con el botón.
async function paraEnvio(envioId, db = getDb()) {
  try {
    const envio = await db.prepare('SELECT id, numero_guia, costo_facturado FROM envios WHERE id = ?').get(envioId);
    if (!envio || !envio.numero_guia) return null;
    return await cruzarEnvio(db, envio);
  } catch (e) {
    console.error(`[cruce-facturas] no se pudo cruzar el envío ${envioId}:`, e.message);
    return null;
  }
}

// Entrada manual: todas las guías sin envío que hoy SÍ tienen envío en el sistema.
async function pendientes(db = getDb()) {
  const candidatas = await db.prepare(`
    SELECT DISTINCT e.id, e.numero_guia, e.costo_facturado
      FROM factura_guias fg
      JOIN envios e ON UPPER(TRIM(e.numero_guia)) = UPPER(TRIM(fg.numero_guia))
     WHERE fg.encontrada = 0 AND fg.envio_id IS NULL AND e.no_volo = 0`).all();
  const cruzados = [];
  for (const envio of candidatas) {
    const h = await db.transaction(() => cruzarEnvio(db, envio));
    if (h) cruzados.push(h);
  }
  return { cruzados, cantidad: cruzados.length };
}

module.exports = { paraEnvio, pendientes, cruzarEnvio, filasSinEnvioDe };
