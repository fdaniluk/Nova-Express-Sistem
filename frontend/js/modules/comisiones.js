// Comisiones por vendedor (24/09/2026). Solo admin. Tres pestañas: resumen del mes,
// asignación cliente → vendedor (con historial por fecha) y alta/edición de vendedores.
(function () {
  const api = window.NovaAPI;
  const { formatDate, showAlert, tipoCobroLabel, mesLocal, hoyLocal } = window.NovaUtils;
  const $ = (id) => document.getElementById(id);
  const alertBox = $('alert-box');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fUSD = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  const usd = (n) => `<span class="${n < 0 ? 'com-neg' : ''}">${fUSD.format(Number(n) || 0)}</span>`;
  const pctTxt = (p) => `${Number(p) % 1 ? Number(p).toFixed(1) : Number(p)} %`;

  let vendedores = [];
  let clientes = [];
  let resumen = null;
  let vendedorActivo = null;   // id, 'sin' o null (todos)
  let mes = mesLocal();

  // ── Pestañas ──────────────────────────────────────────────────────────────────
  document.querySelectorAll('.page-header .tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.page-header .tab').forEach((x) => x.classList.toggle('active', x === t));
    ['resumen', 'clientes', 'vendedores'].forEach((k) => $(`tab-${k}`).classList.toggle('hidden', k !== t.dataset.tab));
    if (t.dataset.tab === 'clientes') cargarClientes();
    if (t.dataset.tab === 'vendedores') cargarVendedores();
  }));

  // ── Resumen ───────────────────────────────────────────────────────────────────
  async function cargarMeses() {
    const { meses } = await api.comisiones.meses();
    const lista = meses.includes(mes) ? meses : [mes, ...meses];
    const nombre = (m) => { const [y, mm] = m.split('-'); return `${['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'][Number(mm) - 1]} ${y}`; };
    $('r-mes').innerHTML = lista.map((m) => `<option value="${m}">${nombre(m)}</option>`).join('');
    $('r-mes').value = mes;
  }

  async function cargarResumen() {
    mes = $('r-mes').value || mes;
    $('r-excel').href = `/api/comisiones/resumen.xlsx?mes=${mes}`;
    try {
      resumen = await api.comisiones.resumen(mes);
      renderTarjetas();
      renderTablaResumen();
    } catch (e) { showAlert(alertBox, e.message); }
  }

  function renderTarjetas() {
    const r = resumen;
    $('r-total').innerHTML = `<span>Envíos <b>${r.total.envios}</b></span><span>Venta <b>${fUSD.format(r.total.venta)}</b></span><span>Utilidad <b>${fUSD.format(r.total.utilidad)}</b></span><span>Comisiones <b>${fUSD.format(r.total.comision)}</b></span>`;
    const tarjeta = (g, clase, id) => `<div class="com-tarjeta ${clase} ${String(vendedorActivo) === String(id) ? 'activa' : ''}" data-id="${id}">
        <div class="nombre">${esc(g.vendedor)}${g.es_casa ? '<small>casa</small>' : (g.vendedor_id ? `<small>${pctTxt(g.pct)}</small>` : '')}</div>
        <div class="comision">${g.es_casa ? 'sin comisión' : fUSD.format(g.comision)}</div>
        <div class="datos"><b>${g.envios}</b> envíos · <b>${g.clientes.length}</b> clientes<br>venta <b>${fUSD.format(g.venta)}</b> · utilidad <b>${fUSD.format(g.utilidad)}</b></div>
      </div>`;
    $('r-tarjetas').innerHTML = r.vendedores.map((g) => tarjeta(g, g.es_casa ? 'casa' : '', g.vendedor_id)).join('')
      + (r.sin_asignar.envios ? tarjeta(r.sin_asignar, 'sin', 'sin') : '');
    $('r-tarjetas').querySelectorAll('.com-tarjeta').forEach((t) => t.addEventListener('click', () => {
      vendedorActivo = String(vendedorActivo) === t.dataset.id ? null : t.dataset.id;
      renderTarjetas(); renderTablaResumen();
    }));
  }

  function renderTablaResumen() {
    const r = resumen;
    const grupos = [...r.vendedores, ...(r.sin_asignar.envios ? [r.sin_asignar] : [])]
      .filter((g) => vendedorActivo == null || String(g.vendedor_id ?? 'sin') === String(vendedorActivo));
    if (!grupos.length || !r.total.envios) { $('r-tabla').innerHTML = '<tr><td colspan="6" class="empty">Sin envíos en este mes</td></tr>'; return; }
    $('r-tabla').innerHTML = grupos.filter((g) => g.envios).map((g) => `
      <tr class="grupo"><td>${esc(g.vendedor)}${g.es_casa ? '<span class="com-chip">casa</span>' : ''}${g.vendedor_id == null ? '<span class="com-chip sin">asignar en la pestaña Clientes</span>' : ''}</td>
        <td class="num">${g.envios}</td><td class="num">${usd(g.venta)}</td><td class="num">${usd(g.utilidad)}</td><td class="num">${g.es_casa ? '—' : pctTxt(g.pct)}</td><td class="num">${g.es_casa ? '—' : usd(g.comision)}</td></tr>
      ${g.clientes.map((c) => `<tr class="cliente" data-v="${g.vendedor_id ?? 'sin'}" data-c="${c.cliente_id}"><td>${esc(c.cliente)}${c.pct_origen === 'cliente' ? '<span class="com-chip cliente">% especial</span>' : ''}</td>
        <td class="num">${c.envios}</td><td class="num">${usd(c.venta)}</td><td class="num">${usd(c.utilidad)}</td><td class="num">${g.es_casa ? '—' : pctTxt(c.pct)}</td><td class="num">${g.es_casa ? '—' : usd(c.comision)}</td></tr>`).join('')}`).join('');
    $('r-tabla').querySelectorAll('tr.cliente').forEach((tr) => tr.addEventListener('click', () => toggleEnvios(tr)));
  }

  async function toggleEnvios(tr) {
    const abiertos = [];
    let n = tr.nextElementSibling;
    while (n && n.classList.contains('envio')) { abiertos.push(n); n = n.nextElementSibling; }
    if (abiertos.length) { abiertos.forEach((x) => x.remove()); return; }
    try {
      const { envios } = await api.comisiones.detalle(mes, tr.dataset.v);
      const mios = envios.filter((e) => String(e.cliente_id) === tr.dataset.c);
      const chip = (f) => f === 'real' ? '<span class="com-chip real">costo real</span>' : f === 'liquidación' ? '<span class="com-chip liq">liquidada</span>' : '<span class="com-chip">estimada</span>';
      tr.insertAdjacentHTML('afterend', mios.map((e) => `<tr class="envio"><td>${formatDate(e.fecha)} · <span class="code">${esc(e.numero_guia)}</span> · ${esc(e.courier)} · ${esc(e.pais_destino)} ${chip(e.fuente)}</td>
        <td class="num"></td><td class="num">${usd(e.venta)}</td><td class="num">${usd(e.utilidad)}</td><td class="num">${e.es_casa ? '—' : pctTxt(e.pct)}</td><td class="num">${e.es_casa ? '—' : usd(e.comision)}</td></tr>`).join(''));
    } catch (e) { showAlert(alertBox, e.message); }
  }

  // ── Clientes → vendedor ───────────────────────────────────────────────────────
  async function cargarClientes() {
    try {
      const [c, v] = await Promise.all([api.comisiones.clientes(), api.comisiones.vendedores()]);
      clientes = c.clientes; vendedores = v.vendedores;
      const activos = vendedores.filter((x) => x.activo);
      $('c-filtro-vend').innerHTML = '<option value="">Todos</option><option value="sin">Sin asignar</option>' + vendedores.map((x) => `<option value="${x.id}">${esc(x.nombre)}</option>`).join('');
      renderClientes(activos);
    } catch (e) { showAlert(alertBox, e.message); }
  }

  function renderClientes(activos = vendedores.filter((x) => x.activo)) {
    const q = $('c-buscar').value.trim().toLowerCase();
    const fv = $('c-filtro-vend').value;
    const inact = $('c-inactivos').checked;
    const rows = clientes.filter((c) => (inact || c.activo) && (!q || `${c.cliente} ${c.razon_social}`.toLowerCase().includes(q))
      && (!fv || (fv === 'sin' ? !c.vendedor_id : String(c.vendedor_id) === fv)));
    $('c-cuenta').textContent = `${rows.length} clientes · ${clientes.filter((c) => c.activo && !c.vendedor_id).length} activos sin vendedor`;
    if (!rows.length) { $('c-tabla').innerHTML = '<tr><td colspan="7" class="empty">Ningún cliente con estos filtros</td></tr>'; return; }
    const opciones = (sel) => '<option value="">— sin asignar —</option>' + activos.map((v) => `<option value="${v.id}" ${String(v.id) === String(sel) ? 'selected' : ''}>${esc(v.nombre)}${v.es_casa ? ' (casa)' : ` · ${pctTxt(v.comision_pct)}`}</option>`).join('');
    $('c-tabla').innerHTML = rows.map((c) => `<tr data-id="${c.cliente_id}" class="${c.vendedor_id ? '' : 'sin-vendedor'} ${c.activo ? '' : 'inactivo'}">
        <td><b>${esc(c.cliente)}</b>${c.razon_social && c.razon_social !== c.cliente ? `<div class="com-hist">${esc(c.razon_social)}</div>` : ''}</td>
        <td>${esc(tipoCobroLabel(c.tipo_cobro) || '—')}</td>
        <td class="num">${c.envios_3m || '<span style="color:#b9c2d0">—</span>'}</td>
        <td><select data-campo="vendedor">${opciones(c.vendedor_id)}</select></td>
        <td><input type="number" data-campo="pct" min="0" max="100" step="0.5" value="${c.pct_cliente ?? ''}" placeholder="${c.es_casa ? '—' : (c.pct_vendedor ?? '')}" ${c.es_casa ? 'disabled' : ''} title="Vacío = usa el % del vendedor"></td>
        <td>${c.desde ? (c.desde === '2000-01-01' ? '<span class="com-hist">desde siempre</span>' : formatDate(c.desde)) : '<span class="com-hist">—</span>'}${c.cambios > 1 ? `<span class="com-chip" title="Ver historial">${c.cambios} cambios</span>` : ''}</td>
        <td><span class="guardado"></span></td>
      </tr>`).join('');
    $('c-tabla').querySelectorAll('select[data-campo=vendedor]').forEach((s) => s.addEventListener('change', () => cambiarVendedor(s.closest('tr'))));
    $('c-tabla').querySelectorAll('input[data-campo=pct]').forEach((i) => i.addEventListener('change', () => cambiarPct(i.closest('tr'))));
    $('c-tabla').querySelectorAll('.com-chip[title="Ver historial"]').forEach((ch) => ch.addEventListener('click', () => verHistorial(ch.closest('tr').dataset.id)));
  }

  async function cambiarVendedor(tr) {
    const id = Number(tr.dataset.id);
    const c = clientes.find((x) => x.cliente_id === id);
    const nuevo = tr.querySelector('select[data-campo=vendedor]').value;
    const marca = tr.querySelector('.guardado');
    try {
      if (!nuevo) {
        if (!c.vendedor_id) return;
        if (!confirm(`¿Sacar el vendedor de "${c.cliente}"? Vuelve a quedar la asignación anterior, si había.`)) { tr.querySelector('select').value = c.vendedor_id; return; }
        await api.comisiones.deshacer(id);
      } else {
        let desde = null;
        if (c.vendedor_id) {
          const sug = hoyLocal().slice(0, 7) + '-01';
          const d = prompt(`¿Desde qué fecha cuenta el nuevo vendedor para "${c.cliente}"?\nLos envíos anteriores siguen con ${c.vendedor}.\n(AAAA-MM-DD; sugerido: principio de este mes)`, sug);
          if (d === null) { tr.querySelector('select').value = c.vendedor_id; return; }
          desde = d.trim();
        }
        const pct = tr.querySelector('input[data-campo=pct]').value;
        await api.comisiones.asignar(id, { vendedor_id: Number(nuevo), desde, comision_pct: pct === '' ? null : Number(pct) });
      }
      marca.textContent = '✓ guardado';
      await cargarClientes();
    } catch (e) { showAlert(alertBox, e.message); }
  }

  async function cambiarPct(tr) {
    const id = Number(tr.dataset.id);
    const c = clientes.find((x) => x.cliente_id === id);
    if (!c.vendedor_id) { showAlert(alertBox, 'Primero elegí el vendedor.'); return; }
    const pct = tr.querySelector('input[data-campo=pct]').value;
    try {
      // Mismo vendedor, mismo "desde": solo cambia el % de la asignación vigente.
      await api.comisiones.asignar(id, { vendedor_id: c.vendedor_id, desde: c.desde, comision_pct: pct === '' ? null : Number(pct) });
      tr.querySelector('.guardado').textContent = '✓ guardado';
      await cargarClientes();
    } catch (e) { showAlert(alertBox, e.message); }
  }

  async function verHistorial(id) {
    try {
      const { historial } = await api.comisiones.historial(id);
      alert(historial.map((h) => `${h.desde === '2000-01-01' ? 'desde siempre' : 'desde ' + formatDate(h.desde)}${h.hasta ? ' hasta ' + formatDate(h.hasta) : ' (vigente)'}: ${h.vendedor}${h.comision_pct != null ? ` · ${h.comision_pct} %` : ''}${h.usuario ? ` · cargó ${h.usuario}` : ''}`).join('\n'));
    } catch (e) { showAlert(alertBox, e.message); }
  }

  ['c-buscar', 'c-filtro-vend', 'c-inactivos'].forEach((id) => $(id).addEventListener('input', () => renderClientes()));

  // ── Vendedores ────────────────────────────────────────────────────────────────
  async function cargarVendedores() {
    try {
      vendedores = (await api.comisiones.vendedores()).vendedores;
      $('v-tabla').innerHTML = vendedores.map((v) => `<tr data-id="${v.id}">
          <td>${v.es_casa ? `<b>${esc(v.nombre)}</b> <span class="com-chip">casa · sin comisión</span>` : `<input type="text" data-campo="nombre" value="${esc(v.nombre)}">`}</td>
          <td class="num">${v.es_casa ? '—' : `<input type="number" data-campo="pct" min="0" max="100" step="0.5" value="${v.comision_pct}"> %`}</td>
          <td class="num">${v.clientes}</td>
          <td>${v.activo ? '<span class="badge badge-liquidado">Activo</span>' : '<span class="badge badge-pendiente">Inactivo</span>'}</td>
          <td>${v.es_casa ? '' : `<button class="btn btn-secondary btn-sm" data-accion="guardar">Guardar</button> <button class="btn btn-secondary btn-sm" data-accion="${v.activo ? 'baja' : 'alta'}">${v.activo ? 'Dar de baja' : 'Reactivar'}</button>`}</td>
        </tr>`).join('');
      $('v-tabla').querySelectorAll('button[data-accion]').forEach((b) => b.addEventListener('click', async () => {
        const tr = b.closest('tr'); const id = Number(tr.dataset.id); const a = b.dataset.accion;
        try {
          if (a === 'guardar') await api.comisiones.editarVendedor(id, { nombre: tr.querySelector('[data-campo=nombre]').value, comision_pct: Number(tr.querySelector('[data-campo=pct]').value) });
          else await api.comisiones.editarVendedor(id, { activo: a === 'alta' ? 1 : 0 });
          await cargarVendedores();
        } catch (e) { showAlert(alertBox, e.message); }
      }));
    } catch (e) { showAlert(alertBox, e.message); }
  }
  $('v-agregar').addEventListener('click', async () => {
    try {
      await api.comisiones.crearVendedor({ nombre: $('v-nombre').value.trim(), comision_pct: Number($('v-pct').value) || 0 });
      $('v-nombre').value = ''; $('v-pct').value = '0';
      await cargarVendedores();
    } catch (e) { showAlert(alertBox, e.message); }
  });

  // ── Arranque ──────────────────────────────────────────────────────────────────
  $('r-mes').addEventListener('change', cargarResumen);
  (async () => {
    try { await cargarMeses(); await cargarResumen(); } catch (e) { showAlert(alertBox, e.message); }
  })();
})();
