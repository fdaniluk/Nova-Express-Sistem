(function () {
  // ── State ──────────────────────────────────────────────────────────────
  let vistaActual = 'dia';
  let semanaLunes = getMondayOfWeek(new Date());
  let diaActual = getDefaultDia(semanaLunes);
  let pickups = [];
  let clientes = [];
  let pickupEditandoId = null;
  let detallePickupId = null;
  let recolectores = [];
  let pickupChoferPendienteId = null;
  let modoChoferAccion = null; // 'confirmar-ricardo' | 'reasignar'

  // ── DOM refs ───────────────────────────────────────────────────────────
  const alertBox      = document.getElementById('alert-box');
  const weekLabel     = document.getElementById('week-label');
  const dayStrip      = document.getElementById('day-strip');
  const vistaDiaEl    = document.getElementById('vista-dia');
  const vistaSemanaEl = document.getElementById('vista-semana');
  const modalOverlay  = document.getElementById('modal-overlay');
  const modalTitle    = document.getElementById('modal-title');
  const btnEliminar   = document.getElementById('btn-eliminar-pickup');
  const detalleOverlay = document.getElementById('detalle-overlay');
  const modalChoferOverlay = document.getElementById('modal-chofer-overlay');
  const modalCobranzaOverlay = document.getElementById('modal-cobranza-overlay');

  // Pickup para el que se está cargando la cobranza (modal abierto).
  let cobranzaPickupId = null;

  // ── Formato de moneda (para el botón "ya cargada") ─────────────────────
  const fmtArs = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const fmtUsd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  // ── Fecha helpers ──────────────────────────────────────────────────────

  function getMondayOfWeek(d) {
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setDate(d.getDate() + diff);
    monday.setHours(0, 0, 0, 0);
    return monday;
  }

  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(d.getDate() + n);
    r.setHours(0, 0, 0, 0);
    return r;
  }

  function toYMD(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function fromYMD(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    const r = new Date(y, m - 1, d);
    r.setHours(0, 0, 0, 0);
    return r;
  }

  function getDefaultDia(lunes) {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const hoyYmd = toYMD(hoy);
    for (let i = 0; i < 5; i++) {
      if (toYMD(addDays(lunes, i)) === hoyYmd) return hoy;
    }
    return new Date(lunes);
  }

  function getDiaOffset(d) {
    const day = d.getDay();
    const offset = day === 0 ? 6 : day - 1;
    return Math.min(offset, 4);
  }

  function formatSemanaLabel(lunes) {
    const viernes = addDays(lunes, 4);
    const mes = viernes.toLocaleDateString('es-AR', { month: 'short' });
    return `Semana ${lunes.getDate()} – ${viernes.getDate()} ${mes}`;
  }

  function formatDiaTitulo(d) {
    return d.toLocaleDateString('es-AR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  }

  const DIAS_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie'];

  // ── Data loading ───────────────────────────────────────────────────────

  async function cargarClientes() {
    try {
      clientes = await NovaAPI.clientes.listar();
    } catch (e) {
      NovaUtils.showAlert(alertBox, 'Error al cargar clientes: ' + e.message);
    }
  }

  async function cargarPickups() {
    const desde = toYMD(semanaLunes);
    const hasta = toYMD(addDays(semanaLunes, 4));
    try {
      pickups = await NovaAPI.pickups.listar(desde, hasta);
    } catch (e) {
      NovaUtils.showAlert(alertBox, 'Error al cargar pickups: ' + e.message);
    }
  }

  async function cargarRecolectores() {
    try {
      recolectores = await NovaAPI.get('/pickups/recolectores');
    } catch (e) {
      console.warn('[pickups] No se pudieron cargar recolectores:', e.message);
    }
  }

  // ── Estado 4-color ────────────────────────────────────────────────────

  function estadoPickup(p) {
    // Tipos especiales: 'cliente' y 'courier' se muestran en gris (estado propio),
    // fuera de la cadena de chofer. El 'normal' deriva exactamente como antes.
    const tipo = p.tipo_recoleccion || 'normal';
    if (tipo === 'cliente' || tipo === 'courier') return tipo;
    if (p.en_deposito_at)     return 'dep';
    if (p.confirmado_juanqui) return 'cam';
    if (p.confirmado_ricardo) return 'conf';
    return 'pend';
  }

  // ── Render ─────────────────────────────────────────────────────────────

  function render() {
    weekLabel.textContent = formatSemanaLabel(semanaLunes);
    if (vistaActual === 'dia') {
      dayStrip.classList.remove('hidden');
      vistaDiaEl.classList.remove('hidden');
      vistaSemanaEl.classList.add('hidden');
      renderDayStrip();
      renderVistaDia();
    } else {
      dayStrip.classList.add('hidden');
      vistaDiaEl.classList.add('hidden');
      vistaSemanaEl.classList.remove('hidden');
      renderVistaSemana();
    }
  }

  function renderDayStrip() {
    const hoyYmd = toYMD(new Date());
    const activoYmd = toYMD(diaActual);
    let html = '';
    for (let i = 0; i < 5; i++) {
      const d = addDays(semanaLunes, i);
      const ymd = toYMD(d);
      const isActive = ymd === activoYmd;
      const isHoy = ymd === hoyYmd;
      const delDia = pickups.filter(p => p.fecha === ymd);
      // El dot agregado se calcula solo sobre los 'normal' (comportamiento intacto).
      // Si el día solo tiene cliente/courier, se muestra en gris.
      const normales = delDia.filter(p => (p.tipo_recoleccion || 'normal') === 'normal');
      let dotClass = '';
      if (normales.length > 0) {
        if (normales.every(p => !!p.en_deposito_at)) {
          dotClass = 'dep';
        } else if (normales.some(p => !!p.confirmado_juanqui && !p.en_deposito_at)) {
          dotClass = 'cam';
        } else if (normales.some(p => !!p.confirmado_ricardo && !p.confirmado_juanqui)) {
          dotClass = 'conf';
        } else {
          dotClass = 'pend';
        }
      } else if (delDia.length > 0) {
        dotClass = 'gris';
      }
      const classes = ['day-pill', isActive ? 'active' : '', isHoy && !isActive ? 'today' : '']
        .filter(Boolean).join(' ');
      html += `<button class="${classes}" data-ymd="${ymd}">
        <span class="day-pill-label">${DIAS_SHORT[i]}</span>
        <span class="day-pill-num">${d.getDate()}</span>
        <span class="day-pill-dot ${dotClass}"></span>
      </button>`;
    }
    dayStrip.innerHTML = html;
    dayStrip.querySelectorAll('.day-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        diaActual = fromYMD(pill.dataset.ymd);
        renderDayStrip();
        renderVistaDia();
      });
    });
  }

  function renderVistaDia() {
    const ymd = toYMD(diaActual);
    const delDia = pickups.filter(p => p.fecha === ymd);
    /* Los contadores del resumen cuentan SOLO los pickups con cadena de chofer. Un
       'cliente' (lo trae al depósito) o un 'courier' (lo levanta UPS/DHL) no tiene nada
       que confirmar, y contarlo como "sin confirmar" hacía parecer que faltaba alguien
       cuando el día estaba completo (lo vio Felipe el 26/08). Van en su propia cuenta
       gris, que solo aparece si hay alguno. */
    const normales = delDia.filter(p => (p.tipo_recoleccion || 'normal') !== 'cliente'
      && (p.tipo_recoleccion || 'normal') !== 'courier');
    const grisCount = delDia.length - normales.length;
    const depCount  = normales.filter(p => !!p.en_deposito_at).length;
    const camCount  = normales.filter(p => !!p.confirmado_juanqui && !p.en_deposito_at).length;
    const confCount = normales.filter(p => !!p.confirmado_ricardo && !p.confirmado_juanqui).length;
    const pendCount = normales.filter(p => !p.confirmado_ricardo).length;

    const titulo = formatDiaTitulo(diaActual);
    document.getElementById('dia-titulo').textContent = titulo.charAt(0).toUpperCase() + titulo.slice(1);
    document.getElementById('dia-count').textContent = delDia.length === 0
      ? 'Sin pickups'
      : `${delDia.length} pickup${delDia.length !== 1 ? 's' : ''}`;
    document.getElementById('count-dep').textContent  = `✓ ${depCount} en depósito`;
    document.getElementById('count-cam').textContent  = `🚐 ${camCount} en camioneta`;
    document.getElementById('count-conf').textContent = `⚑ ${confCount} Ricardo`;
    document.getElementById('count-pend').textContent = `● ${pendCount} sin confirmar`;
    const grisEl = document.getElementById('count-gris');
    if (grisEl) {
      grisEl.textContent = `◼ ${grisCount} cliente/courier`;
      grisEl.style.display = grisCount > 0 ? '' : 'none';
    }

    const list = document.getElementById('pickups-dia-list');
    if (delDia.length === 0) {
      list.innerHTML = '<div class="dia-empty">Sin pickups programados para este día</div>';
      return;
    }

    list.innerHTML = delDia.map(p => buildPickupCard(p)).join('');

    list.querySelectorAll('[data-action="conf-ricardo"]').forEach(btn => {
      btn.addEventListener('click', () => toggleConfirmacion(Number(btn.dataset.id), 'ricardo', true, btn));
    });
    list.querySelectorAll('[data-action="desconf-ricardo"]').forEach(btn => {
      btn.addEventListener('click', () => toggleConfirmacion(Number(btn.dataset.id), 'ricardo', false, btn));
    });
    list.querySelectorAll('[data-action="conf-visto"]').forEach(btn => {
      btn.addEventListener('click', () => toggleConfirmacion(Number(btn.dataset.id), 'visto', true, btn));
    });
    list.querySelectorAll('[data-action="desconf-visto"]').forEach(btn => {
      btn.addEventListener('click', () => toggleConfirmacion(Number(btn.dataset.id), 'visto', false, btn));
    });
    list.querySelectorAll('[data-action="conf-juanqui"]').forEach(btn => {
      btn.addEventListener('click', () => toggleConfirmacion(Number(btn.dataset.id), 'juanqui', true, btn));
    });
    list.querySelectorAll('[data-action="desconf-juanqui"]').forEach(btn => {
      btn.addEventListener('click', () => toggleConfirmacion(Number(btn.dataset.id), 'juanqui', false, btn));
    });
    list.querySelectorAll('[data-action="conf-deposito"]').forEach(btn => {
      btn.addEventListener('click', () => toggleConfirmacion(Number(btn.dataset.id), 'deposito', true, btn));
    });
    list.querySelectorAll('[data-action="desconf-deposito"]').forEach(btn => {
      btn.addEventListener('click', () => toggleConfirmacion(Number(btn.dataset.id), 'deposito', false, btn));
    });
    list.querySelectorAll('[data-action="detalle"]').forEach(btn => {
      btn.addEventListener('click', () => abrirDetalle(Number(btn.dataset.id)));
    });
    list.querySelectorAll('[data-action="reasignar-rec"]').forEach(el => {
      el.addEventListener('click', () => abrirModalChofer(Number(el.dataset.id), 'reasignar'));
    });
    list.querySelectorAll('[data-action="cargar-cobranza"]').forEach(btn => {
      btn.addEventListener('click', () => abrirModalCobranza(Number(btn.dataset.id)));
    });
  }

  function buildPickupCard(p) {
    const tipo = p.tipo_recoleccion || 'normal';
    const esGris = tipo === 'cliente' || tipo === 'courier';
    const sc = estadoPickup(p);

    const cardExtra = esGris ? ' tipo-gris'
      : sc === 'dep' ? ' en-deposito' : sc === 'cam' ? ' en-camioneta' : sc === 'conf' ? ' confirmado' : '';
    const badgeText = tipo === 'cliente' ? 'lo trae el cliente'
      : tipo === 'courier' ? 'lo levanta UPS/DHL'
      : sc === 'dep' ? 'En depósito' : sc === 'cam' ? 'En camioneta'
      : sc === 'conf' ? (p.visto_juanqui_at ? 'Ricardo ✓ · 👁' : 'Ricardo ✓') : 'Sin confirmar';
    const stripeClass = p.recolector === 'Juanqui' ? 'stripe-juanqui' : p.recolector ? 'stripe-otro' : 'stripe-ninguno';
    /* Un 'cliente' o 'courier' no lleva chofer: decirle "Sin asignar" hacía creer que
       faltaba asignárselo a alguien (Felipe, 26/08). La tira dice quién lo mueve. */
    const stripeLabel = esGris
      ? (tipo === 'courier' ? 'UPS/DHL' : 'Lo trae el cliente')
      : (p.recolector || 'Sin asignar');
    const stripeAttrs = (!esGris && p.confirmado_ricardo) ? ` data-action="reasignar-rec" data-id="${p.id}" style="cursor:pointer"` : '';

    let actionsHtml;
    if (tipo === 'courier') {
      // Terminal: lo levanta UPS/DHL, sin botones de confirmación.
      actionsHtml = `<div class="pickup-actions-row">
            <button class="btn-detalle" data-action="detalle" data-id="${p.id}">Ver detalle</button>
          </div>`;
    } else if (tipo === 'cliente') {
      // Solo el paso de depósito, reversible (reusa el toggle conf/desconf-deposito).
      const horaD = p.en_deposito_at ? p.en_deposito_at.slice(11, 16) : null;
      const btnDeposito = horaD
        ? `<button class="btn-conf btn-conf-on btn-conf-deposito" data-action="desconf-deposito" data-id="${p.id}" title="En depósito a las ${horaD} — clic para deshacer">✓ En depósito ${horaD}</button>`
        : `<button class="btn-conf btn-conf-off btn-conf-deposito" data-action="conf-deposito" data-id="${p.id}">En depósito</button>`;
      actionsHtml = `<div class="pickup-actions-row">
            ${btnDeposito}
            <button class="btn-detalle" data-action="detalle" data-id="${p.id}">Ver detalle</button>
          </div>`;
    } else {
      // 'normal': cadena de chofer completa, idéntica a hoy.
      const horaR = p.confirmado_ricardo ? p.confirmado_ricardo.slice(11, 16) : null;
      const horaJ = p.confirmado_juanqui ? p.confirmado_juanqui.slice(11, 16) : null;
      const horaD = p.en_deposito_at ? p.en_deposito_at.slice(11, 16) : null;
      const horaV = p.visto_juanqui_at ? p.visto_juanqui_at.slice(11, 16) : null;

      const btnRicardo = horaR
        ? `<button class="btn-conf btn-conf-on btn-conf-ricardo" data-action="desconf-ricardo" data-id="${p.id}" title="Confirma a las ${horaR} — clic para deshacer">✓ Ricardo ${horaR}</button>`
        : `<button class="btn-conf btn-conf-off btn-conf-ricardo" data-action="conf-ricardo" data-id="${p.id}">Confirmar Ricardo</button>`;

      const btnVisto = horaV
        ? `<button class="btn-conf btn-conf-on btn-conf-visto" data-action="desconf-visto" data-id="${p.id}" title="Visto a las ${horaV} — clic para desmarcar">✓ Visto ${horaV}</button>`
        : `<button class="btn-conf btn-conf-off btn-conf-visto" data-action="conf-visto" data-id="${p.id}"${!horaR ? ' disabled' : ''}>Marcar visto</button>`;

      const btnJuanqui = horaJ
        ? `<button class="btn-conf btn-conf-on btn-conf-juanqui" data-action="desconf-juanqui" data-id="${p.id}" title="Confirma a las ${horaJ} — clic para deshacer">✓ En camioneta ${horaJ}</button>`
        : `<button class="btn-conf btn-conf-off btn-conf-juanqui" data-action="conf-juanqui" data-id="${p.id}"${!horaR ? ' disabled' : ''}>En camioneta</button>`;

      const btnDeposito = horaD
        ? `<button class="btn-conf btn-conf-on btn-conf-deposito" data-action="desconf-deposito" data-id="${p.id}" title="En depósito a las ${horaD} — clic para deshacer">✓ En depósito ${horaD}</button>`
        : `<button class="btn-conf btn-conf-off btn-conf-deposito" data-action="conf-deposito" data-id="${p.id}"${!horaJ ? ' disabled' : ''}>Confirmar depósito</button>`;

      actionsHtml = `<div class="pickup-actions-row">
            ${btnRicardo}
            ${btnVisto}
          </div>
          <div class="pickup-actions-row">
            ${btnJuanqui}
            ${btnDeposito}
            <button class="btn-detalle" data-action="detalle" data-id="${p.id}">Ver detalle</button>
          </div>`;
    }

    const cobroBadgeHtml = p.tiene_cobro ? '<span class="cobro-badge">$ Cobro</span>' : '';
    const llevarPlataBadgeHtml = p.llevar_plata ? '<span class="cobro-badge">Llevar plata</span>' : '';

    // Botón "Cargar cobranza": aparece sólo si el pickup tiene cobro. Titila mientras
    // no se cargó plata (cobranzas_count=0); una vez cargado muestra el total en calma.
    const tieneCobro = !!p.tiene_cobro || tipo === 'cobranza';
    let cobranzaRowHtml = '';
    if (tieneCobro) {
      const count = Number(p.cobranzas_count) || 0;
      const cobranzaBtn = count > 0
        ? `<button class="btn-cobranza cargada" data-action="cargar-cobranza" data-id="${p.id}" title="Cobranza cargada — clic para ver o agregar más líneas">✓ ${escHtml(cobranzaResumenTexto(p))}</button>`
        : `<button class="btn-cobranza titila" data-action="cargar-cobranza" data-id="${p.id}">$ Cargar cobranza</button>`;
      cobranzaRowHtml = `<div class="pickup-actions-row">${cobranzaBtn}</div>`;
    }

    return `<div class="pickup-card-v2${cardExtra}" id="pickup-card-${p.id}">
      <div class="pickup-rec-stripe ${stripeClass}"${stripeAttrs}>${escHtml(stripeLabel)}</div>
      <div class="pickup-card-v2-content">
        <div class="pickup-card-v2-header">
          <div class="pickup-header-top">
            <div class="pickup-avatar ${sc}">${escHtml(getInitials(p.cliente_nombre))}</div>
            <div class="pickup-hora">${escHtml(p.hora_inicio)} – ${escHtml(p.hora_fin)}</div>
            <div class="pickup-header-badges">
              ${courierBadgeHtml(p.courier)}
              <span class="pickup-badge ${sc}">${badgeText}</span>
              ${cobroBadgeHtml}
              ${llevarPlataBadgeHtml}
            </div>
          </div>
          <div class="pickup-client-name">${escHtml(p.cliente_nombre)}</div>
        </div>
        <div class="pickup-direccion">📍 ${escHtml(p.direccion)}</div>
        <div class="pickup-actions">
          ${actionsHtml}
          ${cobranzaRowHtml}
        </div>
      </div>
    </div>`;
  }

  function recChipHtml(recolector, tipoRecoleccion) {
    /* Mismo criterio que la tira de la tarjeta: un 'cliente'/'courier' no lleva chofer,
       así que el chip dice quién lo mueve en vez de "Sin asignar". */
    const tipo = tipoRecoleccion || 'normal';
    if (tipo === 'courier') return '<span class="semana-rec-chip chip-ninguno">UPS/DHL</span>';
    if (tipo === 'cliente') return '<span class="semana-rec-chip chip-ninguno">Lo trae el cliente</span>';
    if (!recolector) return '<span class="semana-rec-chip chip-ninguno">Sin asignar</span>';
    const cls = recolector === 'Juanqui' ? 'chip-juanqui' : 'chip-otro';
    return `<span class="semana-rec-chip ${cls}">${escHtml(recolector)}</span>`;
  }

  function renderVistaSemana() {
    const hoyYmd = toYMD(new Date());
    let html = '<div class="semana-list">';
    for (let i = 0; i < 5; i++) {
      const d = addDays(semanaLunes, i);
      const ymd = toYMD(d);
      const esHoy = ymd === hoyYmd;
      const delDia = pickups.filter(p => p.fecha === ymd);
      const countText = delDia.length === 0
        ? 'sin pickups'
        : `${delDia.length} pickup${delDia.length !== 1 ? 's' : ''}`;
      const diaLabel = d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric' });
      const diaLabelCap = diaLabel.charAt(0).toUpperCase() + diaLabel.slice(1);
      const hoyBadge = esHoy ? ' <span class="semana-hoy-badge">hoy</span>' : '';

      const rowsHtml = delDia.length === 0
        ? '<div class="semana-empty">Sin pickups programados</div>'
        : delDia.map(p => {
            const sc = estadoPickup(p);
            const badgeLabel = sc === 'cliente' ? 'lo trae el cliente'
              : sc === 'courier' ? 'lo levanta UPS/DHL'
              : sc === 'dep' ? 'En depósito' : sc === 'cam' ? 'En camioneta'
              : sc === 'conf' ? (p.visto_juanqui_at ? 'Ricardo ✓ · 👁' : 'Ricardo ✓') : 'Sin confirmar';
            const cobroChip = p.tiene_cobro ? '<span class="cobro-chip-sm">$</span>' : '';
            return `<div class="semana-row ${sc}" data-action="goto-dia" data-ymd="${ymd}">
              <span class="semana-dot ${sc}"></span>
              <span class="semana-row-name">${escHtml(p.cliente_nombre)}</span>
              ${courierBadgeHtml(p.courier)}
              ${cobroChip}
              <span class="semana-row-hora">${escHtml(p.hora_inicio)}</span>
              ${recChipHtml(p.recolector, p.tipo_recoleccion)}
              <span class="semana-row-badge ${sc}">${badgeLabel}</span>
            </div>`;
          }).join('');

      html += `<div class="semana-dia-block">
        <div class="semana-dia-header">
          <span class="semana-dia-titulo">${diaLabelCap}${hoyBadge}</span>
          <span class="semana-dia-count">${countText}</span>
        </div>
        <div class="semana-dia-rows">${rowsHtml}</div>
      </div>`;
    }
    html += '</div>';
    document.getElementById('semana-list').innerHTML = html;

    vistaSemanaEl.querySelectorAll('[data-action="goto-dia"]').forEach(row => {
      row.addEventListener('click', () => {
        diaActual = fromYMD(row.dataset.ymd);
        cambiarVista('dia');
      });
    });
  }

  // ── Vista switching ────────────────────────────────────────────────────

  function cambiarVista(vista) {
    vistaActual = vista;
    document.getElementById('btn-vista-dia').classList.toggle('active', vista === 'dia');
    document.getElementById('btn-vista-semana').classList.toggle('active', vista === 'semana');
    render();
  }

  // ── Confirmaciones ────────────────────────────────────────────────────

  async function toggleConfirmacion(id, quien, valor, btn) {
    if (quien === 'ricardo' && valor === true) {
      abrirModalChofer(id, 'confirmar-ricardo');
      return;
    }
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }
    try {
      let payload;
      if (quien === 'ricardo') {
        payload = { confirmar_ricardo: valor };
      } else if (quien === 'visto') {
        payload = { confirmar_visto: valor };
      } else if (quien === 'juanqui') {
        payload = { confirmar_juanqui: valor };
      } else {
        payload = { confirmar_deposito: valor };
      }
      const updated = await NovaAPI.pickups.confirmar(id, payload);
      const idx = pickups.findIndex(p => p.id === id);
      if (idx !== -1) pickups[idx] = { ...pickups[idx], ...updated };
      renderDayStrip();
      renderVistaDia();
    } catch (e) {
      NovaUtils.showAlert(alertBox, e.message);
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
    }
  }

  // ── Panel detalle ──────────────────────────────────────────────────────

  function abrirDetalle(id) {
    const p = pickups.find(x => x.id === id);
    if (!p) return;
    detallePickupId = id;
    document.getElementById('detalle-cliente').textContent = p.cliente_nombre;
    document.getElementById('detalle-fecha').textContent = NovaUtils.formatDate(p.fecha);
    document.getElementById('detalle-hora').textContent = `${p.hora_inicio} – ${p.hora_fin}`;
    document.getElementById('detalle-dir').textContent = p.direccion;
    document.getElementById('detalle-notas').textContent = p.notas || '—';
    document.getElementById('detalle-courier').textContent = p.courier || '—';
    const sc = estadoPickup(p);
    const horaR = p.confirmado_ricardo ? p.confirmado_ricardo.slice(11, 16) : null;
    const horaV = p.visto_juanqui_at ? p.visto_juanqui_at.slice(11, 16) : null;
    const horaJ = p.confirmado_juanqui ? p.confirmado_juanqui.slice(11, 16) : null;
    const horaD = p.en_deposito_at ? p.en_deposito_at.slice(11, 16) : null;
    const estadoTexto = sc === 'dep'
      ? `✓ En depósito (${horaD})`
      : sc === 'cam'
      ? `🚐 En camioneta — Juanqui ${horaJ}`
      : sc === 'conf'
      ? `⚑ Confirmado Ricardo ${horaR} — pendiente Juanqui`
      : '● Sin confirmar';
    document.getElementById('detalle-estado').textContent = estadoTexto;
    const vistoWrap = document.getElementById('detalle-visto-wrap');
    if (vistoWrap) {
      if (horaV) {
        vistoWrap.style.display = '';
        document.getElementById('detalle-visto').textContent = `${p.visto_juanqui_at.slice(0, 10)} ${horaV}`;
      } else {
        vistoWrap.style.display = 'none';
      }
    }
    detalleOverlay.classList.remove('hidden');
  }

  function cerrarDetalle() {
    detalleOverlay.classList.add('hidden');
    detallePickupId = null;
  }

  // ── Modal nuevo/editar ─────────────────────────────────────────────────

  function poblarSelectClientes() {
    const sel = document.getElementById('m-cliente');
    sel.innerHTML = clientes
      .map(c => `<option value="${c.id}">${escHtml(c.nombre_nova || c.nombre)}</option>`)
      .join('');
  }

  async function cargarDirecciones(clienteId) {
    const wrap = document.getElementById('dir-input-wrap');
    wrap.innerHTML = '<span style="color:var(--color-muted);font-size:0.85rem">Cargando...</span>';
    try {
      const dirs = await NovaAPI.clientes.direcciones.listar(clienteId);
      renderDirInput(dirs);
    } catch (e) {
      console.warn('[pickups] No se pudieron cargar direcciones del cliente:', e.message);
      wrap.innerHTML = '<input type="text" id="m-direccion" placeholder="Dirección de pickup">';
    }
  }

  function renderDirInput(dirs) {
    const wrap = document.getElementById('dir-input-wrap');
    if (dirs.length === 0) {
      wrap.innerHTML = '<input type="text" id="m-direccion" placeholder="Dirección de pickup">';
      return;
    }
    if (dirs.length === 1) {
      wrap.innerHTML = `<input type="text" id="m-direccion" value="${escAttr(dirs[0].direccion)}">`;
      return;
    }
    const opts = dirs
      .map(d => `<option value="${escAttr(d.direccion)}">${escHtml(d.direccion)}</option>`)
      .join('');
    wrap.innerHTML = `
      <select id="m-dir-select" style="width:100%">
        ${opts}
        <option value="__otra__">Otra dirección...</option>
      </select>
      <input type="text" id="m-direccion" placeholder="Escribir dirección" style="display:none;margin-top:0.4rem">`;
    const sel = document.getElementById('m-dir-select');
    const inp = document.getElementById('m-direccion');
    sel.addEventListener('change', () => {
      if (sel.value === '__otra__') {
        inp.style.display = '';
        inp.value = '';
        inp.focus();
      } else {
        inp.style.display = 'none';
        inp.value = sel.value;
      }
    });
    inp.value = sel.value;
  }

  function getDireccionDelModal() {
    const sel = document.getElementById('m-dir-select');
    const inp = document.getElementById('m-direccion');
    if (sel) return sel.value === '__otra__' ? inp.value.trim() : sel.value;
    return inp ? inp.value.trim() : '';
  }

  function setDireccionEnModal(dir) {
    const sel = document.getElementById('m-dir-select');
    const inp = document.getElementById('m-direccion');
    if (sel) {
      let found = false;
      for (const opt of sel.options) {
        if (opt.value === dir) { sel.value = dir; found = true; break; }
      }
      if (!found) {
        sel.value = '__otra__';
        inp.style.display = '';
        inp.value = dir;
      } else {
        inp.style.display = 'none';
        inp.value = dir;
      }
    } else if (inp) {
      inp.value = dir;
    }
  }

  function abrirModal(fechaDefault) {
    pickupEditandoId = null;
    modalTitle.textContent = 'Nuevo pickup';
    btnEliminar.classList.add('hidden');
    poblarSelectClientes();
    const fecha = fechaDefault || (vistaActual === 'dia' ? toYMD(diaActual) : toYMD(semanaLunes));
    document.getElementById('m-fecha').value = fecha;
    document.getElementById('m-hora-inicio').value = '09:00';
    document.getElementById('m-hora-fin').value = '11:00';
    document.getElementById('m-courier').value = '';
    document.getElementById('m-tipo-recoleccion').value = 'normal';
    document.getElementById('m-tiene-cobro').checked = false;
    document.getElementById('m-llevar-plata').checked = false;
    document.getElementById('m-mostrar-operaciones').checked = true;
    document.getElementById('m-notas').value = '';
    const primerCliente = clientes[0];
    if (primerCliente) cargarDirecciones(primerCliente.id);
    else document.getElementById('dir-input-wrap').innerHTML = '<input type="text" id="m-direccion" placeholder="Dirección de pickup">';
    modalOverlay.classList.remove('hidden');
  }

  async function abrirModalEditar(id) {
    const p = pickups.find(x => x.id === id);
    if (!p) return;
    pickupEditandoId = id;
    modalTitle.textContent = 'Editar pickup';
    btnEliminar.classList.remove('hidden');
    poblarSelectClientes();
    document.getElementById('m-cliente').value = p.cliente_id;
    document.getElementById('m-fecha').value = p.fecha;
    document.getElementById('m-hora-inicio').value = p.hora_inicio;
    document.getElementById('m-hora-fin').value = p.hora_fin;
    document.getElementById('m-courier').value = p.courier || '';
    document.getElementById('m-tipo-recoleccion').value = p.tipo_recoleccion || 'normal';
    document.getElementById('m-tiene-cobro').checked = !!p.tiene_cobro;
    document.getElementById('m-llevar-plata').checked = !!p.llevar_plata;
    document.getElementById('m-mostrar-operaciones').checked = !!p.mostrar_en_operaciones;
    document.getElementById('m-notas').value = p.notas || '';
    await cargarDirecciones(p.cliente_id);
    setDireccionEnModal(p.direccion);
    modalOverlay.classList.remove('hidden');
  }

  function cerrarModal() {
    modalOverlay.classList.add('hidden');
    pickupEditandoId = null;
  }

  async function guardarPickup() {
    const cliente_id = document.getElementById('m-cliente').value;
    const direccion = getDireccionDelModal();
    const fecha = document.getElementById('m-fecha').value;
    const hora_inicio = document.getElementById('m-hora-inicio').value;
    const hora_fin = document.getElementById('m-hora-fin').value;
    const courierEl = document.getElementById('m-courier');
    const courier = courierEl ? (courierEl.value || null) : null;
    const tiene_cobro = document.getElementById('m-tiene-cobro').checked ? 1 : 0;
    const llevar_plata = document.getElementById('m-llevar-plata').checked ? 1 : 0;
    const mostrar_en_operaciones = document.getElementById('m-mostrar-operaciones').checked ? 1 : 0;
    const tipo_recoleccion = document.getElementById('m-tipo-recoleccion').value || 'normal';
    const notas = document.getElementById('m-notas').value.trim() || null;
    if (!cliente_id || !direccion || !fecha || !hora_inicio || !hora_fin) {
      NovaUtils.showAlert(alertBox, 'Completá todos los campos obligatorios.');
      return;
    }
    try {
      if (pickupEditandoId) {
        await NovaAPI.pickups.editar(pickupEditandoId, { cliente_id, direccion, fecha, hora_inicio, hora_fin, courier, tiene_cobro, llevar_plata, mostrar_en_operaciones, tipo_recoleccion, notas });
      } else {
        await NovaAPI.pickups.crear({ cliente_id, direccion, fecha, hora_inicio, hora_fin, courier, tiene_cobro, llevar_plata, mostrar_en_operaciones, tipo_recoleccion, notas });
      }
      cerrarModal();
      await cargarPickups();
      render();
    } catch (e) {
      NovaUtils.showAlert(alertBox, e.message);
    }
  }

  async function eliminarPickup() {
    if (!pickupEditandoId) return;
    const p = pickups.find(x => x.id === pickupEditandoId);
    if (!confirm(`¿Eliminar el pickup de ${p ? p.cliente_nombre : 'este cliente'}?`)) return;
    try {
      await NovaAPI.pickups.borrar(pickupEditandoId);
      cerrarModal();
      await cargarPickups();
      render();
    } catch (e) {
      NovaUtils.showAlert(alertBox, e.message);
    }
  }

  // ── Modal chofer (confirmar Ricardo / reasignar) ──────────────────────

  function poblarSelectChofer(valorActual) {
    const sel = document.getElementById('m-chofer-select');
    sel.innerHTML = '<option value="">— Elegir chofer —</option>' +
      recolectores.map(r => `<option value="${escAttr(r)}"${valorActual === r ? ' selected' : ''}>${escHtml(r)}</option>`).join('');
    document.getElementById('btn-chofer-confirmar').disabled = !sel.value;
  }

  function abrirModalChofer(id, modo) {
    pickupChoferPendienteId = id;
    modoChoferAccion = modo;
    const p = pickups.find(x => x.id === id);
    const valorActual = modo === 'reasignar' && p ? (p.recolector || '') : '';
    document.getElementById('modal-chofer-title').textContent =
      modo === 'reasignar' ? 'Cambiar chofer asignado' : '¿Qué chofer pasa a buscar?';
    poblarSelectChofer(valorActual);
    modalChoferOverlay.classList.remove('hidden');
  }

  function cerrarModalChofer() {
    modalChoferOverlay.classList.add('hidden');
    pickupChoferPendienteId = null;
    modoChoferAccion = null;
  }

  async function confirmarModalChofer() {
    const recolector = document.getElementById('m-chofer-select').value;
    if (!recolector) return;
    const id = pickupChoferPendienteId;
    const modo = modoChoferAccion;
    cerrarModalChofer();
    try {
      let updated;
      if (modo === 'confirmar-ricardo') {
        updated = await NovaAPI.pickups.confirmar(id, { confirmar_ricardo: true, recolector });
      } else {
        updated = await NovaAPI.pickups.editar(id, { recolector });
      }
      const idx = pickups.findIndex(p => p.id === id);
      if (idx !== -1) pickups[idx] = { ...pickups[idx], ...updated };
      renderDayStrip();
      renderVistaDia();
    } catch (e) {
      NovaUtils.showAlert(alertBox, e.message);
    }
  }

  // ── Cobranza (cargar plata del pickup) ─────────────────────────────────

  const FORMAS_PAGO = [
    ['efectivo', 'Efectivo'],
    ['cheque', 'Cheque'],
    ['transferencia', 'Transferencia'],
    ['otro', 'Otro'],
  ];
  const FORMAS_LABEL = Object.fromEntries(FORMAS_PAGO);

  function formatMonto(monto, moneda) {
    return moneda === 'USD' ? 'US$' + fmtUsd.format(monto || 0) : fmtArs.format(monto || 0);
  }

  // Texto del botón "ya cargada": total por moneda (sin mezclar ARS/USD).
  function cobranzaResumenTexto(p) {
    const partes = [];
    const ars = Number(p.cobranzas_total_ars) || 0;
    const usd = Number(p.cobranzas_total_usd) || 0;
    if (ars > 0) partes.push(formatMonto(ars, 'ARS'));
    if (usd > 0) partes.push(formatMonto(usd, 'USD'));
    return partes.length ? partes.join(' + ') : 'Cobranza cargada';
  }

  function nuevaLineaCobranzaHtml() {
    const opts = FORMAS_PAGO.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    return `<div class="cobranza-linea">
      <div class="cobranza-linea-campos">
        <input type="number" class="cl-monto" placeholder="Monto" min="0" step="0.01" inputmode="decimal">
        <select class="cl-moneda">
          <option value="ARS">ARS</option>
          <option value="USD">USD</option>
        </select>
        <select class="cl-forma">${opts}</select>
        <button type="button" class="cl-quitar" title="Quitar línea">✕</button>
      </div>
      <input type="text" class="cl-nota" placeholder="Nota (opcional)">
    </div>`;
  }

  function agregarLineaCobranza() {
    const cont = document.getElementById('cobranza-lineas');
    cont.insertAdjacentHTML('beforeend', nuevaLineaCobranzaHtml());
    const linea = cont.lastElementChild;
    linea.querySelector('.cl-quitar').addEventListener('click', () => {
      // Nunca dejar el form sin ninguna línea.
      if (cont.querySelectorAll('.cobranza-linea').length > 1) linea.remove();
      else linea.querySelectorAll('input').forEach(i => (i.value = ''));
    });
    return linea;
  }

  function renderCobranzasExistentes(lista) {
    const wrap = document.getElementById('cobranza-existentes');
    if (!lista || !lista.length) {
      wrap.classList.add('hidden');
      wrap.innerHTML = '';
      return;
    }
    const filas = lista
      .map(c => `<div class="cobranza-exist-row">
        <span class="ce-monto">${escHtml(formatMonto(Number(c.monto), c.moneda))}</span>
        <span class="ce-forma">${escHtml(FORMAS_LABEL[c.forma_pago] || c.forma_pago || '—')}</span>
        <span class="ce-fecha">${escHtml(NovaUtils.formatDate(c.fecha))}</span>
        ${c.nota ? `<span class="ce-nota">${escHtml(c.nota)}</span>` : ''}
      </div>`)
      .join('');
    wrap.innerHTML = `<div class="cobranza-exist-title">Ya cargadas (${lista.length})</div>${filas}`;
    wrap.classList.remove('hidden');
  }

  async function abrirModalCobranza(id) {
    const p = pickups.find(x => x.id === id);
    if (!p) return;
    cobranzaPickupId = id;
    document.getElementById('modal-cobranza-title').textContent =
      (Number(p.cobranzas_count) || 0) > 0 ? 'Cobranza del pickup' : 'Cargar cobranza';
    document.getElementById('cobranza-cliente-nombre').textContent = p.cliente_nombre;
    document.getElementById('m-cobranza-fecha').value = p.fecha;
    document.getElementById('cobranza-lineas').innerHTML = '';
    agregarLineaCobranza();
    renderCobranzasExistentes([]);
    modalCobranzaOverlay.classList.remove('hidden');

    // Traemos las cobranzas ya cargadas de este pickup (filtrando por pickup_id sobre
    // las del cliente) para poder verlas y agregar más líneas.
    try {
      const res = await NovaAPI.cobranzas.listar({ cliente_id: p.cliente_id });
      const existentes = (res.cobranzas || []).filter(c => Number(c.pickup_id) === Number(id));
      if (cobranzaPickupId === id) renderCobranzasExistentes(existentes);
    } catch (e) {
      console.warn('[pickups] No se pudieron cargar cobranzas del pickup:', e.message);
    }
  }

  function cerrarModalCobranza() {
    modalCobranzaOverlay.classList.add('hidden');
    cobranzaPickupId = null;
  }

  async function guardarCobranzas() {
    const p = pickups.find(x => x.id === cobranzaPickupId);
    if (!p) return;
    const fecha = document.getElementById('m-cobranza-fecha').value;
    if (!fecha) {
      NovaUtils.showAlert(alertBox, 'Indicá la fecha del pago.');
      return;
    }

    const lineas = [...document.querySelectorAll('#cobranza-lineas .cobranza-linea')];
    const nuevas = [];
    for (const linea of lineas) {
      const montoRaw = linea.querySelector('.cl-monto').value.trim();
      if (montoRaw === '') continue; // línea vacía: se ignora
      const monto = parseFloat(montoRaw);
      if (!(monto > 0)) {
        NovaUtils.showAlert(alertBox, 'Cada línea debe tener un monto mayor a 0.');
        return;
      }
      nuevas.push({
        cliente_id: p.cliente_id,
        fecha,
        monto,
        moneda: linea.querySelector('.cl-moneda').value,
        forma_pago: linea.querySelector('.cl-forma').value,
        pickup_id: p.id,
        nota: linea.querySelector('.cl-nota').value.trim() || null,
      });
    }

    if (!nuevas.length) {
      NovaUtils.showAlert(alertBox, 'Agregá al menos una línea con monto.');
      return;
    }

    const btn = document.getElementById('btn-cobranza-guardar');
    btn.disabled = true;
    try {
      // Un POST por línea; se muestran los errores del backend tal cual.
      for (const c of nuevas) {
        await NovaAPI.cobranzas.crear(c);
      }
      cerrarModalCobranza();
      await cargarPickups();
      render();
      NovaUtils.showAlert(alertBox, `Cobranza registrada (${nuevas.length} línea${nuevas.length !== 1 ? 's' : ''}).`, 'success');
    } catch (e) {
      NovaUtils.showAlert(alertBox, e.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ── HTML helpers ───────────────────────────────────────────────────────

  function getInitials(nombre) {
    return (nombre || '').split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
  }

  function courierBadgeHtml(courier) {
    if (!courier) return '';
    const c = String(courier).toUpperCase().trim();
    if (c === 'DHL') return '<span class="courier-badge courier-badge-dhl">DHL</span>';
    if (c === 'UPS') return '<span class="courier-badge courier-badge-ups">UPS</span>';
    return '';
  }

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escAttr(s) {
    return String(s || '').replace(/"/g, '&quot;');
  }

  // ── Bind eventos ───────────────────────────────────────────────────────

  function bindEventos() {
    document.getElementById('btn-vista-dia').addEventListener('click', () => cambiarVista('dia'));
    document.getElementById('btn-vista-semana').addEventListener('click', () => cambiarVista('semana'));

    document.getElementById('btn-prev-week').addEventListener('click', async () => {
      const offset = getDiaOffset(diaActual);
      semanaLunes = addDays(semanaLunes, -7);
      diaActual = addDays(semanaLunes, offset);
      await cargarPickups();
      render();
    });

    document.getElementById('btn-next-week').addEventListener('click', async () => {
      const offset = getDiaOffset(diaActual);
      semanaLunes = addDays(semanaLunes, 7);
      diaActual = addDays(semanaLunes, offset);
      await cargarPickups();
      render();
    });

    document.getElementById('btn-nuevo-pickup').addEventListener('click', () => abrirModal());

    document.getElementById('m-cliente').addEventListener('change', e => {
      cargarDirecciones(e.target.value);
    });

    document.getElementById('btn-modal-cancelar').addEventListener('click', cerrarModal);
    document.getElementById('modal-close').addEventListener('click', cerrarModal);
    modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) cerrarModal(); });
    document.getElementById('btn-modal-guardar').addEventListener('click', guardarPickup);
    btnEliminar.addEventListener('click', eliminarPickup);

    document.getElementById('modal-chofer-close').addEventListener('click', cerrarModalChofer);
    document.getElementById('btn-chofer-cancelar').addEventListener('click', cerrarModalChofer);
    modalChoferOverlay.addEventListener('click', e => { if (e.target === modalChoferOverlay) cerrarModalChofer(); });
    document.getElementById('m-chofer-select').addEventListener('change', e => {
      document.getElementById('btn-chofer-confirmar').disabled = !e.target.value;
    });
    document.getElementById('btn-chofer-confirmar').addEventListener('click', confirmarModalChofer);

    document.getElementById('modal-cobranza-close').addEventListener('click', cerrarModalCobranza);
    document.getElementById('btn-cobranza-cancelar').addEventListener('click', cerrarModalCobranza);
    modalCobranzaOverlay.addEventListener('click', e => { if (e.target === modalCobranzaOverlay) cerrarModalCobranza(); });
    document.getElementById('btn-cobranza-agregar').addEventListener('click', () => agregarLineaCobranza());
    document.getElementById('btn-cobranza-guardar').addEventListener('click', guardarCobranzas);

    document.getElementById('detalle-close').addEventListener('click', cerrarDetalle);
    document.getElementById('detalle-btn-cerrar').addEventListener('click', cerrarDetalle);
    detalleOverlay.addEventListener('click', e => { if (e.target === detalleOverlay) cerrarDetalle(); });
    document.getElementById('detalle-btn-editar').addEventListener('click', () => {
      const id = detallePickupId;
      cerrarDetalle();
      if (id) abrirModalEditar(id);
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────

  async function init() {
    await cargarRecolectores();
    await cargarClientes();
    await cargarPickups();
    render();
    bindEventos();
  }

  init();
})();
