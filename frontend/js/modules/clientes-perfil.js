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

  // ── Matriz de tarifas (profit) ────────────────────────
  // UI de edición. No toca cotización (etapa 3) ni la edición inline del perfil.

  let matrizActual = null;
  let tabActivo = { servicio: 'DHL', tipo: 'export' };
  let tarifasCargado = false;

  // Bandas fijas (kg sobre peso facturable). Deben coincidir con backend profit.service.js.
  const TARIFAS_BANDAS = [
    { min: 0, max: 5 },
    { min: 5, max: 10 },
    { min: 10, max: 15 },
    { min: 15, max: 20 },
    { min: 20, max: 25 },
    { min: 25, max: 30 },
    { min: 30, max: 40 },
    { min: 40, max: 50 },
    { min: 50, max: null },
  ];
  const TARIFAS_ZONAS = [1, 2, 3, 4, 5, 6];

  function bandaLabel(b) {
    return b.max === null ? '50+ kg' : `${b.min}-${b.max} kg`;
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

  // Valor efectivo con precedencia: celda → banda → zona → general de tabla → general del cliente.
  // Sólo el override de nivel celda cuenta como "propio" (resaltado + crucecita).
  function valorEfectivo(zona, banda) {
    const celda = overrideCelda(zona, banda.min);
    if (celda) return { pct: celda.profit_pct, propio: true };
    const ob = overrideBanda(banda.min);
    if (ob) return { pct: ob.profit_pct, propio: false };
    const oz = overrideZona(zona);
    if (oz) return { pct: oz.profit_pct, propio: false };
    if (matrizActual.general_tabla) return { pct: matrizActual.general_tabla.profit_pct, propio: false };
    const cli = clienteData && clienteData.tarifa_pct != null ? clienteData.tarifa_pct : 0;
    return { pct: cli, propio: false };
  }

  async function cargarMatriz() {
    try {
      matrizActual = await NovaAPI.clientes.profit.matriz(clienteId, tabActivo.servicio, tabActivo.tipo);
      renderGeneral();
      renderGrid();
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar tarifas: ' + err.message);
    }
  }

  function renderGeneral() {
    const input = document.getElementById('tarifas-general-input');
    const btnBorrar = document.getElementById('btn-borrar-general');
    const generalCliente = clienteData && clienteData.tarifa_pct != null ? clienteData.tarifa_pct : 0;
    if (matrizActual && matrizActual.general_tabla) {
      input.value = matrizActual.general_tabla.profit_pct;
      btnBorrar.classList.remove('hidden');
    } else {
      input.value = '';
      btnBorrar.classList.add('hidden');
    }
    input.placeholder = `General del cliente: ${generalCliente}%`;
  }

  function renderGrid() {
    const wrap = document.getElementById('tarifas-grid');
    if (!matrizActual) {
      wrap.innerHTML = '';
      return;
    }
    let html = '<table class="tarifas-grid"><thead><tr><th></th>';
    TARIFAS_ZONAS.forEach((z) => {
      html += `<th>Zona ${z}</th>`;
    });
    html += '</tr></thead><tbody>';
    TARIFAS_BANDAS.forEach((banda) => {
      html += `<tr><td class="banda-label">${bandaLabel(banda)}</td>`;
      TARIFAS_ZONAS.forEach((zona) => {
        const { pct, propio } = valorEfectivo(zona, banda);
        const cls = propio ? 'tarifa-cell propio' : 'tarifa-cell heredado';
        const del = propio ? '<span class="cell-del" title="Quitar override">✕</span>' : '';
        const maxAttr = banda.max === null ? '' : banda.max;
        html += `<td class="${cls}" data-zona="${zona}" data-min="${banda.min}" data-max="${maxAttr}">${del}<span class="cell-val">${pct}%</span></td>`;
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
  }

  function coordsDeCelda(td) {
    return {
      zona: Number(td.dataset.zona),
      peso_min: Number(td.dataset.min),
      peso_max: td.dataset.max === '' ? null : Number(td.dataset.max),
    };
  }

  function abrirEditorCelda(td) {
    if (td.querySelector('input')) return;
    const coords = coordsDeCelda(td);
    const actual = td.querySelector('.cell-val').textContent.replace('%', '').trim();
    td.innerHTML = `<input type="number" min="0" step="0.5" value="${actual}">`;
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
      try {
        await NovaAPI.clientes.profit.guardar(clienteId, {
          servicio: tabActivo.servicio,
          tipo: tabActivo.tipo,
          zona: coords.zona,
          peso_min: coords.peso_min,
          peso_max: coords.peso_max,
          profit_pct: pct,
        });
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
    try {
      await NovaAPI.clientes.profit.borrar(clienteId, {
        servicio: tabActivo.servicio,
        tipo: tabActivo.tipo,
        zona: coords.zona,
        peso_min: coords.peso_min,
        peso_max: coords.peso_max,
      });
      await cargarMatriz();
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message);
    }
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
      try {
        await NovaAPI.clientes.profit.guardar(clienteId, {
          servicio: tabActivo.servicio,
          tipo: tabActivo.tipo,
          zona: null,
          peso_min: null,
          peso_max: null,
          profit_pct: pct,
        });
        await cargarMatriz();
        NovaUtils.showAlert(alertBox, 'General de tabla guardado', 'success');
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      }
    });

    btnBorrarGeneral.addEventListener('click', async () => {
      try {
        await NovaAPI.clientes.profit.borrar(clienteId, {
          servicio: tabActivo.servicio,
          tipo: tabActivo.tipo,
          zona: null,
          peso_min: null,
          peso_max: null,
        });
        await cargarMatriz();
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      }
    });
  }

  init();
})();
