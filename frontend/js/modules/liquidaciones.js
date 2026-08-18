(function () {
  const alertBox = document.getElementById('alert-box');
  let clientes = [];
  let enviosPendientesCliente = [];
  let lastLiquidacionId = null;
  let lastPreview = null;


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

  // EL BORRADOR PEGADO (sospecha 6 de la auditoría, confirmada el 15/08): exportar creaba
  // el borrador y guardaba su id; cambiar la selección actualizaba la vista previa pero
  // Confirmar seguía apuntando al borrador viejo — se confirmaba otra cosa que la que se
  // veía. Regla nueva: CUALQUIER cambio (tildes, adicionales, cliente, fechas) invalida el
  // borrador y la vista previa, y hay que recalcular antes de confirmar o exportar. El
  // borrador viejo se borra del servidor para que no quede flotando como los #12 y #30.
  function invalidarBorrador() {
    if (lastLiquidacionId) {
      NovaAPI.liquidaciones.eliminarBorrador(lastLiquidacionId).catch(() => {});
      lastLiquidacionId = null;
    }
    lastPreview = null;
    document.getElementById('liq-preview').classList.add('hidden');
    document.getElementById('btn-confirmar-liq').disabled = true;
    document.getElementById('btn-export-borrador').disabled = true;
  }

  function bindCrear() {
    document.getElementById('btn-cargar-envios').addEventListener('click', cargarEnviosCliente);
    document.getElementById('liq-select-all').addEventListener('change', (e) => {
      document.querySelectorAll('.liq-envio-check').forEach((c) => {
        c.checked = e.target.checked;
      });
      invalidarBorrador();
    });
    // Delegado en el tbody porque las filas se redibujan con cada cliente.
    document.getElementById('liq-envios-body').addEventListener('change', (e) => {
      if (e.target.classList.contains('liq-envio-check')) invalidarBorrador();
    });
    document.getElementById('liq-envios-body').addEventListener('input', (e) => {
      if (e.target.classList.contains('liq-adicional')) invalidarBorrador();
    });
    document.getElementById('liq-cliente').addEventListener('change', invalidarBorrador);
    document.getElementById('liq-desde').addEventListener('change', invalidarBorrador);
    document.getElementById('liq-hasta').addEventListener('change', invalidarBorrador);
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


      const tbody = document.getElementById('liq-envios-body');
      if (!enviosPendientesCliente.length) {
        document.getElementById('liq-envios-wrap').classList.remove('hidden');
        tbody.innerHTML = '<tr><td colspan="7" class="empty">Sin envíos en el período</td></tr>';
        return;
      }

      // ⚠️ Un envío SIN precio de venta (total 0) viene DESTILDADO y marcado: confirmarlo
      // lo dejaría liquidado en cero para siempre (defecto 3 de AUDITORIA-NUMEROS.md).
      // El backend además lo rechaza al confirmar; esto es para que ni siquiera moleste.
      tbody.innerHTML = enviosPendientesCliente.map((e) => {
        const sinPrecio = !(Number(e.total_cobrado) > 0);
        return `
        <tr data-envio-id="${e.id}" ${sinPrecio ? 'style="background:#fffbeb" title="Sin precio de venta: si se liquidara, quedaría cobrado en CERO. Cargale el precio primero."' : ''}>
          <td><input type="checkbox" class="liq-envio-check" value="${e.id}" ${sinPrecio ? '' : 'checked'}></td>
          <td>${NovaUtils.formatDate(e.fecha)}</td>
          <td>${e.numero_guia}${sinPrecio ? ' <span style="font-size:0.7rem;font-weight:700;color:#b45309">SIN PRECIO</span>' : ''}</td>
          <td>${e.courier}</td>
          <td>${NovaUtils.formatMoney(e.fob)}</td>
          <td>${NovaUtils.formatMoney(e.total_cobrado)}</td>
          <td><input type="number" class="liq-adicional" step="0.01" min="0" value="0" style="width:80px"></td>
        </tr>
      `; }).join('');

      document.getElementById('liq-envios-wrap').classList.remove('hidden');
      document.getElementById('liq-preview').classList.add('hidden');
      lastLiquidacionId = null;
      lastPreview = null;
      document.getElementById('btn-confirmar-liq').disabled = true;
      document.getElementById('btn-export-borrador').disabled = true;

      // El botón "Cotizar" por fila se sacó (29/07). Recalculaba y mostraba un precio,
      // pero el resultado NUNCA llegaba a la liquidación: el backend ignora `cotizaciones`
      // a propósito desde que se decidió que la liquidación NO recotiza y lee los valores
      // congelados del envío (ver el comentario en liquidacion.model.js). El botón era lo
      // que quedó de la etapa anterior.

    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message, 'error');
    }
  }

  // ── Precarga de % profit desde la matriz ─────────────────────────
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


  async function calcularPreview() {
    const cliente_id = parseInt(document.getElementById('liq-cliente').value, 10);
    const { envio_ids, cargos } = getSelectedEnvios();
    if (!envio_ids.length) {
      NovaUtils.showAlert(alertBox, 'Seleccione al menos un envío', 'error');
      return;
    }
    // La liquidación NO recotiza: el backend arma el desglose con los valores
    // congelados en cada envío. Se manda vacío para no cambiar el contrato de la API.
    const cotizaciones = [];
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
        // Se manda la selección que se está viendo: si no coincide con el borrador, el
        // backend corta con 409 en vez de confirmar otra cosa (defensa en profundidad;
        // con la invalidación de arriba no debería pasar nunca).
        liq = await NovaAPI.liquidaciones.confirmar(lastLiquidacionId, getSelectedEnvios().envio_ids);
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
          <td style="display:flex;gap:0.35rem">
            <button type="button" class="btn btn-sm btn-secondary" data-export="${l.id}">Excel</button>
            ${l.estado !== 'confirmada' ? `<button type="button" class="btn btn-sm btn-danger" data-borrar="${l.id}" title="Borrar este borrador. No toca ningún envío: los envíos de un borrador siguen pendientes.">Borrar</button>` : ''}
          </td>
        </tr>`
      ).join('');
      tbody.querySelectorAll('[data-export]').forEach((btn) => {
        btn.addEventListener('click', () => {
          window.open(NovaAPI.liquidaciones.exportarUrl(btn.dataset.export), '_blank');
        });
      });
      // Borrar borradores muertos (los #12 y #30 del limitador L1 se sacan por acá).
      tbody.querySelectorAll('[data-borrar]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm(`¿Borrar el borrador #${btn.dataset.borrar}? Sus envíos siguen pendientes; no se pierde nada.`)) return;
          try {
            await NovaAPI.liquidaciones.eliminarBorrador(btn.dataset.borrar);
            loadHistorial();
          } catch (err) {
            NovaUtils.showAlert(alertBox, err.message, 'error');
          }
        });
      });
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message, 'error');
    }
  }

  init();
})();
