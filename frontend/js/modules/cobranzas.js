// Cobranzas — saldos por cliente (lo que mira Victoria) y ficha de cuenta corriente.
// Solo lectura (entrega 2, 23/09/2026). Diseño: AUDITORIA-GECOM-Y-REDISENO-COBRANZAS.md.
(function () {
  const api = window.NovaAPI;
  const { formatDate, showAlert, tipoCobroLabel, hoyLocal } = window.NovaUtils;
  const $ = (id) => document.getElementById(id);
  const alertBox = $('alert-box');

  // ---------- formato ----------
  const fARS = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 });
  const fUSD = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  const money = (n, moneda) => (moneda === 'ARS' ? fARS : fUSD).format(Number(n) || 0);
  const monto = (n, moneda) => (Math.abs(Number(n) || 0) < 0.005 ? '<span class="cob-cero">—</span>' : money(n, moneda));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TIPO_LABEL = { FA: 'Factura', LQ: 'Liquidación', ND: 'Nota de débito', NC: 'Nota de crédito', RC: 'Recibo', AC: 'A cuenta' };

  function comprobanteRef(c) {
    if (c.tipo === 'LQ' && c.liquidacion_id) return `Liquidación #${c.liquidacion_id}`;
    const num = [c.punto_venta, c.numero].filter(Boolean).join('-');
    const letra = c.letra ? ` ${c.letra}` : '';
    return `${TIPO_LABEL[c.tipo] || c.tipo}${letra}${num ? ' ' + num : ''}`;
  }

  function estadoBadge(r) {
    if (r.dias_vencido > 30) return `<span class="badge badge-mora">Vencido ${r.dias_vencido} días</span>`;
    if (r.dias_vencido > 0) return `<span class="badge badge-mora-leve">Vencido ${r.dias_vencido} días</span>`;
    if (r.abiertos > 0) return '<span class="badge badge-aldia">Al día</span>';
    return '<span class="badge badge-aldia">Sin deuda</span>';
  }

  // ---------- estado ----------
  let filas = [];
  let clienteActual = null;
  let libroHist = 'CF';

  // ---------- Vista 1: saldos ----------
  async function cargarSaldos() {
    const libro = $('f-libro').value;
    const tipo_cobro = $('f-tipo').value;
    const todos = $('f-todos').checked;
    try {
      const data = await api.cobranzas.saldos({ libro, tipo_cobro, todos });
      filas = data.clientes || [];
      renderResumen(filas);
      renderTabla();
    } catch (e) {
      showAlert(alertBox, e.message || 'No se pudieron cargar los saldos');
      $('tabla-saldos').innerHTML = '<tr><td colspan="9" class="empty">Error al cargar</td></tr>';
    }
  }

  function renderResumen(rows) {
    const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const cf = sum('saldo_cf'), sf = sum('saldo_sf');
    const favCf = sum('a_favor_cf'), favSf = sum('a_favor_sf');
    const vencidos = rows.filter((r) => r.dias_vencido > 0);
    const vCf = vencidos.reduce((a, r) => a + r.saldo_cf, 0);
    const vSf = vencidos.reduce((a, r) => a + r.saldo_sf, 0);
    $('tot-cf').textContent = money(cf, 'ARS');
    $('tot-cf-sub').textContent = `${rows.filter((r) => r.saldo_cf > 0.005).length} clientes deben en pesos`;
    $('tot-sf').textContent = money(sf, 'USD');
    $('tot-sf-sub').textContent = `${rows.filter((r) => r.saldo_sf > 0.005).length} clientes deben en dólares`;
    $('tot-venc').textContent = String(vencidos.length);
    $('tot-venc-sub').textContent = vencidos.length ? `${money(vCf, 'ARS')} · ${money(vSf, 'USD')}` : 'nadie vencido';
    $('tot-favor').textContent = favCf > 0.005 || favSf > 0.005 ? `${money(favCf, 'ARS')} · ${money(favSf, 'USD')}` : '—';
    $('tot-favor-sub').textContent = `${rows.filter((r) => r.a_favor_cf > 0.005 || r.a_favor_sf > 0.005).length} clientes con crédito sin aplicar`;
  }

  function filasVisibles() {
    const q = $('f-buscar').value.trim().toLowerCase();
    const soloVenc = $('f-vencidos').checked;
    const orden = $('f-orden').value;
    let rows = filas.filter((r) => (!q || String(r.cliente).toLowerCase().includes(q)) && (!soloVenc || r.dias_vencido > 0));
    const cmp = {
      nombre: (a, b) => String(a.cliente).localeCompare(String(b.cliente), 'es'),
      deuda: (a, b) => (b.saldo_sf + b.saldo_cf / 1000) - (a.saldo_sf + a.saldo_cf / 1000), // USD manda; $ como desempate grueso
      mora: (a, b) => (b.dias_vencido || 0) - (a.dias_vencido || 0),
      antiguedad: (a, b) => (b.antiguedad_dias || 0) - (a.antiguedad_dias || 0),
    }[orden];
    return rows.sort(cmp);
  }

  function renderTabla() {
    const rows = filasVisibles();
    const tb = $('tabla-saldos');
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="9" class="empty">Ningún cliente con estos filtros</td></tr>';
      $('pie-saldos').innerHTML = '';
      return;
    }
    tb.innerHTML = rows.map((r) => `
      <tr class="fila-cliente" data-id="${r.cliente_id}">
        <td><div class="cliente-nombre">${esc(r.cliente)}</div>${r.cheques_en_cartera ? `<div class="cliente-sub"><span class="badge badge-cheque">${r.cheques_en_cartera} cheque${r.cheques_en_cartera > 1 ? 's' : ''} en cartera</span></div>` : ''}</td>
        <td>${esc(tipoCobroLabel(r.tipo_cobro) || '—')}</td>
        <td class="num">${monto(r.saldo_cf, 'ARS')}${r.a_favor_cf > 0.005 ? `<div class="cob-favor">a favor ${money(r.a_favor_cf, 'ARS')}</div>` : ''}</td>
        <td class="num">${monto(r.saldo_sf, 'USD')}${r.a_favor_sf > 0.005 ? `<div class="cob-favor">a favor ${money(r.a_favor_sf, 'USD')}</div>` : ''}</td>
        <td class="num">${r.abiertos || '<span class="cob-cero">—</span>'}</td>
        <td>${r.fecha_mas_vieja ? `${formatDate(r.fecha_mas_vieja)} <span class="cliente-sub">(${r.antiguedad_dias} días)</span>` : '<span class="cob-cero">—</span>'}</td>
        <td>${estadoBadge(r)}</td>
        <td>${r.ultimo_reclamo ? esc(formatDate(r.ultimo_reclamo.slice(0, 10)) + r.ultimo_reclamo.slice(10)) : '<span class="cob-cero">nunca</span>'}</td>
        <td><button class="btn btn-secondary btn-sm">Ver cuenta</button></td>
      </tr>`).join('');
    const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    $('pie-saldos').innerHTML = `<tr><td colspan="2">${rows.length} clientes</td><td class="num">${money(sum('saldo_cf'), 'ARS')}</td><td class="num">${money(sum('saldo_sf'), 'USD')}</td><td class="num">${sum('abiertos')}</td><td colspan="4"></td></tr>`;
  }

  // ---------- Vista 2: ficha ----------
  async function abrirFicha(id, push = true) {
    clienteActual = Number(id);
    if (push) history.pushState({ cliente: clienteActual }, '', `?cliente=${clienteActual}`);
    $('vista-saldos').classList.add('hidden');
    $('vista-ficha').classList.remove('hidden');
    $('btn-volver').classList.remove('hidden');
    $('btn-perfil').classList.remove('hidden');
    $('btn-perfil').href = `clientes-perfil.html?id=${clienteActual}`;
    $('titulo').textContent = 'Cobranzas · cuenta corriente';
    $('fc-nombre').textContent = 'Cargando…';
    $('fc-sub').textContent = '';
    $('fc-razones').innerHTML = '';
    try {
      const [cli, pend, razones] = await Promise.all([
        api.clientes.obtener(clienteActual),
        api.cobranzas.pendientes(clienteActual),
        api.get(`/clientes/${clienteActual}/razones-sociales`).catch(() => null),
      ]);
      const c = cli.cliente || cli;
      $('fc-nombre').textContent = c.nombre_nova || c.nombre || `Cliente #${clienteActual}`;
      const partes = [];
      if (c.nombre_nova && c.nombre && c.nombre !== c.nombre_nova) partes.push(c.nombre);
      if (c.tipo_cobro) partes.push(tipoCobroLabel(c.tipo_cobro));
      if (c.plazo_pago_dias != null) partes.push(`plazo ${c.plazo_pago_dias} días`);
      $('fc-sub').textContent = partes.join(' · ');
      const lista = Array.isArray(razones) ? razones : (razones && (razones.razones_sociales || razones.razones)) || [];
      if (lista.length) {
        $('fc-razones').innerHTML = lista.map((r) => `<span>${esc(r.razon_social)}${r.cuit ? ` <b>${esc(r.cuit)}</b>` : ''}${r.es_tercero ? ' <b>(tercero)</b>' : ''}</span>`).join('');
      }
      renderLibro('CF', pend.CF, pend.saldo_cf, 'ARS');
      renderLibro('SF', pend.SF, pend.saldo_sf, 'USD');
      // El historial arranca en el libro que tiene movimiento.
      libroHist = pend.CF.length || !pend.SF.length ? 'CF' : 'SF';
      document.querySelectorAll('.cob-hist-filtros .tab').forEach((t) => t.classList.toggle('active', t.dataset.libro === libroHist));
      await cargarHistorial();
    } catch (e) {
      showAlert(alertBox, e.message || 'No se pudo abrir la cuenta del cliente');
    }
  }

  function renderLibro(libro, items, saldo, moneda) {
    const hoy = hoyLocal();
    const debitos = items.filter((x) => ['FA', 'LQ', 'ND'].includes(x.tipo));
    const creditos = items.filter((x) => ['NC', 'AC'].includes(x.tipo));
    $(`fc-saldo-${libro.toLowerCase()}`).textContent = money(saldo, moneda);
    const favor = creditos.reduce((a, x) => a + x.saldo, 0);
    $(`fc-favor-${libro.toLowerCase()}`).textContent = favor > 0.005 ? `a favor ${money(favor, moneda)}` : '';
    const tb = $(`fc-abiertos-${libro.toLowerCase()}`);
    if (!items.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">Nada pendiente</td></tr>'; return; }
    const fila = (x, cred) => {
      const venc = x.vencimiento && x.vencimiento < hoy && !cred;
      const detalle = [x.razon_social, x.descripcion].filter(Boolean).join(' · ');
      return `<tr class="${venc ? 'vencido' : ''}">
        <td>${formatDate(x.fecha)}</td>
        <td><span class="badge badge-tipo ${x.tipo}">${x.tipo}</span> ${esc(comprobanteRef(x))}${x.envios ? ` <span class="cob-desc">${x.envios} envíos</span>` : ''}${detalle ? `<div class="cob-desc">${esc(detalle)}</div>` : ''}${x.origen === 'gecom' ? ' <span class="badge badge-origen">GECOM</span>' : ''}</td>
        <td>${cred ? '—' : `${formatDate(x.vencimiento)}${venc ? ` <span class="badge badge-mora">${x.mora_dias} días</span>` : ''}`}</td>
        <td class="num">${cred ? '-' : ''}${money(x.importe, moneda)}</td>
        <td class="num"><b>${cred ? '-' : ''}${money(x.saldo, moneda)}</b></td>
      </tr>`;
    };
    tb.innerHTML = debitos.map((x) => fila(x, false)).join('') + creditos.map((x) => fila(x, true)).join('');
  }

  async function cargarHistorial() {
    if (!clienteActual) return;
    const tb = $('fc-historial');
    tb.innerHTML = '<tr><td colspan="7" class="empty">Cargando…</td></tr>';
    const moneda = libroHist === 'CF' ? 'ARS' : 'USD';
    try {
      const data = await api.cobranzas.historial(clienteActual, {
        libro: libroHist, desde: $('h-desde').value, hasta: $('h-hasta').value, anulados: $('h-anulados').checked,
      });
      const movs = (data.movimientos || []).slice().reverse(); // lo más nuevo arriba
      if (!movs.length) { tb.innerHTML = '<tr><td colspan="7" class="empty">Sin movimientos en este libro</td></tr>'; return; }
      tb.innerHTML = movs.map((m) => {
        const detalle = [m.razon_social, m.descripcion, m.ref_tipo ? `sobre ${m.ref_tipo} ${m.ref_numero || ''}` : ''].filter(Boolean).join(' · ');
        return `<tr class="${m.anulado_at ? 'anulado' : ''}">
          <td>${formatDate(m.fecha)}</td>
          <td><span class="badge badge-tipo ${m.tipo}">${m.tipo}</span></td>
          <td>${esc(comprobanteRef(m))}${m.origen === 'gecom' ? ' <span class="badge badge-origen">GECOM</span>' : ''}</td>
          <td class="cob-desc">${esc(detalle)}${m.anulado_at ? ` · anulado${m.anulado_motivo ? ': ' + esc(m.anulado_motivo) : ''}` : ''}</td>
          <td class="num">${monto(m.debito, moneda)}</td>
          <td class="num">${monto(m.credito, moneda)}</td>
          <td class="num acum">${m.anulado_at ? '' : money(m.acumulado, moneda)}</td>
        </tr>`;
      }).join('');
    } catch (e) {
      tb.innerHTML = `<tr><td colspan="7" class="empty">${esc(e.message || 'Error')}</td></tr>`;
    }
  }

  function volverASaldos(push = true) {
    clienteActual = null;
    if (push) history.pushState({}, '', location.pathname);
    $('vista-ficha').classList.add('hidden');
    $('vista-saldos').classList.remove('hidden');
    $('btn-volver').classList.add('hidden');
    $('btn-perfil').classList.add('hidden');
    $('titulo').textContent = 'Cobranzas';
    cargarSaldos();
  }

  // ---------- eventos ----------
  ['f-libro', 'f-tipo', 'f-todos'].forEach((id) => $(id).addEventListener('change', cargarSaldos));
  ['f-buscar', 'f-orden', 'f-vencidos'].forEach((id) => $(id).addEventListener('input', renderTabla));
  $('tabla-saldos').addEventListener('click', (e) => {
    const tr = e.target.closest('tr.fila-cliente');
    if (tr) abrirFicha(tr.dataset.id);
  });
  $('btn-volver').addEventListener('click', () => volverASaldos());
  document.querySelectorAll('.cob-hist-filtros .tab').forEach((t) => t.addEventListener('click', () => {
    libroHist = t.dataset.libro;
    document.querySelectorAll('.cob-hist-filtros .tab').forEach((x) => x.classList.toggle('active', x === t));
    cargarHistorial();
  }));
  ['h-desde', 'h-hasta', 'h-anulados'].forEach((id) => $(id).addEventListener('change', cargarHistorial));
  window.addEventListener('popstate', () => {
    const id = new URLSearchParams(location.search).get('cliente');
    if (id) abrirFicha(id, false); else volverASaldos(false);
  });

  // ---------- arranque ----------
  const inicial = new URLSearchParams(location.search).get('cliente');
  if (inicial) abrirFicha(inicial, false); else cargarSaldos();
})();
