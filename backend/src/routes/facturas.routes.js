const { Router } = require('express');
const multer = require('multer');
const { getDb } = require('../db');
const { extraerFacturaUPS } = require('../services/factura-ups.service');

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// POST /api/facturas/chequear
// Solo lectura: extrae el PDF y devuelve qué guías ya tienen costo cargado en la BD.
router.post('/chequear', upload.single('pdf'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo PDF' });

    const { guias } = await extraerFacturaUPS(req.file.buffer);

    if (guias.length === 0) {
      return res.json({ guias_total: 0, guias_ya_cargadas: [], conteo_ya_cargadas: 0 });
    }

    const db = getDb();
    const guias_ya_cargadas = [];

    for (const guia of guias) {
      const envio = await db
        .prepare('SELECT numero_guia, costo_facturado, fecha_facturado FROM envios WHERE numero_guia = ?')
        .get(guia.numero_guia);

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

    const { numero_factura, fecha_factura, guias } = await extraerFacturaUPS(req.file.buffer);

    const db = getDb();

    const config = await db
      .prepare('SELECT ganancia_minima_pct FROM configuracion WHERE courier = ?')
      .get('UPS');
    const umbral = config?.ganancia_minima_pct ?? 20;

    const hoy = new Date().toISOString().slice(0, 10);

    const resumen = {
      total_guias: guias.length,
      guardadas: 0,
      omitidas_duplicado: 0,
      no_encontradas: 0,
      a_revisar: 0,
      no_encontradas_lista: [],
    };

    await db.transaction(async () => {
      for (const guia of guias) {
        await db.exec('SAVEPOINT factura_row');
        try {
          const envio = await db
            .prepare('SELECT id, total_cobrado, costo_facturado FROM envios WHERE numero_guia = ?')
            .get(guia.numero_guia);

          if (!envio) {
            resumen.no_encontradas++;
            resumen.no_encontradas_lista.push(guia.numero_guia);
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
          let estado_revision = 'ok';

          if (costo_facturado > 0) {
            const ganancia_pct = (total_cobrado - costo_facturado) / costo_facturado * 100;
            if (ganancia_pct < umbral) estado_revision = 'a_revisar';
          }

          await db.prepare(`
            UPDATE envios
            SET costo_facturado  = ?,
                courier_facturado = 'UPS',
                fecha_facturado  = ?,
                estado_revision  = ?,
                updated_at       = datetime('now', 'localtime')
            WHERE id = ?
          `).run(costo_facturado, hoy, estado_revision, envio.id);

          resumen.guardadas++;
          if (estado_revision === 'a_revisar') resumen.a_revisar++;

          await db.exec('RELEASE SAVEPOINT factura_row');
        } catch (e) {
          await db.exec('ROLLBACK TO SAVEPOINT factura_row');
          await db.exec('RELEASE SAVEPOINT factura_row');
          console.error(`[facturas/cargar] Error en guía ${guia.numero_guia}:`, e.message);
        }
      }

      await db.prepare(`
        INSERT INTO facturas_cargadas
          (courier, numero_factura, fecha_factura, cantidad_guias, guias_cruzadas, guias_no_encontradas, usuario)
        VALUES ('UPS', ?, ?, ?, ?, ?, NULL)
      `).run(numero_factura, fecha_factura, guias.length, resumen.guardadas, resumen.no_encontradas);
    });

    res.json(resumen);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
