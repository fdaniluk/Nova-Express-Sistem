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
    `SELECT s.expira_en, s.usuario_id, u.usuario, u.rol, u.ver_dashboard, u.editar_config, u.activo
     FROM sesiones s
     JOIN usuarios u ON u.id = s.usuario_id
     WHERE s.token_hash = ?`
  ).get(token_hash);
}

async function borrarSesionPorTokenHash(token_hash) {
  await getDb().prepare('DELETE FROM sesiones WHERE token_hash = ?').run(token_hash);
}

// `expira_en` se guarda como ISO-8601 con T y Z (auth.routes.js), no con el formato
// 'YYYY-MM-DD HH:MM:SS' que devuelve datetime('now'). Comparar contra datetime('now')
// era comparar strings de dos formatos distintos: la 'T' (0x54) ordena DESPUÉS del
// espacio (0x20), así que una sesión vencida el mismo día nunca se borraba.
// Comparando ISO contra ISO el orden sí es cronológico.
async function borrarSesionesExpiradas() {
  const { changes } = await getDb()
    .prepare('DELETE FROM sesiones WHERE expira_en < ?')
    .run(new Date().toISOString());
  return changes;
}

module.exports = {
  buscarUsuarioPorNombre,
  crearSesion,
  buscarSesionConUsuario,
  borrarSesionPorTokenHash,
  borrarSesionesExpiradas,
};
