/**
 * _base-test.js — arranque común de los tests que levantan el servidor de verdad.
 *
 * POR QUÉ EXISTE
 * Los tests de pantalla usaban una base en /tmp y NO la creaban: se apoyaban, sin decirlo,
 * en la que había quedado de una corrida anterior. Eso tapaba dos cosas:
 *
 *   · En una máquina limpia (o después de borrar /tmp) fallaban todos con
 *     "Sesión inválida": la base nueva no tiene usuarios y la sesión se colgaba de un
 *     usuario_id 1 que no existe. En producción los usuarios son Felipe, Marcelo y
 *     empleado_test — no hay ningún id 1.
 *   · Cuando la base SÍ sobrevivía, los envíos que creaba el test quedaban guardados y la
 *     corrida siguiente fallaba con "Ya existe un envío con la guía".
 *
 * Es decir: los tests pasaban o fallaban según qué hubiera quedado en /tmp, que es lo peor
 * que puede pasarle a un test. Este helper deja el arranque explícito y repetible.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PROD = path.join(__dirname, '..', '..', 'database', 'nova.db');

/**
 * Deja la base de test como una copia FRESCA de la de producción.
 * Los -wal/-shm se borran sí o sí: si sobreviven, SQLite los reproduce sobre la copia
 * nueva y aparecen filas fantasma de la corrida anterior.
 *
 * @param {string} destino  ruta de la base de test
 * @param {{desdeProduccion?:boolean}} opts  desdeProduccion=false arranca de cero
 */
function prepararDb(destino, { desdeProduccion = true } = {}) {
  for (const f of [destino, destino + '-wal', destino + '-shm']) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  if (desdeProduccion && fs.existsSync(DB_PROD)) fs.copyFileSync(DB_PROD, destino);
}

/**
 * Abre una sesión válida para el token dado. Se cuelga de un usuario que EXISTA; si la
 * base no tiene ninguno (base recién creada), crea uno de prueba.
 * Hay que llamarla DESPUÉS de que el servidor levantó, porque es el servidor el que crea
 * y migra las tablas.
 *
 * @returns {Promise<number>} el usuario_id usado
 */
function abrirSesion(dbPath, token) {
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(dbPath);
  const all = (sql, p = []) =>
    new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

  return (async () => {
    let [usuario] = await all('SELECT id FROM usuarios ORDER BY id LIMIT 1');
    if (!usuario) {
      await all(
        "INSERT INTO usuarios (id, usuario, password_hash, rol) VALUES (1, 'tester', 'x', 'admin')"
      );
      usuario = { id: 1 };
    }
    await all('INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?,?,?)', [
      crypto.createHash('sha256').update(token).digest('hex'),
      usuario.id,
      new Date(Date.now() + 36e5).toISOString(),
    ]);
    await new Promise((res) => db.close(() => res()));
    return usuario.id;
  })();
}

module.exports = { DB_PROD, prepararDb, abrirSesion };
