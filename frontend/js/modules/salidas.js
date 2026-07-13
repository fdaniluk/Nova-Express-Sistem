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
  let selectedMonth = null;  // mes activo de las solapas ("YYYY-MM"); null = sin datos
  const colFilters = {};     // { courier: Set(['UPS','DHL']), ... }

  // dropdown flotante
  let ddColumn = null;
  let ddTempSelected = new Set();

  // caché de resultados de tracking (por sesión)
  const trackingCache = {};

  // estado del modal de edición
  let editEnvio = null;
  let editBultos = [];      // bultos del envío en edición (multi-bulto)
  let editMulti = false;    // true si el envío tiene más de un bulto
  let editExtras = [];      // desglose de adicionales [{ tipo, label, monto }]
  let editExtrasDirty = false; // true solo si el desglose viene de un Recalcular de esta sesión

  // ── Navegación por celdas (estilo Excel) ────────────────────────────────────
  // activeCell es una COORDENADA LÓGICA, no un nodo: { rowIndex, colIndex } | null.
  // El re-render destruye los td, por eso se guardan índices y se vuelve a resolver el td.
  // La columna 0 es el checkbox de selección: NO se navega con flechas (índices 1..31).
  const GRID_MIN_COL = 1;    // columna 0 = checkbox "copiar guías", no navegable
  const GRID_MAX_COL = 31;   // 32 columnas fijas → índices 0..31; navegables 1..31
  let activeCell = null;

  // ── Columnas fijas (sticky a la izquierda) ──────────────────────────────────
  // Bloque de identificación anclable, en orden visual de izquierda a derecha. La
  // columna 0 (checkbox) queda SIEMPRE fija por CSS estático; estas 7 son opcionales.
  // El sticky se emite como CSS por [data-col] en un <style>, así sobrevive al
  // re-render destructivo del tbody sin volver a tocar ningún <td>.
  const STICKY_ANCHOR_COLS = ['numero_salida', 'courier', 'fecha', 'numero_guia', 'tipo_cobro', 'cliente_nombre', 'destino'];
  const STICKY_LABELS = {
    numero_salida: '#Sal', courier: 'Courier', fecha: 'Fecha', numero_guia: 'Guía',
    tipo_cobro: 'Cobro', cliente_nombre: 'Cliente', destino: 'Destino',
  };
  const STICKY_LS_KEY = 'nova.salidas.stickyCols';
  const STICKY_DEFAULT = ['numero_salida', 'cliente_nombre'];
  let stickyPins = new Set();   // data-col actualmente fijados

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
    bindGridNav();
    bindCopiarGuias();
    bindSelectAllGuias();
    loadStickyPins();
    bindStickyCols();
    bindFloatingScrollbar();
    await loadData();
  }

  // ── Carga de datos ──────────────────────────────────────────────────────────
  async function loadData() {
    try {
      allData = await NovaAPI.salidas.listar();
      recomputeNumSalMes();
      ensureSelectedMonth();
      applyAll();
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar salidas: ' + err.message, 'error');
      document.getElementById('salidas-body').innerHTML =
        '<tr><td colspan="32" class="salidas-empty">Error al cargar datos</td></tr>';
    }
  }

  // ── #Sal renumerado por mes (frontend) ──────────────────────────────────────
  // El backend manda un num_sal global; en pantalla lo ignoramos y mostramos un correlativo
  // 1..N por mes. Cada envío recibe e.num_sal_mes según su mes (e.fecha "YYYY-MM"), ordenado
  // por fecha ASC y desempatado por id ASC. Recalcular tras cualquier cambio en allData.
  function recomputeNumSalMes() {
    const byMonth = {};
    for (const e of allData) {
      const mes = monthOf(e);
      (byMonth[mes] || (byMonth[mes] = [])).push(e);
    }
    for (const mes of Object.keys(byMonth)) {
      byMonth[mes]
        .sort((a, b) => {
          if (a.fecha < b.fecha) return -1;
          if (a.fecha > b.fecha) return 1;
          return (a.id || 0) - (b.id || 0);
        })
        .forEach((e, i) => { e.num_sal_mes = i + 1; });
    }
  }

  // ── Solapas de meses (estilo Excel) ─────────────────────────────────────────
  const MESES_ABBR = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  function monthOf(e) {
    return (e.fecha || '').slice(0, 7);
  }

  // Meses únicos presentes en allData, ordenados DESC (más reciente primero).
  function getMonths() {
    const set = new Set();
    for (const e of allData) {
      const mes = monthOf(e);
      if (mes) set.add(mes);
    }
    return [...set].sort().reverse();
  }

  function monthLabel(mes) {
    const [y, m] = mes.split('-');
    return `${MESES_ABBR[Number(m) - 1] || m} ${y}`;
  }

  // Elige el mes activo: el mes actual si tiene envíos, si no el más reciente con datos.
  // Preserva el mes ya seleccionado mientras siga teniendo envíos (no saltar tras editar/borrar).
  function ensureSelectedMonth() {
    const months = getMonths();
    if (!months.length) { selectedMonth = null; return; }
    if (selectedMonth && months.includes(selectedMonth)) return;
    const current = new Date().toISOString().slice(0, 7);
    selectedMonth = months.includes(current) ? current : months[0];
  }

  function renderMonthTabs() {
    const container = document.getElementById('month-tabs');
    if (!container) return;
    container.innerHTML = '';
    for (const mes of getMonths()) {
      const count = allData.reduce((acc, e) => acc + (monthOf(e) === mes ? 1 : 0), 0);
      const tab = document.createElement('button');
      tab.className = 'month-tab' + (mes === selectedMonth ? ' active' : '');
      tab.dataset.month = mes;
      tab.innerHTML = `${esc(monthLabel(mes))} <span class="month-tab-count">(${count})</span>`;
      tab.addEventListener('click', () => {
        if (selectedMonth === mes) return;
        selectedMonth = mes;
        visibleCount = 0;
        applyAll();
      });
      container.appendChild(tab);
    }
  }

  // ── Pipeline de filtrado / agrupado / render ─────────────────────────────────
  function applyAll() {
    filtered();
    visibleCount = 0;
    // El tbody se reconstruye (los .chk-guia desaparecen): solo resetear el "seleccionar
    // todo" del header para que no quede marcado al cambiar de mes/filtro/búsqueda.
    const chkAll = document.getElementById('chk-all-guias');
    if (chkAll) chkAll.checked = false;
    renderPage();
    updateCounter();
    renderChips();
    renderMonthTabs();
  }

  function filtered() {
    const today = todayStr();
    filteredData = allData.filter((e) => {
      // Solapa de mes activa: solo envíos de ese mes
      if (selectedMonth && monthOf(e) !== selectedMonth) return false;

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
      tr.innerHTML = '<td colspan="32" class="salidas-empty">No hay envíos que coincidan con los filtros</td>';
      tbody.appendChild(tr);
    } else {
      tbody.appendChild(fragment);
    }

    visibleCount += nextBatch.length;
    const loadMoreWrap = document.getElementById('load-more-wrap');
    loadMoreWrap.style.display = visibleCount < filteredData.length ? '' : 'none';

    // El tbody se reconstruyó: re-resolver la celda activa por coordenadas y reaplicar
    // el resaltado (o limpiarlo si la coordenada ya no existe).
    reconcileActiveCell();

    // Re-medir offsets sticky: con table-layout auto los anchos de columna dependen del
    // contenido, que cambia al paginar / filtrar / cambiar de mes. NO toca ningún <td>,
    // solo reescribe el <style id="sticky-cols-style">.
    applyStickyCols();

    // El scrollWidth de la tabla cambió: recalcular el fantasma de la barra flotante.
    refreshFloatingScrollbar();
  }

  // Guía que usa el checkbox de "Copiar guías" para ESTE renglón. En el primer
  // renglón del envío cae al fallback de la guía del envío; en las sub-filas usa
  // solo la guía del bulto. (Misma lógica que tenía inline buildRow.)
  function computeRowGuia(e, b, isFirst) {
    return isFirst
      ? (b.numero_guia || e.numero_guia || '').trim()
      : (b.numero_guia || '').trim();
  }
  // HTML de la celda del checkbox de selección: input si hay guía, vacío si no.
  function chkCellHtml(rowGuia) {
    return rowGuia
      ? `<input type="checkbox" class="chk-guia" value="${escAttr(rowGuia)}">`
      : '';
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
    const pesoVol = b.peso_volumetrico != null ? b.peso_volumetrico : e.peso_volumetrico;
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

    // Checkbox de selección para "Copiar guías": solo en el primer renglón del envío y
    // solo si tiene guía. El value es la guía del ENVÍO (e.numero_guia), nunca la del bulto,
    // para no duplicar guías en envíos multi-bulto. Sub-filas y envíos sin guía: celda vacía.
    const rowGuia = computeRowGuia(e, b, isFirst);
    const chkCell = chkCellHtml(rowGuia);

    tr.innerHTML = `
      <td class="chk-cell">${chkCell}</td>
      <td data-col="numero_salida">${fmtNum(e.num_sal_mes)}</td>
      <td data-col="courier">${env(courierBadge(e.courier))}</td>
      <td data-col="fecha">${env(NovaUtils.formatDate(e.fecha))}</td>
      <td class="mono" data-col="numero_guia"><span class="bulto-guia-text">${esc(bultoGuia)}</span>${bultoGuiaEdit}${guiaIcons}</td>
      <td data-col="tipo_cobro">${env(cobroBadge(e.tipo_cobro))}</td>
      <td data-col="cliente_nombre">${env(`<a href="clientes-perfil.html?id=${e.cliente_id}">${esc(e.cliente_nombre)}</a>`)}</td>
      <td data-col="destino">${env(esc(e.destino))}</td>
      <td>${estadoCajaDotHtml(b.estado_caja)}${numBulto}/${totalBultos}</td>
      <td>${env(tipoBadge(e.tipo_paquete))}</td>
      <td>${env(dirBadge(e.direccion))}</td>
      <td class="num">${fmtDim(largo)}</td>
      <td class="num">${fmtDim(ancho)}</td>
      <td class="num">${fmtDim(alto)}</td>
      <td class="num">${fmtKg(pesoReal)}</td>
      <td class="num">${fmtKg(pesoVol)}</td>
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
      <td class="obs-cell" title="${isFirst ? escAttr(e.observaciones) : ''}">${obsCell(e.observaciones, isFirst)}</td>
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
    if (col === 'numero_salida') return e.num_sal_mes;  // #Sal ordena por el correlativo del mes
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

  // ── Copiar guías seleccionadas ───────────────────────────────────────────────
  // Recolecta las guías de las filas tildadas y las copia al portapapeles separadas por
  // ESPACIO, listas para pegar en el buscador de tracking de UPS. Sin filtrar por courier:
  // copia todo lo seleccionado. Una guía por envío (el value del checkbox es e.numero_guia).
  function bindCopiarGuias() {
    const btn = document.getElementById('btn-copiar-guias');
    if (!btn) return;
    btn.addEventListener('click', copiarGuias);
  }

  async function copiarGuias() {
    const guias = [...new Set(
      [...document.querySelectorAll('.chk-guia:checked')]
        .map((c) => c.value)
        .filter((v) => v && v.trim())
        .map((v) => v.trim())
    )];

    if (!guias.length) {
      NovaUtils.showAlert(alertBox, 'No hay guias seleccionadas', 'error');
      return;
    }

    const texto = guias.join(' ');
    const n = guias.length;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(texto);
      } else {
        copiarFallback(texto);
      }
      NovaUtils.showAlert(alertBox, n + ' guias copiadas', 'success');
    } catch (err) {
      // navigator.clipboard puede fallar (permisos, contexto no seguro): reintentar con el
      // método viejo de textarea + execCommand antes de darse por vencido.
      try {
        copiarFallback(texto);
        NovaUtils.showAlert(alertBox, n + ' guias copiadas', 'success');
      } catch (err2) {
        NovaUtils.showAlert(alertBox, 'No se pudo copiar al portapapeles', 'error');
      }
    }
  }

  // Fallback de copia: textarea temporal fuera de pantalla + document.execCommand('copy').
  function copiarFallback(texto) {
    const ta = document.createElement('textarea');
    ta.value = texto;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (!ok) throw new Error('execCommand copy devolvió false');
  }

  // "Seleccionar todo" del header: marca/desmarca todos los .chk-guia visibles del tbody.
  function bindSelectAllGuias() {
    const chkAll = document.getElementById('chk-all-guias');
    if (!chkAll) return;
    chkAll.addEventListener('change', () => {
      const checked = chkAll.checked;
      document.querySelectorAll('#salidas-body .chk-guia').forEach((c) => { c.checked = checked; });
    });
  }

  // ── Columnas fijas (sticky) ──────────────────────────────────────────────────
  // Persistencia en localStorage: array de data-col fijados, en orden canónico. Primera
  // vez sin nada guardado → STICKY_DEFAULT. Se ignoran valores que no sean anclables.
  function loadStickyPins() {
    let arr = null;
    try {
      const raw = localStorage.getItem(STICKY_LS_KEY);
      if (raw) arr = JSON.parse(raw);
    } catch (_) { arr = null; }
    if (!Array.isArray(arr)) arr = STICKY_DEFAULT.slice();
    stickyPins = new Set(arr.filter((c) => STICKY_ANCHOR_COLS.includes(c)));
  }

  function saveStickyPins() {
    const arr = STICKY_ANCHOR_COLS.filter((c) => stickyPins.has(c));   // orden izquierda→derecha
    try { localStorage.setItem(STICKY_LS_KEY, JSON.stringify(arr)); } catch (_) {}
  }

  // Ancho REAL renderizado de una columna (border-box). Con table-layout auto el width
  // inline del th es solo una preferencia; medir el th da el offset exacto para apilar.
  function stickyColWidth(sel) {
    const el = document.querySelector(sel);
    return el ? el.getBoundingClientRect().width : 0;
  }

  // Reescribe el <style id="sticky-cols-style"> con las reglas de las columnas fijadas.
  // El offset de cada columna = ancho del checkbox + suma de anchos de las columnas
  // fijadas a su izquierda (solo las fijadas: las del medio no fijadas pasan por debajo).
  // Targetea th[data-col]/td[data-col], así que sobrevive al re-render del tbody.
  function applyStickyCols() {
    let styleEl = document.getElementById('sticky-cols-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'sticky-cols-style';
      document.head.appendChild(styleEl);
    }

    const pinned = STICKY_ANCHOR_COLS.filter((c) => stickyPins.has(c));
    let css = '';
    let offset = stickyColWidth('.salidas-table th.chk-cell');   // el bloque arranca tras el checkbox

    for (const col of pinned) {
      const sel = `[data-col="${col}"]`;
      // th + td se congelan a la izquierda. z-index:1 por encima de las celdas normales.
      css += `.salidas-table th${sel},.salidas-table td${sel}{position:sticky;left:${offset}px;z-index:1;}\n`;
      // Esquina (th fijado + thead sticky top, z-index:2): tiene que ir por encima del thead.
      css += `.salidas-table thead th${sel}{z-index:3;}\n`;
      offset += stickyColWidth(`.salidas-table th${sel}`);
    }

    if (pinned.length) {
      // Fondo OPACO que matchea la fila en cada estado (los th ya son opacos por CSS base):
      // normal → #fff, sub-fila de bulto → #f8fafc, hover → #eef2ff. La celda activa gana
      // por su propia regla !important (#e0e7ff), así que no se toca acá.
      const base = pinned.map((c) => `.salidas-table td[data-col="${c}"]`).join(',');
      const detail = pinned.map((c) => `.salidas-table tr.bulto-detail-row td[data-col="${c}"]`).join(',');
      const hover = pinned.map((c) => `.salidas-table tbody tr[data-envio-id]:hover td[data-col="${c}"]`).join(',');
      css += `${base}{background:#fff;}\n`;
      css += `${detail}{background:#f8fafc;}\n`;
      css += `${hover}{background:#eef2ff;}\n`;
    }

    styleEl.textContent = css;
  }

  // Botón "Columnas fijas" + panelito flotante con los 7 checkboxes. Al tildar/destildar
  // recalcula el sticky y persiste. El panel vive FUERA de la tabla (en el body).
  function bindStickyCols() {
    const btn = document.getElementById('btn-sticky-cols');
    if (!btn) return;

    const panel = document.createElement('div');
    panel.id = 'sticky-cols-panel';
    panel.className = 'sticky-cols-panel';
    panel.style.display = 'none';
    panel.innerHTML = `
      <div class="sticky-cols-title">Fijar columnas</div>
      ${STICKY_ANCHOR_COLS.map((c) => `
        <label><input type="checkbox" value="${c}" ${stickyPins.has(c) ? 'checked' : ''}> ${esc(STICKY_LABELS[c])}</label>
      `).join('')}`;
    document.body.appendChild(panel);

    panel.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) stickyPins.add(cb.value);
        else stickyPins.delete(cb.value);
        saveStickyPins();
        applyStickyCols();
        // Fijar/soltar columnas altera anchos → recalcular la barra flotante.
        refreshFloatingScrollbar();
      });
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
      const rect = btn.getBoundingClientRect();
      panel.style.top = `${rect.bottom + window.scrollY + 4}px`;
      panel.style.left = `${rect.left + window.scrollX}px`;
      panel.style.display = 'block';
    });

    document.addEventListener('click', (e) => {
      if (!panel.contains(e.target) && e.target.id !== 'btn-sticky-cols') {
        panel.style.display = 'none';
      }
    });

    // Los anchos de columna cambian al redimensionar (table-layout auto + width:100%).
    window.addEventListener('resize', applyStickyCols);
  }

  // ── Barra de scroll horizontal flotante ──────────────────────────────────────
  // Una scrollbar horizontal fija al fondo del viewport que refleja y controla el scroll
  // de #table-wrap, para poder desplazarse horizontal desde cualquier fila sin bajar a
  // buscar la barra nativa. Vive en el body (fuera de la tabla). Un div "fantasma" adentro
  // con width = wrap.scrollWidth le da a su scrollbar exactamente el mismo recorrido.
  //
  // Sincronización por COMPARACIÓN de valores (sin flag): cada lado solo escribe en el otro
  // si difieren. Así los cambios programáticos de scrollActiveCellIntoView (que setea
  // wrap.scrollLeft) se reflejan en la barra sin re-disparar un loop, porque tras el primer
  // seteo ambos scrollLeft ya coinciden y el segundo handler es no-op.
  let floatBar = null;
  let floatGhost = null;
  let floatRaf = 0;

  function bindFloatingScrollbar() {
    const wrap = document.getElementById('table-wrap');
    if (!wrap) return;

    floatBar = document.createElement('div');
    floatBar.className = 'floating-hscroll';
    floatGhost = document.createElement('div');
    floatGhost.className = 'floating-hscroll-ghost';
    floatBar.appendChild(floatGhost);
    document.body.appendChild(floatBar);

    // Sync bidireccional. Redondeo para tolerar diferencias sub-píxel que rebotarían.
    floatBar.addEventListener('scroll', () => {
      if (Math.round(wrap.scrollLeft) !== Math.round(floatBar.scrollLeft)) {
        wrap.scrollLeft = floatBar.scrollLeft;
      }
    }, { passive: true });

    wrap.addEventListener('scroll', () => {
      if (!floatBar) return;
      if (Math.round(floatBar.scrollLeft) !== Math.round(wrap.scrollLeft)) {
        floatBar.scrollLeft = wrap.scrollLeft;
      }
    }, { passive: true });

    // Visibilidad: IntersectionObserver para el gate grueso (wrap dentro/fuera del viewport)
    // + un scroll listener rAF-throttled solo para el ajuste fino (ocultar cuando la barra
    // nativa del wrap ya asoma al fondo del viewport).
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(() => updateFloatingVisibility());
      io.observe(wrap);
    }
    window.addEventListener('scroll', onFloatingScroll, { passive: true });
    window.addEventListener('resize', refreshFloatingScrollbar);

    refreshFloatingScrollbar();
  }

  function onFloatingScroll() {
    if (floatRaf) return;
    floatRaf = requestAnimationFrame(() => {
      floatRaf = 0;
      updateFloatingVisibility();
    });
  }

  // Recalcula la geometría: ancho del fantasma = recorrido real del wrap; posición y ancho
  // de la barra = área visible del wrap. Llamar cuando cambie scrollWidth de la tabla
  // (renderPage, cambio de columnas sticky, resize de ventana).
  function refreshFloatingScrollbar() {
    if (!floatBar) return;
    const wrap = document.getElementById('table-wrap');
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    floatBar.style.left = `${Math.max(0, rect.left)}px`;
    floatBar.style.width = `${wrap.clientWidth}px`;
    floatGhost.style.width = `${wrap.scrollWidth}px`;
    updateFloatingVisibility();
  }

  // Muestra la barra SOLO si (a) la tabla desborda horizontal, (b) el wrap está en el
  // viewport y (c) su barra nativa aún no asoma (el fondo del wrap queda por debajo del
  // viewport) — así no se duplica ni tapa contenido de más abajo.
  function updateFloatingVisibility() {
    if (!floatBar) return;
    const wrap = document.getElementById('table-wrap');
    if (!wrap) return;
    const overflow = wrap.scrollWidth - wrap.clientWidth > 1;
    const rect = wrap.getBoundingClientRect();
    const viewH = window.innerHeight || document.documentElement.clientHeight;
    const inView = rect.top < viewH && rect.bottom > 0;
    const nativeBarHidden = rect.bottom > viewH;
    const show = overflow && inView && nativeBarHidden;
    floatBar.classList.toggle('visible', show);
    // Al hacerse visible, alinear el thumb con el scroll actual del wrap: mientras estuvo
    // en display:none pudo no haber registrado los cambios de scrollLeft.
    if (show && Math.round(floatBar.scrollLeft) !== Math.round(wrap.scrollLeft)) {
      floatBar.scrollLeft = wrap.scrollLeft;
    }
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
    const timeline = (d.movimientos && d.movimientos.length)
      ? `
      <div class="tracking-row"><span class="tracking-label">Historial</span></div>
      <div class="tracking-timeline">
        ${d.movimientos.map((m) => `
          <div class="tracking-event">
            <span class="tracking-event-when">${m.fecha ? NovaUtils.formatDate(m.fecha) : ''}${m.hora ? ` ${esc(m.hora)}` : ''}</span>
            <span class="tracking-event-what">${esc(m.estado || '')}${m.ubicacion ? `<br><span class="tracking-event-loc">${esc(m.ubicacion)}</span>` : ''}</span>
          </div>
        `).join('')}
      </div>`
      : '';

    popup.innerHTML = `
      <div class="tracking-header"><span class="badge badge-ups">UPS</span> ${esc(d.guia)}</div>
      <div class="tracking-row"><span class="tracking-label">Estado</span><span>${esc(d.estado)}</span></div>
      ${d.ubicacion ? `<div class="tracking-row"><span class="tracking-label">Ubicación</span><span>${esc(d.ubicacion)}</span></div>` : ''}
      ${d.fecha ? `<div class="tracking-row"><span class="tracking-label">Fecha</span><span>${NovaUtils.formatDate(d.fecha)}</span></div>` : ''}
      ${d.fechaEstimada ? `<div class="tracking-row"><span class="tracking-label">Entrega estimada</span><span>${NovaUtils.formatDate(d.fechaEstimada)}</span></div>` : ''}
      ${d.fechaEntrega ? `<div class="tracking-row"><span class="tracking-label">Entregado el</span><span>${NovaUtils.formatDate(d.fechaEntrega)}</span></div>` : ''}
      ${d.detalleEntrega ? `<div class="tracking-row"><span class="tracking-label">Entregado a</span><span>${esc(d.detalleEntrega)}</span></div>` : ''}
      ${d.servicio ? `<div class="tracking-row"><span class="tracking-label">Servicio</span><span>${esc(d.servicio)}</span></div>` : ''}
      ${d.peso ? `<div class="tracking-row"><span class="tracking-label">Peso UPS</span><span>${esc(d.peso)}</span></div>` : ''}
      ${timeline}
    `;
  }

  // ── Helpers de formato ───────────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Escape para usar texto libre dentro de un atributo entre comillas dobles (ej. title).
  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;');
  }

  // Preview de observaciones en la fila: solo en el primer renglón del envío.
  // Texto corto → tal cual; largo → truncado por CSS (.obs-preview) con "…".
  // El texto completo va en el title de la celda (ver el <td class="obs-cell">).
  function obsCell(v, isFirst) {
    if (!isFirst) return '';
    if (v == null || v === '') return '<span class="em">—</span>';
    return `<span class="obs-preview">${esc(v)}</span>`;
  }

  function dash(v) {
    return v == null || v === '' ? '<span class="em">—</span>' : esc(v);
  }

  function fmtUSD(v) {
    if (v == null || v === '') return '<span class="em">—</span>';
    return `$${Number(v).toFixed(2)}`;
  }

  // Lee un valor numérico tolerando la coma decimal con la que se muestran los importes
  // (es-AR: "99,73"). Number('99,73') daría NaN y rompería comparaciones/sumas; aquí la
  // coma se normaliza a punto. Vacío o no numérico → 0. Único criterio de parseo numérico
  // del modal: lo usan recalcProfit, extrasSum y updateExtrasWarn.
  function parseNum(value) {
    if (value == null || value === '') return 0;
    const n = Number(String(value).replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
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

  // ── Semáforo de estado de caja por bulto ─────────────────────────────────────
  // El backend guarda estado_caja por bulto: 'rojo' | 'amarillo' | 'verde' | null.
  // null = sin estado: se PINTA rojo, pero no se fuerza a guardar 'rojo'.
  const ESTADO_CAJA_INFO = {
    rojo:     { cls: 'estado-rojo',     label: 'No escaneada', btn: 'Rojo' },
    amarillo: { cls: 'estado-amarillo', label: 'En tránsito',  btn: 'Amarillo' },
    verde:    { cls: 'estado-verde',    label: 'Entregada',    btn: 'Verde' },
  };

  // Punto de color para la celda de bulto. Cualquier valor no reconocido (incl. null) → rojo.
  function estadoCajaDotHtml(estado) {
    const info = ESTADO_CAJA_INFO[estado] || ESTADO_CAJA_INFO.rojo;
    return `<span class="bulto-estado-dot ${info.cls}" title="${info.label}"></span>`;
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
            <div class="sal-section-title">Estado de la caja</div>
            <div id="saled-estado-caja" class="saled-estado-caja"></div>
          </div>
          <div>
            <div class="sal-section-title">Peso y medidas</div>
            <div class="sal-form-grid">
              <div class="form-group"><label>Peso balanza (kg)</label><input type="number" id="saled-peso-real" step="0.001" min="0"></div>
              <div class="form-group"><label>Largo (cm)</label><input type="number" id="saled-largo" step="0.1" min="0"></div>
              <div class="form-group"><label>Ancho (cm)</label><input type="number" id="saled-ancho" step="0.1" min="0"></div>
              <div class="form-group"><label>Alto (cm)</label><input type="number" id="saled-alto" step="0.1" min="0"></div>
              <div class="form-group"><label>Peso facturable (kg)</label><input type="number" id="saled-peso-facturable" readonly class="campo-bloqueado"></div>
              <div class="form-group"><label>Peso volumétrico (kg)</label><input type="number" id="saled-peso-volumetrico" readonly class="campo-bloqueado"></div>
            </div>
            <div id="saled-bultos-section" class="hidden">
              <div class="saled-bultos-label">Dimensiones por bulto</div>
              <div id="saled-bultos-container"></div>
            </div>
            <div class="saled-recalc-bar">
              <button type="button" class="btn btn-secondary" id="saled-recalcular">Recalcular</button>
              <span id="saled-recalc-status" class="saled-recalc-status"></span>
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
              <div class="form-group"><label>Total cobrado</label><input type="number" id="saled-total" step="0.01"></div>
              <div class="form-group"><label>Profit</label><input type="number" id="saled-profit" step="0.01"></div>
              <div class="form-group"><label>% Profit</label><input type="number" id="saled-porcentaje" step="0.1"></div>
            </div>
            <div id="saled-extras-block" class="saled-extras"></div>
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
    document.getElementById('saled-recalcular').addEventListener('click', recalcularDesglose);
    document.getElementById('saled-estado-caja').addEventListener('click', onEstadoCajaClick);

    // Profit/% se re-derivan en vivo: total cobrado fijo − suma de costos. Aplica tanto
    // al editar un costo a mano como tras Recalcular (que también repuebla estos campos).
    for (const f of ['flete', 'descuento', 'seguro', 'fuel', 'derechos', 'adicionales', 'otros', 'total']) {
      document.getElementById(`saled-${f}`).addEventListener('input', recalcProfit);
    }

    // El cartelito de desfase se re-evalúa en vivo cada vez que se edita Adicionales a mano.
    document.getElementById('saled-adicionales').addEventListener('input', updateExtrasWarn);

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
    document.getElementById('saled-total').value = envio.total ?? '';
    document.getElementById('saled-observaciones').value = envio.observaciones ?? '';

    // Desglose de adicionales: precargar desde el envío. Al abrir no está "dirty" (solo
    // un Recalcular de esta sesión lo marca como tal). Render tras poblar Adicionales para
    // que el chequeo del cartelito lea el total actual.
    editExtras = Array.isArray(envio.extras) ? envio.extras.map((x) => ({ ...x })) : [];
    editExtrasDirty = false;
    renderExtrasBlock();

    // Peso y medidas. Multi-bulto = más de un bulto: las medidas salen de cada bulto y el
    // peso balanza es la suma (no editable arriba). Bulto único = campos sueltos editables.
    editBultos = (envio.bultos || []).map((b) => ({ ...b }));
    editMulti = editBultos.length > 1;

    document.getElementById('saled-peso-real').value = envio.peso ?? '';
    document.getElementById('saled-largo').value = envio.largo ?? '';
    document.getElementById('saled-ancho').value = envio.ancho ?? '';
    document.getElementById('saled-alto').value = envio.alto ?? '';
    document.getElementById('saled-peso-facturable').value = envio.peso_facturable ?? '';
    document.getElementById('saled-peso-volumetrico').value = envio.peso_volumetrico ?? '';
    renderEditBultos();
    renderEstadoCajaSection();
    document.getElementById('saled-recalc-status').textContent = '';

    document.getElementById('sal-modal-alert').innerHTML = '';
    document.getElementById('sal-edit-overlay').classList.remove('hidden');
    document.getElementById('saled-guia').focus();
    document.getElementById('saled-guia').select();
  }

  // Atenúa/libera un campo del modal (readonly + estilo gris). Mismo criterio que
  // "Cargar envío": en multi-bulto el peso balanza y las medidas de arriba no se editan.
  function setCampoBloqueado(el, bloqueado) {
    if (!el) return;
    el.readOnly = bloqueado;
    el.classList.toggle('campo-bloqueado', bloqueado);
  }

  // Renderiza las filas por bulto (multi-bulto) o las oculta (bulto único). Sigue el
  // mismo patrón visual que "Dimensiones por bulto" de Cargar envío.
  function renderEditBultos() {
    const section = document.getElementById('saled-bultos-section');
    const container = document.getElementById('saled-bultos-container');
    ['saled-peso-real', 'saled-largo', 'saled-ancho', 'saled-alto']
      .forEach((id) => setCampoBloqueado(document.getElementById(id), editMulti));

    if (!editMulti) {
      section.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    section.classList.remove('hidden');
    container.innerHTML = '';
    editBultos.forEach((b, i) => {
      const row = document.createElement('div');
      row.className = 'saled-bulto-row';
      row.innerHTML = `
        <span>Bulto ${b.numero_bulto != null ? b.numero_bulto : i + 1}</span>
        <input type="number" data-bidx="${i}" data-field="largo" placeholder="Largo" step="0.1" min="0" value="${b.largo ?? ''}">
        <input type="number" data-bidx="${i}" data-field="ancho" placeholder="Ancho" step="0.1" min="0" value="${b.ancho ?? ''}">
        <input type="number" data-bidx="${i}" data-field="alto" placeholder="Alto" step="0.1" min="0" value="${b.alto ?? ''}">
        <input type="number" data-bidx="${i}" data-field="peso_real" placeholder="Peso (kg)" step="0.001" min="0" value="${b.peso_real ?? ''}">
      `;
      container.appendChild(row);
    });
    // El peso balanza de arriba = suma de los pesos de bulto, recalculada en vivo.
    container.querySelectorAll('[data-field="peso_real"]').forEach((inp) => {
      inp.addEventListener('input', recalcEditPesoBalanza);
    });
    recalcEditPesoBalanza();
  }

  // Suma de los pesos de bulto → peso balanza (solo lectura) en multi-bulto.
  function recalcEditPesoBalanza() {
    if (!editMulti) return;
    let suma = 0;
    document
      .querySelectorAll('#saled-bultos-container [data-field="peso_real"]')
      .forEach((inp) => { suma += parseFloat(inp.value) || 0; });
    document.getElementById('saled-peso-real').value = Math.round(suma * 1000) / 1000;
  }

  // Lee las filas por bulto del modal como [{ id, numero_bulto, peso_real, largo, ancho, alto }].
  function readBultosFromModal() {
    return editBultos.map((b, i) => {
      const val = (field) => {
        const inp = document.querySelector(`#saled-bultos-container [data-bidx="${i}"][data-field="${field}"]`);
        const v = inp ? inp.value : '';
        return v !== '' ? Number(v) : null;
      };
      return {
        id: b.id,
        numero_bulto: b.numero_bulto,
        peso_real: val('peso_real'),
        largo: val('largo'),
        ancho: val('ancho'),
        alto: val('alto'),
      };
    });
  }

  // Render de la sección "Estado de la caja" del modal. Un solo grupo de 3 botones si el
  // envío tiene UN bulto; una fila por bulto si tiene varios. El botón del estado actual
  // queda resaltado (null se considera rojo, igual que el punto de la tabla).
  function renderEstadoCajaSection() {
    const container = document.getElementById('saled-estado-caja');
    if (!container) return;
    const multi = editBultos.length > 1;
    container.innerHTML = '';
    editBultos.forEach((b, i) => {
      const row = document.createElement('div');
      row.className = 'saled-estado-row';
      const labelHtml = multi
        ? `<span class="saled-estado-label">Bulto ${b.numero_bulto != null ? b.numero_bulto : i + 1}</span>`
        : '';
      const actual = b.estado_caja || 'rojo';   // null/undefined → rojo
      const btns = ['rojo', 'amarillo', 'verde'].map((est) => {
        const info = ESTADO_CAJA_INFO[est];
        const active = actual === est ? ' active' : '';
        return `<button type="button" class="saled-estado-btn${active}" data-estado="${est}" title="${info.label}">
          <span class="bulto-estado-dot ${info.cls}"></span>${info.btn}
        </button>`;
      }).join('');
      row.innerHTML = `${labelHtml}<div class="saled-estado-btns" data-bidx="${i}">${btns}</div>`;
      container.appendChild(row);
    });
  }

  // Click en un botón de estado: persiste enseguida (no requiere Guardar). Caso A si el
  // bulto tiene id real; Caso B (materializa la fila) si el bulto es único sintético (id
  // null), y con el id devuelto los próximos cambios ya van por Caso A.
  async function onEstadoCajaClick(e) {
    const btn = e.target.closest('.saled-estado-btn');
    if (!btn || !editEnvio) return;
    const group = btn.closest('.saled-estado-btns');
    const i = Number(group.dataset.bidx);
    const estado = btn.dataset.estado;
    const bulto = editBultos[i];
    if (!bulto) return;

    group.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    try {
      const updated = (bulto.id != null)
        ? await NovaAPI.salidas.actualizarBulto(bulto.id, { estado_caja: estado })
        : await NovaAPI.salidas.actualizarEstadoBultoUnico(editEnvio.id, { estado_caja: estado });
      // Bulto recién materializado: ahora tiene id real → los próximos toques usan Caso A.
      bulto.id = updated.id;
      bulto.estado_caja = updated.estado_caja;
      syncEnvioBulto(i, updated);
      renderEstadoCajaSection();   // refresca el resaltado del botón activo
      await loadData();                  // repinta el punto de color en la tabla
    } catch (err) {
      group.querySelectorAll('button').forEach((x) => { x.disabled = false; });
      NovaUtils.showAlert(document.getElementById('sal-modal-alert'),
        'No se pudo actualizar el estado de la caja: ' + err.message, 'error');
    }
  }

  // Refleja el cambio de estado/materialización en la fila real de allData (editEnvio es la
  // referencia viva). editBultos[i] y editEnvio.bultos[i] comparten orden e índice.
  function syncEnvioBulto(i, updated) {
    if (!editEnvio || !Array.isArray(editEnvio.bultos) || !editEnvio.bultos[i]) return;
    editEnvio.bultos[i].id = updated.id;
    editEnvio.bultos[i].estado_caja = updated.estado_caja;
    if (updated.numero_bulto != null) editEnvio.bultos[i].numero_bulto = updated.numero_bulto;
  }

  // Re-deriva profit y % en vivo. Lee el total cobrado editable (saled-total) y el costo
  // (suma del desglose). profit = cobrado − costo;
  // porcentaje = profit / costo × 100 (margen sobre el costo, igual que el backend).
  // Si no hay total cobrado (null o 0), no toca los campos (misma guarda que el backend).
  function recalcProfit() {
    const num = (id) => parseNum(document.getElementById(id).value);
    const totalRaw = document.getElementById('saled-total').value;
    const total = totalRaw === '' ? null : Number(totalRaw);
    if (total == null || total === 0) return;

    const costo = num('saled-flete') - num('saled-descuento') + num('saled-seguro')
      + num('saled-fuel') + num('saled-derechos') + num('saled-adicionales') + num('saled-otros');
    const profit = Math.round((total - costo) * 100) / 100;
    document.getElementById('saled-profit').value = profit;
    document.getElementById('saled-porcentaje').value = costo > 0
      ? Math.round((profit / costo) * 10000) / 100
      : '';
  }

  // Suma de los montos del desglose de adicionales.
  function extrasSum() {
    return editExtras.reduce((acc, x) => acc + parseNum(x.monto), 0);
  }

  // Render del bloque de solo lectura bajo Costos: una fila por extra (label + monto) y
  // una fila de total. Envío viejo/sin extras → texto tenue. Tras renderizar, re-evalúa
  // el cartelito de desfase.
  function renderExtrasBlock() {
    const block = document.getElementById('saled-extras-block');
    console.log('[renderExtras] block:', block, 'editExtras:', JSON.parse(JSON.stringify(editExtras)), 'dirty:', editExtrasDirty);
    if (!block) return;

    if (!editExtras.length) {
      block.innerHTML = `
        <div class="saled-extras-title">Desglose de adicionales</div>
        <div class="saled-extras-empty">Sin desglose disponible</div>`;
      return;
    }

    const rows = editExtras.map((x) => `
      <div class="saled-extra-row">
        <span class="saled-extra-label">${esc(x.label || x.tipo || '—')}</span>
        <span class="saled-extra-monto">${fmtUSD(x.monto)}</span>
      </div>`).join('');

    block.innerHTML = `
      <div class="saled-extras-title">Desglose de adicionales</div>
      <div class="saled-extras-list">
        ${rows}
        <div class="saled-extra-row saled-extra-total">
          <span class="saled-extra-label">Total desglose</span>
          <span class="saled-extra-monto">${fmtUSD(extrasSum())}</span>
        </div>
      </div>
      <div id="saled-extras-warn" class="saled-extras-warn hidden">Total ajustado a mano — el desglose puede no coincidir.</div>`;

    updateExtrasWarn();
  }

  // Muestra el cartelito ámbar si el total de Adicionales (editable) ya no coincide con la
  // suma del desglose. Sin desglose → nunca (no hay con qué comparar).
  function updateExtrasWarn() {
    const warn = document.getElementById('saled-extras-warn');
    console.log('[extrasWarn] warn elem:', warn, 'editExtras.length:', editExtras.length);
    if (!warn) return;
    if (!editExtras.length) {
      warn.classList.add('hidden');
      return;
    }
    const rawAdic = document.getElementById('saled-adicionales').value;
    const adic = parseNum(rawAdic);
    const sum = extrasSum();
    const mismatch = Math.abs(adic - sum) > 0.01;
    console.log('[extrasWarn] rawAdic:', JSON.stringify(rawAdic), 'adic:', adic, 'extrasSum:', sum, 'mismatch:', mismatch);
    warn.classList.toggle('hidden', !mismatch);
  }

  // Recalcula el desglose contra el motor (POST /salidas/:id/recalcular) con el peso/medidas
  // editados, repuebla flete/seguro/fuel/adicionales y los pesos de solo lectura, y re-deriva
  // profit/%. NO toca derechos/descuento/otros (esos no los calcula el motor).
  async function recalcularDesglose() {
    if (!editEnvio) return;
    const btn = document.getElementById('saled-recalcular');
    const status = document.getElementById('saled-recalc-status');

    const body = {
      asegurado: document.getElementById('saled-asegurado').checked ? 1 : 0,
    };
    if (editMulti) {
      recalcEditPesoBalanza();
      const bultos = readBultosFromModal();
      body.bultos = bultos.map((b) => ({
        peso_real: b.peso_real, largo: b.largo, ancho: b.ancho, alto: b.alto,
      }));
      body.peso_real = parseFloat(document.getElementById('saled-peso-real').value) || null;
    } else {
      const num = (id) => {
        const v = document.getElementById(id).value;
        return v !== '' ? Number(v) : null;
      };
      body.peso_real = num('saled-peso-real');
      body.largo = num('saled-largo');
      body.ancho = num('saled-ancho');
      body.alto = num('saled-alto');
    }

    btn.disabled = true;
    status.className = 'saled-recalc-status';
    status.textContent = 'Recalculando…';

    try {
      const r = await NovaAPI.salidas.recalcular(editEnvio.id, body);
      document.getElementById('saled-flete').value = r.flete ?? '';
      document.getElementById('saled-seguro').value = r.seguro ?? '';
      document.getElementById('saled-fuel').value = r.fuel ?? '';
      document.getElementById('saled-adicionales').value = r.adicionales ?? '';
      document.getElementById('saled-peso-facturable').value = r.peso_facturable ?? '';
      document.getElementById('saled-peso-volumetrico').value = r.peso_volumetrico ?? '';
      // Desglose nuevo del motor: queda "dirty" para persistirlo al guardar. Tras esto el
      // total y la suma vuelven a cuadrar, así que el cartelito desaparece solo.
      editExtras = Array.isArray(r.extras) ? r.extras.map((x) => ({ ...x })) : [];
      editExtrasDirty = true;
      renderExtrasBlock();
      recalcProfit();
      status.className = 'saled-recalc-status saled-recalc-ok';
      status.textContent = 'Desglose actualizado. Revisá y guardá para persistir.';
    } catch (err) {
      // Caso típico 422: país/zona que el motor no reconoce para este envío.
      const msg = /zona|pa[ií]s|desglose/i.test(err.message)
        ? 'No se pudo recalcular: país o zona no reconocidos por el motor.'
        : `No se pudo recalcular: ${err.message}`;
      status.className = 'saled-recalc-status saled-recalc-err';
      status.textContent = msg;
    } finally {
      btn.disabled = false;
    }
  }

  function closeEditModal() {
    document.getElementById('sal-edit-overlay').classList.add('hidden');
    editEnvio = null;
    // Devolver el foco al wrapper de la tabla para que las flechas vuelvan a navegar
    // sobre la última celda activa. Solo si hay celda activa, para no robar el foco si
    // el usuario nunca tocó la grilla.
    if (activeCell) {
      const wrap = document.getElementById('table-wrap');
      if (wrap) wrap.focus({ preventScroll: true });
    }
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
    // Total cobrado editable: se persiste en la columna total_cobrado (el GET lo expone
    // como `total`). Permite cargar una guía en 0 y completar el cobro después.
    const totalCobrado = document.getElementById('saled-total').value;
    payload.total_cobrado = totalCobrado !== '' ? Number(totalCobrado) : null;

    // Peso y medidas (nombres de columna del backend). En multi-bulto las medidas viajan en
    // el array de bultos; el peso balanza de arriba es la suma. peso_facturable/volumétrico
    // son los que dejó el último Recalcular (solo lectura).
    const numField = (id) => {
      const v = document.getElementById(id).value;
      return v !== '' ? Number(v) : null;
    };
    payload.peso_real        = numField('saled-peso-real');
    payload.largo            = numField('saled-largo');
    payload.ancho            = numField('saled-ancho');
    payload.alto             = numField('saled-alto');
    payload.peso_facturable  = numField('saled-peso-facturable');
    payload.peso_volumetrico = numField('saled-peso-volumetrico');

    // Bultos editados: el PATCH actualiza cada fila por id (ignora id null del bulto único).
    const bultosPayload = editMulti
      ? readBultosFromModal().map((b) => ({
          id: b.id, peso_real: b.peso_real, largo: b.largo, ancho: b.ancho, alto: b.alto,
        }))
      : [];
    if (bultosPayload.length > 0) payload.bultos = bultosPayload;

    // Desglose: solo se persiste si proviene de un Recalcular de esta sesión. Si el usuario
    // solo editó el total a mano, no se manda y el backend no pisa la columna (UX acordada).
    if (editExtrasDirty) payload.extras_json = editExtras;

    try {
      await NovaAPI.salidas.actualizar(editEnvio.id, payload);
      const idx = allData.findIndex((d) => d.id === editEnvio.id);
      if (idx !== -1) {
        const d = allData[idx];
        // NO pisar d.bultos con payload.bultos: esos objetos llevan solo dims (id, peso,
        // medidas) SIN estado_caja, y reemplazarían el array vivo borrando el semáforo de
        // caja recién traído del GET (se vería rojo hasta refrescar). Las dims por bulto se
        // mergean más abajo sobre las filas vivas (Object.assign(target, eb)), conservando
        // estado_caja. Por eso aquí se asignan solo los campos del envío, sin `bultos`.
        const { bultos: _ignorarBultos, ...envioFields } = payload;
        Object.assign(d, envioFields);
        // Reflejar el desglose persistido en memoria para que al reabrir se vea igual (el GET
        // lo expone como `extras`, distinto del `extras_json` que viaja en el PATCH).
        if (editExtrasDirty) d.extras = editExtras.map((x) => ({ ...x }));
        // Alias que usa la tabla (el GET expone peso_real como `peso` y total_cobrado como
        // `total`) y refresco de bultos.
        d.peso = payload.peso_real;
        d.total = payload.total_cobrado;
        d.asegurado = Boolean(payload.asegurado);
        d.compra_total = (payload.flete || 0) - (payload.descuento || 0) + (payload.seguro || 0)
          + (payload.fuel || 0) + (payload.derechos || 0) + (payload.adicionales || 0) + (payload.otros || 0);
        if (editMulti && Array.isArray(d.bultos)) {
          for (const eb of bultosPayload) {
            const target = d.bultos.find((x) => x.id === eb.id);
            if (target) Object.assign(target, eb);
          }
        } else if (Array.isArray(d.bultos) && d.bultos.length === 1) {
          // Bulto único sintético: refleja el peso/medidas del envío en su única fila.
          Object.assign(d.bultos[0], {
            peso_real: payload.peso_real, largo: payload.largo, ancho: payload.ancho, alto: payload.alto,
          });
        }
      }
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
      // Recargar desde el backend: loadData() vuelve a correr recomputeNumSalMes(), así que
      // el #Sal por mes se renumera sin huecos al re-render.
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
      // ni si fue en el lápiz / editor inline de la guía del bulto, ni en el checkbox
      // de selección de guías (igual que ya se ignora .track-btn).
      if (e.target.closest('.chk-guia')) return;
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
        // Regenerar el checkbox de "Copiar guías" de esta fila: su value depende
        // de la guía recién editada. Preservar el estado marcado si lo estaba.
        const isFirst = !tr.classList.contains('bulto-detail-row');
        const chkTd = tr.querySelector('td.chk-cell');
        if (chkTd) {
          const wasChecked = !!chkTd.querySelector('.chk-guia')?.checked;
          chkTd.innerHTML = chkCellHtml(computeRowGuia(envio, bulto, isFirst));
          if (wasChecked) {
            const cb = chkTd.querySelector('.chk-guia');
            if (cb) cb.checked = true;
          }
        }
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

  // ── Navegación por celdas tipo Excel ─────────────────────────────────────────
  // Las flechas mueven una celda activa por la grilla. El estado vive como coordenada
  // lógica (activeCell) y sobrevive al re-render destructivo de renderPage.
  function bindGridNav() {
    const wrap = document.getElementById('table-wrap');
    if (!wrap) return;
    // El wrapper necesita poder recibir foco para capturar las flechas.
    wrap.setAttribute('tabindex', '0');
    wrap.addEventListener('keydown', onGridKeydown);

    // Click en una celda de datos: fija la celda activa SIN interferir con el modal.
    // No hace stopPropagation ni preventDefault, así que el handler de fila sigue abriendo
    // el modal igual que hoy; solo deja la coordenada lista para navegar con flechas.
    document.getElementById('salidas-body').addEventListener('click', (e) => {
      const td = e.target.closest('td');
      const tr = e.target.closest('tr[data-envio-id]');
      if (!td || !tr || td.parentElement !== tr) return;
      setActiveCell(dataRowIndexOf(tr), td.cellIndex, false);
      // Dar foco al wrapper para que las flechas lleguen al listener. bindRowEdit está
      // registrado ANTES que este listener, así que si el click abrió el modal el overlay
      // ya es visible y su input ya tiene foco: en ese caso NO robamos el foco. Solo
      // enfocamos el wrapper cuando el click NO terminó abriendo el modal.
      const overlay = document.getElementById('sal-edit-overlay');
      if (!overlay || overlay.classList.contains('hidden')) {
        wrap.focus({ preventScroll: true });
      }
    });
  }

  // Filas de datos = las que tienen data-envio-id. Excluye automáticamente las filas
  // "Cargando…" / "No hay envíos" (td colspan 32 sin data-envio-id).
  function getDataRows() {
    const tbody = document.getElementById('salidas-body');
    if (!tbody) return [];
    return Array.from(tbody.querySelectorAll('tr[data-envio-id]'));
  }

  function dataRowIndexOf(tr) {
    return getDataRows().indexOf(tr);
  }

  function getActiveTd() {
    if (!activeCell) return null;
    const tr = getDataRows()[activeCell.rowIndex];
    if (!tr) return null;
    return tr.cells[activeCell.colIndex] || null;
  }

  function clearActiveCellHighlight() {
    const tbody = document.getElementById('salidas-body');
    if (!tbody) return;
    tbody.querySelectorAll('td.cell-active').forEach((td) => td.classList.remove('cell-active'));
  }

  function applyActiveCellHighlight() {
    clearActiveCellHighlight();
    const td = getActiveTd();
    if (td) td.classList.add('cell-active');
  }

  function setActiveCell(rowIndex, colIndex, scroll) {
    // colIndex < GRID_MIN_COL incluye la columna 0 (checkbox): un click ahí NO activa celda.
    if (rowIndex < 0 || colIndex < GRID_MIN_COL) return;
    activeCell = { rowIndex, colIndex };
    applyActiveCellHighlight();
    if (scroll) scrollActiveCellIntoView();
  }

  // Tras un re-render: clampear la coordenada al set de filas actual y reaplicar el
  // resaltado. Si ya no hay filas de datos, limpiar (sin resaltado fantasma).
  function reconcileActiveCell() {
    if (!activeCell) return;
    const rows = getDataRows();
    if (!rows.length) { activeCell = null; clearActiveCellHighlight(); return; }
    const rowIndex = Math.min(Math.max(activeCell.rowIndex, 0), rows.length - 1);
    const colIndex = Math.min(Math.max(activeCell.colIndex, GRID_MIN_COL), GRID_MAX_COL);
    activeCell = { rowIndex, colIndex };
    applyActiveCellHighlight();
  }

  // La navegación de grilla CEDE el control (no hace nada) cuando el foco está en un
  // input/textarea/select, dentro del editor inline de guía, o con el modal abierto.
  function shouldYieldGridNav(e) {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return true;
    if (e.target.closest && e.target.closest('.bulto-guia-edit-box')) return true;
    const overlay = document.getElementById('sal-edit-overlay');
    if (overlay && !overlay.classList.contains('hidden')) return true;
    return false;
  }

  function onGridKeydown(e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (shouldYieldGridNav(e)) return;

    const rows = getDataRows();
    if (!rows.length) return;

    // Sin celda activa: la primera flecha activa la primera celda de datos navegable
    // (col GRID_MIN_COL, saltando el checkbox de la columna 0).
    if (!activeCell) {
      setActiveCell(0, GRID_MIN_COL, true);
      e.preventDefault();
      return;
    }

    let { rowIndex, colIndex } = activeCell;
    if (e.key === 'ArrowUp') rowIndex = Math.max(0, rowIndex - 1);
    else if (e.key === 'ArrowDown') rowIndex = Math.min(rows.length - 1, rowIndex + 1);
    else if (e.key === 'ArrowLeft') colIndex = Math.max(GRID_MIN_COL, colIndex - 1);
    else if (e.key === 'ArrowRight') colIndex = Math.min(GRID_MAX_COL, colIndex + 1);

    // En el borde no hay movimiento: NO bloquear el scroll normal de la página.
    if (rowIndex === activeCell.rowIndex && colIndex === activeCell.colIndex) return;

    setActiveCell(rowIndex, colIndex, true);
    e.preventDefault();
  }

  // Scroll automático a la celda activa, dos ejes.
  function scrollActiveCellIntoView() {
    const td = getActiveTd();
    if (!td) return;

    // Horizontal: el scroll real es del wrapper (overflow-x auto).
    const wrap = document.getElementById('table-wrap');
    if (wrap) {
      const cellLeft = td.offsetLeft;                 // relativo a la tabla (origen del wrapper)
      const cellRight = cellLeft + td.offsetWidth;
      if (cellLeft < wrap.scrollLeft) {
        wrap.scrollLeft = cellLeft - 8;
      } else if (cellRight > wrap.scrollLeft + wrap.clientWidth) {
        wrap.scrollLeft = cellRight - wrap.clientWidth + 8;
      }
    }

    // Vertical: scroll de la ventana, corrigiendo el thead sticky para que no tape la celda.
    const thead = document.querySelector('.salidas-table thead');
    const headH = thead ? thead.getBoundingClientRect().height : 0;
    const rect = td.getBoundingClientRect();
    const viewH = window.innerHeight || document.documentElement.clientHeight;
    if (rect.top < headH + 4) {
      window.scrollBy(0, rect.top - headH - 8);
    } else if (rect.bottom > viewH) {
      window.scrollBy(0, rect.bottom - viewH + 8);
    }
  }

  init();
})();
