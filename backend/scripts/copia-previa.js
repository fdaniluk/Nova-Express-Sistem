#!/usr/bin/env node
/**
 * copia-previa.js — una copia de la base ANTES de desplegar, abierta y verificada.
 *
 * POR QUÉ EXISTE Y POR QUÉ NO ES `npm run backup`
 * `npm run backup` levanta la base con `initDb()`, que corre las migraciones. Antes de
 * un despliegue eso es justo lo que no se quiere: la copia de seguridad tiene que ser
 * una FOTO de lo que hay, sin tocar nada. Esto abre la base en SOLO LECTURA.
 *
 * Y no usa el `sqlite3` de línea de comandos a propósito: en el VPS puede no estar
 * instalado, y un backup que no corre porque falta un programa es un backup que no
 * existe. Usa el sqlite3 que ya trae la aplicación, que sí está sí o sí.
 *
 * QUÉ HACE
 *   1. VACUUM INTO: un archivo único, compactado, con el WAL ya integrado.
 *   2. ABRE la copia y cuenta los envíos. Una copia que no se puede leer es peor que no
 *      tener copia, porque da tranquilidad falsa. Si no se puede leer, sale con error.
 *
 * Imprime la cantidad de envíos de la COPIA. Sale con 0 si la copia sirve, 1 si no.
 *
 *   node scripts/copia-previa.js <base> <destino>
 */

const fs = require('fs');
const sqlite3 = require('sqlite3');

const [origen, destino] = process.argv.slice(2);

if (!origen || !destino) {
  console.error('Uso: node scripts/copia-previa.js <base.db> <destino.db>');
  process.exit(1);
}
if (!fs.existsSync(origen)) {
  console.error(`No existe la base: ${origen}`);
  process.exit(1);
}

const abrir = (ruta, modo) => new Promise((res, rej) => {
  const db = new sqlite3.Database(ruta, modo, (e) => (e ? rej(e) : res(db)));
});
const correr = (db, sql) => new Promise((res, rej) => db.exec(sql, (e) => (e ? rej(e) : res())));
const uno = (db, sql) => new Promise((res, rej) => db.get(sql, (e, r) => (e ? rej(e) : res(r))));
const cerrar = (db) => new Promise((res) => db.close(() => res()));

(async () => {
  let db;
  try {
    db = await abrir(origen, sqlite3.OPEN_READONLY);
    await correr(db, `VACUUM INTO '${destino.replace(/'/g, "''")}'`);
    await cerrar(db);
  } catch (e) {
    if (db) await cerrar(db);
    console.error(`No se pudo copiar la base: ${e.message}`);
    process.exit(1);
  }

  // La prueba de fuego: abrir lo que quedó y leerlo.
  try {
    const copia = await abrir(destino, sqlite3.OPEN_READONLY);
    const { n } = await uno(copia, 'SELECT COUNT(*) AS n FROM envios');
    await cerrar(copia);
    console.log(String(n));
    process.exitCode = 0;
  } catch (e) {
    console.error(`La copia se creó pero NO se puede leer: ${e.message}`);
    process.exit(1);
  }

  setTimeout(() => process.exit(process.exitCode || 0), 2000).unref();
})();
