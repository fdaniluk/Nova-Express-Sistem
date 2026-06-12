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

router.post('/login', async (req, res, next) => {
  try {
    const { usuario, password } = req.body || {};
    if (!usuario || !password) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    const user = await buscarUsuarioPorNombre(usuario);
    if (!user || !user.activo) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

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
