const path = require('path');
require('dotenv').config();

const ROOT = path.resolve(__dirname, '../../..');

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPath: process.env.DB_PATH || path.join(ROOT, 'database', 'nova.db'),
  schemaPath: path.join(ROOT, 'database', 'schema', 'schema.sql'),
  corsOrigin: process.env.CORS_ORIGIN || '*',
};
