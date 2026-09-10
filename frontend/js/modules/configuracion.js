(function () {
  const alertBox = document.getElementById('alert-box');

  function diasDesde(fechaStr) {
    if (!fechaStr) return null;
    const diff = Date.now() - new Date(fechaStr).getTime();
    return Math.floor(diff / 86400000);
  }

  async function loadFuel() {
    const configs = await NovaAPI.configuracion.fuel();
    const container = document.getElementById('fuel-cards');
    container.innerHTML = configs.map((c) => {
      const dias = diasDesde(c.fecha_actualizacion);
      const alertClass = dias >= 14 ? 'fuel-card--danger' : dias >= 7 ? 'fuel-card--warn' : '';
      const alertMsg = dias >= 14
        ? `Hace ${dias} días — actualizar urgente`
        : dias >= 7
        ? `Hace ${dias} días — verificar`
        : dias !== null ? `Hace ${dias} día${dias === 1 ? '' : 's'}` : '';
      // El Fuel Nova es el nuestro y el que se aplica por defecto al cargar un envio, asi
      // que se distingue de los otros dos: los del courier son lo que NOS cobran a nosotros.
      const esNova = c.courier === 'NOVA';
      const titulo = esNova ? 'Fuel Nova' : `Fuel ${c.courier}`;
      const bajada = esNova
        ? 'El que le cobramos al cliente. Es el que viene elegido por defecto al cargar un envio.'
        : `Lo que nos cobra ${c.courier}.`;
      // Sin cargar nunca, el fuel de Nova queda en 0 y eso NO puede pasar desapercibido:
      // un envio cotizado sin combustible se ve razonable y sale mal cobrado.
      const sinCargar = esNova && !Number(c.fuel_pct);
      return `
      <div class="fuel-card ${sinCargar ? 'fuel-card--danger' : alertClass}${esNova ? ' fuel-card--nova' : ''}" data-courier="${c.courier}">
        <h4>${titulo}</h4>
        <div class="current">${c.fuel_pct}%</div>
        <p class="fuel-age">${sinCargar ? 'SIN CARGAR — los envios nuevos se estan cotizando sin combustible' : alertMsg}</p>
        <p class="hint">${bajada}</p>
        <p class="hint">Actualizado: ${c.fecha_actualizacion ? NovaUtils.formatDate(c.fecha_actualizacion.slice(0, 10)) : 'nunca'}</p>
        <div class="form-group" style="margin-top:0.75rem">
          <label>Nuevo % fuel</label>
          <input type="number" class="fuel-input" step="0.1" min="0" value="${c.fuel_pct}">
        </div>
        <button type="button" class="btn btn-primary btn-sm btn-save-fuel" style="margin-top:0.5rem">Guardar</button>
      </div>`;
    }).join('');

    container.querySelectorAll('.btn-save-fuel').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.fuel-card');
        const courier = card.dataset.courier;
        const fuel_pct = parseFloat(card.querySelector('.fuel-input').value);
        try {
          await NovaAPI.configuracion.actualizarFuel(courier, fuel_pct);
          NovaUtils.showAlert(alertBox,
            `${courier === 'NOVA' ? 'Fuel Nova' : 'Fuel ' + courier} actualizado a ${fuel_pct}%`,
            'success');
          loadFuel();
        } catch (err) {
          NovaUtils.showAlert(alertBox, err.message, 'error');
        }
      });
    });

    const hist = await NovaAPI.configuracion.historialFuel();
    const tbody = document.getElementById('fuel-hist-body');
    tbody.innerHTML = hist.length
      ? hist.map((h) => `<tr>
          <td>${h.fecha_cambio}</td>
          <td>${h.courier}</td>
          <td>${h.fuel_pct_anterior}%</td>
          <td>${h.fuel_pct_nuevo}%</td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="empty">Sin cambios registrados</td></tr>';
  }

  async function loadUmbral() {
    const umbrales = await NovaAPI.configuracion.umbral();
    const container = document.getElementById('umbral-cards');
    container.innerHTML = umbrales.map((c) => `
      <div class="fuel-card" data-courier="${c.courier}">
        <h4>${c.courier}</h4>
        <div class="current">${c.ganancia_minima_pct}%</div>
        <div class="form-group" style="margin-top:0.75rem">
          <label>Ganancia mínima antes de alertar (%)</label>
          <input type="number" class="umbral-input" step="1" min="0" value="${c.ganancia_minima_pct}">
        </div>
        <button type="button" class="btn btn-primary btn-sm btn-save-umbral" style="margin-top:0.5rem">Guardar</button>
      </div>`).join('');

    container.querySelectorAll('.btn-save-umbral').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.fuel-card');
        const courier = card.dataset.courier;
        const ganancia_minima_pct = parseFloat(card.querySelector('.umbral-input').value);
        try {
          await NovaAPI.configuracion.actualizarUmbral(courier, ganancia_minima_pct);
          NovaUtils.showAlert(alertBox, `Umbral de ganancia ${courier} actualizado a ${ganancia_minima_pct}%`, 'success');
          loadUmbral();
        } catch (err) {
          NovaUtils.showAlert(alertBox, err.message, 'error');
        }
      });
    });

    const umbralHist = await NovaAPI.configuracion.historialUmbral();
    const umbralTbody = document.getElementById('umbral-hist-body');
    umbralTbody.innerHTML = umbralHist.length
      ? umbralHist.map((h) => `<tr>
          <td>${h.fecha_cambio}</td>
          <td>${h.courier}</td>
          <td>${h.ganancia_pct_anterior}%</td>
          <td>${h.ganancia_pct_nuevo}%</td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="empty">Sin cambios registrados</td></tr>';
  }

  async function loadTolerancias() {
    const tolerancias = await NovaAPI.configuracion.tolerancias();
    const container = document.getElementById('tolerancia-cards');
    container.innerHTML = tolerancias.map((c) => `
      <div class="fuel-card" data-courier="${c.courier}">
        <h4>${c.courier}</h4>
        <div class="tol-inputs">
          <div class="form-group">
            <label>Tolerancia costo (%)</label>
            <input type="number" class="tol-costo" step="0.1" min="0" max="100" value="${c.tolerancia_costo_pct}">
          </div>
          <div class="form-group">
            <label>Tolerancia costo (USD)</label>
            <input type="number" class="tol-costo-usd" step="1" min="0" value="${c.tolerancia_costo_usd}">
          </div>
          <div class="form-group">
            <label>Tolerancia peso (%)</label>
            <input type="number" class="tol-peso" step="0.1" min="0" max="100" value="${c.tolerancia_peso_pct}">
          </div>
          <div class="form-group">
            <label>Tolerancia peso (kg)</label>
            <input type="number" class="tol-peso-kg" step="0.1" min="0" value="${c.tolerancia_peso_kg}">
          </div>
        </div>
        <button type="button" class="btn btn-primary btn-sm btn-save-tol" style="margin-top:0.5rem">Guardar</button>
      </div>`).join('');

    container.querySelectorAll('.btn-save-tol').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.fuel-card');
        const courier = card.dataset.courier;
        const peso = parseFloat(card.querySelector('.tol-peso').value);
        const costo = parseFloat(card.querySelector('.tol-costo').value);
        const costoUsd = parseFloat(card.querySelector('.tol-costo-usd').value);
        const pesoKg = parseFloat(card.querySelector('.tol-peso-kg').value);
        try {
          await NovaAPI.configuracion.actualizarTolerancias(courier, peso, costo, costoUsd, pesoKg);
          NovaUtils.showAlert(alertBox, `Tolerancias ${courier} actualizadas (costo ${costo}% o ${costoUsd} USD · peso ${peso}% o ${pesoKg} kg)`, 'success');
          loadTolerancias();
        } catch (err) {
          NovaUtils.showAlert(alertBox, err.message, 'error');
        }
      });
    });
  }

  // Fecha de corte del control (07/09): desde cuándo el panel de salud y las bandejas de
  // Facturas destacan cosas. Un solo click guarda (regla siete: sin dos pasos).
  async function loadCorte() {
    const r = await NovaAPI.configuracion.corte();
    const actual = document.getElementById('corte-actual');
    const input = document.getElementById('corte-input');
    if (!actual || !input) return;
    actual.textContent = NovaUtils.formatDate(r.fecha_corte_control);
    input.value = r.fecha_corte_control;
    const btn = document.getElementById('btn-corte-guardar');
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const v = input.value;
      if (!v) { NovaUtils.showAlert(alertBox, 'Elegí una fecha', 'error'); return; }
      btn.disabled = true;
      try {
        const res = await NovaAPI.configuracion.actualizarCorte(v);
        actual.textContent = NovaUtils.formatDate(res.fecha_corte_control);
        input.value = res.fecha_corte_control;
        NovaUtils.showAlert(alertBox, `Desde ahora el control arranca el ${NovaUtils.formatDate(res.fecha_corte_control)}.`, 'success');
      } catch (err) {
        input.value = r.fecha_corte_control;   // si falla, el control vuelve a lo guardado
        NovaUtils.showAlert(alertBox, err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  // Próximo Nº de proforma (10/09): el que el sistema pone al emitir una guía sin número.
  async function loadProforma() {
    const actual = document.getElementById('proforma-actual');
    const input = document.getElementById('proforma-input');
    if (!actual || !input) return;
    const r = await NovaAPI.configuracion.proforma();
    actual.textContent = String(r.proforma_proximo);
    input.value = r.proforma_proximo;
    const btn = document.getElementById('btn-proforma-guardar');
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const n = Number(input.value);
      if (!Number.isInteger(n) || n <= 0) { NovaUtils.showAlert(alertBox, 'Poné un número entero mayor que cero', 'error'); return; }
      btn.disabled = true;
      try {
        const res = await NovaAPI.configuracion.actualizarProforma(n);
        actual.textContent = String(res.proforma_proximo);
        input.value = res.proforma_proximo;
        NovaUtils.showAlert(alertBox, `La próxima proforma sin número va a ser la ${res.proforma_proximo}.`, 'success');
      } catch (err) {
        input.value = r.proforma_proximo;
        NovaUtils.showAlert(alertBox, err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function init() {
    try {
      await loadFuel();
      await loadCorte();
      await loadProforma();
      await loadUmbral();
      await loadTolerancias();
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message, 'error');
    }
  }

  init();
})();
