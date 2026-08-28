const { Router } = require('express');
const multer = require('multer');
const { getDb } = require('../db');
const { extraerFacturaUPS } = require('../services/factura-ups.service');
const { hoyLocal } = require('../utils/fecha');

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// 'pendiente' = neutro: la factura entró pero nadie la miró. Es el estado inicial al
// cargar. No aparece en la bandeja de Facturas ni resaltado en Salidas. El tilde verde
// ('revisado_ok') lo pone SOLO un humano; nunca el auto-marcado.
const ESTADOS_VALIDOS = ['pendiente', 'a_revisar', 'revisado_ok', 'reclamar'];

// Las guías se persisten normalizadas a mayúsculas y sin espacios (envio.model.js,
// salidas.routes.js). Normalizar acá con la MISMA regla permite buscar por igualdad
// directa sobre la columna, que es lo que deja usar el índice único.
function normalizarGuia(g) {
  return String(g ?? '').trim().toUpperCase();
}

// POST /api/facturas/chequear
// Solo lectura: extrae el PDF y devuelve qué guías ya tienen costo cargado en la BD.
router.post('/chequear', upload.single('pdf'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo PDF' });

    const extraido = await extraerFacturaUPS(req.file.buffer);
    const { guias, advertencias, total_declarado, suma_guias, diferencia, cuadra } = extraido;

    // La reconciliación y las advertencias viajan SIEMPRE, también cuando no hay guías.
    // El punto de /chequear es que el operador vea los problemas ANTES de cargar.
    const reconciliacion = { total_declarado, suma_guias, diferencia, cuadra };

    if (guias.length === 0) {
      return res.json({
        guias_total: 0,
        guias_ya_cargadas: [],
        conteo_ya_cargadas: 0,
        reconciliacion,
        advertencias,
      });
    }

    const db = getDb();
    const guias_ya_cargadas = [];

    for (const guia of guias) {
      // UPPER(numero_guia) en el WHERE anulaba el índice único idx_envios_numero_guia:
      // cada guía de la factura hacía un scan completo de `envios` (una factura de 200
      // guías = 200 scans, con la única conexión bloqueada todo ese rato). Las guías se
      // guardan siempre normalizadas a mayúsculas (envio.model.js), así que normalizamos
      // del lado de JS y la columna queda "limpia" para que el índice se use.
      const envio = await db
        .prepare('SELECT numero_guia, costo_facturado, fecha_facturado FROM envios WHERE numero_guia = ?')
        .get(normalizarGuia(guia.numero_guia));

      if (envio && envio.costo_facturado != null) {
        guias_ya_cargadas.push({
          numero_guia: guia.numero_guia,
          costo_facturado_anterior: envio.costo_facturado,
          fecha_facturado_anterior: envio.fecha_facturado,
          costo_nuevo: guia.costo_total,
        });
      }
    }

    res.json({
      guias_total: guias.length,
      conteo_ya_cargadas: guias_ya_cargadas.length,
      guias_ya_cargadas,
      // Guías cuyo importe no se pudo leer: no tienen costo y no se van a poder cargar.
      guias_sin_costo: guias.filter((g) => g.costo_total == null).map((g) => g.numero_guia),
      reconciliacion,
      advertencias,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/facturas/cargar
// Carga el PDF, actualiza envíos y registra en facturas_cargadas.
// Body (multipart): pdf (archivo), sobreescribir (string "true"/"false")
router.post('/cargar', upload.single('pdf'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo PDF' });

    const sobreescribir = req.body.sobreescribir === 'true' || req.body.sobreescribir === true;

    const extraido = await extraerFacturaUPS(req.file.buffer);
    const {
      numero_factura, fecha_factura, guias,
      advertencias, total_declarado, suma_guias, diferencia, cuadra,
      subtotal_factura, percepciones,
    } = extraido;

    const db = getDb();

    // Freno duro: si el PDF no dio ni una guía, no se registra una factura vacía.
    // Antes esto entraba igual y dejaba una cabecera con 0 guías, indistinguible de
    // una factura legítimamente vacía.
    if (guias.length === 0) {
      return res.status(422).json({
        error: 'No se detectó ninguna guía en el PDF. No se cargó nada.',
        advertencias,
      });
    }

    // Segundo freno: la misma factura cargada dos veces. `facturas_cargadas` no tiene
    // UNIQUE en numero_factura (y agregarlo sobre datos existentes es riesgoso), así
    // que se chequea acá. No es a prueba de dos requests simultáneos, pero cubre el
    // caso real: alguien sube el PDF, no ve el resultado, y lo vuelve a subir.
    if (numero_factura) {
      const yaCargada = await db
        .prepare('SELECT id, fecha_carga FROM facturas_cargadas WHERE numero_factura = ? ORDER BY id DESC')
        .get(numero_factura);
      if (yaCargada && !sobreescribir) {
        return res.status(409).json({
          error: `La factura ${numero_factura} ya fue cargada el ${yaCargada.fecha_carga}. `
            + 'Si querés volver a cargarla, marcá sobreescribir.',
          factura_id_anterior: yaCargada.id,
        });
      }
    }

    const config = await db
      .prepare('SELECT ganancia_minima_pct FROM configuracion WHERE courier = ?')
      .get('UPS');
    const umbral = config?.ganancia_minima_pct ?? 20;

    // hoyLocal(): con toISOString() (UTC) una carga de facturas de noche dejaba
    // fecha_facturado un día adelantada.
    const hoy = hoyLocal();

    const resumen = {
      total_guias: guias.length,
      guardadas: 0,
      omitidas_duplicado: 0,
      no_encontradas: 0,
      a_revisar: 0,
      // Contadores que faltaban. Sin ellos, los números del resumen no sumaban al
      // total y las guías que fallaban desaparecían sin dejar rastro visible: el
      // operador veía "120 guías, 118 guardadas" sin saber cuáles dos se perdieron.
      sin_costo: 0,
      errores: 0,
      no_encontradas_lista: [],
      sin_costo_lista: [],
      errores_lista: [],
    };

    // Detalle por guía a persistir en factura_guias (encabezado primero para el id).
    // Se registra TODA guía de la factura, matchee o no un envío, para tener el
    // ledger completo de lo que UPS facturó.
    const detalle = [];

    await db.transaction(async () => {
      // Sobreescribir REEMPLAZA la carga anterior de la misma factura, no la
      // duplica (L10, visto en producción el 28/08: 26 filas para 14 facturas y la
      // pestaña "Sin envío" mostrando 62 guías donde eran 43). Se borran la
      // cabecera y el detalle viejos ANTES de insertar los nuevos, adentro de la
      // misma transacción: si algo falla, la carga anterior queda intacta.
      // Los costos ya escritos en `envios` no se tocan acá — los pisa (o no) el
      // recorrido de guías de abajo, con la misma regla de siempre.
      if (sobreescribir && numero_factura) {
        await db.prepare(`
          DELETE FROM factura_guias WHERE factura_id IN
            (SELECT id FROM facturas_cargadas WHERE numero_factura = ?)
        `).run(numero_factura);
        await db.prepare('DELETE FROM facturas_cargadas WHERE numero_factura = ?')
          .run(numero_factura);
      }

      for (const guia of guias) {
        // Guía sin importe legible (el parser no pudo leer el neto). NO se escribe
        // costo 0 en el envío: un costo cero hace que la comparación de margen ni
        // siquiera corra y la guía queda 'pendiente' sin ninguna alerta, que era
        // exactamente el modo de fallar en silencio que estamos sacando.
        if (guia.costo_total == null) {
          resumen.sin_costo++;
          resumen.sin_costo_lista.push({ numero_guia: guia.numero_guia, pais: guia.pais });
          detalle.push({ guia, envio_id: null, encontrada: 0 });
          continue;
        }

        await db.exec('SAVEPOINT factura_row');
        try {
          // Igual que en /chequear: igualdad directa para que entre por el índice único.
          const envio = await db
            .prepare('SELECT id, total_cobrado, costo_facturado FROM envios WHERE numero_guia = ?')
            .get(normalizarGuia(guia.numero_guia));

          detalle.push({ guia, envio_id: envio ? envio.id : null, encontrada: envio ? 1 : 0 });

          if (!envio) {
            resumen.no_encontradas++;
            resumen.no_encontradas_lista.push({
              numero_guia: guia.numero_guia,
              pais: guia.pais,
              costo_total: guia.costo_total,
            });
            await db.exec('RELEASE SAVEPOINT factura_row');
            continue;
          }

          if (envio.costo_facturado != null && !sobreescribir) {
            resumen.omitidas_duplicado++;
            await db.exec('RELEASE SAVEPOINT factura_row');
            continue;
          }

          const total_cobrado = envio.total_cobrado ?? 0;
          const costo_facturado = guia.costo_total;
          // Default neutro: la guía entra 'pendiente' hasta que un humano la apruebe.
          // El auto-marcado a 'a_revisar' se mantiene: pre-filtra los de margen bajo y
          // los manda solos a la bandeja de problemas. Lo que NO hacemos es aprobar solos.
          let estado_revision = 'pendiente';

          if (costo_facturado > 0) {
            const ganancia_pct = (total_cobrado - costo_facturado) / costo_facturado * 100;
            if (ganancia_pct < umbral) estado_revision = 'a_revisar';
          }

          await db.prepare(`
            UPDATE envios
            SET costo_facturado   = ?,
                peso_facturado    = ?,
                courier_facturado = 'UPS',
                fecha_facturado   = ?,
                estado_revision   = ?,
                updated_at        = datetime('now', 'localtime')
            WHERE id = ?
          `).run(costo_facturado, guia.peso ?? null, hoy, estado_revision, envio.id);

          resumen.guardadas++;
          if (estado_revision === 'a_revisar') resumen.a_revisar++;

          await db.exec('RELEASE SAVEPOINT factura_row');
        } catch (e) {
          await db.exec('ROLLBACK TO SAVEPOINT factura_row');
          await db.exec('RELEASE SAVEPOINT factura_row');
          console.error(`[facturas/cargar] Error en guía ${guia.numero_guia}:`, e.message);
          // Antes esto solo iba al log del servidor y la guía no se contaba en NINGÚN
          // contador: el resumen decía "120 guías, 118 guardadas" y las dos que faltaban
          // eran invisibles. Ahora se cuentan y se listan.
          resumen.errores++;
          resumen.errores_lista.push({ numero_guia: guia.numero_guia, motivo: e.message });
          // Y se saca del detalle, para que el ledger no diga que se procesó algo que falló.
          const i = detalle.findIndex((d) => d.guia === guia);
          if (i !== -1) detalle.splice(i, 1);
        }
      }

      // Los tres totales del pie del PDF se guardan junto con la cabecera. El parser ya
      // los calculaba, pero antes solo se mostraban en el resumen de la carga y se
      // perdian: una vez cargada la factura no quedaba forma de verificar que la suma
      // de las guias diera el total. Es la diferencia entre poder auditar la percepcion
      // de Ingresos Brutos y tener que volver a abrir el PDF a mano.
      const header = await db.prepare(`
        INSERT INTO facturas_cargadas
          (courier, numero_factura, fecha_factura, cantidad_guias, guias_cruzadas, guias_no_encontradas, usuario,
           total_declarado, subtotal_factura, percepciones)
        VALUES ('UPS', ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `).run(
        numero_factura, fecha_factura, guias.length, resumen.guardadas, resumen.no_encontradas,
        total_declarado ?? null, subtotal_factura ?? null, percepciones ?? null
      );

      const facturaId = header.lastInsertRowid;

      // Detalle por guía (peso, neto, recargos desglosados y costo) para los cruces
      // de peso y de recargos facturados vs cobrados.
      // INSERT OR IGNORE + el índice único (factura_id, numero_guia): si por lo que
      // sea la misma guía apareciera dos veces en el detalle, no se duplica la fila
      // del ledger. Antes se insertaba incondicionalmente y un reintento dejaba el
      // detalle con el doble de filas que la cabecera declaraba.
      for (const d of detalle) {
        const g = d.guia;
        await db.prepare(`
          INSERT OR IGNORE INTO factura_guias
            (factura_id, envio_id, numero_guia, pais, peso_facturado, neto, total_recargos, percepcion, costo_total, cargos_json, encontrada)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          facturaId,
          d.envio_id,
          g.numero_guia,
          g.pais ?? null,
          g.peso ?? null,
          g.neto ?? null,
          g.total_recargos ?? null,
          g.percepcion ?? null,
          g.costo_total ?? null,
          JSON.stringify(g.cargos ?? []),
          d.encontrada
        );
      }
    });

    // Chequeo de coherencia del propio resumen: los contadores tienen que sumar el
    // total. Si no suman, hay una guía que se perdió por un camino que no previmos, y
    // es mejor decirlo que devolver números que no cierran.
    const contadas = resumen.guardadas + resumen.omitidas_duplicado
      + resumen.no_encontradas + resumen.sin_costo + resumen.errores;
    if (contadas !== resumen.total_guias) {
      resumen.advertencia_conteo =
        `Los contadores suman ${contadas} pero la factura tenía ${resumen.total_guias} guías. `
        + 'Hay guías sin clasificar: revisar.';
    }

    res.json({
      ...resumen,
      reconciliacion: { total_declarado, suma_guias, diferencia, cuadra },
      advertencias,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/facturas/guias
// Bandeja de problemas: SOLO los envíos facturados marcados como problema
// (a_revisar o reclamar). Los revisado_ok ya están aprobados y NO aparecen acá.
// Los a_revisar van primero.
router.get('/guias', async (req, res, next) => {
  try {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT
        e.id, e.numero_guia, e.pais_destino, e.fecha,
        e.total_cobrado, e.costo_facturado, e.courier_facturado,
        e.fecha_facturado, e.estado_revision, e.servicio_ups,
        c.nombre AS cliente
      FROM envios e
      JOIN clientes c ON c.id = e.cliente_id
      WHERE e.costo_facturado IS NOT NULL
        AND e.estado_revision IN ('a_revisar', 'reclamar')
      ORDER BY
        CASE e.estado_revision
          WHEN 'a_revisar'   THEN 0
          WHEN 'reclamar'    THEN 1
          ELSE 2
        END,
        e.fecha_facturado DESC,
        e.id DESC
    `).all();

    const result = rows.map((r) => {
      const ganancia_usd = r.total_cobrado != null
        ? Math.round((r.total_cobrado - r.costo_facturado) * 100) / 100
        : null;
      const ganancia_pct = r.costo_facturado > 0 && ganancia_usd != null
        ? Math.round((ganancia_usd / r.costo_facturado) * 10000) / 100
        : null;
      return {
        id: r.id,
        numero_guia: r.numero_guia,
        cliente: r.cliente,
        pais_destino: r.pais_destino,
        fecha: r.fecha,
        total_cobrado: r.total_cobrado,
        costo_facturado: r.costo_facturado,
        courier_facturado: r.courier_facturado,
        fecha_facturado: r.fecha_facturado,
        ganancia_usd,
        ganancia_pct,
        estado_revision: r.estado_revision,
        servicio_ups: r.servicio_ups ?? null,
      };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Guías facturadas sin envío ───────────────────────────────────────────────
//
// Cada fila acá es una guía que el courier COBRÓ y que no tiene envío en el sistema.
// O el envío nunca se cargó (y entonces no se le facturó a nadie: plata que se pagó y no
// se cobró), o el número de guía se tipeó mal al cargarlo.
//
// El backend ya las venía guardando (`factura_guias.encontrada = 0`), pero la única
// pantalla que las mostraba era el resumen del momento de cargar la factura: al salir
// de ahí no se volvían a ver nunca. Esto las consulta de todas las facturas cargadas.

// GET /api/facturas/sin-envio
router.get('/sin-envio', async (req, res, next) => {
  try {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT
        fg.id, fg.numero_guia, fg.pais, fg.peso_facturado, fg.costo_total, fg.percepcion,
        f.numero_factura, f.fecha_factura, f.fecha_carga, f.courier
      FROM factura_guias fg
      JOIN facturas_cargadas f ON f.id = fg.factura_id
      WHERE fg.encontrada = 0
      ORDER BY f.fecha_carga DESC, fg.id DESC
    `).all();

    const resultado = rows.map((r) => ({
      id: r.id,
      numero_guia: r.numero_guia,
      pais: r.pais,
      peso_facturado: r.peso_facturado,
      costo_total: r.costo_total,
      percepcion: r.percepcion,
      factura: r.numero_factura,
      fecha_factura: r.fecha_factura,
      fecha_carga: r.fecha_carga,
      courier: r.courier,
    }));

    // NO se sugiere "¿quisiste decir X?". Se probó y se sacó a pedido de Felipe (29/07):
    // todas las guías de Nova comparten el prefijo y solo cambian los últimos dígitos, así
    // que dos guías LEGÍTIMAS y distintas pueden diferir en un caracter. La sugerencia
    // apuntaría a un envío correcto y alguien podría "corregirlo" mal. Con marcar que la
    // guía no existe alcanza.

    res.json({
      total: resultado.length,
      costo_total: Math.round(resultado.reduce((s, g) => s + (g.costo_total || 0), 0) * 100) / 100,
      guias: resultado,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/facturas/guias/:id/estado
// Actualiza estado_revision de un envío con costo facturado.
router.patch('/guias/:id/estado', async (req, res, next) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

    const { estado_revision } = req.body;
    if (!ESTADOS_VALIDOS.includes(estado_revision)) {
      return res.status(400).json({
        error: `estado_revision debe ser uno de: ${ESTADOS_VALIDOS.join(', ')}`,
      });
    }

    const envio = await db
      .prepare('SELECT id FROM envios WHERE id = ? AND costo_facturado IS NOT NULL')
      .get(id);
    if (!envio) return res.status(404).json({ error: 'Envío no encontrado o sin costo facturado' });

    await db.prepare(`
      UPDATE envios
      SET estado_revision = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(estado_revision, id);

    res.json({ ok: true, estado_revision });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
