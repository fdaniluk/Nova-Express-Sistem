(function () {
  const alertBox = document.getElementById('alert-box');
  const params = new URLSearchParams(window.location.search);
  const clienteId = params.get('id');

  let clienteData = null;
  let enEdicion = false;

  async function init() {
    if (!clienteId) {
      document.getElementById('info-grid').innerHTML =
        '<p class="alert alert-error">No se especificó un cliente.</p>';
      return;
    }
    try {
      const perfil = await NovaAPI.clientes.perfil(clienteId);
      clienteData = perfil.cliente;
      document.getElementById('page-title').textContent = clienteData.nombre;
      renderInfoGrid(clienteData);
      renderStats(perfil.stats);
      renderChart(perfil.utilidad_mensual);
      renderGuias(perfil.guias);
      bindEdicion(perfil);
      await cargarDirecciones();
      bindDirecciones();
      bindTarifas();
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar perfil: ' + err.message);
    }
  }

  // ── Info del cliente ──────────────────────────────────

  const CAMPOS = [
    { key: 'nombre',               label: 'Razón social',          type: 'text',   full: false },
    { key: 'cuit',                  label: 'CUIT',                  type: 'text',   full: false },
    { key: 'tipo_cobro',            label: 'Tipo de cobro',         type: 'select', opts: ['D','S','Q','CC'], labels: ['Diario','Semanal','Quincenal','Cta. Cte.'], full: false },
    { key: 'tarifa_pct',            label: '% Tarifa (profit)',     type: 'number', full: false },
    { key: 'tipo_facturacion',      label: 'Tipo facturación',      type: 'select', opts: ['Responsable inscripto','Monotributista','Exento','Consumidor final'], full: false },
    { key: 'contacto',             label: 'Contacto',              type: 'text',   full: false },
    { key: 'email',                label: 'Email',                 type: 'email',  full: false },
    { key: 'whatsapp',             label: 'WhatsApp',              type: 'text',   full: false },
    { key: 'codigo_postal',        label: 'Código postal',         type: 'text',   full: false },
    { key: 'localidad',            label: 'Localidad',             type: 'text',   full: false },
    { key: 'direccion_recoleccion',label: 'Dirección recolección', type: 'text',   full: true  },
  ];

  function renderInfoGrid(c) {
    const grid = document.getElementById('info-grid');
    grid.innerHTML = CAMPOS.map((campo) => {
      const raw = c[campo.key];
      let displayVal = raw != null && raw !== '' ? raw : '—';

      // Para select con labels legibles
      if (campo.type === 'select' && campo.labels && raw != null) {
        const idx = campo.opts.indexOf(raw);
        if (idx >= 0) displayVal = campo.labels[idx];
      }
      if (campo.key === 'tarifa_pct') displayVal = raw != null ? raw + '%' : '—';

      let inputEl = '';
      if (campo.type === 'select') {
        const opts = campo.opts
          .map((o, i) => `<option value="${o}" ${o === raw ? 'selected' : ''}>${campo.labels ? campo.labels[i] : o}</option>`)
          .join('');
        inputEl = `<select id="pf-${campo.key}">${opts}</select>`;
      } else {
        inputEl = `<input type="${campo.type}" id="pf-${campo.key}" value="${raw != null ? raw : ''}" ${campo.key === 'tarifa_pct' ? 'min="0" max="500" step="0.5"' : ''}>`;
      }

      return `<div class="info-field${campo.full ? ' full' : ''}" id="field-${campo.key}">
        <span class="field-label">${campo.label}</span>
        <span class="field-value">${displayVal}</span>
        ${inputEl}
      </div>`;
    }).join('');
  }

  // ── Stats ─────────────────────────────────────────────

  function renderStats(stats) {
    document.getElementById('stat-guias').textContent = stats.total_guias;
    document.getElementById('stat-utilidad').textContent = NovaUtils.formatMoney(stats.utilidad_total_usd);
    document.getElementById('stat-ultima-liq').textContent = stats.ultima_liquidacion || '—';
  }

  // ── Chart utilidad mensual ────────────────────────────

  function renderChart(mensual) {
    const canvas = document.getElementById('chart-mensual');
    const emptyMsg = document.getElementById('chart-empty');
    if (!mensual || !mensual.length) {
      canvas.classList.add('hidden');
      emptyMsg.classList.remove('hidden');
      return;
    }

    // Mostrar en orden cronológico (la API devuelve DESC)
    const data = [...mensual].reverse();

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const pad = { top: 24, right: 12, bottom: 36, left: 70 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    const maxVal = Math.max(...data.map((d) => d.utilidad_usd), 1);
    const barW = Math.max(10, (cw / data.length) * 0.55);
    const gap = cw / data.length;

    // Gridlines + Y labels
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + ch * (1 - i / 4);
      ctx.strokeStyle = '#e2e8f0';
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + cw, y);
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(NovaUtils.formatMoney((maxVal * i) / 4), pad.left - 6, y + 3);
    }

    data.forEach((d, i) => {
      const barH = Math.max(2, (d.utilidad_usd / maxVal) * ch);
      const x = pad.left + i * gap + (gap - barW) / 2;
      const y = pad.top + ch - barH;

      // Bar
      ctx.fillStyle = '#1a3a5c';
      ctx.fillRect(x, y, barW, barH);

      // Envíos tooltip dentro de la barra si hay espacio
      if (barH > 18) {
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(d.cantidad_envios + ' env.', x + barW / 2, y + 12);
      }

      // X label (mes YYYY-MM → MM/YYYY)
      const [anio, mes] = d.mes.split('-');
      ctx.fillStyle = '#64748b';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${mes}/${anio.slice(2)}`, x + barW / 2, h - 6);
    });
  }

  // ── Tabla de guías ────────────────────────────────────

  function renderGuias(guias) {
    const tbody = document.getElementById('tabla-guias');
    if (!guias || !guias.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">Este cliente no tiene envíos registrados.</td></tr>';
      return;
    }
    tbody.innerHTML = guias
      .map(
        (g) => `<tr>
        <td>${NovaUtils.formatDate(g.fecha)}</td>
        <td style="font-family:monospace;font-size:0.85rem">${g.numero_guia}</td>
        <td>${g.pais}</td>
        <td><span class="badge badge-${g.courier.toLowerCase()}">${g.courier}</span></td>
        <td>${g.asegurado ? 'Sí' : 'No'}</td>
        <td>${NovaUtils.formatMoney(g.total_cobrado_usd)}</td>
        <td style="color:var(--color-success);font-weight:600">${NovaUtils.formatMoney(g.utilidad_usd)}</td>
        <td><span class="badge badge-${g.estado}">${g.estado}</span></td>
      </tr>`
      )
      .join('');
  }

  // ── Edición inline ────────────────────────────────────

  function bindEdicion(perfil) {
    const btnEditar = document.getElementById('btn-editar');
    const btnGuardar = document.getElementById('btn-guardar');
    const btnCancelar = document.getElementById('btn-cancelar-edit');

    btnEditar.addEventListener('click', () => {
      enEdicion = true;
      document.querySelectorAll('.info-field').forEach((f) => f.classList.add('editing'));
      btnEditar.classList.add('hidden');
      btnGuardar.classList.remove('hidden');
      btnCancelar.classList.remove('hidden');
    });

    btnCancelar.addEventListener('click', () => {
      enEdicion = false;
      document.querySelectorAll('.info-field').forEach((f) => f.classList.remove('editing'));
      btnEditar.classList.remove('hidden');
      btnGuardar.classList.add('hidden');
      btnCancelar.classList.add('hidden');
      // Restaurar valores originales
      renderInfoGrid(clienteData);
    });

    btnGuardar.addEventListener('click', async () => {
      try {
        const data = {};
        CAMPOS.forEach((campo) => {
          const el = document.getElementById(`pf-${campo.key}`);
          if (!el) return;
          const val = el.value.trim();
          if (campo.key === 'tarifa_pct') data[campo.key] = parseFloat(val) || 0;
          else if (campo.key === 'nombre') data.razon_social = val;
          else data[campo.key] = val || null;
        });

        const updated = await NovaAPI.clientes.actualizar(clienteId, data);
        clienteData = updated;
        NovaUtils.showAlert(alertBox, 'Datos actualizados correctamente', 'success');
        document.getElementById('page-title').textContent = updated.nombre;

        enEdicion = false;
        document.querySelectorAll('.info-field').forEach((f) => f.classList.remove('editing'));
        btnEditar.classList.remove('hidden');
        btnGuardar.classList.add('hidden');
        btnCancelar.classList.add('hidden');
        renderInfoGrid(updated);

        // Refrescar stats y guías con datos actualizados
        const nuevoPerfil = await NovaAPI.clientes.perfil(clienteId);
        renderStats(nuevoPerfil.stats);
        renderChart(nuevoPerfil.utilidad_mensual);
        renderGuias(nuevoPerfil.guias);
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      }
    });
  }

  // ── Direcciones de recolección ────────────────────────

  let direcciones = [];

  async function cargarDirecciones() {
    try {
      direcciones = await NovaAPI.clientes.direcciones.listar(clienteId);
      renderDirecciones();
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar direcciones: ' + err.message);
    }
  }

  function renderDirecciones() {
    const list = document.getElementById('dirs-list');
    if (!direcciones.length) {
      list.innerHTML = '<li style="color:var(--color-muted);font-size:0.9rem">Sin direcciones registradas.</li>';
      return;
    }
    list.innerHTML = direcciones
      .map(
        (d) => `<li>
          <span class="dir-text">${d.direccion}</span>
          ${d.es_principal ? '<span class="badge-principal">principal</span>' : ''}
          <button class="btn-borrar-dir" data-dir-id="${d.id}" title="Eliminar" ${d.es_principal ? 'disabled' : ''}>✕</button>
        </li>`
      )
      .join('');

    list.querySelectorAll('.btn-borrar-dir:not(:disabled)').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const dirId = btn.dataset.dirId;
        if (!confirm('¿Eliminar esta dirección?')) return;
        try {
          await NovaAPI.clientes.direcciones.borrar(clienteId, dirId);
          await cargarDirecciones();
        } catch (err) {
          NovaUtils.showAlert(alertBox, err.message);
        }
      });
    });
  }

  function bindDirecciones() {
    const btnAgregar = document.getElementById('btn-agregar-dir');
    const addForm = document.getElementById('add-dir-form');
    const inputDir = document.getElementById('nueva-direccion');
    const btnGuardar = document.getElementById('btn-guardar-dir');
    const btnCancelar = document.getElementById('btn-cancelar-dir');

    btnAgregar.addEventListener('click', () => {
      addForm.classList.add('visible');
      btnAgregar.style.display = 'none';
      inputDir.focus();
    });

    btnCancelar.addEventListener('click', () => {
      addForm.classList.remove('visible');
      btnAgregar.style.display = '';
      inputDir.value = '';
    });

    btnGuardar.addEventListener('click', async () => {
      const dir = inputDir.value.trim();
      if (!dir) return;
      try {
        await NovaAPI.clientes.direcciones.agregar(clienteId, dir);
        inputDir.value = '';
        addForm.classList.remove('visible');
        btnAgregar.style.display = '';
        await cargarDirecciones();
        NovaUtils.showAlert(alertBox, 'Dirección agregada', 'success');
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      }
    });

    inputDir.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btnGuardar.click();
      if (e.key === 'Escape') btnCancelar.click();
    });
  }

  // ── Matriz de tarifas ─────────────────────────────────
  // UI de edición. Un cliente puede cobrar de DOS maneras y esta pantalla las edita a las
  // dos, con la misma grilla:
  //   'porcentaje' → % de ganancia sobre el flete del courier (tabla profit_overrides).
  //                  Bandas de peso FIJAS, las mismas para todos.
  //   'por_kg'     → precio fijo en USD por kilo (tabla tarifa_kg_overrides). Los rangos
  //                  de peso los define cada cliente.
  // El modo lo guarda clientes.modo_tarifa y vale para las seis tablas del cliente.

  let matrizActual = null;
  // General de la matriz de PROFIT de la tabla activa. En modo por kilo hace falta para
  // poder decir en la grilla con qué porcentaje se cobra una zona que no tiene precio por
  // kilo, sin ir al servidor celda por celda.
  let matrizProfitGeneral = null;
  let tabActivo = { servicio: 'DHL', tipo: 'export' };
  let tarifasCargado = false;

  const esPorKg = () => (clienteData && clienteData.modo_tarifa) === 'por_kg';

  // Tramos de peso del cliente (kg sobre peso facturable). NO son fijos: cada cliente puede
  // tener el suyo. Se traen del backend, que es el que manda; acá solo se dibujan. El juego
  // por defecto que hereda quien no tiene propios también viene en la respuesta, para poder
  // decirle a la persona si está viendo lo heredado o algo negociado.
  //
  // Arrancan en el por defecto por si la grilla se dibuja antes de que conteste el servidor.
  let TARIFAS_BANDAS = [
    { min: 0, max: 5 },
    { min: 5, max: 10 },
    { min: 10, max: 15 },
    { min: 15, max: 20 },
    { min: 20, max: 25 },
    { min: 25, max: 30 },
    { min: 30, max: 35 },
    { min: 35, max: 40 },
    { min: 40, max: 45 },
    { min: 45, max: 50 },
    { min: 50, max: null },
  ];
  let tramosPropios = false;
  const TARIFAS_ZONAS = [1, 2, 3, 4, 5, 6];

  // Trae los tramos del cliente. Si falla, se sigue con los que haya: es preferible una
  // grilla dibujada con el juego por defecto a una pantalla en blanco.
  async function cargarTramos() {
    try {
      const r = await NovaAPI.clientes.tramos.obtener(clienteId);
      if (r && Array.isArray(r.tramos) && r.tramos.length > 0) {
        TARIFAS_BANDAS = r.tramos;
        tramosPropios = Boolean(r.propios);
      }
    } catch { /* se dibuja con los por defecto */ }
  }

  // En modo porcentaje la última banda es la de 50+; en modo por kilo el rango sin tope lo
  // define el cliente, así que la etiqueta sale del propio "desde" y no de un 50 fijo.
  function bandaLabel(b) {
    return b.max === null ? `${b.min}+ kg` : `${b.min}-${b.max} kg`;
  }

  // Overrides de la matriz actual por nivel.
  function overrideCelda(zona, min) {
    return matrizActual.overrides.find((o) => o.zona === zona && o.peso_min === min) || null;
  }
  function overrideBanda(min) {
    return matrizActual.overrides.find((o) => o.zona === null && o.peso_min === min) || null;
  }
  function overrideZona(zona) {
    return matrizActual.overrides.find((o) => o.zona === zona && o.peso_min === null) || null;
  }

  // El valor guardado se llama distinto en cada tabla (profit_pct vs precio_kg); el resto
  // de la grilla es idéntico, así que se lee siempre por acá.
  function valorDe(o) {
    if (!o) return null;
    return esPorKg() ? o.precio_kg : o.profit_pct;
  }

  // Valor efectivo con precedencia: celda → banda/rango → zona → general de tabla →
  // general del cliente (solo en modo porcentaje; en modo por kilo no hay fallback y la
  // celda queda vacía, que es justo lo que hay que ver para saber que falta cargarla).
  // Sólo el override de nivel celda cuenta como "propio" (resaltado + crucecita).
  function valorEfectivo(zona, banda) {
    const celda = overrideCelda(zona, banda.min);
    if (celda) return { val: valorDe(celda), propio: true };
    const ob = overrideBanda(banda.min);
    if (ob) return { val: valorDe(ob), propio: false };
    const oz = overrideZona(zona);
    if (oz) return { val: valorDe(oz), propio: false };
    if (matrizActual.general_tabla) return { val: valorDe(matrizActual.general_tabla), propio: false };
    // Modo por kilo sin ningun precio que aplique: ese peso y esa zona se cobran con el
    // PORCENTAJE de ganancia del cliente. El motor ya lo hace asi (resolverTarifaVenta cae
    // al porcentaje); antes la grilla mostraba un guion, que se leia como un agujero de
    // carga. Es justamente el caso MIXTO: una zona por kilo y las otras por porcentaje.
    if (esPorKg()) return { val: null, propio: false, porPct: true };
    const cli = clienteData && clienteData.tarifa_pct != null ? clienteData.tarifa_pct : 0;
    return { val: cli, propio: false };
  }

  // Porcentaje que le queda a una celda que NO tiene precio por kilo. Es el mismo orden de
  // precedencia que resuelve el backend, pero leido de la matriz de profit del cliente para
  // poder mostrarlo sin ir al servidor. Si no hay nada, el porcentaje general del cliente.
  function pctDeRespaldo() {
    const g = matrizProfitGeneral;
    if (g !== null && g !== undefined) return g;
    return clienteData && clienteData.tarifa_pct != null ? clienteData.tarifa_pct : 0;
  }

  // Cómo se muestra un valor en la grilla: "12%" o "USD 5.00".
  function formatoValor(val) {
    if (val === null || val === undefined) return '—';
    return esPorKg() ? `USD ${Number(val).toFixed(2)}` : `${val}%`;
  }

  // Filas de la grilla: SIEMPRE los tramos del cliente, cobre por porcentaje o por kilo.
  //
  // Hasta el 11/08/2026 el modo por kilo dejaba que cada cliente inventara sus rangos, y la
  // grilla mostraba solo los que tuviera cargados. Eso hacía que la pantalla NO mostrara los
  // huecos: si alguien cargaba 1 a 3 kg, la fila de 3 a 5 no existía —ni en la pantalla ni
  // en la cabeza de nadie— y un envío de 4 kg terminaba cobrándose por porcentaje sin que se
  // enterara nadie. Encima los rangos podían pisarse entre sí.
  //
  // Ahora los tramos del cliente se muestran siempre, llenos o vacíos: un hueco pasa a ser
  // una celda gris que se ve. Y el juego está validado de punta a punta en el backend, así
  // que no puede tener agujeros ni solapes.
  //
  // ⚠️ Las filas que NO caen en ningún tramo del cliente se siguen mostrando, marcadas.
  // Son cargas viejas que todavía no se migraron. Si se mostraran solo los tramos, esas
  // filas desaparecerían de la pantalla mientras el sistema les sigue cobrando esos
  // precios. Un precio que se cobra y no se ve es exactamente lo que estamos evitando.
  function filasDeGrilla() {
    const viejas = (matrizActual ? matrizActual.overrides : [])
      .filter((o) => o.peso_min !== null && !TARIFAS_BANDAS.some((b) => b.min === o.peso_min && b.max === o.peso_max));
    const vistas = new Map();
    viejas.forEach((o) => {
      const k = `${o.peso_min}|${o.peso_max}`;
      if (!vistas.has(k)) vistas.set(k, { min: o.peso_min, max: o.peso_max, vieja: true });
    });
    if (vistas.size === 0) return TARIFAS_BANDAS;
    return [...TARIFAS_BANDAS, ...vistas.values()].sort((a, b) => a.min - b.min || (a.vieja ? 1 : -1));
  }

  async function cargarMatriz() {
    try {
      await cargarTramos();
      matrizActual = esPorKg()
        ? await NovaAPI.clientes.tarifaKg.matriz(clienteId, tabActivo.servicio, tabActivo.tipo)
        : await NovaAPI.clientes.profit.matriz(clienteId, tabActivo.servicio, tabActivo.tipo);

      // En modo por kilo se trae además el general de profit: es el porcentaje con el que
      // se cobra una zona sin precio por kilo, y hay que poder mostrarlo en la grilla.
      // Si falla, no se rompe la pantalla: se cae al porcentaje general del cliente.
      matrizProfitGeneral = null;
      if (esPorKg()) {
        try {
          const mp = await NovaAPI.clientes.profit.matriz(clienteId, tabActivo.servicio, tabActivo.tipo);
          matrizProfitGeneral = mp && mp.general_tabla ? mp.general_tabla.profit_pct : null;
        } catch { /* se usa el general del cliente */ }
      }
      renderModo();
      renderGeneral();
      renderGrid();
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar tarifas: ' + err.message);
    }
  }

  // Encabezado del panel: modo, fuel propio y la explicación de qué se está editando.
  function renderModo() {
    const sel = document.getElementById('tarifas-modo-select');
    const fuel = document.getElementById('tarifas-fuel-input');
    const btnBorrarFuel = document.getElementById('btn-borrar-fuel');
    const hint = document.getElementById('tarifas-modo-hint');
    const rangos = document.getElementById('tarifas-rangos');
    if (!sel) return;

    sel.value = esPorKg() ? 'por_kg' : 'porcentaje';
    const fuelPropio = clienteData ? clienteData.fuel_pct_propio : null;
    fuel.value = fuelPropio === null || fuelPropio === undefined ? '' : fuelPropio;
    btnBorrarFuel.classList.toggle('hidden', fuelPropio === null || fuelPropio === undefined);
    // La barra de "agregar rango" ya no va: los tramos son las nueve bandas fijas y están
    // todos en la grilla. Se deja el elemento en el HTML para no romper nada, oculto.
    if (rangos) rangos.classList.add('hidden');
    hint.textContent = esPorKg()
      ? 'Precio fijo por kilo: reemplaza el flete. El fuel, el seguro y los recargos del courier se cobran igual.'
      : 'Porcentaje de ganancia sobre el flete del courier. Es el modo normal.';

    // Explicación de cómo se usa la grilla. Antes no había ninguna, y la única pista de que
    // las celdas eran clickeables era el cursorcito: la función de poner un precio distinto
    // por zona existía desde el principio y nadie sabía que estaba.
    const ayuda = document.getElementById('tarifas-grid-ayuda');
    if (ayuda) {
      const deQuienSonLosTramos = tramosPropios
        ? 'Este cliente tiene tramos de peso propios, negociados con él: no son los que usa el resto.'
        : 'Los tramos de peso son los generales: de 5 en 5 hasta 50 kg, y de ahí en adelante uno solo.';
      ayuda.textContent = esPorKg()
        ? `Hacé clic en cualquier celda para ponerle el precio por kilo de esa zona y ese tramo de peso. ${deQuienSonLosTramos} La ✕ de la celda quita ese precio; la ✕ de la fila borra el tramo entero. Las celdas en gris NO tienen precio por kilo: se cobran con el porcentaje de ganancia.`
        : deQuienSonLosTramos;
    }

    renderSeguro();
  }

  // Seguro negociado del cliente. Vale para DHL y UPS por igual: cuando esta cargado,
  // reemplaza la escala del courier entera (ni el escalon de USD 15 de UPS ni el minimo
  // de 17,50 de DHL siguen aplicando).
  function renderSeguro() {
    const pct = document.getElementById('tarifas-seguro-pct');
    const min = document.getElementById('tarifas-seguro-min');
    const btnBorrar = document.getElementById('btn-borrar-seguro');
    const hint = document.getElementById('tarifas-seguro-hint');
    if (!pct) return;

    const vacio = (v) => v === null || v === undefined || v === '';
    const segPct = clienteData ? clienteData.seguro_pct_propio : null;
    const segMin = clienteData ? clienteData.seguro_min_propio : null;
    pct.value = vacio(segPct) ? '' : segPct;
    min.value = vacio(segMin) ? '' : segMin;
    btnBorrar.classList.toggle('hidden', vacio(segPct));

    if (vacio(segPct)) {
      hint.textContent =
        'Sin seguro propio usa la escala de cada courier: UPS 0 hasta USD 100, USD 15 fijo hasta 1.000 y 1,5% arriba; DHL el mayor entre USD 17,50 y el 1,5%.';
      return;
    }
    const piso = vacio(segMin) ? 'sin minimo' : `minimo USD ${Number(segMin).toFixed(2)}`;
    hint.textContent =
      `Este cliente paga ${segPct}% del valor declarado (${piso}) en DHL y en UPS. ` +
      'Reemplaza la escala del courier: no se le cobra el escalon de USD 15 ni el minimo de 17,50.';
  }

  function renderGeneral() {
    const input = document.getElementById('tarifas-general-input');
    const label = document.getElementById('tarifas-general-label');
    const btnBorrar = document.getElementById('btn-borrar-general');
    const generalCliente = clienteData && clienteData.tarifa_pct != null ? clienteData.tarifa_pct : 0;
    if (label) {
      label.textContent = esPorKg()
        ? 'General de esta tabla (USD por kilo)'
        : 'General de esta tabla (%)';
    }
    if (matrizActual && matrizActual.general_tabla) {
      input.value = valorDe(matrizActual.general_tabla);
      btnBorrar.classList.remove('hidden');
    } else {
      input.value = '';
      btnBorrar.classList.add('hidden');
    }
    input.placeholder = esPorKg() ? 'sin general' : `General del cliente: ${generalCliente}%`;
  }

  function renderGrid() {
    const wrap = document.getElementById('tarifas-grid');
    if (!matrizActual) {
      wrap.innerHTML = '';
      return;
    }
    const filas = filasDeGrilla();
    let html = '<table class="tarifas-grid"><thead><tr><th></th><th class="col-todas">Todas</th>';
    TARIFAS_ZONAS.forEach((z) => {
      html += `<th>Zona ${z}</th>`;
    });
    html += '</tr></thead><tbody>';
    filas.forEach((banda) => {
      const maxAttr = banda.max === null ? '' : banda.max;
      const borrarFila = esPorKg()
        ? `<span class="rango-del" title="Borrar todo el rango" data-min="${banda.min}" data-max="${maxAttr}">✕</span>`
        : '';
      const etiqueta = banda.vieja
        ? `${bandaLabel(banda)} <span class="tramo-viejo" title="Este tramo no está en el juego de tramos de este cliente: quedó de una carga vieja. Sigue cobrando igual que siempre, pero no se puede editar desde acá. Borralo y volvé a cargarlo sobre los tramos de arriba, o pedile a quien corresponda que ajuste los tramos del cliente.">fuera de los tramos</span>`
        : bandaLabel(banda);
      html += `<tr class="${banda.vieja ? 'fila-vieja' : ''}"><td class="banda-label">${etiqueta}${borrarFila}</td>`;

      // Columna "Todas": el precio de ese tramo para las seis zonas de una. Reemplaza a la
      // barra de "agregar rango" que había cuando los rangos se inventaban a mano. Poner
      // el precio zona por zona seguiría siendo posible, pero serían seis clics por fila.
      {
        const ob = overrideBanda(banda.min);
        const propio = !!ob;
        const texto = ob ? formatoValor(valorDe(ob)) : '—';
        html += `<td class="${banda.vieja ? 'celda-vieja' : 'tarifa-cell'} col-todas ${propio ? 'propio' : 'heredado'}"`
          + ` data-zona="" data-min="${banda.min}" data-max="${maxAttr}"`
          + ` title="Precio de este tramo para las seis zonas. Hacé clic para ponerlo.">`
          + `${propio ? '<span class="cell-del" title="Quitar el precio de todas las zonas">✕</span>' : ''}`
          + `<span class="cell-val">${texto}</span></td>`;
      }

      TARIFAS_ZONAS.forEach((zona) => {
        const { val, propio, porPct } = valorEfectivo(zona, banda);
        let cls = propio ? 'tarifa-cell propio' : 'tarifa-cell heredado';
        if (porPct) cls += ' por-pct';
        const del = propio ? '<span class="cell-del" title="Quitar override">✕</span>' : '';
        const texto = porPct ? `${pctDeRespaldo()}% de ganancia` : formatoValor(val);
        const title = porPct
          ? 'Esta zona no tiene precio por kilo: se cobra con el porcentaje de ganancia. Hacé clic para ponerle un precio por kilo.'
          : 'Hacé clic para cambiar el precio de esta zona';
        if (banda.vieja) cls = cls.replace('tarifa-cell', 'celda-vieja');
        html += `<td class="${cls}" data-zona="${zona}" data-min="${banda.min}" data-max="${maxAttr}" title="${banda.vieja ? 'Tramo viejo: se cobra igual que siempre, pero no se puede editar desde acá. Borrá la fila y volvé a cargarla sobre los tramos fijos.' : title}">${banda.vieja ? '' : del}<span class="cell-val">${texto}</span></td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
    bindGridEvents();
  }

  function bindGridEvents() {
    const wrap = document.getElementById('tarifas-grid');
    wrap.querySelectorAll('td.tarifa-cell').forEach((td) => {
      td.addEventListener('click', (e) => {
        if (e.target.classList.contains('cell-del')) return;
        abrirEditorCelda(td);
      });
    });
    wrap.querySelectorAll('.cell-del').forEach((x) => {
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        borrarCelda(x.closest('td'));
      });
    });
    // Borrar un rango entero (solo modo por kilo): saca la fila completa de la tabla.
    wrap.querySelectorAll('.rango-del').forEach((x) => {
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        borrarRango(Number(x.dataset.min), x.dataset.max === '' ? null : Number(x.dataset.max));
      });
    });
  }

  // zona vacía = la columna "Todas", que es el nivel BANDA: un solo precio para las seis
  // zonas de ese tramo de peso. Es lo que antes hacía la barra de "agregar rango", ahora
  // en un clic y en el mismo lugar donde se mira todo lo demás.
  function coordsDeCelda(td) {
    return {
      zona: td.dataset.zona === '' ? null : Number(td.dataset.zona),
      peso_min: Number(td.dataset.min),
      peso_max: td.dataset.max === '' ? null : Number(td.dataset.max),
    };
  }

  function abrirEditorCelda(td) {
    if (td.querySelector('input')) return;
    const coords = coordsDeCelda(td);
    // El texto de la celda trae el formato ("12%" o "USD 5.00"); acá se necesita el número.
    const crudo = td.querySelector('.cell-val').textContent;
    const actual = crudo === '—' ? '' : crudo.replace('%', '').replace('USD', '').trim();
    td.innerHTML = `<input type="number" min="0" step="${esPorKg() ? '0.1' : '0.5'}" value="${actual}">`;
    const input = td.querySelector('input');
    input.focus();
    input.select();

    let cerrado = false;
    const cancelar = () => {
      if (cerrado) return;
      cerrado = true;
      renderGrid();
    };
    const confirmar = async () => {
      if (cerrado) return;
      cerrado = true;
      const val = input.value.trim();
      const pct = parseFloat(val);
      if (val === '' || !Number.isFinite(pct)) {
        renderGrid();
        return;
      }
      const cuerpo = {
        servicio: tabActivo.servicio,
        tipo: tabActivo.tipo,
        zona: coords.zona,
        peso_min: coords.peso_min,
        peso_max: coords.peso_max,
      };
      try {
        if (esPorKg()) {
          await NovaAPI.clientes.tarifaKg.guardar(clienteId, { ...cuerpo, precio_kg: pct });
        } else {
          await NovaAPI.clientes.profit.guardar(clienteId, { ...cuerpo, profit_pct: pct });
        }
        await cargarMatriz();
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
        renderGrid();
      }
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') confirmar();
      else if (ev.key === 'Escape') cancelar();
    });
    input.addEventListener('blur', confirmar);
  }

  async function borrarCelda(td) {
    const coords = coordsDeCelda(td);
    const cuerpo = {
      servicio: tabActivo.servicio,
      tipo: tabActivo.tipo,
      zona: coords.zona,
      peso_min: coords.peso_min,
      peso_max: coords.peso_max,
    };
    try {
      if (esPorKg()) await NovaAPI.clientes.tarifaKg.borrar(clienteId, cuerpo);
      else await NovaAPI.clientes.profit.borrar(clienteId, cuerpo);
      await cargarMatriz();
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message);
    }
  }

  // Borra un rango de peso completo: la fila de todas las zonas más la de "todas las
  // zonas". Se hace de a una porque cada fila es un registro propio; los 404 de las celdas
  // que no existían se ignoran a propósito (no son un error, simplemente no estaban).
  async function borrarRango(min, max) {
    const zonas = [...TARIFAS_ZONAS, null];
    let falla = null;
    for (const zona of zonas) {
      try {
        await NovaAPI.clientes.tarifaKg.borrar(clienteId, {
          servicio: tabActivo.servicio,
          tipo: tabActivo.tipo,
          zona,
          peso_min: min,
          peso_max: max,
        });
      } catch (err) {
        if (!/no encontrada/i.test(err.message || '')) falla = err;
      }
    }
    if (falla) NovaUtils.showAlert(alertBox, falla.message);
    await cargarMatriz();
  }

  function bindTarifas() {
    const btnEditar = document.getElementById('btn-editar-tarifas');
    const panel = document.getElementById('tarifas-panel');
    const tabs = document.getElementById('tarifas-tabs');
    const inputGeneral = document.getElementById('tarifas-general-input');
    const btnGuardarGeneral = document.getElementById('btn-guardar-general');
    const btnBorrarGeneral = document.getElementById('btn-borrar-general');

    btnEditar.addEventListener('click', () => {
      const abrir = panel.classList.contains('hidden');
      panel.classList.toggle('hidden');
      btnEditar.textContent = abrir ? 'Ocultar tarifas' : 'Editar tarifas';
      if (abrir && !tarifasCargado) {
        tarifasCargado = true;
        cargarMatriz();
      }
    });

    // Switching de tab acotado al contenedor (no querySelector global).
    tabs.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        tabActivo = { servicio: tab.dataset.serv, tipo: tab.dataset.tipo };
        cargarMatriz();
      });
    });

    btnGuardarGeneral.addEventListener('click', async () => {
      const val = inputGeneral.value.trim();
      const pct = parseFloat(val);
      if (val === '' || !Number.isFinite(pct)) return;
      const cuerpo = {
        servicio: tabActivo.servicio,
        tipo: tabActivo.tipo,
        zona: null,
        peso_min: null,
        peso_max: null,
      };
      try {
        if (esPorKg()) {
          await NovaAPI.clientes.tarifaKg.guardar(clienteId, { ...cuerpo, precio_kg: pct });
        } else {
          await NovaAPI.clientes.profit.guardar(clienteId, { ...cuerpo, profit_pct: pct });
        }
        await cargarMatriz();
        NovaUtils.showAlert(alertBox, 'General de tabla guardado', 'success');
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      }
    });

    btnBorrarGeneral.addEventListener('click', async () => {
      const cuerpo = {
        servicio: tabActivo.servicio,
        tipo: tabActivo.tipo,
        zona: null,
        peso_min: null,
        peso_max: null,
      };
      try {
        if (esPorKg()) await NovaAPI.clientes.tarifaKg.borrar(clienteId, cuerpo);
        else await NovaAPI.clientes.profit.borrar(clienteId, cuerpo);
        await cargarMatriz();
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      }
    });

    // ── Modo de tarifa y fuel propio ────────────────────────────────────────
    // Cambiar de modo NO borra nada: las dos tablas quedan guardadas y se puede volver.

    const selModo = document.getElementById('tarifas-modo-select');
    selModo.addEventListener('change', async () => {
      const modo = selModo.value;
      try {
        const actualizado = await NovaAPI.clientes.actualizar(clienteId, { modo_tarifa: modo });
        clienteData = actualizado;
        await cargarMatriz();
        NovaUtils.showAlert(
          alertBox,
          modo === 'por_kg'
            ? 'Cliente pasado a precio por kilo. Cargá los rangos de cada tabla.'
            : 'Cliente pasado a porcentaje de ganancia.',
          'success'
        );
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
        selModo.value = esPorKg() ? 'por_kg' : 'porcentaje';
      }
    });

    const inputFuel = document.getElementById('tarifas-fuel-input');
    async function guardarFuel(valor) {
      try {
        clienteData = await NovaAPI.clientes.actualizar(clienteId, { fuel_pct_propio: valor });
        renderModo();
        NovaUtils.showAlert(
          alertBox,
          valor === null ? 'El cliente vuelve al fuel de Configuracion' : 'Fuel propio guardado',
          'success'
        );
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      }
    }
    document.getElementById('btn-guardar-fuel').addEventListener('click', () => {
      const val = inputFuel.value.trim();
      if (val === '') return guardarFuel(null);
      const n = parseFloat(val);
      if (!Number.isFinite(n) || n < 0) {
        NovaUtils.showAlert(alertBox, 'El fuel propio tiene que ser un numero mayor o igual a 0');
        return;
      }
      guardarFuel(n);
    });
    document.getElementById('btn-borrar-fuel').addEventListener('click', () => guardarFuel(null));

    // Seguro propio: los dos campos se guardan juntos. Sin porcentaje no hay regla posible,
    // asi que vaciar el porcentaje borra tambien el minimo y el cliente vuelve al courier.
    const inputSegPct = document.getElementById('tarifas-seguro-pct');
    const inputSegMin = document.getElementById('tarifas-seguro-min');
    async function guardarSeguro(pctVal, minVal) {
      try {
        clienteData = await NovaAPI.clientes.actualizar(clienteId, {
          seguro_pct_propio: pctVal,
          seguro_min_propio: pctVal === null ? null : minVal,
        });
        renderSeguro();
        NovaUtils.showAlert(
          alertBox,
          pctVal === null
            ? 'El cliente vuelve al seguro de cada courier'
            : 'Seguro propio guardado',
          'success'
        );
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      }
    }
    document.getElementById('btn-guardar-seguro').addEventListener('click', () => {
      const valPct = inputSegPct.value.trim();
      if (valPct === '') return guardarSeguro(null, null);
      const n = parseFloat(valPct);
      if (!Number.isFinite(n) || n < 0) {
        NovaUtils.showAlert(alertBox, 'El seguro propio tiene que ser un numero mayor o igual a 0');
        return;
      }
      const valMin = inputSegMin.value.trim();
      let m = null;
      if (valMin !== '') {
        m = parseFloat(valMin);
        if (!Number.isFinite(m) || m < 0) {
          NovaUtils.showAlert(alertBox, 'El minimo tiene que ser un numero mayor o igual a 0');
          return;
        }
      }
      guardarSeguro(n, m);
    });
    document.getElementById('btn-borrar-seguro').addEventListener('click', () => guardarSeguro(null, null));

    // ⚠️ DESDE EL 11/08/2026 ESTA BARRA ESTÁ OCULTA. Los tramos de peso pasaron a ser las
    // nueve bandas fijas, iguales que en el modo porcentaje, y ya están todas en la grilla:
    // no hay ningún rango que agregar, se hace clic en la celda y listo. El código queda
    // por si hiciera falta volver atrás; si alguien vuelve a mostrar la barra, el servidor
    // igual rechaza cualquier rango que no sea una banda.
    //
    // Alta de un rango de peso (solo modo por kilo). Por defecto se guarda para "todas las
    // zonas" y después se puede pisar zona por zona haciendo clic en la celda.
    //
    // Eligiendo UNA zona en el selector se guarda SOLO esa: el rango queda sin precio
    // general, y las demás zonas de ese peso se cobran con el porcentaje de ganancia. Ese
    // es el caso MIXTO —una zona por kilo y el resto por porcentaje—, que el motor soporta
    // desde siempre (resolverTarifaKg devuelve null y resolverTarifaVenta cae al
    // porcentaje) pero que desde la pantalla no se podía armar, porque el alta creaba
    // siempre la fila de "todas las zonas".
    document.getElementById('btn-agregar-rango').addEventListener('click', async () => {
      const desdeEl = document.getElementById('rango-desde');
      const hastaEl = document.getElementById('rango-hasta');
      const precioEl = document.getElementById('rango-precio');
      const zonaEl = document.getElementById('rango-zona');
      const zonaSel = zonaEl && zonaEl.value !== '' ? Number(zonaEl.value) : null;
      const desde = parseFloat(desdeEl.value);
      const hasta = hastaEl.value.trim() === '' ? null : parseFloat(hastaEl.value);
      const precio = parseFloat(precioEl.value);
      if (!Number.isFinite(desde) || desde < 0) {
        NovaUtils.showAlert(alertBox, 'Poné desde cuántos kilos vale el rango');
        return;
      }
      if (hasta !== null && (!Number.isFinite(hasta) || hasta <= desde)) {
        NovaUtils.showAlert(alertBox, 'El "hasta" tiene que ser mayor que el "desde"');
        return;
      }
      if (!Number.isFinite(precio) || precio < 0) {
        NovaUtils.showAlert(alertBox, 'Poné el precio por kilo del rango');
        return;
      }
      try {
        await NovaAPI.clientes.tarifaKg.guardar(clienteId, {
          servicio: tabActivo.servicio,
          tipo: tabActivo.tipo,
          zona: zonaSel,
          peso_min: desde,
          peso_max: hasta,
          precio_kg: precio,
        });
        desdeEl.value = '';
        hastaEl.value = '';
        precioEl.value = '';
        if (zonaEl) zonaEl.value = '';
        await cargarMatriz();
        if (zonaSel !== null) {
          NovaUtils.showAlert(
            alertBox,
            `Rango cargado solo para la zona ${zonaSel}. Las otras zonas de ese peso se cobran ` +
              'con el porcentaje de ganancia; se ven en gris en la grilla.',
            'success'
          );
        }
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      }
    });
  }

  init();
})();
