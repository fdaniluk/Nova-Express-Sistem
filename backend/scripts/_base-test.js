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

/**
 * Espera a que el servidor de prueba esté REALMENTE arriba, y si no arrancó lo dice.
 *
 * POR QUÉ EXISTE
 * Los tests venían haciendo un bucle de 40 intentos contra /api/health y seguían de largo
 * pasara lo que pasara. Si el servidor no arrancaba —el puerto ocupado por una corrida
 * anterior que quedó viva, un error de arranque, la máquina lenta— el test continuaba
 * igual y reventaba más adelante con un mensaje que no tenía nada que ver. El caso real
 * (Felipe, 06/08/2026, en Windows):
 *
 *     ✗ Error inesperado: [Error: SQLITE_ERROR: no such table: usuarios]
 *
 * Eso NO era un problema de la base: era el servidor que nunca levantó, y la tabla no
 * existía porque nadie la había creado todavía. Media hora de mirar el lugar equivocado.
 *
 * Ahora: si el proceso hijo se murió, se corta en el acto y se muestra SU salida de error
 * (que es donde está el motivo de verdad, EADDRINUSE incluido). Si no se murió pero no
 * contesta, se corta al agotar el tiempo diciendo eso mismo.
 *
 * El tiempo es generoso a propósito: en Windows, con el antivirus mirando cada archivo y
 * la base creándose desde cero, 12 segundos se quedaban cortos.
 *
 * SE ESPERA EL AVISO DEL PROPIO SERVIDOR, NO /api/health
 * Esto importa y no es un detalle. Si quedó vivo un servidor de una corrida anterior en el
 * mismo puerto, /api/health contesta que sí — pero contesta ESE, con OTRA base de datos.
 * El nuestro, mientras tanto, se murió con EADDRINUSE. Preguntándole al puerto es
 * imposible distinguir "arrancó" de "hay otro escuchando", y el test sigue de largo
 * hablándole a la base equivocada. Por eso se espera la línea que imprime NUESTRO proceso
 * hijo al quedar listo: eso solo puede venir de él.
 *
 * @param {ChildProcess} srv    el proceso del servidor (spawn)
 * @param {string} base         http://localhost:PUERTO
 * @param {() => string} logErr devuelve lo que el servidor escribió en stderr
 * @param {() => string} logOut devuelve lo que el servidor escribió en stdout
 * @param {number} segundos     tope de espera (30 por defecto)
 */
const LISTO = /Nova Express API en/;

async function esperarServidor(srv, base, logErr = () => '', logOut = () => '', segundos = 30) {
  const hasta = Date.now() + segundos * 1000;
  const morir = (motivo) => {
    const err = (logErr() || '').trim();
    const pista = /EADDRINUSE|address already in use/i.test(err)
      ? '\nEl puerto ya está ocupado: quedó vivo un node de una corrida anterior. '
        + 'Cerrá esa ventana, o matá el proceso, y volvé a correr el test.'
      : '';
    throw new Error(
      `${motivo}\nPuerto: ${base}\n`
      + (err ? `Lo que dijo el servidor:\n${err}` : 'El servidor no dejó ningún mensaje.')
      + pista,
    );
  };

  while (Date.now() < hasta) {
    if (LISTO.test(logOut())) return;
    if (srv.exitCode !== null || srv.signalCode !== null) {
      morir(`El servidor de prueba se murió al arrancar (código ${srv.exitCode ?? srv.signalCode}).`);
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  morir(`El servidor de prueba no llegó a arrancar en ${segundos} s.`);
}

module.exports = { DB_PROD, prepararDb, abrirSesion, esperarServidor };
