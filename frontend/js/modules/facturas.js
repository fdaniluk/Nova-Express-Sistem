(function () {
  // ── Estado ──────────────────────────────────────────────────────────────────
  let pdfFile = null;             // archivo seleccionado (modo de a una)
  let pdfFiles = [];              // archivos seleccionados (varios a la vez)
  let revisarLoaded = false;      // si la pestaña Revisar ya cargó datos
  let sinEnvioLoaded = false;     // idem para la pestaña Sin envío
  let revisarData = [];           // guías cargadas para Revisar
  // Candado del envío en curso. El 28/08 casi todas las facturas quedaron cargadas
  // DOS veces con segundos de diferencia: "Sobreescribir" y "Omitir" seguían vivos
  // mientras la carga viajaba, y el segundo click disparaba otra carga entera.
  let cargaEnCurso = false;
  // Estado del lote (varios PDFs de una): una entrada por archivo, y la lista de
  // los que ya estaban cargados esperando la decisión de sobreescribir.
  let loteFilas = [];
  let loteConflictos = null;

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
      pdfFiles = Array.from(fileInput.files || []);
      pdfFile = pdfFiles.length === 1 ? pdfFiles[0] : null;
      resetCargarUI();

      if (pdfFiles.length > 1) {
        filename.textContent = `${pdfFiles.length} facturas seleccionadas`;
        filename.classList.add('has-file');
        fileLabel.classList.add('has-file');
        btnCargar.disabled = false;
      } else if (pdfFile) {
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
      btnCargar.textContent = textoBotonCargar();
    });

    btnCargar.addEventListener('click', onCargarClick);

    // Los dos botones de la confirmación sirven a los DOS modos: en el modo de a
    // una relanzan la carga con/sin sobreescribir; en el modo lote deciden qué
    // hacer con las facturas que ya estaban cargadas.
    document.getElementById('btn-sobreescribir').addEventListener('click', () => (
      loteConflictos ? continuarLoteSobreescribiendo() : ejecutarCarga(true)
    ));
    document.getElementById('btn-omitir').addEventListener('click', () => (
      loteConflictos ? cerrarLoteSinSobreescribir() : ejecutarCarga(false)
    ));
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
    hide('fac-lote');
    loteConflictos = null;
  }

  // El texto del botón acompaña la selección: "Cargar factura" o "Cargar N facturas".
  function textoBotonCargar() {
    return pdfFiles.length > 1 ? `Cargar ${pdfFiles.length} facturas` : 'Cargar factura';
  }

  // Prende/apaga los TRES botones que pueden disparar una carga. Bloquear solo
  // "Cargar factura" no alcanzaba: la confirmación de sobreescribir quedaba viva.
  function botonesDeCarga(bloqueados) {
    ['btn-cargar', 'btn-sobreescribir', 'btn-omitir'].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.disabled = bloqueados;
    });
  }

  async function onCargarClick() {
    if (cargaEnCurso) return;
    if (pdfFiles.length > 1) return cargarLote();
    if (!pdfFile) return;
    cargaEnCurso = true;

    const btn = document.getElementById('btn-cargar');
    botonesDeCarga(true);
    btn.textContent = 'Verificando…';
    resetCargarUI();

    try {
      const check = await NovaAPI.facturas.chequear(pdfFile);

      if (check.conteo_ya_cargadas > 0) {
        // Mostrar panel de confirmación
        const n = check.conteo_ya_cargadas;
        const que = check.tipo === 'impuestos' ? 'impuestos DDP cargados' : 'costo cargado';
        document.getElementById('fac-confirm-msg').innerHTML =
          `<strong>⚠ ${n} ${n === 1 ? 'guía' : 'guías'} de esta factura ya ${n === 1 ? 'tenía' : 'tenían'} ${que}.</strong><br>
          ¿Querés sobreescribir los valores anteriores con los de esta factura?`;
        show('fac-confirm');
      } else {
        // Sin duplicados → cargar directamente. Se suelta el candado antes:
        // ejecutarCarga toma el suyo propio.
        cargaEnCurso = false;
        await ejecutarCarga(false);
        return;
      }
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al verificar la factura: ' + err.message, 'error');
    } finally {
      cargaEnCurso = false;
      botonesDeCarga(false);
      btn.textContent = textoBotonCargar();
    }
  }

  async function ejecutarCarga(sobreescribir) {
    if (!pdfFile || cargaEnCurso) return;
    cargaEnCurso = true;

    hide('fac-confirm');

    const btn = document.getElementById('btn-cargar');
    botonesDeCarga(true);
    btn.textContent = 'Cargando…';

    try {
      const res = await NovaAPI.facturas.cargar(pdfFile, sobreescribir);
      mostrarResumen(res);

      // Invalidar caché de la pestaña Revisar para que recargue cuando se abra
      revisarLoaded = false;
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar la factura: ' + err.message, 'error');
    } finally {
      cargaEnCurso = false;
      botonesDeCarga(false);
      btn.textContent = textoBotonCargar();
    }
  }

  // ── Carga de VARIAS facturas de una (28/08) ─────────────────────────────────
  //
  // El caso que la pidió: recargar las 14 facturas de julio de una sola vez.
  // Los PDFs se procesan DE A UNO (el backend chequea duplicados por factura y dos
  // cargas simultáneas podrían pisarse); si alguna factura ya estaba cargada, se
  // junta todo y se pregunta UNA sola vez al final si se sobreescriben.

  async function cargarLote() {
    if (cargaEnCurso) return;
    cargaEnCurso = true;
    resetCargarUI();

    const btn = document.getElementById('btn-cargar');
    botonesDeCarga(true);

    loteFilas = pdfFiles.map((f) => ({ file: f, archivo: f.name, estado: 'pendiente' }));
    const conflictos = [];

    for (let i = 0; i < loteFilas.length; i++) {
      const fila = loteFilas[i];
      btn.textContent = `Cargando ${i + 1} de ${loteFilas.length}…`;
      try {
        fila.res = await NovaAPI.facturas.cargar(fila.file, false);
        fila.estado = 'cargada';
      } catch (err) {
        if (err.status === 409 || /ya fue cargada/i.test(err.message || '')) {
          fila.estado = 'ya_estaba';
          conflictos.push(fila);
        } else {
          fila.estado = 'error';
          fila.motivo = err.message;
        }
      }
      renderLote();
    }

    cargaEnCurso = false;
    botonesDeCarga(false);
    btn.textContent = textoBotonCargar();

    if (conflictos.length > 0) {
      loteConflictos = conflictos;
      const n = conflictos.length;
      document.getElementById('fac-confirm-msg').innerHTML =
        `<strong>⚠ ${n} ${n === 1 ? 'factura ya estaba cargada' : 'facturas ya estaban cargadas'}.</strong><br>
        ¿Querés sobreescribirlas con los valores de estos PDFs? La carga anterior de cada una se reemplaza.`;
      show('fac-confirm');
    } else {
      finalizarLote();
    }
  }

  async function continuarLoteSobreescribiendo() {
    if (cargaEnCurso || !loteConflictos) return;
    const pendientes = loteConflictos;
    loteConflictos = null;
    cargaEnCurso = true;
    hide('fac-confirm');

    const btn = document.getElementById('btn-cargar');
    botonesDeCarga(true);

    for (let i = 0; i < pendientes.length; i++) {
      const fila = pendientes[i];
      btn.textContent = `Sobreescribiendo ${i + 1} de ${pendientes.length}…`;
      try {
        fila.res = await NovaAPI.facturas.cargar(fila.file, true);
        fila.estado = 'sobreescrita';
      } catch (err) {
        fila.estado = 'error';
        fila.motivo = err.message;
      }
      renderLote();
    }

    cargaEnCurso = false;
    botonesDeCarga(false);
    btn.textContent = textoBotonCargar();
    finalizarLote();
  }

  function cerrarLoteSinSobreescribir() {
    hide('fac-confirm');
    loteConflictos = null;
    renderLote();
    finalizarLote();
  }

  function finalizarLote() {
    renderLote(true);
    // Las otras pestañas quedaron viejas: que recarguen cuando se abran, y el
    // cartelito de "Sin envío" se actualiza ya.
    revisarLoaded = false;
    sinEnvioLoaded = false;
    loadSinEnvio();
  }

  const LOTE_ESTADOS = {
    pendiente:    'En cola…',
    cargada:      '✓ Cargada',
    sobreescrita: '✓ Sobreescrita',
    ya_estaba:    'Ya estaba cargada — sin tocar',
    error:        '✗ Error',
  };

  function renderLote(final = false) {
    const listas = loteFilas.filter((f) => f.estado === 'cargada' || f.estado === 'sobreescrita');
    const errores = loteFilas.filter((f) => f.estado === 'error');
    const titulo = final
      ? `Listo: ${listas.length} de ${loteFilas.length} facturas cargadas`
        + (errores.length ? ` · ${errores.length} con error` : '')
      : `Cargando ${loteFilas.length} facturas…`;
    document.getElementById('fac-lote-titulo').textContent = titulo;

    document.getElementById('fac-lote-body').innerHTML = loteFilas.map((f) => {
      const r = f.res || {};
      const num = (v) => (v == null ? '—' : v);
      return `
        <tr>
          <td class="mono">${esc(f.archivo)}</td>
          <td class="mono">${esc(r.numero_factura || '—')}${r.tipo === 'impuestos' ? ' <span class="fac-chip-imp">impuestos DDP</span>' : ''}</td>
          <td>${num(r.total_guias)}</td>
          <td>${num(r.guardadas)}</td>
          <td>${num(r.no_encontradas)}</td>
          <td>${esc(LOTE_ESTADOS[f.estado] || f.estado)}${f.motivo ? ': ' + esc(f.motivo) : ''}</td>
        </tr>`;
    }).join('');
    show('fac-lote');
  }

  // Factura de IMPUESTOS DDP (03/09/2026): UPS factura aparte los impuestos de destino de
  // los envíos DDP, 1-2 meses después. El sistema la reconoce por el contenido y la cruza
  // por guía contra el envío, en columnas separadas del costo del flete. Acá se dice con
  // todas las letras qué tipo de factura entró, porque el resumen se lee igual y no es lo
  // mismo: una pisa costo_facturado, la otra no toca la revisión del flete.
  function bannerTipo(res) {
    if (res.tipo !== 'impuestos') return '';
    return `<div class="fac-tipo-banner">
      <strong>Factura de IMPUESTOS DDP</strong> — gastos de importación en destino.
      Se cruzó con ${res.guardadas === 1 ? 'su envío' : 'sus envíos'} por guía. No toca el costo del flete ni la revisión.
    </div>`;
  }

  function mostrarResumen(res) {
    const nums = document.getElementById('fac-resumen-nums');
    nums.innerHTML = bannerTipo(res) + `
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
      ${contadorExtra(res.no_ddp, 'Sin tilde DDP')}
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
        <td>${esc(g.factura || '')}${g.tipo === 'impuestos' ? ' <span class="fac-chip-imp">impuestos DDP</span>' : ''}<div class="em" style="font-size:11px">${esc(g.fecha_factura || '')}</div></td>
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
