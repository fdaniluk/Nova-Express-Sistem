// Usuarios — estética del sistema (08/10/2026, ítem 6). Los permisos son chips: en el alta
// envuelven los checkbox de siempre (mismos ids), y en la lista se prenden y apagan con un
// click y se guardan al momento. Los endpoints no cambiaron.
(function () {
  const alertBox = document.getElementById('alert-box');
  const formUsuario = document.getElementById('form-usuario');
  const tabla = document.getElementById('tabla-usuarios');

  // Permisos del sistema: columna en la DB → etiqueta del chip.
  const PERMISOS = [
    ['ver_dashboard', 'Dashboard'],
    ['editar_config', 'Config'],
    ['ver_salud', 'Salud'],
    ['cerrar_mes', 'Cierre'],
    ['confirmar_pagos', 'Pagos'],
    ['ver_costos', 'Costos'],
  ];

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

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // "hoy 11:02", "ayer 18:40", "03/10/2026 09:15" o "nunca". La sesión se guarda en UTC.
  function ultimoAcceso(v) {
    if (!v) return '<span class="em">nunca</span>';
    const d = new Date(String(v).replace(' ', 'T') + (/(Z|[+-]\d{2}:?\d{2})$/.test(String(v)) ? '' : 'Z'));
    if (Number.isNaN(d.getTime())) return esc(v);
    const hora = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
    const hoy = new Date(); const ayer = new Date(); ayer.setDate(hoy.getDate() - 1);
    const mismoDia = (a, b) => a.toDateString() === b.toDateString();
    if (mismoDia(d, hoy)) return `hoy ${hora}`;
    if (mismoDia(d, ayer)) return `ayer ${hora}`;
    return `${d.toLocaleDateString('es-AR')} ${hora}`;
  }

  function renderTabla(usuarios) {
    const resumen = document.getElementById('usr-resumen');
    if (resumen) {
      const act = usuarios.filter((u) => u.activo).length;
      const inact = usuarios.length - act;
      resumen.textContent = `${act} activo${act === 1 ? '' : 's'}${inact ? ` · ${inact} inactivo${inact === 1 ? '' : 's'}` : ''}`;
      resumen.classList.toggle('hidden', usuarios.length === 0);
    }
    if (!usuarios.length) {
      tabla.innerHTML = '<tr><td colspan="6" class="empty">No hay usuarios registrados.</td></tr>';
      return;
    }

    tabla.innerHTML = usuarios.map(function (u) {
      const esAdmin = u.rol === 'admin';
      const permisos = esAdmin
        ? '<span class="em usr-todos">todos</span>'
        : `<div class="usr-perm-mini">${PERMISOS.map(([k, label]) => `<button type="button" class="usr-mini ${u[k] ? 'on' : ''}" data-id="${u.id}" data-permiso="${k}" title="${u[k] ? 'Quitar' : 'Dar'} permiso: ${label}">${label}</button>`).join('')}</div>`;
      return `
        <tr class="${u.activo ? '' : 'usr-inactivo'}">
          <td><strong>${esc(u.usuario)}</strong></td>
          <td>
            <select class="inline-select" data-id="${u.id}" data-action="rol" ${u.activo ? '' : 'disabled'}>
              <option value="empleado" ${u.rol === 'empleado' ? 'selected' : ''}>Empleado</option>
              <option value="admin" ${u.rol === 'admin' ? 'selected' : ''}>Administrador</option>
            </select>
          </td>
          <td>${permisos}</td>
          <td class="usr-acceso">${ultimoAcceso(u.ultimo_acceso)}</td>
          <td><span class="usr-chip ${u.activo ? 'usr-chip-ok' : 'usr-chip-gris'}">${u.activo ? 'activo' : 'inactivo'}</span></td>
          <td>
            <div class="actions-cell">
              ${u.activo ? `<button class="btn btn-sm btn-outline reset-pwd" data-id="${u.id}" data-usuario="${esc(u.usuario)}">Resetear contraseña</button>` : ''}
              <button class="btn btn-sm ${u.activo ? 'btn-outline btn-outline-rojo' : 'btn-outline'} toggle-activo"
                      data-id="${u.id}" data-activo="${u.activo ? 1 : 0}">
                ${u.activo ? 'Desactivar' : 'Activar'}
              </button>
            </div>
          </td>
        </tr>`;
    }).join('');

    const patch = async (id, data) => {
      try {
        await NovaAPI.patch('/usuarios/' + id, data);
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      }
      await cargarUsuarios();
    };

    tabla.querySelectorAll('select[data-action="rol"]').forEach(function (sel) {
      sel.addEventListener('change', () => patch(sel.dataset.id, { rol: sel.value }));
    });

    // Chips de permiso: un click = PATCH del permiso al revés de como está.
    tabla.querySelectorAll('button.usr-mini').forEach(function (b) {
      b.addEventListener('click', () => patch(b.dataset.id, { [b.dataset.permiso]: b.classList.contains('on') ? 0 : 1 }));
    });

    tabla.querySelectorAll('button.toggle-activo').forEach(function (btn) {
      btn.addEventListener('click', () => patch(btn.dataset.id, { activo: btn.dataset.activo === '1' ? 0 : 1 }));
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
          + '<button type="button" class="btn btn-sm btn-coral">Guardar</button>'
          + '<button type="button" class="btn btn-sm btn-outline">Cancelar</button>';
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

  // El chip del alta se pinta según su checkbox (el :has() de CSS lo hace solo; esto es
  // el respaldo para navegadores viejos).
  function pintarChipsAlta() {
    document.querySelectorAll('#usr-permisos-alta .usr-perm').forEach((l) => {
      const cb = l.querySelector('input[type="checkbox"]');
      l.classList.toggle('on', Boolean(cb && cb.checked));
    });
  }

  function bindForm() {
    document.querySelectorAll('#usr-permisos-alta input[type="checkbox"]').forEach((cb) => cb.addEventListener('change', pintarChipsAlta));
    formUsuario.addEventListener('reset', () => setTimeout(pintarChipsAlta, 0));
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
        ver_costos: document.getElementById('u-ver-costos').checked ? 1 : 0,
      };
      try {
        await NovaAPI.post('/usuarios', data);
        NovaUtils.showAlert(alertBox, 'Usuario creado correctamente.', 'success');
        formUsuario.reset();
        pintarChipsAlta();
        await cargarUsuarios();
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      }
    });
  }

  init();
})();
