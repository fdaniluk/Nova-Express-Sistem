const { Router } = require('express');
const bcrypt = require('bcryptjs');
const model = require('../models/usuarios.model');

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const usuarios = await model.listarUsuarios();
    res.json(usuarios);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { usuario, password, rol, ver_dashboard, editar_config, ver_salud, cerrar_mes } =
      req.body || {};

    if (!usuario || !String(usuario).trim())
      return res.status(400).json({ error: 'El nombre de usuario es requerido' });
    if (!password || String(password).length < 6)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    if (!['admin', 'empleado'].includes(rol))
      return res.status(400).json({ error: "El rol debe ser 'admin' o 'empleado'" });
    if (![0, 1].includes(Number(ver_dashboard)))
      return res.status(400).json({ error: 'ver_dashboard debe ser 0 o 1' });
    if (![0, 1].includes(Number(editar_config)))
      return res.status(400).json({ error: 'editar_config debe ser 0 o 1' });
    // ver_salud es opcional al crear: un usuario nuevo arranca sin acceso al panel.
    if (ver_salud !== undefined && ![0, 1].includes(Number(ver_salud)))
      return res.status(400).json({ error: 'ver_salud debe ser 0 o 1' });
    // cerrar_mes, igual: opcional al crear, arranca en 0.
    if (cerrar_mes !== undefined && ![0, 1].includes(Number(cerrar_mes)))
      return res.status(400).json({ error: 'cerrar_mes debe ser 0 o 1' });

    const existente = await model.buscarUsuarioPorNombre(String(usuario).trim());
    if (existente) return res.status(409).json({ error: 'Ya existe un usuario con ese nombre' });

    const password_hash = await bcrypt.hash(String(password), 10);
    const id = await model.crearUsuario({
      usuario: String(usuario).trim(),
      password_hash,
      rol,
      ver_dashboard: Number(ver_dashboard),
      editar_config: Number(editar_config),
      ver_salud: ver_salud === undefined ? 0 : Number(ver_salud),
      cerrar_mes: cerrar_mes === undefined ? 0 : Number(cerrar_mes),
    });

    const nuevo = await model.buscarUsuarioPorId(id);
    res.status(201).json(nuevo);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rol, ver_dashboard, editar_config, ver_salud, cerrar_mes, activo } = req.body || {};
    const campos = {};

    if (rol !== undefined) {
      if (!['admin', 'empleado'].includes(rol))
        return res.status(400).json({ error: "El rol debe ser 'admin' o 'empleado'" });
      campos.rol = rol;
    }
    if (ver_dashboard !== undefined) {
      if (![0, 1].includes(Number(ver_dashboard)))
        return res.status(400).json({ error: 'ver_dashboard debe ser 0 o 1' });
      campos.ver_dashboard = Number(ver_dashboard);
    }
    if (editar_config !== undefined) {
      if (![0, 1].includes(Number(editar_config)))
        return res.status(400).json({ error: 'editar_config debe ser 0 o 1' });
      campos.editar_config = Number(editar_config);
    }
    if (ver_salud !== undefined) {
      if (![0, 1].includes(Number(ver_salud)))
        return res.status(400).json({ error: 'ver_salud debe ser 0 o 1' });
      campos.ver_salud = Number(ver_salud);
    }
    if (cerrar_mes !== undefined) {
      if (![0, 1].includes(Number(cerrar_mes)))
        return res.status(400).json({ error: 'cerrar_mes debe ser 0 o 1' });
      campos.cerrar_mes = Number(cerrar_mes);
    }
    if (activo !== undefined) {
      if (![0, 1].includes(Number(activo)))
        return res.status(400).json({ error: 'activo debe ser 0 o 1' });
      campos.activo = Number(activo);
    }

    if (Object.keys(campos).length === 0)
      return res.status(400).json({ error: 'No se enviaron campos para actualizar' });

    const objetivo = await model.buscarUsuarioPorId(id);
    if (!objetivo) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (objetivo.rol === 'admin' && objetivo.activo === 1) {
      if (campos.rol === 'empleado' || campos.activo === 0) {
        const totalAdmins = await model.contarAdminsActivos();
        if (totalAdmins === 1)
          return res.status(400).json({ error: 'No podes desactivar o degradar al ultimo admin activo' });
      }
    }

    if (campos.activo === 0 && id === req.usuario.id)
      return res.status(400).json({ error: 'No podes desactivarte a vos mismo' });

    await model.actualizarUsuario(id, campos);

    if (campos.activo === 0) {
      await model.borrarSesionesDeUsuario(id);
    }

    const actualizado = await model.buscarUsuarioPorId(id);
    res.json(actualizado);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reset-password', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { password } = req.body || {};

    if (!password || String(password).length < 6)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

    const objetivo = await model.buscarUsuarioPorId(id);
    if (!objetivo) return res.status(404).json({ error: 'Usuario no encontrado' });

    const password_hash = await bcrypt.hash(String(password), 10);
    await model.resetearPassword(id, password_hash);
    await model.borrarSesionesDeUsuario(id);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
