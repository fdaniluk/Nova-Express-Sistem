(function () {
  const alertBox = document.getElementById('alert-box');
  let clientes = [];
  let enviosPendientesCliente = [];
  // Cargos de envíos ya liquidados del cliente elegido en Crear (05/10): se muestran debajo
  // de la tabla de envíos y permiten liquidar aunque no haya ningún envío.
  let cargosAnterioresCliente = [];

  function pintarCargosPendientesCrear(lista) {
    let box = document.getElementById('liq-cargos-pend-crear');
    if (!box) {
      box = document.createElement('div');
      box.id = 'liq-cargos-pend-crear';
      document.getElementById('liq-envios-wrap').appendChild(box);
    }
    box.innerHTML = tablaCargosAnterioresHtml(lista);
    box.hidden = !lista.length;
  }
  let lastLiquidacionId = null;
  let lastPreview = null;


  async function init() {
    try { await loadClientes(); } catch (e) { NovaUtils.showAlert(document.getElementById('alert-box'), 'No se pudieron cargar los clientes: ' + e.message, 'error'); }
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
            <span>${g.envios.length ? `${g.envios.length} envío(s)` : 'Sin envíos pendientes'}</span>
            ${g.cargos_anteriores_n ? `<span class="liq-chip cargo-ant" title="Extracargos o impuestos DDP de envíos ya liquidados: entran solos en la próxima liquidación de este cliente. Si no tiene envíos, se puede liquidar solo con estos cargos.">+ ${g.cargos_anteriores_n} cargo${g.cargos_anteriores_n === 1 ? '' : 's'} de envíos anteriores · ${NovaUtils.formatMoney(g.cargos_anteriores_total)}</span>` : ''}
            <span class="cliente-grupo-total">${NovaUtils.formatMoney((g.total_cobrado || 0) + (g.cargos_anteriores_total || 0))}</span>
          </span>
          <button type="button" class="btn btn-sm btn-primary" data-liq-cliente="${g.cliente_id}">${g.envios.length ? 'Liquidar' : 'Liquidar solo los cargos'}</button>
        </div>
        <div class="cliente-grupo-body">
          ${g.envios.length ? `<table>
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
          </table>` : ''}
          ${tablaCargosAnterioresHtml(g.cargos_anteriores)}
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
        } else if (grupo) {
          // Solo cargos: el período es el mes en curso (no hay envíos que lo definan).
          const hoy = NovaUtils.hoyLocal(new Date());
          document.getElementById('liq-desde').value = hoy.slice(0, 8) + '01';
          document.getElementById('liq-hasta').value = hoy;
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
      cargosAnterioresCliente = grupos[0]?.cargos_anteriores || [];
      pintarCargosPendientesCrear(cargosAnterioresCliente);

      const tbody = document.getElementById('liq-envios-body');
      if (!enviosPendientesCliente.length) {
        document.getElementById('liq-envios-wrap').classList.remove('hidden');
        tbody.innerHTML = cargosAnterioresCliente.length
          ? '<tr><td colspan="7" class="empty">Sin envíos en el período. Este cliente tiene cargos de envíos anteriores pendientes (abajo): apretá <strong>Calcular</strong> para armar la liquidación solo con esos cargos.</td></tr>'
          : '<tr><td colspan="7" class="empty">Sin envíos en el período</td></tr>';
        document.getElementById('liq-preview').classList.add('hidden');
        lastLiquidacionId = null;
        lastPreview = null;
        document.getElementById('btn-confirmar-liq').disabled = true;
        document.getElementById('btn-export-borrador').disabled = true;
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

  // Concepto de un cargo posterior de cara a la oficina y al cliente (05/10): qué es, cuándo
  // lo informó el courier y, si corresponde, en qué liquidación se había cobrado el envío.
  function conceptoCargo(c) {
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    let t = esc(c.label);
    if (c.fecha) t += ` <small class="liq-muted">· informado el ${NovaUtils.formatDate(c.fecha)}</small>`;
    if (c.origen === 'impuestos_ddp') t += ' <span class="liq-chip">factura UPS</span>';
    return t;
  }

  // Tabla de cargos de envíos anteriores para la lista de Pendientes (05/10): guía, fecha
  // y país del envío, concepto e importe. Es lo mismo que va a entrar en la liquidación.
  function tablaCargosAnterioresHtml(lista) {
    if (!Array.isArray(lista) || !lista.length) return '';
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    return `<div class="liq-pend-cargos">
      <div class="liq-pend-cargos-titulo">Cargos de envíos anteriores (ya liquidados) · entran en la próxima liquidación</div>
      <table>
        <thead><tr><th>Fecha envío</th><th>Guía</th><th>País</th><th>Concepto</th><th class="n">USD</th></tr></thead>
        <tbody>${lista.map((c) => `<tr>
          <td>${NovaUtils.formatDate(c.envio_fecha)}</td>
          <td><span class="guia-num">${esc(c.numero_guia)}</span>${c.liquidacion_original_id ? ` <span class="liq-num-id" title="El envío se cobró en la liquidación #${c.liquidacion_original_id}">liq. #${c.liquidacion_original_id}</span>` : ''}</td>
          <td>${esc(c.pais_destino)}</td>
          <td>${conceptoCargo(c)}</td>
          <td class="n">${NovaUtils.formatMoney(c.monto)}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
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
    // El borrador que se está retomando (09/10) no es "otro": no se avisa sobre él.
    lista = (lista || []).filter((b) => Number(b.id) !== Number(lastLiquidacionId));
    if (!lista.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = `<strong>⚠ Ojo:</strong> ${lista.length === 1 ? 'hay un borrador anterior' : `hay ${lista.length} borradores anteriores`} con envíos de esta selección. Podés retomarlo tal cual estaba, o borrarlo y seguir con esta selección nueva.
      <ul>${lista.map((b) => `<li>Borrador <strong>#${b.id}</strong> del ${NovaUtils.formatDate(b.fecha)} · ${b.guias.length} envío${b.guias.length === 1 ? '' : 's'} en común: ${b.guias.join(', ')}
        <button type="button" class="btn btn-sm btn-outline" data-retomar-previo="${b.id}">Retomar ese borrador</button>
        <button type="button" class="btn btn-sm btn-secondary" data-borrar-previo="${b.id}">Borrar ese borrador</button></li>`).join('')}</ul>`;
    box.querySelectorAll('[data-retomar-previo]').forEach((btn) => btn.addEventListener('click', () => retomarBorrador(btn.dataset.retomarPrevio)));
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
    // Sin envíos marcados se puede igual si el cliente tiene cargos de envíos anteriores
    // (liquidación solo de cargos, 05/10). Si no hay nada, el backend lo dice.
    if (!envio_ids.length && !cargosAnterioresCliente.length) {
      NovaUtils.showAlert(alertBox, 'Seleccione al menos un envío (este cliente no tiene cargos pendientes de envíos anteriores).', 'error');
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
      tbody.innerHTML = (preview.items.length ? preview.items : []).map((i) => `
        <tr>
          <td><span class="guia-num">${i.envio?.numero_guia || i.envio_id}</span></td>
          <td class="n">${NovaUtils.formatMoney(i.flete)}</td>
          <td class="n">${NovaUtils.formatMoney(i.fuel)}</td>
          <td class="n">${NovaUtils.formatMoney(i.seguro)}</td>
          <td class="n">${NovaUtils.formatMoney(i.adicional)}${adicDetalleHtml(i.adicional_detalle)}</td>
          <td class="n">${NovaUtils.formatMoney(i.total_usd)}</td>
          <td class="liq-interno">${profitInternoHtml(i)}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="empty">Sin envíos: esta liquidación es solo de cargos de envíos anteriores (abajo).</td></tr>';

      // Con cargos de envíos anteriores, el pie de la tabla es "Total envíos" y el total
      // general lo cierra la sección de abajo (igual que el Excel).
      const conAnteriores = Array.isArray(preview.cargos_anteriores) && preview.cargos_anteriores.length > 0;
      document.getElementById('liq-total').innerHTML = `<strong>${NovaUtils.formatMoney(conAnteriores ? preview.total_envios : preview.total)}</strong>`;
      pintarCargosAnteriores(preview);
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

  // RETOMAR UN BORRADOR (09/10/2026, pedido de la oficina). Antes, si alguien armaba la
  // liquidación, bajaba el Excel para revisar y salía sin confirmar, el borrador quedaba
  // colgado y solo se podía borrar: había que volver a seleccionar, recalcular y crear otro.
  // Ahora se abre en "Crear liquidación" con el cliente, el período, sus envíos tildados y
  // sus adicionales; la vista previa se recalcula sobre los valores congelados (son los
  // mismos del borrador) y Confirmar / Excel actúan sobre ESE borrador, no sobre uno nuevo.
  async function retomarBorrador(id) {
    try {
      const liq = await NovaAPI.liquidaciones.obtener(id);
      if (!liq) throw new Error(`No se encontró la liquidación #${id}.`);
      if (liq.estado === 'confirmada') throw new Error(`La liquidación #${id} ya está confirmada: no se retoma, se consulta desde el historial.`);
      document.querySelector('.tab[data-tab="crear"]').click();
      document.getElementById('liq-cliente').value = String(liq.cliente_id);
      if (liq.periodo_desde) document.getElementById('liq-desde').value = String(liq.periodo_desde).slice(0, 10);
      if (liq.periodo_hasta) document.getElementById('liq-hasta').value = String(liq.periodo_hasta).slice(0, 10);
      await cargarEnviosCliente();
      const ids = new Set((liq.items || []).map((i) => Number(i.envio_id)));
      const faltan = [];
      document.querySelectorAll('.liq-envio-check').forEach((c) => { c.checked = ids.has(Number(c.value)); ids.delete(Number(c.value)); });
      // Lo que el borrador tenía y ya no está pendiente (se liquidó en otra, o cambió de período).
      for (const it of liq.items || []) if (ids.has(Number(it.envio_id))) faltan.push(it.numero_guia || it.envio_id);
      // Adicionales manuales por envío: lo que el backend ya separó como "manual" en el
      // detalle del ítem (cargos_adicionales también guarda filas espejo con la columna
      // entera, así que no se lee esa tabla a ciegas; ver liquidacion.model buscarPorId).
      for (const it of liq.items || []) {
        const manual = (it.adicional_detalle || []).filter((d) => d.tipo === 'manual').reduce((s, d) => s + (Number(d.monto) || 0), 0);
        const inp = document.querySelector(`tr[data-envio-id="${it.envio_id}"] .liq-adicional`);
        if (inp && manual > 0) inp.value = String(Math.round(manual * 100) / 100);
      }
      // Si al borrador le falta algún envío, ya no se puede confirmar tal cual (el backend
      // compara la selección con el borrador y corta con 409): se borra y Confirmar / Excel
      // crean uno nuevo con lo que quedó, que es lo que se está viendo.
      if (faltan.length) { await NovaAPI.liquidaciones.eliminarBorrador(id).catch(() => {}); lastLiquidacionId = null; }
      else lastLiquidacionId = Number(id);
      await calcularPreview();
      if (!lastPreview) { lastLiquidacionId = null; return; }
      // calcularPreview no toca lastLiquidacionId; queda apuntando al borrador retomado.
      if (!faltan.length) lastLiquidacionId = Number(id);
      document.getElementById('liq-resumen-pie').textContent = faltan.length ? 'Borrador retomado con menos envíos: al confirmar o exportar se arma uno nuevo.' : `Borrador #${id} retomado: revisá, bajá el Excel si hace falta y confirmá. Si cambiás algo, se reemplaza por uno nuevo.`;
      document.getElementById('liq-resumen-pie').classList.remove('ok');
      document.getElementById('liq-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (faltan.length) NovaUtils.showAlert(alertBox, `Ojo: ${faltan.length === 1 ? 'un envío del borrador ya no está pendiente' : `${faltan.length} envíos del borrador ya no están pendientes`} (${faltan.join(', ')}). La vista previa es con los que quedan; al confirmar o bajar el Excel se arma un borrador nuevo con eso.`, 'error');
      else NovaUtils.showAlert(alertBox, `Borrador #${id} retomado.`, 'success');
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message, 'error');
    }
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
          <td class="n">${l.cantidad_envios}${l.cantidad_cargos_anteriores ? ` <span class="liq-chip cargo-ant" title="Cargos de envíos anteriores incluidos en esta liquidación">+${l.cantidad_cargos_anteriores} cargo${l.cantidad_cargos_anteriores === 1 ? '' : 's'}</span>` : ''}</td>
          <td class="n"><strong>${NovaUtils.formatMoney(l.total)}</strong></td>
          <td><span class="liq-chip ${l.estado === 'confirmada' ? 'confirmada' : 'borrador'}">${l.estado}</span> <span class="liq-num-id">#${l.id}</span></td>
          <td class="acciones">
            <button type="button" class="btn btn-sm btn-outline" data-export="${l.id}">Excel</button>
            ${l.estado !== 'confirmada' ? `<button type="button" class="btn btn-sm btn-coral" data-retomar="${l.id}" title="Abre este borrador en Crear liquidación con sus envíos ya tildados, para revisarlo, bajar el Excel y confirmarlo.">Retomar</button>` : ''}
            ${l.estado !== 'confirmada' ? `<button type="button" class="btn btn-sm btn-danger" data-borrar="${l.id}" title="Borrar este borrador. No toca ningún envío: los envíos de un borrador siguen pendientes.">Borrar</button>` : ''}
          </td>
        </tr>`
      ).join('');
      tbody.querySelectorAll('[data-export]').forEach((btn) => {
        btn.addEventListener('click', () => {
          window.open(NovaAPI.liquidaciones.exportarUrl(btn.dataset.export), '_blank');
        });
      });
      tbody.querySelectorAll('[data-retomar]').forEach((btn) => btn.addEventListener('click', () => retomarBorrador(btn.dataset.retomar)));
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
        : (filas.length || cargosAnterioresCliente.length ? 'Apretá Calcular para ver el desglose y el total.' : 'Elegí el cliente y el período, y cargá sus envíos.');
    }
  }

  // ── Vista previa: profit interno y desglose del Adicional (07/09) ────────────
  function profitInternoHtml(i) {
    if (i.profit_pct == null && i.utilidad_usd == null) return '<span class="em">—</span>';
    const util = Number(i.utilidad_usd) || 0;
    const pct = i.profit_pct != null ? `${Number(i.profit_pct).toFixed(1)}% · ` : '';
    return `<span class="${util < 0 ? 'neg' : ''}" title="Utilidad estimada del envío: venta − costo congelado en el alta">${pct}${NovaUtils.formatMoney(util)}</span>`;
  }

  // Cargos de envíos anteriores (25/09/2026): extracargos o impuestos DDP que llegaron
  // cuando el envío ya estaba liquidado. Entran solos en esta liquidación, en su propia
  // sección (guía, fecha del envío, concepto, importe), igual que en el Excel.
  function pintarCargosAnteriores(preview) {
    let box = document.getElementById('liq-cargos-ant');
    const wrap = document.querySelector('#liq-preview .liq-tabla-wrap');
    if (!box) {
      box = document.createElement('div');
      box.id = 'liq-cargos-ant';
      box.className = 'liq-cargos-ant';
      wrap.insertAdjacentElement('afterend', box);
    }
    const lista = Array.isArray(preview.cargos_anteriores) ? preview.cargos_anteriores : [];
    const foot = document.querySelector('#liq-preview tfoot td:first-child');
    if (!lista.length) { box.hidden = true; box.innerHTML = ''; if (foot) foot.textContent = 'Total liquidación'; return; }
    if (foot) foot.textContent = 'Total envíos';
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    box.hidden = false;
    box.innerHTML = `
      <div class="liq-cargos-ant-head">
        <strong>Cargos de envíos anteriores</strong>
        <span class="liq-hint">Extracargos o impuestos DDP que el courier informó con el envío ya liquidado. Se cobran en esta liquidación, en su propia sección del Excel, con la guía, la fecha del envío y el concepto.</span>
      </div>
      <table class="liq-tabla liq-tabla-ant">
        <thead><tr><th>Fecha envío</th><th>Guía</th><th>País</th><th>Concepto</th><th class="n">USD</th></tr></thead>
        <tbody>${lista.map((c) => `
          <tr>
            <td>${NovaUtils.formatDate(c.envio_fecha)}</td>
            <td><span class="guia-num">${esc(c.numero_guia)}</span>${c.liquidacion_original_id ? ` <span class="liq-num-id" title="El envío se cobró en la liquidación #${c.liquidacion_original_id}">liq. #${c.liquidacion_original_id}</span>` : ''}</td>
            <td>${esc(c.pais_destino)}</td>
            <td>${conceptoCargo(c)}</td>
            <td class="n">${NovaUtils.formatMoney(c.monto)}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr><td colspan="4">Total cargos de envíos anteriores</td><td class="n">${NovaUtils.formatMoney(preview.total_cargos_anteriores)}</td></tr>
          <tr class="liq-total-general"><td colspan="4">Total liquidación</td><td class="n"><strong>${NovaUtils.formatMoney(preview.total)}</strong></td></tr>
        </tfoot>
      </table>`;
  }

  function adicDetalleHtml(detalle) {
    if (!Array.isArray(detalle) || !detalle.length) return '';
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<span class="liq-adic-detalle">${detalle.map((d) => `<span>${esc(d.label)} ${NovaUtils.formatMoney(d.monto)}</span>`).join(' · ')}</span>`;
  }

  init().catch((e) => NovaUtils.showAlert(document.getElementById('alert-box'), 'No se pudo cargar la pantalla: ' + e.message, 'error'));
})();
