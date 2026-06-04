(function () {
  // ── State ──────────────────────────────────────────────────────────────
  let vistaActual = 'dia';
  let semanaLunes = getMondayOfWeek(new Date());
  let diaActual = getDefaultDia(semanaLunes);
  let pickups = [];
  let clientes = [];
  let pickupEditandoId = null;
  let detallePickupId = null;

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
      let dotClass = '';
      if (delDia.length > 0) {
        dotClass = delDia.some(p => (p.estado || 'pendiente') !== 'recolectado') ? 'pend' : 'rec';
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
    const recCount = delDia.filter(p => (p.estado || 'pendiente') === 'recolectado').length;
    const pendCount = delDia.filter(p => (p.estado || 'pendiente') !== 'recolectado').length;

    const titulo = formatDiaTitulo(diaActual);
    document.getElementById('dia-titulo').textContent = titulo.charAt(0).toUpperCase() + titulo.slice(1);
    document.getElementById('dia-count').textContent = delDia.length === 0
      ? 'Sin pickups'
      : `${delDia.length} pickup${delDia.length !== 1 ? 's' : ''}`;
    document.getElementById('count-rec').textContent = `✓ ${recCount} recolectado${recCount !== 1 ? 's' : ''}`;
    document.getElementById('count-pend').textContent = `⏱ ${pendCount} pendiente${pendCount !== 1 ? 's' : ''}`;

    const list = document.getElementById('pickups-dia-list');
    if (delDia.length === 0) {
      list.innerHTML = '<div class="dia-empty">Sin pickups programados para este día</div>';
      return;
    }

    list.innerHTML = delDia.map(p => buildPickupCard(p)).join('');

    list.querySelectorAll('[data-action="confirmar"]').forEach(btn => {
      btn.addEventListener('click', () => confirmarRecoleccion(Number(btn.dataset.id), btn));
    });
    list.querySelectorAll('[data-action="detalle"]').forEach(btn => {
      btn.addEventListener('click', () => abrirDetalle(Number(btn.dataset.id)));
    });
  }

  function buildPickupCard(p) {
    const esRec = (p.estado || 'pendiente') === 'recolectado';
    const sc = esRec ? 'rec' : 'pend';
    const badgeText = esRec ? '✓ Listo' : '⏱ Pendiente';
    const acciones = esRec
      ? `<div class="pickup-recolectado-label">✓ Recolectado</div>
         <button class="btn-detalle" data-action="detalle" data-id="${p.id}">Ver detalle</button>`
      : `<button class="btn-confirmar" data-action="confirmar" data-id="${p.id}">✓ Confirmar recolección</button>
         <button class="btn-detalle" data-action="detalle" data-id="${p.id}">Ver detalle</button>`;
    return `<div class="pickup-card-v2${esRec ? ' recolectado' : ''}" id="pickup-card-${p.id}">
      <div class="pickup-card-v2-header">
        <div class="pickup-avatar ${sc}">${escHtml(getInitials(p.cliente_nombre))}</div>
        <div class="pickup-card-v2-info">
          <div class="pickup-name-row">
            <div class="pickup-client-name">${escHtml(p.cliente_nombre)}</div>
            ${courierBadgeHtml(p.courier)}
          </div>
          <div class="pickup-hora">${escHtml(p.hora_inicio)} – ${escHtml(p.hora_fin)}</div>
        </div>
        <span class="pickup-badge ${sc}">${badgeText}</span>
      </div>
      <div class="pickup-direccion">📍 ${escHtml(p.direccion)}</div>
      <div class="pickup-actions">${acciones}</div>
    </div>`;
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
            const esRec = (p.estado || 'pendiente') === 'recolectado';
            const sc = esRec ? 'rec' : 'pend';
            return `<div class="semana-row ${sc}" data-action="goto-dia" data-ymd="${ymd}">
              <span class="semana-dot ${sc}"></span>
              <span class="semana-row-name">${escHtml(p.cliente_nombre)}</span>
              ${courierBadgeHtml(p.courier)}
              <span class="semana-row-hora">${escHtml(p.hora_inicio)}</span>
              <span class="semana-row-badge ${sc}">${esRec ? '✓ Listo' : 'Pendiente'}</span>
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

  // ── Confirmar recolección ──────────────────────────────────────────────

  async function confirmarRecoleccion(id, btn) {
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }
    try {
      await NovaAPI.pickups.editar(id, { estado: 'recolectado' });
      const idx = pickups.findIndex(p => p.id === id);
      if (idx !== -1) pickups[idx] = { ...pickups[idx], estado: 'recolectado' };
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
    const esRec = (p.estado || 'pendiente') === 'recolectado';
    document.getElementById('detalle-estado').textContent = esRec ? '✓ Recolectado' : '⏱ Pendiente';
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
      .map(c => `<option value="${c.id}">${escHtml(c.nombre)}</option>`)
      .join('');
  }

  async function cargarDirecciones(clienteId) {
    const wrap = document.getElementById('dir-input-wrap');
    wrap.innerHTML = '<span style="color:var(--color-muted);font-size:0.85rem">Cargando...</span>';
    try {
      const dirs = await NovaAPI.clientes.direcciones.listar(clienteId);
      renderDirInput(dirs);
    } catch (e) {
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
    const notas = document.getElementById('m-notas').value.trim() || null;
    console.log('[guardarPickup] courierEl:', courierEl, '| value:', courierEl?.value, '| courier enviado:', courier);
    const payload = { cliente_id, direccion, fecha, hora_inicio, hora_fin, courier, notas };
    console.log('[guardarPickup] payload completo:', JSON.stringify(payload));
    if (!cliente_id || !direccion || !fecha || !hora_inicio || !hora_fin) {
      NovaUtils.showAlert(alertBox, 'Completá todos los campos obligatorios.');
      return;
    }
    try {
      if (pickupEditandoId) {
        await NovaAPI.pickups.editar(pickupEditandoId, { cliente_id, direccion, fecha, hora_inicio, hora_fin, courier, notas });
      } else {
        await NovaAPI.pickups.crear({ cliente_id, direccion, fecha, hora_inicio, hora_fin, courier, notas });
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
    await cargarClientes();
    await cargarPickups();
    render();
    bindEventos();
  }

  init();
})();
