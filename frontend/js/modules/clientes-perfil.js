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
      bindTarifario();
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

  // ── Matriz de tarifas ─────────────────────────────────
  // UI de edición. Un cliente puede cobrar de DOS maneras y esta pantalla las edita a las
  // dos, con la misma grilla:
  //   'porcentaje' → % de ganancia sobre el flete del courier (tabla profit_overrides).
  //                  Bandas de peso FIJAS, las mismas para todos.
  //   'por_kg'     → precio fijo en USD por kilo (tabla tarifa_kg_overrides). Los rangos
  //                  de peso los define cada cliente.
  // El modo lo guarda clientes.modo_tarifa y vale para las seis tablas del cliente.

  // ── Matriz unificada (13/08/2026) ──────────────────────────────────────────
  // TODA la matriz del cliente se ve de una: los tres servicios uno debajo del otro,
  // exportación e importación, con el precio por kilo y el porcentaje en la misma celda.
  // Los botones de arriba LLEVAN a cada servicio, no ocultan nada. Fue un pedido directo
  // de Felipe: "que se pueda ver la matriz de las tarifas todo de una, no en distintas
  // cosas". Antes había seis pestañas y un selector que obligaba a elegir qué mirar.
  //
  // Se guardan las DOCE matrices (3 servicios × expo/impo × kg/pct), clave "SERV|tipo".
  let matrices = {};
  // Impo sin datos arranca plegada en una línea; este set recuerda cuáles abrió la persona.
  const impoAbierta = { DHL: false, UPS_EXP: false, UPS_SAVER: false };
  let tarifasCargado = false;
  // La pantalla tiene DOS estados, pedido de Felipe (13/08): la VISTA, que muestra lo que
  // se cobra (un solo número por celda, sin edición), y la EDICIÓN, donde se elige qué
  // tabla se está tocando: 'pct' (porcentaje) o 'kg' (precio por kilo). null = vista.
  let editando = null;

  const SERVICIOS_MATRIZ = [
    { serv: 'DHL', nombre: 'DHL', chip: 'dhl', chipTxt: 'DHL' },
    { serv: 'UPS_EXP', nombre: 'UPS Express', chip: 'ups', chipTxt: 'UPS' },
    { serv: 'UPS_SAVER', nombre: 'UPS Saver', chip: 'ups', chipTxt: 'UPS' },
  ];
  const TIPOS_MATRIZ = ['export', 'import'];
  const claveM = (serv, tipo) => `${serv}|${tipo}`;

  const esPorKg = () => (clienteData && clienteData.modo_tarifa) === 'por_kg';

  // Tramos de peso del cliente (kg sobre peso facturable). NO son fijos: cada cliente puede
  // tener el suyo. Se traen del backend, que es el que manda; acá solo se dibujan. El juego
  // por defecto que hereda quien no tiene propios también viene en la respuesta, para poder
  // decirle a la persona si está viendo lo heredado o algo negociado.
  //
  // Arrancan en el por defecto por si la grilla se dibuja antes de que conteste el servidor.
  //
  // ⚠️ Estos NUEVE tienen que ser los mismos que `TRAMOS_POR_DEFECTO` de
  // `backend/src/services/profit.service.js`. Están duplicados a mano: al tocar una lista,
  // tocar la otra. Y no son los de 5 en 5 hasta 50 — esos son los SUGERIDOS, y llegan por
  // `r.sugeridos`. Poner los finos acá dibujaría una grilla con tramos que el motor no
  // resuelve, y la pantalla mostraría precios que el sistema no cobra.
  let TARIFAS_BANDAS = [
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
  let TARIFAS_SUGERIDOS = [];
  let tramosPropios = false;
  const TARIFAS_ZONAS = [1, 2, 3, 4, 5, 6];

  // Trae los tramos del cliente. Si falla, se sigue con los que haya: es preferible una
  // grilla dibujada con el juego por defecto a una pantalla en blanco.
  async function cargarTramos() {
    try {
      const r = await NovaAPI.clientes.tramos.obtener(clienteId);
      if (r && Array.isArray(r.tramos) && r.tramos.length > 0) {
        TARIFAS_BANDAS = r.tramos;
        tramosPropios = Boolean(r.propios);
      }
      if (r && Array.isArray(r.sugeridos)) TARIFAS_SUGERIDOS = r.sugeridos;
    } catch { /* se dibuja con los por defecto */ }
  }

  // En modo porcentaje la última banda es la de 50+; en modo por kilo el rango sin tope lo
  // define el cliente, así que la etiqueta sale del propio "desde" y no de un 50 fijo.
  function bandaLabel(b) {
    return b.max === null ? `${b.min}+ kg` : `${b.min}-${b.max} kg`;
  }

  // Overrides de UNA matriz por nivel. La matriz llega por parámetro porque ahora hay doce
  // a la vez, no una "activa".
  function overrideCelda(m, zona, min) {
    return m ? m.overrides.find((o) => o.zona === zona && o.peso_min === min) || null : null;
  }
  function overrideBanda(m, min) {
    return m ? m.overrides.find((o) => o.zona === null && o.peso_min === min) || null : null;
  }
  function overrideZona(m, zona) {
    return m ? m.overrides.find((o) => o.zona === zona && o.peso_min === null) || null : null;
  }

  // Valor efectivo dentro de una matriz, con la precedencia del backend:
  // celda → banda → zona → general de tabla. Sólo la celda cuenta como "propio".
  function efectivoEn(m, campo, zona, banda) {
    const c = overrideCelda(m, zona, banda.min);
    if (c) return { val: c[campo], propio: true };
    const b = overrideBanda(m, banda.min);
    if (b) return { val: b[campo], propio: false };
    const z = overrideZona(m, zona);
    if (z) return { val: z[campo], propio: false };
    if (m && m.general_tabla) return { val: m.general_tabla[campo], propio: false, general: true };
    return { val: null, propio: false };
  }

  // LA CELDA MUESTRA UN SOLO NÚMERO. En la VISTA es lo que se cobra: el precio por kilo
  // si el cliente cobra por kilo y hay precio; si no, el porcentaje. En EDICIÓN es el
  // valor crudo de la tabla que se está editando ('—' si no hay nada). Pedido de Felipe
  // (13/08): "o dice 70 o dice 5,50", nada de dos números en la misma celda.
  function valorEfectivo(serv, tipo, zona, banda) {
    const m = matrices[claveM(serv, tipo)] || {};
    const kg = efectivoEn(m.kg, 'precio_kg', zona, banda);
    const pct = efectivoEn(m.pct, 'profit_pct', zona, banda);
    const pctConCliente = pct.val !== null ? pct.val
      : (clienteData && clienteData.tarifa_pct != null ? clienteData.tarifa_pct : 0);

    if (editando === 'kg') {
      return { val: kg.val, propio: kg.propio, cero: kg.val === 0, unidad: 'kg' };
    }
    if (editando === 'pct') {
      return { val: pct.val !== null ? pct.val : pctConCliente, propio: pct.propio, unidad: 'pct' };
    }
    // Vista: EL PRECIO POR KILO DONDE HAY, EL PORCENTAJE DONDE NO. Es exactamente lo que
    // cobra el motor desde el 13/08: el precio por kilo cargado se cobra siempre, sin
    // importar el modo del cliente (pedido de Felipe).
    if (kg.val !== null) {
      return { val: kg.val, propio: false, cero: kg.val === 0, unidad: 'kg' };
    }
    return { val: pctConCliente, propio: false, unidad: 'pct', porPct: esPorKg() };
  }

  // Cómo se muestra un valor según su unidad.
  function formatoValor(val, unidad) {
    if (val === null || val === undefined) return '—';
    return unidad === 'kg' ? `USD ${Number(val).toFixed(2)}` : `${val}%`;
  }

  // Filas de la grilla: SIEMPRE los tramos del cliente, cobre por porcentaje o por kilo.
  //
  // Hasta el 11/08/2026 el modo por kilo dejaba que cada cliente inventara sus rangos, y la
  // grilla mostraba solo los que tuviera cargados. Eso hacía que la pantalla NO mostrara los
  // huecos: si alguien cargaba 1 a 3 kg, la fila de 3 a 5 no existía —ni en la pantalla ni
  // en la cabeza de nadie— y un envío de 4 kg terminaba cobrándose por porcentaje sin que se
  // enterara nadie. Encima los rangos podían pisarse entre sí.
  //
  // Ahora los tramos del cliente se muestran siempre, llenos o vacíos: un hueco pasa a ser
  // una celda gris que se ve. Y el juego está validado de punta a punta en el backend, así
  // que no puede tener agujeros ni solapes.
  //
  // ⚠️ Las filas que NO caen en ningún tramo del cliente se siguen mostrando, marcadas.
  // Son cargas viejas que todavía no se migraron. Si se mostraran solo los tramos, esas
  // filas desaparecerían de la pantalla mientras el sistema les sigue cobrando esos
  // precios. Un precio que se cobra y no se ve es exactamente lo que estamos evitando.
  function filasDeGrilla(serv, tipo) {
    const m = matrices[claveM(serv, tipo)] || {};
    const todas = [...(m.kg ? m.kg.overrides : []), ...(m.pct ? m.pct.overrides : [])];
    const viejas = todas
      .filter((o) => o.peso_min !== null && !TARIFAS_BANDAS.some((b) => b.min === o.peso_min && b.max === o.peso_max));
    const vistas = new Map();
    viejas.forEach((o) => {
      const k = `${o.peso_min}|${o.peso_max}`;
      if (!vistas.has(k)) vistas.set(k, { min: o.peso_min, max: o.peso_max, vieja: true });
    });
    if (vistas.size === 0) return TARIFAS_BANDAS;
    return [...TARIFAS_BANDAS, ...vistas.values()].sort((a, b) => a.min - b.min || (a.vieja ? 1 : -1));
  }

  // Trae TODO de una: los tramos y las doce matrices (3 servicios × expo/impo × kg/pct).
  // Son pedidos chicos y en paralelo; así cada celda puede mostrar el precio por kilo y el
  // porcentaje juntos sin volver al servidor.
  async function cargarMatriz() {
    try {
      await cargarTramos();
      const pedidos = [];
      for (const s of SERVICIOS_MATRIZ) {
        for (const tipo of TIPOS_MATRIZ) {
          pedidos.push((async () => {
            const [kg, pct] = await Promise.all([
              NovaAPI.clientes.tarifaKg.matriz(clienteId, s.serv, tipo),
              NovaAPI.clientes.profit.matriz(clienteId, s.serv, tipo),
            ]);
            matrices[claveM(s.serv, tipo)] = { kg, pct };
          })());
        }
      }
      await Promise.all(pedidos);
      renderModo();
      renderGrid();
    } catch (err) {
      NovaUtils.showAlert(alertBox, 'Error al cargar tarifas: ' + err.message);
    }
  }

  // Encabezado del panel: modo, fuel propio y la explicación de qué se está editando.
  function renderModo() {
    const fuel = document.getElementById('tarifas-fuel-input');
    const btnBorrarFuel = document.getElementById('btn-borrar-fuel');
    if (!fuel) return;

    const fuelPropio = clienteData ? clienteData.fuel_pct_propio : null;
    fuel.value = fuelPropio === null || fuelPropio === undefined ? '' : fuelPropio;
    btnBorrarFuel.classList.toggle('hidden', fuelPropio === null || fuelPropio === undefined);

    const ayuda = document.getElementById('tarifas-grid-ayuda');
    if (ayuda) {
      const deQuienSonLosTramos = tramosPropios
        ? 'Este cliente tiene tramos de peso propios, negociados con él: no son los que usa el resto.'
        : 'Los tramos de peso son los generales.';
      ayuda.textContent = `Lo que se carga es lo que se cobra: el precio por kilo gana en su cuadrante, el porcentaje cubre el resto. ${deQuienSonLosTramos} Para cambiar precios: Editar porcentaje o Editar precio por kilo.`;
    }

    renderSeguro();
  }

  // Seguro negociado del cliente. Vale para DHL y UPS por igual: cuando esta cargado,
  // reemplaza la escala del courier entera (ni el escalon de USD 15 de UPS ni el minimo
  // de 17,50 de DHL siguen aplicando).
  function renderSeguro() {
    const pct = document.getElementById('tarifas-seguro-pct');
    const min = document.getElementById('tarifas-seguro-min');
    const btnBorrar = document.getElementById('btn-borrar-seguro');
    const hint = document.getElementById('tarifas-seguro-hint');
    if (!pct) return;

    const vacio = (v) => v === null || v === undefined || v === '';
    const segPct = clienteData ? clienteData.seguro_pct_propio : null;
    const segMin = clienteData ? clienteData.seguro_min_propio : null;
    pct.value = vacio(segPct) ? '' : segPct;
    min.value = vacio(segMin) ? '' : segMin;
    btnBorrar.classList.toggle('hidden', vacio(segPct));

    if (vacio(segPct)) {
      hint.textContent =
        'Sin seguro propio usa la escala de cada courier: UPS 0 hasta USD 100, USD 15 fijo hasta 1.000 y 1,5% arriba; DHL el mayor entre USD 17,50 y el 1,5%.';
      return;
    }
    const piso = vacio(segMin) ? 'sin minimo' : `minimo USD ${Number(segMin).toFixed(2)}`;
    hint.textContent =
      `Este cliente paga ${segPct}% del valor declarado (${piso}) en DHL y en UPS. ` +
      'Reemplaza la escala del courier: no se le cobra el escalon de USD 15 ni el minimo de 17,50.';
  }

  // El general de cada tabla vive en el encabezado de su sección: con las seis tablas a la
  // vista ya no hay "tabla activa" a la que pueda referirse un input global.
  function generalHtml(serv, tipo) {
    const m = matrices[claveM(serv, tipo)] || {};
    const gKg = m.kg && m.kg.general_tabla ? m.kg.general_tabla.precio_kg : null;
    const gPct = m.pct && m.pct.general_tabla ? m.pct.general_tabla.profit_pct : null;

    if (editando === null) {
      // Vista: el general se informa, no se edita.
      const partes = [];
      if (gPct !== null) partes.push(`General ${gPct}%`);
      if (gKg !== null) partes.push(gKg === 0
        ? `<span style="color:#d03b3b;font-weight:600" title="General por kilo en USD 0: todo peso sin precio específico vende el flete GRATIS en esta tabla.">General USD ${Number(gKg).toFixed(2)}/kg</span>`
        : `General USD ${Number(gKg).toFixed(2)}/kg`);
      return `<span class="tarifa-general-linea">${partes.join(' · ') || ''}</span>`;
    }

    const esKg = editando === 'kg';
    const g = esKg ? gKg : gPct;
    return `<span class="tarifa-general-linea">General (${esKg ? 'USD/kg' : '%'})
      <input type="number" min="0" step="0.5" class="gen-input" value="${g === null ? '' : g}"
        data-serv="${serv}" data-tipo="${tipo}" placeholder="sin general">
      <button class="btn btn-primary btn-sm gen-guardar" data-serv="${serv}" data-tipo="${tipo}">Guardar</button>
      <button class="btn btn-secondary btn-sm gen-quitar ${g === null ? 'hidden' : ''}" data-serv="${serv}" data-tipo="${tipo}">Quitar</button>
    </span>`;
  }

  function tablaHtml(serv, tipo) {
    const filas = filasDeGrilla(serv, tipo);
    let html = '<div class="tarifas-grid-wrap"><table class="tarifas-grid"><thead><tr><th></th><th class="col-todas">Todas</th>';
    TARIFAS_ZONAS.forEach((z) => { html += `<th>Zona ${z}</th>`; });
    html += '</tr></thead><tbody>';
    const m = matrices[claveM(serv, tipo)] || {};
    filas.forEach((banda) => {
      const maxAttr = banda.max === null ? '' : banda.max;
      const dataST = `data-serv="${serv}" data-tipo="${tipo}"`;
      const borrarFila = banda.vieja && esPorKg()
        ? `<span class="rango-del" title="Borrar todo el rango" ${dataST} data-min="${banda.min}" data-max="${maxAttr}">✕</span>`
        : '';
      const etiqueta = banda.vieja
        ? `${bandaLabel(banda)} <span class="tramo-viejo" title="Este tramo no está en el juego de tramos de este cliente: quedó de una carga vieja. Sigue cobrando igual que siempre, pero no se puede editar desde acá. Borralo y volvé a cargarlo sobre los tramos del cliente.">fuera de los tramos</span>`
        : bandaLabel(banda);
      html += `<tr class="${banda.vieja ? 'fila-vieja' : ''}"><td class="banda-label">${etiqueta}${borrarFila}</td>`;

      // Columna "Todas": el precio de ese tramo para las seis zonas de una. Solo se toca
      // en edición; en la vista muestra el de la tabla que manda.
      {
        let tablaTodas; let unidadTodas;
        if (editando === 'pct') { tablaTodas = m.pct; unidadTodas = 'pct'; }
        else if (editando === 'kg') { tablaTodas = m.kg; unidadTodas = 'kg'; }
        else if (overrideBanda(m.kg, banda.min)) { tablaTodas = m.kg; unidadTodas = 'kg'; }
        else { tablaTodas = m.pct; unidadTodas = 'pct'; }
        const ob = overrideBanda(tablaTodas, banda.min);
        const propio = !!ob;
        const val = ob ? (unidadTodas === 'kg' ? ob.precio_kg : ob.profit_pct) : null;
        let extra = unidadTodas === 'kg' && propio && val === 0 ? ' cero' : '';
        html += `<td class="${banda.vieja ? 'celda-vieja' : 'tarifa-cell'} col-todas ${propio ? 'propio' : 'heredado sin-valor'}${extra}"`
          + ` ${dataST} data-zona="" data-min="${banda.min}" data-max="${maxAttr}"`
          + ` title="${editando === null ? 'Precio de este tramo para las seis zonas.' : 'Precio de este tramo para las seis zonas. Hacé clic para ponerlo.'}">`
          + `${propio && editando !== null ? '<span class="cell-del" title="Quitar el precio de todas las zonas">✕</span>' : ''}`
          + `<span class="cell-val">${propio ? formatoValor(val, unidadTodas) : '—'}</span></td>`;
      }

      TARIFAS_ZONAS.forEach((zona) => {
        const ef = valorEfectivo(serv, tipo, zona, banda);
        let cls = ef.propio ? 'tarifa-cell propio' : 'tarifa-cell heredado';
        if (ef.porPct) cls += ' por-pct';
        if (ef.cero) cls += ' cero';
        if (!ef.propio && ef.val === null) cls += ' sin-valor';
        const del = ef.propio && editando !== null ? '<span class="cell-del" title="Quitar override">✕</span>' : '';
        const title = editando === null
          ? (ef.porPct ? 'Sin precio por kilo: este peso se cobra con este porcentaje.'
            : (ef.cero ? 'PRECIO CERO: esta zona vende el flete a USD 0,00.'
              : 'Lo que se cobra en esta zona y este tramo. Para cambiarlo, botón Editar.'))
          : 'Hacé clic para cambiar el valor de esta zona';
        if (banda.vieja) cls = cls.replace('tarifa-cell', 'celda-vieja');
        html += `<td class="${cls}" ${dataST} data-zona="${zona}" data-min="${banda.min}" data-max="${maxAttr}"`
          + ` title="${banda.vieja ? 'Tramo viejo: se cobra igual que siempre, pero no se puede editar desde acá.' : title}">`
          + `${banda.vieja ? '' : del}<span class="cell-val">${banda.vieja ? '' : formatoValor(ef.val, ef.unidad)}</span></td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  function renderGrid() {
    const wrap = document.getElementById('tarifas-grid');
    if (Object.keys(matrices).length === 0) {
      wrap.innerHTML = '';
      return;
    }
    // El conmutador vista/edición. La vista es la tabla general de lo que se cobra;
    // Editar abre la tabla elegida (porcentaje o precio por kilo) con las celdas vivas.
    let html = `<div class="tarifas-vista" id="tarifas-vista">
      <button class="vista-btn ${editando === null ? 'on' : ''}" data-vista="cobra">Lo que se cobra</button>
      <button class="vista-btn ${editando === 'pct' ? 'on' : ''}" data-vista="pct">Editar porcentaje</button>
      <button class="vista-btn ${editando === 'kg' ? 'on' : ''}" data-vista="kg">Editar precio por kilo</button>
      <span class="tarifas-hint" style="flex-basis:auto">${editando === null
        ? 'Cada celda muestra lo que se cobra. Para cambiar algo, Editar.'
        : (editando === 'kg' ? 'Editando los PRECIOS POR KILO. Clic en una celda; la ✕ quita ese precio.'
          : 'Editando los PORCENTAJES. Clic en una celda; la ✕ quita ese valor.')}</span>
    </div>`;
    for (const s of SERVICIOS_MATRIZ) {
      html += `<div class="tarifa-seccion" id="sec-${s.serv}">`;
      for (const tipo of TIPOS_MATRIZ) {
        const m = matrices[claveM(s.serv, tipo)] || {};
        const hayDatos = (m.kg && m.kg.overrides.length > 0) || (m.pct && m.pct.overrides.length > 0)
          || (m.kg && m.kg.general_tabla) || (m.pct && m.pct.general_tabla);
        const esImpo = tipo === 'import';
        if (esImpo && !hayDatos && !impoAbierta[s.serv]) {
          // Impo sin nada cargado: una línea, no una tabla vacía de cien celdas. El link la
          // abre para poder cargar; los envíos de impo mientras tanto usan el porcentaje.
          html += `<div class="tarifa-impo-vacia">Importación: sin tarifas propias → se cobra con el porcentaje general del cliente.
            <a class="impo-abrir" data-serv="${s.serv}">Cargar tarifas de impo</a></div>`;
          continue;
        }
        html += `<div class="tarifa-sec-head">
          <span class="serv-chip ${s.chip}">${s.chipTxt}</span><h3>${s.nombre}</h3>
          <span class="tipo-tag">${esImpo ? 'Importación' : 'Exportación'}</span>
          ${generalHtml(s.serv, tipo)}</div>`;
        html += tablaHtml(s.serv, tipo);
      }
      html += '</div>';
    }
    wrap.innerHTML = html;
    bindGridEvents();
    renderAlertaCeros();
  }

  // Cuenta las celdas de tarifa por kilo en USD 0 de TODO el cliente y lo dice arriba,
  // en rojo. Un 0 no es "sin precio": vende el flete a cero (pasó con PIO ALVAREZ).
  function renderAlertaCeros() {
    const alerta = document.getElementById('tarifas-alerta');
    if (!alerta) return;
    let ceros = 0;
    for (const k of Object.keys(matrices)) {
      const kg = matrices[k].kg;
      if (kg) ceros += kg.overrides.filter((o) => o.precio_kg === 0).length;
      if (kg && kg.general_tabla && kg.general_tabla.precio_kg === 0) ceros += 1;
    }
    if (ceros > 0) {
      alerta.innerHTML = `● <b>${ceros} precio(s) por kilo en USD 0,00:</b> esas celdas venden el flete GRATIS — un 0 no es "sin precio". Están en rojo en la grilla. Si no es a propósito, cambialas o quitalas.`;
      alerta.style.display = 'block';
    } else {
      alerta.style.display = 'none';
    }
  }

  function bindGridEvents() {
    const wrap = document.getElementById('tarifas-grid');
    // En la VISTA no se edita nada: para eso está el botón Editar. Pedido de Felipe (13/08).
    if (editando !== null) {
      wrap.querySelectorAll('td.tarifa-cell').forEach((td) => {
        td.addEventListener('click', (e) => {
          if (e.target.classList.contains('cell-del')) return;
          abrirEditorCelda(td);
        });
      });
    }
    wrap.querySelectorAll('.cell-del').forEach((x) => {
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        borrarCelda(x.closest('td'));
      });
    });
    // Borrar un rango viejo entero (solo quedan en cargas anteriores a los tramos).
    wrap.querySelectorAll('.rango-del').forEach((x) => {
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        borrarRango(x.dataset.serv, x.dataset.tipo, Number(x.dataset.min), x.dataset.max === '' ? null : Number(x.dataset.max));
      });
    });
    // Conmutador vista/edición.
    wrap.querySelectorAll('.vista-btn').forEach((b) => {
      b.addEventListener('click', () => {
        editando = b.dataset.vista === 'cobra' ? null : b.dataset.vista;
        renderGrid();
      });
    });
    // Abrir la tabla de impo de un servicio que no tiene nada cargado.
    wrap.querySelectorAll('.impo-abrir').forEach((a) => {
      a.addEventListener('click', () => {
        impoAbierta[a.dataset.serv] = true;
        renderGrid();
      });
    });
    // General por tabla: guardar y quitar, con el servicio y el tipo en el botón.
    wrap.querySelectorAll('.gen-guardar').forEach((b) => {
      b.addEventListener('click', () => guardarGeneral(b.dataset.serv, b.dataset.tipo));
    });
    wrap.querySelectorAll('.gen-quitar').forEach((b) => {
      b.addEventListener('click', () => borrarGeneral(b.dataset.serv, b.dataset.tipo));
    });
  }

  async function guardarGeneral(serv, tipo) {
    const input = document.querySelector(`.gen-input[data-serv="${serv}"][data-tipo="${tipo}"]`);
    const val = input ? input.value.trim() : '';
    const n = parseFloat(val);
    if (val === '' || !Number.isFinite(n)) return;
    const cuerpo = { servicio: serv, tipo, zona: null, peso_min: null, peso_max: null };
    try {
      if (editando === 'kg') await NovaAPI.clientes.tarifaKg.guardar(clienteId, { ...cuerpo, precio_kg: n });
      else await NovaAPI.clientes.profit.guardar(clienteId, { ...cuerpo, profit_pct: n });
      await cargarMatriz();
      NovaUtils.showAlert(alertBox, 'General de tabla guardado', 'success');
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message);
    }
  }

  async function borrarGeneral(serv, tipo) {
    const cuerpo = { servicio: serv, tipo, zona: null, peso_min: null, peso_max: null };
    try {
      if (editando === 'kg') await NovaAPI.clientes.tarifaKg.borrar(clienteId, cuerpo);
      else await NovaAPI.clientes.profit.borrar(clienteId, cuerpo);
      await cargarMatriz();
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message);
    }
  }
  // zona vacía = la columna "Todas", que es el nivel BANDA: un solo precio para las seis
  // zonas de ese tramo de peso. Es lo que antes hacía la barra de "agregar rango", ahora
  // en un clic y en el mismo lugar donde se mira todo lo demás.
  function coordsDeCelda(td) {
    return {
      zona: td.dataset.zona === '' ? null : Number(td.dataset.zona),
      peso_min: Number(td.dataset.min),
      peso_max: td.dataset.max === '' ? null : Number(td.dataset.max),
    };
  }

  function abrirEditorCelda(td) {
    if (td.querySelector('input')) return;
    const coords = coordsDeCelda(td);
    // El texto de la celda trae el formato ("12%" o "USD 5.00"); acá se necesita el número.
    const crudo = td.querySelector('.cell-val').textContent;
    // Una celda por-pct muestra el porcentaje con el que CAE, no un precio por kilo: el
    // editor arranca vacío para no ofrecer "70" como precio.
    const actual = (crudo === '—' || td.classList.contains('por-pct'))
      ? '' : crudo.replace('%', '').replace('USD', '').trim();
    td.innerHTML = `<input type="number" min="0" step="${editando === 'kg' ? '0.1' : '0.5'}" value="${actual}">`;
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
      const cuerpo = {
        servicio: td.dataset.serv,
        tipo: td.dataset.tipo,
        zona: coords.zona,
        peso_min: coords.peso_min,
        peso_max: coords.peso_max,
      };
      try {
        if (editando === 'kg') {
          await NovaAPI.clientes.tarifaKg.guardar(clienteId, { ...cuerpo, precio_kg: pct });
        } else {
          await NovaAPI.clientes.profit.guardar(clienteId, { ...cuerpo, profit_pct: pct });
        }
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
    const cuerpo = {
      servicio: td.dataset.serv,
      tipo: td.dataset.tipo,
      zona: coords.zona,
      peso_min: coords.peso_min,
      peso_max: coords.peso_max,
    };
    try {
      if (editando === 'kg') await NovaAPI.clientes.tarifaKg.borrar(clienteId, cuerpo);
      else await NovaAPI.clientes.profit.borrar(clienteId, cuerpo);
      await cargarMatriz();
    } catch (err) {
      NovaUtils.showAlert(alertBox, err.message);
    }
  }

  // Borra un rango de peso completo: la fila de todas las zonas más la de "todas las
  // zonas". Se hace de a una porque cada fila es un registro propio; los 404 de las celdas
  // que no existían se ignoran a propósito (no son un error, simplemente no estaban).
  async function borrarRango(serv, tipo, min, max) {
    const zonas = [...TARIFAS_ZONAS, null];
    let falla = null;
    for (const zona of zonas) {
      try {
        await NovaAPI.clientes.tarifaKg.borrar(clienteId, {
          servicio: serv,
          tipo,
          zona,
          peso_min: min,
          peso_max: max,
        });
      } catch (err) {
        if (!/no encontrada/i.test(err.message || '')) falla = err;
      }
    }
    if (falla) NovaUtils.showAlert(alertBox, falla.message);
    await cargarMatriz();
  }

  function bindTarifas() {
    const btnEditar = document.getElementById('btn-editar-tarifas');
    const panel = document.getElementById('tarifas-panel');
    const tabs = document.getElementById('tarifas-tabs');

    btnEditar.addEventListener('click', () => {
      const abrir = panel.classList.contains('hidden');
      panel.classList.toggle('hidden');
      btnEditar.textContent = abrir ? 'Ocultar tarifas' : 'Editar tarifas';
      if (abrir && !tarifasCargado) {
        tarifasCargado = true;
        cargarMatriz();
      }
    });

    // Los botones de servicio LLEVAN a su sección, no cargan nada: toda la matriz ya está
    // en la página. Se marca el activo al hacer clic y también al scrollear (scrollspy).
    tabs.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const sec = document.getElementById('sec-' + tab.dataset.serv);
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    window.addEventListener('scroll', () => {
      const pills = [...tabs.querySelectorAll('.tab')];
      let activo = 0;
      pills.forEach((p, i) => {
        const sec = document.getElementById('sec-' + p.dataset.serv);
        if (sec && sec.getBoundingClientRect().top < 130) activo = i;
      });
      pills.forEach((p, i) => p.classList.toggle('active', i === activo));
    }, { passive: true });

    // ── Fuel propio ─────────────────────────────────────────────────────────

    const inputFuel = document.getElementById('tarifas-fuel-input');
    async function guardarFuel(valor) {
      try {
        clienteData = await NovaAPI.clientes.actualizar(clienteId, { fuel_pct_propio: valor });
        renderModo();
        NovaUtils.showAlert(
          alertBox,
          valor === null ? 'El cliente vuelve al fuel de Configuracion' : 'Fuel propio guardado',
          'success'
        );
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      }
    }
    document.getElementById('btn-guardar-fuel').addEventListener('click', () => {
      const val = inputFuel.value.trim();
      if (val === '') return guardarFuel(null);
      const n = parseFloat(val);
      if (!Number.isFinite(n) || n < 0) {
        NovaUtils.showAlert(alertBox, 'El fuel propio tiene que ser un numero mayor o igual a 0');
        return;
      }
      guardarFuel(n);
    });
    document.getElementById('btn-borrar-fuel').addEventListener('click', () => guardarFuel(null));

    // Seguro propio: los dos campos se guardan juntos. Sin porcentaje no hay regla posible,
    // asi que vaciar el porcentaje borra tambien el minimo y el cliente vuelve al courier.
    const inputSegPct = document.getElementById('tarifas-seguro-pct');
    const inputSegMin = document.getElementById('tarifas-seguro-min');
    async function guardarSeguro(pctVal, minVal) {
      try {
        clienteData = await NovaAPI.clientes.actualizar(clienteId, {
          seguro_pct_propio: pctVal,
          seguro_min_propio: pctVal === null ? null : minVal,
        });
        renderSeguro();
        NovaUtils.showAlert(
          alertBox,
          pctVal === null
            ? 'El cliente vuelve al seguro de cada courier'
            : 'Seguro propio guardado',
          'success'
        );
      } catch (err) {
        NovaUtils.showAlert(alertBox, err.message);
      }
    }
    document.getElementById('btn-guardar-seguro').addEventListener('click', () => {
      const valPct = inputSegPct.value.trim();
      if (valPct === '') return guardarSeguro(null, null);
      const n = parseFloat(valPct);
      if (!Number.isFinite(n) || n < 0) {
        NovaUtils.showAlert(alertBox, 'El seguro propio tiene que ser un numero mayor o igual a 0');
        return;
      }
      const valMin = inputSegMin.value.trim();
      let m = null;
      if (valMin !== '') {
        m = parseFloat(valMin);
        if (!Number.isFinite(m) || m < 0) {
          NovaUtils.showAlert(alertBox, 'El minimo tiene que ser un numero mayor o igual a 0');
          return;
        }
      }
      guardarSeguro(n, m);
    });
    document.getElementById('btn-borrar-seguro').addEventListener('click', () => guardarSeguro(null, null));

  }

  // ── El tarifario que se le manda AL CLIENTE ───────────────────────────────
  //
  // El panel NO calcula nada: junta las opciones, arma el query string y se lo pasa a
  // pages/tarifario.html, que es la hoja de verdad. La vista previa y el PDF son la MISMA
  // página; por eso "Imprimir" es literalmente imprimir el iframe que se está viendo.
  //
  // Los cuatro escenarios de arriba existen para que el empleado que no conoce el detalle
  // no tenga que entender quince casillas: elige uno y ya queda bien.

  const ESCENARIOS = {
    uno: {
      ayuda: 'El cliente pidió un servicio concreto. Sale ese, con su nombre y sus notas.',
      aplicar: (o) => { o.nombrar = true; },
    },
    varios: {
      ayuda: 'Comparativa: una tabla por servicio, cada una con su nombre. Para cuando el cliente elige.',
      aplicar: (o) => { o.nombrar = true; },
    },
    unico: {
      ayuda: 'Elegí un servicio y el tarifario sale sin decir cuál es, para después despachar '
        + 'por donde convenga. Las notas tampoco nombran couriers.',
      aplicar: (o) => { o.nombrar = false; },
    },
    libre: { ayuda: 'Todo a mano.', aplicar: () => {} },
  };

  function bindTarifario() {
    const modal = document.getElementById('tarifario-modal');
    if (!modal) return;
    const $ = (id) => document.getElementById(id);
    const preview = $('t-preview');
    const alerta = $('t-alerta');
    let escenario = 'uno';

    const serviciosElegidos = () => {
      const s = [];
      if ($('t-dhl').checked) s.push('DHL');
      if ($('t-ups-exp').checked) s.push('UPS_EXP');
      if ($('t-ups-sav').checked) s.push('UPS_SAVER');
      return s;
    };

    function queryString() {
      const combinar = escenario === 'unico' || (escenario === 'libre' && !$('t-nombrar').checked);
      return new URLSearchParams({
        cliente: clienteId,
        servicios: serviciosElegidos().join(','),
        tipo: $('t-tipo').value,
        desde: $('t-desde').value || '0.5',
        hasta: $('t-hasta').value || '50',
        paso: $('t-paso').value,
        combinar: combinar ? '1' : '0',
        // Fijo en el más caro, sin selector: ver el comentario del HTML donde estaba.
        base: 'alto',
        documentos: $('t-documentos').checked ? '1' : '0',
        marca: $('t-marca').value,
        logo: $('t-logo').checked ? '1' : '0',
        nombrar: $('t-nombrar').checked ? '1' : '0',
        nombre_cliente: $('t-nombre-cliente').checked ? '1' : '0',
        notas: $('t-notas').checked ? '1' : '0',
        destinos: $('t-destinos').checked ? '1' : '0',
        fuel: $('t-fuel').checked ? '1' : '0',
        vence: $('t-vence').value || '0',
      }).toString();
    }

    let pedido = null;
    function refrescar() {
      const servicios = serviciosElegidos();
      const avisos = [];
      if (!servicios.length) avisos.push('Elegí al menos un servicio.');
      if (escenario === 'unico' && servicios.length > 1) {
        avisos.push('Tildaste más de un servicio y el tarifario no los va a nombrar: en cada '
          + 'casilla se imprime <b>el precio más caro</b> de los tildados, para que no quede '
          + 'corto si después despachás por el otro.');
      }
      // Avisos, no frenos. Felipe pidió expresamente que no bloquee: la oficina se asegura
      // de que el cliente tenga las tarifas completas antes de mandarlo.
      if (avisos.length) { alerta.innerHTML = avisos.join('<br>'); alerta.classList.remove('hidden'); } else {
        alerta.classList.add('hidden');
      }
      if (!servicios.length) return;

      // Un respiro antes de pedir: cada tecleo en "hasta" dispararía cientos de celdas.
      clearTimeout(pedido);
      pedido = setTimeout(() => { preview.src = `tarifario.html?${queryString()}`; }, 350);
    }

    function aplicarEscenario(nombre) {
      escenario = nombre;
      modal.querySelectorAll('.t-esc').forEach((b) => b.classList.toggle('active', b.dataset.esc === nombre));
      $('t-esc-ayuda').textContent = ESCENARIOS[nombre].ayuda;
      const o = {};
      ESCENARIOS[nombre].aplicar(o);
      if (o.nombrar !== undefined) $('t-nombrar').checked = o.nombrar;
      refrescar();
    }

    modal.querySelectorAll('.t-esc').forEach((b) => {
      b.addEventListener('click', () => aplicarEscenario(b.dataset.esc));
    });
    modal.querySelectorAll('.t-rango').forEach((b) => {
      b.addEventListener('click', () => {
        modal.querySelectorAll('.t-rango').forEach((x) => x.classList.toggle('active', x === b));
        $('t-desde').value = b.dataset.desde;
        $('t-hasta').value = b.dataset.hasta;
        $('t-paso').value = b.dataset.paso;
        refrescar();
      });
    });
    modal.querySelectorAll('input, select').forEach((el) => {
      el.addEventListener('change', refrescar);
      if (el.type === 'number') el.addEventListener('input', refrescar);
    });

    document.getElementById('btn-armar-tarifario').addEventListener('click', () => {
      modal.classList.remove('hidden');
      aplicarEscenario(escenario);
    });
    $('tarifario-cerrar').addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) modal.classList.add('hidden');
    });

    $('t-imprimir').addEventListener('click', () => {
      // Se imprime el iframe: exactamente lo que se está viendo, sin nada de la pantalla.
      preview.contentWindow.focus();
      preview.contentWindow.print();
    });
    $('t-excel').addEventListener('click', () => {
      window.location.href = NovaAPI.clientes.tarifarioExcelUrl(clienteId, queryString());
    });
  }

  init();
})();
