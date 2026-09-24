const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPath: process.env.DB_PATH || path.join(ROOT, 'database', 'nova.db'),
  schemaPath: path.join(ROOT, 'database', 'schema', 'schema.sql'),
  // Comprobantes de pago adjuntos (Cobranzas). Junto a la base, fuera de git.
  adjuntosDir: process.env.ADJUNTOS_DIR || path.join(ROOT, 'database', 'adjuntos'),
  corsOrigin: process.env.CORS_ORIGIN || '*',
};
