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
    const t = formatearFechaTitulo(fechaActual);
    dateLabel.textContent = t.charAt(0).toUpperCase() + t.slice(1);
    datePicker.value = toYMD(fechaActual);

    const total = pickupsDelDia.length;
    const pendientes = pickupsDelDia.filter((p) => estadoPickup(p) !== 'dep').length;
    const partes = [`${total} pickup${total !== 1 ? 's' : ''}`];
    if (pendientes > 0) partes.push(`${pendientes} sin llegar al depósito`);
    subtitleEl.textContent = partes.join(' · ');
    actualizarProgreso();
  }

  // Barra de avance del día: cuántos de los 4 pasos (datos, guía, proforma,
  // despachado) están hechos sobre el total, contando pickups y cuadrantes de HOY.
  // Los de días anteriores van aparte (chip naranja), no mueven la barra.
  const CAMPOS = ['check_datos', 'check_guia', 'check_proforma', 'check_despachado'];
  function actualizarProgreso() {
    const box = document.getElementById('op-resumen');
    if (!box) return;
    const items = [...pickupsDelDia, ...cuadrantes];
    const totalPasos = items.length * CAMPOS.length;
    const hechos = items.reduce((n, it) => n + CAMPOS.filter((c) => Number(it[c]) === 1).length, 0);
    const despachados = items.filter((it) => Number(it.check_despachado) === 1).length;
    const porDespachar = items.length - despachados;
    const atrasados = rezagados.length + cuadrantesRezagados.length;
    if (!items.length && !atrasados) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const pct = totalPasos ? Math.round((hechos / totalPasos) * 100) : 0;
    document.getElementById('op-pct').textContent = `${pct}%`;
    document.getElementById('op-bar-fill').style.width = `${pct}%`;
    document.getElementById('op-pasos').innerHTML = `<b>${hechos}</b> de ${totalPasos} pasos hechos`;
    document.getElementById('op-chips').innerHTML =
      `<span class="op-chip"><i class="op-dot" style="background:var(--color-primary-light)"></i><b>${porDespachar}</b> por despachar</span>` +
      `<span class="op-chip"><i class="op-dot" style="background:var(--color-primary)"></i><b>${despachados}</b> despachado${despachados !== 1 ? 's' : ''}</span>` +
      (atrasados ? `<span class="op-chip warn"><i class="op-dot" style="background:#F59E0B"></i><b>${atrasados}</b> de días anteriores</span>` : '');
  }

  function estadoPickup(p) {
    // Tipos especiales: 'cliente' y 'courier' se muestran en gris, fuera de la
    // cadena de chofer. El 'normal' deriva exactamente como antes.
    const tipo = p.tipo_recoleccion || 'normal';
    if (tipo === 'cliente' || tipo === 'courier' || tipo === 'ninguna') return 'gris';
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
      actualizarProgreso();
      return;
    }

    // Cada pickup se renderiza con sus cuadrantes pegados debajo (matcheados por
    // pickup_id). Para rezagados la fuente de cuadrantes es cuadrantesRezagados.
    const renderPickupConCuadrantes = (p, esRezagado) =>
      renderCardPickupStandalone(p, esRezagado) +
      cuadrantesDePickup(p.id, esRezagado).map((q) => renderCardCuadrante(q, esRezagado)).join('');

    const seccion = (titulo, n, extra = '') =>
      `<div class="op-seccion ${extra}"><span>${titulo}</span><span class="op-seccion-n">${n}</span></div>`;

    let html = '';
    const porDespachar = [...pickupsPendientes, ...pickupsDeposito];
    if (porDespachar.length) {
      html += seccion('Por despachar', porDespachar.length);
      html += porDespachar.map((p) => renderPickupConCuadrantes(p, false)).join('');
    }
    if (pickupsDespachados.length) {
      html += seccion('Despachados', pickupsDespachados.length, 'ok');
      html += pickupsDespachados.map((p) => renderPickupConCuadrantes(p, false)).join('');
    }

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
      html += seccion('Pendientes de días anteriores', totalRezagados, 'warn');
      html += rezOrdenados.map((p) => renderPickupConCuadrantes(p, true)).join('');
      // Cuadrantes rezagados que no cuelgan de ningún pickup rezagado mostrado
      // (su pickup ya fue despachado) se renderizan sueltos para no perderlos.
      const idsRezagados = new Set(rezOrdenados.map((p) => p.id));
      const cuadrantesSueltos = cuadrantesRezagados.filter((q) => !idsRezagados.has(q.pickup_id));
      html += cuadrantesSueltos.map((q) => renderCardCuadrante(q, true)).join('');
    }

    opsList.innerHTML = html;
    actualizarProgreso();
    bindCheckboxes();
    bindCuadranteAcciones();
    bindSueltos();
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
    const despachado = Number(cuadrante.check_despachado) === 1;
    const clases = `op-card cuadrante-card${despachado ? ' despachado' : ''}${esRezagado ? ' rezagado' : ''}`;
    const badgeRezagado = esRezagado
      ? `<span class="op-rezagado">cargado el ${formatDDMM(cuadrante.fecha)}</span>`
      : '';
    return `<div class="${clases}" data-cuadrante-id="${cuadrante.id}">
      <div class="op-stripe ${despachado ? 'st-desp' : 'st-cuad'}"></div>
      <div class="op-main">
        <div class="op-top">
          <span class="cuadrante-badge">Cuadrante</span>
          <span class="op-cliente">${escHtml(cuadrante.cliente_nombre)}</span>
          ${badgeRezagado}
        </div>
        <input type="text" class="op-nota" placeholder="Título del cuadrante…"
          value="${escHtml(cuadrante.titulo || '')}" data-cuadrante-titulo="${cuadrante.id}">
        <div class="op-acciones">
          <button type="button" class="op-link danger" data-del-cuadrante="${cuadrante.id}">Borrar cuadrante</button>
        </div>
      </div>
      <div class="op-side">
        ${renderPasos('cuadrante', cuadrante)}
      </div>
    </div>`;
  }

  // ── Cards de pickup standalone ────────────────────────

  const PIN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';

  function renderCardPickupStandalone(pickup, esRezagado) {
    const despachado = pickupDespachado(pickup);
    const sc = estadoPickup(pickup);
    const tipo = pickup.tipo_recoleccion || 'normal';
    let est, estClase;
    if (despachado) {
      est = 'Despachado'; estClase = 'desp';
    } else if (sc === 'gris') {
      est = tipo === 'courier' ? 'Lo levanta UPS/DHL'
        : tipo === 'ninguna' ? 'Sin pickup · impo / ya está acá'
        : pickup.en_deposito_at ? 'En depósito · lo trajo el cliente'
        : 'Lo trae el cliente';
      estClase = 'gris';
    } else if (sc === 'dep') {
      est = 'En depósito'; estClase = 'dep';
    } else if (sc === 'cam') {
      est = 'En camioneta'; estClase = 'cam';
    } else {
      est = `Pickup pendiente · ${escHtml(pickup.hora_inicio)}–${escHtml(pickup.hora_fin)}`; estClase = 'pend';
    }

    const badgeRezagado = esRezagado
      ? `<span class="op-rezagado">cargado el ${formatDDMM(pickup.fecha)}</span>`
      : '';

    return `<div class="op-card standalone-pickup${despachado ? ' despachado' : ''}${esRezagado ? ' rezagado' : ''}" data-pickup-id="${pickup.id}">
      <div class="op-stripe st-${estClase}"></div>
      <div class="op-main">
        <div class="op-top">
          <span class="op-cliente">${escHtml(pickup.cliente_nombre)}</span>
          <span class="op-estado est-${estClase}"><i></i>${est}</span>
          ${badgeRezagado}
        </div>
        ${(tipo === 'ninguna' || !pickup.direccion)
          ? ''
          : `<div class="op-dir">${PIN}<span>${escHtml(pickup.direccion)}</span></div>`}
        <input type="text" class="op-nota" placeholder="Nota…"
          value="${escHtml(pickup.titulo || '')}" data-pickup-titulo="${pickup.id}">
        <div class="op-acciones">
          <button type="button" class="op-link" data-add-cuadrante-pickup="${pickup.id}">+ Agregar cuadrante</button>
          ${(tipo === 'ninguna')
            ? `<button type="button" class="op-link danger" data-borrar-suelto="${pickup.id}">Quitar</button>`
            : ''}
        </div>
      </div>
      <div class="op-side">
        ${renderPasos('pickup', pickup)}
      </div>
    </div>`;
  }

  // ── Helpers de render ─────────────────────────────────

  const TILDE = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  // Los 4 checks como pasos en línea. Sigue siendo un <input type="checkbox"> (oculto):
  // el CSS pinta el paso con :has(:checked), así que tildar no necesita re-render.
  function renderPasos(tipo, item) {
    return `<div class="op-pasos">
      ${renderCheck(tipo, item.id, 'check_datos', item.check_datos, 'Datos')}
      ${renderCheck(tipo, item.id, 'check_guia', item.check_guia, 'Guía')}
      ${renderCheck(tipo, item.id, 'check_proforma', item.check_proforma, 'Proforma')}
      ${renderCheck(tipo, item.id, 'check_despachado', item.check_despachado, 'Despachado')}
    </div>`;
  }

  function renderCheck(tipo, itemId, campo, valor, label) {
    const checked = Number(valor) === 1 ? 'checked' : '';
    const titulos = { check_datos: 'Datos completos', check_guia: 'Guía aérea', check_proforma: 'Proforma', check_despachado: 'Despachado' };
    return `<label class="op-paso paso-${campo.replace('check_', '')}" title="${titulos[campo] || label}">
      <input type="checkbox" ${checked}
        data-tipo="${tipo}" data-item-id="${itemId}" data-campo="${campo}">
      <span class="op-paso-ico">${TILDE}</span>${escHtml(label)}
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
        actualizarProgreso();
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
      if (campo === 'check_despachado') renderLista();
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

  // ── Envíos SIN pickup (pedido de operaciones, 26/08) ──────────────────────────
  // El caso típico es una importación: no la pasa a buscar nadie, así que no existe en
  // Pickups, pero operaciones la necesita acá para seguir si están los datos, la guía y
  // la proforma. Por dentro es un pickup de tipo 'ninguna' (reusa los checks y el
  // arrastre de rezagados); la pantalla de Pickups nunca lo muestra.

  function bindSueltos() {
    opsList.querySelectorAll('[data-borrar-suelto]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('¿Quitar este envío de operaciones? No afecta nada más: solo existe acá.')) return;
        try {
          await NovaAPI.operaciones.borrarSuelto(Number(btn.dataset.borrarSuelto));
          await cargarDia(fechaActual);
        } catch (e) {
          NovaUtils.showAlert(alertBox, 'No se pudo quitar: ' + e.message);
        }
      });
    });
  }

  let clientesCargados = false;
  async function abrirFormSuelto() {
    const form = document.getElementById('form-suelto');
    if (!clientesCargados) {
      // Los clientes se piden recién la primera vez que alguien abre el formulario:
      // la pantalla de operaciones no los necesita para nada más.
      const sel = document.getElementById('suelto-cliente');
      const clientes = await NovaAPI.clientes.listar();
      sel.innerHTML = clientes
        .map((c) => `<option value="${c.id}">${escHtml(c.nombre_nova || c.nombre)}</option>`)
        .join('');
      clientesCargados = true;
    }
    form.classList.remove('hidden');
    form.style.display = 'flex';
    document.getElementById('suelto-titulo').value = '';
    document.getElementById('suelto-titulo').focus();
  }

  function cerrarFormSuelto() {
    const form = document.getElementById('form-suelto');
    form.classList.add('hidden');
    form.style.display = 'none';
  }

  async function crearSuelto() {
    const btn = document.getElementById('btn-crear-suelto');
    btn.disabled = true;
    try {
      await NovaAPI.operaciones.crearSuelto({
        cliente_id: Number(document.getElementById('suelto-cliente').value),
        fecha: toYMD(fechaActual),
        titulo: document.getElementById('suelto-titulo').value.trim() || null,
      });
      cerrarFormSuelto();
      await cargarDia(fechaActual);
    } catch (e) {
      NovaUtils.showAlert(alertBox, 'No se pudo agregar: ' + e.message);
    } finally {
      btn.disabled = false;
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

  document.getElementById('btn-nuevo-suelto').addEventListener('click', abrirFormSuelto);
  document.getElementById('btn-cancelar-suelto').addEventListener('click', cerrarFormSuelto);
  document.getElementById('btn-crear-suelto').addEventListener('click', crearSuelto);
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
