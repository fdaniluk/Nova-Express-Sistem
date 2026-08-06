(function () {
  const alertBox = document.getElementById('alert-box');

  // ── Franja de salud ───────────────────────────────────────────────────────
  // Pide el semaforo del panel de salud y, si hay algo en rojo, lo muestra arriba del
  // Dashboard. Es lo que hace que el panel sirva sin tener que acordarse de entrar.
  //
  // Tres decisiones:
  //   · Si esta todo en verde, la franja NO aparece. Un aviso permanente se vuelve
  //     paisaje y se deja de leer.
  //   · Un chequeo que no pudo correr tambien enciende la franja. "No se pudo mirar" no
  //     es lo mismo que "esta bien", y confundirlos es como se pierde un backup.
  //   · Si la consulta falla (403 de un usuario sin permiso, red caida) la franja se
  //     queda callada y NO rompe el Dashboard. El Dashboard es la pantalla principal;
  //     no puede quedar en blanco porque falle un accesorio.
  (async function franjaSalud() {
    const el = document.getElementById('franja-salud');
    if (!el) return;
    try {
      const r = await NovaAPI.salud.resumen();
      const rojos = r.rojos || [];
      const errores = r.errores || [];
      if (!rojos.length && !errores.length) return;

      const partes = [];
      if (rojos.length) {
        partes.push(rojos.map((x) => `${x.titulo}${x.cantidad ? ` (${x.cantidad})` : ''}`).join(' · '));
      }
      if (errores.length) {
        partes.push(`${errores.length} chequeo(s) no pudieron correr: ${errores.map((x) => x.titulo).join(', ')}`);
      }

      const total = rojos.length + errores.length;
      el.innerHTML =
        `<strong>${total} ${total === 1 ? 'cosa necesita' : 'cosas necesitan'} atencion.</strong> `
        + 'Ver el panel de salud →'
        + `<div class="franja-detalle">${partes.join(' · ')}</div>`;
      el.hidden = false;
    } catch (err) {
      // Silencio deliberado: sin permiso o sin red, el Dashboard sigue funcionando igual.
      console.warn('[dashboard] No se pudo leer el panel de salud:', err.message);
    }
  })();

  const mesSelector = document.getElementById('mes-selector');
  const periodoLabel = document.getElementById('periodo-label');

  const MESES_ES = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];
  const LABELS_PERIODO = {
    hoy: 'Hoy',
    semana: 'Últimos 7 días',
    mes: 'Este mes',
  };

  // 'YYYY-MM' -> 'Julio 2026'
  function nombreMes(mes) {
    const [anio, m] = mes.split('-').map(Number);
    return `${MESES_ES[m - 1]} ${anio}`;
  }

  function mesActual() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  let modo = 'periodo'; // 'periodo' | 'mes'
  let periodoActual = 'hoy';
  let mesActualSel = mesActual();

  async function init() {
    bindPeriodo();
    bindMesSelector();
    await cargarMeses();
    await cargarMetricas();
  }

  function bindPeriodo() {
    document.querySelectorAll('.period-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        document.querySelectorAll('.period-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        periodoActual = btn.dataset.periodo;
        modo = 'periodo';
        // Volver al mes actual en el select (sin cambiar de modo)
        mesActualSel = mesActual();
        if (mesSelector && [...mesSelector.options].some((o) => o.value === mesActualSel)) {
          mesSelector.value = mesActualSel;
        }
        await cargarMetricas();
      });
    });
  }

  function bindMesSelector() {
    if (!mesSelector) return;
    mesSelector.addEventListener('change', async () => {
      modo = 'mes';
      mesActualSel = mesSelector.value;
      document.querySelectorAll('.period-btn').forEach((b) => b.classList.remove('active'));
      await cargarMetricas();
    });
  }

  async function cargarMeses() {
    if (!mesSelector) return;
    try {
      const meses = await NovaAPI.dashboard.meses();
      mesSelector.innerHTML = meses
        .map((r) => `<option value="${r.mes}">${nombreMes(r.mes)}</option>`)
        .join('');
      // Default: mes actual si está en la lista; si no, el más reciente.
      const actual = mesActual();
      if (meses.some((r) => r.mes === actual)) {
        mesSelector.value = actual;
        mesActualSel = actual;
      } else if (meses.length) {
        mesActualSel = meses[0].mes;
        mesSelector.value = mesActualSel;
      }
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar meses: ' + err.message);
    }
  }

  function actualizarLabelPeriodo() {
    if (!periodoLabel) return;
    periodoLabel.textContent =
      modo === 'mes' ? nombreMes(mesActualSel) : LABELS_PERIODO[periodoActual] || '';
  }

  async function cargarMetricas() {
    try {
      const params = modo === 'mes' ? { mes: mesActualSel } : { periodo: periodoActual };
      const data = await NovaAPI.dashboard.metricas(params);
      actualizarLabelPeriodo();
      renderMetrics(data);
      renderTopClientes(data.top_clientes);
      renderCourierMix(data.mix_couriers);
      renderChart(data.chart_data);
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar métricas: ' + err.message);
    }
  }

  // formatMoney no antepone '+' en positivos; lo agregamos para leer el signo de un vistazo.
  function signedMoney(n) {
    const m = NovaUtils.formatMoney(n);
    return n > 0 ? '+' + m : m;
  }

  function renderMetrics(data) {
    const grid = document.getElementById('metrics-grid');

    // Desvío de cotización: positivo = UPS cobró de más = cotizamos corto (rojo).
    const desvioCant = data.cantidad_envios_comparados;
    const desvioValue =
      desvioCant > 0
        ? `${signedMoney(data.desvio_cotizacion_usd)} (${data.desvio_cotizacion_pct}%)`
        : '—';
    const desvioClass = desvioCant === 0 ? '' : data.desvio_cotizacion_usd > 0 ? 'danger' : 'success';
    const desvioSub =
      desvioCant > 0 ? `sobre ${desvioCant} envíos facturados` : 'sin datos aún';

    // Plata en disputa: si hay algo abierto es plata que puede evaporarse (rojo).
    const disputaClass = data.disputa_usd > 0 ? 'danger' : '';
    const disputaSub =
      data.disputa_cantidad > 0 ? `${data.disputa_cantidad} guías en reclamo` : 'sin reclamos';

    grid.innerHTML = `
      <div class="metric-card success">
        <div class="metric-label">Utilidad neta</div>
        <div class="metric-value">${NovaUtils.formatMoney(data.utilidad_neta_usd)}</div>
      </div>
      <div class="metric-card ${desvioClass}">
        <div class="metric-label">Desvío de cotización</div>
        <div class="metric-value">${desvioValue}</div>
        <div class="metric-sub">${desvioSub}</div>
      </div>
      <div class="metric-card ${disputaClass}">
        <div class="metric-label">En disputa con UPS</div>
        <div class="metric-value">${NovaUtils.formatMoney(data.disputa_usd)}</div>
        <div class="metric-sub">${disputaSub}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Envíos totales</div>
        <div class="metric-value">${data.envios_totales}</div>
        <div class="metric-sub">${data.pais_mas_activo ? 'Top: ' + data.pais_mas_activo : ''}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Kilos facturados</div>
        <div class="metric-value">${data.kilos_facturados.toLocaleString('es-AR')} kg</div>
        <div class="metric-sub">${data.bultos_despachados} bultos</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Ticket promedio</div>
        <div class="metric-value">${NovaUtils.formatMoney(data.ticket_promedio_usd)}</div>
      </div>
      <div class="metric-card ${data.envios_pendientes_liquidar > 0 ? 'danger' : ''}">
        <div class="metric-label">Pendientes de liquidar</div>
        <div class="metric-value">${data.envios_pendientes_liquidar}</div>
      </div>
      <div class="metric-card accent">
        <div class="metric-label">Clientes nuevos</div>
        <div class="metric-value">${data.clientes_nuevos}</div>
      </div>
    `;
  }

  function renderTopClientes(top) {
    const tbody = document.getElementById('top-clientes-body');
    if (!top || !top.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">Sin datos</td></tr>';
      return;
    }
    tbody.innerHTML = top
      .map(
        (c) => `<tr>
        <td><a href="pages/clientes-perfil.html?id=${c.id}">${c.nombre}</a></td>
        <td>${c.envios}</td>
        <td>${c.kilos} kg</td>
        <td>${NovaUtils.formatMoney(c.utilidad_usd)}</td>
      </tr>`
      )
      .join('');
  }

  function renderCourierMix(mix) {
    const el = document.getElementById('courier-mix');
    if (!mix || !mix.length) {
      el.innerHTML = '<p class="empty">Sin datos</p>';
      return;
    }
    el.innerHTML = mix
      .map(
        (m) => `
      <div style="margin-bottom:0.75rem">
        <div style="display:flex;justify-content:space-between;margin-bottom:0.3rem">
          <span class="badge badge-${m.courier.toLowerCase()}">${m.courier}</span>
          <span style="font-size:0.85rem;color:var(--color-muted)">${m.cantidad} envíos — ${m.porcentaje}%</span>
        </div>
        <div style="background:#e2e8f0;border-radius:4px;height:8px">
          <div style="background:var(--color-primary);height:8px;border-radius:4px;width:${m.porcentaje}%"></div>
        </div>
      </div>`
      )
      .join('');
  }

  function renderChart(data) {
    const canvas = document.getElementById('chart-utilidad');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!data || !data.length) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Sin datos para el período', w / 2, h / 2);
      return;
    }

    const pad = { top: 24, right: 12, bottom: 36, left: 60 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    const maxVal = Math.max(...data.map((d) => d.utilidad_usd), 1);
    const barW = Math.max(8, (cw / data.length) * 0.55);
    const gap = cw / data.length;

    // Y-axis gridlines
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + ch * (1 - i / 4);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + cw, y);
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('$' + Math.round((maxVal * i) / 4), pad.left - 6, y + 3);
    }

    data.forEach((d, i) => {
      const barH = Math.max(2, (d.utilidad_usd / maxVal) * ch);
      const x = pad.left + i * gap + (gap - barW) / 2;
      const y = pad.top + ch - barH;

      ctx.fillStyle = '#1a3a5c';
      ctx.fillRect(x, y, barW, barH);

      // Label
      ctx.fillStyle = '#64748b';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(d.label, x + barW / 2, h - 6);
    });
  }

  init();
})();
