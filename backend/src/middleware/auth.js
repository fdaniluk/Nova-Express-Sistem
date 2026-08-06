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
      ver_salud: session.ver_salud,
      cerrar_mes: session.cerrar_mes,
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

// Panel de salud. Misma regla que requireConfig: el admin SIEMPRE puede, los demás
// necesitan ver_salud = 1. Es un permiso aparte del dashboard a propósito — el
// dashboard muestra la plata que se hizo, el panel de salud muestra lo que está roto,
// y no tienen por qué verlos las mismas personas.
function requireSalud(req, res, next) {
  if (!req.usuario || (req.usuario.rol !== 'admin' && req.usuario.ver_salud !== 1)) {
    return res.status(403).json({ error: 'Acceso denegado al panel de salud' });
  }
  next();
}

// Cierre de mes/semana. Misma regla de siempre: el admin puede, los demás necesitan
// cerrar_mes = 1. Es un permiso aparte de los otros dos a propósito: lo usa
// administración para archivar la planilla del período, no dirección para mirar plata.
// Lo que se lleva quien lo tiene es el detalle completo de las salidas del período, así
// que no se regala junto con el acceso a la pantalla de Salidas.
function requireCierre(req, res, next) {
  if (!req.usuario || (req.usuario.rol !== 'admin' && req.usuario.cerrar_mes !== 1)) {
    return res.status(403).json({ error: 'Acceso denegado al cierre de período' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.usuario || req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Se requiere rol administrador' });
  }
  next();
}

module.exports = {
  requireAuth, requireDashboard, requireConfig, requireSalud, requireCierre, requireAdmin,
};
