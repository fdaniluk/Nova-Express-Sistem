const { getDb } = require('../db');

async function listarUsuarios() {
  return getDb()
    .prepare('SELECT id, usuario, rol, ver_dashboard, activo, creado_en FROM usuarios ORDER BY id')
    .all();
}

async function buscarUsuarioPorId(id) {
  return getDb()
    .prepare('SELECT id, usuario, rol, ver_dashboard, activo, creado_en FROM usuarios WHERE id = ?')
    .get(id);
}

async function buscarUsuarioPorNombre(nombre) {
  return getDb()
    .prepare('SELECT id FROM usuarios WHERE usuario = ? COLLATE NOCASE')
    .get(nombre);
}

async function crearUsuario({ usuario, password_hash, rol, ver_dashboard }) {
  const result = await getDb()
    .prepare('INSERT INTO usuarios (usuario, password_hash, rol, ver_dashboard, activo) VALUES (?, ?, ?, ?, 1)')
    .run(usuario, password_hash, rol, ver_dashboard);
  return result.lastInsertRowid;
}

async function actualizarUsuario(id, campos) {
  const keys = Object.keys(campos);
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(campos), id];
  await getDb().prepare(`UPDATE usuarios SET ${sets} WHERE id = ?`).run(...values);
}

async function resetearPassword(id, password_hash) {
  await getDb().prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(password_hash, id);
}

async function contarAdminsActivos() {
  const row = await getDb()
    .prepare("SELECT COUNT(*) as count FROM usuarios WHERE rol = 'admin' AND activo = 1")
    .get();
  return row.count;
}

async function borrarSesionesDeUsuario(id) {
  await getDb().prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id);
}

module.exports = {
  listarUsuarios,
  buscarUsuarioPorId,
  buscarUsuarioPorNombre,
  crearUsuario,
  actualizarUsuario,
  resetearPassword,
  contarAdminsActivos,
  borrarSesionesDeUsuario,
};
