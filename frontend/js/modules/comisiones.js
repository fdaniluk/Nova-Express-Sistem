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
  const fARS = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 });
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
    const tc = $('r-tc').value;
    $('r-excel').href = `/api/comisiones/resumen.xlsx?mes=${mes}${tc ? `&tc=${tc}` : ''}`;
    try {
      resumen = await api.comisiones.resumen(mes, tc);
      const fuente = $('r-tc-fuente');
      fuente.classList.toggle('falta', !resumen.tc);
      fuente.textContent = resumen.tc
        ? (resumen.tc_fuente === 'manual' ? `Usando $ ${fARS.format(resumen.tc)}` : `Usando $ ${fARS.format(resumen.tc)} · ${resumen.tc_fuente}`)
        : 'Falta el dólar del mes: sin él no se puede descontar el sueldo (piso)';
      renderTarjetas();
      renderTablaResumen();
    } catch (e) { showAlert(alertBox, e.message); }
  }

  const inicial = (n) => String(n || '?').trim().charAt(0).toUpperCase();

  function renderTarjetas() {
    const r = resumen;
    const t = r.total;
    const margen = t.venta ? Math.round((t.utilidad / t.venta) * 100) : 0;
    const faltaTC = r.vendedores.some((g) => g.piso_estado === 'falta TC');
    $('r-total').innerHTML = `
      <div class="com-kpi"><span>Venta</span><b>${fUSD.format(t.venta)}</b><small>${t.envios} envíos en el mes</small></div>
      <div class="com-kpi"><span>Utilidad</span><b>${fUSD.format(t.utilidad)}</b><small>${margen} % de la venta</small></div>
      <div class="com-kpi"><span>Utilidad sobre sueldos</span><b>${faltaTC ? '—' : fUSD.format(r.vendedores.reduce((a, g) => a + (g.excedente ?? (g.es_casa ? 0 : g.utilidad)), 0))}</b><small>${faltaTC ? 'falta el dólar del mes' : 'lo que queda después de cubrir cada sueldo'}</small></div>
      <div class="com-kpi destacado"><span>A pagar</span><b>${fUSD.format(t.a_pagar)}</b><small>${faltaTC ? 'falta el dólar del mes' : 'el % de cada vendedor sobre esa utilidad'}</small></div>`;

    // "Sin asignar" no es un vendedor: va como aviso para que no parezca que se le paga algo.
    const sa = r.sin_asignar;
    $('r-aviso').innerHTML = sa.envios ? `<div class="com-aviso">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div><b>${sa.clientes.length} cliente${sa.clientes.length !== 1 ? 's' : ''} sin vendedor</b> · ${sa.envios} envíos · ${fUSD.format(sa.venta)} de venta y ${fUSD.format(sa.utilidad)} de utilidad que hoy no le cuentan a nadie.</div>
        <button type="button" class="btn btn-sm com-aviso-btn" id="r-ir-asignar">Asignar vendedor →</button>
      </div>` : '';
    const ir = $('r-ir-asignar');
    if (ir) ir.addEventListener('click', () => {
      document.querySelector('.page-header .tab[data-tab="clientes"]').click();
      $('c-filtro-vend').dataset.pendiente = 'sin';
    });

    const tarjeta = (g) => {
      const activa = String(vendedorActivo) === String(g.vendedor_id);
      const vacio = !g.envios;
      let monto, barra = '', pie = '';
      if (g.es_casa) {
        monto = '<div class="com-monto casa">Sin comisión</div>';
        pie = 'La casa: sus clientes no generan comisión';
      } else if (g.a_pagar == null) {
        monto = `<div class="com-monto falta">—<small>a pagar</small></div>`;
        pie = `<span class="com-chip sin">falta dólar del mes</span> para comparar la utilidad con el sueldo de $ ${fARS.format(g.piso_mensual)}`;
      } else {
        monto = `<div class="com-monto">${fUSD.format(g.a_pagar)}<small>a pagar</small></div>`;
        if (g.piso_usd != null) {
          // Barra: utilidad del vendedor contra su sueldo. Pasado el sueldo, cobra su % de lo que sobra.
          const pct = g.piso_usd ? Math.min(100, (g.utilidad / g.piso_usd) * 100) : 100;
          const supera = g.utilidad > g.piso_usd;
          barra = `<div class="com-piso ${supera ? 'supera' : ''}"><div class="com-piso-fill" style="width:${pct}%"></div></div>`;
          pie = supera
            ? `Utilidad ${fUSD.format(g.utilidad)} − sueldo ${fUSD.format(g.piso_usd)} = <b>${fUSD.format(g.excedente)}</b> × ${pctTxt(g.pct)}`
            : `Utilidad ${fUSD.format(g.utilidad)} de ${fUSD.format(g.piso_usd)} de sueldo · le faltan ${fUSD.format(g.piso_usd - g.utilidad)} para empezar a comisionar`;
        } else if (!vacio) {
          pie = `Sin sueldo cargado: cobra su % de toda la utilidad`;
        }
      }
      return `<div class="com-tarjeta ${g.es_casa ? 'casa' : ''} ${vacio ? 'vacia' : ''} ${activa ? 'activa' : ''}" data-id="${g.vendedor_id}">
        <div class="com-t-head">
          <span class="com-avatar">${esc(inicial(g.vendedor))}</span>
          <span class="com-t-nombre">${esc(g.vendedor)}</span>
          ${g.es_casa ? '<span class="com-pct">casa</span>' : `<span class="com-pct">${pctTxt(g.pct)}</span>`}
        </div>
        ${vacio ? '<div class="com-monto vacio">Sin envíos este mes</div>' : monto}
        ${barra}
        ${pie && !vacio ? `<div class="com-t-pie">${pie}</div>` : ''}
        <div class="com-t-stats">
          <span><b>${g.envios}</b> envíos</span>
          <span><b>${g.clientes.length}</b> clientes</span>
          <span>utilidad <b>${fUSD.format(g.utilidad)}</b></span>
        </div>
      </div>`;
    };
    $('r-tarjetas').innerHTML = r.vendedores.map(tarjeta).join('');
    $('r-tarjetas').querySelectorAll('.com-tarjeta').forEach((el) => el.addEventListener('click', () => {
      vendedorActivo = String(vendedorActivo) === el.dataset.id ? null : el.dataset.id;
      renderTarjetas(); renderTablaResumen();
    }));
    const g = r.vendedores.find((x) => String(x.vendedor_id) === String(vendedorActivo));
    $('r-filtro-txt').innerHTML = g
      ? `Mostrando solo <b>${esc(g.vendedor)}</b> · <a href="#" id="r-ver-todos">ver todos</a>`
      : 'Clic en una tarjeta para ver solo ese vendedor · clic en un cliente para ver sus envíos';
    const vt = $('r-ver-todos');
    if (vt) vt.addEventListener('click', (e) => { e.preventDefault(); vendedorActivo = null; renderTarjetas(); renderTablaResumen(); });
  }

  function renderTablaResumen() {
    const r = resumen;
    const grupos = [...r.vendedores, ...(r.sin_asignar.envios ? [r.sin_asignar] : [])]
      .filter((g) => vendedorActivo == null || String(g.vendedor_id ?? 'sin') === String(vendedorActivo));
    if (!grupos.length || !r.total.envios) { $('r-tabla').innerHTML = '<tr><td colspan="8" class="empty">Sin envíos en este mes</td></tr>'; return; }
    const pisoTd = (g) => g.es_casa || g.vendedor_id == null ? '<td class="num">—</td><td class="num">—</td>'
      : `<td class="num">${g.piso_usd != null ? usd(g.piso_usd) : (g.piso_estado === 'falta TC' ? '<span class="com-chip sin">falta dólar</span>' : '—')}</td><td class="num"><b>${g.a_pagar != null ? usd(g.a_pagar) : '—'}</b></td>`;
    $('r-tabla').innerHTML = grupos.filter((g) => g.envios).map((g) => `
      <tr class="grupo"><td><span class="com-avatar sm ${g.vendedor_id == null ? 'sin' : (g.es_casa ? 'casa' : '')}">${g.vendedor_id == null ? '!' : esc(inicial(g.vendedor))}</span>${esc(g.vendedor)}${g.es_casa ? '<span class="com-chip">casa</span>' : ''}${g.vendedor_id == null ? '<span class="com-chip sin">asignar en la pestaña Clientes</span>' : ''}</td>
        <td class="num">${g.envios}</td><td class="num">${usd(g.venta)}</td><td class="num">${usd(g.utilidad)}</td><td class="num">${g.es_casa ? '—' : pctTxt(g.pct)}</td><td class="num">${g.es_casa ? '—' : usd(g.comision)}</td>${pisoTd(g)}</tr>
      ${g.clientes.map((c) => `<tr class="cliente" data-v="${g.vendedor_id ?? 'sin'}" data-c="${c.cliente_id}"><td>${esc(c.cliente)}${c.pct_origen === 'cliente' ? '<span class="com-chip cliente">% especial</span>' : ''}</td>
        <td class="num">${c.envios}</td><td class="num">${usd(c.venta)}</td><td class="num">${usd(c.utilidad)}</td><td class="num">${g.es_casa ? '—' : pctTxt(c.pct)}</td><td class="num">${g.es_casa ? '—' : usd(c.comision)}</td><td></td><td></td></tr>`).join('')}`).join('');
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
        <td class="num"></td><td class="num">${usd(e.venta)}</td><td class="num">${usd(e.utilidad)}</td><td class="num">${e.es_casa ? '—' : pctTxt(e.pct)}</td><td class="num">${e.es_casa ? '—' : usd(e.comision)}</td><td></td><td></td></tr>`).join(''));
    } catch (e) { showAlert(alertBox, e.message); }
  }

  // ── Clientes → vendedor ───────────────────────────────────────────────────────
  async function cargarClientes() {
    try {
      const [c, v] = await Promise.all([api.comisiones.clientes(), api.comisiones.vendedores()]);
      clientes = c.clientes; vendedores = v.vendedores;
      const activos = vendedores.filter((x) => x.activo);
      const fsel = $('c-filtro-vend');
      const previo = fsel.dataset.pendiente || fsel.value;
      fsel.innerHTML = '<option value="">Todos</option><option value="sin">Sin asignar</option>' + vendedores.map((x) => `<option value="${x.id}">${esc(x.nombre)}</option>`).join('');
      fsel.value = previo || '';
      delete fsel.dataset.pendiente;
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
          <td>${v.es_casa ? '—' : `<input type="number" data-campo="piso" min="0" step="1000" value="${v.piso_mensual ?? ''}" placeholder="sin piso" style="width:120px"> <select data-campo="piso_moneda"><option value="ARS" ${v.piso_moneda !== 'USD' ? 'selected' : ''}>$ pesos</option><option value="USD" ${v.piso_moneda === 'USD' ? 'selected' : ''}>US$</option></select>`}</td>
          <td class="num">${v.clientes}</td>
          <td>${v.activo ? '<span class="badge badge-liquidado">Activo</span>' : '<span class="badge badge-pendiente">Inactivo</span>'}</td>
          <td>${v.es_casa ? '' : `<button class="btn btn-secondary btn-sm" data-accion="guardar">Guardar</button> <button class="btn btn-secondary btn-sm" data-accion="${v.activo ? 'baja' : 'alta'}">${v.activo ? 'Dar de baja' : 'Reactivar'}</button>`}</td>
        </tr>`).join('');
      $('v-tabla').querySelectorAll('button[data-accion]').forEach((b) => b.addEventListener('click', async () => {
        const tr = b.closest('tr'); const id = Number(tr.dataset.id); const a = b.dataset.accion;
        try {
          if (a === 'guardar') await api.comisiones.editarVendedor(id, { nombre: tr.querySelector('[data-campo=nombre]').value, comision_pct: Number(tr.querySelector('[data-campo=pct]').value),
            piso_mensual: tr.querySelector('[data-campo=piso]').value === '' ? null : Number(tr.querySelector('[data-campo=piso]').value), piso_moneda: tr.querySelector('[data-campo=piso_moneda]').value });
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
  $('r-tc').addEventListener('change', cargarResumen);
  (async () => {
    try { await cargarMeses(); await cargarResumen(); } catch (e) { showAlert(alertBox, e.message); }
  })();
})();
