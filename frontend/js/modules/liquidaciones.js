(function () {
  const alertBox = document.getElementById('alert-box');
  let clientes = [];
  let enviosPendientesCliente = [];
  let lastLiquidacionId = null;
  let lastPreview = null;

  // Mapa de cotizaciones ingresadas por el usuario: { envio_id: { profitPct, servicio, resultado } }
  const cotizacionesMap = {};

  async function init() {
    await loadClientes();
    bindTabs();
    bindPendientes();
    bindCrear();
    bindHistorial();
    setDefaultDates();
    loadPendientes();
  }

  function setDefaultDates() {
    const today = new Date();
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    // hoyLocal(): con toISOString() (UTC) el período por defecto arrancaba corrido
    // un día después de las 21:00 hora local.
    const iso = (d) => NovaUtils.hoyLocal(d);
    ['pend-desde', 'liq-desde', 'hist-desde'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = iso(first);
    });
    ['pend-hasta', 'liq-hasta', 'hist-hasta'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = iso(today);
    });
  }

  async function loadClientes() {
    clientes = await NovaAPI.clientes.listar();
    const selects = [document.getElementById('liq-cliente'), document.getElementById('hist-cliente')];
    for (const sel of selects) {
      const isHist = sel.id === 'hist-cliente';
      sel.innerHTML = isHist ? '<option value="">Todos</option>' : '';
      for (const c of clientes) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.nombre_nova || c.nombre} (${NovaUtils.tipoCobroLabel(c.tipo_cobro)})`;
        sel.appendChild(opt);
      }
    }
  }

  function bindTabs() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const name = tab.dataset.tab;
        ['pendientes', 'crear', 'historial'].forEach((p) => {
          document.getElementById(`panel-${p}`).classList.toggle('hidden', name !== p);
        });
        if (name === 'historial') loadHistorial();
        if (name === 'pendientes') loadPendientes();
      });
    });
  }

  function bindPendientes() {
    document.getElementById('btn-pend-filtrar').addEventListener('click', loadPendientes);
  }

  async function loadPendientes() {
    const params = {
      fecha_desde: document.getElementById('pend-desde').value,
      fecha_hasta: document.getElementById('pend-hasta').value,
    };
    const courier = document.getElementById('pend-courier').value;
    const tc = document.getElementById('pend-tipo-cobro').value;
    if (courier) params.courier = courier;
    if (tc) params.tipo_cobro = tc;

    const container = document.getElementById('pendientes-list');
    try {
      const grupos = await NovaAPI.liquidaciones.pendientes(params);
      if (!grupos.length) {
        container.innerHTML = '<p class="empty">No hay envíos pendientes de liquidar</p>';
        return;
      }
      container.innerHTML = grupos
        .map(
          (g) => `
        <div class="cliente-grupo">
          <div class="cliente-grupo-header">
            <strong>${g.cliente_nombre}</strong>
            <span>${NovaUtils.tipoCobroLabel(g.tipo_cobro)} · ${g.envios.length} envío(s) · ${NovaUtils.formatMoney(g.total_cobrado)}</span>
            <button type="button" class="btn btn-sm btn-primary" data-liq-cliente="${g.cliente_id}">Liquidar</button>
          </div>
          <div class="cliente-grupo-body">
            <table>
              <thead><tr><th>Fecha</th><th>Guía</th><th>Courier</th><th>País</th><th>Total</th></tr></thead>
              <tbody>
                ${g.envios.map((e) => `<tr>
                  <td>${NovaUtils.formatDate(e.fecha)}</td>
                  <td>${e.numero_guia}</td>
                  <td>${e.courier}</td>
                  <td>${e.pais_destino}</td>
                  <td>${NovaUtils.formatMoney(e.total_cobrado)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>`
        )
        .join('');

      container.querySelectorAll('[data-liq-cliente]').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelector('.tab[data-tab="crear"]').click();
          document.getElementById('liq-cliente').value = btn.dataset.liqCliente;
          document.getElementById('btn-cargar-envios').click();
        });
      });
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message, 'error');
    }
  }

  function bindCrear() {
    document.getElementById('btn-cargar-envios').addEventListener('click', cargarEnviosCliente);
    document.getElementById('liq-select-all').addEventListener('change', (e) => {
      document.querySelectorAll('.liq-envio-check').forEach((c) => {
        c.checked = e.target.checked;
      });
    });
    document.getElementById('btn-preview').addEventListener('click', calcularPreview);
    document.getElementById('btn-confirmar-liq').addEventListener('click', confirmarLiquidacion);
    document.getElementById('btn-export-borrador').addEventListener('click', exportarActual);
  }

  async function cargarEnviosCliente() {
    const clienteId = document.getElementById('liq-cliente').value;
    if (!clienteId) {
      NovaUtils.showAlert(alertBox, 'Seleccione un cliente', 'error');
      return;
    }
    const params = {
      cliente_id: clienteId,
      fecha_desde: document.getElementById('liq-desde').value,
      fecha_hasta: document.getElementById('liq-hasta').value,
    };
    try {
      const grupos = await NovaAPI.liquidaciones.pendientes(params);
      enviosPendientesCliente = grupos[0]?.envios || [];

      // Limpiar cotizaciones anteriores
      Object.keys(cotizacionesMap).forEach(k => delete cotizacionesMap[k]);

      const tbody = document.getElementById('liq-envios-body');
      if (!enviosPendientesCliente.length) {
        document.getElementById('liq-envios-wrap').classList.remove('hidden');
        tbody.innerHTML = '<tr><td colspan="9" class="empty">Sin envíos en el período</td></tr>';
        return;
      }

      tbody.innerHTML = enviosPendientesCliente.map((e) => `
        <tr data-envio-id="${e.id}">
          <td><input type="checkbox" class="liq-envio-check" value="${e.id}" checked></td>
          <td>${NovaUtils.formatDate(e.fecha)}</td>
          <td>${e.numero_guia}</td>
          <td>${e.courier}</td>
          <td>${NovaUtils.formatMoney(e.fob)}</td>
          <td>${NovaUtils.formatMoney(e.total_cobrado)}</td>
          <td><input type="number" class="liq-adicional" step="0.01" min="0" value="0" style="width:80px"></td>
          <td>
            <button type="button" class="btn btn-sm btn-secondary btn-cotizar" data-envio-id="${e.id}" title="Calcular cotización para este envío">
              🧮 Cotizar
            </button>
          </td>
          <td class="cot-resultado" id="cot-res-${e.id}">—</td>
        </tr>
        <tr class="cot-panel hidden" id="cot-panel-${e.id}">
          <td colspan="9">
            <div class="cotizador-inline">
              <div class="cot-campos">
                <div class="form-group">
                  <label>Servicio</label>
                  <select class="cot-servicio">
                    <option value="DHL">DHL Express</option>
                    <option value="UPS_EXP">UPS Expedited</option>
                    <option value="UPS_SAV">UPS Saver</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>Peso facturable (kg)</label>
                  <input type="number" class="cot-peso" step="0.1" min="0" value="${e.peso_facturable || e.peso_real || 0}">
                </div>
                <div class="form-group">
                  <label>Tipo operación</label>
                  <select class="cot-tipo">
                    <option value="export">Exportación</option>
                    <option value="import">Importación</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>% Profit cliente</label>
                  <input type="number" class="cot-profit" step="0.1" min="0" value="">
                </div>
                <div class="form-group">
                  <label>% Fuel</label>
                  <input type="number" class="cot-fuel" step="0.1" min="0" value="39">
                </div>
              </div>
              <button type="button" class="btn btn-primary btn-calc-cot" data-envio-id="${e.id}" data-pais="${e.pais_destino || ''}" data-fob="${e.fob || 0}" data-zona="${e.zona || ''}">
                Calcular
              </button>
              <div class="cot-detalle hidden" id="cot-det-${e.id}"></div>
            </div>
          </td>
        </tr>
      `).join('');

      document.getElementById('liq-envios-wrap').classList.remove('hidden');
      document.getElementById('liq-preview').classList.add('hidden');
      lastLiquidacionId = null;
      lastPreview = null;
      document.getElementById('btn-confirmar-liq').disabled = true;
      document.getElementById('btn-export-borrador').disabled = true;

      // Bind botones cotizar
      tbody.querySelectorAll('.btn-cotizar').forEach((btn) => {
        btn.addEventListener('click', () => {
          const envioId = btn.dataset.envioId;
          const panel = document.getElementById(`cot-panel-${envioId}`);
          panel.classList.toggle('hidden');
        });
      });

      // Bind botones calcular cotización
      tbody.querySelectorAll('.btn-calc-cot').forEach((btn) => {
        btn.addEventListener('click', () => calcularCotizacion(btn));
      });

      // Precarga del % profit desde la matriz por fila + marca de edición manual.
      tbody.querySelectorAll('.cot-panel').forEach((row) => {
        const profitInput = row.querySelector('.cot-profit');
        if (profitInput) {
          // Lo tipeado a mano gana sobre la matriz y borra la etiqueta de origen.
          profitInput.addEventListener('input', () => {
            profitInput.dataset.tocado = '1';
            setProfitOrigenFila(row, '');
          });
        }
        // Cambiar servicio o tipo cambia el contexto de la matriz: reset + re-precarga.
        row.querySelectorAll('.cot-servicio, .cot-tipo').forEach((el) => {
          el.addEventListener('change', () => {
            if (profitInput) delete profitInput.dataset.tocado;
            precargarProfitFila(row);
          });
        });
        // El peso también entra en la resolución; re-precarga (respeta lo tipeado a mano).
        row.querySelector('.cot-peso')?.addEventListener('change', () => precargarProfitFila(row));
        precargarProfitFila(row);
      });

    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message, 'error');
    }
  }

  // ── Precarga de % profit desde la matriz ─────────────────────────
  function origenLabel(origen) {
    switch (origen) {
      case 'celda': return 'matriz: celda';
      case 'banda': return 'matriz: banda';
      case 'zona': return 'matriz: zona';
      case 'tabla': return 'matriz: tabla';
      case 'cliente': return 'general cliente';
      default: return ''; // manual / body: es el número tipeado, no se rotula
    }
  }

  // Muestra (o limpia) el origen del profit dentro del form-group del input, una sola vez.
  function setProfitOrigenFila(row, texto) {
    const grp = row.querySelector('.cot-profit')?.closest('.form-group');
    if (!grp) return;
    let el = grp.querySelector('.cot-profit-origen');
    if (!el) {
      el = document.createElement('small');
      el.className = 'cot-profit-origen';
      el.style.cssText = 'color:#2563eb;font-size:11px;';
      grp.appendChild(el);
    }
    el.textContent = texto || '';
  }

  // Precarga .cot-profit de una fila desde la matriz del cliente seleccionado. Si falta
  // contexto cae a tarifa_pct del cliente; si no hay cliente deja el input vacío. No pisa
  // lo tipeado a mano (dataset.tocado).
  async function precargarProfitFila(row) {
    const profitInput = row.querySelector('.cot-profit');
    if (!profitInput || profitInput.dataset.tocado === '1') return;

    const clienteId = parseInt(document.getElementById('liq-cliente').value, 10);
    if (!clienteId) { profitInput.value = ''; setProfitOrigenFila(row, ''); return; }
    const cliente = clientes.find((c) => c.id === clienteId);

    const precargaSimple = () => {
      profitInput.value = (cliente && cliente.tarifa_pct != null && cliente.tarifa_pct > 0)
        ? cliente.tarifa_pct
        : '';
      setProfitOrigenFila(row, '');
    };

    const btn = row.querySelector('.btn-calc-cot');
    const pais = btn?.dataset.pais || '';
    const zona = parseInt(btn?.dataset.zona, 10);
    const pf = parseFloat(row.querySelector('.cot-peso').value) || 0;
    if (((!pais || pais === '—') && isNaN(zona)) || pf <= 0) { precargaSimple(); return; }

    const servicio = row.querySelector('.cot-servicio').value;
    // El resolver valida contra el enum de la matriz: UPS_SAV -> UPS_SAVER solo acá.
    const servicioResolve = servicio === 'UPS_SAV' ? 'UPS_SAVER' : servicio;
    const tipo = row.querySelector('.cot-tipo').value;

    const params = { servicio: servicioResolve, tipo, pf };
    if (!isNaN(zona)) params.zona = zona;

    try {
      const r = await NovaAPI.clientes.profit.resolver(clienteId, params);
      if (r && r.profitPct != null) {
        profitInput.value = r.profitPct;
        setProfitOrigenFila(row, origenLabel(r.origen));
      } else {
        precargaSimple();
      }
    } catch (err) {
      console.warn('[liquidaciones] profit-resolve falló, uso precarga simple:', err.message);
      precargaSimple();
    }
  }

  async function calcularCotizacion(btn) {
    const envioId = parseInt(btn.dataset.envioId, 10);
    const pais = btn.dataset.pais;
    const fob = parseFloat(btn.dataset.fob) || 0;
    const zona = parseInt(btn.dataset.zona, 10) || undefined;
    const panel = btn.closest('.cotizador-inline');
    const servicio = panel.querySelector('.cot-servicio').value;
    const pesoFacturable = parseFloat(panel.querySelector('.cot-peso').value) || 0;
    const tipo = panel.querySelector('.cot-tipo').value;
    const profitInput = panel.querySelector('.cot-profit');
    const profitPct = parseFloat(profitInput.value) || 0;
    const profitManual = profitInput.dataset.tocado === '1';
    const fuelPct = parseFloat(panel.querySelector('.cot-fuel').value) || 0;
    const clienteId = parseInt(document.getElementById('liq-cliente').value, 10) || undefined;

    if ((!pais || pais === '—') && !zona) {
      NovaUtils.showAlert(alertBox, 'El envío no tiene país ni zona asignados', 'error');
      return;
    }

    try {
      btn.textContent = '...';
      btn.disabled = true;

      const res = await NovaAPI.liquidaciones.cotizar({
        pais, tipo, servicio, pesoFacturable, fob, fuelPct, profitPct, zona,
        cliente_id: clienteId,
        // profitManual true => backend usa profitPct; false => resuelve por matriz.
        profitManual,
      });

      // El backend puede haber resuelto el profit por matriz: usamos lo efectivamente
      // aplicado para mostrar y guardar (y sincronizamos el input si no fue manual).
      const profitAplicado = res.profit_aplicado != null ? res.profit_aplicado : profitPct;
      if (res.profit_aplicado != null && !profitManual) {
        profitInput.value = res.profit_aplicado;
        const row = btn.closest('.cot-panel');
        if (row) setProfitOrigenFila(row, origenLabel(res.profit_origen));
      }

      // Guardar resultado en el mapa
      cotizacionesMap[envioId] = {
        envio_id: envioId,
        profitPct: profitAplicado,
        servicio: res.servicio,
        precioFinal: res.precioFinal,
        utilidad: res.utilidad,
      };

      // Mostrar desglose interno
      const det = document.getElementById(`cot-det-${envioId}`);
      det.innerHTML = `
        <div class="cot-desglose">
          <div class="cot-fila"><span>Precio base (con fuel)</span><span>${NovaUtils.formatMoney(res.precioBase)}</span></div>
          <div class="cot-fila cot-profit-row"><span>Profit ${profitAplicado}%</span><span>+ ${NovaUtils.formatMoney(res.profitMonto)}</span></div>
          <div class="cot-fila cot-total-row"><span>Precio final sugerido</span><span>${NovaUtils.formatMoney(res.precioFinal)}</span></div>
          <div class="cot-fila cot-utilidad-row"><span>💰 Utilidad empresa</span><span>${NovaUtils.formatMoney(res.utilidad)}</span></div>
        </div>
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center;">
          <label style="font-size:12px;color:#666;">Precio final (editable):</label>
          <input type="number" class="cot-precio-editable" step="0.01" value="${res.precioFinal}" style="width:110px;">
          <button type="button" class="btn btn-sm btn-primary btn-aplicar-cot" data-envio-id="${envioId}">Aplicar</button>
        </div>
      `;
      det.classList.remove('hidden');

      // Bind aplicar
      det.querySelector('.btn-aplicar-cot').addEventListener('click', () => {
        const precioEditable = parseFloat(det.querySelector('.cot-precio-editable').value) || res.precioFinal;
        cotizacionesMap[envioId].precioFinal = precioEditable;
        cotizacionesMap[envioId].utilidad = redondear2(precioEditable - res.precioBase);

        // Mostrar en la columna de resultado
        const resCell = document.getElementById(`cot-res-${envioId}`);
        resCell.innerHTML = `
          <span class="badge badge-cotizado">${NovaUtils.formatMoney(precioEditable)}</span>
          <span class="util-badge">💰 ${NovaUtils.formatMoney(cotizacionesMap[envioId].utilidad)}</span>
        `;

        // Cerrar panel
        document.getElementById(`cot-panel-${envioId}`).classList.add('hidden');
      });

    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message || 'Error al cotizar', 'error');
    } finally {
      btn.textContent = 'Calcular';
      btn.disabled = false;
    }
  }

  function redondear2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function getSelectedEnvios() {
    const rows = document.querySelectorAll('#liq-envios-body tr[data-envio-id]');
    const ids = [];
    const cargos = [];
    rows.forEach((row) => {
      const cb = row.querySelector('.liq-envio-check');
      if (cb?.checked) {
        const id = parseInt(row.dataset.envioId, 10);
        ids.push(id);
        const adic = parseFloat(row.querySelector('.liq-adicional')?.value) || 0;
        if (adic > 0) {
          cargos.push({ envio_id: id, monto: adic, descripcion: 'Cargo adicional' });
        }
      }
    });
    return { envio_ids: ids, cargos };
  }

  function getCotizaciones(envio_ids) {
    return envio_ids
      .filter(id => cotizacionesMap[id])
      .map(id => cotizacionesMap[id]);
  }

  async function calcularPreview() {
    const cliente_id = parseInt(document.getElementById('liq-cliente').value, 10);
    const { envio_ids, cargos } = getSelectedEnvios();
    if (!envio_ids.length) {
      NovaUtils.showAlert(alertBox, 'Seleccione al menos un envío', 'error');
      return;
    }
    const cotizaciones = getCotizaciones(envio_ids);
    try {
      const preview = await NovaAPI.liquidaciones.preview({
        cliente_id,
        envio_ids,
        cargos,
        cotizaciones,
      });
      lastPreview = { cliente_id, envio_ids, cargos, cotizaciones, preview };

      const tbody = document.getElementById('liq-preview-body');
      // Desglose de cara al cliente: solo lo que pagó. NO se muestran % Profit ni Utilidad
      // empresa (datos internos). El desglose cierra exacto en Total USD = total_cobrado.
      tbody.innerHTML = preview.items.map((i) => `
        <tr>
          <td>${i.envio?.numero_guia || i.envio_id}</td>
          <td>${NovaUtils.formatMoney(i.flete)}</td>
          <td>${NovaUtils.formatMoney(i.fuel)}</td>
          <td>${NovaUtils.formatMoney(i.seguro)}</td>
          <td>${NovaUtils.formatMoney(i.adicional)}</td>
          <td>${NovaUtils.formatMoney(i.total_usd)}</td>
        </tr>`).join('');

      document.getElementById('liq-total').innerHTML = `<strong>${NovaUtils.formatMoney(preview.total)}</strong>`;

      // Utilidad total empresa: dato interno, no se muestra en el documento del cliente.
      document.getElementById('liq-utilidad-total').classList.add('hidden');

      const fuels = [...new Set(preview.items.map((i) => `${i.envio?.courier || ''}: ${i.fuel_pct_usado}%`))];
      document.getElementById('fuel-info').textContent =
        `Fuel aplicado: ${fuels.filter(Boolean).join(' · ')}`;

      document.getElementById('liq-preview').classList.remove('hidden');
      document.getElementById('btn-confirmar-liq').disabled = false;
      document.getElementById('btn-export-borrador').disabled = false;
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message, 'error');
    }
  }

  async function confirmarLiquidacion() {
    if (!lastPreview) {
      await calcularPreview();
      if (!lastPreview) return;
    }
    try {
      let liq;
      if (lastLiquidacionId) {
        liq = await NovaAPI.liquidaciones.confirmar(lastLiquidacionId);
      } else {
        const { cliente_id, envio_ids, cargos, cotizaciones } = lastPreview;
        liq = await NovaAPI.liquidaciones.crear({
          cliente_id,
          periodo_desde: document.getElementById('liq-desde').value,
          periodo_hasta: document.getElementById('liq-hasta').value,
          envio_ids,
          cargos,
          cotizaciones,
          confirmar: true,
        });
        lastLiquidacionId = liq.id;
      }
      NovaUtils.showAlert(
        alertBox,
        `Liquidación #${liq.id} confirmada. Total: ${NovaUtils.formatMoney(liq.total)}`,
        'success'
      );
      enviosPendientesCliente = [];
      document.getElementById('liq-envios-wrap').classList.add('hidden');
      lastPreview = null;
      lastLiquidacionId = null;
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message, 'error');
    }
  }

  async function exportarActual() {
    try {
      const id = await ensureLiquidacionBorrador();
      if (id) window.open(NovaAPI.liquidaciones.exportarUrl(id), '_blank');
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message, 'error');
    }
  }

  async function ensureLiquidacionBorrador() {
    if (lastLiquidacionId) return lastLiquidacionId;
    if (!lastPreview) {
      await calcularPreview();
      if (!lastPreview) return null;
    }
    const { cliente_id, envio_ids, cargos, cotizaciones } = lastPreview;
    const liq = await NovaAPI.liquidaciones.crear({
      cliente_id,
      periodo_desde: document.getElementById('liq-desde').value,
      periodo_hasta: document.getElementById('liq-hasta').value,
      envio_ids,
      cargos,
      cotizaciones,
      confirmar: false,
    });
    lastLiquidacionId = liq.id;
    return liq.id;
  }

  function bindHistorial() {
    document.getElementById('btn-hist-filtrar').addEventListener('click', loadHistorial);
  }

  async function loadHistorial() {
    const params = {};
    const cid = document.getElementById('hist-cliente').value;
    if (cid) params.cliente_id = cid;
    const desde = document.getElementById('hist-desde').value;
    if (desde) params.fecha_desde = desde;
    const hasta = document.getElementById('hist-hasta').value;
    if (hasta) params.fecha_hasta = hasta;

    const tbody = document.getElementById('hist-body');
    try {
      const list = await NovaAPI.liquidaciones.listar(params);
      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty">Sin liquidaciones</td></tr>';
        return;
      }
      tbody.innerHTML = list.map((l) => `
        <tr>
          <td>${NovaUtils.formatDate(l.fecha)}</td>
          <td>${l.cliente_nombre}</td>
          <td>${NovaUtils.formatDate(l.periodo_desde)} – ${NovaUtils.formatDate(l.periodo_hasta)}</td>
          <td>${l.cantidad_envios}</td>
          <td>${NovaUtils.formatMoney(l.total)}</td>
          <td><span class="badge ${l.estado === 'confirmada' ? 'badge-liquidado' : 'badge-pendiente'}">${l.estado}</span></td>
          <td><button type="button" class="btn btn-sm btn-secondary" data-export="${l.id}">Excel</button></td>
        </tr>`
      ).join('');
      tbody.querySelectorAll('[data-export]').forEach((btn) => {
        btn.addEventListener('click', () => {
          window.open(NovaAPI.liquidaciones.exportarUrl(btn.dataset.export), '_blank');
        });
      });
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message, 'error');
    }
  }

  init();
})();
