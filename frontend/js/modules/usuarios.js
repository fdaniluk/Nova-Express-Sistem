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
      tabla.innerHTML = '<tr><td colspan="5" class="empty">No hay usuarios registrados.</td></tr>';
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
        var nueva = prompt('Nueva contraseña para "' + usuario + '" (mínimo 6 caracteres):');
        if (nueva === null) return;
        if (nueva.length < 6) {
          NovaUtils.showAlert(alertBox, 'La contraseña debe tener al menos 6 caracteres.');
          return;
        }
        try {
          await NovaAPI.post('/usuarios/' + id + '/reset-password', { password: nueva });
          NovaUtils.showAlert(alertBox, 'Contraseña reseteada correctamente.', 'success');
        } catch (err) {
          NovaUtils.showAlert(alertBox, err.message);
        }
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
