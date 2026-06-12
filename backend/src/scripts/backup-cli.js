const { initDb, closeDb } = require('../db');
const { hacerBackup } = require('../services/backup.service');

async function main() {
  console.log('[backup-cli] Iniciando backup manual...');
  await initDb();
  await hacerBackup();
  await closeDb();
  console.log('[backup-cli] Listo.');
}

main().catch((err) => {
  console.error('[backup-cli] Error fatal:', err);
  process.exit(1);
});
