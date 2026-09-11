// Módulo Guías (etapa 2, 08/09/2026 — GUIAS-UPS.md 3-bis).
//
// Pide la guía a UPS con los datos del sistema (cliente = remitente, destinatario de la
// libreta, contenido, renglones de la proforma, bultos, servicio, DDP), muestra los
// documentos (etiqueta térmica / A4, proforma) y deja la guía como PRECARGA para que
// administración la confirme desde Cargar envío.
(function () {
  const alertBox = document.getElementById('alert-box');
  let clientes = [];
  let destinatarios = [];
  let config = null;
  let clienteActual = null;
  let destEditando = null;
  let remitentes = [];
  let remEditando = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let borradorActual = null; // id del borrador que se está retomando (11/09)

  async function init() {
    $('g-fecha').value = NovaUtils.hoyLocal();
    $('gui-f-fecha').value = NovaUtils.hoyLocal();
    await Promise.all([loadConfig(), loadClientes()]);
    rellenarPaises();
    bindTabs();
    bindForm();
    bindModalDest();
    bindModalRem();
    bindListado();
    bindTituloProforma();
    mostrarProximaProforma();
    agregarItem();
    agregarBulto();
    bindBorradores();
    contarBorradores();
    // ?cliente=ID desde otra pantalla
    const q = new URLSearchParams(location.search);
    if (q.get('cliente')) {
      $('g-cliente').value = q.get('cliente');
      await onClienteChange();
    }
  }

  async function loadConfig() {
    try {
      config = await NovaAPI.guias.configuracion();
    } catch (e) {
      config = { entorno: 'test', cuenta: '', mock: false, shipper_completo: false };
    }
    const chip = $('gui-entorno');
    if (config.mock) {
      chip.textContent = 'SIMULADO (sin UPS)';
      chip.classList.add('mock');
    } else if (config.entorno === 'prod') {
      chip.textContent = `UPS producción · cuenta ${config.cuenta}`;
      chip.classList.add('prod');
    } else {
      chip.textContent = 'UPS entorno de PRUEBA · las guías no sirven para despachar';
    }
  }

  async function loadClientes() {
    clientes = await NovaAPI.clientes.listar();
    const sel = $('g-cliente');
    sel.innerHTML = '<option value="">Seleccioná un cliente</option>';
    for (const c of clientes) {
      if (c.activo === 0) continue;
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.nombre_nova || c.nombre;
      sel.appendChild(opt);
    }
  }

  function rellenarPaises() {
    const sel = $('d-pais');
    const paises = [...new Set(Object.keys(typeof ZONAS_UPS !== 'undefined' ? ZONAS_UPS : {}))].sort();
    sel.innerHTML = '<option value="">Seleccioná país</option>';
    for (const p of paises) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      sel.appendChild(opt);
    }
  }

  function bindTabs() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const name = tab.dataset.tab;
        $('panel-nueva').classList.toggle('hidden', name !== 'nueva');
        $('panel-resultado').classList.add('hidden');
        $('panel-listado').classList.toggle('hidden', name !== 'listado');
        $('panel-borradores').classList.toggle('hidden', name !== 'borradores');
        if (name === 'listado') loadListado();
        if (name === 'borradores') loadBorradores();
      });
    });
  }

  // ── Cliente y remitente ────────────────────────────────────────────────────
  async function onClienteChange() {
    const id = parseInt($('g-cliente').value, 10);
    clienteActual = clientes.find((c) => c.id === id) || null;
    await Promise.all([loadRemitentes(), loadDestinatarios()]);
  }

  // ── Libreta de remitentes (la ficha del cliente + perfiles propios) ────────
  async function loadRemitentes(seleccionar) {
    const sel = $('g-remitente-sel');
    if (!clienteActual) {
      remitentes = [];
      sel.innerHTML = '<option value="">— Elegí un cliente primero —</option>';
      pintarRemitente();
      return;
    }
    remitentes = await NovaAPI.clientes.remitentes.listar(clienteActual.id);
    sel.innerHTML = '';
    for (const r of remitentes) {
      const opt = document.createElement('option');
      opt.value = r.id == null ? '' : String(r.id);
      opt.textContent = r.principal ? `${r.nombre} (ficha del cliente)` : r.nombre;
      sel.appendChild(opt);
    }
    sel.value = seleccionar ? String(seleccionar) : '';
    pintarRemitente();
  }

  function remSeleccionado() {
    const v = $('g-remitente-sel').value;
    if (!clienteActual) return null;
    if (!v) return remitentes.find((r) => r.principal) || null;
    return remitentes.find((r) => String(r.id) === v) || null;
  }

  // Ficha con cada dato rotulado (pedido de administración, 08/09: "que se puedan
  // visualizar aunque se completen solos"). Lo que falta va en ámbar.
  function fichaHtml(campos) {
    return `<div class="gui-ficha">${campos.map(([rotulo, valor, obligatorio]) => `
      <div class="gui-ficha-campo${!valor && obligatorio ? ' falta' : ''}">
        <span class="k">${esc(rotulo)}</span>
        <span class="v">${valor ? esc(valor) : (obligatorio ? 'falta' : '—')}</span>
      </div>`).join('')}</div>`;
  }

  function pintarRemitente() {
    const box = $('g-remitente');
    const r = remSeleccionado();
    $('g-rem-editar').classList.toggle('hidden', !r || r.principal);
    if (!r) { box.innerHTML = ''; box.classList.remove('falta'); return; }
    const faltan = [];
    if (!r.direccion) faltan.push('dirección');
    if (!r.ciudad) faltan.push('localidad');
    if (!r.codigo_postal) faltan.push('código postal');
    if (!r.cuit) faltan.push('CUIT (para la proforma)');
    if (!r.telefono) faltan.push('teléfono');
    const donde = r.principal
      ? `<a href="clientes-perfil.html?id=${clienteActual.id}">completar en el cliente</a>`
      : 'con el botón Editar';
    box.innerHTML = fichaHtml([
      ['Nombre', r.nombre, true], ['CUIT', r.cuit, true], ['Dirección', r.direccion, true],
      ['CP', r.codigo_postal, true], ['Localidad', r.ciudad, true], ['Provincia', r.provincia, false],
      ['Teléfono', r.telefono, true], ['Contacto', r.contacto, false], ['E-mail', r.email, false],
    ]) + (faltan.length ? `<div class="gui-ficha-aviso">Falta ${esc(faltan.join(', '))} — ${donde}.</div>` : '');
    box.classList.toggle('falta', faltan.length > 0);
    pintarResumen();
  }

  function abrirModalRem(r) {
    remEditando = r || null;
    $('modal-rem-title').textContent = r ? 'Editar remitente' : 'Nuevo remitente';
    $('r-nombre').value = r?.nombre || '';
    $('r-cuit').value = r?.cuit || '';
    $('r-direccion').value = r?.direccion || '';
    $('r-cp').value = r?.codigo_postal || '';
    $('r-ciudad').value = r?.ciudad || '';
    $('r-provincia').value = r?.provincia || '';
    $('r-telefono').value = r?.telefono || '';
    $('r-contacto').value = r?.contacto || '';
    $('r-email').value = r?.email || '';
    $('r-errores').classList.add('hidden');
    $('modal-rem-borrar').classList.toggle('hidden', !r);
    $('modal-rem').classList.remove('hidden');
    $('r-nombre').focus();
  }

  function cerrarModalRem() {
    $('modal-rem').classList.add('hidden');
    remEditando = null;
  }

  async function guardarRem() {
    const data = {
      nombre: $('r-nombre').value.trim(),
      cuit: $('r-cuit').value.trim(),
      direccion: $('r-direccion').value.trim(),
      codigo_postal: $('r-cp').value.trim(),
      ciudad: $('r-ciudad').value.trim(),
      provincia: $('r-provincia').value.trim(),
      telefono: $('r-telefono').value.trim(),
      contacto: $('r-contacto').value.trim(),
      email: $('r-email').value.trim(),
    };
    const faltan = [];
    if (!data.nombre) faltan.push('el nombre');
    if (!data.direccion) faltan.push('la dirección');
    if (!data.codigo_postal) faltan.push('el código postal');
    if (!data.ciudad) faltan.push('la localidad');
    const errBox = $('r-errores');
    if (faltan.length) {
      errBox.textContent = `Falta ${faltan.join(', ')}.`;
      errBox.classList.remove('hidden');
      return;
    }
    try {
      let r;
      if (remEditando) r = await NovaAPI.clientes.remitentes.actualizar(clienteActual.id, remEditando.id, data);
      else r = await NovaAPI.clientes.remitentes.crear(clienteActual.id, data);
      cerrarModalRem();
      await loadRemitentes(r.id);
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove('hidden');
    }
  }

  function bindModalRem() {
    $('g-rem-nuevo').addEventListener('click', () => {
      if (!clienteActual) { NovaUtils.showAlert(alertBox, 'Elegí el cliente primero', 'error'); return; }
      abrirModalRem(null);
    });
    $('g-rem-editar').addEventListener('click', () => { const r = remSeleccionado(); if (r && !r.principal) abrirModalRem(r); });
    $('modal-rem-close').addEventListener('click', cerrarModalRem);
    $('modal-rem-cancelar').addEventListener('click', cerrarModalRem);
    $('modal-rem-guardar').addEventListener('click', guardarRem);
    $('modal-rem-borrar').addEventListener('click', async () => {
      if (!remEditando) return;
      if (!window.confirm(`¿Sacar el remitente "${remEditando.nombre}" de la libreta? Las guías ya emitidas lo siguen viendo.`)) return;
      try {
        await NovaAPI.clientes.remitentes.borrar(clienteActual.id, remEditando.id);
        cerrarModalRem();
        await loadRemitentes();
      } catch (e) {
        NovaUtils.showAlert(alertBox, e.message, 'error');
      }
    });
    $('g-remitente-sel').addEventListener('change', pintarRemitente);
  }

  // ── Libreta de destinatarios ───────────────────────────────────────────────
  async function loadDestinatarios(seleccionar) {
    const sel = $('g-destinatario');
    if (!clienteActual) {
      destinatarios = [];
      sel.innerHTML = '<option value="">— Elegí un cliente primero —</option>';
      pintarDestinatario();
      return;
    }
    destinatarios = await NovaAPI.clientes.destinatarios.listar(clienteActual.id);
    sel.innerHTML = destinatarios.length
      ? '<option value="">Elegí un destinatario</option>'
      : '<option value="">La libreta está vacía: cargá el primero</option>';
    for (const d of destinatarios) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.nombre} — ${[d.ciudad, d.pais].filter(Boolean).join(', ')}`;
      sel.appendChild(opt);
    }
    if (seleccionar) sel.value = String(seleccionar);
    else if (destinatarios.length === 1) sel.value = String(destinatarios[0].id);
    pintarDestinatario();
  }

  function destSeleccionado() {
    const id = parseInt($('g-destinatario').value, 10);
    return destinatarios.find((d) => d.id === id) || null;
  }

  function pintarDestinatario() {
    const d = destSeleccionado();
    const ficha = $('g-dest-ficha');
    $('g-dest-editar').classList.toggle('hidden', !d);
    if (!d) { ficha.innerHTML = ''; return; }
    const esNA = /^(Estados Unidos|USA|Canad[aá])$/i.test(String(d.pais || ''));
    ficha.innerHTML = fichaHtml([
      ['Nombre', d.nombre, true], ['Contacto', d.contacto, false],
      ['Dirección', [d.direccion1, d.direccion2, d.direccion3].filter(Boolean).join(', '), true],
      ['CP', d.codigo_postal, esNA], ['Ciudad', d.ciudad, true], ['Estado / prov.', d.estado, esNA],
      ['País', d.pais, true], ['Teléfono', d.telefono, true], ['E-mail', d.email, false], ['Tax ID', d.tax_id, false],
    ]);
    pintarResumen();
  }

  function abrirModalDest(d) {
    destEditando = d || null;
    $('modal-dest-title').textContent = d ? 'Editar destinatario' : 'Nuevo destinatario';
    $('d-nombre').value = d?.nombre || '';
    $('d-contacto').value = d?.contacto || '';
    $('d-direccion1').value = d?.direccion1 || '';
    $('d-direccion2').value = d?.direccion2 || '';
    $('d-ciudad').value = d?.ciudad || '';
    $('d-estado').value = d?.estado || '';
    $('d-cp').value = d?.codigo_postal || '';
    $('d-pais').value = d?.pais || '';
    $('d-telefono').value = d?.telefono || '';
    $('d-email').value = d?.email || '';
    $('d-taxid').value = d?.tax_id || '';
    $('d-errores').classList.add('hidden');
    $('modal-dest-borrar').classList.toggle('hidden', !d);
    $('modal-dest').classList.remove('hidden');
    $('d-nombre').focus();
  }

  function cerrarModalDest() {
    $('modal-dest').classList.add('hidden');
    destEditando = null;
  }

  function bindModalDest() {
    $('g-dest-nuevo').addEventListener('click', () => {
      if (!clienteActual) { NovaUtils.showAlert(alertBox, 'Elegí el cliente primero', 'error'); return; }
      abrirModalDest(null);
    });
    $('g-dest-editar').addEventListener('click', () => { const d = destSeleccionado(); if (d) abrirModalDest(d); });
    $('modal-dest-close').addEventListener('click', cerrarModalDest);
    $('modal-dest-cancelar').addEventListener('click', cerrarModalDest);
    $('modal-dest-guardar').addEventListener('click', guardarDest);
    $('modal-dest-borrar').addEventListener('click', async () => {
      if (!destEditando) return;
      if (!window.confirm(`¿Sacar a "${destEditando.nombre}" de la libreta? Las guías ya emitidas lo siguen viendo.`)) return;
      try {
        await NovaAPI.clientes.destinatarios.borrar(clienteActual.id, destEditando.id);
        cerrarModalDest();
        await loadDestinatarios();
      } catch (e) {
        NovaUtils.showAlert(alertBox, e.message, 'error');
      }
    });
    $('g-destinatario').addEventListener('change', pintarDestinatario);
    $('g-cliente').addEventListener('change', onClienteChange);
  }

  async function guardarDest() {
    const data = {
      nombre: $('d-nombre').value.trim(),
      contacto: $('d-contacto').value.trim(),
      direccion1: $('d-direccion1').value.trim(),
      direccion2: $('d-direccion2').value.trim(),
      ciudad: $('d-ciudad').value.trim(),
      estado: $('d-estado').value.trim().toUpperCase(),
      codigo_postal: $('d-cp').value.trim(),
      pais: $('d-pais').value,
      telefono: $('d-telefono').value.trim(),
      email: $('d-email').value.trim(),
      tax_id: $('d-taxid').value.trim(),
    };
    const faltan = [];
    if (!data.nombre) faltan.push('el nombre');
    if (!data.direccion1) faltan.push('la dirección');
    if (!data.ciudad) faltan.push('la ciudad');
    if (!data.pais) faltan.push('el país');
    if (!data.telefono) faltan.push('el teléfono (UPS lo exige)');
    const errBox = $('d-errores');
    if (faltan.length) {
      errBox.innerHTML = `Falta ${esc(faltan.join(', '))}.`;
      errBox.classList.remove('hidden');
      return;
    }
    try {
      let d;
      if (destEditando) d = await NovaAPI.clientes.destinatarios.actualizar(clienteActual.id, destEditando.id, data);
      else d = await NovaAPI.clientes.destinatarios.crear(clienteActual.id, data);
      cerrarModalDest();
      await loadDestinatarios(d.id);
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove('hidden');
    }
  }

  // ── Renglones de la proforma ───────────────────────────────────────────────
  function agregarItem(it) {
    const tb = $('g-items').querySelector('tbody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="number" class="n" data-f="cantidad" min="0" step="1" value="${it?.cantidad ?? 1}"></td>
      <td><input type="text" data-f="descripcion" maxlength="60" value="${esc(it?.descripcion || '')}" placeholder="Leather hides"></td>
      <td><input type="number" class="n" data-f="valor_unitario" min="0" step="0.01" value="${it?.valor_unitario ?? ''}"></td>
      <td class="total">0.00</td>
      <td><button type="button" class="gui-quitar" title="Quitar">✕</button></td>`;
    tr.querySelector('.gui-quitar').addEventListener('click', () => { tr.remove(); recalcItems(); });
    tr.querySelectorAll('input').forEach((i) => i.addEventListener('input', recalcItems));
    tb.appendChild(tr);
    recalcItems();
  }

  function leerItems() {
    return [...$('g-items').querySelectorAll('tbody tr')].map((tr) => ({
      cantidad: parseFloat(tr.querySelector('[data-f="cantidad"]').value) || 0,
      descripcion: tr.querySelector('[data-f="descripcion"]').value.trim(),
      valor_unitario: parseFloat(tr.querySelector('[data-f="valor_unitario"]').value) || 0,
    })).filter((it) => it.descripcion);
  }

  function recalcItems() {
    let total = 0;
    $('g-items').querySelectorAll('tbody tr').forEach((tr) => {
      const c = parseFloat(tr.querySelector('[data-f="cantidad"]').value) || 0;
      const v = parseFloat(tr.querySelector('[data-f="valor_unitario"]').value) || 0;
      const t = Math.round(c * v * 100) / 100;
      tr.querySelector('.total').textContent = money(t);
      total += t;
    });
    $('g-items-total').textContent = money(total);
    pintarResumen();
  }

  // ── Bultos ────────────────────────────────────────────────────────────────
  function agregarBulto(b) {
    const tb = $('g-bultos').querySelector('tbody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="num"></td>
      <td><input type="number" data-f="peso_real" min="0" step="0.1" value="${b?.peso_real ?? ''}" placeholder="kg"></td>
      <td><input type="number" data-f="largo" min="0" step="1" value="${b?.largo ?? ''}"></td>
      <td><input type="number" data-f="ancho" min="0" step="1" value="${b?.ancho ?? ''}"></td>
      <td><input type="number" data-f="alto" min="0" step="1" value="${b?.alto ?? ''}"></td>
      <td><button type="button" class="gui-quitar" title="Quitar">✕</button></td>`;
    tr.querySelector('.gui-quitar').addEventListener('click', () => {
      if (tb.children.length <= 1) return;
      tr.remove();
      numerarBultos();
    });
    tb.appendChild(tr);
    numerarBultos();
  }

  function numerarBultos() {
    [...$('g-bultos').querySelectorAll('tbody tr')].forEach((tr, i) => { tr.querySelector('.num').textContent = i + 1; });
    pintarResumen();
  }

  function leerBultos() {
    return [...$('g-bultos').querySelectorAll('tbody tr')].map((tr) => ({
      peso_real: parseFloat(tr.querySelector('[data-f="peso_real"]').value) || 0,
      largo: parseFloat(tr.querySelector('[data-f="largo"]').value) || null,
      ancho: parseFloat(tr.querySelector('[data-f="ancho"]').value) || null,
      alto: parseFloat(tr.querySelector('[data-f="alto"]').value) || null,
    }));
  }

  // ── Emitir ────────────────────────────────────────────────────────────────
  function bindForm() {
    $('g-item-agregar').addEventListener('click', () => agregarItem());
    $('g-bulto-agregar').addEventListener('click', () => agregarBulto());
    $('gui-otra').addEventListener('click', () => {
      $('panel-resultado').classList.add('hidden');
      $('panel-nueva').classList.remove('hidden');
      limpiarForm();
    });
    $('form-guia').addEventListener('submit', async (e) => {
      e.preventDefault();
      await emitir();
    });
    $('gui-ver-lista').addEventListener('click', () => document.querySelector('.tab[data-tab="listado"]').click());
    // El resumen sigue al formulario.
    $('form-guia').addEventListener('input', pintarResumen);
    $('form-guia').addEventListener('change', pintarResumen);
  }

  function mostrarErrores(lista, titulo) {
    const box = $('g-errores');
    box.innerHTML = `<b>${esc(titulo)}</b><ul>${lista.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    box.classList.remove('hidden');
    box.scrollIntoView({ block: 'nearest' });
  }

  async function emitir() {
    $('g-errores').classList.add('hidden');
    const d = destSeleccionado();
    const items = leerItems();
    const bultos = leerBultos();
    const previos = [];
    if (!clienteActual) previos.push('Elegí el cliente');
    if (!d) previos.push('Elegí el destinatario (o cargá uno nuevo)');
    if (!$('g-contenido').value.trim()) previos.push('Escribí el contenido');
    if (!items.length) previos.push('Cargá al menos un renglón de la proforma (descripción y valor)');
    if (!bultos.some((b) => b.peso_real > 0)) previos.push('Cargá el peso de al menos un bulto');
    if (previos.length) { mostrarErrores(previos, 'Antes de pedir la guía:'); return; }

    const payload = {
      cliente_id: clienteActual.id,
      destinatario_id: d.id,
      remitente_id: $('g-remitente-sel').value ? Number($('g-remitente-sel').value) : null,
      fecha: $('g-fecha').value,
      servicio: $('g-servicio').value,
      ddp: $('g-ddp').checked ? 1 : 0,
      contenido: $('g-contenido').value.trim(),
      proforma_numero: $('g-proforma').value.trim() || null,
      proforma_titulo: tituloProforma(),
      items,
      bultos: bultos.filter((b) => b.peso_real > 0 || (b.largo && b.ancho && b.alto)),
      pais_destino: d.pais,
      observaciones: $('g-observaciones').value.trim() || null,
      borrador_id: borradorActual,
    };
    const btn = $('g-emitir');
    btn.disabled = true;
    $('g-estado').textContent = 'Pidiendo la guía a UPS…';
    try {
      const g = await NovaAPI.guias.emitir(payload);
      soltarBorrador();
      contarBorradores();
      mostrarResultado(g);
    } catch (err) {
      if (err.errores) mostrarErrores(err.errores, err.message);
      else NovaUtils.showAlert(alertBox, err.message, 'error');
    } finally {
      btn.disabled = false;
      $('g-estado').textContent = '';
    }
  }

  // Título de la proforma: el desplegable o, con "Otro…", lo que se escribió.
  function tituloProforma() {
    const sel = $('g-proforma-titulo');
    if (!sel) return null;
    if (sel.value === '__otro') return $('g-proforma-titulo-otro').value.trim() || null;
    return sel.value;
  }

  function bindTituloProforma() {
    const sel = $('g-proforma-titulo');
    if (!sel) return;
    sel.addEventListener('change', () => {
      const otro = $('g-proforma-titulo-otro');
      otro.classList.toggle('hidden', sel.value !== '__otro');
      if (sel.value === '__otro') otro.focus();
    });
  }

  // El próximo Nº de proforma, para que se vea qué va a poner el sistema si el campo
  // queda vacío (se cambia en Configuración).
  async function mostrarProximaProforma() {
    try {
      const r = await NovaAPI.configuracion.proforma();
      const inp = $('g-proforma');
      const hint = $('g-proforma-hint');
      if (inp) inp.placeholder = `Automático: ${r.proforma_proximo}`;
      if (hint) hint.textContent = `Si lo dejás vacío, sale el ${r.proforma_proximo} (correlativo; se ajusta en Configuración).`;
    } catch (_) { /* sin dato el campo queda "Automático" */ }
  }

  function limpiarForm() {
    $('g-contenido').value = '';
    $('g-proforma').value = '';
    if ($('g-proforma-titulo')) { $('g-proforma-titulo').value = 'COMMERCIAL INVOICE'; $('g-proforma-titulo-otro').value = ''; $('g-proforma-titulo-otro').classList.add('hidden'); }
    mostrarProximaProforma();
    $('g-observaciones').value = '';
    $('g-ddp').checked = false;
    $('g-items').querySelector('tbody').innerHTML = '';
    $('g-bultos').querySelector('tbody').innerHTML = '';
    agregarItem();
    agregarBulto();
    $('g-errores').classList.add('hidden');
    soltarBorrador();
    // Cliente y destinatario se mantienen: lo normal es emitir varias del mismo cliente.
  }

  // ── Guías en espera (borradores, pedido de administración 11/09) ───────────
  // El formulario se guarda TAL CUAL está (con lo que haya, sin validar y sin UPS) y se
  // retoma después. Se pueden dejar varias a medio hacer. Al emitir desde una, se borra.
  function leerFormulario() {
    const d = destSeleccionado();
    return {
      cliente_id: clienteActual ? clienteActual.id : null,
      remitente_id: $('g-remitente-sel').value ? Number($('g-remitente-sel').value) : null,
      destinatario_id: d ? d.id : null,
      destinatario_nombre: d ? d.nombre : null,
      fecha: $('g-fecha').value,
      servicio: $('g-servicio').value,
      ddp: $('g-ddp').checked ? 1 : 0,
      contenido: $('g-contenido').value.trim(),
      proforma_numero: $('g-proforma').value.trim() || null,
      proforma_titulo_sel: $('g-proforma-titulo') ? $('g-proforma-titulo').value : null,
      proforma_titulo_otro: $('g-proforma-titulo-otro') ? $('g-proforma-titulo-otro').value.trim() : '',
      items: [...$('g-items').querySelectorAll('tbody tr')].map((tr) => ({
        cantidad: tr.querySelector('[data-f="cantidad"]').value, descripcion: tr.querySelector('[data-f="descripcion"]').value, valor_unitario: tr.querySelector('[data-f="valor_unitario"]').value,
      })),
      bultos: leerBultos(),
      observaciones: $('g-observaciones').value.trim() || null,
    };
  }

  async function aplicarBorrador(b) {
    const x = b.datos || {};
    if (x.cliente_id) { $('g-cliente').value = String(x.cliente_id); clienteActual = clientes.find((c) => c.id === Number(x.cliente_id)) || null; await Promise.all([loadRemitentes(x.remitente_id || null), loadDestinatarios(x.destinatario_id || null)]); }
    if (x.fecha) $('g-fecha').value = x.fecha;
    if (x.servicio) $('g-servicio').value = x.servicio;
    $('g-ddp').checked = !!x.ddp;
    $('g-contenido').value = x.contenido || '';
    $('g-proforma').value = x.proforma_numero || '';
    if ($('g-proforma-titulo') && x.proforma_titulo_sel) { $('g-proforma-titulo').value = x.proforma_titulo_sel; $('g-proforma-titulo-otro').value = x.proforma_titulo_otro || ''; $('g-proforma-titulo-otro').classList.toggle('hidden', x.proforma_titulo_sel !== '__otro'); }
    $('g-observaciones').value = x.observaciones || '';
    $('g-items').querySelector('tbody').innerHTML = '';
    (x.items && x.items.length ? x.items : [null]).forEach((it) => agregarItem(it));
    $('g-bultos').querySelector('tbody').innerHTML = '';
    (x.bultos && x.bultos.length ? x.bultos : [null]).forEach((bu) => agregarBulto(bu));
    borradorActual = b.id;
    $('g-borrador-chip').classList.remove('hidden');
    $('g-errores').classList.add('hidden');
    pintarResumen();
  }

  function soltarBorrador() { borradorActual = null; $('g-borrador-chip').classList.add('hidden'); }

  async function guardarBorrador() {
    const datos = leerFormulario();
    const vacio = !datos.cliente_id && !datos.contenido && !datos.destinatario_id && !datos.items.some((i) => i.descripcion) && !datos.bultos.some((b) => b.peso_real > 0);
    if (vacio) { NovaUtils.showAlert(alertBox, 'No hay nada cargado para guardar.', 'error'); return; }
    const btn = $('g-guardar-borrador'); btn.disabled = true;
    try {
      const b = await NovaAPI.guias.borradores.guardar(datos, null, borradorActual);
      NovaUtils.showAlert(alertBox, `Guardada en espera: ${b.titulo}. La retomás desde la pestaña "En espera".`, 'success');
      soltarBorrador();
      limpiarForm();
      contarBorradores();
    } catch (e) {
      NovaUtils.showAlert(alertBox, e.message, 'error');
    } finally { btn.disabled = false; }
  }

  async function contarBorradores() {
    try { const l = await NovaAPI.guias.borradores.listar(); $('gui-badge-borradores').textContent = l.length ? String(l.length) : ''; } catch (_) { /* sin badge */ }
  }

  async function loadBorradores() {
    const lista = await NovaAPI.guias.borradores.listar();
    $('gui-badge-borradores').textContent = lista.length ? String(lista.length) : '';
    const tb = $('gui-borradores').querySelector('tbody');
    if (!lista.length) { tb.innerHTML = '<tr><td colspan="7" class="empty">No hay guías en espera.</td></tr>'; return; }
    tb.innerHTML = lista.map((b) => {
      const x = b.datos || {};
      const bultos = (x.bultos || []).filter((u) => u.peso_real > 0);
      const kg = bultos.reduce((a, u) => a + (Number(u.peso_real) || 0), 0);
      const fob = (x.items || []).reduce((a, it) => a + (parseFloat(it.cantidad) || 0) * (parseFloat(it.valor_unitario) || 0), 0);
      const cuando = (b.updated_at || b.created_at || '').slice(0, 16).replace('T', ' ');
      return `<tr data-id="${b.id}">
        <td>${esc(cuando)}</td>
        <td>${esc(b.cliente_nombre || '—')}</td>
        <td>${esc(x.destinatario_nombre || '—')}${x.contenido ? `<br><span class="gui-hint">${esc(x.contenido)}</span>` : ''}</td>
        <td class="n">${bultos.length ? `${bultos.length} × ${esc(String(Math.round(kg * 10) / 10))} kg` : '—'}</td>
        <td class="n">${fob ? money(fob) : '—'}</td>
        <td>${esc(b.usuario || '—')}</td>
        <td class="acc"><button type="button" class="btn btn-primary btn-sm" data-retomar="${b.id}">Retomar</button><button type="button" class="btn btn-secondary btn-sm" data-borrar="${b.id}">Borrar</button></td>
      </tr>`;
    }).join('');
    tb.querySelectorAll('[data-retomar]').forEach((btn) => btn.addEventListener('click', async () => {
      const b = lista.find((z) => z.id === Number(btn.dataset.retomar));
      await aplicarBorrador(b);
      document.querySelector('.tab[data-tab="nueva"]').click();
      window.scrollTo({ top: 0 });
    }));
    tb.querySelectorAll('[data-borrar]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!window.confirm('¿Borrar esta guía en espera? No se puede recuperar.')) return;
      await NovaAPI.guias.borradores.borrar(Number(btn.dataset.borrar));
      if (borradorActual === Number(btn.dataset.borrar)) soltarBorrador();
      loadBorradores();
    }));
  }

  function bindBorradores() {
    $('g-guardar-borrador').addEventListener('click', guardarBorrador);
    $('g-borrador-soltar').addEventListener('click', soltarBorrador);
  }

  // Impresión directa (termica.js): el clic manda el ZPL al plugin de UPS de esta PC.
  document.addEventListener('click', async (ev) => {
    const a = ev.target.closest('a.doc-directo[data-imprimir]');
    if (!a) return;
    ev.preventDefault();
    if (a.dataset.ocupado) return;
    a.dataset.ocupado = '1'; const txt = a.innerHTML; a.innerHTML = '<span class="ico">⏳</span>Enviando…';
    try {
      const imp = await NovaTermica.imprimirGuia(a.dataset.imprimir, { descripcion: `Etiqueta de la guía ${a.closest('tr')?.querySelector('.numero, td')?.textContent?.trim().slice(0, 20) || ''} lista` });
      if (imp === 'ventana de UPS') NovaUtils.showAlert(alertBox, 'Se abrió la ventana de UPS: elegí la impresora y apretá Imprimir ahí; después "Enviar etiqueta" (abajo a la derecha).', 'success');
      else NovaUtils.showAlert(alertBox, `Etiqueta enviada a la impresora ${imp}. Si no salió papel: botón "Impresora térmica" arriba a la derecha → Imprimir prueba.`, 'success');
    } catch (e) {
      NovaUtils.showAlert(alertBox, `No pude imprimir directo: ${e.message}. Usá "Térmica PDF 4×6".`, 'error');
    } finally { a.innerHTML = txt; delete a.dataset.ocupado; }
  });
  const btnImp = document.getElementById('gui-impresora');
  if (btnImp) btnImp.addEventListener('click', () => NovaTermica.configurar());

  function docsHtml(g, chico) {
    if (chico) {
      return `
      <a href="#" class="doc-directo" data-imprimir="${g.id}" title="Mandar la etiqueta directo a la impresora térmica (plugin de UPS)">⚡ Térmica</a>
      <a href="${NovaAPI.guias.etiquetaPdfUrl(g.id)}" target="_blank" rel="noopener" title="Etiqueta térmica en PDF de 4×6 exactas">PDF 4×6</a>
      <a href="${NovaAPI.guias.etiquetaUrl(g.id, 'termica')}" target="_blank" rel="noopener" title="Etiqueta térmica en el navegador (4×6)">Térmica</a>
      <a href="${NovaAPI.guias.etiquetaUrl(g.id, 'a4')}" target="_blank" rel="noopener" title="Etiqueta en hoja A4 (una sola hoja)">A4</a>
      <a href="${NovaAPI.guias.proformaUrl(g.id)}" target="_blank" rel="noopener" title="Proforma / commercial invoice">Proforma</a>`;
    }
    return `
      <a class="doc-termica doc-directo" href="#" data-imprimir="${g.id}" title="Sale directo de la impresora térmica, por el plugin de UPS (sin ventana de imprimir)"><span class="ico">⚡</span>Imprimir térmica <small>directo</small></a>
      <a class="doc-termica sec" href="${NovaAPI.guias.etiquetaPdfUrl(g.id)}" target="_blank" rel="noopener" title="PDF de 4×6 exactas, por si la impresión directa no anda"><span class="ico">🏷</span>Térmica <small>PDF 4×6</small></a>
      <a class="doc-a4" href="${NovaAPI.guias.etiquetaUrl(g.id, 'a4')}" target="_blank" rel="noopener"><span class="ico">📄</span>Etiqueta en A4</a>
      <a class="doc-proforma" href="${NovaAPI.guias.proformaUrl(g.id)}" target="_blank" rel="noopener"><span class="ico">🧾</span>Proforma</a>`;
  }

  // ── Resumen lateral (se actualiza con cada cambio del formulario) ──────────
  function pintarResumen() {
    const set = (k, v) => { const el = document.querySelector(`#g-resumen [data-r="${k}"]`); if (el) el.textContent = v || '—'; };
    const r = remSeleccionado();
    const d = destSeleccionado();
    set('cliente', clienteActual ? (clienteActual.nombre_nova || clienteActual.nombre) : '');
    set('remitente', r ? (r.principal ? 'La ficha del cliente' : r.nombre) : '');
    set('destino', d ? `${d.nombre} · ${[d.ciudad, d.pais].filter(Boolean).join(', ')}` : '');
    const serv = $('g-servicio');
    set('servicio', (serv.options[serv.selectedIndex]?.text || '') + ($('g-ddp').checked ? ' · DDP' : ''));
    const bultos = leerBultos();
    const kg = bultos.reduce((s2, b) => s2 + (b.peso_real || 0), 0);
    set('bultos', bultos.length ? `${bultos.length} × ${Math.round(kg * 100) / 100} kg` : '');
    set('fob', `US$ ${$('g-items-total').textContent}`);
  }

  function mostrarResultado(g) {
    $('panel-nueva').classList.add('hidden');
    const box = $('gui-resultado');
    const kg = g.bultos.reduce((s, b) => s + (b.peso_real || 0), 0);
    box.innerHTML = `
      ${g.entorno === 'test' ? '<div class="aviso-test">Guía del entorno de PRUEBA de UPS: sirve para probar el circuito, no para despachar.</div>' : ''}
      <div class="datos">
        <div class="numero">${esc(g.numero_guia || '(sin número)')}</div>
        <div><b>${esc(g.cliente_nombre)}</b>${g.remitente_nombre ? ` (remitente: ${esc(g.remitente_nombre)})` : ''} → ${esc(g.destinatario_nombre)}, ${esc([g.destinatario_ciudad, g.destinatario_pais].filter(Boolean).join(', '))}</div>
        <div>${esc(config?.servicios?.find((s) => s.codigo === g.servicio)?.nombre || g.servicio)} · ${g.bultos.length} bulto(s) · ${kg} kg · FOB US$ ${money(g.fob)}${g.ddp ? ' · DDP' : ''}</div>
        ${g.cargo_ups != null ? `<div class="gui-hint">Cargo según UPS (tarifa de lista): ${esc(g.datos.moneda || 'USD')} ${money(g.cargo_ups)}</div>` : ''}
        <div class="gui-hint">Quedó como precarga: administración la confirma desde <a href="envios.html">Cargar envío</a>.</div>
      </div>
      <div class="docs">${docsHtml(g, false)}</div>
      ${g.datos.alertas?.length ? `<div class="alertas">Avisos de UPS: ${esc(g.datos.alertas.join(' · '))}</div>` : ''}`;
    $('panel-resultado').classList.remove('hidden');
    $('panel-resultado').scrollIntoView({ block: 'start' });
  }

  // ── Listado ───────────────────────────────────────────────────────────────
  let listadoTodas = false;
  function bindListado() {
    $('gui-f-fecha').addEventListener('change', () => { listadoTodas = false; loadListado(); });
    $('gui-f-estado').addEventListener('change', loadListado);
    $('gui-f-todas').addEventListener('click', () => { listadoTodas = !listadoTodas; loadListado(); });
  }

  async function loadListado() {
    const params = {};
    if (!listadoTodas && $('gui-f-fecha').value) params.fecha = $('gui-f-fecha').value;
    if ($('gui-f-estado').value) params.estado = $('gui-f-estado').value;
    $('gui-f-todas').textContent = listadoTodas ? 'Solo esta fecha' : 'Todas las fechas';
    const lista = await NovaAPI.guias.listar(params);
    const tb = $('gui-tabla').querySelector('tbody');
    if (!lista.length) {
      tb.innerHTML = '<tr><td colspan="8" class="empty">No hay guías para mostrar.</td></tr>';
      return;
    }
    const labelEstado = { emitida: 'Para confirmar', confirmada: 'Confirmada', anulada: 'Anulada' };
    tb.innerHTML = lista.map((g) => `
      <tr data-id="${g.id}">
        <td>${esc(NovaUtils.formatDate(g.fecha))}</td>
        <td><span class="guia-num">${esc(g.numero_guia || '—')}</span>${g.entorno === 'test' ? '<span class="gui-test-chip">prueba</span>' : ''}<br><span class="gui-hint">${esc(g.servicio === 'UPS_SAV' ? 'Saver' : g.servicio === 'UPS_EXP' ? 'Expedited' : g.servicio)}${g.ddp ? ' · DDP' : ''}</span></td>
        <td>${esc(g.cliente_nombre)}${g.remitente_nombre ? `<br><span class="gui-hint">rem. ${esc(g.remitente_nombre)}</span>` : ''}</td>
        <td>${esc(g.destinatario_nombre || '—')}<br><span class="gui-hint">${esc([g.destinatario_ciudad, g.destinatario_pais].filter(Boolean).join(', '))}</span></td>
        <td class="n">${g.bultos.length} × ${esc(g.peso_real)} kg</td>
        <td class="n">${money(g.fob)}</td>
        <td><span class="gui-estado ${esc(g.estado)}">${esc(labelEstado[g.estado] || g.estado)}</span>${g.envio_id ? `<br><span class="gui-hint">envío #${g.envio_id}</span>` : ''}</td>
        <td class="docs">${g.tiene_etiqueta ? docsHtml(g, true) : `<a href="${NovaAPI.guias.proformaUrl(g.id)}" target="_blank" rel="noopener">Proforma</a>`}
          ${g.estado === 'emitida' ? `<br><a class="gui-confirmar" href="envios.html?guia=${g.id}">Confirmar →</a> · <button type="button" class="gui-quitar" data-anular="${g.id}" title="Anular la guía en UPS">Anular</button>` : ''}</td>
      </tr>`).join('');
    tb.querySelectorAll('[data-anular]').forEach((b) => b.addEventListener('click', () => anular(b.dataset.anular)));
    const hoy = NovaUtils.hoyLocal();
    const pend = lista.filter((g) => g.estado === 'emitida').length;
    $('gui-badge-dia').textContent = pend && !listadoTodas && $('gui-f-fecha').value === hoy ? String(pend) : '';
  }

  async function anular(id) {
    const nota = window.prompt('¿Anular la guía en UPS? Escribí el motivo (opcional):');
    if (nota === null) return;
    try {
      await NovaAPI.guias.anular(id, nota);
      NovaUtils.showAlert(alertBox, 'Guía anulada', 'success');
      loadListado();
    } catch (e) {
      const detalle = e.errores ? ` (${e.errores.join(' · ')})` : '';
      NovaUtils.showAlert(alertBox, e.message + detalle, 'error');
    }
  }

  init().catch((e) => NovaUtils.showAlert(alertBox, e.message, 'error'));
})();
