// Cobranzas — entrega 3 (24/09/2026): cargar pago, pagos del cliente y bandeja para confirmar.
// Decisiones de Felipe: la imputación se elige a mano; confirma solo quien tiene
// confirmar_pagos (Marcelo); transferencia y Mercado Pago llevan comprobante obligatorio.
// Se engancha a cobranzas.js por dos eventos: 'cob:ficha' (se abrió la ficha de un cliente)
// y 'cob:saldos' (se mostró la vista de saldos).
(function () {
  const api = window.NovaAPI;
  const { formatDate, showAlert, hoyLocal } = window.NovaUtils;
  const $ = (id) => document.getElementById(id);
  const alertBox = $('alert-box');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fARS = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 });
  const fUSD = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  const money = (n, m) => (m === 'ARS' ? fARS : fUSD).format(Number(n) || 0);
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const MONEDA_LIBRO = { CF: 'ARS', SF: 'USD' };
  const MEDIO_LABEL = { transferencia: 'Transferencia', mercadopago: 'Mercado Pago', efectivo: 'Efectivo', cheque: 'Cheque', otro: 'Otro' };
  const CON_COMPROBANTE = ['transferencia', 'mercadopago'];

  const puedeConfirmar = () => !!(window.currentUser && window.currentUser.confirmar_pagos === 1);

  // Número "cortito" para mostrar un débito: LQ-123 → Liquidación #123, FA A 0003-00001234.
  function refDebito(c) {
    if (c.tipo === 'LQ' && c.liquidacion_id) return `Liquidación #${c.liquidacion_id}`;
    const n = [c.punto_venta, c.numero].filter(Boolean).join('-');
    return `${{ FA: 'Factura', ND: 'Nota de débito', LQ: 'Liquidación' }[c.tipo] || c.tipo}${c.letra ? ' ' + c.letra : ''}${n ? ' ' + n : ''}`;
  }

  // ══ Ficha del cliente: lista de pagos ══════════════════════════════════════════════
  let ficha = null; // { clienteId, nombre, pend }

  window.addEventListener('cob:ficha', (e) => {
    ficha = e.detail;
    $('btn-cargar-pago').classList.remove('hidden');
    cargarPagosCliente();
  });
  window.addEventListener('cob:saldos', () => {
    ficha = null;
    $('btn-cargar-pago').classList.add('hidden');
    cargarBandeja();
    cargarEntrantes();
  });

  async function cargarPagosCliente() {
    if (!ficha) return;
    const tb = $('fc-pagos');
    tb.innerHTML = '<tr><td colspan="7" class="empty">Cargando…</td></tr>';
    try {
      const { pagos } = await api.cobranzas.pagosCliente(ficha.clienteId, $('p-eliminados').checked);
      $('fc-pagos-n').textContent = pagos.filter((p) => !p.anulado_at && p.estado === 'informado').length
        ? `${pagos.filter((p) => !p.anulado_at && p.estado === 'informado').length} sin confirmar` : '';
      if (!pagos.length) { tb.innerHTML = '<tr><td colspan="7" class="empty">Todavía no hay pagos cargados en el sistema para este cliente</td></tr>'; return; }
      tb.innerHTML = pagos.map((p) => filaPago(p)).join('');
    } catch (e) {
      tb.innerHTML = `<tr><td colspan="7" class="empty">${esc(e.message)}</td></tr>`;
    }
  }

  function medios(p) {
    return p.valores.map((v) => {
      const extra = v.medio === 'cheque' ? ` ${esc(v.banco || '')} nº ${esc(v.numero || '')}, cobra ${formatDate(v.fecha_vto)}` : '';
      const adj = v.tiene_adjunto ? ` <a class="pg-adj" href="/api/cobranzas/adjuntos/${v.id}" target="_blank" rel="noopener">comprobante</a>` : '';
      return `<div>${MEDIO_LABEL[v.medio] || v.medio} ${money(v.importe, v.moneda)}${extra}${adj}</div>`;
    }).join('');
  }

  function aplicadoA(p) {
    const vivas = p.imputaciones.filter((i) => i.estado !== 'revertida' || p.anulado_at);
    const lista = vivas.map((i) => `<div>${esc(refDebito(i))} · ${money(i.importe, p.moneda)}</div>`).join('');
    const favor = p.a_favor > 0.005 ? `<div class="pg-favor">a favor ${money(p.a_favor, p.moneda)}</div>` : '';
    return lista + favor || '<span class="cob-cero">—</span>';
  }

  function estadoPago(p) {
    if (p.anulado_at) return `<span class="badge pg-est-anulado" title="${esc(p.anulado_motivo || '')}">Eliminado</span><div class="cob-desc">${esc(p.anulado_por || '')}: ${esc(p.anulado_motivo || '')}</div>`;
    if (p.estado === 'confirmado') return `<span class="badge pg-est-ok">Confirmado</span><div class="cob-desc">${esc(p.confirmado_por || '')}</div>`;
    return '<span class="badge pg-est-pend">Sin confirmar</span>';
  }

  function filaPago(p) {
    const acciones = p.anulado_at ? '' : `
      ${p.estado === 'informado' && puedeConfirmar() ? `<button class="btn btn-primary btn-sm" data-pg-confirmar="${p.id}">Confirmar</button>` : ''}
      <button class="pg-link-del" data-pg-eliminar="${p.id}">Eliminar</button>`;
    return `<tr class="${p.anulado_at ? 'anulado' : ''} ${p.estado === 'informado' && !p.anulado_at ? 'pg-pend' : ''}">
      <td>${formatDate(p.fecha)}<div class="cob-desc">RC ${p.numero_sistema}${p.numero_talonario ? ` · tal. ${esc(p.numero_talonario)}` : ''}</div></td>
      <td><span class="badge badge-libro-${p.libro}">${p.libro === 'CF' ? 'Con factura' : 'Sin factura'}</span></td>
      <td class="pg-medios">${medios(p)}</td>
      <td class="num"><b>${money(p.total, p.moneda)}</b></td>
      <td class="pg-aplicado">${aplicadoA(p)}</td>
      <td>${estadoPago(p)}<div class="cob-desc">cargó ${esc(p.creado_por || '')}</div></td>
      <td class="pg-acciones">${acciones}</td>
    </tr>`;
  }

  // Confirmar / eliminar: mismos botones en la ficha y en la bandeja.
  document.addEventListener('click', async (e) => {
    const bc = e.target.closest('[data-pg-confirmar]');
    const be = e.target.closest('[data-pg-eliminar]');
    if (!bc && !be) return;
    const btn = bc || be;
    try {
      if (bc) {
        btn.disabled = true;
        await api.cobranzas.confirmarPago(bc.dataset.pgConfirmar);
      } else {
        const motivo = prompt('¿Por qué se elimina este pago? (la deuda vuelve a quedar abierta)');
        if (motivo === null) return;
        btn.disabled = true;
        await api.cobranzas.eliminarPago(be.dataset.pgEliminar, motivo);
      }
      await refrescarTodo();
    } catch (err) {
      btn.disabled = false;
      showAlert(alertBox, err.message);
    }
  });
  $('p-eliminados').addEventListener('change', cargarPagosCliente);

  async function refrescarTodo() {
    if (ficha && window.NovaCobranzas) await window.NovaCobranzas.recargarFicha();
    else if (window.NovaCobranzas) await window.NovaCobranzas.recargarSaldos();
  }

  // ══ Bandeja: pagos para confirmar (solo quien confirma) ════════════════════════════
  async function cargarBandeja() {
    const box = $('bandeja-pagos');
    if (!puedeConfirmar()) { box.classList.add('hidden'); return; }
    try {
      const { pagos } = await api.cobranzas.bandeja();
      if (!pagos.length) { box.classList.add('hidden'); return; }
      box.classList.remove('hidden');
      $('bandeja-n').textContent = pagos.length;
      $('bandeja-lista').innerHTML = pagos.map((p) => `
        <div class="pg-card">
          <div class="pg-card-main">
            <div class="pg-card-top">
              <a href="?cliente=${p.cliente_id}" class="pg-cli" data-ir-cliente="${p.cliente_id}">${esc(p.cliente)}</a>
              <span class="badge badge-libro-${p.libro}">${p.libro === 'CF' ? 'Con factura' : 'Sin factura'}</span>
              <span class="cob-desc">${formatDate(p.fecha)} · cargó ${esc(p.creado_por || '')}${p.numero_talonario ? ` · talonario ${esc(p.numero_talonario)}` : ''}</span>
            </div>
            <div class="pg-card-monto">${money(p.total, p.moneda)}</div>
            <div class="pg-card-det">
              <div><span class="pg-lbl">Entró</span>${medios(p)}</div>
              <div><span class="pg-lbl">Se aplica a</span>${aplicadoA(p)}</div>
            </div>
            ${p.observaciones ? `<div class="cob-desc">“${esc(p.observaciones)}”</div>` : ''}
          </div>
          <div class="pg-card-acc">
            <button class="btn btn-primary" data-pg-confirmar="${p.id}">✓ Confirmar</button>
            <button class="pg-link-del" data-pg-eliminar="${p.id}">Rechazar</button>
          </div>
        </div>`).join('');
    } catch (e) {
      box.classList.add('hidden');
    }
  }
  // El usuario llega después de que arranca la pantalla: recién ahí se sabe si confirma.
  window.addEventListener('nova:usuario', () => { if (!ficha) cargarBandeja(); });
  // cobranzas.js arranca antes que este archivo: la primera vista de saldos ya pasó sin
  // avisarnos, así que los pagos que entraron se piden acá una vez.
  setTimeout(() => { if (!ficha && !new URLSearchParams(location.search).get('cliente')) cargarEntrantes(); }, 0);
  $('bandeja-lista').addEventListener('click', (e) => {
    const a = e.target.closest('[data-ir-cliente]');
    if (!a || !window.NovaCobranzas) return;
    e.preventDefault();
    window.NovaCobranzas.abrirFicha(a.dataset.irCliente);
  });

  // ══ Pagos que entraron solos (Mercado Pago; después Galicia) ═════════════════════════
  // El sistema avisa y sugiere → la oficina revisa y pasa → Marcelo aprueba.
  let clientesLista = null;
  async function listaClientes() {
    if (!clientesLista) {
      const cl = await api.clientes.listar();
      clientesLista = (cl.clientes || cl).map((c) => ({ id: c.id, nombre: c.nombre_nova || c.nombre }))
        .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
    }
    return clientesLista;
  }

  function fmtHora(at) { return at ? String(at).slice(11, 16) : ''; }

  async function cargarEntrantes() {
    const box = $('entrantes-box');
    try {
      const { entrantes, mercadopago } = await api.cobranzas.entrantes();
      const mpTxt = mercadopago.configurado
        ? (mercadopago.ultima && mercadopago.ultima.ok === false
          ? `<span class="pe-mp err" title="${esc(mercadopago.ultima.error || '')}">Mercado Pago: la última consulta falló</span>`
          : `<span class="pe-mp ok">Mercado Pago conectado${mercadopago.ultima ? ` · revisado ${fmtHora(mercadopago.ultima.at)}` : ''}</span>`)
        : '<span class="pe-mp off">Mercado Pago sin conectar</span>';
      $('pe-estado').innerHTML = mpTxt;
      $('pe-buscar').classList.toggle('hidden', !mercadopago.configurado);
      $('pe-n').textContent = entrantes.length;
      $('pe-n').classList.toggle('hidden', !entrantes.length);
      box.classList.toggle('vacio', !entrantes.length);
      if (!entrantes.length) {
        $('pe-lista').innerHTML = `<div class="pe-vacio">${mercadopago.configurado ? 'No hay pagos nuevos para revisar.' : 'Cuando se conecte Mercado Pago (y después Galicia), acá van a aparecer solos los pagos que entran, con el cliente y la liquidación sugeridos.'}</div>`;
        return;
      }
      $('pe-lista').innerHTML = entrantes.map((e) => {
        const c = e.cliente_sugerido;
        const sug = e.sugerencia;
        return `<div class="pe-card" data-id="${e.id}">
          <div class="pe-card-izq">
            <span class="pe-fuente ${e.fuente}">${e.fuente === 'mercadopago' ? 'Mercado Pago' : 'Banco'}</span>
            <div class="pe-monto">${money(e.importe, e.moneda)}</div>
            <div class="cob-desc">${formatDate(e.fecha)}</div>
          </div>
          <div class="pe-card-med">
            <div class="pe-quien"><span class="pg-lbl">Pagó</span>${esc(e.nombre_emisor || 'sin nombre')}${e.cuit_emisor ? ` <span class="cob-desc">· ${esc(e.cuit_emisor)}</span>` : ''}${e.referencia ? `<div class="cob-desc">“${esc(e.referencia)}”</div>` : ''}</div>
            <div class="pe-cliente"><span class="pg-lbl">Cliente</span>${c
              ? `<b>${esc(c.nombre)}</b> <span class="cob-desc">(${esc(c.por)})</span> <button class="pe-cambiar" data-pe-cambiar="${e.id}">cambiar</button>`
              : `<span class="pe-nosabe">No sé de quién es</span> <button class="pe-cambiar" data-pe-cambiar="${e.id}">elegir cliente</button>`}
              <div class="pe-elegir hidden" id="pe-elegir-${e.id}"></div></div>
            ${sug ? `<div class="pe-sug">💡 ${esc(sug.motivo)}${sug.imputaciones.length ? ` <span class="cob-desc">(${sug.imputaciones.map((i) => esc(i.ref)).join(', ')})</span>` : ''}</div>` : ''}
          </div>
          <div class="pe-card-acc">
            <button class="btn btn-primary" data-pe-revisar="${e.id}" ${c ? '' : 'disabled title="Primero elegí el cliente"'}>Revisar y pasar</button>
            <button class="pg-link-del" data-pe-descartar="${e.id}">No es de un cliente</button>
          </div>
        </div>`;
      }).join('');
      box._entrantes = entrantes;
    } catch (e) {
      $('pe-lista').innerHTML = `<div class="pe-vacio">${esc(e.message)}</div>`;
    }
  }

  $('pe-lista').addEventListener('click', async (ev) => {
    const box = $('entrantes-box');
    const bRev = ev.target.closest('[data-pe-revisar]');
    const bDes = ev.target.closest('[data-pe-descartar]');
    const bCam = ev.target.closest('[data-pe-cambiar]');
    try {
      if (bRev) {
        const e = (box._entrantes || []).find((x) => String(x.id) === bRev.dataset.peRevisar);
        if (!e || !e.cliente_sugerido) return;
        bRev.disabled = true;
        const pend = await api.cobranzas.pendientes(e.cliente_sugerido.id);
        bRev.disabled = false;
        abrirModal({ clienteId: e.cliente_sugerido.id, nombre: e.cliente_sugerido.nombre, pend, entrante: e, sugerencia: e.sugerencia });
      } else if (bDes) {
        const motivo = prompt('¿Qué es este movimiento? (ej.: reintegro, plata nuestra, cobro de UPS)');
        if (motivo === null) return;
        await api.cobranzas.descartarEntrante(bDes.dataset.peDescartar, motivo);
        cargarEntrantes();
      } else if (bCam) {
        const id = bCam.dataset.peCambiar;
        const cont = $(`pe-elegir-${id}`);
        const lista = await listaClientes();
        cont.innerHTML = `<select data-pe-cliente="${id}"><option value="">Elegí el cliente…</option>${lista.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}</select>`;
        cont.classList.remove('hidden');
        cont.querySelector('select').focus();
      }
    } catch (err) {
      showAlert(alertBox, err.message);
    }
  });
  $('pe-lista').addEventListener('change', async (ev) => {
    const sel = ev.target.closest('[data-pe-cliente]');
    if (!sel || !sel.value) return;
    try {
      await api.cobranzas.clienteEntrante(sel.dataset.peCliente, sel.value);
      cargarEntrantes();
    } catch (err) { showAlert(alertBox, err.message); }
  });
  $('pe-buscar').addEventListener('click', async () => {
    const b = $('pe-buscar');
    b.disabled = true;
    try {
      const r = await api.cobranzas.sincronizarEntrantes();
      showAlert(alertBox, r.nuevos ? `Entraron ${r.nuevos} pagos nuevos.` : 'No hay pagos nuevos en Mercado Pago.', 'success');
      await cargarEntrantes();
    } catch (err) { showAlert(alertBox, err.message); } finally { b.disabled = false; }
  });

  // ══ Modal: cargar pago ═════════════════════════════════════════════════════════════
  let libroPago = 'SF';
  let nValor = 0;
  // ctx = para quién es el pago: { clienteId, nombre, pend, entrante?, sugerencia? }.
  // Desde la ficha es la ficha abierta; desde "Pagos que entraron" es el movimiento a revisar.
  let ctx = null;

  function abrirModal(c) {
    ctx = c && c.clienteId ? c : ficha;
    if (!ctx) return;
    const ent = ctx.entrante || null;
    $('mp-titulo-txt').textContent = ent ? `Revisar pago de ${ent.fuente === 'mercadopago' ? 'Mercado Pago' : 'banco'}` : 'Cargar pago';
    $('mp-cliente').textContent = ctx.nombre;
    const p = ctx.pend;
    // Arranca en el libro que tiene deuda (si tiene en los dos, el de dólares, que es el más común).
    libroPago = ctx.sugerencia ? ctx.sugerencia.libro
      : (p.SF.some((x) => ['FA', 'LQ', 'ND'].includes(x.tipo)) || !p.CF.length ? 'SF' : 'CF');
    $('mp-fecha').value = ent ? ent.fecha : hoyLocal();
    $('mp-fecha').max = hoyLocal();
    $('mp-fecha').disabled = !!ent;
    $('mp-tc').value = ctx.sugerencia && ctx.sugerencia.tc ? ctx.sugerencia.tc : '';
    $('mp-talonario').value = '';
    $('mp-obs').value = '';
    $('mp-valores').innerHTML = '';
    nValor = 0;
    agregarValor();
    $('mp-agregar-valor').classList.toggle('hidden', !!ent);
    $('mp-entrante').classList.toggle('hidden', !ent);
    if (ent) {
      // Lo que entró lo dice el banco / MP: no se toca.
      const row = document.querySelector('#mp-valores .mp-valor');
      row.querySelector('.mp-medio').value = ent.fuente === 'mercadopago' ? 'mercadopago' : 'transferencia';
      row.querySelector('.mp-moneda').value = ent.moneda;
      row.querySelector('.mp-moneda').dataset.tocado = '1';
      row.querySelector('.mp-importe').value = ent.importe;
      row.querySelectorAll('select, input').forEach((x) => { x.disabled = true; });
      row.classList.add('bloqueado');
      $('mp-entrante').innerHTML = `<b>${ent.fuente === 'mercadopago' ? 'Mercado Pago' : 'Banco'}</b> · ${formatDate(ent.fecha)} · ${esc(ent.nombre_emisor || 'sin nombre')}${ent.cuit_emisor ? ` · CUIT/DNI ${esc(ent.cuit_emisor)}` : ''}${ent.referencia ? ` · “${esc(ent.referencia)}”` : ''}`
        + (ctx.sugerencia ? `<div class="mp-sug">💡 ${esc(ctx.sugerencia.motivo)} Revisalo y corregí lo que haga falta.</div>` : '');
      actualizarValor(row);
      row.querySelector('.mp-file').classList.add('hidden');
    }
    marcarLibro();
    if (ctx.sugerencia) aplicarSugerencia(ctx.sugerencia);
    $('mp-aviso').textContent = puedeConfirmar()
      ? 'Queda confirmado al guardar.'
      : (ent ? 'Pasa a Marcelo para que lo apruebe. La deuda baja cuando él lo aprueba.'
        : 'Queda "sin confirmar" hasta que Marcelo lo confirme. La deuda baja cuando él lo confirma.');
    $('mp-guardar').textContent = ent && !puedeConfirmar() ? 'Pasar a Marcelo' : 'Guardar pago';
    $('mp-error').textContent = '';
    $('modal-pago').classList.remove('hidden');
  }

  // Tilda las deudas que sugirió el sistema (la oficina las puede cambiar).
  function aplicarSugerencia(sug) {
    if (sug.libro !== libroPago) return;
    for (const im of sug.imputaciones || []) {
      const lab = document.querySelector(`#mp-deudas .mp-deuda[data-id="${im.comprobante_id}"]`);
      if (!lab) continue;
      lab.querySelector('.mp-chk').checked = true;
      const imp = lab.querySelector('.mp-d-imp');
      imp.disabled = false;
      imp.value = Number(im.importe).toFixed(2);
      lab.classList.add('on', 'sugerida');
    }
    recalcular();
  }

  function marcarLibro() {
    document.querySelectorAll('#mp-libro button').forEach((b) => b.classList.toggle('active', b.dataset.libro === libroPago));
    const moneda = MONEDA_LIBRO[libroPago];
    document.querySelectorAll('#mp-valores .mp-moneda').forEach((s) => { if (!s.dataset.tocado) s.value = moneda; });
    renderDeudas();
    recalcular();
  }

  function agregarValor() {
    const i = nValor++;
    const row = document.createElement('div');
    row.className = 'mp-valor';
    row.dataset.i = i;
    row.innerHTML = `
      <select class="mp-medio" aria-label="Medio">
        <option value="transferencia">Transferencia</option>
        <option value="mercadopago">Mercado Pago</option>
        <option value="efectivo">Efectivo</option>
        <option value="cheque">Cheque</option>
        <option value="otro">Otro</option>
      </select>
      <select class="mp-moneda" aria-label="Moneda"><option value="USD">US$</option><option value="ARS">$</option></select>
      <input type="number" class="mp-importe" min="0" step="0.01" placeholder="Importe" aria-label="Importe">
      <label class="mp-file"><input type="file" accept="application/pdf,image/*"><span>Adjuntar comprobante *</span></label>
      <div class="mp-cheque hidden">
        <input type="text" class="mp-banco" placeholder="Banco">
        <input type="text" class="mp-numero" placeholder="Nº de cheque">
        <input type="date" class="mp-vto" title="Fecha de cobro">
      </div>
      ${i > 0 ? '<button type="button" class="mp-quitar" title="Quitar">✕</button>' : ''}`;
    $('mp-valores').appendChild(row);
    row.querySelector('.mp-moneda').value = MONEDA_LIBRO[libroPago];
    actualizarValor(row);
  }

  function actualizarValor(row) {
    const medio = row.querySelector('.mp-medio').value;
    row.querySelector('.mp-file').classList.toggle('hidden', !CON_COMPROBANTE.includes(medio));
    row.querySelector('.mp-cheque').classList.toggle('hidden', medio !== 'cheque');
    const f = row.querySelector('.mp-file input').files[0];
    row.querySelector('.mp-file span').textContent = f ? `📎 ${f.name}` : 'Adjuntar comprobante *';
    row.querySelector('.mp-file').classList.toggle('ok', !!f);
  }

  $('mp-valores').addEventListener('change', (e) => {
    const row = e.target.closest('.mp-valor');
    if (!row) return;
    if (e.target.classList.contains('mp-moneda')) e.target.dataset.tocado = '1';
    actualizarValor(row);
    recalcular();
  });
  $('mp-valores').addEventListener('input', recalcular);
  $('mp-valores').addEventListener('click', (e) => {
    if (e.target.classList.contains('mp-quitar')) { e.target.closest('.mp-valor').remove(); recalcular(); }
  });
  $('mp-agregar-valor').addEventListener('click', agregarValor);
  document.querySelectorAll('#mp-libro button').forEach((b) => b.addEventListener('click', () => { libroPago = b.dataset.libro; marcarLibro(); }));
  $('mp-tc').addEventListener('input', recalcular);

  function renderDeudas() {
    const moneda = MONEDA_LIBRO[libroPago];
    const deudas = (ctx.pend[libroPago] || []).filter((x) => ['FA', 'LQ', 'ND'].includes(x.tipo) && x.saldo > 0.005);
    $('mp-deudas').innerHTML = deudas.length ? deudas.map((d) => `
      <label class="mp-deuda" data-id="${d.id}" data-saldo="${d.saldo}">
        <input type="checkbox" class="mp-chk">
        <span class="mp-d-ref"><b>${esc(refDebito(d))}</b><span class="cob-desc">${formatDate(d.fecha)}${d.descripcion ? ' · ' + esc(d.descripcion) : ''}</span></span>
        <span class="mp-d-saldo">debe ${money(d.saldo, moneda)}</span>
        <input type="number" class="mp-d-imp" min="0" step="0.01" max="${d.saldo}" placeholder="0,00" disabled aria-label="Importe a aplicar">
      </label>`).join('')
      : '<div class="empty">No tiene nada pendiente en este libro: todo el pago queda a favor.</div>';
  }

  $('mp-deudas').addEventListener('change', (e) => {
    const lab = e.target.closest('.mp-deuda');
    if (!lab) return;
    if (e.target.classList.contains('mp-chk')) {
      const imp = lab.querySelector('.mp-d-imp');
      imp.disabled = !e.target.checked;
      if (e.target.checked) {
        // Sugiere lo que falta aplicar (sin pasarse del saldo de esa deuda). Se puede cambiar.
        const libre = Math.max(0, r2(totalPago() - totalAplicado()));
        imp.value = Math.min(Number(lab.dataset.saldo), libre || Number(lab.dataset.saldo)).toFixed(2);
        imp.focus();
      } else imp.value = '';
      lab.classList.toggle('on', e.target.checked);
    }
    recalcular();
  });
  $('mp-deudas').addEventListener('input', recalcular);

  function valoresForm() {
    return [...document.querySelectorAll('#mp-valores .mp-valor')].map((row) => ({
      row,
      medio: row.querySelector('.mp-medio').value,
      moneda: row.querySelector('.mp-moneda').value,
      importe: Number(row.querySelector('.mp-importe').value) || 0,
      banco: row.querySelector('.mp-banco').value.trim(),
      numero: row.querySelector('.mp-numero').value.trim(),
      fecha_vto: row.querySelector('.mp-vto').value,
      file: row.querySelector('.mp-file input').files[0] || null,
    }));
  }

  function totalPago() {
    const moneda = MONEDA_LIBRO[libroPago];
    const tc = Number($('mp-tc').value) || 0;
    return r2(valoresForm().reduce((a, v) => {
      if (v.moneda === moneda) return a + v.importe;
      if (!tc) return a;
      return a + (moneda === 'ARS' ? v.importe * tc : v.importe / tc);
    }, 0));
  }
  function totalAplicado() {
    return r2([...document.querySelectorAll('#mp-deudas .mp-deuda')].reduce((a, l) => a + (l.querySelector('.mp-chk').checked ? Number(l.querySelector('.mp-d-imp').value) || 0 : 0), 0));
  }

  function recalcular() {
    const moneda = MONEDA_LIBRO[libroPago];
    const mixto = valoresForm().some((v) => v.moneda !== moneda);
    $('mp-tc-box').classList.toggle('hidden', !mixto);
    const total = totalPago();
    const aplicado = totalAplicado();
    const favor = r2(total - aplicado);
    $('mp-tot-pago').textContent = mixto && !(Number($('mp-tc').value) > 0) ? 'falta el tipo de cambio' : money(total, moneda);
    $('mp-tot-aplicado').textContent = money(aplicado, moneda);
    $('mp-tot-favor').textContent = favor < -0.005 ? `te pasás por ${money(-favor, moneda)}` : money(favor, moneda);
    $('mp-totales').classList.toggle('error', favor < -0.005);
  }

  function cerrarModal() { $('modal-pago').classList.add('hidden'); }
  $('mp-cerrar').addEventListener('click', cerrarModal);
  $('mp-cancelar').addEventListener('click', cerrarModal);
  $('btn-cargar-pago').addEventListener('click', () => abrirModal(null));

  $('mp-guardar').addEventListener('click', async () => {
    const btn = $('mp-guardar');
    const vals = valoresForm().filter((v) => v.importe > 0);
    const err = (m) => { $('mp-error').textContent = m; };
    err('');
    if (!vals.length) return err('Poné el importe de lo que entró.');
    for (const v of vals) {
      if (CON_COMPROBANTE.includes(v.medio) && !v.file && !ctx.entrante) return err('Falta adjuntar el comprobante de la transferencia.');
      if (v.medio === 'cheque' && (!v.banco || !v.numero || !v.fecha_vto)) return err('Del cheque falta el banco, el número o la fecha de cobro.');
    }
    if (totalAplicado() > totalPago() + 0.005) return err('Lo aplicado supera lo que entró.');
    const fd = new FormData();
    const datos = {
      cliente_id: ctx.clienteId, libro: libroPago, fecha: $('mp-fecha').value,
      entrante_id: ctx.entrante ? ctx.entrante.id : null,
      tc_pago: $('mp-tc').value || null, numero_talonario: $('mp-talonario').value.trim() || null,
      observaciones: $('mp-obs').value.trim() || null,
      valores: vals.map((v, i) => {
        if (v.file) fd.append(`adj${i}`, v.file);
        return { medio: v.medio, moneda: v.moneda, importe: v.importe, banco: v.banco || null, numero: v.numero || null, fecha_vto: v.fecha_vto || null, adjunto: v.file ? `adj${i}` : null };
      }),
      imputaciones: [...document.querySelectorAll('#mp-deudas .mp-deuda')]
        .filter((l) => l.querySelector('.mp-chk').checked && Number(l.querySelector('.mp-d-imp').value) > 0)
        .map((l) => ({ comprobante_id: Number(l.dataset.id), importe: Number(l.querySelector('.mp-d-imp').value) })),
    };
    fd.append('datos', JSON.stringify(datos));
    btn.disabled = true;
    try {
      await api.cobranzas.cargarPago(fd);
      cerrarModal();
      showAlert(alertBox, puedeConfirmar() ? 'Pago cargado y confirmado.' : (ctx.entrante ? 'Revisado. Pasó a Marcelo para que lo apruebe.' : 'Pago cargado. Queda para que Marcelo lo confirme.'), 'success');
      await refrescarTodo();
      cargarEntrantes();
    } catch (e) {
      err(e.message);
    } finally {
      btn.disabled = false;
    }
  });
})();
