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
    agregarItem();
    agregarBulto();
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
        if (name === 'listado') loadListado();
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

  function pintarRemitente() {
    const box = $('g-remitente');
    const r = remSeleccionado();
    $('g-rem-editar').classList.toggle('hidden', !r || r.principal);
    if (!r) { box.textContent = ''; box.classList.remove('falta'); return; }
    const faltan = [];
    if (!r.direccion) faltan.push('dirección');
    if (!r.ciudad) faltan.push('localidad');
    if (!r.codigo_postal) faltan.push('código postal');
    if (!r.cuit) faltan.push('CUIT (para la proforma)');
    if (!r.telefono) faltan.push('teléfono');
    const linea = [r.nombre, r.cuit ? `CUIT ${r.cuit}` : null, r.direccion,
      [r.codigo_postal, r.ciudad, r.provincia].filter(Boolean).join(' '), r.telefono, r.contacto]
      .filter(Boolean).join(' · ');
    const donde = r.principal
      ? `(<a href="clientes-perfil.html?id=${clienteActual.id}">completar en el cliente</a>)`
      : '(botón Editar)';
    box.innerHTML = `<b>Remitente:</b> ${esc(linea)}` + (faltan.length
      ? ` — <b>faltan:</b> ${esc(faltan.join(', '))} ${donde}`
      : '');
    box.classList.toggle('falta', faltan.length > 0);
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
    if (!d) { ficha.textContent = ''; return; }
    ficha.textContent = [
      d.nombre + (d.contacto ? ` (Attn: ${d.contacto})` : ''),
      [d.direccion1, d.direccion2, d.direccion3].filter(Boolean).join(', '),
      [d.codigo_postal, d.ciudad, d.estado].filter(Boolean).join(' ') + ' · ' + d.pais,
      [d.telefono ? `Tel ${d.telefono}` : null, d.email, d.tax_id ? `Tax ID ${d.tax_id}` : null].filter(Boolean).join(' · '),
    ].filter(Boolean).join('\n');
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
      items,
      bultos: bultos.filter((b) => b.peso_real > 0 || (b.largo && b.ancho && b.alto)),
      pais_destino: d.pais,
      observaciones: $('g-observaciones').value.trim() || null,
    };
    const btn = $('g-emitir');
    btn.disabled = true;
    $('g-estado').textContent = 'Pidiendo la guía a UPS…';
    try {
      const g = await NovaAPI.guias.emitir(payload);
      mostrarResultado(g);
    } catch (err) {
      if (err.errores) mostrarErrores(err.errores, err.message);
      else NovaUtils.showAlert(alertBox, err.message, 'error');
    } finally {
      btn.disabled = false;
      $('g-estado').textContent = '';
    }
  }

  function limpiarForm() {
    $('g-contenido').value = '';
    $('g-proforma').value = '';
    $('g-observaciones').value = '';
    $('g-ddp').checked = false;
    $('g-items').querySelector('tbody').innerHTML = '';
    $('g-bultos').querySelector('tbody').innerHTML = '';
    agregarItem();
    agregarBulto();
    $('g-errores').classList.add('hidden');
    // Cliente y destinatario se mantienen: lo normal es emitir varias del mismo cliente.
  }

  function docsHtml(g, chico) {
    const cls = chico ? '' : 'btn btn-secondary';
    return `
      <a class="${cls}" href="${NovaAPI.guias.etiquetaUrl(g.id, 'termica')}" target="_blank" rel="noopener" title="Etiqueta para la impresora térmica (4×6)">${chico ? 'Térmica' : 'Etiqueta térmica'}</a>
      <a class="${cls}" href="${NovaAPI.guias.etiquetaUrl(g.id, 'a4')}" target="_blank" rel="noopener" title="Etiqueta en hoja A4 (una sola hoja)">${chico ? 'A4' : 'Etiqueta A4'}</a>
      <a class="${cls}" href="${NovaAPI.guias.proformaUrl(g.id)}" target="_blank" rel="noopener" title="Proforma / commercial invoice">Proforma</a>`;
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
      tb.innerHTML = '<tr><td colspan="11" class="empty">No hay guías para mostrar.</td></tr>';
      return;
    }
    const labelEstado = { emitida: 'Para confirmar', confirmada: 'Confirmada', anulada: 'Anulada' };
    tb.innerHTML = lista.map((g) => `
      <tr data-id="${g.id}">
        <td>${esc(NovaUtils.formatDate(g.fecha))}</td>
        <td class="guia-num">${esc(g.numero_guia || '—')}${g.entorno === 'test' ? '<span class="gui-test-chip">prueba</span>' : ''}</td>
        <td>${esc(g.cliente_nombre)}${g.remitente_nombre ? `<br><span class="gui-hint">rem. ${esc(g.remitente_nombre)}</span>` : ''}</td>
        <td>${esc(g.destinatario_nombre || '—')}<br><span class="gui-hint">${esc([g.destinatario_ciudad, g.destinatario_pais].filter(Boolean).join(', '))}</span></td>
        <td>${esc(g.servicio === 'UPS_SAV' ? 'Saver' : g.servicio === 'UPS_EXP' ? 'Expedited' : g.servicio)}</td>
        <td class="n">${g.bultos.length}</td>
        <td class="n">${esc(g.peso_real)}</td>
        <td class="n">${money(g.fob)}</td>
        <td><span class="gui-estado ${esc(g.estado)}">${esc(labelEstado[g.estado] || g.estado)}</span>${g.envio_id ? `<br><span class="gui-hint">envío #${g.envio_id}</span>` : ''}</td>
        <td class="docs">${g.tiene_etiqueta ? docsHtml(g, true) : `<a href="${NovaAPI.guias.proformaUrl(g.id)}" target="_blank" rel="noopener">Proforma</a>`}</td>
        <td>${g.estado === 'emitida' ? `<a href="envios.html?guia=${g.id}">Confirmar</a> · <button type="button" class="gui-quitar" data-anular="${g.id}" title="Anular la guía en UPS">Anular</button>` : ''}</td>
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
