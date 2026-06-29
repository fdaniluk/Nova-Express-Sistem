(function () {
  const alertBox = document.getElementById('alert-box');
  const formPanel = document.getElementById('form-panel');
  const formTitle = document.getElementById('form-title');
  const formCliente = document.getElementById('form-cliente');
  const clienteIdInput = document.getElementById('cliente-id');
  const tabla = document.getElementById('tabla-clientes');

  let clientes = [];
  let modoEdicion = false;

  async function init() {
    await cargarClientes();
    bindBtnNuevo();
    bindBtnCancelar();
    bindForm();
  }

  async function cargarClientes() {
    try {
      clientes = await NovaAPI.clientes.listar();
      renderTabla();
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar clientes: ' + err.message);
    }
  }

  function renderTabla() {
    if (!clientes.length) {
      tabla.innerHTML = '<tr><td colspan="9" class="empty">No hay clientes registrados.</td></tr>';
      return;
    }
    tabla.innerHTML = clientes
      .map(
        (c) => `
      <tr>
        <td>
          <a href="clientes-perfil.html?id=${c.id}" style="font-weight:500;color:var(--color-primary)">
            ${c.nombre}
          </a>
        </td>
        <td>${c.nombre_nova || '—'}</td>
        <td>${c.cuit || '—'}</td>
        <td>${c.contacto || '—'}</td>
        <td>${c.email || '—'}</td>
        <td>${NovaUtils.tipoCobroLabel(c.tipo_cobro)}</td>
        <td>${c.tarifa_pct != null ? c.tarifa_pct + '%' : '—'}</td>
        <td>${c.activo ? '<span class="badge badge-liquidado">Activo</span>' : '<span class="badge badge-pendiente">Inactivo</span>'}</td>
        <td>
          <div style="display:flex;gap:0.35rem">
            <button class="btn btn-sm btn-secondary" data-id="${c.id}" data-action="editar">Editar</button>
            <button class="btn btn-sm btn-danger" data-id="${c.id}" data-action="eliminar">Eliminar</button>
          </div>
        </td>
      </tr>`
      )
      .join('');

    tabla.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        if (btn.dataset.action === 'editar') abrirEdicion(id);
        else if (btn.dataset.action === 'eliminar') confirmarEliminar(id);
      });
    });
  }

  function bindBtnNuevo() {
    document.getElementById('btn-nuevo').addEventListener('click', () => {
      modoEdicion = false;
      formTitle.textContent = 'Nuevo cliente';
      limpiarForm();
      formPanel.classList.remove('hidden');
      formPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function bindBtnCancelar() {
    document.getElementById('btn-cancelar').addEventListener('click', () => {
      formPanel.classList.add('hidden');
      limpiarForm();
    });
  }

  function bindForm() {
    formCliente.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = getFormData();
      try {
        if (modoEdicion) {
          const id = clienteIdInput.value;
          await NovaAPI.clientes.actualizar(id, data);
          NovaUtils.showAlert(alertBox, 'Cliente actualizado correctamente', 'success');
        } else {
          await NovaAPI.clientes.crear(data);
          NovaUtils.showAlert(alertBox, 'Cliente creado correctamente', 'success');
        }
        formPanel.classList.add('hidden');
        limpiarForm();
        await cargarClientes();
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      }
    });
  }

  function abrirEdicion(id) {
    const c = clientes.find((x) => x.id === id);
    if (!c) return;
    modoEdicion = true;
    formTitle.textContent = 'Editar cliente';
    clienteIdInput.value = c.id;
    setField('f-razon_social', c.nombre);
    setField('f-nombre_nova', c.nombre_nova || '');
    setField('f-cuit', c.cuit || '');
    setField('f-tipo_cobro', c.tipo_cobro || 'CC');
    setField('f-tarifa_pct', c.tarifa_pct != null ? c.tarifa_pct : 0);
    setField('f-tipo_facturacion', c.tipo_facturacion || 'Responsable inscripto');
    setField('f-contacto', c.contacto || '');
    setField('f-email', c.email || '');
    setField('f-whatsapp', c.whatsapp || '');
    setField('f-codigo_postal', c.codigo_postal || '');
    setField('f-localidad', c.localidad || '');
    setField('f-direccion_recoleccion', c.direccion_recoleccion || '');
    formPanel.classList.remove('hidden');
    formPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function confirmarEliminar(id) {
    const c = clientes.find((x) => x.id === id);
    if (!c) return;
    if (!confirm(`¿Eliminar el cliente "${c.nombre}"? Esta acción no se puede deshacer.`)) return;
    try {
      await NovaAPI.clientes.eliminar(id);
      NovaUtils.showAlert(alertBox, 'Cliente eliminado', 'success');
      await cargarClientes();
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message);
    }
  }

  function getFormData() {
    return {
      razon_social: document.getElementById('f-razon_social').value.trim(),
      nombre_nova: document.getElementById('f-nombre_nova').value.trim() || null,
      cuit: document.getElementById('f-cuit').value.trim() || null,
      tipo_cobro: document.getElementById('f-tipo_cobro').value,
      tarifa_pct: parseFloat(document.getElementById('f-tarifa_pct').value) || 0,
      tipo_facturacion: document.getElementById('f-tipo_facturacion').value,
      contacto: document.getElementById('f-contacto').value.trim() || null,
      email: document.getElementById('f-email').value.trim() || null,
      whatsapp: document.getElementById('f-whatsapp').value.trim() || null,
      codigo_postal: document.getElementById('f-codigo_postal').value.trim() || null,
      localidad: document.getElementById('f-localidad').value.trim() || null,
      direccion_recoleccion: document.getElementById('f-direccion_recoleccion').value.trim() || null,
    };
  }

  function limpiarForm() {
    formCliente.reset();
    clienteIdInput.value = '';
  }

  function setField(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
  }

  init();
})();
