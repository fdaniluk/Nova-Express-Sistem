/**
 * tracking-auto.service.js — el semáforo de Salidas que se pinta solo (31/08/2026).
 *
 * POR QUÉ EXISTE
 * El semáforo por bulto (rojo = sin escanear · amarillo = en tránsito · verde =
 * entregada) estaba en la pantalla desde julio, pero era manual — y por manual no lo
 * usaba nadie. Felipe (31/08): "si bien hoy en día está, no se usa porque no se hace
 * solo". Esto lo hace solo: cada tanto le pregunta a UPS por cada envío en curso y
 * pinta el semáforo con la respuesta.
 *
 * LAS REGLAS (decididas por Felipe el 31/08):
 *  - Corre cada 4 horas (y una vez al arrancar el servidor).
 *  - Solo UPS: DHL no tiene API configurada, sus botones siguen siendo manuales.
 *  - GANA UPS SIEMPRE: en un envío UPS, lo que diga el courier pisa lo que se haya
 *    marcado a mano. Los botones quedan para DHL y para el que quiera ver el detalle.
 *
 * QUÉ MIRA Y QUÉ NO
 *  - Envíos UPS de los últimos 45 días, con guía con pinta de UPS (1Z + 16), que no
 *    estén NO VOLÓ ni ya entregados (verde es terminal: entregado no se vuelve a
 *    preguntar — es lo que mantiene el costo de API bajo).
 *  - El resultado se guarda DOS veces: en `envios.tracking_*` (la verdad del courier,
 *    con fecha, para que "hace cuánto se miró" siempre se pueda saber) y en
 *    `envio_bultos.estado_caja` (lo que pinta la pantalla). Para envíos sin filas de
 *    bulto (bulto único sintético) el GET de Salidas cae a `envios.tracking_estado`.
 *  - Una guía que UPS rechaza (mal tipeada, ajena) queda anotada en tracking_detalle
 *    con su fecha — visible, nunca un silencio. El backlog lo pedía así: el riesgo de
 *    un tracking automático es "que falle en silencio y muestre estados viejos como
 *    frescos".
 *
 * El acceso a UPS se inyecta (`obtenerTracking`) para que la tanda de tests ejercite
 * todo el circuito sin red y sin credenciales.
 */

const { getTracking, semaforoDeEstado } = require('./ups.service');

// Guía UPS: "1Z" + 16 alfanuméricos (igual que tracking.routes.js).
const UPS_GUIA_REGEX = /^1Z[0-9A-Z]{16}$/i;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Una pasada completa del semáforo automático.
 * @param db          la base (getDb() del caller — inyectada para poder testear)
 * @param obtenerTracking  reemplazo de getTracking en tests
 * @param limite      tope de guías por pasada (defensa de rate limit)
 * @param pausaMs     respiro entre llamadas a UPS
 * @returns {consultados, pintados, errores, omitidos}
 */
async function refrescarSemaforo(db, { obtenerTracking = getTracking, limite = 300, pausaMs = 250 } = {}) {
  const candidatos = await db.prepare(`
    SELECT id, numero_guia
    FROM envios
    WHERE UPPER(courier) LIKE '%UPS%'
      AND numero_guia IS NOT NULL AND TRIM(numero_guia) != ''
      AND (no_volo IS NULL OR no_volo = 0)
      AND fecha >= date('now', '-45 day')
      AND (tracking_estado IS NULL OR tracking_estado != 'verde')
    ORDER BY fecha DESC, id DESC
  `).all();

  const resumen = { consultados: 0, pintados: 0, errores: 0, omitidos: 0 };

  for (const e of candidatos) {
    if (resumen.consultados >= limite) break;

    const guia = String(e.numero_guia).trim();
    if (!UPS_GUIA_REGEX.test(guia)) {
      // Guía que no tiene forma de UPS (mal tipeada o de otra cuenta): se anota UNA vez
      // para que se vea en el tooltip, y no se gasta una llamada de API en ella.
      await db.prepare(`
        UPDATE envios SET tracking_detalle = ?, tracking_fecha = datetime('now', 'localtime')
        WHERE id = ? AND (tracking_detalle IS NULL OR tracking_detalle != ?)
      `).run('Guía sin formato UPS: no se puede rastrear', e.id, 'Guía sin formato UPS: no se puede rastrear');
      resumen.omitidos++;
      continue;
    }

    resumen.consultados++;
    try {
      const t = await obtenerTracking(guia);
      const color = semaforoDeEstado(t?.tipo, t?.estado);
      const detalle = [t?.estado, t?.ubicacion].filter(Boolean).join(' — ') || null;
      if (color) {
        await db.prepare(`
          UPDATE envios SET tracking_estado = ?, tracking_detalle = ?, tracking_fecha = datetime('now', 'localtime')
          WHERE id = ?
        `).run(color, detalle, e.id);
        // Gana UPS siempre: pisa lo manual en los bultos de este envío.
        await db.prepare('UPDATE envio_bultos SET estado_caja = ? WHERE envio_id = ?').run(color, e.id);
        resumen.pintados++;
      } else {
        // UPS respondió pero sin nada útil: se deja constancia de que se miró.
        await db.prepare(`
          UPDATE envios SET tracking_detalle = ?, tracking_fecha = datetime('now', 'localtime') WHERE id = ?
        `).run('UPS sin actividad para esta guía', e.id);
      }
    } catch (err) {
      // El error queda A LA VISTA en el envío (no solo en el log): tracking_detalle lo
      // muestra el tooltip del semáforo. El estado anterior NO se toca.
      resumen.errores++;
      const msg = String(err.message || err).slice(0, 200);
      await db.prepare(`
        UPDATE envios SET tracking_detalle = ?, tracking_fecha = datetime('now', 'localtime') WHERE id = ?
      `).run('Error al rastrear: ' + msg, e.id);
    }
    if (pausaMs > 0) await esperar(pausaMs);
  }

  return resumen;
}

module.exports = { refrescarSemaforo, UPS_GUIA_REGEX };
