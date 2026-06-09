(function () {
  const alertBox = document.getElementById('alert-box');
  let clientes = [];
  let fuelPctActual = { DHL: 39, UPS: 39 };

  async function init() {
    document.getElementById('fecha').value = new Date().toISOString().slice(0, 10);
    await loadClientes();
    await loadFuelConfig();
    bindTabs();
    bindForm();
    bindFilters();
    bindImport();
    bindPesoCalc();
    bindNuevoCliente();
    bindClienteProfit();
    bindCotizador();
    document.getElementById('btn-cancelar-edit').addEventListener('click', resetForm);
    document.getElementById('cantidad_bultos').addEventListener('change', renderBultos);
  }

  // Carga los % fuel actuales desde el backend
  async function loadFuelConfig() {
    try {
      const configs = await NovaAPI.configuracion.fuel();
      for (const c of configs) {
        fuelPctActual[c.courier] = c.fuel_pct;
      }
    } catch (_) { /* usa defaults si falla */ }
  }

  async function loadClientes() {
    clientes = await NovaAPI.clientes.listar();
    const selects = [document.getElementById('cliente_id'), document.getElementById('filtro-cliente')];
    for (const sel of selects) {
      const isFilter = sel.id === 'filtro-cliente';
      sel.innerHTML = isFilter ? '<option value="">Todos</option>' : '';
      for (const c of clientes) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.nombre;
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
        document.getElementById('panel-nuevo').classList.toggle('hidden', name !== 'nuevo');
        document.getElementById('panel-listado').classList.toggle('hidden', name !== 'listado');
        document.getElementById('panel-importar').classList.toggle('hidden', name !== 'importar');
        if (name === 'listado') loadListado();
      });
    });
  }

  function renderBultos() {
    const n = parseInt(document.getElementById('cantidad_bultos').value, 10) || 1;
    const section = document.getElementById('bultos-extra');
    const container = document.getElementById('bultos-container');
    if (n <= 1) {
      section.classList.add('hidden');
      container.innerHTML = '';
      updatePesos();
      return;
    }
    section.classList.remove('hidden');
    container.innerHTML = '';
    for (let i = 1; i <= n; i++) {
      const row = document.createElement('div');
      row.className = 'bulto-row';
      row.innerHTML = `
        <span>Bulto ${i}</span>
        <input type="number" data-bulto="${i}" data-field="largo" placeholder="Largo" step="0.1" min="0">
        <input type="number" data-bulto="${i}" data-field="ancho" placeholder="Ancho" step="0.1" min="0">
        <input type="number" data-bulto="${i}" data-field="alto" placeholder="Alto" step="0.1" min="0">
        <input type="number" data-bulto="${i}" data-field="peso_real" placeholder="Peso (opt.)" step="0.001" min="0">
      `;
      container.appendChild(row);
    }
    container.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('input', debounce(updatePesosYCotizacion, 300));
    });
    updatePesosYCotizacion();
  }

  function getBultosFromForm() {
    const n = parseInt(document.getElementById('cantidad_bultos').value, 10) || 1;
    if (n <= 1) return [];
    const bultos = [];
    for (let i = 1; i <= n; i++) {
      const largo = parseFloat(document.querySelector(`[data-bulto="${i}"][data-field="largo"]`)?.value);
      const ancho = parseFloat(document.querySelector(`[data-bulto="${i}"][data-field="ancho"]`)?.value);
      const alto = parseFloat(document.querySelector(`[data-bulto="${i}"][data-field="alto"]`)?.value);
      if (largo && ancho && alto) {
        bultos.push({
          numero_bulto: i,
          largo,
          ancho,
          alto,
          peso_real: parseFloat(
            document.querySelector(`[data-bulto="${i}"][data-field="peso_real"]`)?.value
          ) || null,
        });
      }
    }
    return bultos;
  }

  function bindPesoCalc() {
    ['peso_real', 'largo', 'ancho', 'alto', 'cantidad_bultos'].forEach((id) => {
      document.getElementById(id).addEventListener('input', debounce(updatePesosYCotizacion, 300));
    });
  }

  // ── Cotizador integrado ──────────────────────────────────────────
  function bindCotizador() {
    // Recalcular cuando cambian campos clave
    ['pais_destino', 'courier', 'tipo_envio', 'fob'].forEach((id) => {
      document.getElementById(id).addEventListener('change', debounce(updateCotizacion, 400));
      document.getElementById(id).addEventListener('input', debounce(updateCotizacion, 400));
    });

    // Mostrar selector de variante UPS solo cuando courier = UPS
    document.getElementById('courier').addEventListener('change', function () {
      document.getElementById('cot-ups-wrap').style.display = this.value === 'UPS' ? '' : 'none';
    });

    // Recalcular al cambiar variante UPS o % profit
    document.getElementById('cot-ups-variante').addEventListener('change', debounce(updateCotizacion, 400));
    document.getElementById('cot-profit').addEventListener('input', debounce(updateCotizacion, 400));
  }

  async function updatePesosYCotizacion() {
    await updatePesos();
    await updateCotizacion();
  }

  async function updatePesos() {
    const payload = {
      peso_real: parseFloat(document.getElementById('peso_real').value) || 0,
      largo: parseFloat(document.getElementById('largo').value) || null,
      ancho: parseFloat(document.getElementById('ancho').value) || null,
      alto: parseFloat(document.getElementById('alto').value) || null,
      bultos: getBultosFromForm(),
    };
    try {
      const p = await NovaAPI.envios.calcularPesos(payload);
      document.getElementById('peso-preview').textContent =
        `Peso volumétrico: ${p.pesoVolumetrico} kg | Peso facturable: ${p.pesoFacturable} kg`;
      document.getElementById('peso-preview').dataset.facturable = p.pesoFacturable;
    } catch {
      document.getElementById('peso-preview').textContent = 'Peso volumétrico: — | Peso facturable: —';
      document.getElementById('peso-preview').dataset.facturable = '';
    }
  }

  async function updateCotizacion() {
    const pais = document.getElementById('pais_destino').value.trim();
    const courier = document.getElementById('courier').value;
    const tipo_envio = document.getElementById('tipo_envio').value;
    const fob = parseFloat(document.getElementById('fob').value) || 0;
    const profitPct = parseFloat(document.getElementById('cot-profit').value) || 0;
    const pesoFacturable = parseFloat(document.getElementById('peso-preview').dataset.facturable) || 0;

    const zona = parseInt(document.getElementById('zona')?.value, 10) || undefined;
    const panel = document.getElementById('cot-panel');
    const resultado = document.getElementById('cot-resultado');

    // Necesita al menos país (o zona manual) y peso para cotizar
    if ((!pais && !zona) || pesoFacturable <= 0) {
      panel.classList.add('hidden');
      return;
    }

    // Mapear courier del form al servicio del cotizador
    const servicioUPS = document.getElementById('cot-ups-variante')?.value || 'UPS_EXP';
    const servicio = courier === 'DHL' ? 'DHL' : servicioUPS;
    const tipo = tipo_envio === 'exportacion' ? 'export' : 'import';
    const fuelPct = fuelPctActual[courier] || 39;

    try {
      const pesoReal1 = parseFloat(document.getElementById('peso_real').value) || 0;
      const bultosParaCotizar = [
        {
          pesoReal: pesoReal1,
          largo: parseFloat(document.getElementById('largo').value) || 0,
          ancho: parseFloat(document.getElementById('ancho').value) || 0,
          alto: parseFloat(document.getElementById('alto').value) || 0,
        },
        ...getBultosFromForm().map(b => ({ pesoReal: b.peso_real || 0, largo: b.largo, ancho: b.ancho, alto: b.alto })),
      ];
      const res = await NovaAPI.liquidaciones.cotizar({
        pais,
        tipo,
        servicio,
        pesoFacturable,
        fob,
        fuelPct,
        profitPct,
        zona,
        bultos: bultosParaCotizar,
      });

      panel.classList.remove('hidden');
      panel.classList.remove('cot-aplicado');

      resultado.innerHTML = `
        <div class="cot-desglose">
          <div class="cot-fila">
            <span>Servicio</span>
            <span><strong>${res.servicio}</strong> · Zona ${res.zona}</span>
          </div>
          <div class="cot-fila">
            <span>Precio base (con fuel ${fuelPct}%)</span>
            <span>${fmt(res.precioBase)}</span>
          </div>
          <div class="cot-fila cot-profit-row">
            <span>Profit ${profitPct}%</span>
            <span>+ ${fmt(res.profitMonto)}</span>
          </div>
          <div class="cot-fila cot-total-row">
            <span>Precio sugerido</span>
            <span>${fmt(res.precioFinal)}</span>
          </div>
          <div class="cot-fila cot-utilidad-row">
            <span>💰 Utilidad empresa</span>
            <span>${fmt(res.utilidad)}</span>
          </div>
        </div>
        <div class="cot-aplicar">
          <label>Precio a cobrar (editable):</label>
          <input type="number" id="cot-precio-editable" step="0.01" value="${res.precioFinal.toFixed(2)}">
          <button type="button" class="btn btn-primary btn-sm" id="btn-aplicar-precio">Usar este precio →</button>
          <span id="cot-estado" class="cot-estado"></span>
        </div>
      `;

      // Re-bind botón aplicar porque innerHTML lo regeneró
      document.getElementById('btn-aplicar-precio').addEventListener('click', () => {
        const precio = parseFloat(document.getElementById('cot-precio-editable').value);
        if (!isNaN(precio) && precio > 0) {
          document.getElementById('total_cobrado').value = precio.toFixed(2);
          panel.classList.add('cot-aplicado');
          document.getElementById('cot-estado').textContent = '✓ Precio aplicado al envío';
        }
      });

    } catch (err) {
      panel.classList.remove('hidden');
      resultado.innerHTML = `<p class="cot-aviso">⚠ No se encontró tarifa para "${pais}" en ${courier}. Ingresá el precio manualmente.</p>`;
    }
  }

  function fmt(n) {
    return 'US$ ' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // ────────────────────────────────────────────────────────────────

  function bindForm() {
    document.getElementById('form-envio').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('envio-id').value;
      const bultos = getBultosFromForm();
      const data = {
        cliente_id: parseInt(document.getElementById('cliente_id').value, 10),
        fecha: document.getElementById('fecha').value,
        courier: document.getElementById('courier').value,
        tipo_envio: document.getElementById('tipo_envio').value,
        numero_guia: document.getElementById('numero_guia').value.trim(),
        pais_destino: document.getElementById('pais_destino').value.trim(),
        zona: document.getElementById('zona').value.trim() || null,
        cantidad_bultos: parseInt(document.getElementById('cantidad_bultos').value, 10) || 1,
        peso_real: parseFloat(document.getElementById('peso_real').value),
        largo: parseFloat(document.getElementById('largo').value) || null,
        ancho: parseFloat(document.getElementById('ancho').value) || null,
        alto: parseFloat(document.getElementById('alto').value) || null,
        fob: parseFloat(document.getElementById('fob').value) || 0,
        asegurado: document.getElementById('asegurado').checked ? 1 : 0,
        total_cobrado: parseFloat(document.getElementById('total_cobrado').value) || 0,
        observaciones: document.getElementById('observaciones').value.trim() || null,
        bultos: bultos.length ? bultos : undefined,
      };
      try {
        if (id) {
          await NovaAPI.envios.actualizar(id, data);
          NovaUtils.showAlert(alertBox, 'Envío actualizado correctamente', 'success');
        } else {
          await NovaAPI.envios.crear(data);
          NovaUtils.showAlert(alertBox, 'Envío registrado correctamente', 'success');
        }
        resetForm();
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message, 'error');
      }
    });
  }

  function resetForm() {
    document.getElementById('form-envio').reset();
    document.getElementById('envio-id').value = '';
    document.getElementById('form-title').textContent = 'Cargar envío';
    document.getElementById('fecha').value = new Date().toISOString().slice(0, 10);
    document.getElementById('cantidad_bultos').value = 1;
    document.getElementById('bultos-extra').classList.add('hidden');
    document.getElementById('btn-cancelar-edit').classList.add('hidden');
    document.getElementById('cot-panel').classList.add('hidden');
    document.getElementById('cot-resultado').innerHTML = '';
    updatePesos();
  }

  async function editarEnvio(id) {
    const envio = await NovaAPI.envios.obtener(id);
    document.querySelector('.tab[data-tab="nuevo"]').click();
    document.getElementById('envio-id').value = envio.id;
    document.getElementById('form-title').textContent = 'Editar envío';
    document.getElementById('btn-cancelar-edit').classList.remove('hidden');
    document.getElementById('cliente_id').value = envio.cliente_id;
    document.getElementById('fecha').value = envio.fecha?.slice(0, 10);
    document.getElementById('courier').value = envio.courier;
    document.getElementById('tipo_envio').value = envio.tipo_envio;
    document.getElementById('numero_guia').value = envio.numero_guia;
    document.getElementById('pais_destino').value = envio.pais_destino;
    document.getElementById('zona').value = envio.zona || '';
    document.getElementById('cantidad_bultos').value = envio.cantidad_bultos;
    document.getElementById('peso_real').value = envio.peso_real;
    document.getElementById('largo').value = envio.largo || '';
    document.getElementById('ancho').value = envio.ancho || '';
    document.getElementById('alto').value = envio.alto || '';
    document.getElementById('fob').value = envio.fob;
    document.getElementById('asegurado').checked = Boolean(envio.asegurado);
    document.getElementById('total_cobrado').value = envio.total_cobrado;
    document.getElementById('observaciones').value = envio.observaciones || '';
    renderBultos();
    if (envio.bultos?.length) {
      for (const b of envio.bultos) {
        const set = (field, val) => {
          const el = document.querySelector(
            `[data-bulto="${b.numero_bulto}"][data-field="${field}"]`
          );
          if (el) el.value = val || '';
        };
        set('largo', b.largo);
        set('ancho', b.ancho);
        set('alto', b.alto);
        set('peso_real', b.peso_real);
      }
    }
    updatePesosYCotizacion();
  }

  function bindFilters() {
    document.getElementById('btn-filtrar').addEventListener('click', loadListado);
  }

  async function loadListado() {
    const params = {};
    const cid = document.getElementById('filtro-cliente').value;
    if (cid) params.cliente_id = cid;
    const desde = document.getElementById('filtro-desde').value;
    if (desde) params.fecha_desde = desde;
    const hasta = document.getElementById('filtro-hasta').value;
    if (hasta) params.fecha_hasta = hasta;
    const courier = document.getElementById('filtro-courier').value;
    if (courier) params.courier = courier;
    const tipo = document.getElementById('filtro-tipo').value;
    if (tipo) params.tipo_envio = tipo;
    const liq = document.getElementById('filtro-liquidado').value;
    if (liq !== '') params.liquidado = liq;

    const tbody = document.getElementById('tabla-envios');
    try {
      const envios = await NovaAPI.envios.listar(params);
      if (!envios.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty">Sin resultados</td></tr>';
        return;
      }
      tbody.innerHTML = envios.map((e) => `
        <tr>
          <td>${NovaUtils.formatDate(e.fecha)}</td>
          <td>${e.numero_guia}</td>
          <td>${e.cliente_nombre}</td>
          <td>${e.pais_destino}</td>
          <td><span class="badge badge-${e.courier.toLowerCase()}">${e.courier}</span></td>
          <td>${e.peso_facturable} kg</td>
          <td>${NovaUtils.formatMoney(e.total_cobrado)}</td>
          <td><span class="badge ${e.liquidado ? 'badge-liquidado' : 'badge-pendiente'}">${e.liquidado ? 'Liquidado' : 'Pendiente'}</span></td>
          <td>${e.liquidado ? '' : `<button type="button" class="btn btn-sm btn-secondary" data-edit="${e.id}">Editar</button>`}</td>
        </tr>`
      ).join('');
      tbody.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', () => editarEnvio(btn.dataset.edit));
      });
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message, 'error');
    }
  }

  function bindImport() {
    document.getElementById('btn-importar').addEventListener('click', async () => {
      const file = document.getElementById('archivo-excel').files[0];
      if (!file) {
        NovaUtils.showAlert(alertBox, 'Seleccione un archivo', 'error');
        return;
      }
      try {
        const res = await NovaAPI.envios.importar(file);
        document.getElementById('import-result').textContent = JSON.stringify(res, null, 2);
        NovaUtils.showAlert(
          alertBox,
          `Importados: ${res.importados}, omitidos: ${res.omitidos || 0}, errores: ${res.errores?.length || 0}`,
          'success'
        );
        await loadClientes();
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message, 'error');
      }
    });
  }

  function bindClienteProfit() {
    document.getElementById('cliente_id').addEventListener('change', function () {
      const id = parseInt(this.value, 10);
      const cliente = clientes.find((c) => c.id === id);
      if (cliente && cliente.tarifa_pct != null && cliente.tarifa_pct > 0) {
        document.getElementById('cot-profit').value = cliente.tarifa_pct;
      }
    });
  }

  function bindNuevoCliente() {
    document.getElementById('btn-nuevo-cliente').addEventListener('click', async () => {
      const nombre = prompt('Nombre del cliente:');
      if (!nombre?.trim()) return;
      const tipo = prompt('Tipo de cobro (D/S/Q/CC):', 'D')?.toUpperCase() || 'D';
      if (!['D', 'S', 'Q', 'CC'].includes(tipo)) {
        NovaUtils.showAlert(alertBox, 'Tipo de cobro inválido', 'error');
        return;
      }
      try {
        const c = await NovaAPI.clientes.crear({ nombre: nombre.trim(), tipo_cobro: tipo });
        await loadClientes();
        document.getElementById('cliente_id').value = c.id;
        NovaUtils.showAlert(alertBox, 'Cliente creado', 'success');
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message, 'error');
      }
    });
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  document.getElementById('btn-cancelar-edit').classList.add('hidden');
  init();
})();
