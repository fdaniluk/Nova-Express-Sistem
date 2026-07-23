(function () {
  const alertBox = document.getElementById('alert-box');
  const tabla = document.getElementById('tabla-cobranzas');
  const totalArsEl = document.getElementById('total-ars');
  const totalUsdEl = document.getElementById('total-usd');
  const desgloseArsEl = document.getElementById('desglose-ars');
  const desgloseUsdEl = document.getElementById('desglose-usd');

  const filtroCliente = document.getElementById('f-cliente');
  const filtroDesde = document.getElementById('f-desde');
  const filtroHasta = document.getElementById('f-hasta');

  const formPanel = document.getElementById('form-panel');
  const formTitle = document.getElementById('form-title');
  const formEl = document.getElementById('form-cobranza-el');
  const cobranzaIdInput = document.getElementById('cobranza-id');
  const selCliente = document.getElementById('c-cliente');

  const fmtArs = new Intl.NumberFormat('es-AR', {
    style: 'currency', currency: 'ARS', minimumFractionDigits: 2,
  });
  const fmtUsd = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

  const FORMAS = {
    efectivo: 'Efectivo',
    cheque: 'Cheque',
    transferencia: 'Transferencia',
    otro: 'Otro',
  };

  let cobranzas = [];
  let clientes = [];
  let modoEdicion = false;

  function hoyISO() {
    const d = new Date();
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  }

  function inicioMesISO() {
    return hoyISO().slice(0, 8) + '01';
  }

  function nombreCliente(c) {
    return c.nombre_nova || c.nombre || `Cliente #${c.id}`;
  }

  async function init() {
    filtroDesde.value = inicioMesISO();
    filtroHasta.value = hoyISO();
    document.getElementById('c-fecha').value = hoyISO();

    await cargarClientes();
    await cargarCobranzas();

    document.getElementById('btn-filtrar').addEventListener('click', cargarCobranzas);
    document.getElementById('btn-limpiar').addEventListener('click', limpiarFiltros);
    document.getElementById('btn-nueva').addEventListener('click', abrirNueva);
    document.getElementById('btn-cancelar').addEventListener('click', cerrarForm);
    formEl.addEventListener('submit', guardar);
  }

  async function cargarClientes() {
    try {
      clientes = await NovaAPI.clientes.listar();
      clientes.sort((a, b) => nombreCliente(a).localeCompare(nombreCliente(b)));
      const opts = clientes
        .map((c) => `<option value="${c.id}">${nombreCliente(c)}</option>`)
        .join('');
      filtroCliente.insertAdjacentHTML('beforeend', opts);
      selCliente.insertAdjacentHTML('beforeend', opts);
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar clientes: ' + err.message);
    }
  }

  async function cargarCobranzas() {
    const filtros = {
      cliente_id: filtroCliente.value || undefined,
      desde: filtroDesde.value || undefined,
      hasta: filtroHasta.value || undefined,
    };
    try {
      const res = await NovaAPI.cobranzas.listar(filtros);
      cobranzas = res.cobranzas || [];
      renderResumen(res.resumen || { total_ars: 0, total_usd: 0 });
      renderTabla();
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar cobranzas: ' + err.message);
    }
  }

  function renderResumen(resumen) {
    totalArsEl.textContent = fmtArs.format(resumen.total_ars || 0);
    totalUsdEl.textContent = 'US$' + fmtUsd.format(resumen.total_usd || 0);
    renderDesglose();
  }

  // Desglose por forma de pago dentro de cada moneda, calculado en el frontend
  // a partir de la lista ya cargada. Nunca mezcla ARS con USD.
  function renderDesglose() {
    desgloseArsEl.innerHTML = desgloseHtml('ARS');
    desgloseUsdEl.innerHTML = desgloseHtml('USD');
  }

  function desgloseHtml(moneda) {
    const totales = { efectivo: 0, cheque: 0, transferencia: 0, otro: 0 };
    for (const c of cobranzas) {
      if (c.moneda !== moneda) continue;
      const forma = totales.hasOwnProperty(c.forma_pago) ? c.forma_pago : 'otro';
      totales[forma] += Number(c.monto) || 0;
    }

    const items = Object.keys(FORMAS)
      .filter((forma) => totales[forma] > 0)
      .map(
        (forma) =>
          `<span class="dg-item"><span class="dg-label">${FORMAS[forma]}</span> ` +
          `<span class="dg-monto">${formatMonto(totales[forma], moneda)}</span></span>`
      );

    if (!items.length) {
      desgloseElVacio(moneda);
      return 'Sin cobranzas';
    }
    desgloseElNoVacio(moneda);
    return items.join('<span class="dg-sep">·</span>');
  }

  function desgloseElVacio(moneda) {
    (moneda === 'USD' ? desgloseUsdEl : desgloseArsEl).classList.add('vacio');
  }

  function desgloseElNoVacio(moneda) {
    (moneda === 'USD' ? desgloseUsdEl : desgloseArsEl).classList.remove('vacio');
  }

  function formatMonto(monto, moneda) {
    return moneda === 'USD'
      ? 'US$' + fmtUsd.format(monto || 0)
      : fmtArs.format(monto || 0);
  }

  function renderTabla() {
    if (!cobranzas.length) {
      tabla.innerHTML = '<tr><td colspan="8" class="empty">No hay cobranzas en el período seleccionado.</td></tr>';
      return;
    }
    tabla.innerHTML = cobranzas
      .map(
        (c) => `
      <tr>
        <td>${NovaUtils.formatDate(c.fecha)}</td>
        <td>${c.cliente_nombre || '—'}</td>
        <td>${formatMonto(c.monto, c.moneda)}</td>
        <td>${c.moneda}</td>
        <td>${FORMAS[c.forma_pago] || c.forma_pago || '—'}</td>
        <td>${c.pickup_id ? '<span class="badge badge-liquidado">Pickup</span>' : '<span class="badge badge-pendiente">Directa</span>'}</td>
        <td>${c.nota ? escapeHtml(c.nota) : '—'}</td>
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

  function limpiarFiltros() {
    filtroCliente.value = '';
    filtroDesde.value = inicioMesISO();
    filtroHasta.value = hoyISO();
    cargarCobranzas();
  }

  function abrirNueva() {
    modoEdicion = false;
    formTitle.textContent = 'Nueva cobranza';
    formEl.reset();
    cobranzaIdInput.value = '';
    document.getElementById('c-fecha').value = hoyISO();
    document.getElementById('c-moneda').value = 'ARS';
    document.getElementById('c-forma_pago').value = 'efectivo';
    formPanel.classList.remove('hidden');
    formPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function abrirEdicion(id) {
    const c = cobranzas.find((x) => x.id === id);
    if (!c) return;
    modoEdicion = true;
    formTitle.textContent = 'Editar cobranza';
    cobranzaIdInput.value = c.id;
    selCliente.value = c.cliente_id;
    document.getElementById('c-fecha').value = String(c.fecha).slice(0, 10);
    document.getElementById('c-monto').value = c.monto;
    document.getElementById('c-moneda').value = c.moneda || 'ARS';
    document.getElementById('c-forma_pago').value = c.forma_pago || 'efectivo';
    document.getElementById('c-nota').value = c.nota || '';
    formPanel.classList.remove('hidden');
    formPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function cerrarForm() {
    formPanel.classList.add('hidden');
    formEl.reset();
    cobranzaIdInput.value = '';
  }

  function getFormData() {
    return {
      cliente_id: Number(selCliente.value),
      fecha: document.getElementById('c-fecha').value,
      monto: parseFloat(document.getElementById('c-monto').value),
      moneda: document.getElementById('c-moneda').value,
      forma_pago: document.getElementById('c-forma_pago').value,
      nota: document.getElementById('c-nota').value.trim() || null,
    };
  }

  async function guardar(e) {
    e.preventDefault();
    const data = getFormData();
    if (!data.cliente_id) {
      NovaUtils.showAlert(alertBox, 'Seleccioná un cliente.');
      return;
    }
    if (!(data.monto > 0)) {
      NovaUtils.showAlert(alertBox, 'El monto debe ser mayor a 0.');
      return;
    }
    try {
      if (modoEdicion) {
        await NovaAPI.cobranzas.actualizar(cobranzaIdInput.value, data);
        NovaUtils.showAlert(alertBox, 'Cobranza actualizada correctamente', 'success');
      } else {
        await NovaAPI.cobranzas.crear(data);
        NovaUtils.showAlert(alertBox, 'Cobranza registrada correctamente', 'success');
      }
      cerrarForm();
      await cargarCobranzas();
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message);
    }
  }

  async function confirmarEliminar(id) {
    const c = cobranzas.find((x) => x.id === id);
    if (!c) return;
    if (!confirm(`¿Eliminar la cobranza de ${c.cliente_nombre || 'cliente'} por ${formatMonto(c.monto, c.moneda)}? Esta acción no se puede deshacer.`)) return;
    try {
      await NovaAPI.cobranzas.eliminar(id);
      NovaUtils.showAlert(alertBox, 'Cobranza eliminada', 'success');
      await cargarCobranzas();
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  init();
})();
