(function () {
  const alertBox = document.getElementById('alert-box');
  const formUsuario = document.getElementById('form-usuario');
  const tabla = document.getElementById('tabla-usuarios');

  async function init() {
    bindForm();
    await cargarUsuarios();
  }

  async function cargarUsuarios() {
    try {
      const usuarios = await NovaAPI.get('/usuarios');
      renderTabla(usuarios);
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar usuarios: ' + err.message);
    }
  }

  function renderTabla(usuarios) {
    if (!usuarios.length) {
      tabla.innerHTML = '<tr><td colspan="8" class="empty">No hay usuarios registrados.</td></tr>';
      return;
    }

    tabla.innerHTML = usuarios.map(function (u) {
      return `
        <tr>
          <td><strong>${u.usuario}</strong></td>
          <td>
            <select class="inline-select" data-id="${u.id}" data-action="rol">
              <option value="empleado" ${u.rol === 'empleado' ? 'selected' : ''}>Empleado</option>
              <option value="admin" ${u.rol === 'admin' ? 'selected' : ''}>Administrador</option>
            </select>
          </td>
          <td style="text-align:center">
            <input type="checkbox" class="dashboard-check" data-id="${u.id}" ${u.ver_dashboard ? 'checked' : ''}>
          </td>
          <td style="text-align:center">
            <input type="checkbox" class="config-check" data-id="${u.id}" ${u.editar_config ? 'checked' : ''}>
          </td>
          <td style="text-align:center">
            <input type="checkbox" class="salud-check" data-id="${u.id}" ${u.ver_salud ? 'checked' : ''}>
          </td>
          <td style="text-align:center">
            <input type="checkbox" class="cierre-check" data-id="${u.id}" ${u.cerrar_mes ? 'checked' : ''}>
          </td>
          <td style="text-align:center">
            <input type="checkbox" class="pagos-check" data-id="${u.id}" ${u.confirmar_pagos ? 'checked' : ''}>
          </td>
          <td>
            <div class="estado-cell">
              <span class="badge ${u.activo ? 'badge-liquidado' : 'badge-pendiente'}">${u.activo ? 'Activo' : 'Inactivo'}</span>
              <button class="btn btn-sm ${u.activo ? 'btn-danger' : 'btn-secondary'} toggle-activo"
                      data-id="${u.id}" data-activo="${u.activo ? 1 : 0}">
                ${u.activo ? 'Desactivar' : 'Activar'}
              </button>
            </div>
          </td>
          <td>
            <div class="actions-cell">
              <button class="btn btn-sm btn-secondary reset-pwd" data-id="${u.id}" data-usuario="${u.usuario}">
                Resetear contraseña
              </button>
            </div>
          </td>
        </tr>`;
    }).join('');

    tabla.querySelectorAll('select[data-action="rol"]').forEach(function (sel) {
      sel.addEventListener('change', async function () {
        var id = sel.dataset.id;
        try {
          await NovaAPI.patch('/usuarios/' + id, { rol: sel.value });
          await cargarUsuarios();
        } catch (err) {
          NovaUtils.showAlert(alertBox, err.message);
          await cargarUsuarios();
        }
      });
    });

    tabla.querySelectorAll('input.dashboard-check').forEach(function (cb) {
      cb.addEventListener('change', async function () {
        var id = cb.dataset.id;
        try {
          await NovaAPI.patch('/usuarios/' + id, { ver_dashboard: cb.checked ? 1 : 0 });
          await cargarUsuarios();
        } catch (err) {
          NovaUtils.showAlert(alertBox, err.message);
          await cargarUsuarios();
        }
      });
    });

    tabla.querySelectorAll('input.config-check').forEach(function (cb) {
      cb.addEventListener('change', async function () {
        var id = cb.dataset.id;
        try {
          await NovaAPI.patch('/usuarios/' + id, { editar_config: cb.checked ? 1 : 0 });
          await cargarUsuarios();
        } catch (err) {
          NovaUtils.showAlert(alertBox, err.message);
          await cargarUsuarios();
        }
      });
    });

    tabla.querySelectorAll('input.pagos-check').forEach(function (cb) {
      cb.addEventListener('change', async function () {
        var id = cb.dataset.id;
        try {
          await NovaAPI.patch('/usuarios/' + id, { confirmar_pagos: cb.checked ? 1 : 0 });
          await cargarUsuarios();
        } catch (err) {
          NovaUtils.showAlert(alertBox, err.message);
          await cargarUsuarios();
        }
      });
    });

    tabla.querySelectorAll('input.cierre-check').forEach(function (cb) {
      cb.addEventListener('change', async function () {
        var id = cb.dataset.id;
        try {
          await NovaAPI.patch('/usuarios/' + id, { cerrar_mes: cb.checked ? 1 : 0 });
          await cargarUsuarios();
        } catch (err) {
          NovaUtils.showAlert(alertBox, err.message);
          await cargarUsuarios();
        }
      });
    });

    tabla.querySelectorAll('input.salud-check').forEach(function (cb) {
      cb.addEventListener('change', async function () {
        var id = cb.dataset.id;
        try {
          await NovaAPI.patch('/usuarios/' + id, { ver_salud: cb.checked ? 1 : 0 });
          await cargarUsuarios();
        } catch (err) {
          NovaUtils.showAlert(alertBox, err.message);
          await cargarUsuarios();
        }
      });
    });

    tabla.querySelectorAll('button.toggle-activo').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = btn.dataset.id;
        var nuevoActivo = btn.dataset.activo === '1' ? 0 : 1;
        try {
          await NovaAPI.patch('/usuarios/' + id, { activo: nuevoActivo });
          await cargarUsuarios();
        } catch (err) {
          NovaUtils.showAlert(alertBox, err.message);
          await cargarUsuarios();
        }
      });
    });

    tabla.querySelectorAll('button.reset-pwd').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = btn.dataset.id;
        var usuario = btn.dataset.usuario;
        // Campo de contraseña en la misma fila (29/09/2026): con prompt() la contraseña
        // quedaba escrita a la vista en el cuadro del navegador.
        if (btn.nextElementSibling && btn.nextElementSibling.classList.contains('pwd-inline')) return;
        var caja = document.createElement('span');
        caja.className = 'pwd-inline';
        caja.innerHTML = '<input type="password" autocomplete="new-password" placeholder="Nueva contraseña (mín. 6)">'
          + '<button type="button" class="btn btn-sm btn-primary">Guardar</button>'
          + '<button type="button" class="btn btn-sm btn-secondary">Cancelar</button>';
        btn.after(caja);
        btn.style.display = 'none';
        var input = caja.querySelector('input');
        var cerrar = function () { caja.remove(); btn.style.display = ''; };
        input.focus();
        caja.querySelectorAll('button')[1].addEventListener('click', cerrar);
        var guardar = async function () {
          var nueva = input.value;
          if (nueva.length < 6) {
            NovaUtils.showAlert(alertBox, 'La contraseña de "' + usuario + '" debe tener al menos 6 caracteres.');
            input.focus();
            return;
          }
          try {
            await NovaAPI.post('/usuarios/' + id + '/reset-password', { password: nueva });
            NovaUtils.showAlert(alertBox, 'Contraseña de "' + usuario + '" cambiada.', 'success');
            cerrar();
          } catch (err) {
            NovaUtils.showAlert(alertBox, err.message);
          }
        };
        caja.querySelectorAll('button')[0].addEventListener('click', guardar);
        input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') guardar(); if (ev.key === 'Escape') cerrar(); });
      });
    });
  }

  function bindForm() {
    formUsuario.addEventListener('submit', async function (e) {
      e.preventDefault();
      var data = {
        usuario: document.getElementById('u-usuario').value.trim(),
        password: document.getElementById('u-password').value,
        rol: document.getElementById('u-rol').value,
        ver_dashboard: document.getElementById('u-ver-dashboard').checked ? 1 : 0,
        editar_config: document.getElementById('u-editar-config').checked ? 1 : 0,
        ver_salud: document.getElementById('u-ver-salud').checked ? 1 : 0,
        cerrar_mes: document.getElementById('u-cerrar-mes').checked ? 1 : 0,
        confirmar_pagos: document.getElementById('u-confirmar-pagos').checked ? 1 : 0,
      };
      try {
        await NovaAPI.post('/usuarios', data);
        NovaUtils.showAlert(alertBox, 'Usuario creado correctamente.', 'success');
        formUsuario.reset();
        await cargarUsuarios();
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      }
    });
  }

  init();
})();
