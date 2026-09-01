(function () {
  // ── Constantes ──────────────────────────────────────────────────────────────
  const DIAS_ALERTA_ROJO = 15;    // umbral de días para semáforo rojo

  // ── Estado ──────────────────────────────────────────────────────────────────
  let allData = [];          // todos los envíos cargados del servidor
  let filteredData = [];     // resultado de aplicar todos los filtros (lista de envíos)
  let sortCol = 'fecha';
  let sortDir = 'desc';
  let searchTerm = '';
  let soloAlertas = false;
  // "1º bulto": deja UN renglón por envío (pedido de la oficina, 28/08 — el desglose de
  // los multibulto molesta cuando revisan envíos). Solo afecta el render, no los filtros.
  let soloPrimerBulto = false;
  let selectedMonth = null;  // mes activo de las solapas ("YYYY-MM"); null = sin datos
  const colFilters = {};     // { courier: Set(['UPS','DHL']), ... }

  // Envíos con el desglose de adicionales desplegado (sub-fila de extras). Se consulta
  // en render para re-expandir tras el rebuild destructivo del tbody (filtro/mes/sort),
  // así el estado sobrevive dentro de la sesión sin persistir en localStorage.
  const expandedExtras = new Set();

  // Envíos "marcados" a mano (click en la celda #Sal) como ayuda de lectura en una tabla
  // ancha, tipo seleccionar la fila en Excel. Solo en memoria: se limpia al recargar, no
  // persiste en localStorage. Como expandedExtras, se re-aplica tras el rebuild del tbody.
  const markedEnvios = new Set();

  // dropdown flotante
  let ddColumn = null;
  let ddTempSelected = new Set();

  // Columnas que se pueden filtrar de más de una forma. La celda Bulto dice "2/3": la
  // oficina a veces quiere el NÚMERO de bulto (ver solo los 1/x y sacar de la vista los
  // 2/3, 3/3 — pedido del 31/08) y a veces la CANTIDAD de bultos del envío (ver solo los
  // de una caja — pedido del 28/08). Son dos preguntas distintas sobre la misma celda.
  const CRITERIOS = {
    numero_bulto: [
      { col: 'numero_bulto', label: 'Bulto n°' },
      { col: 'cantidad_bultos', label: 'Cant. bultos' },
      // Con el semáforo automático (31/08) el color pasó a ser DATO y no adorno: la
      // oficina quiere "ver todas las amarillas" para saber qué está en tránsito.
      { col: 'estado_semaforo', label: 'Semáforo' },
    ],
  };
  // Filtros que NO se resuelven sobre el envío sino sobre cada RENGLÓN (un bulto).
  const FILTROS_DE_BULTO = new Set(['numero_bulto', 'estado_semaforo']);
  // Lo que el filtro de semáforo muestra por cada color: EL MISMO texto que el tooltip
  // del puntito (regla de los filtros del 28/08: se filtra por lo que se ve).
  const SEMAFORO_LABEL = { rojo: 'No escaneada', amarillo: 'En tránsito', verde: 'Entregada' };
  const semaforoDeBulto = (b) => SEMAFORO_LABEL[b && b.estado_caja] || SEMAFORO_LABEL.rojo;

  // caché de resultados de tracking (por sesión)

  // Clientes para el select del modal de edición. Se cargan una vez en init y se
  // reusan cada vez que se abre el modal (para poder preseleccionar el del envío).
  let clientes = [];

  // Tolerancias de comparación contra la factura del courier, por courier:
  // { UPS: { peso, costo }, DHL: { peso, costo } }. Se cargan una vez en init y las usan
  // las columnas UPS para decidir el semáforo rojo del desvío. Vacío = sin semáforo.
  let tolerancias = {};

  // estado del modal de edición
  let editEnvio = null;
  let editBultos = [];      // bultos del envío en edición (multi-bulto)
  let editMulti = false;    // true si el envío tiene más de un bulto
  let editExtras = [];      // desglose de adicionales [{ tipo, label, monto }]
  let editExtrasDirty = false; // true solo si el desglose viene de un Recalcular de esta sesión

  // ── Navegación por celdas (estilo Excel) ────────────────────────────────────
  // activeCell es una COORDENADA LÓGICA, no un nodo: { rowIndex, colIndex } | null.
  // El re-render destruye los td, por eso se guardan índices y se vuelve a resolver el td.
  // La columna 0 es el checkbox de selección: NO se navega con flechas (índices 1..36).
  const GRID_MIN_COL = 1;    // columna 0 = checkbox "copiar guías", no navegable
  const GRID_MAX_COL = 37;   // 38 columnas fijas → índices 0..37; navegables 1..37
  let activeCell = null;

  // ── Bloque desplegable de columnas UPS (Costo UPS, Dif Costo, Peso UPS, Dif Peso, Revisión)
  // Cinco columnas contiguas (índices 30..34) que solo importan al cruzar facturas. Se ocultan
  // con la clase .ups-collapsed en la tabla (CSS: .ups-col{display:none}). Frontend puro: la
  // exportación a Excel las incluye SIEMPRE, este el bloque plegado o no.
  const UPS_COL_START = 30;  // Costo UPS
  const UPS_COL_END = 35;    // Revisión (el bloque sumó Profit Real el 31/08)
  const UPS_BLOCK_COLS = UPS_COL_END - UPS_COL_START + 1;   // 6 columnas ocultables

  // Override manual del bloque, guardado en sessionStorage (dura la sesión y después vuelve al
  // comportamiento automático). null = auto (según haya pendientes); true/false = forzado.
  const UPS_OVERRIDE_KEY = 'nova.salidas.upsColsOverride';
  let upsOverride = null;    // null | true (forzar mostrar) | false (forzar ocultar)
  let upsVisible = true;     // estado efectivo actual del bloque (se recalcula en cada render)

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
    bindTracking();
    bindRowEdit();
    bindRowMark();
    bindRevisionButtons();
    bindBultoGuiaEdit();
    bindDetailToggle();
    bindGridNav();
    bindCopiarGuias();
    bindSelectAllGuias();
    loadStickyPins();
    bindStickyCols();
    loadUpsOverride();
    bindUpsToggle();
    bindFloatingScrollbar();
    await loadClientes();
    await loadTolerancias();
    await loadData();
  }

  // Carga la lista de clientes (para el select de cliente del modal de edición). Si
  // falla no rompe la pantalla: el select simplemente quedará vacío hasta reintentar.
  async function loadClientes() {
    try {
      clientes = await NovaAPI.clientes.listar();
    } catch (err) {
      console.warn('[salidas] No se pudieron cargar clientes:', err.message);
      clientes = [];
    }
  }

  // Carga las tolerancias por courier (GET /configuracion/tolerancias → array de filas
  // con umbral % y umbral absoluto por métrica) y las indexa por courier. Cada métrica
  // guarda { pct, abs }: el semáforo pinta rojo si el desvío en contra nuestra supera UNO
  // de los dos (ver difEval). Si falla no rompe la pantalla: sin tolerancias no se pinta.
  async function loadTolerancias() {
    try {
      const rows = await NovaAPI.configuracion.tolerancias();
      tolerancias = {};
      for (const r of (rows || [])) {
        tolerancias[r.courier] = {
          peso:  { pct: r.tolerancia_peso_pct,  abs: r.tolerancia_peso_kg },
          costo: { pct: r.tolerancia_costo_pct, abs: r.tolerancia_costo_usd },
        };
      }
    } catch (err) {
      console.warn('[salidas] No se pudieron cargar tolerancias:', err.message);
      tolerancias = {};
      // Falla RUIDOSA a propósito. Con `tolerancias` en {}, difEval() evalúa
      // `tol.pct != null && ...` como false SIEMPRE: ningún desvío contra la factura del
      // courier se pinta en rojo nunca, y la pantalla queda idéntica a "todo dentro de
      // tolerancia". Es un control de costos apagado sin que nadie se entere.
      NovaUtils.showAlert(
        alertBox,
        'No se pudieron cargar las tolerancias: el semáforo de desvíos contra la factura '
          + 'del courier quedó DESACTIVADO en esta pantalla. Recargá la página.',
        'error'
      );
    }
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
        `<tr><td colspan="${emptyColspan()}" class="salidas-empty">Error al cargar datos</td></tr>`;
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
      let n = 0;   // correlativo corrido del mes; los "sin numerar" NO lo consumen
      byMonth[mes]
        .sort((a, b) => {
          if (a.fecha < b.fecha) return -1;
          if (a.fecha > b.fecha) return 1;
          return (a.id || 0) - (b.id || 0);
        })
        .forEach((e) => {
          // Envío "sin numerar" (num_sal_cero): recibe 0 y no gasta número; el resto del
          // mes se sigue numerando 1..N corrido, como si los cero no existieran. Como la
          // columna #Sal ordena por num_sal_mes, los 0 quedan arriba de todos.
          e.num_sal_mes = e.num_sal_cero ? 0 : ++n;
        });
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
    const current = NovaUtils.mesLocal();
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
        applyAll();
      });
      container.appendChild(tab);
    }
  }

  // ── Pipeline de filtrado / agrupado / render ─────────────────────────────────
  function applyAll() {
    filtered();
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
        // Los de RENGLÓN (número de bulto, semáforo) se resuelven juntos más abajo.
        if (FILTROS_DE_BULTO.has(col)) continue;
        const cell = resolveCell(e, col, today);
        if (!vals.has(String(cell))) return false;
      }

      // Filtros de RENGLÓN, aplicados JUNTOS: el envío entra si le queda al menos un
      // bulto que cumpla todos (bulto n° 1 Y amarillo, por ejemplo). Los renglones que
      // sobran los saca renderPage con la misma función — así lo que se lista y lo que
      // se dibuja no pueden discrepar.
      if (!bultosVisibles(e, colFilters).length) return false;

      // Solo alertas
      if (soloAlertas) {
        const a = alertLevel(e);
        if (!a) return false;
      }

      return true;
    });
  }

  // Los bultos del envío que pasan los filtros DE RENGLÓN (número de bulto y semáforo),
  // aplicados juntos: un renglón queda solo si cumple TODOS. Recibe el objeto de filtros
  // entero (colFilters o una copia); ignora los que no son de renglón y los vacíos.
  // Devuelve pares [bulto, índiceOriginal] para que el renglón siga sabiendo su posición
  // real: filtrando el bulto 2 de un envío de tres, la celda tiene que decir "2/3" y no
  // "1/1" — el total y el número son del envío, no de lo que quedó a la vista.
  function bultosVisibles(e, filtros) {
    const lista = (e.bultos && e.bultos.length) ? e.bultos : [null];
    const conIdx = lista.map((b, i) => [b, i]);
    const fNum = filtros && filtros.numero_bulto;
    const fSem = filtros && filtros.estado_semaforo;
    return conIdx.filter(([b, i]) => {
      if (fNum && fNum.size > 0 && !fNum.has(String((b && b.numero_bulto) ?? (i + 1)))) return false;
      if (fSem && fSem.size > 0 && !fSem.has(semaforoDeBulto(b))) return false;
      return true;
    });
  }

  // Devuelve el valor de la celda que se usa para filtrar/mostrar
  function resolveCell(e, col, today) {
    if (col === 'estado') return estadoLabel(e, today);
    if (col === 'tipo_paquete') return e.tipo_paquete || '—';
    if (col === 'direccion') return e.direccion || 'expo';
    // Columnas con filtro que no son texto directo de la fila (28/08, pedido de la
    // oficina de filtrar "como en el Excel"). El valor tiene que ser EL MISMO que se ve
    // en pantalla, para que el desplegable liste lo que la oficina reconoce.
    if (col === 'fecha') return NovaUtils.formatDate(e.fecha) || '';
    if (col === 'asegurado') return e.asegurado ? 'Sí' : 'No';
    if (col === 'cantidad_bultos') return String((e.bultos && e.bultos.length) || e.cantidad_bultos || 1);
    if (col === 'revision') {
      const m = { revisado_ok: 'Aprobada', a_revisar: 'A revisar', reclamar: 'En reclamo', pendiente: 'Pendiente' };
      return e.costo_facturado == null ? 'Sin factura' : (m[e.estado_revision] || 'Pendiente');
    }
    return String(e[col] ?? '');
  }

  // ── Render: fila por bulto ───────────────────────────────────────────────────
  // El sort y el filtro operan sobre la lista de ENVÍOS (filteredData). La expansión
  // a N renglones por bulto es un paso puro de render: cada envío ya ordenado/filtrado
  // se convierte en e.bultos.length renglones. Se renderizan TODAS las filas de una: el
  // contenedor de alto fijo (#table-wrap) scrollea internamente hasta la última. El volumen
  // es chico (decenas por mes, a lo sumo cientos sin filtrar), así que no hace falta paginar.
  function renderPage() {
    const today = todayStr();
    const tbody = document.getElementById('salidas-body');
    const fragment = document.createDocumentFragment();

    // Recalcular la visibilidad efectiva del bloque UPS ANTES de construir filas: las sub-filas
    // de detalle y los estados vacíos leen upsVisible para elegir su colspan.
    upsVisible = computeUpsVisible();

    tbody.innerHTML = '';

    for (const e of filteredData) {
      const todos = (e.bultos && e.bultos.length) ? e.bultos : [null];
      const totalBultos = todos.length;
      // El filtro por número de bulto (columna Bulto) saca renglones, no envíos: acá se
      // aplica. Cada par conserva el índice ORIGINAL, así la celda sigue diciendo "2/3".
      let visibles = bultosVisibles(e, colFilters);
      // "1º bulto": un renglón por envío. La celda Bulto sigue diciendo "1/3", así se ve
      // que el envío tiene más bultos aunque no se muestren.
      if (soloPrimerBulto && visibles.length > 1) visibles = [visibles[0]];
      visibles.forEach(([bulto, idxOriginal], pos) => {
        // isFirst = es el PRIMER renglón que se dibuja de este envío. Los datos del envío
        // (cliente, plata, iconos) van ahí, aunque el bulto que quedó a la vista sea el 2.
        fragment.appendChild(buildRow(e, bulto, idxOriginal, totalBultos, today, pos === 0));
      });
      // Re-expandir el detalle si estaba abierto: cuelga del envío completo, DESPUÉS de
      // todos sus renglones de bulto.
      if (expandedExtras.has(e.id) && detailHasContent(e)) {
        fragment.appendChild(buildDetailRow(e));
      }
    }

    if (filteredData.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="${emptyColspan()}" class="salidas-empty">No hay envíos que coincidan con los filtros</td>`;
      tbody.appendChild(tr);
    } else {
      tbody.appendChild(fragment);
    }

    // El tbody se reconstruyó: re-resolver la celda activa por coordenadas y reaplicar
    // el resaltado (o limpiarlo si la coordenada ya no existe).
    reconcileActiveCell();

    // Plegar/desplegar el bloque UPS (clase de la tabla + botón) ANTES de medir sticky: con
    // table-layout auto, ocultar columnas redistribuye anchos y mueve los offsets sticky.
    syncUpsChrome();

    // Re-medir offsets sticky: con table-layout auto los anchos de columna dependen del
    // contenido, que cambia al filtrar / cambiar de mes / ordenar. NO toca ningún <td>,
    // solo reescribe el <style id="sticky-cols-style">.
    applyStickyCols();

    // El scrollWidth de la tabla cambió: recalcular el fantasma de la barra flotante.
    refreshFloatingScrollbar();
  }

  // ── Bloque desplegable de columnas UPS ───────────────────────────────────────
  // Carga el override manual desde sessionStorage. Ausente o inválido → auto (null).
  function loadUpsOverride() {
    let raw = null;
    try { raw = sessionStorage.getItem(UPS_OVERRIDE_KEY); } catch (_) { raw = null; }
    upsOverride = raw === 'show' ? true : raw === 'hide' ? false : null;
  }

  // Visibilidad efectiva del bloque. Override manual (dura la sesión) tiene prioridad; si no
  // hay override, AUTO: se muestra si en la vista actual (filteredData) hay AL MENOS UN envío
  // pendiente de revisión (misma condición que la botonera ✓/✕: isRevisionPendiente).
  function computeUpsVisible() {
    if (upsOverride !== null) return upsOverride;
    return filteredData.some((e) => isRevisionPendiente(e, true));
  }

  // Colspan de la celda de CONTENIDO de la sub-fila de detalle (arranca en Venta Total, col 19,
  // y llega hasta Observaciones, col 36). Plegado → restar las 5 columnas del bloque.
  function detailContentColspan() {
    return upsVisible ? 19 : 19 - UPS_BLOCK_COLS;
  }

  // Colspan de las filas de estado vacío / cargando / error (abarcan toda la tabla).
  function emptyColspan() {
    return upsVisible ? 38 : 38 - UPS_BLOCK_COLS;
  }

  // Aplica la visibilidad efectiva al "chrome": clase de la tabla (CSS oculta .ups-col) y
  // estado del botón. No toca colspans ni mide anchos (eso lo hace applyUpsCols / renderPage).
  function syncUpsChrome() {
    const table = document.getElementById('salidas-table');
    if (table) table.classList.toggle('ups-collapsed', !upsVisible);
    updateUpsToggleBtn();
  }

  // El botón muestra el estado actual: distinto abierto (activo, ▾) que cerrado (▸).
  function updateUpsToggleBtn() {
    const btn = document.getElementById('btn-toggle-ups');
    if (!btn) return;
    btn.classList.toggle('active', upsVisible);
    btn.setAttribute('aria-pressed', upsVisible ? 'true' : 'false');
    btn.title = upsVisible
      ? 'Ocultar las columnas de comparación con UPS'
      : 'Mostrar las columnas de comparación con UPS';
    btn.innerHTML = `🧾 Columnas UPS <span class="ups-toggle-caret">${upsVisible ? '▾' : '▸'}</span>`;
  }

  // Recalcula y aplica la visibilidad del bloque SOBRE el DOM ya renderizado, sin re-paginar:
  // recomputa upsVisible, sincroniza clase/botón, corrige los colspans de las sub-filas de
  // detalle y de los estados vacíos ya presentes, y re-mide sticky + barra flotante (cambió el
  // ancho). Se usa en el toggle manual y al cambiar un estado de revisión (auto).
  function applyUpsCols() {
    upsVisible = computeUpsVisible();
    syncUpsChrome();
    document.querySelectorAll('#salidas-body tr.extras-detail-row > td:last-child')
      .forEach((td) => { td.colSpan = detailContentColspan(); });
    document.querySelectorAll('#salidas-body td.salidas-empty')
      .forEach((td) => { td.colSpan = emptyColspan(); });
    applyStickyCols();
    refreshFloatingScrollbar();
  }

  // Botón manual: fuerza lo CONTRARIO a lo que se ve ahora y lo persiste para la sesión.
  function bindUpsToggle() {
    const btn = document.getElementById('btn-toggle-ups');
    if (!btn) return;
    updateUpsToggleBtn();
    btn.addEventListener('click', () => {
      const forceVisible = !upsVisible;
      upsOverride = forceVisible;
      try { sessionStorage.setItem(UPS_OVERRIDE_KEY, forceVisible ? 'show' : 'hide'); } catch (_) {}
      applyUpsCols();
    });
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

    // NO VOLO: el envio se cargo y no salio. Se pinta el renglon entero (todos sus bultos)
    // para que se vea de un vistazo, igual que la oficina lo pintaba en el Excel. La fila
    // NO se saca de la lista y conserva su numero de salida: el envio 27 sigue siendo el 27.
    if (e.no_volo) tr.classList.add('row-no-volo');

    // Alertas: resaltar TODOS los renglones del envío (se ve como una unidad).
    const alert = alertLevel(e, today);
    if (alert === 'rojo') tr.classList.add('row-alert-rojo');
    else if (alert === 'ambar') tr.classList.add('row-alert-ambar');

    // Marca de lectura manual: sobrevive al rebuild del tbody vía markedEnvios.
    if (markedEnvios.has(e.id)) tr.classList.add('row-marked');

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

    // Celda Adic expandible: fila principal con desglose. Toda la celda es clickeable para
    // togglear el desglose (no solo el ▸). Bultos y envíos sin extras quedan como hoy.
    const adicExp = !!(isFirst && e.extras && e.extras.length);
    // Celda Venta Total expandible: abre la MISMA sub-fila de detalle (bloque Venta). Solo en
    // la fila principal (isFirst) y solo si hay venta cargada (venta_desglose != null, i.e.
    // total_cobrado > 0). Envío sin venta → celda no clickeable, sin ▸ (como una celda normal).
    const ventaExp = !!(isFirst && e.venta_desglose);

    // Checkbox de selección para "Copiar guías": solo en el primer renglón del envío y
    // solo si tiene guía. El value es la guía del ENVÍO (e.numero_guia), nunca la del bulto,
    // para no duplicar guías en envíos multi-bulto. Sub-filas y envíos sin guía: celda vacía.
    const rowGuia = computeRowGuia(e, b, isFirst);
    const chkCell = chkCellHtml(rowGuia);

    // Columnas de comparación contra la factura del courier (Costo/Peso UPS + sus desvíos).
    // Solo datos de UPS: no repiten venta/peso nuestros, que ya están en la fila. El desvío
    // se pinta rojo solo si va en contra nuestra (positivo) y supera la tolerancia del courier.
    const difCosto = difEval(e, isFirst, e.costo_facturado, e.compra_estimada ?? e.compra_total, 'costo');
    const difPeso = difEval(e, isFirst, e.peso_facturado, e.peso_facturable, 'peso');

    tr.innerHTML = `
      <td class="chk-cell">${chkCell}</td>
      <td data-col="numero_salida" class="numsal-cell" title="Marcar fila">${fmtNum(e.num_sal_mes)}</td>
      <td data-col="courier">${env(courierBadge(e.courier))}</td>
      <td data-col="fecha">${env(NovaUtils.formatDate(e.fecha))}</td>
      <td class="mono${guiaMalaAttrs(e.courier, bultoGuia)}" data-col="numero_guia"><span class="bulto-guia-text">${esc(bultoGuia)}</span>${bultoGuiaEdit}${guiaIcons}</td>
      <td data-col="tipo_cobro">${env(cobroBadge(e.tipo_cobro))}</td>
      <td data-col="cliente_nombre">${env(`<a href="clientes-perfil.html?id=${e.cliente_id}">${esc(e.cliente_nombre)}</a>`)}</td>
      <td data-col="destino">${env(esc(e.destino))}</td>
      <td>${estadoCajaDotHtml(b.estado_caja, e)}${numBulto}/${totalBultos}</td>
      <td>${env(tipoBadge(e.tipo_paquete))}</td>
      <td>${env(dirBadge(e.direccion))}</td>
      <td class="num">${fmtDim(largo)}</td>
      <td class="num">${fmtDim(ancho)}</td>
      <td class="num">${fmtDim(alto)}</td>
      <td class="num">${fmtKg(pesoReal)}</td>
      <td class="num">${fmtKg(pesoVol)}</td>
      <td class="num${sinPesarEnvio(e) ? ' cell-sin-pesar' : ''}" data-col="peso_facturable">${env(pesoFacturableCellHtml(e))}</td>
      <td class="num">${env(fmtUSD(e.valor_declarado))}</td>
      <td>${env(e.asegurado ? 'Sí' : 'No')}</td>
      <td class="num venta-total-cell${ventaExp ? ' detail-expandable' : ''}"${ventaExp ? ` data-detail-envio="${e.id}"` : ''} data-col="total">${ventaTotalCellHtml(e, isFirst)}</td>
      <td class="num" data-col="flete">${env(fmtUSD(e.flete))}</td>
      <td class="num" data-col="descuento">${env(fmtUSD(e.descuento))}</td>
      <td class="num" data-col="seguro">${env(fmtUSD(e.seguro))}</td>
      <td class="num" data-col="fuel">${env(fmtUSD(e.fuel))}</td>
      <td class="num" data-col="derechos">${env(fmtUSD(e.derechos))}</td>
      <td class="num adic-cell${adicExp ? ' adic-expandable detail-expandable' : ''}"${adicExp ? ` data-detail-envio="${e.id}"` : ''}>${adicCellHtml(e, isFirst)}</td>
      <td class="num" data-col="otros">${env(fmtUSD(e.otros))}</td>
      <td class="num${isRevisionPendiente(e, isFirst) ? ' cell-compra-pendiente' : ''}" data-col="compra_total">${env(fmtUSD(e.compra_estimada ?? e.compra_total))}</td>
      <td class="num" data-col="profit">${env(profitCell(e))}</td>
      <td class="num" data-col="porcentaje">${env(pctCell(e))}</td>
      <td class="num ups-col" data-col="costo_ups">${costoUpsCellHtml(e, isFirst)}</td>
      <td class="num ups-col${difCosto.rojo ? ' cell-desvio-rojo' : ''}" data-col="dif_costo">${difCosto.html}</td>
      <td class="num ups-col" data-col="profit_real">${profitRealCellHtml(e, isFirst)}</td>
      <td class="num ups-col" data-col="peso_ups">${pesoUpsCellHtml(e, isFirst)}</td>
      <td class="num ups-col${difPeso.rojo ? ' cell-desvio-rojo' : ''}" data-col="dif_peso">${difPeso.html}</td>
      <td class="revision-cell ups-col">${revisionCellHtml(e, isFirst)}</td>
      <td>${env(estadoBadge(e, today))}</td>
      <td class="obs-cell" title="${isFirst ? escAttr(e.observaciones) : ''}">${obsCell(e.observaciones, isFirst)}</td>
    `;

    return tr;
  }

  // ¿Este envío está SIN PESAR? Son los que se cargan el día que salen para clientes cuyos
  // paquetes no pasan por el depósito (Kasdorf y parecidos): los pesos reales llegan días
  // después. Peso facturable en 0 es el marcador; el backend deja el costo en blanco hasta
  // que se pesen, así que no hay que confundirlos con un envío de costo cero.
  function sinPesarEnvio(e) {
    return !(Number(e.peso_facturable) > 0);
  }

  // Celda de peso facturable: "sin pesar" en vez de "0.0 kg", que se lee como si pesara cero.
  function pesoFacturableCellHtml(e) {
    if (sinPesarEnvio(e)) return '<span class="badge-sin-pesar">sin pesar</span>';
    return fmtKg(e.peso_facturable);
  }

  // Celda "Adic": monto + un ▸ clickeable SOLO en la fila principal (isFirst) y solo si
  // el envío tiene desglose (e.extras). En las filas de bulto o sin extras queda como hoy.
  // El ▸ es un <button> propio (no un input) para no disparar shouldYieldGridNav.
  function adicCellHtml(e, isFirst) {
    if (!(isFirst && e.extras && e.extras.length)) return isFirst ? fmtUSD(e.adicionales) : '';
    const open = expandedExtras.has(e.id) ? ' open' : '';
    return `${fmtUSD(e.adicionales)}<button class="extras-toggle${open}" data-envio-id="${e.id}" `
      + `title="Ver desglose de adicionales" aria-label="Ver desglose de adicionales">▸</button>`;
  }

  // Celda "Venta Total": monto + un ▸ clickeable SOLO en la fila principal (isFirst) y solo
  // si el envío tiene venta cargada (venta_desglose != null). Abre la MISMA sub-fila de
  // detalle que Adic. Sin venta → solo el monto (como una celda normal, sin ▸).
  function ventaTotalCellHtml(e, isFirst) {
    if (!isFirst) return '';
    if (!e.venta_desglose) return fmtUSD(e.total);
    const open = expandedExtras.has(e.id) ? ' open' : '';
    return `${fmtUSD(e.total)}<button class="extras-toggle${open}" data-envio-id="${e.id}" `
      + `title="Ver desglose de venta" aria-label="Ver desglose de venta">▸</button>`;
  }

  // ── Columnas de comparación contra la factura del courier (UPS) ──────────────
  // Muestran SOLO lo que facturó el courier y los desvíos contra lo nuestro; no repiten
  // venta ni peso propios (ya están en la fila). "Sin factura" = costo_facturado null → las
  // cuatro celdas van con un guión, sin semáforo ni cuentas. En sub-filas de bulto van en
  // blanco (dato de envío, no de bulto), igual que el resto de columnas del envío.

  // Celda "Costo UPS": lo que facturó el courier (e.costo_facturado).
  function costoUpsCellHtml(e, isFirst) {
    if (!isFirst) return '';
    if (e.costo_facturado == null) return '<span class="em">—</span>';
    return fmtUSD(e.costo_facturado);
  }

  // Celda "Peso UPS": el peso que facturó el courier (e.peso_facturado).
  function pesoUpsCellHtml(e, isFirst) {
    if (!isFirst) return '';
    if (e.costo_facturado == null) return '<span class="em">—</span>';
    return fmtKg(e.peso_facturado);
  }

  // Evalúa el desvío de una métrica facturada por el courier vs. la nuestra. Dos medidas:
  //   pct = (facturado − base) / base × 100      abs = facturado − base
  // Devuelve { html, rojo }. Semáforo ROJO solo si se cumplen LAS DOS condiciones:
  //   1. abs POSITIVO (el courier facturó de MÁS, va en contra nuestra). Si facturó de menos
  //      es a favor nuestro y no se pinta nunca, sin importar cuánto sea.
  //   2. Y además se supera AL MENOS UNO de los dos umbrales del courier: pct > tol.pct
  //      O abs > tol.abs (independientes: alcanza con uno). Atrapa el envío grande donde un
  //      desvío chico en % es mucha plata.
  // Dentro de tolerancia o desvío a favor → neutro. Nunca verde. Sin factura o base inválida
  // → guión neutro. La celda muestra siempre el %; el disparo absoluto solo cambia el color.
  function difEval(e, isFirst, facturado, base, tipo) {
    if (!isFirst) return { html: '', rojo: false };
    if (e.costo_facturado == null || facturado == null || base == null || base === 0) {
      return { html: '<span class="em">—</span>', rojo: false };
    }
    const pct = (facturado - base) / base * 100;
    const abs = facturado - base;
    const tol = (tolerancias[e.courier] || {})[tipo] || {};
    const superaPct = tol.pct != null && pct > tol.pct;
    const superaAbs = tol.abs != null && abs > tol.abs;
    const rojo = abs > 0 && (superaPct || superaAbs);
    const sign = pct > 0 ? '+' : '';
    return { html: `${sign}${pct.toFixed(1)}%`, rojo };
  }

  // ¿Hay algo para mostrar en la sub-fila de detalle? Venta (venta_desglose) y/o los
  // extracargos de compra (extras). Si no hay ninguno, la fila no es expandible.
  function detailHasContent(e) {
    return !!(e.venta_desglose || (e.extras && e.extras.length));
  }

  // Sub-fila de detalle: dos <td> (espaciador + contenido) SIN data-envio-id (queda fuera de
  // getDataRows() → no corre índices ni participa de la navegación por celdas). Muestra dos
  // bloques bien diferenciados: "Venta" (mini-liquidación: flete/fuel/seguro/adic/total, lo
  // que cobrás) y "Extracargos compra" (chips por tipo, lo que pagás). Cada bloque aparece
  // solo si tiene datos. El Σ de extras usa e.adicionales (no la suma cruda) para cuadrar
  // exacto con la columna aun cuando el redondeo desvíe la suma en ±0.01.
  function buildDetailRow(e) {
    const tr = document.createElement('tr');
    tr.className = 'extras-detail-row';
    tr.dataset.extrasFor = e.id;
    if (markedEnvios.has(e.id)) tr.classList.add('row-marked');

    const vd = e.venta_desglose;
    const ventaBlock = vd ? `
      <div class="detail-block detail-venta">
        <span class="detail-block-title">Venta</span>
        <div class="venta-desglose">
          <span class="venta-item"><span class="venta-label">Flete</span> <b>${fmtUSD(vd.flete)}</b></span>
          <span class="venta-item"><span class="venta-label">Fuel</span> <b>${fmtUSD(vd.fuel)}</b></span>
          <span class="venta-item"><span class="venta-label">Seguro</span> <b>${fmtUSD(vd.seguro)}</b></span>
          <span class="venta-item"><span class="venta-label">Adicionales</span> <b>${fmtUSD(vd.adicional)}</b></span>
          <span class="venta-item venta-item-total"><span class="venta-label">Total</span> <b>${fmtUSD(vd.total)}</b></span>
        </div>
      </div>` : '';

    const extras = e.extras || [];
    const chips = extras
      .map((x) => `<span class="extra-chip">${esc(x.label)} <b>${fmtUSD(x.monto)}</b></span>`)
      .join('');
    const extrasBlock = extras.length ? `
      <div class="detail-block detail-extras">
        <span class="detail-block-title">Extracargos compra</span>
        <div class="extras-breakdown">
          ${chips}
          <span class="extra-chip extra-chip-total">Σ <b>${fmtUSD(e.adicionales)}</b></span>
        </div>
      </div>` : '';

    // Espaciador de 19 columnas (checkbox … las 19 previas a "Venta Total") + celda de
    // contenido: el desglose arranca justo debajo de "Venta Total" y se extiende a la derecha
    // para comparar de un vistazo contra las columnas de plata. El espaciador (cols 0..18) NO
    // toca el bloque UPS (cols 30..34), así que sigue en 19 en ambos estados; la celda de
    // contenido cae de 18 a 13 cuando el bloque está plegado (detailContentColspan), para que
    // el colspan total cuadre con las columnas realmente visibles.
    tr.innerHTML = `<td colspan="19" class="detail-spacer"></td><td colspan="${detailContentColspan()}"><div class="detail-row-inner">${ventaBlock}${extrasBlock}</div></td>`;
    return tr;
  }

  // ── Auto 2: alertas de profit ────────────────────────────────────────────────
  // Retorna 'rojo' | 'ambar' | null
  function alertLevel(e) {
    // NO VOLO: el envio no salio, asi que su profit en cero o su falta de costo no son un
    // problema para revisar — son la consecuencia de que no exista la operacion.
    if (e.no_volo) return null;
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

  // Guía mal tipeada: se pinta la CELDA entera. Antes era un ícono chiquito al lado del
  // número y no llamaba la atención (pedido de Felipe, 29/07).
  //
  // Usa el dígito verificador del número (validar-guia.js): no consulta a UPS ni a DHL, así
  // que no depende de la red. Avisa, no bloquea: una guía con formato raro puede ser
  // legítima, por eso se pinta pero no se impide nada.
  function guiaMalaAttrs(courier, guia) {
    if (typeof validarGuia !== 'function') return '';
    const v = validarGuia(courier, guia);
    if (v.estado !== 'sospechosa') return '';
    return ` cell-guia-mala" title="Guía mal cargada: ${esc(v.motivo)}`;
  }

  function revisionIconHtml(e) {
    if (e.estado_revision === 'a_revisar') {
      return `<span class="alert-icon revision-flag" title="A revisar" style="color:#d97706">⚑</span>`;
    }
    if (e.estado_revision === 'reclamar') {
      return `<span class="alert-icon revision-flag" title="Reclamar" style="color:#dc2626">⚑</span>`;
    }
    return '';
  }

  // ── Columna "Revisión" (aprobar / mandar a revisar desde Salidas) ─────────────
  // Solo en la fila principal del envío (isFirst) y solo si ya hay factura cargada
  // (costo_facturado != null): sin factura → celda vacía, no hay nada que revisar.
  // La celda muestra UNA de dos cosas según el estado, para que cuando entren las
  // facturas de fin de mes se vea de un golpe qué guías faltan mirar (las únicas con
  // botonera) y lo ya decidido no compita por la atención:
  //   • 'pendiente' / null (con factura) → BOTONERA: ✓ verde + ✕ roja, ambas clickeables.
  //     Único caso que pide una decisión → el más visible.
  //   • 'revisado_ok' → ✓ verde chico estático (aprobado).
  //   • 'a_revisar'   → ✕ ámbar chico estático (mandado a revisar).
  //   • 'reclamar'    → ⚑ rojo chico estático (en reclamo; distinto de 'a_revisar').
  // Los tres marcadores estáticos son clickeables: devuelven a 'pendiente' (data-estado)
  // y vuelve a aparecer la botonera, para no encerrar al usuario si se equivocó. Comparten
  // la clase .btn-revision, así los guards de bindRowEdit / bindRevisionButtons los cubren.
  // ¿La guía está pendiente de revisión, i.e. la celda Revisión muestra la botonera ✓/✕?
  // ES LA MISMA condición que hace visible la botonera en revisionCellHtml (ver abajo: los
  // tres estados decididos salen por sus if; el único caso que llega a la botonera es este).
  // Fuente única para: mostrar botonera Y pintar de azul la Compra Total (mejora de foco).
  function isRevisionPendiente(e, isFirst) {
    if (!isFirst || e.costo_facturado == null) return false;
    const est = e.estado_revision;
    return est == null || est === 'pendiente';
  }

  function revisionCellHtml(e, isFirst) {
    if (!isFirst || e.costo_facturado == null) return '';
    const est = e.estado_revision;

    // Estados ya decididos → marcador estático chico, click vuelve a 'pendiente'.
    if (est === 'revisado_ok') {
      return staticRevisionHtml('revision-static-ok', '✓', 'Aprobado — click para volver a pendiente');
    }
    if (est === 'a_revisar') {
      return staticRevisionHtml('revision-static-rev', '✕', 'A revisar — click para volver a pendiente');
    }
    if (est === 'reclamar') {
      return staticRevisionHtml('revision-static-reclamar', '⚑', 'En reclamo — click para volver a pendiente');
    }

    // 'pendiente' / null → botonera completa: es la que pide la decisión (isRevisionPendiente).
    return `<div class="revision-btns">`
      + `<button class="btn-revision btn-revision-ok" data-estado="revisado_ok" `
      + `title="Aprobado — lo miré, está bien">✓</button>`
      + `<button class="btn-revision btn-revision-rev" data-estado="a_revisar" `
      + `title="A revisar — algo está mal">✕</button>`
      + `</div>`;
  }

  function staticRevisionHtml(cls, glyph, title) {
    return `<div class="revision-btns">`
      + `<button class="btn-revision revision-static ${cls}" data-estado="pendiente" `
      + `title="${title}">${glyph}</button>`
      + `</div>`;
  }

  // ── Auto 5: semáforo de antigüedad ──────────────────────────────────────────
  function estadoLabel(e, today) {
    if (e.no_volo) return 'NO VOLÓ';
    if (e.liquidado) return 'Liquidado';
    const dias = diffDias(e.fecha, today);
    if (dias >= DIAS_ALERTA_ROJO) return `Pendiente · ${dias}d`;
    return `Pendiente · ${dias}d`;
  }

  function estadoBadge(e, today) {
    if (e.no_volo) {
      const quien = e.no_volo_usuario ? ` — marcado por ${e.no_volo_usuario}` : '';
      const cuando = e.no_volo_en ? ` el ${String(e.no_volo_en).slice(0, 10).split('-').reverse().join('/')}` : '';
      return `<span class="badge badge-no-volo" title="Este envío no salió${quien}${cuando}. No cuenta en el dashboard ni en el cierre de mes.">NO VOLÓ</span>`;
    }
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

  // Base del semáforo de antigüedad. Con toISOString() (UTC) después de las 21:00
  // contaba un día de más y el semáforo se ponía rojo un día antes de los 15.
  function todayStr() {
    return NovaUtils.hoyLocal();
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
      // Los "sin numerar" (salida 0) van SIEMPRE arriba de todo, se ordene por la columna
      // que se ordene. Pedido de administración del 14/08: son los envíos que están a
      // medio resolver, y abajo de 200 filas no los ve nadie.
      const ca = a.num_sal_cero ? 0 : 1;
      const cb = b.num_sal_cero ? 0 : 1;
      if (ca !== cb) return ca - cb;
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
    // Si la columna tiene varios criterios (hoy Bulto), se abre en el que ya esté
    // aplicado; si no hay ninguno, en el primero.
    const alternativas = CRITERIOS[col];
    if (alternativas) {
      const aplicado = alternativas.find((a) => colFilters[a.col] && colFilters[a.col].size > 0);
      ddColumn = (aplicado || alternativas[0]).col;
    } else {
      ddColumn = col;
    }

    // Armar el contenido (criterios + lista de valores). Es lo mismo que hace falta al
    // cambiar de criterio con el menú ya abierto, así que vive en una sola función.
    redibujarDropdown(col);

    // Posicionar
    const rect = triggerBtn.getBoundingClientRect();
    dd.style.display = 'flex';
    dd.style.top = `${rect.bottom + window.scrollY + 2}px`;
    dd.style.left = `${rect.left + window.scrollX}px`;

    document.getElementById('dd-search-input').focus();
  }

  // Los botoncitos de criterio arriba del desplegable. `colBoton` es la columna de la
  // cabecera (la que abrió el menú); ddColumn es el criterio activo.
  function pintarCriterios(colBoton) {
    const cont = document.getElementById('dd-criterios');
    if (!cont) return;
    const alternativas = CRITERIOS[colBoton];
    if (!alternativas) {
      cont.classList.add('hidden');
      cont.innerHTML = '';
      return;
    }
    cont.classList.remove('hidden');
    cont.innerHTML = alternativas.map((a) => `
      <button type="button" data-criterio="${a.col}" class="${a.col === ddColumn ? 'active' : ''}">
        ${esc(a.label)}${colFilters[a.col] && colFilters[a.col].size > 0 ? ' •' : ''}
      </button>`).join('');
    cont.querySelectorAll('button[data-criterio]').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // Cambiar de criterio NO borra el otro filtro: son independientes y se pueden
        // combinar (bulto n° 1 de los envíos de 3 cajas, por ejemplo).
        ddColumn = b.dataset.criterio;
        redibujarDropdown(colBoton);
      });
    });
  }

  // Vuelve a armar la lista de valores del desplegable para el criterio activo, sin
  // moverlo de lugar (el usuario ya lo tiene abierto donde lo abrió).
  function redibujarDropdown(colBoton) {
    const today = todayStr();
    pintarCriterios(colBoton);
    // El criterio activo se excluye de los filtros al armar su propia lista (para que
    // ofrezca TODOS sus valores), pero los demás — incluidos los otros de renglón — sí
    // recortan.
    const sinActivo = { ...colFilters, [ddColumn]: null };
    const dataForDD = allData.filter((e) => {
      for (const [c, vals] of Object.entries(sinActivo)) {
        if (!vals || vals.size === 0) continue;
        if (FILTROS_DE_BULTO.has(c)) continue;
        if (!vals.has(String(resolveCell(e, c, today)))) return false;
      }
      return bultosVisibles(e, sinActivo).length > 0;
    });
    const uniqueVals = valoresDeColumna(dataForDD, ddColumn, today);
    ddTempSelected = new Set(colFilters[ddColumn] || []);
    buildDropdownList(uniqueVals, ddTempSelected);
    const inp = document.getElementById('dd-search-input');
    if (inp) inp.value = '';
  }

  // Los valores únicos que ofrece una columna. El número de bulto no sale del envío sino
  // de sus bultos, así que tiene su propio camino.
  function valoresDeColumna(envios, col, today) {
    let vals;
    if (col === 'numero_bulto') {
      const set = new Set();
      for (const e of envios) {
        const lista = (e.bultos && e.bultos.length) ? e.bultos : [null];
        lista.forEach((b, i) => set.add(String((b && b.numero_bulto) ?? (i + 1))));
      }
      vals = [...set];
    } else if (col === 'estado_semaforo') {
      const set = new Set();
      for (const e of envios) {
        const lista = (e.bultos && e.bultos.length) ? e.bultos : [null];
        lista.forEach((b) => set.add(semaforoDeBulto(b)));
      }
      // Orden del semáforo, no alfabético: rojo (lo urgente) arriba.
      return Object.values(SEMAFORO_LABEL).filter((l) => set.has(l));
    } else {
      vals = [...new Set(envios.map((e) => String(resolveCell(e, col, today))))];
    }
    // Orden numérico cuando todos los valores son números (#Sal, bultos); si no,
    // alfabético. Sin esto el desplegable ordenaba "10" antes que "2".
    const todosNumericos = vals.every((v) => v !== '' && !Number.isNaN(Number(v)));
    return vals.sort(todosNumericos ? (a, b) => Number(a) - Number(b) : undefined);
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

  // Prende/apaga el ▼ de la cabecera. Ojo con las columnas de varios criterios: el botón
  // de Bulto lleva data-filter="numero_bulto", así que al aplicar "cantidad_bultos" hay
  // que encontrarlo igual, y queda encendido si CUALQUIERA de sus dos criterios está puesto.
  function updateFilterBtnState(col) {
    let botonCol = col;
    for (const [base, alts] of Object.entries(CRITERIOS)) {
      if (alts.some((a) => a.col === col)) { botonCol = base; break; }
    }
    const btn = document.querySelector(`.filter-btn[data-filter="${botonCol}"]`);
    if (!btn) return;
    const cols = CRITERIOS[botonCol] ? CRITERIOS[botonCol].map((a) => a.col) : [botonCol];
    btn.classList.toggle('active', cols.some((c) => colFilters[c] && colFilters[c].size > 0));
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
      fecha: 'Fecha', numero_salida: '#Sal', asegurado: 'Aseg',
      cantidad_bultos: 'Cant. bultos', numero_bulto: 'Bulto n°', revision: 'Revisión',
      estado_semaforo: 'Semáforo',
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

    // "1º bulto" es de RENDER, no de filtro: la lista filtrada no cambia, así que
    // alcanza con re-dibujar. El contador de envíos tampoco cambia (cuenta envíos).
    const btnPB = document.getElementById('btn-primer-bulto');
    if (btnPB) btnPB.addEventListener('click', () => {
      soloPrimerBulto = !soloPrimerBulto;
      btnPB.classList.toggle('active', soloPrimerBulto);
      renderPage();
    });

    // "Limpiar filtros" (31/08): un golpe y la tabla queda "como la usamos siempre" —
    // sin filtros de columna, sin búsqueda, sin toggles, ordenada por número de salida
    // de MAYOR a menor. La solapa de mes NO se toca: el mes no es un filtro, es el
    // período que se está mirando.
    const btnLimpiar = document.getElementById('btn-limpiar-filtros');
    if (btnLimpiar) btnLimpiar.addEventListener('click', () => {
      for (const c of Object.keys(colFilters)) delete colFilters[c];
      document.querySelectorAll('.filter-btn.active').forEach((b) => b.classList.remove('active'));
      searchTerm = '';
      const inp = document.getElementById('buscador');
      if (inp) inp.value = '';
      const clearBtn = document.getElementById('btn-clear-search');
      if (clearBtn) clearBtn.classList.remove('visible');
      soloAlertas = false;
      const bA = document.getElementById('btn-solo-alertas');
      if (bA) bA.classList.remove('active');
      soloPrimerBulto = false;
      btnPB.classList.remove('active');
      // El orden de siempre: # de salida descendente (los "sin numerar" quedan arriba
      // igual: sortData los prioriza se ordene por lo que se ordene).
      sortCol = 'numero_salida';
      sortDir = 'desc';
      document.querySelectorAll('.salidas-table th').forEach((t) => t.classList.remove('sort-asc', 'sort-desc'));
      const th = document.querySelector('.salidas-table th[data-col="numero_salida"]');
      if (th) th.classList.add('sort-desc');
      sortData();
      applyAll();
    });
  }

  // ── Auto 6: bajar la planilla ────────────────────────────────────────────────
  function bindExport() {
    bindCierre();
  }

  // ── Cierre de período ────────────────────────────────────────────────────────
  // Baja el período COMPLETO (mes o semana), lo arma el servidor y queda asentado que se
  // hizo. Es el respaldo que administración archiva fuera del sistema.
  //
  // Acá había antes un botón "Exportar Excel" que bajaba lo que hubiera quedado filtrado
  // en pantalla, armado en el navegador con una librería traída de un CDN. Se sacó el
  // 06/08/2026 por pedido de Felipe ("nunca lo usamos"), y por una razón de fondo: dos
  // botones parecidos al lado del respaldo del mes invitan al error caro, que es bajar
  // una planilla FILTRADA creyendo que se archivó el mes entero. Un archivo incompleto se
  // ve igual que uno completo hasta el día que hace falta.
  //
  // De paso, Salidas dejó de pedirle nada a internet: el <script> del CDN se fue con él.
  //
  // Si algún día hace falta bajar "lo que estoy viendo" (filtrado por cliente, o solo las
  // filas con alerta), se agrega de nuevo pero adentro de la barra de filtros y con ese
  // nombre — no al lado del cierre.
  function bindCierre() {
    const caja = document.querySelector('.cierre-box');
    if (!caja) return;

    // El mes por defecto es el ANTERIOR durante los primeros 5 días, y el actual después.
    // Es el momento en que se cierra: el 1 o el 2 nadie quiere archivar el mes que recién
    // empieza, quiere el que terminó.
    const hoy = new Date();
    const ref = new Date(hoy);
    if (hoy.getDate() <= 5) ref.setMonth(ref.getMonth() - 1);
    const inputMes = document.getElementById('cierre-mes');
    inputMes.value = `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, '0')}`;

    document.getElementById('btn-cierre-mes').addEventListener('click', () => {
      const mes = inputMes.value;
      if (!/^\d{4}-\d{2}$/.test(mes)) {
        NovaUtils.showAlert(alertBox, 'Elegí un mes para cerrar', 'error');
        return;
      }
      bajarCierre(`tipo=mes&mes=${mes}`, `el mes ${mes}`);
    });

    document.getElementById('btn-cierre-semana').addEventListener('click', () => {
      bajarCierre('tipo=semana', 'la semana');
    });

    refrescarUltimoCierre();
  }

  // La descarga va por fetch y no por un link directo para poder leer el resultado: si el
  // período salió vacío hay que decirlo, porque un Excel sin filas se archiva igual y
  // nadie se entera hasta que lo necesita.
  async function bajarCierre(query, comoSeLlama) {
    const botones = document.querySelectorAll('#btn-cierre-mes, #btn-cierre-semana');
    botones.forEach((b) => { b.disabled = true; });
    try {
      const r = await fetch(`/api/salidas/exportar?${query}`, { credentials: 'same-origin' });
      if (!r.ok) {
        let msg = `No se pudo generar el cierre de ${comoSeLlama}`;
        if (r.status === 403) msg = 'No tenés permiso para hacer el cierre de período';
        else {
          try { const j = await r.json(); if (j && j.error) msg = j.error; } catch { /* no era JSON */ }
        }
        NovaUtils.showAlert(alertBox, msg, 'error');
        return;
      }

      const filas = Number(r.headers.get('X-Nova-Filas') || 0);
      const nombre = nombreDeContentDisposition(r.headers.get('Content-Disposition'))
        || 'Nova-salidas.xlsx';
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = nombre;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      if (filas === 0) {
        NovaUtils.showAlert(alertBox,
          `El cierre de ${comoSeLlama} salió SIN envíos. Revisá que el período sea el correcto.`,
          'error');
      } else {
        NovaUtils.showAlert(alertBox,
          `Cierre de ${comoSeLlama} descargado: ${filas} envío(s). Guardalo en la carpeta de respaldos.`,
          'success');
      }
      refrescarUltimoCierre();
    } catch (e) {
      NovaUtils.showAlert(alertBox, 'No se pudo generar el cierre: ' + e.message, 'error');
    } finally {
      botones.forEach((b) => { b.disabled = false; });
    }
  }

  function nombreDeContentDisposition(cd) {
    if (!cd) return null;
    const m = /filename="?([^"]+)"?/.exec(cd);
    return m ? m[1] : null;
  }

  // Muestra de cuándo es el último cierre. Si hace más de 40 días que nadie cierra, se
  // pinta en ámbar. Es el mismo dato que mira el panel de salud, acá al lado del botón.
  async function refrescarUltimoCierre() {
    const span = document.getElementById('cierre-ultimo');
    if (!span) return;
    try {
      const lista = await NovaAPI.get('/salidas/cierres');
      const ultimo = (lista || []).find((c) => c.tipo === 'mes') || (lista || [])[0];
      if (!ultimo) {
        span.textContent = 'nunca se cerró un período';
        span.classList.add('atrasado');
        return;
      }
      const dias = Math.round((Date.now() - new Date(ultimo.creado_en).getTime()) / 86400000);
      span.textContent = `último: ${ultimo.desde.slice(0, 7)} (${ultimo.filas} envíos)`;
      span.classList.toggle('atrasado', dias > 40);
    } catch {
      span.textContent = '';
    }
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
  let floatResizeObserver = null;
  let floatRefreshQueued = false;

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
    // Re-medir cuando el layout se asiente DESPUÉS del primer pintado: las fuentes cambian la
    // altura de las filas y algo tardío ('load') puede correr la tabla. Sin esto, la única
    // corrección era el resize manual de la ventana ("achicar y agrandar").
    window.addEventListener('load', scheduleFloatingRefresh);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(scheduleFloatingRefresh).catch(() => {});
    }

    // Si el layout de ARRIBA cambia luego (aparecen las solapas de meses o los chips de
    // filtro), el tope del wrap se corre y la medición previa queda mal. Un ResizeObserver
    // sobre el wrap y su .card rehace la medición solo, sin depender de que el usuario
    // redimensione la ventana. El guard de idempotencia de refreshTableHeight corta el lazo
    // de realimentación (fijar el max-height cambia el tamaño del wrap → dispararía el RO).
    if ('ResizeObserver' in window) {
      floatResizeObserver = new ResizeObserver(() => scheduleFloatingRefresh());
      floatResizeObserver.observe(wrap);
      const card = wrap.closest('.card');
      if (card && card !== wrap) floatResizeObserver.observe(card);
    }

    // Primera medición: en rAF anidado, NO síncrona. Medir acá mismo (tabla vacía, solapas y
    // chips aún sin pintar, fuentes sin cargar) daba un tope equivocado, y de ahí los dos
    // bugs: la barra flotante no aparecía y las últimas filas quedaban inalcanzables.
    scheduleFloatingRefresh();
  }

  function onFloatingScroll() {
    if (floatRaf) return;
    floatRaf = requestAnimationFrame(() => {
      floatRaf = 0;
      updateFloatingVisibility();
    });
  }

  // Corre refreshFloatingScrollbar recién cuando el layout ya se pintó (rAF anidado): un solo
  // rAF puede caer antes de que el navegador reflote tras un cambio de DOM; el segundo asegura
  // medir sobre geometría real. Coalesce llamadas seguidas (RO/fonts/load pueden dispararse
  // juntas) para no encadenar varias pasadas.
  function scheduleFloatingRefresh() {
    if (floatRefreshQueued) return;
    floatRefreshQueued = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      floatRefreshQueued = false;
      refreshFloatingScrollbar();
    }));
  }

  // Fija el max-height del wrapper para que scrollee ÉL (y el thead quede sticky arriba) en
  // vez de la página. Mide el tope real del wrapper en el viewport y descuenta, así el fondo
  // de la tabla llega justo al borde inferior sin dejar hueco ni cortarse, aunque cambien las
  // solapas de meses o aparezcan chips de filtro. Deja un colchón abajo para la barra flotante
  // / el borde. El CSS trae un calc de respaldo para el primer pintado antes de correr esto.
  function refreshTableHeight() {
    const wrap = document.getElementById('table-wrap');
    if (!wrap) return;
    const top = wrap.getBoundingClientRect().top;
    const viewH = window.innerHeight || document.documentElement.clientHeight;
    // Colchón inferior: hay que cubrir el padding-bottom de .page-body (4px) + .card (4px) que
    // viven debajo del wrap dentro de page-content (100vh, overflow:hidden); si el wrap + esos
    // paddings pasan de 100vh se clipea el fondo del wrap y con él su barra de scroll horizontal.
    // Al fijar el alto en viewH - top - GAP, el borde inferior del wrap queda pinneado a GAP px
    // del fondo del viewport: nunca desborda, así ninguna fila queda inalcanzable (la página no
    // scrollea) y la barra nativa del wrap no se corta. 8px de paddings + ~2px de aire = 10.
    // El piso de 200px es para viewports muy bajos.
    const BOTTOM_GAP = 10;
    const h = Math.max(200, viewH - top - BOTTOM_GAP);
    const next = `${h}px`;
    // Solo escribir si cambió: fijar el max-height altera el tamaño del wrap y volvería a
    // disparar el ResizeObserver; sin este guard el lazo no convergería.
    if (wrap.style.maxHeight !== next) wrap.style.maxHeight = next;
  }

  // Recalcula la geometría: ancho del fantasma = recorrido real del wrap; posición y ancho
  // de la barra = área visible del wrap. Llamar cuando cambie scrollWidth de la tabla
  // (renderPage, cambio de columnas sticky, resize de ventana). Ajusta primero la altura del
  // wrapper: al aparecer/desaparecer su scroll vertical cambia el clientWidth que se mide acá.
  function refreshFloatingScrollbar() {
    refreshTableHeight();
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
  // El camioncito lleva DERECHO a la página de UPS (pedido de la oficina, 24/08/2026).
  // Antes abría un recuadro con lo que devuelve la API de UPS, pero la página es más
  // completa y más fácil de leer, así que el recuadro se retiró. El endpoint
  // /api/tracking/ups sigue existiendo por si otra pantalla lo necesita.
  function trackBtnHtml(guia) {
    return `<button class="track-btn" data-guia="${esc(guia)}" title="Ver el tracking en la página de UPS">🚚</button>`;
  }

  function bindTracking() {
    document.getElementById('salidas-body').addEventListener('click', (e) => {
      const btn = e.target.closest('.track-btn');
      if (!btn) return;
      e.stopPropagation();
      // loc=es_AR para que UPS la muestre en castellano.
      const url = `https://www.ups.com/track?loc=es_AR&tracknum=${encodeURIComponent(btn.dataset.guia)}`;
      window.open(url, '_blank', 'noopener');
    });
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

  // La columna Profit muestra SIEMPRE el estimado nuestro (venta − compra estimada),
  // sin importar el estado de revisión. El real vive en su propia columna (Profit Real).
  // Antes esta celda cambiaba de fórmula sola al aprobar la revisión y la oficina lo
  // leía como "me sobrescribió el profit" (31/08).
  function profitCell(e) {
    const v = e.profit_estimado ?? e.profit;
    if (v == null) return '<span class="em">—</span>';
    const color = v < 0 ? '#dc2626' : v === 0 ? '#d97706' : '#15803d';
    return `<span style="color:${color}" title="Estimado por nosotros: venta − compra estimada">$${Number(v).toFixed(2)}</span>`;
  }

  // Profit contra la factura REAL del courier (venta − Costo UPS). Aparece apenas se
  // cruza la factura, sin esperar el tilde de Revisión (es informativo). Solo en el
  // primer renglón del envío, como el resto del bloque UPS.
  function profitRealCellHtml(e, isFirst) {
    if (!isFirst) return '<span class="em">—</span>';
    if (e.profit_real_monto == null) return '<span class="em">—</span>';
    const v = e.profit_real_monto;
    const color = v < 0 ? '#dc2626' : v === 0 ? '#d97706' : '#15803d';
    const pct = e.porcentaje_real != null ? ` (${e.porcentaje_real}%)` : '';
    const aprobada = e.estado_revision === 'revisado_ok';
    const title = `Venta − Costo UPS facturado${pct}` + (aprobada ? '' : ' · la factura aún no está aprobada en Revisión');
    return `<span style="color:${color}" title="${escAttr(title)}">$${Number(v).toFixed(2)}</span>`;
  }

  function pctCell(e) {
    const v = e.porcentaje_estimado ?? e.porcentaje;
    if (v == null) return '<span class="em">—</span>';
    return `${Number(v).toFixed(1)}%`;
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
  // Si el semáforo automático ya miró este envío (envios.tracking_*), el tooltip cuenta
  // qué dijo UPS y cuándo se consultó — así un estado viejo o un error de rastreo nunca
  // se disfraza de dato fresco.
  function estadoCajaDotHtml(estado, envio) {
    const info = ESTADO_CAJA_INFO[estado] || ESTADO_CAJA_INFO.rojo;
    let title = info.label;
    if (envio && (envio.tracking_detalle || envio.tracking_fecha)) {
      const partes = [info.label];
      if (envio.tracking_detalle) partes.push('UPS: ' + envio.tracking_detalle);
      if (envio.tracking_fecha) partes.push('consultado ' + envio.tracking_fecha);
      title = partes.join('\n');
    }
    return `<span class="bulto-estado-dot ${info.cls}" title="${esc(title)}"></span>`;
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
          <div id="saled-no-volo-note" class="saled-no-volo-note hidden"></div>
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
                <label>Fecha *</label>
                <input type="date" id="saled-fecha">
              </div>
              <div class="form-group" style="grid-column:span 2">
                <label>Cliente *</label>
                <select id="saled-cliente"></select>
              </div>
              <div class="form-group">
                <label>Courier *</label>
                <select id="saled-courier">
                  <option value="DHL">DHL</option>
                  <option value="UPS">UPS</option>
                </select>
              </div>
              <div class="form-group" style="grid-column:span 2">
                <label>País destino *</label>
                <select id="saled-pais-destino"></select>
              </div>
              <div class="form-group" style="justify-content:flex-end;padding-bottom:2px">
                <label>&nbsp;</label>
                <label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:13px">
                  <input type="checkbox" id="saled-sin-numerar" style="width:auto;margin:0">
                  Envío sin numerar
                </label>
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
              <!-- Valor declarado (fob): editable desde el 14/08 a pedido de administración.
                   El seguro sale de él, así que después de cambiarlo hay que Recalcular. -->
              <div class="form-group">
                <label>Valor declarado (USD)</label>
                <input type="number" id="saled-fob" step="0.01" min="0">
              </div>
              <div class="form-group" style="justify-content:flex-end;padding-bottom:2px">
                <label>&nbsp;</label>
                <label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:13px">
                  <input type="checkbox" id="saled-asegurado" style="width:auto;margin:0">
                  Asegurado
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:13px">
                  Zona
                  <select id="saled-entrega" style="width:auto;margin:0;padding:2px 4px;font-size:12px">
                    <option value="normal">Normal</option>
                    <option value="extendida">Extendida</option>
                    <option value="remota">Remota</option>
                  </select>
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:13px">
                  <input type="checkbox" id="saled-ddp" style="width:auto;margin:0">
                  DDP
                </label>
                <!-- Proteccion de Documentos de DHL: USD 7,50 por envio, a pedido. Se
                     esconde en UPS porque es un servicio que solo existe en DHL. -->
                <label id="saled-prot-doc-label" style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:13px" title="Protección de documentos de DHL — USD 7,50 por envío">
                  <input type="checkbox" id="saled-proteccion-doc" style="width:auto;margin:0">
                  Prot. doc.
                </label>
              </div>
            </div>
            <div id="saled-lock-note" class="alert alert-info hidden" style="margin-top:8px">
              Este envío está liquidado: no se puede cambiar la fecha ni el cliente (afectaría una liquidación confirmada). El resto de los campos sí se pueden editar.
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
            <!-- Calcular venta: para los envios que se cargan sin pesar (Kasdorf y
                 parecidos). Recalcular trae el COSTO; este trae lo que hay que COBRARLE,
                 usando el profit ya cargado del cliente. -->
            <div class="saled-recalc-bar">
              <button type="button" class="btn btn-secondary" id="saled-calcular-venta">Calcular venta</button>
              <span id="saled-venta-status" class="saled-recalc-status"></span>
            </div>
            <!-- Aviso de venta desfasada: aparece solo cuando Recalcular dejo el precio
                 calculado para el peso anterior. Va ARRIBA del panel de venta a proposito:
                 es lo primero que tiene que leer quien acaba de cambiar el peso. -->
            <div id="saled-venta-aviso" class="saled-venta-aviso hidden"></div>
            <div id="saled-venta-panel" class="saled-venta-panel hidden"></div>
          </div>
          <div id="saled-costos-block">
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
            <!-- LAS COTIZACIONES DE ESTE CLIENTE. Arranca oculto y aparece SOLO cuando
                 alguien se para en "Total cobrado" (pedido de Felipe, 25/08: "que no
                 moleste, tal vez que solo aparezca en el caso que esten editando el
                 precio de venta"). El precio que trae es un SUGERIDO. -->
            <div id="saled-ctzr" class="saled-ctzr hidden">
              <div class="saled-ctzr-tit">Cotizaciones de este cliente — últimos 30 días</div>
              <div id="saled-ctzr-panel"></div>
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
          <button class="btn btn-no-volo" id="sal-modal-no-volo">NO VOLÓ</button>
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
    document.getElementById('sal-modal-no-volo').addEventListener('click', toggleNoVolo);
    document.getElementById('saled-recalcular').addEventListener('click', recalcularDesglose);
    document.getElementById('saled-calcular-venta').addEventListener('click', calcularVenta);
    document.getElementById('saled-courier').addEventListener('change', () => toggleProtDocVisible(true));
    document.getElementById('saled-tipo-paquete').addEventListener('change', () => toggleProtDocVisible(true));
    document.getElementById('saled-estado-caja').addEventListener('click', onEstadoCajaClick);

    // Profit/% se re-derivan en vivo: total cobrado fijo − suma de costos. Aplica tanto
    // al editar un costo a mano como tras Recalcular (que también repuebla estos campos).
    for (const f of ['flete', 'descuento', 'seguro', 'fuel', 'derechos', 'adicionales', 'otros', 'total']) {
      document.getElementById(`saled-${f}`).addEventListener('input', recalcProfit);
    }

    // El cartelito de desfase se re-evalúa en vivo cada vez que se edita Adicionales a mano.
    document.getElementById('saled-adicionales').addEventListener('input', updateExtrasWarn);

    // Pararse en el precio de venta abre las cotizaciones de ese cliente. No se abre solo
    // al abrir el envío: la mayoría de las veces no hace falta y sería ruido en un modal
    // que ya está lleno.
    document.getElementById('saled-total').addEventListener('focus', abrirCotizacionesDelCliente);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('sal-edit-overlay').classList.contains('hidden')) {
        closeEditModal();
      }
    });
  }

  // Llena el select de clientes del modal y preselecciona el del envío. El nombre visible
  // sigue el mismo criterio que la tabla: nombre_nova si existe, si no el nombre común.
  function fillClienteSelect(selectedId) {
    const sel = document.getElementById('saled-cliente');
    if (!sel) return;
    sel.innerHTML = '';
    for (const c of clientes) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.nombre_nova || c.nombre;
      sel.appendChild(opt);
    }
    if (selectedId != null) sel.value = String(selectedId);
  }

  // Llena el select de países con la lista canónica: unión de las claves de las 3 tablas
  // de zonas del cotizador (DHL, UPS export, UPS import), ordenada alfabéticamente. Es un
  // SELECT y no texto libre a propósito: escribir un país que no matchea las tablas deja
  // el envío con una zona equivocada en silencio (nos pasó con "Gran Bretaña" vs "Reino
  // Unido"). Si el país actual del envío NO está en la lista (envío viejo mal cargado),
  // lo agregamos marcado como "no reconocido" para que el usuario lo vea y lo corrija, en
  // vez de que el select lo reemplace por otro sin avisar.
  function fillPaisSelect(selectedPais) {
    const sel = document.getElementById('saled-pais-destino');
    if (!sel) return;
    const paises = (typeof ZONAS_DHL !== 'undefined')
      ? [...new Set([
          ...Object.keys(ZONAS_DHL),
          ...Object.keys(ZONAS_UPS),
          ...Object.keys(ZONAS_UPS_I),
        ])].sort()
      : [];
    sel.innerHTML = '';
    if (selectedPais && !paises.includes(selectedPais)) {
      const opt = document.createElement('option');
      opt.value = selectedPais;
      opt.textContent = `${selectedPais} (no reconocido)`;
      sel.appendChild(opt);
    }
    for (const p of paises) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      sel.appendChild(opt);
    }
    if (selectedPais) sel.value = selectedPais;
  }

  function openEditModal(envio, focusCol) {
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
    document.getElementById('saled-entrega').value = envio.entrega || (envio.remota ? 'extendida' : 'normal');
    document.getElementById('saled-ddp').checked = Boolean(envio.ddp);
    document.getElementById('saled-proteccion-doc').checked = Boolean(envio.proteccion_doc);

    // Identidad editable: fecha, cliente, courier, país destino y "sin numerar".
    document.getElementById('saled-fecha').value = envio.fecha || '';
    fillClienteSelect(envio.cliente_id);
    document.getElementById('saled-courier').value = envio.courier || 'DHL';
    // Recién acá: la visibilidad de la protección de documentos mira el courier Y el tipo
    // de paquete, así que tiene que correr después de que los dos estén cargados.
    toggleProtDocVisible(false);
    fillPaisSelect(envio.destino);
    document.getElementById('saled-sin-numerar').checked = Boolean(envio.num_sal_cero);
    // El fob viaja en la grilla como `valor_declarado` (el SELECT lo renombra).
    document.getElementById('saled-fob').value = envio.valor_declarado ?? '';

    // Envío liquidado: el backend congela fecha y cliente (responde 409 si cambian).
    // Deshabilitamos ambos campos y explicamos por qué, en vez de dejar que el usuario
    // los toque y choque contra el error. El resto de los campos sigue editable.
    const liquidado = Boolean(envio.liquidado);
    document.getElementById('saled-fecha').disabled = liquidado;
    document.getElementById('saled-cliente').disabled = liquidado;
    document.getElementById('saled-lock-note').classList.toggle('hidden', !liquidado);

    for (const f of ['flete', 'descuento', 'seguro', 'fuel', 'derechos', 'adicionales', 'otros', 'profit', 'porcentaje']) {
      document.getElementById(`saled-${f}`).value = envio[f] ?? '';
    }
    document.getElementById('saled-total').value = envio.total ?? '';
    // El aviso de venta desfasada es de la sesion de edicion, no del envio: al abrir otro
    // se limpia, si no arrastraria el cartel del anterior.
    ventaDesfasada = null;
    pintarAvisoVenta();
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
    // Cada envío arranca con el panel cerrado y sin nada pintado: si quedara lo del envío
    // anterior, alguien se llevaría el precio de otro cliente.
    cerrarCotizacionesDelCliente();
    sincronizarNoVolo(envio);
    document.getElementById('sal-edit-overlay').classList.remove('hidden');

    // Si el modal se abrió por click en una celda con campo asociado (mejora de foco),
    // llevar el ojo ahí: scroll dentro del modal + destello ámbar que se apaga solo a los 2s.
    // Sin campo asociado → abre normal, con el foco/selección en la guía como siempre.
    const focusEl = focusCol ? resolveModalFocusTarget(focusCol) : null;
    if (focusEl) {
      flashModalField(focusEl);
    } else {
      document.getElementById('saled-guia').focus();
      document.getElementById('saled-guia').select();
    }
  }

  // Mapa celda → campo del modal para la mejora de foco. Cada data-col de la fila apunta al
  // input (o bloque) que edita ese dato. Las columnas de comparación con UPS apuntan a NUESTRO
  // dato equivalente (contra el que se compara): Peso UPS / Dif Peso → peso facturable; Costo
  // UPS / Dif Costo → el bloque de Costos entero (la compra total es la suma de esos campos, no
  // un input único). Celdas que no figuran acá (total, cliente, compra_total, adic…) abren el
  // modal sin destello.
  const MODAL_FIELD_BY_COL = {
    peso_facturable: 'saled-peso-facturable',
    peso_ups:        'saled-peso-facturable',
    dif_peso:        'saled-peso-facturable',
    flete:      'saled-flete',
    descuento:  'saled-descuento',
    seguro:     'saled-seguro',
    fuel:       'saled-fuel',
    derechos:   'saled-derechos',
    otros:      'saled-otros',
    profit:     'saled-profit',
    porcentaje: 'saled-porcentaje',
    numero_guia: 'saled-guia',
    fecha:       'saled-fecha',
    destino:     'saled-pais-destino',
    courier:     'saled-courier',
    costo_ups: 'saled-costos-block',   // el bloque entero de Costos, no un input único
    dif_costo: 'saled-costos-block',
  };

  function resolveModalFocusTarget(col) {
    const id = MODAL_FIELD_BY_COL[col];
    return id ? document.getElementById(id) : null;
  }

  // Lleva el campo a la vista DENTRO del modal (sal-modal-body es el contenedor scrolleable) y
  // lo marca con un destello ámbar de 2s. Ámbar (no rojo): el campo no está mal, lo que está
  // mal es la diferencia. Reinicia la animación si ya estaba destellando (reflow forzado).
  function flashModalField(el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('field-flash');
    void el.offsetWidth;                 // fuerza reflow → reinicia la animación desde cero
    el.classList.add('field-flash');
    setTimeout(() => el.classList.remove('field-flash'), 2000);
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
    if (!warn) return;
    if (!editExtras.length) {
      warn.classList.add('hidden');
      return;
    }
    const rawAdic = document.getElementById('saled-adicionales').value;
    const adic = parseNum(rawAdic);
    const sum = extrasSum();
    const mismatch = Math.abs(adic - sum) > 0.01;
    warn.classList.toggle('hidden', !mismatch);
  }

  // Recalcula el desglose contra el motor (POST /salidas/:id/recalcular) con el peso/medidas
  // editados, repuebla flete/seguro/fuel/adicionales y los pesos de solo lectura, y re-deriva
  // profit/%. NO toca derechos/descuento/otros (esos no los calcula el motor).
  async function recalcularDesglose() {
    if (!editEnvio) return;
    const btn = document.getElementById('saled-recalcular');
    const status = document.getElementById('saled-recalc-status');

    // País y courier tal como el usuario los ve en el modal AHORA (aún sin guardar): el
    // backend recalcula con estos, no con los del envío original. Así Recalcular refleja el
    // cambio de país/courier antes del PATCH.
    const body = {
      asegurado: document.getElementById('saled-asegurado').checked ? 1 : 0,
      // Zona de entrega tal como está AHORA en el modal: el backend re-aplica el recargo
      // en el recálculo con este valor (si no se manda, se pierde el recargo guardado).
      entrega: document.getElementById('saled-entrega').value,
      remota: document.getElementById('saled-entrega').value !== 'normal' ? 1 : 0,
      // DDP tal como está tildado AHORA: sin esto el recálculo lo recibe undefined y el
      // cargo de 24.05 desaparece del desglose.
      ddp: document.getElementById('saled-ddp').checked ? 1 : 0,
      proteccion_doc: document.getElementById('saled-proteccion-doc').checked ? 1 : 0,
      pais_destino: document.getElementById('saled-pais-destino').value || null,
      courier: document.getElementById('saled-courier').value,
      // Valor declarado tal como está AHORA en el modal: el seguro del recálculo sale de él.
      fob: (() => {
        const v = document.getElementById('saled-fob').value;
        return v !== '' ? Number(v) : 0;
      })(),
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
      // Recalcular toca el COSTO. Si el envio ya tenia un precio de venta, ese precio se
      // calculo con el peso VIEJO y ahora quedo desfasado, sin que nada avise. Asi se
      // facturaba mal: cambias el peso, guardas, y el precio viejo queda. Lo encontro la
      // oficina el 07/08/2026 (un envio de 5 kg pasado a 50 kg seguia cobrando el de 5 kg,
      // USD 372 de menos). Se chequea ACA, apenas cambia el costo.
      await chequearVentaDesfasada();
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

  // ── Aviso de venta desfasada ────────────────────────────────────────────────
  // `ventaDesfasada` guarda el precio que corresponderia al peso actual, o null si el
  // precio cargado esta bien. Lo lee el guardado para pedir confirmacion: un cartel que
  // no frena nada se termina ignorando, y aca lo que se pierde es plata.
  let ventaDesfasada = null;

  async function chequearVentaDesfasada() {
    ventaDesfasada = null;
    pintarAvisoVenta();
    const totalRaw = document.getElementById('saled-total').value;
    const total = totalRaw === '' ? 0 : Number(totalRaw);
    // Sin venta cargada no hay nada que contradecir: el envio se completa despues.
    if (!(total > 0)) return;
    try {
      const body = armarBodyCotizacion();
      if (!body) return;
      const r = await NovaAPI.liquidaciones.cotizar(body);
      const sugerido = Number(r.precioFinal);
      if (!isFinite(sugerido) || sugerido <= 0) return;
      // Un centavo de redondeo no es un desfase. Se avisa desde un dolar de diferencia.
      if (Math.abs(sugerido - total) >= 1) {
        ventaDesfasada = { sugerido, cargado: total };
      }
      pintarAvisoVenta();
    } catch (e) {
      // Que no se pueda chequear NO puede romper el recalculo. Se deja sin aviso.
      console.warn('[salidas] no se pudo chequear el precio de venta:', e.message);
    }
  }

  function pintarAvisoVenta() {
    const cont = document.getElementById('saled-venta-aviso');
    if (!cont) return;
    if (!ventaDesfasada) { cont.classList.add('hidden'); cont.innerHTML = ''; return; }
    const { sugerido, cargado } = ventaDesfasada;
    const dif = sugerido - cargado;
    cont.classList.remove('hidden');
    cont.innerHTML = `
      <strong>El precio de venta no corresponde a este peso.</strong>
      Tiene cargado <strong>US$ ${cargado.toFixed(2)}</strong> y con el peso actual seria
      <strong>US$ ${sugerido.toFixed(2)}</strong>
      (${dif > 0 ? 'se estarian cobrando' : 'se estarian cobrando de mas'}
      <strong>US$ ${Math.abs(dif).toFixed(2)}</strong> ${dif > 0 ? 'de menos' : ''}).
      Toca <strong>Calcular venta</strong> para actualizarlo.`;
  }

  // La Proteccion de Documentos de DHL cubre documentos valiosos (pasaportes, visas,
  // certificados), asi que la tilde solo tiene sentido cuando el envio ES un documento y
  // va por DHL. Pedido de Felipe el 04/08.
  //
  // `destildar` distingue quien disparo el cambio: si el usuario cambio el courier o el
  // tipo de paquete, destildar es la consecuencia de SU accion. Al ABRIR un envio guardado
  // no se toca — destildarlo ahi seria cambiarle la plata a un envio sin que nadie lo
  // pida —, asi que un envio que ya tenga el cargo se muestra igual aunque hoy no
  // califique: mejor verlo y decidir que esconder un cobro activo.
  function toggleProtDocVisible(destildar = false) {
    const label = document.getElementById('saled-prot-doc-label');
    const chk = document.getElementById('saled-proteccion-doc');
    const courierEl = document.getElementById('saled-courier');
    const tipoEl = document.getElementById('saled-tipo-paquete');
    if (!label || !chk || !courierEl || !tipoEl) return;
    const aplica = courierEl.value === 'DHL' && tipoEl.value === 'd';
    if (!aplica && destildar) chk.checked = false;
    label.style.display = (aplica || chk.checked) ? 'flex' : 'none';
  }

  // Arma el pedido de cotizacion del envio abierto. Lo usan DOS cosas: el boton "Calcular
  // venta" y el chequeo silencioso que corre despues de Recalcular.
  //
  // REGLA: se manda SOLO lo que el usuario esta editando en el modal. Todo lo demas
  // (fob, tipo de envio, servicio, zona, fuel) sale del envio, del lado del servidor.
  //
  // Por que la regla es esa y no "mandar todo lo que tengamos a mano": la fila que dibuja
  // la grilla NO tiene los mismos nombres que la tabla de envios. `fob` viaja como
  // `valor_declarado`, y `tipo_envio` directamente no viaja. Leerlos de ahi daba
  // `undefined`, y `undefined || 0` es 0:
  //
  //   · fob 0        -> el motor no cobraba SEGURO. USD 15 de menos en cada envio.
  //   · tipo_envio   -> toda importacion se cotizaba con la tarifa de EXPORTACION.
  //
  // Los dos salieron a la luz el 07/08/2026 con un caso de la oficina, y los dos son el
  // mismo error de siempre: la pantalla opinando sobre datos que no tiene. Si hace falta
  // un dato del envio que no se edita aca, NO se busca en la fila: se deja que lo ponga
  // el servidor a partir del envio_id.
  function armarBodyCotizacion() {
    if (!editEnvio) return null;
    const pf = parseNum(document.getElementById('saled-peso-facturable').value);
    if (!(pf > 0)) return null;
    const clienteId = parseInt(document.getElementById('saled-cliente').value, 10);
    if (!clienteId) return null;

    const num = (id) => {
      const v = document.getElementById(id).value;
      return v !== '' ? Number(v) : null;
    };

    const body = {
      // Lo que el modal edita, y nada mas:
      envio_id: editEnvio.id,
      cliente_id: clienteId,
      pais: document.getElementById('saled-pais-destino').value || null,
      courier: document.getElementById('saled-courier').value,
      pesoFacturable: pf,
      // El valor declarado tal como está AHORA en el modal: el seguro de la venta sale de
      // él. Sin esto, "Calcular venta" usaría el fob guardado aunque recién lo hayan editado.
      fob: num('saled-fob') ?? 0,
      ddp: document.getElementById('saled-ddp').checked,
      proteccionDoc: document.getElementById('saled-proteccion-doc').checked,
      entrega: document.getElementById('saled-entrega').value,
      contenido: document.getElementById('saled-tipo-paquete').value === 'd'
        ? 'documento' : 'paquete',
      // Que el backend resuelva el profit por la matriz del cliente.
      profitManual: false,
    };

    body.bultos = editMulti
      ? readBultosFromModal().map((b) => ({
        peso_real: b.peso_real, largo: b.largo, ancho: b.ancho, alto: b.alto,
      }))
      : [{ peso_real: num('saled-peso-real'), largo: num('saled-largo'),
        ancho: num('saled-ancho'), alto: num('saled-alto') }];
    return body;
  }

  async function calcularVenta() {
    if (!editEnvio) return;
    const btn = document.getElementById('saled-calcular-venta');
    const status = document.getElementById('saled-venta-status');
    const panel = document.getElementById('saled-venta-panel');
    panel.classList.add('hidden');

    // Sin peso no hay precio. Si el envio venia sin pesar y recien le cargaron los kilos,
    // el peso facturable todavia no esta calculado: se pide primero el recalculo, que es
    // el paso que igual habria que dar.
    let pf = parseNum(document.getElementById('saled-peso-facturable').value);
    if (!(pf > 0)) {
      status.className = 'saled-recalc-status';
      status.textContent = 'Calculando el peso facturable…';
      await recalcularDesglose();
      pf = parseNum(document.getElementById('saled-peso-facturable').value);
    }
    if (!(pf > 0)) {
      status.className = 'saled-recalc-status saled-recalc-err';
      status.textContent = 'Cargá primero el peso y las medidas: sin peso no hay precio.';
      return;
    }
    if (!parseInt(document.getElementById('saled-cliente').value, 10)) {
      status.className = 'saled-recalc-status saled-recalc-err';
      status.textContent = 'El envío no tiene cliente: sin cliente no hay tarifa que aplicar.';
      return;
    }

    const body = armarBodyCotizacion();
    if (!body) return;

    btn.disabled = true;
    status.className = 'saled-recalc-status';
    status.textContent = 'Calculando…';

    try {
      const r = await NovaAPI.liquidaciones.cotizar(body);
      status.textContent = '';
      renderVentaPanel(r);
    } catch (err) {
      const msg = /zona|pa[ií]s/i.test(err.message)
        ? 'No se pudo calcular: país o zona no reconocidos por el motor.'
        : `No se pudo calcular: ${err.message}`;
      status.className = 'saled-recalc-status saled-recalc-err';
      status.textContent = msg;
    } finally {
      btn.disabled = false;
    }
  }

  // Panel del precio sugerido. Si ya habia una venta cargada muestra las dos y la diferencia,
  // y el boton pasa a decir "Reemplazar" — hay que confirmarlo a mano.
  function renderVentaPanel(r) {
    const panel = document.getElementById('saled-venta-panel');
    const actual = parseNum(document.getElementById('saled-total').value);
    const sugerido = Number(r.precioFinal) || 0;
    const yaTenia = actual > 0;
    const dif = Math.round((sugerido - actual) * 100) / 100;

    const origen = {
      celda: 'celda de la matriz', banda: 'banda de peso', zona: 'zona',
      tabla: 'general de la tabla', cliente: '% del cliente', body: 'el valor del formulario',
    }[r.profit_origen] || r.profit_origen || '—';

    const comoSeArma = r.modo_venta === 'por_kg'
      ? `Precio por kilo USD ${Number(r.precio_kg_aplicado).toFixed(2)} · ${origen}`
      : `Profit ${r.profit_aplicado}% · ${origen}`;

    const filas = [
      `<div class="saled-venta-linea"><span>Servicio</span><b>${esc(r.servicio)} · Zona ${esc(String(r.zona))}</b></div>`,
      `<div class="saled-venta-linea"><span>Costo con fuel ${r.fuel_aplicado}%${r.fuel_origen === 'cliente' ? ' (propio del cliente)' : ''}</span><b>${fmtUSDPlano(r.precioBase)}</b></div>`,
      `<div class="saled-venta-linea"><span>${esc(comoSeArma)}</span><b>+ ${fmtUSDPlano(r.profitMonto)}</b></div>`,
      `<div class="saled-venta-linea saled-venta-total"><span>Precio de venta sugerido</span><b>${fmtUSDPlano(sugerido)}</b></div>`,
    ];

    if (yaTenia) {
      const cls = dif > 0 ? 'saled-venta-dif-pos' : dif < 0 ? 'saled-venta-dif-neg' : '';
      const signo = dif > 0 ? '+' : '';
      filas.push(
        `<div class="saled-venta-linea"><span>Lo que tiene cargado hoy</span><b>${fmtUSDPlano(actual)}</b></div>`,
        `<div class="saled-venta-linea"><span>Diferencia</span><b class="${cls}">${signo}${fmtUSDPlano(dif)}</b></div>`
      );
    }

    const aviso = r.advertencia
      ? `<div class="saled-venta-aviso">${esc(r.advertencia)}</div>`
      : '';
    const avisoPisar = yaTenia
      ? `<div class="saled-venta-aviso">Este envío ya tiene una venta cargada. Si reemplazás, se pierde el número anterior.</div>`
      : '';

    panel.innerHTML = filas.join('') + aviso + avisoPisar + `
      <div class="saled-venta-acciones">
        <button type="button" class="btn btn-primary btn-sm" id="saled-venta-aplicar">
          ${yaTenia ? 'Reemplazar por el sugerido' : 'Usar este precio'}
        </button>
        <button type="button" class="btn btn-secondary btn-sm" id="saled-venta-descartar">
          ${yaTenia ? 'Dejar como está' : 'Descartar'}
        </button>
      </div>`;
    panel.classList.remove('hidden');

    document.getElementById('saled-venta-aplicar').addEventListener('click', () => {
      document.getElementById('saled-total').value = sugerido.toFixed(2);
      // Se acaba de poner el precio que corresponde: ya no hay desfase que avisar.
      ventaDesfasada = null;
      pintarAvisoVenta();
      // Profit y % se re-derivan solos con la misma cuenta de siempre (total − costos), asi
      // que no hay dos formas distintas de calcular la utilidad.
      recalcProfit();
      panel.classList.add('hidden');
      const status = document.getElementById('saled-venta-status');
      status.className = 'saled-recalc-status saled-recalc-ok';
      status.textContent = 'Venta aplicada. Revisá y guardá para persistir.';
    });
    document.getElementById('saled-venta-descartar').addEventListener('click', () => {
      panel.classList.add('hidden');
      document.getElementById('saled-venta-status').textContent = '';
    });
  }

  // fmtUSD devuelve HTML con <span class="em"> para los vacios; aca hace falta texto plano.
  function fmtUSDPlano(v) {
    const n = Number(v);
    return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—';
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

    // Guardar con el precio calculado para otro peso es el error que costo plata. No se
    // bloquea —hay precios negociados aparte que son legitimos— pero no se guarda callado.
    if (ventaDesfasada) {
      const { sugerido, cargado } = ventaDesfasada;
      const dif = sugerido - cargado;
      const ok = window.confirm(
        'El precio de venta no corresponde a este peso.\n\n'
        + `Cargado:  US$ ${cargado.toFixed(2)}\n`
        + `Deberia ser:  US$ ${sugerido.toFixed(2)}\n`
        + `Diferencia:  US$ ${Math.abs(dif).toFixed(2)} ${dif > 0 ? 'de MENOS' : 'de MAS'}\n\n`
        + 'Si es un precio negociado aparte, esta bien guardarlo asi.\n'
        + 'Si no, cancela y toca "Calcular venta".\n\n'
        + 'Guardar igual?');
      if (!ok) return;
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
      entrega:        document.getElementById('saled-entrega').value,
      remota:         document.getElementById('saled-entrega').value !== 'normal' ? 1 : 0,
      ddp:            document.getElementById('saled-ddp').checked ? 1 : 0,
      proteccion_doc: document.getElementById('saled-proteccion-doc').checked ? 1 : 0,
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

    // Identidad: fecha, cliente, courier, país destino y "sin numerar". El backend valida
    // todo y re-resuelve la zona solo cuando cambia el país. En envíos liquidados fecha y
    // cliente están deshabilitados en el modal, así que su .value sigue siendo el original
    // (mismo valor → el backend no lo rechaza). El país viaja como pais_destino.
    payload.fecha        = document.getElementById('saled-fecha').value || null;
    payload.cliente_id   = Number(document.getElementById('saled-cliente').value) || null;
    payload.courier      = document.getElementById('saled-courier').value;
    payload.pais_destino = document.getElementById('saled-pais-destino').value || null;
    payload.num_sal_cero = document.getElementById('saled-sin-numerar').checked ? 1 : 0;
    // Valor declarado: vacío = 0 (sin valor declarado), igual que en el alta.
    payload.fob = (() => {
      const v = document.getElementById('saled-fob').value;
      return v !== '' ? Number(v) : 0;
    })();

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

    // Valores previos para detectar qué cambió: la tarifa (país/courier) queda
    // desactualizada y hay que avisar; la fecha puede mover el envío a otro mes/solapa.
    const prevCourier = editEnvio.courier;
    const prevPais    = editEnvio.destino;
    const prevMes     = (editEnvio.fecha || '').slice(0, 7);

    try {
      const resp = await NovaAPI.salidas.actualizar(editEnvio.id, payload);
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
        // Alias de identidad que usa la tabla: el país se muestra como `destino`,
        // num_sal_cero se consume como booleano, y el nombre del cliente se refresca desde
        // la lista cargada (mismo criterio que el GET: nombre_nova con fallback a nombre).
        d.destino = payload.pais_destino;
        d.num_sal_cero = Boolean(payload.num_sal_cero);
        d.valor_declarado = payload.fob;
        const cliSel = clientes.find((c) => c.id === payload.cliente_id);
        if (cliSel) d.cliente_nombre = cliSel.nombre_nova || cliSel.nombre;
        d.compra_total = (payload.flete || 0) - (payload.descuento || 0) + (payload.seguro || 0)
          + (payload.fuel || 0) + (payload.derechos || 0) + (payload.adicionales || 0) + (payload.otros || 0);
        // La doble vista se refresca igual que la simple, o quedaría mostrando la
        // estimación vieja hasta el próximo GET (los campos *_estimado son los que pinta
        // la tabla desde el 31/08).
        d.compra_estimada = d.compra_total;
        d.profit_estimado = payload.profit ?? d.profit_estimado;
        d.porcentaje_estimado = payload.porcentaje ?? d.porcentaje_estimado;
        if (d.costo_facturado != null && d.total != null) {
          d.profit_real_monto = Math.round((d.total - d.costo_facturado) * 100) / 100;
          d.porcentaje_real = d.costo_facturado !== 0
            ? Math.round((d.profit_real_monto / d.costo_facturado) * 10000) / 100 : null;
        }
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
      // Renumerar y reordenar con los datos nuevos. Si la fecha movió el envío a otro mes,
      // saltar la solapa activa a ese mes para que el usuario vea dónde quedó en vez de que
      // le "desaparezca" de pantalla.
      recomputeNumSalMes();
      const mesNuevo = (payload.fecha || '').slice(0, 7);
      if (mesNuevo && mesNuevo !== prevMes) selectedMonth = mesNuevo;

      // Avisos que mantienen el modal ABIERTO: la decisión de recalcular es del usuario.
      //  - aviso_zona: el backend no pudo resolver una zona para el país nuevo.
      //  - tarifa: cambió país o courier → el costo guardado quedó desactualizado.
      const cambioPais    = (payload.pais_destino ?? '') !== (prevPais ?? '');
      const cambioCourier = payload.courier !== prevCourier;
      const avisoZona     = resp && resp.aviso_zona ? resp.aviso_zona : null;
      const avisoTarifa   = cambioPais || cambioCourier;

      applyAll();

      if (avisoZona || avisoTarifa) {
        // Persistido OK, pero dejamos el modal abierto con el aviso y el CTA de Recalcular
        // (que reusa el botón/flujo existente) para que el usuario decida.
        renderPostSaveAvisos(avisoZona, avisoTarifa);
        NovaUtils.showAlert(alertBox, 'Cambios guardados. Revisá el aviso.', 'success');
      } else {
        closeEditModal();
        NovaUtils.showAlert(alertBox, 'Cambios guardados correctamente', 'success');
      }
    } catch (err) {
      // Incluye el 409 de envío liquidado (cambio de cliente/fecha): mostramos el mensaje
      // que manda el backend, no un error genérico.
      const modalAlert = document.getElementById('sal-modal-alert');
      NovaUtils.showAlert(modalAlert, err.message, 'error');
      document.querySelector('.sal-modal-body').scrollTop = 0;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Guardar cambios';
    }
  }

  // Aviso post-guardado dentro del modal (persistente, no se auto-cierra). Muestra el
  // aviso de zona del backend y/o el de tarifa desactualizada por cambio de país/courier.
  // El botón "Recalcular ahora" reusa recalcularDesglose (el mismo flujo del botón del
  // modal): recalcula el desglose contra el motor y deja al usuario revisar y volver a
  // guardar. NO recalculamos solos para no pisar valores ajustados a mano.
  function renderPostSaveAvisos(avisoZona, avisoTarifa) {
    const box = document.getElementById('sal-modal-alert');
    if (!box) return;
    const parts = [];
    if (avisoZona) {
      parts.push(`<div class="alert alert-info">${esc(avisoZona)}</div>`);
    }
    if (avisoTarifa) {
      parts.push(`<div class="alert alert-info">`
        + `Cambiaste el país o el courier: la tarifa es distinta, así que el costo guardado `
        + `quedó desactualizado. No lo recalculamos solos para no pisar valores ajustados a `
        + `mano. Si querés actualizarlo, tocá `
        + `<button type="button" class="btn btn-sm btn-secondary" id="saled-recalc-cta">Recalcular</button>`
        + ` y volvé a Guardar.`
        + `</div>`);
    }
    box.innerHTML = parts.join('');
    const cta = document.getElementById('saled-recalc-cta');
    if (cta) cta.addEventListener('click', recalcularDesglose);
    document.querySelector('.sal-modal-body').scrollTop = 0;
  }

  // ── Cotizaciones recientes del cliente ───────────────────────────────────────
  // Idea de Felipe (25/08/2026). En Salidas el panel NO está a la vista: aparece solo
  // cuando alguien se para en "Total cobrado", que es el único momento en que sirve.
  // Textual: *"me gustaría que esté de una forma que no moleste, tal vez que solo aparezca
  // en el caso que estén editando el precio de venta"*.
  //
  // EL PRECIO ES UN SUGERIDO: se escribe en el campo y se puede pisar. El envío no queda
  // atado a la cotización, y el profit se re-deriva solo como con cualquier otra edición.
  function abrirCotizacionesDelCliente() {
    const caja = document.getElementById('saled-ctzr');
    const cont = document.getElementById('saled-ctzr-panel');
    if (!caja || !cont || !editEnvio || !window.CotizacionesRecientes) return;
    if (!caja.classList.contains('hidden')) return;   // ya está abierto: no re-consultar
    caja.classList.remove('hidden');
    window.CotizacionesRecientes.montar(cont, {
      clienteId: document.getElementById('saled-cliente').value || editEnvio.cliente_id,
      onUsar: (total) => {
        const campo = document.getElementById('saled-total');
        campo.value = Number(total).toFixed(2);
        // Mismo camino que editarlo a mano: el profit y el % se re-derivan solos.
        campo.dispatchEvent(new Event('input', { bubbles: true }));
      },
    });
  }

  function cerrarCotizacionesDelCliente() {
    const caja = document.getElementById('saled-ctzr');
    if (caja) caja.classList.add('hidden');
    if (window.CotizacionesRecientes) {
      window.CotizacionesRecientes.limpiar(document.getElementById('saled-ctzr-panel'));
    }
  }

  // ── NO VOLÓ ─────────────────────────────────────────────────────────────────
  // El envío se cargó, se emitió la guía y no salió — ni va a salir por ahora. La oficina
  // lo venía marcando a mano en el Excel: renglón pintado, leyenda "NO VOLÓ" y la venta y
  // los kilos borrados, para que un envío que nunca salió no ensuciara la estadística del
  // mes.
  //
  // Acá NO se borra nada: la plata y los kilos quedan guardados y dejan de contar (en el
  // dashboard, en el perfil del cliente, en el cierre de mes y en las liquidaciones). Por
  // eso el mismo botón lo deshace: el día que el envío sale, vuelve a la normalidad sin
  // tener que volver a cargar un solo número.
  //
  // Y el número de salida NO cambia: el envío 27 sigue siendo el 27 (pedido de la oficina).
  function sincronizarNoVolo(envio) {
    const btn = document.getElementById('sal-modal-no-volo');
    const nota = document.getElementById('saled-no-volo-note');
    const marcado = Boolean(envio.no_volo);

    btn.textContent = marcado ? 'Sí voló — deshacer' : 'NO VOLÓ';
    btn.classList.toggle('activo', marcado);
    btn.title = marcado
      ? 'Devolver el envío a la normalidad: vuelve a contar en las estadísticas'
      : 'El envío no salió: deja de contar en las estadísticas, pero conserva su número';

    if (marcado) {
      const quien = envio.no_volo_usuario ? ` por ${esc(envio.no_volo_usuario)}` : '';
      const cuando = envio.no_volo_en
        ? ` el ${String(envio.no_volo_en).slice(0, 10).split('-').reverse().join('/')}`
        : '';
      nota.innerHTML = `<b>NO VOLÓ</b> — marcado${quien}${cuando}. Este envío no cuenta en el `
        + `dashboard, en el perfil del cliente ni en el cierre de mes, y no se puede liquidar. `
        + `Conserva su número de salida y sus datos.`;
      nota.classList.remove('hidden');
    } else {
      nota.innerHTML = '';
      nota.classList.add('hidden');
    }
  }

  async function toggleNoVolo() {
    if (!editEnvio) return;
    const envio = editEnvio;
    const marcar = !envio.no_volo;

    const msg = marcar
      ? `Marcar el envío de guía ${envio.numero_guia} como NO VOLÓ.\n\n`
        + `Deja de contar en el dashboard, en el perfil del cliente y en el cierre de mes, `
        + `y no se va a poder liquidar. Los datos NO se borran y el número de salida no cambia.\n\n`
        + `¿Confirmás?`
      : `Devolver el envío de guía ${envio.numero_guia} a la normalidad.\n\n`
        + `Vuelve a contar en todas las estadísticas con los valores que ya tenía.\n\n¿Confirmás?`;
    if (!confirm(msg)) return;

    const btn = document.getElementById('sal-modal-no-volo');
    const textoPrevio = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Guardando…';

    try {
      const r = await NovaAPI.salidas.noVolo(envio.id, marcar);
      // El objeto de la grilla se actualiza en el acto para que la fila se pinte (o se
      // despinte) sin esperar la recarga, igual que hace el resto del modal.
      envio.no_volo = Boolean(r.no_volo);
      envio.no_volo_usuario = r.no_volo_usuario;
      envio.no_volo_en = r.no_volo_en;
      sincronizarNoVolo(envio);
      closeEditModal();
      await loadData();
      NovaUtils.showAlert(alertBox,
        marcar ? 'Envío marcado como NO VOLÓ' : 'El envío vuelve a contar en las estadísticas',
        'success');
    } catch (err) {
      const modalAlert = document.getElementById('sal-modal-alert');
      NovaUtils.showAlert(modalAlert, err.message, 'error');
      document.querySelector('.sal-modal-body').scrollTop = 0;
    } finally {
      btn.disabled = false;
      btn.textContent = textoPrevio;
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
      if (e.target.closest('.btn-revision')) return;   // ✓/✕ de Revisión aprueban/rechazan, no abren el modal
      if (e.target.closest('td.detail-expandable')) return;   // Venta Total / Adic togglean el detalle, no abren el modal
      if (e.target.closest('td[data-col="numero_salida"]')) return;   // #Sal marca la fila, no abre el modal
      const tr = e.target.closest('tr[data-envio-id]');
      if (!tr) return;
      const envio = allData.find((d) => d.id === Number(tr.dataset.envioId));
      // De qué columna vino el click: si tiene campo asociado, el modal lleva el ojo ahí.
      const cell = e.target.closest('td[data-col]');
      if (envio) openEditModal(envio, cell ? cell.dataset.col : null);
    });
  }

  // ── Marca de lectura (click en #Sal) ─────────────────────────────────────────
  // Click en la celda del correlativo (#Sal) togglea el resaltado de TODO el envío,
  // como seleccionar el número de fila en Excel. Listener delegado propio (misma capa
  // que bindRowEdit, que ya ignora esta celda por su guard). No abre el modal.
  function bindRowMark() {
    document.getElementById('salidas-body').addEventListener('click', (e) => {
      const cell = e.target.closest('td[data-col="numero_salida"]');
      if (!cell) return;
      const tr = cell.closest('tr[data-envio-id]');
      if (!tr) return;
      toggleMark(Number(tr.dataset.envioId));
    });
  }

  // Toggle en vivo del resaltado: pinta/despinta TODAS las tr del envío (incluidas las
  // sub-filas de bulto y la sub-fila de detalle con data-extras-for), sin re-render.
  function toggleMark(envioId) {
    const on = !markedEnvios.has(envioId);
    if (on) markedEnvios.add(envioId);
    else markedEnvios.delete(envioId);
    document
      .querySelectorAll(
        `#salidas-body tr[data-envio-id="${envioId}"], `
        + `#salidas-body tr.extras-detail-row[data-extras-for="${envioId}"]`)
      .forEach((row) => row.classList.toggle('row-marked', on));
  }

  // ── Revisión desde Salidas (aprobar / mandar a revisar) ──────────────────────
  // Listener delegado propio (misma capa que bindRowEdit, que ya ignora .btn-revision por
  // su guard). Al clickear ✓/✕: PATCH del estado, y si sale bien se actualiza el envío en
  // memoria y se repinta SOLO la celda de Revisión (más el ⚑ de la columna Guía, que depende
  // del mismo estado). Si el PATCH falla, se reabilitan los botones y la UI queda como estaba:
  // no se toca el estado en memoria, así no miente con algo que no se guardó.
  function bindRevisionButtons() {
    document.getElementById('salidas-body').addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-revision');
      if (!btn) return;
      e.stopPropagation();
      onRevisionClick(btn);
    });
  }

  async function onRevisionClick(btn) {
    const tr = btn.closest('tr[data-envio-id]');
    if (!tr) return;
    const envio = allData.find((d) => d.id === Number(tr.dataset.envioId));
    if (!envio) return;

    const nuevo = btn.dataset.estado;              // 'revisado_ok' | 'a_revisar' (botonera) | 'pendiente' (deshacer)
    if (nuevo === envio.estado_revision) return;   // ya está en ese estado: no re-pegar

    const wrap = btn.closest('.revision-btns');
    if (wrap) wrap.querySelectorAll('.btn-revision').forEach((b) => (b.disabled = true));

    try {
      await NovaAPI.facturas.actualizarEstado(envio.id, nuevo);
      envio.estado_revision = nuevo;               // estado en memoria
      repaintRevisionCell(envio);                  // repinta solo la celda (+ el ⚑ de Guía)
      // En modo automático, aprobar el último pendiente pliega el bloque solo (o des-aprobar
      // vuelve a mostrarlo). Con override manual, applyUpsCols respeta lo forzado.
      applyUpsCols();
    } catch (err) {
      if (wrap) wrap.querySelectorAll('.btn-revision').forEach((b) => (b.disabled = false));
      NovaUtils.showAlert(alertBox, 'No se pudo actualizar la revisión: ' + err.message, 'error');
    }
  }

  // Repinta la celda de Revisión del envío (vive solo en la fila principal) desde el estado
  // en memoria, y mantiene honesto el ⚑ de la columna Guía (mismo estado_revision) sin
  // reconstruir toda la celda de la guía (preserva texto, lápiz y demás iconos).
  function repaintRevisionCell(envio) {
    const firstRow = document.querySelector(`#salidas-body tr[data-envio-id="${envio.id}"]`);
    if (!firstRow) return;

    const cell = firstRow.querySelector('td.revision-cell');
    if (cell) cell.innerHTML = revisionCellHtml(envio, true);

    // El azul de "Compra Total" vive exactamente mientras la guía está pendiente (botonera
    // visible). Al decidir ✓/✕ el estado deja de ser pendiente → se apaga en el acto, junto
    // con la celda de Revisión, sin recargar. Misma condición vía isRevisionPendiente.
    const compraCell = firstRow.querySelector('td[data-col="compra_total"]');
    if (compraCell) {
      compraCell.classList.toggle('cell-compra-pendiente', isRevisionPendiente(envio, true));
    }

    const guiaCell = firstRow.querySelector('td[data-col="numero_guia"]');
    if (guiaCell) {
      const old = guiaCell.querySelector('.revision-flag');
      if (old) old.remove();
      const html = revisionIconHtml(envio);
      if (html) {
        const tmpl = document.createElement('template');
        tmpl.innerHTML = html;
        // El ⚑ va antes del ⚠ de alerta / del botón de tracking; si no hay, al final.
        const anchor = guiaCell.querySelector('.alert-icon:not(.revision-flag), .track-btn');
        if (anchor) guiaCell.insertBefore(tmpl.content.firstChild, anchor);
        else guiaCell.appendChild(tmpl.content.firstChild);
      }
    }
  }

  // ── Sub-fila de detalle (expandible al tocar la celda Venta Total o Adic) ─────
  // El área clickeable es TODA la celda expandible (Venta Total o Adic), no solo el ▸: los
  // empleados no tienen que apuntar a la flechita. Ambas celdas togglean la MISMA sub-fila
  // (mismo renglón, mismos bloques). El ▸ queda como señal visual (rota a ▾ vía .open) y se
  // sincroniza en las dos celdas. stopPropagation NO frena los otros listeners de
  // #salidas-body (misma capa: bindGridNav sigue seleccionando la celda; bindRowEdit ya
  // descarta el modal por su guard), solo evita que burbujee a los cierres de dropdown.
  function bindDetailToggle() {
    document.getElementById('salidas-body').addEventListener('click', (e) => {
      const cell = e.target.closest('td.detail-expandable');
      if (!cell) return;
      e.stopPropagation();   // que NO cierre dropdowns flotantes ni burbujee de más
      toggleDetailRow(Number(cell.dataset.detailEnvio));
    });
  }

  // Toggle en vivo: inserta/remueve la sub-fila directamente en el DOM (sin re-render de
  // toda la tabla) y sincroniza el Set + el estado de AMBOS ▸ (Venta Total y Adic). Varios
  // envíos pueden estar abiertos a la vez. La sub-fila se cuelga DESPUÉS del último renglón
  // (bulto) del envío.
  function toggleDetailRow(envioId) {
    const envio = allData.find((d) => d.id === envioId);
    if (!envio || !detailHasContent(envio)) return;
    if (expandedExtras.has(envioId)) {
      expandedExtras.delete(envioId);
      const row = document.querySelector(`#salidas-body tr.extras-detail-row[data-extras-for="${envioId}"]`);
      if (row) row.remove();
    } else {
      expandedExtras.add(envioId);
      const rows = document.querySelectorAll(`#salidas-body tr[data-envio-id="${envioId}"]`);
      const lastRow = rows[rows.length - 1];
      if (lastRow) lastRow.after(buildDetailRow(envio));
    }
    syncDetailToggles(envioId);
  }

  // Refleja el estado abierto/cerrado en los ▸ de las dos celdas expandibles del envío
  // (Venta Total y Adic): abrir desde una rota también el ▸ de la otra, porque es la misma fila.
  function syncDetailToggles(envioId) {
    const open = expandedExtras.has(envioId);
    document
      .querySelectorAll(`#salidas-body tr[data-envio-id="${envioId}"] .extras-toggle`)
      .forEach((b) => b.classList.toggle('open', open));
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
        const guiaNueva = bulto.numero_guia || envio.numero_guia || '';
        cell.querySelector('.bulto-guia-text').textContent = guiaNueva;
        // Se re-evalúa el pintado: si la corrigieron, la celda tiene que dejar de estar
        // marcada en el acto, sin recargar la pantalla.
        const malAhora = typeof validarGuia === 'function'
          && validarGuia(envio.courier, guiaNueva).estado === 'sospechosa';
        cell.classList.toggle('cell-guia-mala', malAhora);
        if (malAhora) {
          cell.title = 'Guía mal cargada: ' + validarGuia(envio.courier, guiaNueva).motivo;
        } else {
          cell.removeAttribute('title');
        }
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
  // "Cargando…" / "No hay envíos" (td colspan 37 sin data-envio-id).
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
    let colIndex = Math.min(Math.max(activeCell.colIndex, GRID_MIN_COL), GRID_MAX_COL);
    // Con el bloque UPS plegado, no dejar la celda activa sobre una columna oculta: correrla
    // a la última visible antes del bloque (%, col 29).
    if (!upsVisible && colIndex >= UPS_COL_START && colIndex <= UPS_COL_END) {
      colIndex = UPS_COL_START - 1;
    }
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
    else if (e.key === 'ArrowLeft') colIndex = prevVisibleCol(colIndex);
    else if (e.key === 'ArrowRight') colIndex = nextVisibleCol(colIndex);

    // En el borde no hay movimiento: NO bloquear el scroll normal de la página.
    if (rowIndex === activeCell.rowIndex && colIndex === activeCell.colIndex) return;

    setActiveCell(rowIndex, colIndex, true);
    e.preventDefault();
  }

  // Vecino navegable a la derecha, saltando el bloque UPS cuando está plegado (columnas
  // ocultas: las flechas no deben entrar ahí). El bloque [30..34] es contiguo → un solo salto.
  function nextVisibleCol(c) {
    let n = Math.min(GRID_MAX_COL, c + 1);
    if (!upsVisible && n >= UPS_COL_START && n <= UPS_COL_END) {
      n = Math.min(GRID_MAX_COL, UPS_COL_END + 1);
    }
    return n;
  }

  // Vecino navegable a la izquierda, con el mismo salto sobre el bloque UPS plegado.
  function prevVisibleCol(c) {
    let p = Math.max(GRID_MIN_COL, c - 1);
    if (!upsVisible && p >= UPS_COL_START && p <= UPS_COL_END) {
      p = Math.max(GRID_MIN_COL, UPS_COL_START - 1);
    }
    return p;
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

    // Vertical: el scroll real ahora también es del wrapper (overflow-y auto). El thead sticky
    // (alto headH) tapa la franja superior del wrapper, así que la zona útil arranca en
    // scrollTop + headH. offsetTop de la celda es relativo a la tabla = origen del wrapper.
    if (wrap) {
      const thead = document.querySelector('.salidas-table thead');
      const headH = thead ? thead.offsetHeight : 0;
      const cellTop = td.offsetTop;
      const cellBottom = cellTop + td.offsetHeight;
      if (cellTop < wrap.scrollTop + headH) {
        wrap.scrollTop = cellTop - headH - 8;
      } else if (cellBottom > wrap.scrollTop + wrap.clientHeight) {
        wrap.scrollTop = cellBottom - wrap.clientHeight + 8;
      }
    }
  }

  init();
})();
