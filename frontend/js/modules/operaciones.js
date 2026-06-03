(function () {
  const alertBox = document.getElementById('alert-box');
  const opsList = document.getElementById('ops-list');
  const dateLabel = document.getElementById('date-label');
  const subtitleEl = document.getElementById('subtitle-ops');
  const datePicker = document.getElementById('date-picker');

  let fechaActual = new Date();
  fechaActual.setHours(0, 0, 0, 0);
  let envios = [];
  let pickupsDelDia = [];

  // ── Helpers de fecha ──────────────────────────────────

  function toYMD(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatearFechaTitulo(d) {
    return d.toLocaleDateString('es-AR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }

  // ── Cargar día ────────────────────────────────────────

  async function cargarDia(fecha) {
    try {
      const data = await NovaAPI.operaciones.delDia(toYMD(fecha));
      envios = data.envios || [];
      pickupsDelDia = data.pickups || [];
      actualizarHeader();
      renderLista();
    } catch (e) {
      NovaUtils.showAlert(alertBox, 'Error al cargar operaciones: ' + e.message);
    }
  }

  function actualizarHeader() {
    dateLabel.textContent = formatearFechaTitulo(fechaActual);
    datePicker.value = toYMD(fechaActual);

    const pendientes = pickupsDelDia.filter((p) => p.estado !== 'recolectado').length;
    const partes = [`${envios.length} envío${envios.length !== 1 ? 's' : ''}`];
    if (pendientes > 0) partes.push(`${pendientes} pickup${pendientes !== 1 ? 's' : ''} pendiente${pendientes !== 1 ? 's' : ''}`);
    subtitleEl.textContent = partes.join(' · ');
  }

  // ── Pickups standalone (sin envíos para ese cliente ese día) ──

  function getStandalonePickups() {
    const clientesConEnvio = new Set(envios.map((e) => e.cliente_id));
    return pickupsDelDia.filter((p) => !clientesConEnvio.has(p.cliente_id));
  }

  // ── Render lista ──────────────────────────────────────

  function renderLista() {
    const standalone = getStandalonePickups();
    const pickupPorCliente = {};
    pickupsDelDia.forEach((p) => { pickupPorCliente[p.cliente_id] = p; });

    const standalonesPendientes = standalone
      .filter((p) => p.estado !== 'recolectado')
      .sort((a, b) => a.hora_inicio.localeCompare(b.hora_inicio));

    const standalonesRecolectados = standalone
      .filter((p) => p.estado === 'recolectado')
      .sort((a, b) => a.cliente_nombre.localeCompare(b.cliente_nombre));

    const enviosActivos = envios
      .filter((e) => e.estado_operativo !== 'despachado')
      .sort((a, b) => a.cliente_nombre.localeCompare(b.cliente_nombre));

    const enviosDespachados = envios
      .filter((e) => e.estado_operativo === 'despachado')
      .sort((a, b) => a.cliente_nombre.localeCompare(b.cliente_nombre));

    if (!standalonesPendientes.length && !standalonesRecolectados.length && !envios.length) {
      opsList.innerHTML = '<div class="ops-empty">No hay envíos ni pickups registrados para este día.</div>';
      return;
    }

    const partes = [
      ...standalonesPendientes.map((p) => renderCardPickupStandalone(p)),
      ...standalonesRecolectados.map((p) => renderCardPickupStandalone(p)),
      ...enviosActivos.map((e) => renderCardEnvio(e, pickupPorCliente[e.cliente_id] || null)),
      ...enviosDespachados.map((e) => renderCardEnvio(e, pickupPorCliente[e.cliente_id] || null)),
    ];

    opsList.innerHTML = partes.join('');
    bindCheckboxes();
    bindConfirmarPickups();
  }

  // ── Cards de envío ────────────────────────────────────

  function renderCardEnvio(envio, pickup) {
    const esDespachado = envio.estado_operativo === 'despachado';
    return `<div class="envio-card${esDespachado ? ' despachado' : ''}" data-envio-id="${envio.id}">
      ${buildHeaderEnvio(envio, pickup)}
      <div class="envio-card-body">
        <div class="envio-card-info">
          <div class="envio-card-cliente">${escHtml(envio.cliente_nombre)}</div>
          <div class="envio-card-guia">${escHtml(envio.numero_guia)}</div>
          <div class="envio-card-pais">${escHtml(envio.pais)}</div>
        </div>
        <div class="envio-card-checks">
          ${renderCheck('envio', envio.id, 'check_datos', envio.check_datos, 'Datos completos')}
          ${renderCheck('envio', envio.id, 'check_guia', envio.check_guia, 'Guía aérea')}
          ${renderCheck('envio', envio.id, 'check_proforma', envio.check_proforma, 'Proforma')}
          ${renderCheck('envio', envio.id, 'check_despachado', envio.check_despachado, 'Despachado')}
        </div>
      </div>
    </div>`;
  }

  function buildHeaderEnvio(envio, pickup) {
    if (envio.estado_operativo === 'despachado') {
      return `<div class="envio-card-header header-despachado"><span>✓ Despachado</span></div>`;
    }
    if (pickup && pickup.estado !== 'recolectado') {
      return `<div class="envio-card-header pickup-pendiente">
        <span>🕐 Pickup pendiente · ${escHtml(pickup.hora_inicio)}–${escHtml(pickup.hora_fin)}</span>
        <button class="btn-confirmar-pickup" data-pickup-id="${pickup.id}" data-contexto="envio">
          ✓ Confirmar recolección
        </button>
      </div>`;
    }
    if (pickup && pickup.estado === 'recolectado') {
      return `<div class="envio-card-header en-deposito"><span>🏭 En depósito · recolectado</span></div>`;
    }
    return `<div class="envio-card-header en-deposito"><span>🏭 En depósito · ingreso directo</span></div>`;
  }

  // ── Cards de pickup standalone ────────────────────────

  function renderCardPickupStandalone(pickup) {
    const esPendiente = pickup.estado !== 'recolectado';
    const headerHtml = esPendiente
      ? `<div class="envio-card-header pickup-pendiente">
           <span>🕐 Pickup pendiente · ${escHtml(pickup.hora_inicio)}–${escHtml(pickup.hora_fin)}</span>
           <button class="btn-confirmar-pickup" data-pickup-id="${pickup.id}" data-contexto="standalone">
             ✓ Confirmar recolección
           </button>
         </div>`
      : `<div class="envio-card-header en-deposito"><span>🏭 En depósito · recolectado</span></div>`;

    return `<div class="envio-card standalone-pickup" data-pickup-id="${pickup.id}">
      ${headerHtml}
      <div class="envio-card-body">
        <div class="envio-card-info">
          <div class="envio-card-cliente">${escHtml(pickup.cliente_nombre)}</div>
          <div class="envio-card-guia" style="color:var(--color-muted)">📍 ${escHtml(pickup.direccion)}</div>
        </div>
        <div class="envio-card-checks">
          ${renderCheck('pickup', pickup.id, 'check_datos', pickup.check_datos, 'Datos completos')}
          ${renderCheck('pickup', pickup.id, 'check_guia', pickup.check_guia, 'Guía aérea')}
          ${renderCheck('pickup', pickup.id, 'check_proforma', pickup.check_proforma, 'Proforma')}
          ${renderCheck('pickup', pickup.id, 'check_despachado', pickup.check_despachado, 'Despachado')}
        </div>
      </div>
    </div>`;
  }

  // ── Helpers de render ─────────────────────────────────

  function renderCheck(tipo, itemId, campo, valor, label) {
    const checked = Number(valor) === 1 ? 'checked' : '';
    return `<label class="check-item">
      <input type="checkbox" ${checked}
        data-tipo="${tipo}" data-item-id="${itemId}" data-campo="${campo}">
      ${escHtml(label)}
    </label>`;
  }

  // ── Bind checkboxes ───────────────────────────────────

  function bindCheckboxes() {
    opsList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        const tipo = cb.dataset.tipo;
        const itemId = cb.dataset.itemId;
        const campo = cb.dataset.campo;
        const valor = cb.checked ? 1 : 0;
        if (tipo === 'pickup') {
          await onCheckboxPickupChange(itemId, campo, valor, cb);
        } else {
          await onCheckboxEnvioChange(itemId, campo, valor, cb);
        }
      });
    });
  }

  async function onCheckboxEnvioChange(envioId, campo, valor, cb) {
    try {
      await NovaAPI.operaciones.actualizarEnvio(envioId, { [campo]: valor });
      const idx = envios.findIndex((e) => e.id === Number(envioId));
      if (idx >= 0) {
        envios[idx][campo] = valor;
        if (campo === 'check_despachado' && valor === 1) {
          envios[idx].estado_operativo = 'despachado';
        }
      }
      if (campo === 'check_despachado' && valor === 1) {
        renderLista();
      }
    } catch (e) {
      cb.checked = !cb.checked;
      NovaUtils.showAlert(alertBox, 'Error al guardar: ' + e.message);
    }
  }

  async function onCheckboxPickupChange(pickupId, campo, valor, cb) {
    try {
      await NovaAPI.operaciones.actualizarPickup(pickupId, { [campo]: valor });
      const idx = pickupsDelDia.findIndex((p) => p.id === Number(pickupId));
      if (idx >= 0) pickupsDelDia[idx][campo] = valor;
    } catch (e) {
      cb.checked = !cb.checked;
      NovaUtils.showAlert(alertBox, 'Error al guardar: ' + e.message);
    }
  }

  // ── Confirmar recolección ─────────────────────────────

  function bindConfirmarPickups() {
    opsList.querySelectorAll('.btn-confirmar-pickup').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const pickupId = Number(btn.dataset.pickupId);
        const contexto = btn.dataset.contexto;
        const pickup = pickupsDelDia.find((p) => p.id === pickupId);
        if (!confirm(`¿Confirmar recolección del pickup de ${pickup ? pickup.cliente_nombre : 'este cliente'}?`)) return;
        try {
          await NovaAPI.pickups.editar(pickupId, { estado: 'recolectado' });
          const idx = pickupsDelDia.findIndex((p) => p.id === pickupId);
          if (idx >= 0) pickupsDelDia[idx].estado = 'recolectado';

          // Si el pickup tiene envíos asociados, actualizar su estado_operativo
          if (contexto === 'envio' && pickup) {
            envios.forEach((e) => {
              if (e.cliente_id === pickup.cliente_id && e.estado_operativo === 'pendiente') {
                e.estado_operativo = 'en_deposito';
              }
            });
          }

          actualizarHeader();
          renderLista();
          NovaUtils.showAlert(alertBox, 'Recolección confirmada', 'success');
        } catch (e) {
          NovaUtils.showAlert(alertBox, 'Error: ' + e.message);
        }
      });
    });
  }

  // ── Navegación ────────────────────────────────────────

  function cambiarDia(delta) {
    fechaActual.setDate(fechaActual.getDate() + delta);
    cargarDia(fechaActual);
  }

  // ── Escaping ──────────────────────────────────────────

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Init ─────────────────────────────────────────────

  document.getElementById('btn-prev-day').addEventListener('click', () => cambiarDia(-1));
  document.getElementById('btn-next-day').addEventListener('click', () => cambiarDia(1));

  datePicker.addEventListener('change', () => {
    if (!datePicker.value) return;
    const [y, m, d] = datePicker.value.split('-').map(Number);
    fechaActual = new Date(y, m - 1, d);
    fechaActual.setHours(0, 0, 0, 0);
    cargarDia(fechaActual);
  });

  cargarDia(fechaActual);
})();
