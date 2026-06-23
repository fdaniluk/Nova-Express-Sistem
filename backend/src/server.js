const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const config = require('./config');
const routes = require('./routes');
const { initDb } = require('./db');
const { migrarColumnas: migrarColumnasliquidacion } = require('./models/liquidacion.model');
const { hacerBackup } = require('./services/backup.service');

const app = express();

app.set('trust proxy', 1);

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.use('/api', routes);

const frontendPath = path.join(__dirname, '../../frontend');
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
    app.listen(config.port, () => {
      console.log(`Nova Express API en http://localhost:${config.port}`);
      console.log(`Base de datos: ${config.dbPath}`);
    });
  })
  .catch((err) => {
    console.error('Error al iniciar la base de datos:', err);
    process.exit(1);
  });
