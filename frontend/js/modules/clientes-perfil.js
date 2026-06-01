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
        inputEl = `<input type="${campo.type}" id="pf-${campo.key}" value="${raw != null ? raw : ''}" ${campo.key === 'tarifa_pct' ? 'min="0" max="100" step="0.5"' : ''}>`;
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

  init();
})();
