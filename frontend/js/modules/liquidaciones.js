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
    // Pendientes arranca SIN fechas: muestra todo lo que hay sin liquidar, de cualquier
    // mes (03/09/2026, pedido de Felipe: "que de entrada muestre todo lo pendiente por
    // perfil para que no se pase nada de largo"). El filtro por mes queda para quien lo
    // quiera. Crear e Historial siguen con el mes en curso: el período de una liquidación
    // necesita fechas, y el historial es una consulta.
    ['liq-desde', 'hist-desde'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = iso(first);
    });
    ['liq-hasta', 'hist-hasta'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = iso(today);
    });
    ['pend-desde', 'pend-hasta'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
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
    document.getElementById('btn-pend-todo').addEventListener('click', () => {
      document.getElementById('pend-desde').value = '';
      document.getElementById('pend-hasta').value = '';
      loadPendientes();
    });
    bindBuscadorPendientes();
  }

  /* ── Buscador por cliente (15/09/2026) ────────────────────────────────────────────
     Felipe: *"agregame en liquidaciones un buscador por cliente, como el del módulo de
     clientes"*. Es el MISMO criterio que clientes.js: filtra en memoria lo que ya se
     trajo, sin tildes ni mayúsculas, y cada palabra tipeada tiene que aparecer en algún
     lado. Filtrar acá NO vuelve a pedirle nada al servidor: los filtros de arriba (fechas,
     courier, tipo de cobro) siguen valiendo y la lista no parpadea. */
  let gruposPendientes = [];
  let busquedaPend = '';

  function normalizarTxt(s) {
    return String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function pendientesFiltrados() {
    const q = normalizarTxt(busquedaPend).trim();
    if (!q) return gruposPendientes;
    const palabras = q.split(/\s+/);
    return gruposPendientes.filter((g) => {
      // Se busca por cliente, y de yapa por las guías del grupo: pasa seguido que uno tiene
      // el número de guía a mano y no se acuerda de qué cliente era.
      const pajar = normalizarTxt([g.cliente_nombre, ...(g.envios || []).map((e) => e.numero_guia)]
        .filter(Boolean).join(' '));
      return palabras.every((p) => pajar.includes(p));
    });
  }

  function bindBuscadorPendientes() {
    const input = document.getElementById('buscador-pendientes');
    if (!input) return;
    input.addEventListener('input', () => { busquedaPend = input.value; renderPendientes(); });
    // Escape limpia y devuelve la lista entera, sin sacar el foco del campo.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; busquedaPend = ''; renderPendientes(); }
    });
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

    try {
      gruposPendientes = await NovaAPI.liquidaciones.pendientes(params);
      renderPendientes();
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message, 'error');
    }
  }

  function renderPendientes() {
    const container = document.getElementById('pendientes-list');
    const cuenta = document.getElementById('buscador-pendientes-cuenta');
    const grupos = pendientesFiltrados();

    if (cuenta) {
      cuenta.textContent = busquedaPend.trim()
        ? `${grupos.length} de ${gruposPendientes.length}`
        : (gruposPendientes.length ? `${gruposPendientes.length} cliente(s)` : '');
    }
    pintarContadorPendientes();
    if (!gruposPendientes.length) {
      container.innerHTML = '<p class="empty">No hay envíos pendientes de liquidar</p>';
      return;
    }
    if (!grupos.length) {
      container.innerHTML = '<p class="empty">Ningún cliente coincide con la búsqueda.</p>';
      return;
    }

    container.innerHTML = grupos
      .map(
        (g) => `
      <div class="cliente-grupo">
        <div class="cliente-grupo-header">
          <strong>${g.cliente_nombre}</strong>
          <span class="cliente-grupo-meta">
            <span class="liq-chip cobro">${NovaUtils.tipoCobroLabel(g.tipo_cobro)}</span>
            <span>${g.envios.length} envío(s)</span>
            <span class="cliente-grupo-total">${NovaUtils.formatMoney(g.total_cobrado)}</span>
          </span>
          <button type="button" class="btn btn-sm btn-primary" data-liq-cliente="${g.cliente_id}">Liquidar</button>
        </div>
        <div class="cliente-grupo-body">
          <table>
            <thead><tr><th>Fecha</th><th>Guía</th><th>Courier</th><th>País</th><th class="n">Total</th></tr></thead>
            <tbody>
              ${g.envios.map((e) => `<tr>
                <td>${NovaUtils.formatDate(e.fecha)}</td>
                <td><span class="guia-num">${e.numero_guia}</span>${chipBorrador(e)}</td>
                <td>${chipCourier(e.courier)}</td>
                <td>${e.pais_destino}</td>
                <td class="n">${NovaUtils.formatMoney(e.total_cobrado)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`
      )
      .join('');

    container.querySelectorAll('[data-liq-cliente]').forEach((btn) => {
      btn.addEventListener('click', () => {
        // El período de la liquidación tiene que ABARCAR lo que se acaba de ver en
        // pendientes. Antes se saltaba a Crear con el mes en curso y los envíos de meses
        // anteriores del mismo grupo desaparecían: era la segunda forma de que se pasaran
        // de largo. Desde = el envío más viejo del grupo; hasta = hoy.
        // OJO: se busca en gruposPendientes (la lista ENTERA), no en lo que quedó filtrado:
        // el grupo es el mismo y así el botón no depende de lo que esté tipeado.
        const grupo = gruposPendientes.find((g) => String(g.cliente_id) === String(btn.dataset.liqCliente));
        if (grupo && grupo.envios.length) {
          const fechas = grupo.envios.map((e) => e.fecha).filter(Boolean).sort();
          document.getElementById('liq-desde').value = fechas[0];
          document.getElementById('liq-hasta').value = NovaUtils.hoyLocal(new Date());
        }
        document.querySelector('.tab[data-tab="crear"]').click();
        document.getElementById('liq-cliente').value = btn.dataset.liqCliente;
        document.getElementById('btn-cargar-envios').click();
      });
    });
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
    actualizarResumen();
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
    // Cualquier toque saca el "confirmada" del pie y vuelve al estado normal.
    ['liq-cliente', 'liq-desde', 'liq-hasta', 'liq-envios-body'].forEach((id) => {
      ['change', 'input'].forEach((ev) => document.getElementById(id).addEventListener(ev, () => {
        document.getElementById('liq-resumen-pie').classList.remove('ok');
        actualizarResumen();
      }));
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


      const tbody = document.getElementById('liq-envios-body');
      if (!enviosPendientesCliente.length) {
        document.getElementById('liq-envios-wrap').classList.remove('hidden');
        tbody.innerHTML = '<tr><td colspan="7" class="empty">Sin envíos en el período</td></tr>';
        actualizarResumen();
        return;
      }

      // ⚠️ Un envío SIN precio de venta (total 0) viene DESTILDADO y marcado: confirmarlo
      // lo dejaría liquidado en cero para siempre (defecto 3 de AUDITORIA-NUMEROS.md).
      // El backend además lo rechaza al confirmar; esto es para que ni siquiera moleste.
      tbody.innerHTML = enviosPendientesCliente.map((e) => {
        const sinPrecio = !(Number(e.total_cobrado) > 0);
        return `
        <tr data-envio-id="${e.id}" ${sinPrecio ? 'class="sin-precio" title="Sin precio de venta: si se liquidara, quedaría cobrado en CERO. Cargale el precio primero."' : ''}>
          <td><input type="checkbox" class="liq-envio-check" value="${e.id}" ${sinPrecio ? '' : 'checked'}></td>
          <td>${NovaUtils.formatDate(e.fecha)}</td>
          <td><span class="guia-num">${e.numero_guia}</span>${sinPrecio ? ' <span class="liq-chip sin-precio">SIN PRECIO</span>' : ''}${chipBorrador(e)}</td>
          <td>${chipCourier(e.courier)}</td>
          <td class="n">${NovaUtils.formatMoney(e.fob)}</td>
          <td class="n">${NovaUtils.formatMoney(e.total_cobrado)}</td>
          <td class="n"><input type="number" class="liq-adicional" step="0.01" min="0" value="0"></td>
        </tr>
      `; }).join('');

      document.getElementById('liq-envios-wrap').classList.remove('hidden');
      document.getElementById('liq-preview').classList.add('hidden');
      lastLiquidacionId = null;
      lastPreview = null;
      document.getElementById('btn-confirmar-liq').disabled = true;
      document.getElementById('btn-export-borrador').disabled = true;
      actualizarResumen();

      // El botón "Cotizar" por fila se sacó (29/07). Recalculaba y mostraba un precio,
      // pero el resultado NUNCA llegaba a la liquidación: el backend ignora `cotizaciones`
      // a propósito desde que se decidió que la liquidación NO recotiza y lee los valores
      // congelados del envío (ver el comentario en liquidacion.model.js). El botón era lo
      // que quedó de la etapa anterior.

    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message, 'error');
    }
  }

  // Pendiente 52 (12/09): el envío que ya está en un borrador se marca en las dos listas.
  function chipBorrador(e) {
    if (!e.borrador_id) return '';
    return ` <span class="chip-borrador" title="Este envío ya está en el borrador #${e.borrador_id}. Si armás otro con él, el sistema te va a avisar.">📝 en borrador #${e.borrador_id}</span>`;
  }

  // Pinta (o esconde) el aviso de la vista previa con los borradores que ya tienen envíos
  // de la selección, con un botón para borrar cada uno.
  function pintarAvisoBorradores(lista) {
    let box = document.getElementById('liq-aviso-borradores');
    if (!box) {
      box = document.createElement('div');
      box.id = 'liq-aviso-borradores';
      box.className = 'liq-aviso-borradores';
      const prev = document.getElementById('liq-preview');
      prev.insertBefore(box, prev.firstChild);
    }
    if (!lista || !lista.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = `<strong>⚠ Ojo:</strong> ${lista.length === 1 ? 'hay un borrador anterior' : `hay ${lista.length} borradores anteriores`} con envíos de esta selección. Si seguís, el sistema te va a pedir borrarlo antes de crear uno nuevo.
      <ul>${lista.map((b) => `<li>Borrador <strong>#${b.id}</strong> del ${NovaUtils.formatDate(b.fecha)} · ${b.guias.length} envío${b.guias.length === 1 ? '' : 's'} en común: ${b.guias.join(', ')}
        <button type="button" class="btn btn-sm btn-secondary" data-borrar-previo="${b.id}">Borrar ese borrador</button></li>`).join('')}</ul>`;
    box.querySelectorAll('[data-borrar-previo]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.borrarPrevio;
        if (!confirm(`¿Borrar el borrador #${id}? Sus envíos siguen pendientes; no se pierde nada.`)) return;
        try {
          await NovaAPI.liquidaciones.eliminarBorrador(id);
          NovaUtils.showAlert(alertBox, `Borrador #${id} borrado.`, 'success');
          await calcularPreview();
        } catch (err) {
          NovaUtils.showAlert(alertBox, err.message, 'error');
        }
      });
    });
  }

  // Crea la liquidación (borrador o confirmada). Si el servidor contesta 409 porque esos
  // envíos ya están en otro borrador, pregunta y vuelve a intentar pidiendo reemplazarlo.
  async function crearConAviso(datos) {
    try {
      return await NovaAPI.liquidaciones.crear(datos);
    } catch (err) {
      if (err.status !== 409 || !Array.isArray(err.borradores) || !err.borradores.length) throw err;
      const detalle = err.borradores.map((b) => `• #${b.id} del ${NovaUtils.formatDate(b.fecha)}: ${b.guias.join(', ')}`).join('\n');
      const ok = confirm(`Estos envíos ya están en otro borrador:\n${detalle}\n\n¿Borrar ${err.borradores.length === 1 ? 'ese borrador' : 'esos borradores'} y seguir con este? (Sus otros envíos siguen pendientes; no se pierde nada.)`);
      if (!ok) throw new Error('No se creó la liquidación: los envíos siguen en el borrador anterior.');
      return NovaAPI.liquidaciones.crear({ ...datos, reemplazar_borradores: err.borradores.map((b) => b.id) });
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
      // Profit por envío (07/09, pedido de Felipe): "solo para que vea la oficina". Va en una
      // columna propia, marcada como interna, y NO viaja al Excel (exportarLiquidacion no lo lee).
      // El desglose del Adicional (surge con fuel, GoGreen, manejo…) va debajo del número.
      tbody.innerHTML = preview.items.map((i) => `
        <tr>
          <td><span class="guia-num">${i.envio?.numero_guia || i.envio_id}</span></td>
          <td class="n">${NovaUtils.formatMoney(i.flete)}</td>
          <td class="n">${NovaUtils.formatMoney(i.fuel)}</td>
          <td class="n">${NovaUtils.formatMoney(i.seguro)}</td>
          <td class="n">${NovaUtils.formatMoney(i.adicional)}${adicDetalleHtml(i.adicional_detalle)}</td>
          <td class="n">${NovaUtils.formatMoney(i.total_usd)}</td>
          <td class="liq-interno">${profitInternoHtml(i)}</td>
        </tr>`).join('');

      document.getElementById('liq-total').innerHTML = `<strong>${NovaUtils.formatMoney(preview.total)}</strong>`;
      // Total interno: utilidad de la liquidación y % sobre el costo (misma convención que Salidas).
      {
        const util = preview.items.reduce((s, i) => s + (Number(i.utilidad_usd) || 0), 0);
        const costo = preview.items.reduce((s, i) => s + ((Number(i.precio_cotizado) || 0) - (Number(i.utilidad_usd) || 0)), 0);
        const pct = costo > 0 ? (util / costo) * 100 : null;
        document.getElementById('liq-profit-total').innerHTML =
          `<span class="${util < 0 ? 'neg' : ''}">${pct != null ? pct.toFixed(1) + '% · ' : ''}${NovaUtils.formatMoney(util)}</span>`;
      }

      // Utilidad total empresa: dato interno, no se muestra en el documento del cliente.
      document.getElementById('liq-utilidad-total').classList.add('hidden');

      const fuels = [...new Set(preview.items.map((i) => `${i.envio?.courier || ''}: ${i.fuel_pct_usado}%`))];
      document.getElementById('fuel-info').textContent =
        `Fuel aplicado: ${fuels.filter(Boolean).join(' · ')}`;

      pintarAvisoBorradores(preview.en_borrador);
      document.getElementById('liq-preview').classList.remove('hidden');
      document.getElementById('btn-confirmar-liq').disabled = false;
      document.getElementById('btn-export-borrador').disabled = false;
      actualizarResumen();
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
        liq = await crearConAviso({
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
      document.getElementById('liq-envios-body').innerHTML = '';
      lastPreview = null;
      lastLiquidacionId = null;
      actualizarResumen();
      document.getElementById('liq-resumen-pie').textContent = `Liquidación #${liq.id} confirmada.`;
      document.getElementById('liq-resumen-pie').classList.add('ok');
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
    const liq = await crearConAviso({
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
          <td><strong>${l.cliente_nombre}</strong></td>
          <td>${NovaUtils.formatDate(l.periodo_desde)} – ${NovaUtils.formatDate(l.periodo_hasta)}</td>
          <td class="n">${l.cantidad_envios}</td>
          <td class="n"><strong>${NovaUtils.formatMoney(l.total)}</strong></td>
          <td><span class="liq-chip ${l.estado === 'confirmada' ? 'confirmada' : 'borrador'}">${l.estado}</span> <span class="liq-num-id">#${l.id}</span></td>
          <td class="acciones">
            <button type="button" class="btn btn-sm btn-outline" data-export="${l.id}">Excel</button>
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

  // ── Rediseño (16/09/2026): chips, contador y resumen lateral ─────────────────
  function chipCourier(c) {
    const k = String(c || '').toUpperCase();
    return k ? `<span class="liq-chip courier-${k}">${k}</span>` : '';
  }

  // Cuántos clientes hay sin liquidar y por cuánto: en la pestaña y en la cabecera.
  function pintarContadorPendientes() {
    const n = gruposPendientes.length;
    const total = gruposPendientes.reduce((s, g) => s + (Number(g.total_cobrado) || 0), 0);
    const badge = document.getElementById('tab-badge-pendientes');
    if (badge) { badge.textContent = String(n); badge.hidden = !n; }
    const pill = document.getElementById('liq-pill-pendientes');
    if (pill) {
      pill.textContent = n ? `${n} cliente${n === 1 ? '' : 's'} sin liquidar · ${NovaUtils.formatMoney(total)}` : '';
      pill.classList.toggle('vacio', !n);
    }
  }

  // El resumen lateral de Crear: se arma SIEMPRE de lo que está en pantalla (cliente
  // elegido, tildes, adicionales tipeados) y, una vez calculada, de la vista previa. No
  // recalcula nada: el total sale del preview del servidor, que es el que manda.
  function actualizarResumen() {
    const q = (r) => document.querySelector(`.liq-resumen [data-r="${r}"]`);
    if (!q('cliente')) return;
    const sel = document.getElementById('liq-cliente');
    const nombreCli = sel && sel.value ? sel.options[sel.selectedIndex].textContent.replace(/\s*\([^)]*\)\s*$/, '') : '';
    q('cliente').textContent = nombreCli || '—';
    const d = document.getElementById('liq-desde').value, h = document.getElementById('liq-hasta').value;
    q('periodo').textContent = d && h ? `${NovaUtils.formatDate(d)} – ${NovaUtils.formatDate(h)}` : '—';

    const filas = [...document.querySelectorAll('#liq-envios-body tr[data-envio-id]')];
    const marcadas = filas.filter((r) => r.querySelector('.liq-envio-check')?.checked);
    q('envios').textContent = filas.length ? `${marcadas.length} de ${filas.length}` : '—';
    const adic = marcadas.reduce((s, r) => s + (parseFloat(r.querySelector('.liq-adicional')?.value) || 0), 0);
    q('adicionales').textContent = filas.length ? (adic > 0 ? NovaUtils.formatMoney(adic) : '—') : '—';

    const preview = lastPreview && lastPreview.preview;
    q('total').textContent = preview ? NovaUtils.formatMoney(preview.total) : '—';
    const box = document.getElementById('liq-res-profit');
    if (box) {
      if (preview) {
        const util = preview.items.reduce((s, i) => s + (Number(i.utilidad_usd) || 0), 0);
        const costo = preview.items.reduce((s, i) => s + ((Number(i.precio_cotizado) || 0) - (Number(i.utilidad_usd) || 0)), 0);
        const pct = costo > 0 ? (util / costo) * 100 : null;
        box.querySelector('[data-r="profit"]').textContent = `${pct != null ? pct.toFixed(1) + '% · ' : ''}${NovaUtils.formatMoney(util)}`;
        box.classList.remove('hidden');
      } else {
        box.classList.add('hidden');
      }
    }

    // Los pasos 2 y 3 se "prenden" cuando tienen algo que mostrar.
    document.getElementById('liq-paso-2').classList.toggle('apagado', !filas.length);
    document.getElementById('liq-paso-2-vacio').classList.toggle('hidden', !!filas.length);
    document.getElementById('liq-paso-2-extra').textContent = filas.length ? `${marcadas.length} marcado${marcadas.length === 1 ? '' : 's'}` : '';
    document.getElementById('liq-paso-3').classList.toggle('apagado', !preview);
    document.getElementById('liq-paso-3-vacio').classList.toggle('hidden', !!preview);
    const pie = document.getElementById('liq-resumen-pie');
    if (pie && !pie.classList.contains('ok')) {
      pie.textContent = preview
        ? 'Listo para confirmar o exportar. Si cambiás la selección, hay que recalcular.'
        : (filas.length ? 'Apretá Calcular para ver el desglose y el total.' : 'Elegí el cliente y el período, y cargá sus envíos.');
    }
  }

  // ── Vista previa: profit interno y desglose del Adicional (07/09) ────────────
  function profitInternoHtml(i) {
    if (i.profit_pct == null && i.utilidad_usd == null) return '<span class="em">—</span>';
    const util = Number(i.utilidad_usd) || 0;
    const pct = i.profit_pct != null ? `${Number(i.profit_pct).toFixed(1)}% · ` : '';
    return `<span class="${util < 0 ? 'neg' : ''}" title="Utilidad estimada del envío: venta − costo congelado en el alta">${pct}${NovaUtils.formatMoney(util)}</span>`;
  }

  function adicDetalleHtml(detalle) {
    if (!Array.isArray(detalle) || !detalle.length) return '';
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<span class="liq-adic-detalle">${detalle.map((d) => `<span>${esc(d.label)} ${NovaUtils.formatMoney(d.monto)}</span>`).join(' · ')}</span>`;
  }

  init();
})();
