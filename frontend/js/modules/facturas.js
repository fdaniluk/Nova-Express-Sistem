(function () {
  // ── Estado ──────────────────────────────────────────────────────────────────
  let pdfFile = null;             // archivo seleccionado (modo de a una)
  let pdfFiles = [];              // archivos seleccionados (varios a la vez)
  let revisarLoaded = false;      // si la pestaña Revisar ya cargó datos
  let sinEnvioLoaded = false;     // idem para la pestaña Sin envío
  let iibbLoaded = false;         // idem para Ingresos Brutos (05/10)
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
        document.getElementById('tab-iibb').classList.toggle('hidden', tab !== 'iibb');

        if (tab === 'revisar' && !revisarLoaded) loadRevisar();
        if (tab === 'sinenvio' && !sinEnvioLoaded) loadSinEnvio();
        if (tab === 'iibb' && !iibbLoaded) loadIibb();
      });
    });
    // Llegar con #iibb (desde Costos de la empresa, 08/10) abre esa pestaña.
    const pedida = (location.hash || '').slice(1);
    const btn = pedida && document.querySelector(`.tab[data-tab="${pedida}"]`);
    if (btn) btn.click();
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

    // Soltar el PDF sobre la zona (08/10/2026): mismo camino que elegirlo con el botón.
    const drop = document.getElementById('fac-drop');
    if (drop) {
      ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
      ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
      drop.addEventListener('drop', (e) => {
        const archivos = [...(e.dataTransfer?.files || [])].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
        if (!archivos.length) return;
        const dt = new DataTransfer();
        archivos.forEach((f) => dt.items.add(f));
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

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
    document.getElementById('btn-iibb-reload').addEventListener('click', () => { iibbLoaded = false; loadIibb(); });
    // Filtros de Revisar guías (08/10).
    const seg = document.getElementById('fac-revisar-estado');
    if (seg) seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-estado]');
      if (!b) return;
      revisarEstado = b.dataset.estado;
      renderRevisar();
    });
    const buscar = document.getElementById('fac-revisar-buscar');
    if (buscar) buscar.addEventListener('input', () => { revisarTexto = buscar.value; renderRevisar(); });
  }

  function resetCargarUI() {
    hide('fac-confirm');
    hide('fac-resumen');
    hide('fac-no-enc');
    hide('fac-anom');
    hide('fac-reconc');
    hide('fac-advert');
    hide('fac-lote');
    hide('fac-resultado');
    const sub = document.getElementById('fac-resultado-sub');
    if (sub) sub.textContent = '';
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
          <td>${r.con_anomalias ? `<span class="fac-chip-anom">⚠ ${r.con_anomalias}</span>` : (r.con_anomalias === 0 ? '0' : '—')}</td>
          <td>${esc(LOTE_ESTADOS[f.estado] || f.estado)}${f.motivo ? ': ' + esc(f.motivo) : ''}</td>
        </tr>`;
    }).join('');
    show('fac-lote');
    if (final) {
      const todas = [];
      for (const f of loteFilas) for (const a of ((f.res && f.res.anomalias_lista) || [])) todas.push({ ...a, factura: f.res.numero_factura });
      renderAnomalias(todas);
    }
  }

  // Cargos no previstos (05/10): una fila por guía, con la lista de lo que la factura trae
  // de más respecto de lo que el envío tenía calculado.
  function renderAnomalias(lista) {
    if (!Array.isArray(lista) || !lista.length) { hide('fac-anom'); return; }
    const clase = { no_previsto: 'fac-anom-np', mas_caro: 'fac-anom-mc', peso: 'fac-anom-peso' };
    document.getElementById('fac-anom-titulo').textContent = `${lista.length} guía${lista.length > 1 ? 's' : ''} con cargos no previstos`;
    document.getElementById('fac-anom-body').innerHTML = lista.map((g) => `
      <tr>
        <td class="mono">${esc(g.numero_guia)}</td>
        <td class="mono">${esc(g.factura || '')}</td>
        <td>${esc(g.pais || '')}</td>
        <td>${(g.anomalias || []).map((a) => `<span class="fac-chip-anom ${clase[a.clase] || ''}">${esc(a.texto)}</span>`).join(' ')}</td>
        <td><a class="btn btn-sm btn-outline" href="salidas.html?buscar=${encodeURIComponent(g.numero_guia)}">Ver en Salidas</a></td>
      </tr>`).join('');
    show('fac-anom');
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
      Los impuestos quedan como <strong>cargo al cliente</strong>: entran en la liquidación del envío o, si ya estaba liquidado, en la próxima liquidación del cliente como "cargo de envío anterior".
      ${res.impuestos_ya_liquidados > 0 ? `<br><strong>Ojo:</strong> ${res.impuestos_ya_liquidados} ${res.impuestos_ya_liquidados === 1 ? 'guía ya tenía sus impuestos cobrados' : 'guías ya tenían sus impuestos cobrados'} en una liquidación confirmada y el monto cambió; no se tocó: ${(res.impuestos_ya_liquidados_lista || []).map((g) => `${g.numero_guia} (liq. #${g.liquidacion_id})`).join(', ')}.` : ''}
    </div>`;
  }

  function mostrarResumen(res) {
    const nums = document.getElementById('fac-resumen-nums');
    nums.innerHTML = bannerTipo(res) + `
      <div class="fac-resumen-item">
        <div class="fac-resumen-val">${res.total_guias}</div>
        <div class="fac-resumen-lbl">Guías en la factura</div>
      </div>
      <div class="fac-resumen-item">
        <div class="fac-resumen-val ok">${res.guardadas}</div>
        <div class="fac-resumen-lbl">Cruzadas con envío</div>
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
        <div class="fac-resumen-lbl">Sin envío</div>
      </div>
      ${contadorExtra(res.sin_costo, 'Sin costo')}
      ${contadorExtra(res.errores, 'Con error')}
      ${contadorExtra(res.no_ddp, 'Sin tilde DDP')}
      ${contadorExtra(res.con_anomalias, 'Con cargos no previstos')}
    `;
    show('fac-resumen');
    const sub = document.getElementById('fac-resultado-sub');
    if (sub) sub.textContent = [res.numero_factura ? `factura ${res.numero_factura}` : '', res.courier || '', res.fecha_factura ? NovaUtils.formatDate(res.fecha_factura) : ''].filter(Boolean).join(' · ');
    renderAnomalias((res.anomalias_lista || []).map((a) => ({ ...a, factura: res.numero_factura })));

    // El backend ya devolvía estos datos; la pantalla no los mostraba.
    renderReconciliacion(res.reconciliacion);
    renderAdvertencias(res.advertencias, res.advertencia_conteo);

    if (res.no_encontradas > 0 && res.no_encontradas_lista?.length > 0) {
      const tbody = document.getElementById('fac-no-enc-body');
      tbody.innerHTML = res.no_encontradas_lista.map((g) => `
        <tr>
          <td class="mono">${esc(g.numero_guia)}</td>
          <td>${esc(g.pais)}</td>
          <td class="num">$${Number(g.costo_total).toFixed(2)}</td>
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
    const usd = (v) => `USD ${Number(v).toFixed(2)}`;
    const hayExtras = Boolean(rec.percepciones || rec.iva);
    box.className = `fac-reconc ${cuadra ? 'ok' : 'warn'}`;
    box.innerHTML = `
      <div class="fac-reconc-title">
        ${cuadra ? '✓ La factura cuadra' : '⚠ La factura NO cuadra'}
        ${rec.courier ? `<span class="fac-chip-courier fac-chip-${esc(String(rec.courier).toLowerCase())}">${esc(rec.courier)}</span>` : ''}
      </div>
      <dl class="fac-reconc-nums">
        <dt>Suma de las guías</dt><dd><b>${usd(rec.suma_guias)}</b></dd>
        ${rec.iva ? `<dt>IVA (sobre lo gravado)</dt><dd>${usd(rec.iva)}</dd>` : ''}
        ${rec.percepciones ? `<dt>Percepción IIBB</dt><dd>${usd(rec.percepciones)}</dd>` : ''}
        <dt class="tot">Total de la factura</dt><dd class="tot">${usd(rec.total_declarado)}</dd>
        ${hayExtras && cuadra ? '' : `<dt>Diferencia</dt><dd class="dif">${usd(rec.diferencia)}</dd>`}
      </dl>
      ${hayExtras ? `
        <div class="fac-reconc-nota">
          ${rec.iva ? 'El IVA (crédito fiscal) y la percepción' : 'La percepción'} de Ingresos Brutos <b>no se reparten entre los envíos</b>: quedan en la pestaña "Ingresos Brutos". El costo de cada guía es el del detalle.
        </div>` : (cuadra ? '' : `
        <div class="fac-reconc-nota">
          La suma de las guías no da el total de la factura y no se pudo identificar la diferencia
          como percepción de Ingresos Brutos. Revisá la factura: puede haber una guía que no se leyó.
        </div>`)}
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
      <div class="fac-seccion-titulo"><h4>Avisos del lector</h4><span class="em">${lista.length}</span></div>
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

  // Fecha de corte del control (07/09, Configuración): las dos bandejas arrancan mostrando
  // solo lo posterior al corte; "ver anteriores" trae todo. Por pestaña, no persiste.
  let sinEnvioTodo = false;
  let revisarTodo = false;

  function pintarNotaCorte(el, { fecha_corte, anteriores, todo }, onToggle) {
    if (!el) return;
    if (!fecha_corte) { el.innerHTML = ''; return; }
    const f = NovaUtils.formatDate(fecha_corte);
    el.innerHTML = todo
      ? `Mostrando <b>todo</b>, incluido lo anterior al ${esc(f)}. <a data-corte-toggle>Volver a mostrar desde el ${esc(f)}</a>`
      : `Mostrando desde el <b>${esc(f)}</b> (fecha de corte del control, en Configuración).`
        + (anteriores > 0 ? ` Hay <b>${anteriores}</b> anterior${anteriores > 1 ? 'es' : ''} que no se muestra${anteriores > 1 ? 'n' : ''}. <a data-corte-toggle>Ver anteriores</a>` : '');
    const a = el.querySelector('[data-corte-toggle]');
    if (a) a.addEventListener('click', onToggle);
  }

  async function loadSinEnvio() {
    const tbody = document.getElementById('fac-sinenvio-body');
    const counter = document.getElementById('fac-sinenvio-counter');
    const badge = document.getElementById('sinenvio-badge');
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Cargando…</td></tr>';
    try {
      const res = await NovaAPI.facturas.sinEnvio(sinEnvioTodo);
      sinEnvioLoaded = true;
      const guias = res.guias || [];
      pintarNotaCorte(document.getElementById('fac-sinenvio-corte'),
        { fecha_corte: res.fecha_corte, anteriores: res.anteriores || 0, todo: sinEnvioTodo },
        () => { sinEnvioTodo = !sinEnvioTodo; loadSinEnvio(); });

      if (badge) {
        badge.textContent = guias.length;
        badge.classList.toggle('hidden', guias.length === 0);
      }
      counter.textContent = guias.length
        ? `${guias.length} guía${guias.length > 1 ? 's' : ''} · ${fmtUSD(res.costo_total)} facturados`
        : '';

      // Tarjetas de totales (08/10): cuántas, cuánta plata y cuántas quedaron antes del corte.
      const tiles = document.getElementById('fac-sinenvio-tiles');
      if (tiles) {
        tiles.innerHTML = `
          <div class="fac-tile ${guias.length ? 'danger' : 'ok'}"><div class="fac-tile-v">${guias.length}</div><div class="fac-tile-l">Guías ${sinEnvioTodo ? 'en total' : 'desde el corte'}</div></div>
          <div class="fac-tile ${guias.length ? 'danger' : 'ok'}"><div class="fac-tile-v">${fmtUSD(res.costo_total || 0)}</div><div class="fac-tile-l">Costo sin imputar</div></div>
          ${!sinEnvioTodo && res.anteriores ? `<div class="fac-tile"><div class="fac-tile-v">${res.anteriores}</div><div class="fac-tile-l">Anteriores al corte (ocultas)</div></div>` : ''}`;
        tiles.classList.remove('hidden');
      }

      if (!guias.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">Ninguna. Todas las guías facturadas tienen su envío cargado.</td></tr>';
        return;
      }

      tbody.innerHTML = guias.map((g) => `<tr>
        <td class="mono">${esc(g.numero_guia)}</td>
        <td>${courierChip(g.courier)}</td>
        <td>${esc(g.factura || '')}${g.tipo === 'impuestos' ? ' <span class="fac-chip-imp">impuestos DDP</span>' : ''}<div class="em" style="font-size:11px">${g.fecha_factura ? NovaUtils.formatDate(g.fecha_factura) : ''}</div></td>
        <td>${esc(g.pais || '')}</td>
        <td class="num">${g.peso_facturado != null ? Number(g.peso_facturado).toFixed(1) + ' kg' : '<span class="em">—</span>'}</td>
        <td class="num">${fmtUSD(g.costo_total)}</td>
      </tr>`).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">No se pudo cargar: ${esc(e.message || e)}</td></tr>`;
    }
  }

  // ── Pestaña INGRESOS BRUTOS (05/10/2026) ───────────────────────────────────
  // La percepción de IIBB de cada factura, fuera de los envíos. Por mes y por factura.
  async function loadIibb() {
    const tbody = document.getElementById('fac-iibb-body');
    const counter = document.getElementById('fac-iibb-counter');
    const meses = document.getElementById('fac-iibb-meses');
    tbody.innerHTML = '<tr><td colspan="8" class="empty">Cargando…</td></tr>';
    try {
      const res = await NovaAPI.facturas.percepciones();
      iibbLoaded = true;
      const lista = res.facturas || [];
      counter.textContent = lista.length ? `${lista.length} factura${lista.length > 1 ? 's' : ''} · ${fmtUSD(res.total)} de percepción${res.iva ? ` · ${fmtUSD(res.iva)} de IVA` : ''}` : '';
      const pm = Object.entries(res.por_mes || {}).sort((a, b) => b[0].localeCompare(a[0]));
      const ivaPm = res.iva_por_mes || {};
      meses.innerHTML = pm.map(([m, v]) => `<div class="fac-iibb-mes"><span class="em">${esc(m)}</span><b>${fmtUSD(v)}</b><span class="em">percepción</span>${ivaPm[m] ? `<span class="em">· IVA ${fmtUSD(ivaPm[m])}</span>` : ''}</div>`).join('');
      if (!lista.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty">Ninguna factura cargada tiene percepción de Ingresos Brutos ni IVA.</td></tr>';
        return;
      }
      tbody.innerHTML = lista.map((f) => `<tr>
        <td class="mono">${esc(f.numero_factura || '')}${f.tipo === 'impuestos' ? ' <span class="fac-chip-imp">impuestos DDP</span>' : ''}</td>
        <td><span class="fac-chip-courier fac-chip-${esc(String(f.courier || 'ups').toLowerCase())}">${esc(f.courier || 'UPS')}</span></td>
        <td>${f.fecha_factura ? NovaUtils.formatDate(f.fecha_factura) : '<span class="em">—</span>'}</td>
        <td class="num">${f.guias}</td>
        <td class="num">${f.subtotal_factura != null ? fmtUSD(f.subtotal_factura) : '<span class="em">—</span>'}</td>
        <td class="num">${f.iva ? fmtUSD(f.iva) : '<span class="em">—</span>'}</td>
        <td class="num"><b>${f.percepciones != null ? fmtUSD(f.percepciones) : '—'}</b></td>
        <td class="num">${f.total_declarado != null ? fmtUSD(f.total_declarado) : '<span class="em">—</span>'}</td>
      </tr>`).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty">No se pudo cargar: ${esc(e.message || e)}</td></tr>`;
    }
  }

  async function loadRevisar() {
    const tbody = document.getElementById('fac-table-body');
    const counter = document.getElementById('fac-revisar-counter');

    tbody.innerHTML = '<tr><td colspan="11" class="empty">Cargando…</td></tr>';
    counter.textContent = '';

    try {
      const res = await NovaAPI.facturas.guias(revisarTodo);
      // Desde el 07/09 la API devuelve { guias, fecha_corte, anteriores, todo }.
      revisarData = Array.isArray(res) ? res : (res.guias || []);
      revisarLoaded = true;
      pintarNotaCorte(document.getElementById('fac-revisar-corte'),
        { fecha_corte: res.fecha_corte, anteriores: res.anteriores || 0, todo: revisarTodo },
        () => { revisarTodo = !revisarTodo; loadRevisar(); });
      const pill = document.getElementById('fac-corte-pill');
      if (pill && res.fecha_corte) { pill.textContent = `corte ${NovaUtils.formatDate(res.fecha_corte)}`; pill.classList.remove('hidden'); }
      renderRevisar();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="11" class="empty" style="color:var(--color-danger)">Error al cargar: ${esc(err.message)}</td></tr>`;
    }
  }

  // Filtros de la bandeja (08/10/2026): estado (a revisar / en reclamo / todas) y texto
  // (cliente o guía). Son de pantalla: la API trae las dos bandejas juntas.
  let revisarEstado = 'a_revisar';
  let revisarTexto = '';

  function renderRevisar() {
    const tbody = document.getElementById('fac-table-body');
    const counter = document.getElementById('fac-revisar-counter');
    const badge = document.getElementById('revisar-badge');
    if (badge) {
      badge.textContent = revisarData.length;
      badge.classList.toggle('hidden', revisarData.length === 0);
    }
    const seg = document.getElementById('fac-revisar-estado');
    if (seg) {
      const n = (e) => revisarData.filter((g) => (g.estado_revision || '') === e).length;
      seg.querySelectorAll('button').forEach((b) => {
        const e = b.dataset.estado;
        b.classList.toggle('on', e === revisarEstado);
        b.textContent = e === 'a_revisar' ? `A revisar · ${n('a_revisar')}` : e === 'reclamar' ? `En reclamo · ${n('reclamar')}` : `Todas · ${revisarData.length}`;
      });
    }
    const t = revisarTexto.trim().toLowerCase();
    const lista = revisarData.filter((g) => (!revisarEstado || (g.estado_revision || '') === revisarEstado)
      && (!t || String(g.cliente || '').toLowerCase().includes(t) || String(g.numero_guia || '').toLowerCase().includes(t)));

    counter.textContent = lista.length === revisarData.length ? `${revisarData.length} guías` : `${lista.length} de ${revisarData.length} guías`;

    if (revisarData.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" class="empty">No hay guías con costo facturado aún.</td></tr>';
      return;
    }
    if (lista.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" class="empty">Ninguna guía con ese filtro.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    for (const g of lista) {
      tbody.appendChild(buildRevisarRow(g));
    }
  }

  function courierChip(c, servicio) {
    const cc = c === 'DHL' ? 'DHL' : 'UPS';
    const det = cc === 'UPS' && servicio ? ` <span class="em">${esc(servicioUPSLabel(servicio))}</span>` : '';
    return `<span class="fac-chip-courier fac-chip-${cc.toLowerCase()}">${cc}</span>${det}`;
  }

  function buildRevisarRow(g) {
    const tr = document.createElement('tr');
    tr.dataset.id = g.id;

    const estado = g.estado_revision || '';
    if (estado === 'a_revisar') tr.classList.add('row-a-revisar');
    else if (estado === 'reclamar') tr.classList.add('row-reclamar');

    const clase = { no_previsto: 'fac-anom-np', mas_caro: 'fac-anom-mc', peso: 'fac-anom-peso' };
    // Motivo (08/10): las anomalías de la factura o, si no hay, el margen bajo el mínimo.
    const anom = (g.anomalias || []).length
      ? `<div class="fac-anom-fila">${g.anomalias.map((a) => `<span class="fac-chip-anom ${clase[a.clase] || ''}">${esc(a.texto)}</span>`).join(' ')}</div>`
      : (!(Number(g.total_cobrado) > 0) ? '<span class="em">sin precio de venta</span>' : (g.ganancia_pct != null && estado === 'a_revisar' ? '<span class="em">margen bajo el mínimo</span>' : ''));
    const sinPrecio = !(Number(g.total_cobrado) > 0);
    tr.innerHTML = `
      <td class="mono">${esc(g.numero_guia)}</td>
      <td>${esc(g.cliente)}</td>
      <td>${esc(g.pais_destino)}</td>
      <td>${courierChip(g.courier_facturado, g.servicio_ups)}</td>
      <td>${NovaUtils.formatDate(g.fecha_facturado)}</td>
      <td class="num">${sinPrecio ? '<span class="fac-chip-gris">sin precio</span>' : fmtUSD(g.total_cobrado)}</td>
      <td class="num">${fmtUSD(g.costo_facturado)}</td>
      <td class="num">${gainCell(g.ganancia_usd)}</td>
      <td class="num">${pctCell(g.ganancia_pct)}</td>
      <td class="fac-motivo">${anom}</td>
      <td class="fac-estado">${estadoBadge(estado)}${accionesBtns(g.id, estado)}</td>
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
      cells[10].innerHTML = estadoBadge(nuevoEstado) + accionesBtns(id, nuevoEstado);

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
      'a_revisar':   ['badge-a-revisar',   'a revisar'],
      'revisado_ok': ['badge-revisado-ok',  'revisado OK'],
      'reclamar':    ['badge-reclamar',     'en reclamo'],
    };
    const [cls, label] = map[estado] || ['', estado];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function accionesBtns(id, estado) {
    if (estado === 'a_revisar') {
      return `<div class="fac-action-btns">
        <button class="btn btn-sm btn-outline btn-ok btn-accion" data-estado="revisado_ok" data-id="${id}">✓ Aprobar</button>
        <button class="btn btn-sm btn-outline btn-reclamar btn-accion" data-estado="reclamar" data-id="${id}">Reclamar</button>
      </div>`;
    }
    if (estado === 'reclamar') {
      return `<div class="fac-action-btns">
        <button class="btn btn-sm btn-outline btn-ok btn-accion" data-estado="revisado_ok" data-id="${id}">✓ Aprobar</button>
        <button class="btn btn-sm btn-outline btn-accion" data-estado="a_revisar" data-id="${id}">Volver a revisar</button>
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

  // Lo que vive adentro del paso 2 ("Resultado de la carga"): mostrar cualquiera de estos
  // destapa el paso entero (estética 08/10/2026).
  const EN_RESULTADO = new Set(['fac-resumen', 'fac-reconc', 'fac-advert', 'fac-anom', 'fac-no-enc', 'fac-lote']);
  function show(id) {
    document.getElementById(id).classList.remove('hidden');
    if (EN_RESULTADO.has(id)) { const r = document.getElementById('fac-resultado'); if (r) r.classList.remove('hidden'); }
  }
  function hide(id) { document.getElementById(id).classList.add('hidden'); }

  init();
})();
