/* ═══════════════════════════════════════════════════════════════════════════════════
   CLIENTES — la lista y el alta / edición (rediseño 17/09/2026, ítem 5 de estética).

   Lo que cambió respecto de la versión anterior, además del dibujo:
   - La columna "Margen" ya no muestra `tarifa_pct` pelado: dice "75 %", "75 % + matriz"
     o "por kilo", según lo que el servidor cuenta en `matriz_celdas` / `kg_celdas`.
     Pedido de Felipe: "si edito las tarifas y dejo un profit diferente a 75, me sigue
     marcando 75 arriba".
   - Los datos que van a la GUÍA (teléfono, localidad, provincia, CP) son una sección
     aparte con "Usar los mismos datos"; no son obligatorios en el alta.
   - Eliminar solo si el cliente no dejó rastro; si tiene envíos, guías, liquidaciones o
     pickups, el sistema ofrece DESACTIVAR. Los inactivos se ven con el filtro.
   - Los campos vaciados se guardan vacíos (antes el servidor no dejaba borrar un CUIT).
   - Todo lo que viene de la base se escapa antes de ir al HTML.
   ═══════════════════════════════════════════════════════════════════════════════════ */
(function () {
  const alertBox = document.getElementById('alert-box');
  const formPanel = document.getElementById('form-panel');
  const formTitle = document.getElementById('form-title');
  const formCliente = document.getElementById('form-cliente');
  const clienteIdInput = document.getElementById('cliente-id');
  const tabla = document.getElementById('tabla-clientes');

  let clientes = [];
  let modoEdicion = false;
  // Lo tipeado en el buscador. La lista se filtra en memoria mientras se escribe: con
  // ~100 clientes no hay nada que pedirle al servidor.
  let busqueda = '';
  let filtroCobro = '';
  let filtroEstado = 'activos';
  let filtroMargen = 'todos';

  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function init() {
    await cargarClientes();
    bindBtnNuevo();
    bindBtnCancelar();
    bindForm();
    bindBuscador();
    bindFiltros();
    bindCopiarGuia();
  }

  // Sin tildes y en minúsculas, para que "Perez" encuentre a "PÉREZ" — el mismo criterio
  // que canonizarPais en el motor: lo que uno tipea rara vez coincide letra por letra.
  function normalizar(s) {
    return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // "75 %", "75 % + matriz", "por kilo" o "sin margen". Es lo que la oficina necesita
  // leer de un vistazo; el detalle está en el perfil.
  function margenDe(c) {
    const pct = Number(c.tarifa_pct) || 0;
    const celdas = Number(c.matriz_celdas) || 0;
    const kg = Number(c.kg_celdas) || 0;
    if (c.modo_tarifa === 'por_kg' || kg > 0) {
      return { texto: 'por kilo', clase: 'kg', sin: false, titulo: `${kg} precio(s) por kilo cargado(s)${celdas ? ` · ${celdas} celda(s) de % para lo que no cubre` : ''}` };
    }
    if (celdas > 0) {
      return { texto: `${pct} % + matriz`, clase: 'matriz', sin: false, titulo: `${pct} % general y ${celdas} celda(s) propia(s) por servicio / zona / peso` };
    }
    if (pct > 0) return { texto: `${pct} %`, clase: '', sin: false, titulo: 'Un solo % para todo' };
    return { texto: 'sin margen', clase: 'sin-margen', sin: true, titulo: 'Sin % general, sin matriz y sin precio por kilo: cotiza al costo' };
  }

  function clientesFiltrados() {
    const q = normalizar(busqueda).trim();
    const palabras = q ? q.split(/\s+/) : [];
    return clientes.filter((c) => {
      if (filtroEstado === 'activos' && !c.activo) return false;
      if (filtroEstado === 'inactivos' && c.activo) return false;
      if (filtroCobro && c.tipo_cobro !== filtroCobro) return false;
      if (filtroMargen === 'sin' && !margenDe(c).sin) return false;
      if (!palabras.length) return true;
      // Cada palabra tipeada tiene que aparecer en ALGÚN campo (en cualquiera): "perez cc"
      // encuentra al Pérez de cuenta corriente sin exigir que estén juntos en el mismo campo.
      const pajar = normalizar([c.nombre, c.nombre_nova, c.cuit, c.contacto, c.email, c.localidad,
        c.provincia, c.whatsapp, c.telefono].filter(Boolean).join(' '));
      return palabras.every((p) => pajar.includes(p));
    });
  }

  function bindBuscador() {
    const input = document.getElementById('buscador-clientes');
    if (!input) return;
    input.addEventListener('input', () => { busqueda = input.value; renderTabla(); });
    // Escape limpia y devuelve la lista entera, sin sacar el foco del campo.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; busqueda = ''; renderTabla(); }
    });
  }

  function bindFiltros() {
    document.getElementById('filtro-cobro').addEventListener('change', (e) => { filtroCobro = e.target.value; renderTabla(); });
    const segmentos = (contId, attr, setter) => {
      const cont = document.getElementById(contId);
      cont.querySelectorAll('.cli-seg').forEach((b) => b.addEventListener('click', () => {
        cont.querySelectorAll('.cli-seg').forEach((x) => x.classList.toggle('on', x === b));
        setter(b.dataset[attr]);
        renderTabla();
      }));
    };
    segmentos('filtro-estado', 'estado', (v) => { filtroEstado = v; });
    segmentos('filtro-margen', 'margen', (v) => { filtroMargen = v; });
  }

  async function cargarClientes() {
    try {
      // ?todos=1: la lista de Clientes es el único lugar que ve a los inactivos.
      clientes = await NovaAPI.clientes.listar({ todos: 1 });
      renderTabla();
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar clientes: ' + err.message);
    }
  }

  function renderPill() {
    const pill = document.getElementById('cli-pill');
    if (!pill) return;
    const activos = clientes.filter((c) => c.activo);
    const sinMargen = activos.filter((c) => margenDe(c).sin).length;
    pill.textContent = activos.length
      ? `${activos.length} cliente${activos.length === 1 ? '' : 's'}${sinMargen ? ` · ${sinMargen} sin margen` : ''}`
      : '';
  }

  function renderTabla() {
    const lista = clientesFiltrados();
    const cuenta = document.getElementById('buscador-cuenta');
    renderPill();
    if (cuenta) {
      const filtrado = busqueda.trim() || filtroCobro || filtroEstado !== 'activos' || filtroMargen !== 'todos';
      cuenta.textContent = filtrado ? `${lista.length} de ${clientes.length}` : `${lista.length} clientes`;
    }
    if (!clientes.length) {
      tabla.innerHTML = '<tr><td colspan="8" class="empty">No hay clientes registrados.</td></tr>';
      return;
    }
    if (!lista.length) {
      tabla.innerHTML = '<tr><td colspan="8" class="empty">Ningún cliente coincide con la búsqueda.</td></tr>';
      return;
    }
    tabla.innerHTML = lista.map((c) => {
      const m = margenDe(c);
      const contacto = [c.email, c.whatsapp].filter(Boolean).map(esc).join(' · ');
      return `
      <tr class="${c.activo ? '' : 'inactivo'}" data-cliente-id="${c.id}">
        <td class="cli-nombre">
          <a href="clientes-perfil.html?id=${c.id}">${esc(c.nombre_nova || c.nombre)}</a>
          ${c.nombre_nova ? `<span class="cli-sub">${esc(c.nombre)}</span>` : ''}
        </td>
        <td class="cuit">${esc(c.cuit || '—')}</td>
        <td class="cli-contacto">${esc(c.contacto || '—')}${contacto ? `<small>${contacto}</small>` : ''}</td>
        <td>${esc(c.localidad || '—')}</td>
        <td><span class="cli-chip cobro">${esc(NovaUtils.tipoCobroLabel(c.tipo_cobro))}</span></td>
        <td class="n"><span class="cli-chip ${m.clase}" title="${esc(m.titulo)}">${esc(m.texto)}</span></td>
        <td>${c.activo ? '<span class="cli-chip activo">Activo</span>' : '<span class="cli-chip inactivo">Inactivo</span>'}</td>
        <td class="acciones">
          <a class="btn btn-sm btn-outline" href="clientes-perfil.html?id=${c.id}">Perfil</a>
          <a class="btn btn-sm btn-outline" href="cotizador.html?cliente=${c.id}" title="Abre el cotizador con este cliente elegido">Cotizar</a>
          <button type="button" class="btn btn-sm btn-outline" data-id="${c.id}" data-action="editar">Editar</button>
          ${c.activo
            ? `<button type="button" class="btn btn-sm btn-peligro" data-id="${c.id}" data-action="desactivar" title="Lo saca de los selectores; conserva todo su historial">Desactivar</button>`
            : `<button type="button" class="btn btn-sm btn-outline" data-id="${c.id}" data-action="activar">Activar</button>
               <button type="button" class="btn btn-sm btn-peligro" data-id="${c.id}" data-action="eliminar" title="Solo si no tiene envíos, guías ni liquidaciones">Eliminar</button>`}
        </td>
      </tr>`;
    }).join('');

    tabla.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const a = btn.dataset.action;
        if (a === 'editar') abrirEdicion(id);
        else if (a === 'eliminar') confirmarEliminar(id);
        else if (a === 'desactivar') cambiarActivo(id, false);
        else if (a === 'activar') cambiarActivo(id, true);
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
      document.getElementById('f-razon_social').focus();
    });
  }

  function bindBtnCancelar() {
    document.getElementById('btn-cancelar').addEventListener('click', () => {
      formPanel.classList.add('hidden');
      limpiarForm();
    });
  }

  // "Usar los mismos datos": la dirección de recolección suele ser la del remitente. Se
  // copia lo que tiene sentido copiar; nada se pisa si el campo ya tiene algo.
  function bindCopiarGuia() {
    const btn = document.getElementById('btn-copiar-guia');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const pares = [['f-whatsapp', 'f-telefono']];
      let copiados = 0;
      pares.forEach(([de, a]) => {
        const src = document.getElementById(de).value.trim();
        const dst = document.getElementById(a);
        if (src && !dst.value.trim()) { dst.value = src; copiados += 1; }
      });
      // De "Av. Mitre 2450, Munro" se intenta sacar la localidad (lo que va después de la
      // última coma) si el campo está vacío.
      const dir = document.getElementById('f-direccion_recoleccion').value.trim();
      const loc = document.getElementById('f-localidad');
      if (dir && !loc.value.trim() && dir.includes(',')) {
        loc.value = dir.slice(dir.lastIndexOf(',') + 1).trim();
        copiados += 1;
      }
      NovaUtils.showAlert(alertBox, copiados ? `Se copiaron ${copiados} dato(s). Revisá provincia y código postal.` : 'No había nada para copiar: cargá WhatsApp y dirección primero.', copiados ? 'success' : 'info');
    });
  }

  function bindForm() {
    formCliente.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = getFormData();
      const btn = document.getElementById('btn-guardar-cliente');
      btn.disabled = true;
      try {
        if (modoEdicion) {
          await NovaAPI.clientes.actualizar(clienteIdInput.value, data);
          NovaUtils.showAlert(alertBox, 'Cliente actualizado', 'success');
        } else {
          const nuevo = await NovaAPI.clientes.crear(data);
          NovaUtils.showAlert(alertBox, `Cliente creado. <a href="clientes-perfil.html?id=${nuevo.id}">Abrir el perfil</a> para cargar su matriz de tarifas.`, 'success');
        }
        formPanel.classList.add('hidden');
        limpiarForm();
        await cargarClientes();
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      } finally {
        btn.disabled = false;
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
    setField('f-plazo_pago_dias', c.plazo_pago_dias != null ? c.plazo_pago_dias : '');
    setField('f-tipo_cambio', c.tipo_cambio || 'venta');
    setField('f-contacto', c.contacto || '');
    setField('f-email', c.email || '');
    setField('f-whatsapp', c.whatsapp || '');
    setField('f-codigo_postal', c.codigo_postal || '');
    setField('f-localidad', c.localidad || '');
    setField('f-provincia', c.provincia || '');
    setField('f-telefono', c.telefono || '');
    setField('f-direccion_recoleccion', c.direccion_recoleccion || '');
    formPanel.classList.remove('hidden');
    formPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function cambiarActivo(id, activo) {
    const c = clientes.find((x) => x.id === id);
    if (!c) return;
    const nombre = c.nombre_nova || c.nombre;
    if (!activo && !confirm(`¿Desactivar a "${nombre}"?\n\nDeja de aparecer en los selectores del sistema (Cargar envío, Liquidaciones, Cotizador). Su historial se conserva y se puede volver a activar desde el filtro "Inactivos".`)) return;
    try {
      await NovaAPI.clientes.activar(id, activo);
      NovaUtils.showAlert(alertBox, activo ? `"${esc(nombre)}" vuelve a estar activo.` : `"${esc(nombre)}" quedó inactivo.`, 'success');
      await cargarClientes();
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message);
    }
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
      // 409: tiene historial. El servidor dice qué, y la salida es desactivarlo.
      NovaUtils.showAlert(alertBox, err.message);
    }
  }

  // Los campos de texto viajan SIEMPRE (vacío = ''): así el servidor los puede vaciar.
  function getFormData() {
    const v = (id) => document.getElementById(id).value.trim();
    return {
      razon_social: v('f-razon_social'),
      nombre_nova: v('f-nombre_nova'),
      cuit: v('f-cuit'),
      tipo_cobro: v('f-tipo_cobro'),
      tarifa_pct: parseFloat(v('f-tarifa_pct')) || 0,
      tipo_facturacion: v('f-tipo_facturacion'),
      plazo_pago_dias: v('f-plazo_pago_dias') === '' ? null : parseInt(v('f-plazo_pago_dias'), 10),
      tipo_cambio: v('f-tipo_cambio') || 'venta',
      contacto: v('f-contacto'),
      email: v('f-email'),
      whatsapp: v('f-whatsapp'),
      codigo_postal: v('f-codigo_postal'),
      localidad: v('f-localidad'),
      provincia: v('f-provincia'),
      telefono: v('f-telefono'),
      direccion_recoleccion: v('f-direccion_recoleccion'),
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
