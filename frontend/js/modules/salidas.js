(function () {
  // ── Constantes ──────────────────────────────────────────────────────────────
  const DIAS_ALERTA_ROJO = 15;    // umbral de días para semáforo rojo
  const PAGE_SIZE = 100;          // filas por página

  // ── Estado ──────────────────────────────────────────────────────────────────
  let allData = [];          // todos los envíos cargados del servidor
  let filteredData = [];     // resultado de aplicar todos los filtros
  let groupedRows = [];      // filas agrupadas listas para renderizar
  let visibleCount = 0;      // cuántas filas ya mostramos
  let sortCol = 'fecha';
  let sortDir = 'desc';
  let searchTerm = '';
  let soloAlertas = false;
  const colFilters = {};     // { courier: Set(['UPS','DHL']), ... }
  const expandedGuias = new Set(); // guías expandidas (multi-bulto)

  // dropdown flotante
  let ddColumn = null;
  let ddTempSelected = new Set();

  // caché de resultados de tracking (por sesión)
  const trackingCache = {};

  const alertBox = document.getElementById('alert-box');

  // ── Init ────────────────────────────────────────────────────────────────────
  async function init() {
    bindSearch();
    bindSortHeaders();
    bindFilterButtons();
    bindDropdown();
    bindExport();
    bindAlertToggle();
    bindLoadMore();
    bindTracking();
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
        '<tr><td colspan="25" class="salidas-empty">Error al cargar datos</td></tr>';
    }
  }

  // ── Pipeline de filtrado / agrupado / render ─────────────────────────────────
  function applyAll() {
    filtered();
    grouped();
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

  // ── Auto 1: agrupar bultos ───────────────────────────────────────────────────
  function grouped() {
    // Agrupa por numero_guia + cliente_id. Envíos con una sola fila quedan sin grupo.
    const map = new Map();
    for (const e of filteredData) {
      const key = `${e.numero_guia}||${e.cliente_id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }

    groupedRows = [];
    for (const rows of map.values()) {
      if (rows.length === 1) {
        groupedRows.push({ type: 'single', data: rows[0] });
      } else {
        // Fila resumen
        const first = rows[0];
        const totalPeso = rows.reduce((s, r) => s + (r.peso || 0), 0);
        const totalFact = rows.reduce((s, r) => s + (r.peso_facturable || 0), 0);
        const totalMonto = rows.reduce((s, r) => s + (r.total || 0), 0);
        const expanded = expandedGuias.has(first.numero_guia + first.cliente_id);
        groupedRows.push({
          type: 'group',
          key: first.numero_guia + first.cliente_id,
          summary: { ...first, peso: totalPeso, peso_facturable: totalFact, total: totalMonto },
          bultoCount: rows.length,
          rows,
          expanded,
        });
      }
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  function renderPage() {
    const today = todayStr();
    const tbody = document.getElementById('salidas-body');
    const fragment = document.createDocumentFragment();
    const nextBatch = groupedRows.slice(visibleCount, visibleCount + PAGE_SIZE);

    if (visibleCount === 0) tbody.innerHTML = '';

    for (const grp of nextBatch) {
      if (grp.type === 'single') {
        fragment.appendChild(buildRow(grp.data, today, null, null));
      } else {
        fragment.appendChild(buildGroupRow(grp, today));
        if (grp.expanded) {
          for (const r of grp.rows) {
            fragment.appendChild(buildRow(r, today, grp.key, true));
          }
        }
      }
    }

    if (visibleCount === 0 && nextBatch.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="25" class="salidas-empty">No hay envíos que coincidan con los filtros</td>';
      tbody.appendChild(tr);
    } else {
      tbody.appendChild(fragment);
    }

    visibleCount += nextBatch.length;
    const loadMoreWrap = document.getElementById('load-more-wrap');
    loadMoreWrap.style.display = visibleCount < groupedRows.length ? '' : 'none';
  }

  function buildGroupRow(grp, today) {
    const e = grp.summary;
    const tr = document.createElement('tr');
    const expanded = grp.expanded;
    const alert = alertLevel(e, today);
    if (alert === 'rojo') tr.classList.add('row-alert-rojo');
    else if (alert === 'ambar') tr.classList.add('row-alert-ambar');

    tr.innerHTML = `
      <td>${fmtNum(e.numero_salida)}</td>
      <td>${courierBadge(e.courier)}</td>
      <td>${NovaUtils.formatDate(e.fecha)}</td>
      <td class="mono">${esc(e.numero_guia)}${e.courier === 'UPS' ? trackBtnHtml(e.numero_guia) : ''}</td>
      <td>${cobroBadge(e.tipo_cobro)}</td>
      <td><a href="clientes-perfil.html?id=${e.cliente_id}">${esc(e.cliente_nombre)}</a></td>
      <td>${esc(e.destino)}</td>
      <td>
        <button class="expand-btn" data-grp-key="${esc(grp.key)}">
          ${expanded ? '▼' : '▶'} ${grp.bultoCount} bultos
        </button>
      </td>
      <td>${tipoBadge(e.tipo_paquete)}</td>
      <td>${dirBadge(e.direccion)}</td>
      <td class="num">${fmtKg(e.peso)}</td>
      <td class="num">${fmtKg(e.peso_facturable)}</td>
      <td class="num">${fmtUSD(e.valor_declarado)}</td>
      <td class="em">—</td>
      <td class="num em">—</td>
      <td class="num em">—</td>
      <td class="num em">—</td>
      <td class="num em">—</td>
      <td class="num em">—</td>
      <td class="num em">—</td>
      <td class="num em">—</td>
      <td class="num">${fmtUSD(e.total)}</td>
      <td class="num em">—</td>
      <td class="num em">—</td>
      <td>${estadoBadge(e, today)}</td>
      <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(e.observaciones)}</td>
    `;

    tr.querySelector('.expand-btn').addEventListener('click', () => {
      if (expandedGuias.has(grp.key)) expandedGuias.delete(grp.key);
      else expandedGuias.add(grp.key);
      applyAll();
    });

    return tr;
  }

  function buildRow(e, today, grpKey, isDetail) {
    const tr = document.createElement('tr');
    if (isDetail) tr.classList.add('bulto-detail-row');

    const alert = alertLevel(e, today);
    if (!isDetail) {
      if (alert === 'rojo') tr.classList.add('row-alert-rojo');
      else if (alert === 'ambar') tr.classList.add('row-alert-ambar');
    }

    const alertIcon = alert ? alertIconHtml(alert, e) : '';

    tr.innerHTML = `
      <td>${fmtNum(e.numero_salida)}</td>
      <td>${courierBadge(e.courier)}</td>
      <td>${NovaUtils.formatDate(e.fecha)}</td>
      <td class="mono">${esc(e.numero_guia)}${alertIcon}${e.courier === 'UPS' ? trackBtnHtml(e.numero_guia) : ''}</td>
      <td>${cobroBadge(e.tipo_cobro)}</td>
      <td><a href="clientes-perfil.html?id=${e.cliente_id}">${esc(e.cliente_nombre)}</a></td>
      <td>${esc(e.destino)}</td>
      <td>${dash(e.bulto)}</td>
      <td>${tipoBadge(e.tipo_paquete)}</td>
      <td>${dirBadge(e.direccion)}</td>
      <td class="num">${fmtKg(e.peso)}</td>
      <td class="num">${fmtKg(e.peso_facturable)}</td>
      <td class="num">${fmtUSD(e.valor_declarado)}</td>
      <td>${e.asegurado ? 'Sí' : 'No'}</td>
      <td class="num">${fmtUSD(e.flete)}</td>
      <td class="num">${fmtUSD(e.descuento)}</td>
      <td class="num">${fmtUSD(e.seguro)}</td>
      <td class="num">${fmtUSD(e.fuel)}</td>
      <td class="num">${fmtUSD(e.derechos)}</td>
      <td class="num">${fmtUSD(e.adicionales)}</td>
      <td class="num">${fmtUSD(e.otros)}</td>
      <td class="num">${fmtUSD(e.total)}</td>
      <td class="num">${profitCell(e)}</td>
      <td class="num">${pctCell(e)}</td>
      <td>${estadoBadge(e, today)}</td>
      <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis" title="${esc(e.observaciones)}">${esc(e.observaciones)}</td>
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
    // Desagrupar: si hay grupos, expandimos todos para exportar fila por fila
    const rows = [];
    for (const grp of groupedRows) {
      if (grp.type === 'single') {
        rows.push(grp.data);
      } else {
        rows.push(...grp.rows);
      }
    }

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

  init();
})();
