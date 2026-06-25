(function () {
  const alertBox = document.getElementById('alert-box');
  const opsList = document.getElementById('ops-list');
  const dateLabel = document.getElementById('date-label');
  const subtitleEl = document.getElementById('subtitle-ops');
  const datePicker = document.getElementById('date-picker');

  let fechaActual = new Date();
  fechaActual.setHours(0, 0, 0, 0);
  let pickupsDelDia = [];
  let rezagados = [];
  let cuadrantes = [];
  let cuadrantesRezagados = [];

  // ── Helpers de fecha ──────────────────────────────────

  function toYMD(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatDDMM(ymd) {
    if (!ymd) return '';
    const [, m, d] = String(ymd).split('-');
    return `${d}/${m}`;
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
      pickupsDelDia = data.pickups || [];
      rezagados = data.rezagados || [];
      cuadrantes = data.cuadrantes || [];
      cuadrantesRezagados = data.cuadrantes_rezagados || [];
      actualizarHeader();
      renderLista();
    } catch (e) {
      NovaUtils.showAlert(alertBox, 'Error al cargar operaciones: ' + e.message);
    }
  }

  function actualizarHeader() {
    dateLabel.textContent = formatearFechaTitulo(fechaActual);
    datePicker.value = toYMD(fechaActual);

    const total = pickupsDelDia.length;
    const pendientes = pickupsDelDia.filter((p) => estadoPickup(p) !== 'dep').length;
    const partes = [`${total} pickup${total !== 1 ? 's' : ''}`];
    if (pendientes > 0) partes.push(`${pendientes} pendiente${pendientes !== 1 ? 's' : ''}`);
    subtitleEl.textContent = partes.join(' · ');
  }

  function estadoPickup(p) {
    // Tipos especiales: 'cliente' y 'courier' se muestran en gris, fuera de la
    // cadena de chofer. El 'normal' deriva exactamente como antes.
    const tipo = p.tipo_recoleccion || 'normal';
    if (tipo === 'cliente' || tipo === 'courier') return 'gris';
    if (p.en_deposito_at || p.estado === 'en_deposito') return 'dep';
    if (p.confirmado_juanqui || p.estado === 'en_camioneta') return 'cam';
    return 'pend';
  }

  // Un pickup despachado se saca de su sección de origen y baja a la sección
  // verde "Despachado", sin importar su estadoPickup (gris/dep/cam/pend).
  function pickupDespachado(p) {
    return Number(p.check_despachado) === 1;
  }

  // ── Render lista ──────────────────────────────────────

  function renderLista() {
    // Operaciones ahora muestra SOLO pickups. Todos los pickups del día se
    // renderizan como cards de pickup (ya no hay envíos que los "absorban").
    // Los despachados se separan ANTES de la sectorización normal y bajan a la
    // sección verde "Despachado".
    const pickupsDespachados = pickupsDelDia
      .filter((p) => pickupDespachado(p))
      .sort((a, b) => a.cliente_nombre.localeCompare(b.cliente_nombre));

    const pickupsPendientes = pickupsDelDia
      .filter((p) => !pickupDespachado(p) && estadoPickup(p) !== 'dep')
      .sort((a, b) => a.hora_inicio.localeCompare(b.hora_inicio));

    const pickupsDeposito = pickupsDelDia
      .filter((p) => !pickupDespachado(p) && estadoPickup(p) === 'dep')
      .sort((a, b) => a.cliente_nombre.localeCompare(b.cliente_nombre));

    if (
      !pickupsPendientes.length &&
      !pickupsDeposito.length &&
      !pickupsDespachados.length &&
      !rezagados.length &&
      !cuadrantesRezagados.length
    ) {
      opsList.innerHTML = '<div class="ops-empty">No hay pickups registrados para este día.</div>';
      return;
    }

    // Cada pickup se renderiza con sus cuadrantes pegados debajo (matcheados por
    // pickup_id). Para rezagados la fuente de cuadrantes es cuadrantesRezagados.
    const renderPickupConCuadrantes = (p, esRezagado) =>
      renderCardPickupStandalone(p, esRezagado) +
      cuadrantesDePickup(p.id, esRezagado).map((q) => renderCardCuadrante(q, esRezagado)).join('');

    const partes = [
      ...pickupsPendientes.map((p) => renderPickupConCuadrantes(p, false)),
      ...pickupsDeposito.map((p) => renderPickupConCuadrantes(p, false)),
      ...pickupsDespachados.map((p) => renderPickupConCuadrantes(p, false)),
    ];

    let html = partes.join('');

    // Sección de rezagados (arrastre visual de días anteriores), debajo de lo de
    // hoy. Los rezagados ahora son PICKUPS y se renderizan igual que los del día.
    if (rezagados.length || cuadrantesRezagados.length) {
      const rezOrdenados = rezagados
        .slice()
        .sort((a, b) =>
          a.fecha === b.fecha
            ? a.cliente_nombre.localeCompare(b.cliente_nombre)
            : a.fecha.localeCompare(b.fecha)
        );
      const totalRezagados = rezOrdenados.length + cuadrantesRezagados.length;
      html += `<div class="ops-rezagados-header">
        <span>Pendientes de días anteriores</span>
        <span class="ops-rezagados-count">${totalRezagados}</span>
      </div>`;
      html += rezOrdenados.map((p) => renderPickupConCuadrantes(p, true)).join('');
      // Cuadrantes rezagados que no cuelgan de ningún pickup rezagado mostrado
      // (su pickup ya fue despachado) se renderizan sueltos para no perderlos.
      const idsRezagados = new Set(rezOrdenados.map((p) => p.id));
      const cuadrantesSueltos = cuadrantesRezagados.filter((q) => !idsRezagados.has(q.pickup_id));
      html += cuadrantesSueltos.map((q) => renderCardCuadrante(q, true)).join('');
    }

    opsList.innerHTML = html;
    bindCheckboxes();
    bindCuadranteAcciones();
  }

  // Cuadrantes que cuelgan de un pickup dado, por pickup_id. Para los rezagados
  // la fuente es cuadrantesRezagados; para el día, los cuadrantes de hoy.
  function cuadrantesDePickup(pickupId, esRezagado) {
    const fuente = esRezagado ? cuadrantesRezagados : cuadrantes;
    return fuente
      .filter((q) => q.pickup_id === pickupId)
      .sort((a, b) => (a.titulo || '').localeCompare(b.titulo || '') || a.id - b.id);
  }

  // ── Cards de cuadrante (envío manual colgado de un pickup origen) ──

  function renderCardCuadrante(cuadrante, esRezagado) {
    const clases = `envio-card cuadrante-card${esRezagado ? ' rezagado' : ''}`;
    const badgeRezagado = esRezagado
      ? `<div class="envio-card-rezagado-badge">cargado el ${formatDDMM(cuadrante.fecha)}</div>`
      : '';
    return `<div class="${clases}" data-cuadrante-id="${cuadrante.id}">
      <div class="envio-card-body">
        <div class="envio-card-info">
          <div class="cuadrante-top">
            <span class="cuadrante-badge">cuadrante</span>
            <span class="envio-card-cliente">${escHtml(cuadrante.cliente_nombre)}</span>
          </div>
          <input type="text" class="cuadrante-titulo-input" placeholder="Título…"
            value="${escHtml(cuadrante.titulo || '')}" data-cuadrante-titulo="${cuadrante.id}">
          ${badgeRezagado}
        </div>
        <div class="envio-card-checks">
          ${renderCheck('cuadrante', cuadrante.id, 'check_datos', cuadrante.check_datos, 'Datos completos')}
          ${renderCheck('cuadrante', cuadrante.id, 'check_guia', cuadrante.check_guia, 'Guía aérea')}
          ${renderCheck('cuadrante', cuadrante.id, 'check_proforma', cuadrante.check_proforma, 'Proforma')}
          ${renderCheck('cuadrante', cuadrante.id, 'check_despachado', cuadrante.check_despachado, 'Despachado')}
          <button type="button" class="btn-del-cuadrante" data-del-cuadrante="${cuadrante.id}">Borrar</button>
        </div>
      </div>
    </div>`;
  }

  // ── Cards de pickup standalone ────────────────────────

  function renderCardPickupStandalone(pickup, esRezagado) {
    const despachado = pickupDespachado(pickup);
    const sc = estadoPickup(pickup);
    let headerHtml;
    if (despachado) {
      headerHtml = `<div class="envio-card-header header-despachado"><span>✓ Despachado</span></div>`;
    } else if (sc === 'gris') {
      const tipo = pickup.tipo_recoleccion || 'normal';
      const leyenda = tipo === 'courier'
        ? '📦 Lo levanta UPS/DHL'
        : pickup.en_deposito_at
        ? '🏭 En depósito · lo trae el cliente'
        : '📥 Lo trae el cliente';
      headerHtml = `<div class="envio-card-header tipo-gris"><span>${leyenda}</span></div>`;
    } else if (sc === 'dep') {
      headerHtml = `<div class="envio-card-header en-deposito"><span>🏭 En depósito</span></div>`;
    } else if (sc === 'cam') {
      headerHtml = `<div class="envio-card-header en-camioneta-pickup"><span>🚐 En camioneta</span></div>`;
    } else {
      headerHtml = `<div class="envio-card-header pickup-pendiente">
           <span>🕐 Pickup pendiente · ${escHtml(pickup.hora_inicio)}–${escHtml(pickup.hora_fin)}</span>
         </div>`;
    }

    const badgeRezagado = esRezagado
      ? `<div class="envio-card-rezagado-badge">cargado el ${formatDDMM(pickup.fecha)}</div>`
      : '';

    return `<div class="envio-card standalone-pickup${despachado ? ' despachado' : ''}${esRezagado ? ' rezagado' : ''}" data-pickup-id="${pickup.id}">
      ${headerHtml}
      <div class="envio-card-body">
        <div class="envio-card-info">
          <div class="envio-card-cliente">${escHtml(pickup.cliente_nombre)}</div>
          <div class="envio-card-guia" style="color:var(--color-muted)">📍 ${escHtml(pickup.direccion)}</div>
          <input type="text" class="cuadrante-titulo-input" placeholder="Nota…"
            value="${escHtml(pickup.titulo || '')}" data-pickup-titulo="${pickup.id}">
          ${badgeRezagado}
        </div>
        <div class="envio-card-checks">
          ${renderCheck('pickup', pickup.id, 'check_datos', pickup.check_datos, 'Datos completos')}
          ${renderCheck('pickup', pickup.id, 'check_guia', pickup.check_guia, 'Guía aérea')}
          ${renderCheck('pickup', pickup.id, 'check_proforma', pickup.check_proforma, 'Proforma')}
          ${renderCheck('pickup', pickup.id, 'check_despachado', pickup.check_despachado, 'Despachado')}
        </div>
      </div>
      <div class="envio-card-footer">
        <button type="button" class="btn-add-cuadrante" data-add-cuadrante-pickup="${pickup.id}">+ agregar cuadrante</button>
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
        } else if (tipo === 'cuadrante') {
          await onCheckboxCuadranteChange(itemId, campo, valor, cb);
        }
      });
    });
  }

  // ── Acciones de cuadrantes (agregar / editar título / borrar) ──

  function bindCuadranteAcciones() {
    opsList.querySelectorAll('[data-add-cuadrante]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await NovaAPI.post('/operaciones/cuadrantes', {
            envio_origen_id: Number(btn.dataset.addCuadrante),
          });
          await cargarDia(fechaActual);
        } catch (e) {
          btn.disabled = false;
          NovaUtils.showAlert(alertBox, 'Error al agregar cuadrante: ' + e.message);
        }
      });
    });

    opsList.querySelectorAll('[data-add-cuadrante-pickup]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await NovaAPI.post('/operaciones/cuadrantes', {
            pickup_id: Number(btn.dataset.addCuadrantePickup),
          });
          await cargarDia(fechaActual);
        } catch (e) {
          btn.disabled = false;
          NovaUtils.showAlert(alertBox, 'Error al agregar cuadrante: ' + e.message);
        }
      });
    });

    opsList.querySelectorAll('[data-cuadrante-titulo]').forEach((input) => {
      input.addEventListener('change', () => onTituloCuadranteChange(input));
    });

    opsList.querySelectorAll('[data-pickup-titulo]').forEach((input) => {
      input.addEventListener('change', () => onTituloPickupChange(input));
    });

    opsList.querySelectorAll('[data-del-cuadrante]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await NovaAPI.delete(`/operaciones/cuadrantes/${btn.dataset.delCuadrante}`);
          await cargarDia(fechaActual);
        } catch (e) {
          btn.disabled = false;
          NovaUtils.showAlert(alertBox, 'Error al borrar cuadrante: ' + e.message);
        }
      });
    });
  }

  function getCuadrante(id) {
    return cuadrantes.find((q) => q.id === id) || cuadrantesRezagados.find((q) => q.id === id);
  }

  async function onTituloCuadranteChange(input) {
    const id = Number(input.dataset.cuadranteTitulo);
    const titulo = input.value.trim();
    try {
      await NovaAPI.patch(`/operaciones/cuadrantes/${id}`, { titulo });
      const q = getCuadrante(id);
      if (q) q.titulo = titulo;
    } catch (e) {
      NovaUtils.showAlert(alertBox, 'Error al guardar título: ' + e.message);
    }
  }

  async function onTituloPickupChange(input) {
    const id = Number(input.dataset.pickupTitulo);
    const titulo = input.value.trim();
    try {
      await NovaAPI.operaciones.actualizarPickup(id, { titulo });
      const p = pickupsDelDia.find((x) => x.id === id) || rezagados.find((x) => x.id === id);
      if (p) p.titulo = titulo;
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al guardar nota: ' + err.message);
    }
  }

  async function onCheckboxCuadranteChange(cuadranteId, campo, valor, cb) {
    try {
      await NovaAPI.patch(`/operaciones/cuadrantes/${cuadranteId}`, { [campo]: valor });
      const id = Number(cuadranteId);
      const q = cuadrantes.find((x) => x.id === id);
      const rIdx = cuadrantesRezagados.findIndex((x) => x.id === id);
      if (q) {
        q[campo] = valor;
        if (campo === 'check_despachado' && valor === 1) q.estado_operativo = 'despachado';
      } else if (rIdx >= 0) {
        cuadrantesRezagados[rIdx][campo] = valor;
        // Al despachar, el cuadrante rezagado deja de arrastrarse.
        if (campo === 'check_despachado' && valor === 1) cuadrantesRezagados.splice(rIdx, 1);
      }
      if (campo === 'check_despachado' && valor === 1) renderLista();
    } catch (e) {
      cb.checked = !cb.checked;
      NovaUtils.showAlert(alertBox, 'Error al guardar: ' + e.message);
    }
  }

  async function onCheckboxPickupChange(pickupId, campo, valor, cb) {
    try {
      await NovaAPI.operaciones.actualizarPickup(pickupId, { [campo]: valor });
      const id = Number(pickupId);
      const idx = pickupsDelDia.findIndex((p) => p.id === id);
      if (idx >= 0) {
        pickupsDelDia[idx][campo] = valor;
      } else {
        // Pickup rezagado (arrastre de días anteriores).
        const rIdx = rezagados.findIndex((p) => p.id === id);
        if (rIdx >= 0) {
          rezagados[rIdx][campo] = valor;
          // Al despachar, el rezagado deja de arrastrarse: lo sacamos de la sección.
          if (campo === 'check_despachado' && valor === 1) rezagados.splice(rIdx, 1);
        }
      }
      // Al tildar o destildar Despachado, re-renderizamos para que la card se
      // reubique sola: baja a la sección verde "Despachado" o vuelve a su
      // sección original (pendientes / depósito).
      if (campo === 'check_despachado') renderLista();
    } catch (e) {
      cb.checked = !cb.checked;
      NovaUtils.showAlert(alertBox, 'Error al guardar: ' + e.message);
    }
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
