const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const config = require('./config');
const routes = require('./routes');
const { initDb, getDb } = require('./db');
const { migrarColumnas: migrarColumnasliquidacion } = require('./models/liquidacion.model');
const { hacerBackup } = require('./services/backup.service');
const { borrarSesionesExpiradas } = require('./models/auth.model');

const app = express();

app.set('trust proxy', 1);

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.use('/api', routes);

const frontendPath = path.join(__dirname, '../../frontend');
// La URL linda del link de cotizacion: /cotizar/CODIGO sirve la pagina publica y la
// pagina saca el codigo de la URL. Va ANTES del static para que no busque un archivo.
app.get('/cotizar/:codigo', (req, res) => {
  res.sendFile(path.join(frontendPath, 'pages', 'cotizar-cliente.html'));
});
app.use(express.static(frontendPath));
app.use('/shared', express.static(path.join(__dirname, '../../shared')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message || 'Error interno del servidor',
  });
});

initDb()
  .then(async () => {
    await migrarColumnasliquidacion();
    console.log('[liquidacion.model] Migración de columnas OK');
    await hacerBackup();
    setInterval(hacerBackup, 24 * 60 * 60 * 1000);

    // Purga de sesiones vencidas. La función existía desde siempre y no la llamaba
    // nadie: en producción había 25 sesiones vencidas de 43 acumuladas. No afecta la
    // seguridad (el middleware ya valida la expiración en cada request), es higiene.
    // Falla en silencio a propósito: que no se pueda limpiar no debe tirar el arranque.
    const purgarSesiones = async () => {
      try {
        const n = await borrarSesionesExpiradas();
        if (n > 0) console.log(`[sesiones] purgadas ${n} sesiones vencidas`);
      } catch (err) {
        console.error('[sesiones] no se pudieron purgar las vencidas:', err.message);
      }
    };
    await purgarSesiones();
    setInterval(purgarSesiones, 24 * 60 * 60 * 1000);

    // Semáforo automático de Salidas (31/08): cada 4 horas le pregunta a UPS por los
    // envíos en curso y pinta rojo/amarillo/verde solo. Sin credenciales UPS queda
    // apagado (los tests y cualquier entorno sin .env de UPS caen acá y no tocan la
    // red). La primera pasada espera un minuto para no pisar el arranque.
    if ((process.env.UPS_CLIENT_ID || '').trim()) {
      const { refrescarSemaforo } = require('./services/tracking-auto.service');
      const correrSemaforo = async () => {
        try {
          const r = await refrescarSemaforo(getDb());
          console.log(`[tracking-auto] consultados ${r.consultados} · pintados ${r.pintados} · errores ${r.errores} · omitidos ${r.omitidos}`);
        } catch (err) {
          console.error('[tracking-auto] la pasada falló entera:', err.message);
        }
      };
      setTimeout(correrSemaforo, 60 * 1000);
      setInterval(correrSemaforo, 4 * 60 * 60 * 1000);
    } else {
      console.log('[tracking-auto] sin credenciales UPS: el semáforo automático queda apagado');
    }
    app.listen(config.port, () => {
      console.log(`Nova Express API en http://localhost:${config.port}`);
      console.log(`Base de datos: ${config.dbPath}`);
    });
  })
  .catch((err) => {
    console.error('Error al iniciar la base de datos:', err);
    process.exit(1);
  });
