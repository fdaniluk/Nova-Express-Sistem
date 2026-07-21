const crypto = require('crypto');
const { buscarSesionConUsuario, borrarSesionPorTokenHash } = require('../models/auth.model');

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies && req.cookies.nova_session;
    if (!token) return res.status(401).json({ error: 'No autenticado' });

    const tokenHash = sha256(token);
    const session = await buscarSesionConUsuario(tokenHash);

    if (!session) return res.status(401).json({ error: 'Sesión inválida' });

    if (new Date(session.expira_en) < new Date()) {
      await borrarSesionPorTokenHash(tokenHash).catch(() => {});
      return res.status(401).json({ error: 'Sesión expirada' });
    }

    if (!session.activo) return res.status(401).json({ error: 'Usuario inactivo' });

    req.usuario = {
      id: session.usuario_id,
      usuario: session.usuario,
      rol: session.rol,
      ver_dashboard: session.ver_dashboard,
      editar_config: session.editar_config,
    };
    next();
  } catch (err) {
    next(err);
  }
}

function requireDashboard(req, res, next) {
  if (!req.usuario || req.usuario.ver_dashboard !== 1) {
    return res.status(403).json({ error: 'Acceso denegado al dashboard' });
  }
  next();
}

// El admin SIEMPRE puede, tenga o no el flag; los demás necesitan editar_config = 1.
function requireConfig(req, res, next) {
  if (!req.usuario || (req.usuario.rol !== 'admin' && req.usuario.editar_config !== 1)) {
    return res.status(403).json({ error: 'Acceso denegado a la configuración' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.usuario || req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Se requiere rol administrador' });
  }
  next();
}

module.exports = { requireAuth, requireDashboard, requireConfig, requireAdmin };
