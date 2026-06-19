(function () {
  // ── Constantes ──────────────────────────────────────────────────────────────
  const DIAS_ALERTA_ROJO = 15;    // umbral de días para semáforo rojo
  const PAGE_SIZE = 100;          // filas por página

  // ── Estado ──────────────────────────────────────────────────────────────────
  let allData = [];          // todos los envíos cargados del servidor
  let filteredData = [];     // resultado de aplicar todos los filtros (lista de envíos)
  let visibleCount = 0;      // cuántos ENVÍOS ya mostramos (la paginación cuenta envíos)
  let sortCol = 'fecha';
  let sortDir = 'desc';
  let searchTerm = '';
  let soloAlertas = false;
  const colFilters = {};     // { courier: Set(['UPS','DHL']), ... }

  // dropdown flotante
  let ddColumn = null;
  let ddTempSelected = new Set();

  // caché de resultados de tracking (por sesión)
  const trackingCache = {};

  // estado del modal de edición
  let editEnvio = null;

  const alertBox = document.getElementById('alert-box');

  // ── Init ────────────────────────────────────────────────────────────────────
  async function init() {
    buildEditModal();
    bindSearch();
    bindSortHeaders();
    bindFilterButtons();
    bindDropdown();
    bindExport();
    bindAlertToggle();
    bindLoadMore();
    bindTracking();
    bindRowEdit();
    bindBultoGuiaEdit();
    await loadData();
  }

  // ── Carga de datos ──────────────────────────────────────────────────────────
  async function loadData() {
    try {
      allData = await NovaAPI.salidas.listar();
      applyAll();
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar salidas: ' + err.message, 'error');
      document.getElementById('salidas-body').innerHTML =
        '<tr><td colspan="30" class="salidas-empty">Error al cargar datos</td></tr>';
    }
  }

  // ── Pipeline de filtrado / agrupado / render ─────────────────────────────────
  function applyAll() {
    filtered();
    visibleCount = 0;
    renderPage();
    updateCounter();
    renderChips();
  }

  function filtered() {
    const today = todayStr();
    filteredData = allData.filter((e) => {
      // Buscador general
      if (searchTerm) {
        const hay = [
          e.numero_salida, e.courier, e.numero_guia,
          e.cliente_nombre, e.destino, e.destino_raw, e.observaciones,
        ].map((v) => String(v || '').toLowerCase()).join(' ');
        if (!hay.includes(searchTerm)) return false;
      }

      // Filtros por columna
      for (const [col, vals] of Object.entries(colFilters)) {
        if (!vals || vals.size === 0) continue;
        const cell = resolveCell(e, col, today);
        if (!vals.has(String(cell))) return false;
      }

      // Solo alertas
      if (soloAlertas) {
        const a = alertLevel(e);
        if (!a) return false;
      }

      return true;
    });
  }

  // Devuelve el valor de la celda que se usa para filtrar/mostrar
  function resolveCell(e, col, today) {
    if (col === 'estado') return estadoLabel(e, today);
    if (col === 'tipo_paquete') return e.tipo_paquete || '—';
    if (col === 'direccion') return e.direccion || 'expo';
    return String(e[col] ?? '');
  }

  // ── Render: fila por bulto ───────────────────────────────────────────────────
  // El sort y el filtro operan sobre la lista de ENVÍOS (filteredData). La expansión
  // a N renglones por bulto es un paso puro de render: cada envío ya ordenado/filtrado
  // se convierte en e.bultos.length renglones. La paginación cuenta ENVÍOS.
  function renderPage() {
    const today = todayStr();
    const tbody = document.getElementById('salidas-body');
    const fragment = document.createDocumentFragment();
    const nextBatch = filteredData.slice(visibleCount, visibleCount + PAGE_SIZE);

    if (visibleCount === 0) tbody.innerHTML = '';

    for (const e of nextBatch) {
      const bultos = (e.bultos && e.bultos.length) ? e.bultos : [null];
      bultos.forEach((bulto, idx) => {
        fragment.appendChild(buildRow(e, bulto, idx, bultos.length, today, idx === 0));
      });
    }

    if (visibleCount === 0 && nextBatch.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="30" class="salidas-empty">No hay envíos que coincidan con los filtros</td>';
      tbody.appendChild(tr);
    } else {
      tbody.appendChild(fragment);
    }

    visibleCount += nextBatch.length;
    const loadMoreWrap = document.getElementById('load-more-wrap');
    loadMoreWrap.style.display = visibleCount < filteredData.length ? '' : 'none';
  }

  // Arma un renglón. `bulto` son los datos de ESTE bulto; `isFirst` es el primer
  // renglón del envío (lleva todos los datos/costo del envío). Los renglones
  // siguientes solo llevan #Sal (repetido) y las columnas del bulto.
  function buildRow(e, bulto, idx, totalBultos, today, isFirst) {
    const tr = document.createElement('tr');
    tr.dataset.envioId = e.id;
    if (!isFirst) tr.classList.add('bulto-detail-row');

    // Alertas: resaltar TODOS los renglones del envío (se ve como una unidad).
    const alert = alertLevel(e, today);
    if (alert === 'rojo') tr.classList.add('row-alert-rojo');
    else if (alert === 'ambar') tr.classList.add('row-alert-ambar');

    // Datos del bulto de este renglón (fallback a campos del envío para el bulto sintético).
    const b = bulto || {};
    const bultoGuia = b.numero_guia || e.numero_guia;
    const pesoReal = b.peso_real != null ? b.peso_real : e.peso;
    const largo = b.largo != null ? b.largo : e.largo;
    const ancho = b.ancho != null ? b.ancho : e.ancho;
    const alto = b.alto != null ? b.alto : e.alto;
    const numBulto = b.numero_bulto != null ? b.numero_bulto : (idx + 1);

    // Iconos (revisión/alerta/tracking) solo en el primer renglón del envío.
    const guiaIcons = isFirst
      ? `${revisionIconHtml(e)}${alert ? alertIconHtml(alert, e) : ''}${e.courier === 'UPS' ? trackBtnHtml(e.numero_guia) : ''}`
      : '';

    // Lápiz para editar la guía de ESTE bulto: solo en bultos reales (id no nulo).
    // En el bulto único (sintético, id null) la guía se edita con el modal del envío.
    const bultoGuiaEdit = (b.id != null) ? bultoGuiaEditBtnHtml(b) : '';

    // env(html): celda solo en el primer renglón; en los siguientes va en blanco.
    const env = (html) => (isFirst ? html : '');

    tr.innerHTML = `
      <td>${fmtNum(e.num_sal)}</td>
      <td>${env(courierBadge(e.courier))}</td>
      <td>${env(NovaUtils.formatDate(e.fecha))}</td>
      <td class="mono"><span class="bulto-guia-text">${esc(bultoGuia)}</span>${bultoGuiaEdit}${guiaIcons}</td>
      <td>${env(cobroBadge(e.tipo_cobro))}</td>
      <td>${env(`<a href="clientes-perfil.html?id=${e.cliente_id}">${esc(e.cliente_nombre)}</a>`)}</td>
      <td>${env(esc(e.destino))}</td>
      <td>${numBulto}/${totalBultos}</td>
      <td>${env(tipoBadge(e.tipo_paquete))}</td>
      <td>${env(dirBadge(e.direccion))}</td>
      <td class="num">${fmtDim(largo)}</td>
      <td class="num">${fmtDim(ancho)}</td>
      <td class="num">${fmtDim(alto)}</td>
      <td class="num">${fmtKg(pesoReal)}</td>
      <td class="num">${env(fmtKg(e.peso_facturable))}</td>
      <td class="num">${env(fmtUSD(e.valor_declarado))}</td>
      <td>${env(e.asegurado ? 'Sí' : 'No')}</td>
      <td class="num">${env(fmtUSD(e.total))}</td>
      <td class="num">${env(fmtUSD(e.flete))}</td>
      <td class="num">${env(fmtUSD(e.descuento))}</td>
      <td class="num">${env(fmtUSD(e.seguro))}</td>
      <td class="num">${env(fmtUSD(e.fuel))}</td>
      <td class="num">${env(fmtUSD(e.derechos))}</td>
      <td class="num">${env(fmtUSD(e.adicionales))}</td>
      <td class="num">${env(fmtUSD(e.otros))}</td>
      <td class="num">${env(fmtUSD(e.compra_total))}</td>
      <td class="num">${env(profitCell(e))}</td>
      <td class="num">${env(pctCell(e))}</td>
      <td>${env(estadoBadge(e, today))}</td>
      <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis" title="${isFirst ? esc(e.observaciones) : ''}">${env(esc(e.observaciones))}</td>
    `;

    return tr;
  }

  // ── Auto 2: alertas de profit ────────────────────────────────────────────────
  // Retorna 'rojo' | 'ambar' | null
  function alertLevel(e) {
    if (e.profit !== null && e.profit < 0) return 'rojo';
    if (e.profit === 0 || (e.total && !e.flete && !e.profit)) return 'ambar';
    if (!e.total && e.valor_declarado) return 'ambar';
    return null;
  }

  function alertMsg(e) {
    if (e.profit !== null && e.profit < 0) return 'Profit negativo';
    if (e.profit === 0) return 'Profit es 0 — verificar';
    if (!e.total && e.valor_declarado) return 'Sin costo cargado';
    return 'Datos incompletos';
  }

  function alertIconHtml(level, e) {
    const color = level === 'rojo' ? '#dc2626' : '#d97706';
    return `<span class="alert-icon" title="${alertMsg(e)}" style="color:${color}">⚠</span>`;
  }

  function revisionIconHtml(e) {
    if (e.estado_revision === 'a_revisar') {
      return `<span class="alert-icon" title="A revisar" style="color:#d97706">⚑</span>`;
    }
    if (e.estado_revision === 'reclamar') {
      return `<span class="alert-icon" title="Reclamar" style="color:#dc2626">⚑</span>`;
    }
    return '';
  }

  // ── Auto 5: semáforo de antigüedad ──────────────────────────────────────────
  function estadoLabel(e, today) {
    if (e.liquidado) return 'Liquidado';
    const dias = diffDias(e.fecha, today);
    if (dias >= DIAS_ALERTA_ROJO) return `Pendiente · ${dias}d`;
    return `Pendiente · ${dias}d`;
  }

  function estadoBadge(e, today) {
    if (e.liquidado) {
      return `<span class="badge badge-liq">Liquidado</span>`;
    }
    const dias = diffDias(e.fecha, today);
    const cls = dias >= DIAS_ALERTA_ROJO ? 'badge-pend-alert' : 'badge-pend-ok';
    return `<span class="badge ${cls}">Pendiente · ${dias}d</span>`;
  }

  function diffDias(fechaStr, todayStr) {
    if (!fechaStr) return 0;
    const f = new Date(fechaStr);
    const t = new Date(todayStr);
    return Math.max(0, Math.round((t - f) / 86400000));
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  // ── Sorting ─────────────────────────────────────────────────────────────────
  function bindSortHeaders() {
    document.querySelectorAll('.salidas-table th[data-col]').forEach((th) => {
      th.addEventListener('click', (e) => {
        if (e.target.classList.contains('filter-btn')) return;
        const col = th.dataset.col;
        if (sortCol === col) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortCol = col;
          sortDir = 'asc';
        }
        document.querySelectorAll('.salidas-table th').forEach((t) => {
          t.classList.remove('sort-asc', 'sort-desc');
        });
        th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
        sortData();
        applyAll();
      });
    });
  }

  function sortData() {
    const today = todayStr();
    allData.sort((a, b) => {
      let va = getSortVal(a, sortCol, today);
      let vb = getSortVal(b, sortCol, today);
      if (va == null) va = sortDir === 'asc' ? Infinity : -Infinity;
      if (vb == null) vb = sortDir === 'asc' ? Infinity : -Infinity;
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }

  function getSortVal(e, col, today) {
    if (col === 'estado') return e.liquidado ? 0 : diffDias(e.fecha, today);
    if (col === 'numero_salida') return e.num_sal;  // #Sal ordena por el correlativo nuevo
    if (col === 'peso') return e.peso;
    return e[col] ?? null;
  }

  // ── Buscador general ─────────────────────────────────────────────────────────
  function bindSearch() {
    const input = document.getElementById('buscador');
    const clearBtn = document.getElementById('btn-clear-search');

    input.addEventListener('input', () => {
      searchTerm = input.value.trim().toLowerCase();
      clearBtn.classList.toggle('visible', searchTerm.length > 0);
      applyAll();
    });

    clearBtn.addEventListener('click', () => {
      input.value = '';
      searchTerm = '';
      clearBtn.classList.remove('visible');
      applyAll();
    });
  }

  // ── Filtros por columna (dropdown tipo Excel) ────────────────────────────────
  function bindFilterButtons() {
    document.querySelectorAll('.filter-btn[data-filter]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openDropdown(btn, btn.dataset.filter);
      });
    });
  }

  function openDropdown(triggerBtn, col) {
    const dd = document.getElementById('col-filter-dropdown');
    ddColumn = col;

    // Valores únicos de esa columna en los datos completos (no filtrados por ella misma)
    const today = todayStr();
    const dataForDD = allData.filter((e) => {
      for (const [c, vals] of Object.entries(colFilters)) {
        if (c === col) continue;
        if (!vals || vals.size === 0) continue;
        const cell = resolveCell(e, c, today);
        if (!vals.has(String(cell))) return false;
      }
      return true;
    });

    const uniqueVals = [...new Set(dataForDD.map((e) => String(resolveCell(e, col, today))))].sort();
    const current = colFilters[col] || new Set();
    ddTempSelected = new Set(current);

    buildDropdownList(uniqueVals, ddTempSelected);

    // Posicionar
    const rect = triggerBtn.getBoundingClientRect();
    dd.style.display = 'flex';
    dd.style.top = `${rect.bottom + window.scrollY + 2}px`;
    dd.style.left = `${rect.left + window.scrollX}px`;

    document.getElementById('dd-search-input').value = '';
    document.getElementById('dd-search-input').focus();
  }

  function buildDropdownList(vals, selected) {
    const list = document.getElementById('dd-list');
    list.innerHTML = vals.map((v) => `
      <label>
        <input type="checkbox" value="${esc(v)}" ${selected.has(v) ? 'checked' : ''}>
        ${esc(v) || '<em style="color:#aaa">vacío</em>'}
      </label>
    `).join('');

    list.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) ddTempSelected.add(cb.value);
        else ddTempSelected.delete(cb.value);
      });
    });
  }

  function bindDropdown() {
    const dd = document.getElementById('col-filter-dropdown');

    document.getElementById('dd-search-input').addEventListener('input', (e) => {
      const term = e.target.value.toLowerCase();
      dd.querySelectorAll('.dd-list label').forEach((lbl) => {
        lbl.style.display = lbl.textContent.toLowerCase().includes(term) ? '' : 'none';
      });
    });

    document.getElementById('dd-apply').addEventListener('click', () => {
      if (ddTempSelected.size > 0) {
        colFilters[ddColumn] = new Set(ddTempSelected);
      } else {
        delete colFilters[ddColumn];
      }
      updateFilterBtnState(ddColumn);
      dd.style.display = 'none';
      applyAll();
    });

    document.getElementById('dd-clear').addEventListener('click', () => {
      delete colFilters[ddColumn];
      updateFilterBtnState(ddColumn);
      dd.style.display = 'none';
      applyAll();
    });

    document.addEventListener('click', (e) => {
      if (!dd.contains(e.target) && !e.target.classList.contains('filter-btn')) {
        dd.style.display = 'none';
      }
    });
  }

  function updateFilterBtnState(col) {
    const btn = document.querySelector(`.filter-btn[data-filter="${col}"]`);
    if (!btn) return;
    btn.classList.toggle('active', colFilters[col] && colFilters[col].size > 0);
  }

  // ── Filter chips ─────────────────────────────────────────────────────────────
  function renderChips() {
    const container = document.getElementById('filter-chips');
    container.innerHTML = '';
    for (const [col, vals] of Object.entries(colFilters)) {
      if (!vals || vals.size === 0) continue;
      const label = colLabel(col);
      const valStr = [...vals].join(', ');
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.innerHTML = `<strong>${label}:</strong> ${esc(valStr)} <button class="chip-remove" data-col="${col}" title="Quitar filtro">×</button>`;
      chip.querySelector('.chip-remove').addEventListener('click', () => {
        delete colFilters[col];
        updateFilterBtnState(col);
        applyAll();
      });
      container.appendChild(chip);
    }
  }

  function colLabel(col) {
    const labels = {
      courier: 'Courier', tipo_cobro: 'Cobro', cliente_nombre: 'Cliente',
      destino: 'Destino', tipo_paquete: 'Tipo', direccion: 'Dir.', estado: 'Estado',
    };
    return labels[col] || col;
  }

  // ── Contador ─────────────────────────────────────────────────────────────────
  function updateCounter() {
    const total = allData.length;
    const visible = filteredData.length;
    document.getElementById('contador').textContent =
      visible === total ? `${total} envíos` : `${visible} de ${total} envíos`;
  }

  // ── Solo alertas toggle ──────────────────────────────────────────────────────
  function bindAlertToggle() {
    const btn = document.getElementById('btn-solo-alertas');
    btn.addEventListener('click', () => {
      soloAlertas = !soloAlertas;
      btn.classList.toggle('active', soloAlertas);
      applyAll();
    });
  }

  // ── Paginación "Ver más" ─────────────────────────────────────────────────────
  function bindLoadMore() {
    document.getElementById('btn-load-more').addEventListener('click', renderPage);
  }

  // ── Auto 6: exportar a Excel ─────────────────────────────────────────────────
  function bindExport() {
    document.getElementById('btn-exportar-excel').addEventListener('click', exportarExcel);
  }

  function exportarExcel() {
    // Una fila por ENVÍO, sobre la lista filtrada (mismas columnas/formato de siempre).
    const rows = filteredData;

    if (!rows.length) {
      NovaUtils.showAlert(alertBox, 'No hay datos para exportar', 'error');
      return;
    }

    const today = todayStr();
    const sheetData = rows.map((e) => ({
      '# Salida':     e.numero_salida ?? '',
      Courier:        e.courier ?? '',
      Fecha:          e.fecha ?? '',
      Guía:           e.numero_guia ?? '',
      Cobro:          e.tipo_cobro ?? '',
      Cliente:        e.cliente_nombre ?? '',
      Destino:        e.destino ?? '',
      'Dest. original': e.destino_raw ?? '',
      Dirección:      e.direccion ?? '',
      Bulto:          e.bulto ?? '',
      Tipo:           e.tipo_paquete ?? '',
      'Peso (kg)':    e.peso ?? '',
      'P. Fact (kg)': e.peso_facturable ?? '',
      'Vol. (kg)':    e.peso_volumetrico ?? '',
      'FOB (USD)':    e.valor_declarado ?? '',
      Asegurado:      e.asegurado ? 'Sí' : 'No',
      'Flete (USD)':  e.flete ?? '',
      'Dscto (USD)':  e.descuento ?? '',
      'Seguro (USD)': e.seguro ?? '',
      'Fuel (USD)':   e.fuel ?? '',
      'Derechos (USD)': e.derechos ?? '',
      'Adic. (USD)':  e.adicionales ?? '',
      'Otros (USD)':  e.otros ?? '',
      'Total (USD)':  e.total ?? '',
      'Profit (USD)': e.profit ?? '',
      '% Profit':     e.porcentaje ?? '',
      Estado:         estadoLabel(e, today),
      Observaciones:  e.observaciones ?? '',
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(sheetData);
    XLSX.utils.book_append_sheet(wb, ws, 'Salidas');
    const filename = `historial-envios-${today}.xlsx`;
    XLSX.writeFile(wb, filename);
  }

  // ── UPS Tracking ────────────────────────────────────────────────────────────
  function trackBtnHtml(guia) {
    return `<button class="track-btn" data-guia="${esc(guia)}" title="Consultar tracking UPS">🚚</button>`;
  }

  function bindTracking() {
    const popup = document.createElement('div');
    popup.id = 'tracking-popup';
    popup.className = 'tracking-popup';
    popup.style.display = 'none';
    document.body.appendChild(popup);

    document.getElementById('salidas-body').addEventListener('click', async (e) => {
      const btn = e.target.closest('.track-btn');
      if (!btn) return;
      e.stopPropagation();
      await showTrackingPopup(btn, btn.dataset.guia, popup);
    });

    document.addEventListener('click', (e) => {
      if (!popup.contains(e.target) && !e.target.classList.contains('track-btn')) {
        popup.style.display = 'none';
      }
    });
  }

  async function showTrackingPopup(btn, guia, popup) {
    const rect = btn.getBoundingClientRect();
    popup.style.display = 'block';
    popup.style.top = `${rect.bottom + window.scrollY + 4}px`;
    popup.style.left = `${rect.left + window.scrollX}px`;
    popup.innerHTML = '<div class="tracking-loading">Consultando UPS…</div>';

    if (trackingCache[guia]) {
      renderTrackingPopup(popup, trackingCache[guia]);
      return;
    }

    try {
      const data = await NovaAPI.tracking.ups(guia);
      trackingCache[guia] = { ok: true, data };
      renderTrackingPopup(popup, trackingCache[guia]);
    } catch (err) {
      trackingCache[guia] = { ok: false, error: err.message };
      renderTrackingPopup(popup, trackingCache[guia]);
    }
  }

  function renderTrackingPopup(popup, cached) {
    if (!cached.ok) {
      popup.innerHTML = `<div class="tracking-error">Error: ${esc(cached.error)}</div>`;
      return;
    }
    const d = cached.data;
    popup.innerHTML = `
      <div class="tracking-header"><span class="badge badge-ups">UPS</span> ${esc(d.guia)}</div>
      <div class="tracking-row"><span class="tracking-label">Estado</span><span>${esc(d.estado)}</span></div>
      ${d.ubicacion ? `<div class="tracking-row"><span class="tracking-label">Ubicación</span><span>${esc(d.ubicacion)}</span></div>` : ''}
      ${d.fecha ? `<div class="tracking-row"><span class="tracking-label">Fecha</span><span>${NovaUtils.formatDate(d.fecha)}</span></div>` : ''}
    `;
  }

  // ── Helpers de formato ───────────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function dash(v) {
    return v == null || v === '' ? '<span class="em">—</span>' : esc(v);
  }

  function fmtUSD(v) {
    if (v == null || v === '') return '<span class="em">—</span>';
    return `$${Number(v).toFixed(2)}`;
  }

  function fmtKg(v) {
    if (v == null || v === '') return '<span class="em">—</span>';
    return `${Number(v).toFixed(1)} kg`;
  }

  function fmtDim(v) {
    if (v == null || v === '') return '<span class="em">—</span>';
    return String(Number(v));
  }

  function fmtNum(v) {
    if (v == null || v === '') return '<span class="em">—</span>';
    return String(v);
  }

  function profitCell(e) {
    if (e.profit == null) return '<span class="em">—</span>';
    const color = e.profit < 0 ? '#dc2626' : e.profit === 0 ? '#d97706' : '#15803d';
    return `<span style="color:${color}">$${Number(e.profit).toFixed(2)}</span>`;
  }

  function pctCell(e) {
    if (e.porcentaje == null) return '<span class="em">—</span>';
    return `${Number(e.porcentaje).toFixed(1)}%`;
  }

  function courierBadge(c) {
    if (!c) return '<span class="em">—</span>';
    const cls = c === 'UPS' ? 'badge-ups' : c === 'DHL' ? 'badge-dhl' : 'badge-fx';
    return `<span class="badge ${cls}">${esc(c)}</span>`;
  }

  function cobroBadge(c) {
    if (!c) return '<span class="em">—</span>';
    const map = { D: 'badge-cobro-d', S: 'badge-cobro-s', Q: 'badge-cobro-q', CC: 'badge-cobro-cc' };
    return `<span class="badge ${map[c] || ''}">${esc(c)}</span>`;
  }

  function tipoBadge(t) {
    if (!t) return '<span class="em">—</span>';
    const cls = t === 'm' ? 'badge-m' : t === 'd' ? 'badge-d' : '';
    return `<span class="badge ${cls}">${esc(t)}</span>`;
  }

  function dirBadge(d) {
    if (!d) return '<span class="em">—</span>';
    const cls = d === 'impo' ? 'badge-impo' : 'badge-expo';
    return `<span class="badge ${cls}">${esc(d)}</span>`;
  }

  // ── Modal de edición ────────────────────────────────────────────────────────
  function buildEditModal() {
    const overlay = document.createElement('div');
    overlay.id = 'sal-edit-overlay';
    overlay.className = 'sal-modal-overlay hidden';
    overlay.innerHTML = `
      <div class="sal-modal-box">
        <div class="sal-modal-header">
          <div>
            <h2 id="sal-modal-title">Editar salida</h2>
            <div id="sal-modal-meta" class="sal-modal-meta"></div>
          </div>
          <button class="sal-modal-close" id="sal-modal-close" title="Cerrar">×</button>
        </div>
        <div class="sal-modal-body">
          <div id="sal-modal-alert"></div>
          <div>
            <div class="sal-section-title">Identificación</div>
            <div class="sal-form-grid">
              <div class="form-group" style="grid-column:span 2">
                <label>Nro. Guía *</label>
                <input type="text" id="saled-guia">
              </div>
              <div class="form-group">
                <label>Nro. Salida</label>
                <input type="number" id="saled-numero-salida" step="1" min="0">
              </div>
              <div class="form-group">
                <label>Bulto</label>
                <input type="text" id="saled-bulto">
              </div>
              <div class="form-group">
                <label>Tipo</label>
                <select id="saled-tipo-paquete">
                  <option value="">—</option>
                  <option value="m">m</option>
                  <option value="d">d</option>
                </select>
              </div>
              <div class="form-group">
                <label>Dirección</label>
                <select id="saled-direccion">
                  <option value="expo">expo</option>
                  <option value="impo">impo</option>
                </select>
              </div>
              <div class="form-group" style="justify-content:flex-end;padding-bottom:2px">
                <label>&nbsp;</label>
                <label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:13px">
                  <input type="checkbox" id="saled-asegurado" style="width:auto;margin:0">
                  Asegurado
                </label>
              </div>
            </div>
          </div>
          <div>
            <div class="sal-section-title">Costos (USD)</div>
            <div class="sal-form-grid sal-form-grid--nums">
              <div class="form-group"><label>Flete</label><input type="number" id="saled-flete" step="0.01"></div>
              <div class="form-group"><label>Descuento</label><input type="number" id="saled-descuento" step="0.01"></div>
              <div class="form-group"><label>Seguro</label><input type="number" id="saled-seguro" step="0.01"></div>
              <div class="form-group"><label>Fuel</label><input type="number" id="saled-fuel" step="0.01"></div>
              <div class="form-group"><label>Derechos</label><input type="number" id="saled-derechos" step="0.01"></div>
              <div class="form-group"><label>Adicionales</label><input type="number" id="saled-adicionales" step="0.01"></div>
              <div class="form-group"><label>Otros</label><input type="number" id="saled-otros" step="0.01"></div>
              <div class="form-group"><label>Profit</label><input type="number" id="saled-profit" step="0.01"></div>
              <div class="form-group"><label>% Profit</label><input type="number" id="saled-porcentaje" step="0.1"></div>
            </div>
          </div>
          <div class="form-group">
            <label>Observaciones</label>
            <textarea id="saled-observaciones" rows="2" style="resize:vertical"></textarea>
          </div>
        </div>
        <div class="sal-modal-footer">
          <button class="btn btn-danger" id="sal-modal-delete" style="margin-right:auto">Eliminar</button>
          <button class="btn btn-secondary" id="sal-modal-cancel">Cancelar</button>
          <button class="btn btn-primary" id="sal-modal-save">Guardar cambios</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeEditModal(); });
    document.getElementById('sal-modal-close').addEventListener('click', closeEditModal);
    document.getElementById('sal-modal-cancel').addEventListener('click', closeEditModal);
    document.getElementById('sal-modal-save').addEventListener('click', saveEditModal);
    document.getElementById('sal-modal-delete').addEventListener('click', deleteEditModal);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('sal-edit-overlay').classList.contains('hidden')) {
        closeEditModal();
      }
    });
  }

  function openEditModal(envio) {
    editEnvio = envio;
    document.getElementById('sal-modal-title').textContent = `Editar — ${envio.numero_guia}`;
    document.getElementById('sal-modal-meta').innerHTML =
      `${courierBadge(envio.courier)}<span>${esc(envio.cliente_nombre)}</span><span style="color:var(--color-muted)">${NovaUtils.formatDate(envio.fecha)}</span>`;

    document.getElementById('saled-guia').value = envio.numero_guia ?? '';
    document.getElementById('saled-numero-salida').value = envio.numero_salida ?? '';
    document.getElementById('saled-bulto').value = envio.bulto ?? '';
    document.getElementById('saled-tipo-paquete').value = envio.tipo_paquete ?? '';
    document.getElementById('saled-direccion').value = envio.direccion || 'expo';
    document.getElementById('saled-asegurado').checked = Boolean(envio.asegurado);

    for (const f of ['flete', 'descuento', 'seguro', 'fuel', 'derechos', 'adicionales', 'otros', 'profit', 'porcentaje']) {
      document.getElementById(`saled-${f}`).value = envio[f] ?? '';
    }
    document.getElementById('saled-observaciones').value = envio.observaciones ?? '';

    document.getElementById('sal-modal-alert').innerHTML = '';
    document.getElementById('sal-edit-overlay').classList.remove('hidden');
    document.getElementById('saled-guia').focus();
    document.getElementById('saled-guia').select();
  }

  function closeEditModal() {
    document.getElementById('sal-edit-overlay').classList.add('hidden');
    editEnvio = null;
  }

  async function saveEditModal() {
    if (!editEnvio) return;
    const saveBtn = document.getElementById('sal-modal-save');
    const guia = document.getElementById('saled-guia').value.trim();

    if (!guia) {
      NovaUtils.showAlert(document.getElementById('sal-modal-alert'), 'El número de guía no puede estar vacío', 'error');
      document.getElementById('saled-guia').focus();
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Guardando…';

    const payload = {
      numero_guia:    guia,
      numero_salida:  document.getElementById('saled-numero-salida').value !== '' ? Number(document.getElementById('saled-numero-salida').value) : null,
      bulto:          document.getElementById('saled-bulto').value.trim() || null,
      tipo_paquete:   document.getElementById('saled-tipo-paquete').value || null,
      direccion:      document.getElementById('saled-direccion').value,
      asegurado:      document.getElementById('saled-asegurado').checked ? 1 : 0,
      observaciones:  document.getElementById('saled-observaciones').value.trim() || null,
    };
    for (const f of ['flete', 'descuento', 'seguro', 'fuel', 'derechos', 'adicionales', 'otros', 'profit', 'porcentaje']) {
      const v = document.getElementById(`saled-${f}`).value;
      payload[f] = v !== '' ? Number(v) : null;
    }

    try {
      await NovaAPI.salidas.actualizar(editEnvio.id, payload);
      const idx = allData.findIndex((d) => d.id === editEnvio.id);
      if (idx !== -1) Object.assign(allData[idx], payload);
      closeEditModal();
      applyAll();
      NovaUtils.showAlert(alertBox, 'Cambios guardados correctamente', 'success');
    } catch (err) {
      const modalAlert = document.getElementById('sal-modal-alert');
      NovaUtils.showAlert(modalAlert, err.message, 'error');
      document.querySelector('.sal-modal-body').scrollTop = 0;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Guardar cambios';
    }
  }

  async function deleteEditModal() {
    if (!editEnvio) return;
    const envio = editEnvio;

    // Mensaje de confirmación: deja claro que se borra el envío entero (todos sus
    // bultos) y es definitivo. Si está liquidado, avisa que se ajustará la liquidación.
    const nBultos = (envio.bultos && envio.bultos.length) ? envio.bultos.length : 1;
    let msg = `Vas a eliminar el envío de guía ${envio.numero_guia} (con sus ${nBultos} bulto${nBultos === 1 ? '' : 's'}). Esta acción es definitiva.`;
    if (envio.liquidado || envio.liquidacion_id) {
      msg += `\n\nATENCIÓN: este envío está liquidado. Al borrarlo se ajustará su liquidación.`;
    }
    msg += `\n\n¿Confirmás?`;
    if (!confirm(msg)) return;

    const deleteBtn = document.getElementById('sal-modal-delete');
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Eliminando…';

    try {
      await NovaAPI.salidas.eliminar(envio.id);
      closeEditModal();
      // Recargar desde el backend: el num_sal se recalcula allá, así que la lista
      // se renumera sin huecos al volver a pedir y re-renderizar.
      await loadData();
      NovaUtils.showAlert(alertBox, 'Envío eliminado correctamente', 'success');
    } catch (err) {
      const modalAlert = document.getElementById('sal-modal-alert');
      NovaUtils.showAlert(modalAlert, err.message, 'error');
      document.querySelector('.sal-modal-body').scrollTop = 0;
    } finally {
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Eliminar';
    }
  }

  function bindRowEdit() {
    document.getElementById('salidas-body').addEventListener('click', (e) => {
      // No abrir modal si el click fue en un botón o link interactivo de la fila,
      // ni si fue en el lápiz / editor inline de la guía del bulto.
      if (e.target.closest('.track-btn') || e.target.closest('a')) return;
      if (e.target.closest('.bulto-guia-edit') || e.target.closest('.bulto-guia-edit-box')) return;
      const tr = e.target.closest('tr[data-envio-id]');
      if (!tr) return;
      const envio = allData.find((d) => d.id === Number(tr.dataset.envioId));
      if (envio) openEditModal(envio);
    });
  }

  // ── Edición inline de la guía por bulto ──────────────────────────────────────
  function bultoGuiaEditBtnHtml(b) {
    return `<button class="bulto-guia-edit" data-bulto-id="${b.id}" title="Editar guía de este bulto">✎</button>`;
  }

  function bindBultoGuiaEdit() {
    document.getElementById('salidas-body').addEventListener('click', (e) => {
      const btn = e.target.closest('.bulto-guia-edit');
      if (!btn) return;
      e.stopPropagation();   // que NO abra el modal del envío
      openBultoGuiaEdit(btn);
    });
  }

  function openBultoGuiaEdit(btn) {
    const cell = btn.closest('td');
    const tr = btn.closest('tr[data-envio-id]');
    if (!cell || !tr) return;

    const envio = allData.find((d) => d.id === Number(tr.dataset.envioId));
    if (!envio) return;
    const bultoId = Number(btn.dataset.bultoId);
    const bulto = (envio.bultos || []).find((b) => b.id === bultoId);
    if (!bulto) return;

    const original = cell.innerHTML;            // para cancelar / restaurar
    const current = bulto.numero_guia || '';

    cell.innerHTML = `
      <span class="bulto-guia-edit-box">
        <input type="text" class="bulto-guia-input" value="${esc(current)}">
        <button class="bulto-guia-save" title="Guardar">✓</button>
        <button class="bulto-guia-cancel" title="Cancelar">×</button>
      </span>`;

    const input = cell.querySelector('.bulto-guia-input');
    const saveBtn = cell.querySelector('.bulto-guia-save');
    const cancelBtn = cell.querySelector('.bulto-guia-cancel');
    input.focus();
    input.select();

    const cancel = (ev) => {
      ev.stopPropagation();
      cell.innerHTML = original;
    };

    const save = async (ev) => {
      ev.stopPropagation();
      saveBtn.disabled = true;
      try {
        const updated = await NovaAPI.salidas.actualizarBulto(bultoId, { numero_guia: input.value });
        bulto.numero_guia = updated.numero_guia;   // refresca el dato en memoria
        // Restaurar la celda (con lápiz e iconos) y refrescar solo el texto de la guía:
        // vacío en el bulto → fallback a la guía del envío (igual que en el render).
        cell.innerHTML = original;
        cell.querySelector('.bulto-guia-text').textContent = bulto.numero_guia || envio.numero_guia || '';
      } catch (err) {
        saveBtn.disabled = false;
        NovaUtils.showAlert(alertBox, 'No se pudo guardar la guía del bulto: ' + err.message, 'error');
      }
    };

    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') save(ev);
      else if (ev.key === 'Escape') cancel(ev);
    });
  }

  init();
})();
