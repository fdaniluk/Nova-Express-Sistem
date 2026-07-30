(function () {
  // ── Estado ──────────────────────────────────────────────────────────────────
  let pdfFile = null;             // archivo seleccionado
  let revisarLoaded = false;      // si la pestaña Revisar ya cargó datos
  let sinEnvioLoaded = false;     // idem para la pestaña Sin envío
  let revisarData = [];           // guías cargadas para Revisar

  const alertBox = document.getElementById('alert-box');

  // ── Init ────────────────────────────────────────────────────────────────────
  function init() {
    bindTabs();
    document.getElementById('btn-sinenvio-reload')?.addEventListener('click', loadSinEnvio);
    // Se consulta al entrar a la pantalla para que el número del cartelito de la pestaña
    // esté a la vista sin tener que abrirla.
    loadSinEnvio();
    bindCargar();
  }

  // ── Pestañas ─────────────────────────────────────────────────────────────────
  function bindTabs() {
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        btn.classList.add('active');

        const tab = btn.dataset.tab;
        document.getElementById('tab-cargar').classList.toggle('hidden', tab !== 'cargar');
        document.getElementById('tab-revisar').classList.toggle('hidden', tab !== 'revisar');
        document.getElementById('tab-sinenvio').classList.toggle('hidden', tab !== 'sinenvio');

        if (tab === 'revisar' && !revisarLoaded) loadRevisar();
        if (tab === 'sinenvio' && !sinEnvioLoaded) loadSinEnvio();
      });
    });
  }

  // ── Pestaña CARGAR ──────────────────────────────────────────────────────────

  function bindCargar() {
    const fileInput = document.getElementById('fac-file-input');
    const fileLabel = document.getElementById('fac-file-label');
    const filename  = document.getElementById('fac-filename');
    const btnCargar = document.getElementById('btn-cargar');

    fileInput.addEventListener('change', () => {
      pdfFile = fileInput.files[0] || null;
      resetCargarUI();

      if (pdfFile) {
        filename.textContent = pdfFile.name;
        filename.classList.add('has-file');
        fileLabel.classList.add('has-file');
        btnCargar.disabled = false;
      } else {
        filename.textContent = 'Ningún archivo seleccionado';
        filename.classList.remove('has-file');
        fileLabel.classList.remove('has-file');
        btnCargar.disabled = true;
      }
    });

    btnCargar.addEventListener('click', onCargarClick);

    document.getElementById('btn-sobreescribir').addEventListener('click', () => ejecutarCarga(true));
    document.getElementById('btn-omitir').addEventListener('click',       () => ejecutarCarga(false));
    document.getElementById('btn-revisar-reload').addEventListener('click', () => {
      revisarLoaded = false;
      loadRevisar();
    });
  }

  function resetCargarUI() {
    hide('fac-confirm');
    hide('fac-resumen');
    hide('fac-no-enc');
    hide('fac-reconc');
    hide('fac-advert');
  }

  async function onCargarClick() {
    if (!pdfFile) return;

    const btn = document.getElementById('btn-cargar');
    btn.disabled = true;
    btn.textContent = 'Verificando…';
    resetCargarUI();

    try {
      const check = await NovaAPI.facturas.chequear(pdfFile);

      if (check.conteo_ya_cargadas > 0) {
        // Mostrar panel de confirmación
        const n = check.conteo_ya_cargadas;
        document.getElementById('fac-confirm-msg').innerHTML =
          `<strong>⚠ ${n} ${n === 1 ? 'guía' : 'guías'} de esta factura ya ${n === 1 ? 'tenía' : 'tenían'} costo cargado.</strong><br>
          ¿Querés sobreescribir los valores anteriores con los de esta factura?`;
        show('fac-confirm');
      } else {
        // Sin duplicados → cargar directamente
        await ejecutarCarga(false);
        return;
      }
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al verificar la factura: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Cargar factura';
    }
  }

  async function ejecutarCarga(sobreescribir) {
    if (!pdfFile) return;

    hide('fac-confirm');

    const btn = document.getElementById('btn-cargar');
    btn.disabled = true;
    btn.textContent = 'Cargando…';

    try {
      const res = await NovaAPI.facturas.cargar(pdfFile, sobreescribir);
      mostrarResumen(res);

      // Invalidar caché de la pestaña Revisar para que recargue cuando se abra
      revisarLoaded = false;
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar la factura: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Cargar factura';
    }
  }

  function mostrarResumen(res) {
    const nums = document.getElementById('fac-resumen-nums');
    nums.innerHTML = `
      <div class="fac-resumen-item">
        <div class="fac-resumen-val">${res.total_guias}</div>
        <div class="fac-resumen-lbl">Total guías</div>
      </div>
      <div class="fac-resumen-item">
        <div class="fac-resumen-val">${res.guardadas}</div>
        <div class="fac-resumen-lbl">Guardadas</div>
      </div>
      <div class="fac-resumen-item">
        <div class="fac-resumen-val ${res.a_revisar > 0 ? 'warning' : ''}">${res.a_revisar}</div>
        <div class="fac-resumen-lbl">A revisar</div>
      </div>
      <div class="fac-resumen-item">
        <div class="fac-resumen-val ${res.omitidas_duplicado > 0 ? 'warning' : ''}">${res.omitidas_duplicado}</div>
        <div class="fac-resumen-lbl">Omitidas (dup.)</div>
      </div>
      <div class="fac-resumen-item">
        <div class="fac-resumen-val ${res.no_encontradas > 0 ? 'danger' : ''}">${res.no_encontradas}</div>
        <div class="fac-resumen-lbl">No encontradas</div>
      </div>
      ${contadorExtra(res.sin_costo, 'Sin costo')}
      ${contadorExtra(res.errores, 'Con error')}
    `;
    show('fac-resumen');

    // El backend ya devolvía estos datos; la pantalla no los mostraba.
    renderReconciliacion(res.reconciliacion);
    renderAdvertencias(res.advertencias, res.advertencia_conteo);

    if (res.no_encontradas > 0 && res.no_encontradas_lista?.length > 0) {
      const tbody = document.getElementById('fac-no-enc-body');
      tbody.innerHTML = res.no_encontradas_lista.map((g) => `
        <tr>
          <td class="mono">${esc(g.numero_guia)}</td>
          <td>${esc(g.pais)}</td>
          <td>$${Number(g.costo_total).toFixed(2)}</td>
        </tr>
      `).join('');
      show('fac-no-enc');
    }
  }

  // Contadores que solo aparecen si tienen algo: guías sin importe legible y guías
  // que fallaron al guardar. En una carga normal valen 0 y no ensucian el resumen;
  // cuando valen algo, es justo lo que hay que ver.
  function contadorExtra(valor, etiqueta) {
    if (!valor) return '';
    return `
      <div class="fac-resumen-item">
        <div class="fac-resumen-val danger">${valor}</div>
        <div class="fac-resumen-lbl">${esc(etiqueta)}</div>
      </div>
    `;
  }

  // Suma de las guías vs. total declarado por la propia factura. Si no cuadra, la
  // diferencia suele ser la percepción de Ingresos Brutos del pie, que UPS cobra y
  // no aparece en el detalle por guía.
  function renderReconciliacion(rec) {
    if (!rec || rec.total_declarado == null) return;
    const box = document.getElementById('fac-reconc');
    const cuadra = rec.cuadra === true;
    box.className = `fac-reconc ${cuadra ? 'ok' : 'warn'}`;
    box.innerHTML = `
      <div class="fac-reconc-title">
        ${cuadra ? '✓ La factura cuadra' : '⚠ La factura NO cuadra'}
      </div>
      <div class="fac-reconc-nums">
        <span>Suma de las guías: <b>$${Number(rec.suma_guias).toFixed(2)}</b></span>
        <span>Total de la factura: <b>$${Number(rec.total_declarado).toFixed(2)}</b></span>
        <span>Diferencia: <b>$${Number(rec.diferencia).toFixed(2)}</b></span>
      </div>
      ${cuadra ? '' : `
        <div class="fac-reconc-nota">
          La diferencia suele ser la percepción de Ingresos Brutos del pie de la factura,
          que no está repartida por guía. Los costos guardados NO la incluyen.
        </div>`}
    `;
    show('fac-reconc');
  }

  // Todo lo que el parser no pudo resolver. Antes esto no existía: los problemas se
  // degradaban a 0 o se descartaban en silencio y la pantalla decía "todo OK".
  function renderAdvertencias(advertencias, advertenciaConteo) {
    const lista = (advertencias || []).slice();
    if (advertenciaConteo) lista.push({ tipo: 'conteo', detalle: advertenciaConteo });
    if (lista.length === 0) return;

    const box = document.getElementById('fac-advert');
    box.innerHTML = `
      <div class="fac-advert-title">Avisos del lector de la factura (${lista.length})</div>
      <ul class="fac-advert-list">
        ${lista.map((a) => `
          <li>
            ${a.guia ? `<span class="mono">${esc(a.guia)}</span> — ` : ''}${esc(a.detalle)}
            ${a.montos ? ` <span class="mono">[${a.montos.map((m) => '$' + Number(m).toFixed(2)).join(' · ')}]</span>` : ''}
          </li>
        `).join('')}
      </ul>
    `;
    show('fac-advert');
  }

  // ── Pestaña REVISAR ─────────────────────────────────────────────────────────

  // ── Pestaña SIN ENVÍO ───────────────────────────────────────────────────────
  //
  // Guías que el courier facturó y que no tienen envío cargado. La info ya se guardaba
  // (factura_guias.encontrada = 0) pero solo se veía en el resumen del momento de cargar
  // la factura: al salir de ahí no se volvía a ver nunca.

  async function loadSinEnvio() {
    const tbody = document.getElementById('fac-sinenvio-body');
    const counter = document.getElementById('fac-sinenvio-counter');
    const badge = document.getElementById('sinenvio-badge');
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Cargando…</td></tr>';
    try {
      const res = await NovaAPI.facturas.sinEnvio();
      sinEnvioLoaded = true;
      const guias = res.guias || [];

      if (badge) {
        badge.textContent = guias.length;
        badge.classList.toggle('hidden', guias.length === 0);
      }
      counter.textContent = guias.length
        ? `${guias.length} guía${guias.length > 1 ? 's' : ''} · ${fmtUSD(res.costo_total)} facturados`
        : '';

      if (!guias.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">Ninguna. Todas las guías facturadas tienen su envío cargado.</td></tr>';
        return;
      }

      tbody.innerHTML = guias.map((g) => `<tr>
        <td class="mono">${esc(g.numero_guia)}</td>
        <td>${esc(g.factura || '')}<div class="em" style="font-size:11px">${esc(g.fecha_factura || '')}</div></td>
        <td>${esc(g.pais || '')}</td>
        <td class="num">${g.peso_facturado != null ? Number(g.peso_facturado).toFixed(1) + ' kg' : '<span class="em">—</span>'}</td>
        <td class="num">${fmtUSD(g.costo_total)}</td>
      </tr>`).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty">No se pudo cargar: ${esc(e.message || e)}</td></tr>`;
    }
  }

  async function loadRevisar() {
    const tbody = document.getElementById('fac-table-body');
    const counter = document.getElementById('fac-revisar-counter');

    tbody.innerHTML = '<tr><td colspan="11" class="empty">Cargando…</td></tr>';
    counter.textContent = '';

    try {
      revisarData = await NovaAPI.facturas.guias();
      revisarLoaded = true;
      renderRevisar();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="10" class="empty" style="color:var(--color-danger)">Error al cargar: ${esc(err.message)}</td></tr>`;
    }
  }

  function renderRevisar() {
    const tbody = document.getElementById('fac-table-body');
    const counter = document.getElementById('fac-revisar-counter');

    counter.textContent = `${revisarData.length} guías`;

    if (revisarData.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" class="empty">No hay guías con costo facturado aún.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    for (const g of revisarData) {
      tbody.appendChild(buildRevisarRow(g));
    }
  }

  function buildRevisarRow(g) {
    const tr = document.createElement('tr');
    tr.dataset.id = g.id;

    const estado = g.estado_revision || '';
    if (estado === 'a_revisar') tr.classList.add('row-a-revisar');
    else if (estado === 'reclamar') tr.classList.add('row-reclamar');

    tr.innerHTML = `
      <td class="mono">${esc(g.numero_guia)}</td>
      <td>${esc(g.cliente)}</td>
      <td>${esc(g.pais_destino)}</td>
      <td>${servicioUPSLabel(g.servicio_ups)}</td>
      <td>${NovaUtils.formatDate(g.fecha_facturado)}</td>
      <td class="num">${fmtUSD(g.total_cobrado)}</td>
      <td class="num">${fmtUSD(g.costo_facturado)}</td>
      <td class="num">${gainCell(g.ganancia_usd)}</td>
      <td class="num">${pctCell(g.ganancia_pct)}</td>
      <td>${estadoBadge(estado)}</td>
      <td>${accionesBtns(g.id, estado)}</td>
    `;

    tr.querySelectorAll('.btn-accion').forEach((btn) => {
      btn.addEventListener('click', () => onCambiarEstado(g.id, btn.dataset.estado, tr, g));
    });

    return tr;
  }

  async function onCambiarEstado(id, nuevoEstado, tr, guia) {
    const btns = tr.querySelectorAll('.btn-accion');
    btns.forEach((b) => { b.disabled = true; b.classList.add('btn-loading'); });

    try {
      await NovaAPI.facturas.actualizarEstado(id, nuevoEstado);

      // Actualizar datos en memoria
      guia.estado_revision = nuevoEstado;
      const idx = revisarData.findIndex((g) => g.id === id);
      if (idx !== -1) revisarData[idx].estado_revision = nuevoEstado;

      // Actualizar fila en el DOM sin re-render completo
      tr.className = '';
      if (nuevoEstado === 'a_revisar') tr.classList.add('row-a-revisar');
      else if (nuevoEstado === 'reclamar') tr.classList.add('row-reclamar');

      const cells = tr.querySelectorAll('td');
      cells[9].innerHTML = estadoBadge(nuevoEstado);
      cells[10].innerHTML = accionesBtns(id, nuevoEstado);

      tr.querySelectorAll('.btn-accion').forEach((btn) => {
        btn.addEventListener('click', () => onCambiarEstado(id, btn.dataset.estado, tr, guia));
      });
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cambiar estado: ' + err.message, 'error');
      btns.forEach((b) => { b.disabled = false; b.classList.remove('btn-loading'); });
    }
  }

  // ── Helpers de render ────────────────────────────────────────────────────────

  function estadoBadge(estado) {
    const map = {
      // 'pendiente' no debería llegar acá (la bandeja filtra a_revisar/reclamar), pero lo
      // mapeamos para no romper el render si alguna vez aparece.
      'pendiente':   ['badge-pendiente',    '• Pendiente'],
      'a_revisar':   ['badge-a-revisar',   '⚠ A revisar'],
      'revisado_ok': ['badge-revisado-ok',  '✓ Revisado OK'],
      'reclamar':    ['badge-reclamar',     '⚑ Reclamar'],
    };
    const [cls, label] = map[estado] || ['', estado];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function accionesBtns(id, estado) {
    if (estado === 'a_revisar') {
      return `<div class="fac-action-btns">
        <button class="btn btn-sm btn-ok btn-accion" data-estado="revisado_ok" data-id="${id}">✓ OK</button>
        <button class="btn btn-sm btn-reclamar btn-accion" data-estado="reclamar" data-id="${id}">⚑ Reclamar</button>
      </div>`;
    }
    if (estado === 'reclamar') {
      return `<div class="fac-action-btns">
        <button class="btn btn-sm btn-ok btn-accion" data-estado="revisado_ok" data-id="${id}">✓ OK</button>
      </div>`;
    }
    return '';
  }

  function gainCell(v) {
    if (v == null) return '<span class="em">—</span>';
    const cls = v > 0 ? 'gain-pos' : v < 0 ? 'gain-neg' : 'gain-zero';
    const sign = v > 0 ? '+' : '';
    return `<span class="${cls}">${sign}$${Number(v).toFixed(2)}</span>`;
  }

  function pctCell(v) {
    if (v == null) return '<span class="em">—</span>';
    const cls = v > 0 ? 'gain-pos' : v < 0 ? 'gain-neg' : 'gain-zero';
    const sign = v > 0 ? '+' : '';
    return `<span class="${cls}">${sign}${Number(v).toFixed(1)}%</span>`;
  }

  function fmtUSD(v) {
    if (v == null) return '<span class="em">—</span>';
    return `$${Number(v).toFixed(2)}`;
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function servicioUPSLabel(v) {
    if (v === 'UPS_EXP') return 'Expedited';
    if (v === 'UPS_SAV') return 'Saver';
    return '<span class="em">—</span>';
  }

  function show(id) { document.getElementById(id).classList.remove('hidden'); }
  function hide(id) { document.getElementById(id).classList.add('hidden'); }

  init();
})();
