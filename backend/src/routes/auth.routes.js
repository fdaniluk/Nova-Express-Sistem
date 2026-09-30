const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { buscarUsuarioPorNombre, crearSesion, borrarSesionPorTokenHash } = require('../models/auth.model');
const { requireAuth } = require('../middleware/auth');

const router = Router();

const COOKIE_NAME = 'nova_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.nodeEnv === 'production',
  maxAge: MAX_AGE_MS,
  path: '/',
};

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Freno de intentos (29/09/2026): 10 fallidos por IP en 15 minutos y se corta hasta que
// pase la ventana. En memoria alcanza: es un solo proceso y un reinicio no es un problema.
const VENTANA_MS = 15 * 60 * 1000;
const MAX_FALLIDOS = 10;
const fallidos = new Map(); // ip -> [timestamps]
function intentosRecientes(ip) {
  const ahora = Date.now();
  const lista = (fallidos.get(ip) || []).filter((t) => ahora - t < VENTANA_MS);
  if (lista.length) fallidos.set(ip, lista); else fallidos.delete(ip);
  return lista;
}
function anotarFallido(ip) { intentosRecientes(ip); fallidos.set(ip, [...(fallidos.get(ip) || []), Date.now()]); }

router.post('/login', async (req, res, next) => {
  const ip = req.ip || 'sin-ip';
  if (intentosRecientes(ip).length >= MAX_FALLIDOS) {
    return res.status(429).json({ error: 'Demasiados intentos fallidos. Esperá 15 minutos y probá de nuevo.' });
  }
  const rechazar = () => { anotarFallido(ip); return res.status(401).json({ error: 'Usuario o contraseña incorrectos' }); };
  try {
    const usuario = (req.body?.usuario || '').trim();
    const password = (req.body?.password || '').trim();
    if (!usuario || !password) {
      return rechazar();
    }

    const user = await buscarUsuarioPorNombre(usuario);
    if (!user || !user.activo) {
      return rechazar();
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return rechazar();
    }
    fallidos.delete(ip);

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(token);
    const expira_en = new Date(Date.now() + MAX_AGE_MS).toISOString();

    await crearSesion(user.id, tokenHash, expira_en);

    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({
      usuario: user.usuario,
      rol: user.rol,
      ver_dashboard: user.ver_dashboard,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (token) {
      await borrarSesionPorTokenHash(sha256(token)).catch(() => {});
    }
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json(req.usuario);
});

module.exports = router;
