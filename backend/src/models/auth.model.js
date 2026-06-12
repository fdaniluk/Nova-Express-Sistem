const { getDb } = require('../db');

async function buscarUsuarioPorNombre(usuario) {
  return getDb().prepare('SELECT * FROM usuarios WHERE usuario = ? COLLATE NOCASE').get(usuario);
}

async function crearSesion(usuario_id, token_hash, expira_en) {
  await getDb()
    .prepare('INSERT INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?, ?, ?)')
    .run(token_hash, usuario_id, expira_en);
}

async function buscarSesionConUsuario(token_hash) {
  return getDb().prepare(
    `SELECT s.expira_en, s.usuario_id, u.usuario, u.rol, u.ver_dashboard, u.activo
     FROM sesiones s
     JOIN usuarios u ON u.id = s.usuario_id
     WHERE s.token_hash = ?`
  ).get(token_hash);
}

async function borrarSesionPorTokenHash(token_hash) {
  await getDb().prepare('DELETE FROM sesiones WHERE token_hash = ?').run(token_hash);
}

async function borrarSesionesExpiradas() {
  await getDb().prepare("DELETE FROM sesiones WHERE expira_en < datetime('now')").run();
}

module.exports = {
  buscarUsuarioPorNombre,
  crearSesion,
  buscarSesionConUsuario,
  borrarSesionPorTokenHash,
  borrarSesionesExpiradas,
};
