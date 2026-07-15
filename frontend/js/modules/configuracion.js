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
      return `
      <div class="fuel-card ${alertClass}" data-courier="${c.courier}">
        <h4>${c.courier}</h4>
        <div class="current">${c.fuel_pct}%</div>
        <p class="fuel-age">${alertMsg}</p>
        <p class="hint">Actualizado: ${NovaUtils.formatDate(c.fecha_actualizacion?.slice(0, 10))}</p>
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
          NovaUtils.showAlert(alertBox, `Fuel ${courier} actualizado a ${fuel_pct}%`, 'success');
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
            <label>Tolerancia peso (%)</label>
            <input type="number" class="tol-peso" step="0.1" min="0" max="100" value="${c.tolerancia_peso_pct}">
          </div>
          <div class="form-group">
            <label>Tolerancia costo (%)</label>
            <input type="number" class="tol-costo" step="0.1" min="0" max="100" value="${c.tolerancia_costo_pct}">
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
        try {
          await NovaAPI.configuracion.actualizarTolerancias(courier, peso, costo);
          NovaUtils.showAlert(alertBox, `Tolerancias ${courier} actualizadas (peso ${peso}% · costo ${costo}%)`, 'success');
          loadTolerancias();
        } catch (err) {
          NovaUtils.showAlert(alertBox, err.message, 'error');
        }
      });
    });
  }

  async function init() {
    try {
      await loadFuel();
      await loadUmbral();
      await loadTolerancias();
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message, 'error');
    }
  }

  init();
})();
