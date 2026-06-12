const fs = require('fs');
const path = require('path');
const { getDb } = require('../db');
const config = require('../config');

const BACKUP_DIR = path.join(path.dirname(config.dbPath), 'backups');
const MAX_BACKUPS = 30;

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function hacerBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const destPath = path.join(BACKUP_DIR, `nova_backup_${timestamp()}.db`);
    const db = getDb();

    try {
      // VACUUM INTO produce un archivo único, compactado, con el WAL ya integrado
      await db.exec(`VACUUM INTO '${destPath.replace(/\\/g, '/')}'`);
    } catch (vacuumErr) {
      console.error('[backup] VACUUM INTO falló, usando fallback checkpoint+copia:', vacuumErr.message);
      // Flush WAL al archivo principal antes de copiar
      await db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      await fs.promises.copyFile(config.dbPath, destPath);
    }

    const { size } = fs.statSync(destPath);
    console.log(`[backup] OK → ${destPath} (${(size / 1024).toFixed(1)} KB)`);

    await rotarBackups();
  } catch (err) {
    console.error('[backup] Error al crear backup:', err);
    // No relanzar — el servidor debe seguir corriendo
  }
}

async function rotarBackups() {
  const archivos = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('nova_backup_') && f.endsWith('.db'))
    .sort(); // YYYYMMDD_HHmmss → lexicográfico = cronológico

  const sobrantes = archivos.slice(0, Math.max(0, archivos.length - MAX_BACKUPS));
  for (const f of sobrantes) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`[backup] Rotación: eliminado ${f}`);
  }
}

module.exports = { hacerBackup };
