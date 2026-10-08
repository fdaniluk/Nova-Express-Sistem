// Costos de la empresa (08/10/2026). Pinta lo que devuelve GET /api/costos?mes=…: el
// backend decide qué ve cada uno (puede_todo) y la pantalla solo muestra u oculta.
//   · dirección (ver_costos / admin): tarjetas, todas las categorías, confirmar, fijos,
//     dólar del mes, categorías;
//   · empleado: cargar gastos del día a día, ver y editar los suyos por confirmar.
(function () {
  const $ = (id) => document.getElementById(id);
  const alertBox = $('alert-box');
  const tabla = $('cos-tabla');
  const form = $('cos-form');
  const mesInput = $('cos-mes');

  const fmtArs = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const fmtUsd = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usd = (n) => 'US$ ' + fmtUsd.format(n || 0);
  const plata = (n, moneda) => (moneda === 'USD' ? usd(n) : fmtArs.format(n || 0));
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const nombreMes = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MESES[m - 1]} ${y}`; };
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let datos = null;
  let moneda = (function () { try { return localStorage.getItem('costos_moneda') === 'ARS' ? 'ARS' : 'USD'; } catch (e) { return 'USD'; } }());
  let editando = null;

  function mesHoy() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
  function moverMes(ym, n) { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

  // ── Carga ─────────────────────────────────────────────────────────────────────────
  async function cargar() {
    const mes = mesInput.value || mesHoy();
    try {
      datos = await NovaAPI.costos.mes(mes);
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'No se pudieron leer los costos: ' + err.message);
      return;
    }
    try { sessionStorage.setItem('costos_mes', mes); } catch (e) { /* nada */ }
    pintar();
  }

  function pintar() {
    const d = datos;
    const todo = !!d.puede_todo;
    document.body.classList.toggle('cos-todo', todo);
    $('cos-tiles').classList.toggle('hidden', !todo);
    $('cos-aviso-emp').classList.toggle('hidden', todo);
    $('btn-traer-fijos').classList.toggle('hidden', !todo);
    $('btn-categorias').classList.toggle('hidden', !todo);
    $('c-fijo-grupo').classList.toggle('hidden', !todo);
    $('cos-lista-titulo').textContent = (todo ? 'Costos de ' : 'Gastos del día a día de ') + nombreMes(d.mes);

    // Dólar del mes
    const tc = $('cos-tc');
    if (d.tc) { tc.textContent = `dólar del mes ${fmtUsd.format(d.tc).replace(',00', '')} · ${d.tc_fuente}`; tc.classList.remove('sin'); }
    else { tc.textContent = 'sin dólar del mes: cargalo acá o en Cobranzas'; tc.classList.add('sin'); }
    tc.classList.toggle('editable', todo);
    $('cos-th-conv').textContent = moneda === 'USD' ? 'En USD' : 'En ARS';
    $('cos-moneda').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.moneda === moneda));

    // Categorías del formulario
    const sel = $('c-categoria');
    const actual = sel.value;
    sel.innerHTML = '<option value="">Elegí…</option>' + (d.categorias_disponibles || []).map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('');
    if (actual) sel.value = actual;

    pintarTiles();
    pintarTabla();
  }

  function pintarTiles() {
    const t = datos.totales;
    if (!t) return;
    const n = (id) => $(id).querySelector('.n');
    const s = (id) => $(id).querySelector('.s');
    const principal = moneda === 'USD' ? (t.sin_tc ? null : t.usd_total) : (t.sin_tc ? null : t.ars_total);
    n('tile-costos').textContent = principal == null ? '—' : plata(principal, moneda);
    s('tile-costos').textContent = (t.ars ? `${fmtArs.format(t.ars)} en pesos` : '') + (t.ars && t.usd ? ' + ' : '') + (t.usd ? `${usd(t.usd)} en dólares` : '') + (t.sin_tc ? ' · falta el dólar del mes para sumar todo' : '');
    n('tile-utilidad').textContent = moneda === 'USD' ? usd(t.utilidad_envios) : (datos.tc ? fmtArs.format(t.utilidad_envios * datos.tc) : '—');
    s('tile-utilidad').textContent = `${t.envios} envío${t.envios === 1 ? '' : 's'} del mes · la misma del Dashboard`;
    const neto = t.resultado_neto;
    const nn = n('tile-neto');
    nn.textContent = neto == null ? '—' : (moneda === 'USD' ? usd(neto) : (datos.tc ? fmtArs.format(neto * datos.tc) : '—'));
    nn.classList.toggle('neg', neto != null && neto < 0);
    s('tile-neto').textContent = neto == null ? 'falta el dólar del mes' : `utilidad − costos${t.resultado_pct != null ? ` · ${t.resultado_pct} % de la utilidad` : ''}${neto < 0 ? ' · el mes no cubre los costos' : ''}`;
    const ant = t.mes_anterior || {};
    const na = n('tile-anterior');
    na.classList.remove('sube', 'baja');
    if (ant.variacion_pct == null) { na.textContent = '—'; s('tile-anterior').textContent = ant.usd_total ? `${nombreMes(ant.mes)}: ${usd(ant.usd_total)} de costos` : `${nombreMes(ant.mes)}: sin costos cargados`; }
    else { na.textContent = `${ant.variacion_pct > 0 ? '+' : ''}${ant.variacion_pct} %`; na.classList.add(ant.variacion_pct > 0 ? 'sube' : 'baja'); s('tile-anterior').textContent = `${nombreMes(ant.mes)}: ${usd(ant.usd_total)} de costos`; }
  }

  function pintarTabla() {
    const d = datos;
    const todo = !!d.puede_todo;
    const conv = (c) => (moneda === 'USD' ? c.usd : c.ars);
    const grupos = d.categorias || [];
    $('cos-resumen').textContent = d.costos.length ? `${d.costos.length} costo${d.costos.length === 1 ? '' : 's'}${d.por_confirmar ? ` · ${d.por_confirmar} por confirmar` : ''}` : '';
    if (!d.costos.length) {
      tabla.innerHTML = `<tr><td colspan="7" class="empty">${todo ? 'No hay costos cargados en este mes. Cargá el primero arriba o traé los fijos del mes pasado.' : 'No hay gastos del día a día cargados en este mes.'}</td></tr>`;
      $('cos-pie').textContent = '';
      return;
    }
    let html = '';
    for (const g of grupos) {
      const filas = d.costos.filter((c) => c.categoria_id === g.categoria_id);
      const total = moneda === 'USD' ? g.usd_total : (filas.every((c) => c.ars != null) ? filas.reduce((a, c) => a + c.ars, 0) : null);
      html += `<tr class="cat"><td colspan="3">${esc(g.categoria)}${g.automatica ? ' <span class="cos-chip auto">sale de las facturas del courier</span>' : ''}</td><td class="num">${g.sin_tc || total == null ? '—' : plata(total, moneda)}${todo && g.pct != null ? `<span class="pct">${g.pct} % de los costos</span>` : ''}</td><td colspan="3"></td></tr>`;
      for (const c of filas) {
        const porConf = c.estado === 'por_confirmar';
        const mio = window.currentUser && c.creado_por === window.currentUser.id;
        const puedeEditar = !c.automatica && (todo || (porConf && mio));
        const estado = c.automatica ? '<span class="cos-chip auto">automático</span>'
          : porConf ? '<span class="cos-chip ambar">por confirmar</span>'
            : `<span class="cos-chip ok">confirmado</span>${c.fijo ? ' <span class="cos-chip">fijo</span>' : ''}`;
        const acciones = [];
        if (todo && porConf) acciones.push(`<button type="button" class="btn btn-sm btn-coral" data-action="confirmar" data-id="${c.id}">Confirmar</button>`);
        if (c.automatica) acciones.push('<a class="btn btn-sm btn-outline" href="facturas.html#iibb">Ver facturas</a>');
        if (puedeEditar) acciones.push(`<button type="button" class="btn btn-sm btn-outline" data-action="editar" data-id="${c.id}">Editar</button>`);
        if (puedeEditar) acciones.push(`<button type="button" class="btn btn-sm btn-outline btn-outline-rojo" data-action="eliminar" data-id="${c.id}">Borrar</button>`);
        html += `<tr class="${porConf ? 'por-confirmar' : ''}${c.automatica ? ' automatica' : ''}" data-id="${c.id || ''}">
          <td>${esc(c.detalle)}${c.nota ? ` <span class="em" title="${esc(c.nota)}">· ${esc(c.nota)}</span>` : ''}</td>
          <td><span class="cos-chip ${c.moneda === 'USD' ? 'ok' : ''}">${c.moneda}</span></td>
          <td class="num orig">${plata(c.monto, c.moneda)}</td>
          <td class="num conv">${c.moneda === moneda ? '' : (conv(c) == null ? 'sin dólar' : plata(conv(c), moneda))}</td>
          <td>${estado}</td>
          <td class="quien">${c.automatica ? 'sistema' : esc(c.creado_por_nombre || '—')}${porConf ? '' : (c.confirmado_por_nombre && c.confirmado_por_nombre !== c.creado_por_nombre ? ` · ok ${esc(c.confirmado_por_nombre)}` : '')}</td>
          <td><div class="cos-fila-acciones">${acciones.join('')}</div></td>
        </tr>`;
      }
    }
    tabla.innerHTML = html;
    $('cos-pie').textContent = todo
      ? '"Fijo" se copia al mes siguiente como "por confirmar" (botón "Traer los fijos del mes pasado"); se confirma con el monto real cuando llega la factura. Lo que carga la oficina también entra por confirmar. Ingresos Brutos no se edita: es la suma de las percepciones de las facturas del courier con fecha en el mes.'
      : 'Lo que cargás queda por confirmar hasta que lo revise dirección; mientras tanto lo podés corregir o borrar.';
    tabla.querySelectorAll('button[data-action]').forEach((b) => b.addEventListener('click', () => accion(b.dataset.action, Number(b.dataset.id))));
  }

  // ── Acciones de fila ──────────────────────────────────────────────────────────────
  async function accion(que, id) {
    const c = datos.costos.find((x) => x.id === id);
    if (!c) return;
    if (que === 'editar') return abrirEdicion(c);
    if (que === 'eliminar') {
      if (!confirm(`¿Borrar "${c.detalle}" (${plata(c.monto, c.moneda)})?`)) return;
      try { await NovaAPI.costos.eliminar(id); NovaUtils.showAlert(alertBox, 'Costo borrado.', 'success'); await cargar(); } catch (err) { NovaUtils.showAlert(alertBox, err.message); }
      return;
    }
    if (que === 'confirmar') {
      const v = prompt(`Confirmar "${c.detalle}". Monto real en ${c.moneda} (Enter deja ${c.monto}):`, String(c.monto));
      if (v === null) return;
      const monto = v.trim() === '' ? undefined : Number(String(v).replace(/\./g, '').replace(',', '.'));
      if (monto !== undefined && !(monto > 0)) { NovaUtils.showAlert(alertBox, 'El monto tiene que ser mayor a 0.'); return; }
      try { await NovaAPI.costos.confirmar(id, monto); NovaUtils.showAlert(alertBox, 'Costo confirmado.', 'success'); await cargar(); } catch (err) { NovaUtils.showAlert(alertBox, err.message); }
    }
  }

  // ── Formulario ────────────────────────────────────────────────────────────────────
  function limpiarForm() {
    editando = null;
    form.reset();
    $('c-id').value = '';
    $('c-moneda').value = 'ARS';
    $('c-fijo').value = '0';
    $('cos-form-title').textContent = 'Cargar un costo';
    $('btn-guardar').textContent = 'Guardar costo';
    $('cos-form-panel').classList.remove('editando');
  }

  function abrirEdicion(c) {
    editando = c;
    $('c-id').value = c.id;
    $('c-categoria').value = String(c.categoria_id);
    $('c-detalle').value = c.detalle;
    $('c-monto').value = c.monto;
    $('c-moneda').value = c.moneda;
    $('c-fijo').value = c.fijo ? '1' : '0';
    $('c-nota').value = c.nota || '';
    $('cos-form-title').textContent = 'Editar costo';
    $('btn-guardar').textContent = 'Guardar cambios';
    $('cos-form-panel').classList.add('editando');
    $('cos-form-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('c-detalle').focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {
      mes: mesInput.value || mesHoy(),
      categoria_id: Number($('c-categoria').value),
      detalle: $('c-detalle').value.trim(),
      monto: Number($('c-monto').value),
      moneda: $('c-moneda').value,
      fijo: $('c-fijo').value === '1' ? 1 : 0,
      nota: $('c-nota').value.trim() || null,
    };
    if (!data.categoria_id) { NovaUtils.showAlert(alertBox, 'Elegí la categoría.'); return; }
    if (!data.detalle) { NovaUtils.showAlert(alertBox, 'Escribí el detalle.'); return; }
    if (!(data.monto > 0)) { NovaUtils.showAlert(alertBox, 'El monto tiene que ser mayor a 0.'); return; }
    try {
      if (editando) { await NovaAPI.costos.editar(editando.id, data); NovaUtils.showAlert(alertBox, 'Costo actualizado.', 'success'); }
      else { const r = await NovaAPI.costos.crear(data); NovaUtils.showAlert(alertBox, r.estado === 'por_confirmar' ? 'Gasto cargado: queda por confirmar.' : 'Costo cargado.', 'success'); }
      limpiarForm();
      await cargar();
    } catch (err) { NovaUtils.showAlert(alertBox, err.message); }
  });
  $('btn-cancelar').addEventListener('click', limpiarForm);

  // ── Mes, moneda, fijos ────────────────────────────────────────────────────────────
  $('cos-mes-prev').addEventListener('click', () => { mesInput.value = moverMes(mesInput.value || mesHoy(), -1); cargar(); });
  $('cos-mes-next').addEventListener('click', () => { mesInput.value = moverMes(mesInput.value || mesHoy(), 1); cargar(); });
  mesInput.addEventListener('change', () => { if (mesInput.value) cargar(); });
  $('cos-moneda').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    moneda = b.dataset.moneda;
    try { localStorage.setItem('costos_moneda', moneda); } catch (e) { /* nada */ }
    if (datos) pintar();
  }));
  $('btn-traer-fijos').addEventListener('click', async () => {
    try {
      const r = await NovaAPI.costos.traerFijos(mesInput.value || mesHoy());
      NovaUtils.showAlert(alertBox, r.copiados ? `${r.copiados} costo${r.copiados === 1 ? '' : 's'} fijo${r.copiados === 1 ? '' : 's'} de ${nombreMes(r.desde)} copiado${r.copiados === 1 ? '' : 's'} como "por confirmar".` : `No había fijos nuevos en ${nombreMes(r.desde)} para copiar.`, r.copiados ? 'success' : 'info');
      await cargar();
    } catch (err) { NovaUtils.showAlert(alertBox, err.message); }
  });

  // ── Dólar del mes ─────────────────────────────────────────────────────────────────
  $('cos-tc').addEventListener('click', () => {
    if (!datos || !datos.puede_todo) return;
    $('tc-explica').textContent = datos.tc
      ? `Hoy se usa ${fmtUsd.format(datos.tc)} (${datos.tc_fuente}). Si cargás uno a mano, manda para ${nombreMes(datos.mes)}.`
      : `No hay tipo de cambio para ${nombreMes(datos.mes)}: Cobranzas no cargó ninguno. Ponelo acá para poder sumar los pesos con los dólares.`;
    $('tc-valor').value = datos.tc_manual ? datos.tc : '';
    $('modal-tc').classList.remove('hidden');
    $('tc-valor').focus();
  });
  $('modal-tc-cerrar').addEventListener('click', () => $('modal-tc').classList.add('hidden'));
  $('tc-guardar').addEventListener('click', async () => {
    const v = Number($('tc-valor').value);
    if (!(v > 0)) { NovaUtils.showAlert(alertBox, 'El dólar tiene que ser mayor a 0.'); return; }
    try { await NovaAPI.costos.guardarTc(datos.mes, v); $('modal-tc').classList.add('hidden'); await cargar(); } catch (err) { NovaUtils.showAlert(alertBox, err.message); }
  });
  $('tc-borrar').addEventListener('click', async () => {
    try { await NovaAPI.costos.guardarTc(datos.mes, null); $('modal-tc').classList.add('hidden'); await cargar(); } catch (err) { NovaUtils.showAlert(alertBox, err.message); }
  });

  // ── Categorías ────────────────────────────────────────────────────────────────────
  async function pintarCategorias() {
    const cats = await NovaAPI.costos.categorias(true);
    const tb = $('cat-tabla').querySelector('tbody');
    tb.innerHTML = cats.map((c) => `<tr data-id="${c.id}">
      <td>${esc(c.nombre)}${c.automatica ? ' <span class="cos-chip auto">automática</span>' : ''}</td>
      <td>${c.automatica ? '—' : `<input type="checkbox" data-campo="oficina" ${c.oficina ? 'checked' : ''}>`}</td>
      <td>${c.automatica ? '—' : `<input type="checkbox" data-campo="activa" ${c.activa ? 'checked' : ''}>`}</td>
    </tr>`).join('');
    tb.querySelectorAll('input[data-campo]').forEach((i) => i.addEventListener('change', async () => {
      const id = Number(i.closest('tr').dataset.id);
      try { await NovaAPI.costos.editarCategoria(id, { [i.dataset.campo]: i.checked ? 1 : 0 }); await cargar(); } catch (err) { NovaUtils.showAlert(alertBox, err.message); i.checked = !i.checked; }
    }));
  }
  $('btn-categorias').addEventListener('click', async () => { await pintarCategorias(); $('modal-cat').classList.remove('hidden'); });
  $('modal-cat-cerrar').addEventListener('click', () => $('modal-cat').classList.add('hidden'));
  $('cat-agregar').addEventListener('click', async () => {
    const nombre = $('cat-nombre').value.trim();
    if (!nombre) return;
    try { await NovaAPI.costos.crearCategoria({ nombre, oficina: $('cat-oficina').checked ? 1 : 0 }); $('cat-nombre').value = ''; $('cat-oficina').checked = false; await pintarCategorias(); await cargar(); } catch (err) { NovaUtils.showAlert(alertBox, err.message); }
  });
  [$('modal-cat'), $('modal-tc')].forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));

  // ── Arranque ──────────────────────────────────────────────────────────────────────
  (function init() {
    let mes = mesHoy();
    try { mes = sessionStorage.getItem('costos_mes') || mes; } catch (e) { /* nada */ }
    mesInput.value = mes;
    cargar();
  }());
}());
