(function () {
  const alertBox = document.getElementById('alert-box');
  let clientes = [];
  let fuelPctActual = { DHL: 39, UPS: 39 };
  // true cuando el usuario pisó a mano el % profit: en ese caso su valor GANA sobre la
  // matriz y no se re-precarga. Se resetea al cambiar cliente / courier / servicio /
  // tipo / país, porque ahí corresponde volver a resolver el profit desde la matriz.
  let profitTocado = false;

  async function init() {
    // hoyLocal(): toISOString() es UTC y adelantaba la fecha un día después de las 21:00.
    document.getElementById('fecha').value = NovaUtils.hoyLocal();
    rellenarSelectPaises();
    updatePaisLabel();
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

  function rellenarSelectPaises() {
    const sel = document.getElementById('pais_destino');
    const paises = [...new Set([
      ...Object.keys(ZONAS_DHL),
      ...Object.keys(ZONAS_UPS),
      ...Object.keys(ZONAS_UPS_I),
    ])].sort();
    sel.innerHTML = '<option value="">Selecciona país</option>';
    for (const p of paises) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      sel.appendChild(opt);
    }
  }

  // Los envíos siempre salen de o llegan a Argentina: en importación el país
  // seleccionado es el de origen; en exportación, el de destino. Solo cambia el label.
  function updatePaisLabel() {
    const impo = document.getElementById('tipo_envio').value === 'importacion';
    document.getElementById('lbl_pais_destino').textContent = impo ? 'País origen *' : 'País destino *';
  }

  function autocompletarZona() {
    const pais = document.getElementById('pais_destino').value;
    if (!pais) { document.getElementById('zona').value = ''; return; }
    const courier = document.getElementById('courier').value;
    const tipo = document.getElementById('tipo_envio').value === 'exportacion' ? 'export' : 'import';
    const zona = resolverZona(pais, courier, tipo);
    document.getElementById('zona').value = zona !== null ? zona : '';
  }

  // Carga los % fuel actuales desde el backend
  async function loadFuelConfig() {
    try {
      const configs = await NovaAPI.configuracion.fuel();
      for (const c of configs) {
        fuelPctActual[c.courier] = c.fuel_pct;
      }
    } catch (err) {
      console.warn('[envios] No se pudo cargar fuel config, usando defaults:', err.message);
    }
    setFuelPctDefault();
  }

  // Completa el % segun la FUENTE elegida en el desplegable. Desde el 07/08/2026 hay tres
  // fuels —Nova, DHL y UPS— y el predeterminado es Nova, que es el que le cobramos al
  // cliente; los otros dos son lo que nos cobran a nosotros.
  //
  // El campo del % queda de solo lectura salvo en "A mano": si se pudiera editar con
  // "Fuel Nova" elegido, la etiqueta diria una cosa y el numero seria otro.
  function setFuelPctDefault() {
    const sel = document.getElementById('fuel_origen');
    const input = document.getElementById('fuel_pct');
    if (!sel || !input) return;
    const fuente = sel.value;
    if (fuente === 'manual') {
      input.readOnly = false;
      input.focus();
    } else {
      input.readOnly = true;
      const mapa = { nova: 'NOVA', dhl: 'DHL', ups: 'UPS' };
      input.value = fuelPctActual[mapa[fuente]] ?? '';
    }
    avisarFuelDelCliente();
  }

  // Si el cliente tiene un fuel propio negociado y se le va a aplicar OTRO, se avisa.
  // Felipe pidio que el predeterminado sea Nova siempre; esto hace que elegirlo sobre un
  // cliente con acuerdo sea una decision visible y no un descuido.
  function avisarFuelDelCliente() {
    const aviso = document.getElementById('fuel-aviso-cliente');
    if (!aviso) return;
    const id = parseInt(document.getElementById('cliente_id').value, 10);
    const cli = clientes.find((c) => c.id === id);
    const propio = cli && cli.fuel_pct_propio;
    const fuente = document.getElementById('fuel_origen').value;
    if (propio === null || propio === undefined || propio === '' || fuente === 'cliente') {
      aviso.classList.add('hidden');
      aviso.textContent = '';
      return;
    }
    aviso.classList.remove('hidden');
    aviso.textContent = `Ojo: este cliente tiene ${propio}% de fuel negociado. `
      + 'Si lo dejas asi, se le cobra el que elegiste arriba.';
  }

  // Fuel % vigente en el form: es el que quedo en el input, sea el de la fuente o el
  // escrito a mano.
  function getFuelPctForm() {
    const v = parseFloat(document.getElementById('fuel_pct').value);
    return (!isNaN(v) && v >= 0) ? v : 0;
  }

  function getFuelOrigenForm() {
    const sel = document.getElementById('fuel_origen');
    return sel ? sel.value : 'nova';
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
        opt.textContent = c.nombre_nova || c.nombre;
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

  function esMultibulto() {
    return (parseInt(document.getElementById('cantidad_bultos').value, 10) || 1) >= 2;
  }

  // Habilita/atenúa un campo del form superior (readonly + estilo gris).
  function setCampoBloqueado(el, bloqueado) {
    if (!el) return;
    el.readOnly = bloqueado;
    el.classList.toggle('campo-bloqueado', bloqueado);
  }

  // En multi-bulto, el PESO BALANZA de arriba = suma de los pesos de cada bulto.
  // Suma directa de los inputs de peso (independiente de si el bulto tiene medidas),
  // recalculada en vivo. No toca el peso facturable (ese sale del motor).
  function recalcPesoBalanza() {
    if (!esMultibulto()) return;
    let suma = 0;
    document
      .querySelectorAll('#bultos-container [data-field="peso_real"]')
      .forEach((inp) => { suma += parseFloat(inp.value) || 0; });
    document.getElementById('peso_real').value = Math.round(suma * 1000) / 1000;
  }

  // Bloquea (multi-bulto) o libera (1 bulto) los campos superiores:
  // las medidas salen de los bultos y el peso balanza es la suma de sus pesos.
  function aplicarBloqueoMultibulto() {
    const multi = esMultibulto();
    ['peso_real', 'largo', 'ancho', 'alto'].forEach((id) => {
      setCampoBloqueado(document.getElementById(id), multi);
    });
    if (multi) recalcPesoBalanza();
  }

  function renderBultos() {
    const n = parseInt(document.getElementById('cantidad_bultos').value, 10) || 1;
    const section = document.getElementById('bultos-extra');
    const container = document.getElementById('bultos-container');
    if (n <= 1) {
      section.classList.add('hidden');
      container.innerHTML = '';
      aplicarBloqueoMultibulto();
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
        <input type="number" data-bulto="${i}" data-field="peso_real" placeholder="Peso (kg) *" step="0.001" min="0">
      `;
      container.appendChild(row);
    }
    container.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('input', debounce(updatePesosYCotizacion, 300));
    });
    // El peso balanza de arriba se suma al vuelo (sin esperar al debounce).
    container.querySelectorAll('[data-field="peso_real"]').forEach((inp) => {
      inp.addEventListener('input', recalcPesoBalanza);
    });
    aplicarBloqueoMultibulto();
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
      const pesoReal = parseFloat(
        document.querySelector(`[data-bulto="${i}"][data-field="peso_real"]`)?.value
      ) || null;
      // ⚠️ Defecto 4 de AUDITORIA-NUMEROS.md: antes solo se agregaba el bulto
      // `if (largo && ancho && alto)`. Un bulto PESADO pero sin medir pasaba la
      // validación (que solo exige peso) y desaparecía CON SU PESO ADENTRO: 20 kg
      // sin medidas facturaban como 0 kg, y el "peso balanza" de la pantalla sí los
      // mostraba, así que el faltante era invisible (USD 64 de menos reproducidos).
      // Un bulto entra si tiene medidas O peso: sin medidas su volumétrico es 0 y
      // factura por peso real, que es lo correcto.
      if ((largo && ancho && alto) || pesoReal) {
        bultos.push({
          numero_bulto: i,
          largo: largo || null,
          ancho: ancho || null,
          alto: alto || null,
          peso_real: pesoReal,
        });
      }
    }
    return bultos;
  }

  // Bultos canónicos para cálculo: MISMA fuente que usa el peso facturable
  // (calcularPesos en el backend). Multi-bulto -> los N bultos reales;
  // bulto único -> el bulto armado con los campos sueltos del form.
  function getBultosParaCalculo() {
    const reales = getBultosFromForm();
    if (reales.length > 0) {
      return reales.map(b => ({
        pesoReal: b.peso_real || 0,
        largo: b.largo,
        ancho: b.ancho,
        alto: b.alto,
      }));
    }
    return [{
      pesoReal: parseFloat(document.getElementById('peso_real').value) || 0,
      largo: parseFloat(document.getElementById('largo').value) || 0,
      ancho: parseFloat(document.getElementById('ancho').value) || 0,
      alto: parseFloat(document.getElementById('alto').value) || 0,
    }];
  }

  function bindPesoCalc() {
    ['peso_real', 'largo', 'ancho', 'alto', 'cantidad_bultos'].forEach((id) => {
      document.getElementById(id).addEventListener('input', debounce(updatePesosYCotizacion, 300));
    });
  }

  // ── Cotizador integrado ──────────────────────────────────────────
  function bindCotizador() {
    // Autocompletar zona al cambiar país, courier o tipo (síncrono, antes de re-precargar)
    ['pais_destino', 'courier', 'tipo_envio'].forEach((id) => {
      document.getElementById(id).addEventListener('change', autocompletarZona);
    });

    // El label del país (destino/origen) sigue al tipo de envío.
    document.getElementById('tipo_envio').addEventListener('change', updatePaisLabel);

    // Cambiar país, courier o tipo cambia el contexto de la matriz: reset + re-precarga.
    const resetRecotizar = debounce(() => { profitTocado = false; precargarYCotizar(); }, 400);
    ['pais_destino', 'courier', 'tipo_envio'].forEach((id) => {
      document.getElementById(id).addEventListener('change', resetRecotizar);
      document.getElementById(id).addEventListener('input', resetRecotizar);
    });

    // El FOB no afecta el profit de la matriz: solo recotiza.
    document.getElementById('fob').addEventListener('change', debounce(updateCotizacion, 400));
    document.getElementById('fob').addEventListener('input', debounce(updateCotizacion, 400));

    // Mostrar selector de variante UPS solo cuando courier = UPS y precargar el fuel del courier
    document.getElementById('courier').addEventListener('change', function () {
      document.getElementById('cot-ups-wrap').style.display = this.value === 'UPS' ? '' : 'none';
      aplicarVisibilidadProteccionDoc(true);
      setFuelPctDefault();
    });

    // La variante UPS es el servicio: reset + re-precarga.
    document.getElementById('cot-ups-variante').addEventListener('change', resetRecotizar);

    // Edición manual del % profit: gana sobre la matriz y borra la etiqueta de origen.
    document.getElementById('cot-profit').addEventListener('input', () => {
      profitTocado = true;
      setProfitOrigen('');
    });
    document.getElementById('cot-profit').addEventListener('input', debounce(updateCotizacion, 400));
    document.getElementById('fuel_pct').addEventListener('input', debounce(updateCotizacion, 400));
    document.getElementById('fuel_origen').addEventListener('change', () => {
      setFuelPctDefault();
      updateCotizacion();
    });

    // Recalcular al tildar/destildar DDP (passthrough +24.05)
    document.getElementById('ddp').addEventListener('change', debounce(updateCotizacion, 400));
    document.getElementById('proteccion_doc').addEventListener('change', debounce(updateCotizacion, 400));

    // Recalcular al cambiar la zona de entrega (el recargo lo resuelve el motor).
    // Son DOS cargos distintos de UPS: extendida (42.15 o 0.92/kg) y remota (5.86 por
    // envío a EE.UU.). Antes había un solo casillero y todo pagaba la de extendida.
    document.getElementById('entrega').addEventListener('change', debounce(updateCotizacion, 400));

    // Aviso de guía mal tipeada. El número lleva un dígito verificador, así que un error
    // de tipeo se detecta al instante y sin consultar al courier. AVISA, no bloquea: si
    // frenara la carga por una sospecha sería peor que el problema.
    const inputGuia = document.getElementById('numero_guia');
    const avisoGuia = document.getElementById('aviso-guia');
    function revisarGuia() {
      if (!inputGuia || !avisoGuia || typeof validarGuia !== 'function') return;
      const courier = document.getElementById('courier').value;
      const v = validarGuia(courier, inputGuia.value);
      if (v.estado === 'sospechosa') {
        avisoGuia.textContent = '⌦ ' + v.motivo;
        avisoGuia.style.display = '';
      } else {
        avisoGuia.style.display = 'none';
      }
    }
    inputGuia?.addEventListener('blur', revisarGuia);
    inputGuia?.addEventListener('input', debounce(revisarGuia, 500));
    document.getElementById('courier').addEventListener('change', revisarGuia);

    // Recalcular al cambiar mercadería/documento: en DHL cambia la tabla de tarifa
    // (documento hasta 2 kg), así que el precio cambia. Sin este listener el operador
    // tildaba documento y el número de arriba seguía siendo el de mercadería.
    document.getElementById('tipo_paquete').addEventListener('change', () => {
      aplicarReglaDocumentos();
      aplicarVisibilidadProteccionDoc(true);
      updateCotizacion();
    });
    aplicarReglaDocumentos();
    aplicarVisibilidadProteccionDoc(true);
  }

  // ── Visibilidad de la Proteccion de Documentos de DHL ───────────────────────
  // El servicio cubre documentos valiosos (pasaportes, visas, certificados), asi que la
  // tilde solo tiene sentido cuando el envio ES un documento y va por DHL. Pedido de
  // Felipe el 04/08: que no aparezca en los demas casos.
  //
  // El parametro `destildar` existe por una razon concreta: cuando el usuario cambia el
  // courier o el tipo de paquete, destildar es la consecuencia correcta de SU accion. Pero
  // al ABRIR un envio guardado no se puede tocar: destildarlo ahi seria cambiarle la plata
  // a un envio sin que nadie lo haya pedido. Por eso, al cargar, un envio que tenga el
  // cargo puesto se muestra igual aunque hoy no califique — asi se ve y se decide, en vez
  // de esconder un cobro activo.
  function aplicarVisibilidadProteccionDoc(destildar = false) {
    const grupo = document.getElementById('grupo-proteccion-doc');
    const chk = document.getElementById('proteccion_doc');
    const tipoPaq = document.getElementById('tipo_paquete');
    const courier = document.getElementById('courier');
    if (!grupo || !chk || !tipoPaq || !courier) return;

    const aplica = courier.value === 'DHL' && tipoPaq.value === 'd';
    if (!aplica && destildar) chk.checked = false;
    grupo.style.display = (aplica || chk.checked) ? '' : 'none';
  }

  // ── Regla de negocio: los DOCUMENTOS solo se despachan por DHL ──────────────
  // Definida por Felipe el 28/07/2026. Es una decisión operativa, no técnica: hasta
  // nuevo aviso Nova solo manda documentos por DHL. Al elegir "Documento" se fuerza el
  // courier a DHL y se bloquea UPS, para que nadie cargue un envío con el courier
  // equivocado. Si la regla cambia, se cambia acá y en cotizador.html.
  function aplicarReglaDocumentos() {
    const tipoPaq = document.getElementById('tipo_paquete');
    const courier = document.getElementById('courier');
    if (!tipoPaq || !courier) return;

    const esDoc = tipoPaq.value === 'd';
    for (const opt of courier.options) {
      if (opt.value !== 'DHL') opt.disabled = esDoc;
    }

    let aviso = document.getElementById('aviso-doc-dhl');
    if (!aviso) {
      aviso = document.createElement('div');
      aviso.id = 'aviso-doc-dhl';
      aviso.style.cssText = 'font-size:11px;color:var(--color-muted);margin-top:4px';
      aviso.textContent = 'Los documentos se despachan solo por DHL.';
      tipoPaq.parentNode.appendChild(aviso);
    }
    aviso.style.display = esDoc ? '' : 'none';

    if (esDoc && courier.value !== 'DHL') {
      courier.value = 'DHL';
      // Cambiar el value por código NO dispara 'change'. En vez de duplicar acá lo que
      // hacen los handlers del courier (ocultar la variante UPS, re-precargar el fuel,
      // resolver la zona, resetear el profit y recotizar), se despacha el evento y los
      // corre a todos. Menos código y no se desincroniza si mañana se agrega otro.
      courier.dispatchEvent(new Event('change'));
    }
  }

  async function updatePesosYCotizacion() {
    await updatePesos();
    // Con el peso facturable ya recalculado, re-precargamos el profit desde la matriz
    // (respeta profitTocado) antes de cotizar.
    await precargarProfit();
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
    } catch (err) {
      console.warn('[envios] Error al calcular pesos:', err.message);
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
    const fuelPct = getFuelPctForm();

    try {
      const clienteId = parseInt(document.getElementById('cliente_id').value, 10) || undefined;
      const bultosParaCotizar = getBultosParaCalculo();
      const res = await NovaAPI.liquidaciones.cotizar({
        pais,
        tipo,
        servicio,
        pesoFacturable,
        fob,
        fuelPct,
        fuenteFuel: getFuelOrigenForm(),
        profitPct,
        zona,
        bultos: bultosParaCotizar,
        ddp: document.getElementById('ddp').checked,
        proteccionDoc: document.getElementById('proteccion_doc').checked,
        entrega: document.getElementById('entrega').value,
        // Tipo de paquete → tarifa de DOCUMENTO de DHL (hasta 2 kg). El formulario ya tenía
        // el selector y lo guardaba en el envío, pero nunca se lo mandaba al cotizador: por
        // eso esta pantalla y el cotizador manual daban números distintos para el mismo
        // documento (hasta 60% en un DHL de 0,5 kg).
        contenido: document.getElementById('tipo_paquete').value === 'd' ? 'documento' : 'paquete',
        cliente_id: clienteId,
        // Si el usuario pisó el profit a mano, el backend usa profitPct; si no, lo resuelve
        // por la matriz del cliente e ignora el número (retrocompatible en ambos sentidos).
        profitManual: profitTocado,
      });

      // El backend puede haber resuelto el profit por matriz: sincronizamos el input
      // (sin marcar profitTocado) y la etiqueta de origen con lo efectivamente aplicado.
      const profitMostrar = res.profit_aplicado != null ? res.profit_aplicado : profitPct;
      if (res.profit_aplicado != null && !profitTocado) {
        document.getElementById('cot-profit').value = res.profit_aplicado;
        setProfitOrigen(origenLabel(res.profit_origen));
      }

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
            <span>Profit ${profitMostrar}%</span>
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

      // Multi-bulto: peso obligatorio por bulto; el peso balanza guardado = suma.
      if (esMultibulto()) {
        const pesos = [...document.querySelectorAll('#bultos-container [data-field="peso_real"]')];
        const faltaPeso = pesos.some((inp) => !(parseFloat(inp.value) > 0));
        if (faltaPeso) {
          NovaUtils.showAlert(alertBox, 'En multi-bulto cada bulto debe tener un peso mayor a 0.', 'error');
          return;
        }
        recalcPesoBalanza();
      }

      const bultos = getBultosFromForm();
      const data = {
        cliente_id: parseInt(document.getElementById('cliente_id').value, 10),
        fecha: document.getElementById('fecha').value,
        courier: document.getElementById('courier').value,
        tipo_envio: document.getElementById('tipo_envio').value,
        tipo_paquete: document.getElementById('tipo_paquete').value,
        numero_guia: document.getElementById('numero_guia').value.trim(),
        pais_destino: document.getElementById('pais_destino').value.trim(),
        zona: document.getElementById('zona').value.trim() || null,
        cantidad_bultos: parseInt(document.getElementById('cantidad_bultos').value, 10) || 1,
        peso_real: parseFloat(document.getElementById('peso_real').value),
        largo: parseFloat(document.getElementById('largo').value) || null,
        ancho: parseFloat(document.getElementById('ancho').value) || null,
        alto: parseFloat(document.getElementById('alto').value) || null,
        fob: parseFloat(document.getElementById('fob').value) || 0,
        fuel_pct: getFuelPctForm(),
        fuel_origen: getFuelOrigenForm(),
        asegurado: document.getElementById('asegurado').checked ? 1 : 0,
        ddp: document.getElementById('ddp').checked ? 1 : 0,
        proteccion_doc: document.getElementById('proteccion_doc').checked ? 1 : 0,
        entrega: document.getElementById('entrega').value,
        // `remota` se sigue guardando por compatibilidad: hay pantallas y consultas que
        // lo leen, y los envíos viejos solo tienen ese flag.
        remota: document.getElementById('entrega').value !== 'normal' ? 1 : 0,
        total_cobrado: parseFloat(document.getElementById('total_cobrado').value) || 0,
        observaciones: document.getElementById('observaciones').value.trim() || null,
        bultos: bultos.length ? bultos : undefined,
        servicio_ups: document.getElementById('courier').value === 'UPS'
          ? (document.getElementById('cot-ups-variante').value || null)
          : null,
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
    updatePaisLabel();
    profitTocado = false;
    setProfitOrigen('');
    document.getElementById('envio-id').value = '';
    document.getElementById('form-title').textContent = 'Cargar envío';
    document.getElementById('fecha').value = NovaUtils.hoyLocal();
    document.getElementById('cantidad_bultos').value = 1;
    setFuelPctDefault();
    document.getElementById('bultos-extra').classList.add('hidden');
    document.getElementById('bultos-container').innerHTML = '';
    aplicarBloqueoMultibulto();
    // form.reset() devuelve tipo_paquete a 'm': hay que re-habilitar UPS.
    aplicarReglaDocumentos();
    aplicarVisibilidadProteccionDoc(true);
    document.getElementById('btn-cancelar-edit').classList.add('hidden');
    document.getElementById('cot-panel').classList.add('hidden');
    document.getElementById('cot-resultado').innerHTML = '';
    updatePesos();
  }

  async function editarEnvio(id) {
    const envio = await NovaAPI.envios.obtener(id);
    // Al abrir un envío para editar re-precargamos el profit desde la matriz.
    profitTocado = false;
    document.querySelector('.tab[data-tab="nuevo"]').click();
    document.getElementById('envio-id').value = envio.id;
    document.getElementById('form-title').textContent = 'Editar envío';
    document.getElementById('btn-cancelar-edit').classList.remove('hidden');
    document.getElementById('cliente_id').value = envio.cliente_id;
    document.getElementById('fecha').value = envio.fecha?.slice(0, 10);
    document.getElementById('courier').value = envio.courier;
    document.getElementById('cot-ups-wrap').style.display = envio.courier === 'UPS' ? '' : 'none';
    if (envio.courier === 'UPS' && envio.servicio_ups) {
      document.getElementById('cot-ups-variante').value = envio.servicio_ups;
    }
    document.getElementById('tipo_envio').value = envio.tipo_envio;
    updatePaisLabel();
    document.getElementById('tipo_paquete').value = envio.tipo_paquete || 'm';
    // Un envío guardado como documento tiene que abrir con UPS bloqueado.
    aplicarReglaDocumentos();
    document.getElementById('numero_guia').value = envio.numero_guia;
    document.getElementById('pais_destino').value = envio.pais_destino;
    document.getElementById('zona').value = envio.zona || '';
    document.getElementById('cantidad_bultos').value = envio.cantidad_bultos;
    document.getElementById('peso_real').value = envio.peso_real;
    document.getElementById('largo').value = envio.largo || '';
    document.getElementById('ancho').value = envio.ancho || '';
    document.getElementById('alto').value = envio.alto || '';
    document.getElementById('fob').value = envio.fob;
    // Fuel% guardado del envío; si es viejo (NULL) cae al de config del courier.
    // Al abrir un envio guardado se repone SU fuente y SU porcentaje congelado: recotizar
    // un envio viejo no le puede cambiar el fuel sin que nadie lo pida.
    const selOrigen = document.getElementById('fuel_origen');
    if (selOrigen) selOrigen.value = envio.fuel_origen || 'manual';
    document.getElementById('fuel_pct').readOnly = (selOrigen && selOrigen.value !== 'manual');
    document.getElementById('fuel_pct').value =
      envio.fuel_pct != null ? envio.fuel_pct : (fuelPctActual[envio.courier] ?? '');
    document.getElementById('asegurado').checked = Boolean(envio.asegurado);
    document.getElementById('ddp').checked = Boolean(envio.ddp);
    document.getElementById('proteccion_doc').checked = Boolean(envio.proteccion_doc);
    // Sin destildar: si el envio ya tiene el cargo, se muestra aunque hoy no califique.
    aplicarVisibilidadProteccionDoc(false);
    // Envío viejo: solo tiene el flag `remota`, que equivalía a la tarifa de extendida.
    document.getElementById('entrega').value = envio.entrega || (envio.remota ? 'extendida' : 'normal');
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
    // Tras cargar los pesos de cada bulto, sincronizar el peso balanza y el bloqueo.
    aplicarBloqueoMultibulto();
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
    // Cambiar de cliente re-precarga el profit desde la matriz del nuevo cliente.
    document.getElementById('cliente_id').addEventListener('change', () => {
      profitTocado = false;
      // El aviso del fuel negociado depende del cliente: se re-evalua al cambiarlo.
      avisarFuelDelCliente();
      precargarYCotizar();
    });
  }

  // ── Precarga de % profit desde la matriz ─────────────────────────
  // Etiqueta discreta de dónde salió el valor precargado.
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

  // Muestra (o limpia) el origen del profit junto al input, creando el <small> una vez.
  function setProfitOrigen(texto) {
    let el = document.getElementById('cot-profit-origen');
    if (!el) {
      el = document.createElement('small');
      el.id = 'cot-profit-origen';
      el.style.cssText = 'color:#2563eb;font-size:11px;margin-left:6px;';
      document.getElementById('cot-profit').insertAdjacentElement('afterend', el);
    }
    el.textContent = texto || '';
  }

  // Precarga cot-profit desde la matriz del cliente cuando hay contexto suficiente
  // (cliente + servicio + tipo + país + peso facturable). Si falta algo, cae a la
  // precarga simple con tarifa_pct del cliente. No pisa lo tipeado a mano.
  async function precargarProfit() {
    if (profitTocado) return;
    const id = parseInt(document.getElementById('cliente_id').value, 10);
    if (!id) return;
    const cliente = clientes.find((c) => c.id === id);

    const precargaSimple = () => {
      if (cliente && cliente.tarifa_pct != null && cliente.tarifa_pct > 0) {
        document.getElementById('cot-profit').value = cliente.tarifa_pct;
      }
      setProfitOrigen('');
    };

    const pais = document.getElementById('pais_destino').value.trim();
    const pf = parseFloat(document.getElementById('peso-preview').dataset.facturable) || 0;
    if (!pais || pf <= 0) { precargaSimple(); return; }

    const courier = document.getElementById('courier').value;
    const servicioUPS = document.getElementById('cot-ups-variante')?.value || 'UPS_EXP';
    const servicio = courier === 'DHL' ? 'DHL' : servicioUPS;
    // El resolver valida contra el enum de la matriz: UPS_SAV -> UPS_SAVER solo acá.
    const servicioResolve = servicio === 'UPS_SAV' ? 'UPS_SAVER' : servicio;
    const tipo = document.getElementById('tipo_envio').value === 'exportacion' ? 'export' : 'import';
    const zona = parseInt(document.getElementById('zona')?.value, 10);

    // EL PAIS VA SIEMPRE. Sin pais el resolvedor no puede sacar la zona, y sin zona nunca
    // encuentra la celda de la matriz: devolvia el porcentaje general del cliente. La
    // pantalla mostraba 75% y el sistema cobraba el 70% de la celda (07/08/2026).
    const params = { servicio: servicioResolve, tipo, pf, pais };
    if (!isNaN(zona)) params.zona = zona;

    try {
      const r = await NovaAPI.clientes.profit.resolver(id, params);
      if (r && r.profitPct != null) {
        document.getElementById('cot-profit').value = r.profitPct;
        setProfitOrigen(origenLabel(r.origen));
      } else {
        precargaSimple();
      }
    } catch (err) {
      console.warn('[envios] profit-resolve falló, uso precarga simple:', err.message);
      precargaSimple();
    }
  }

  async function precargarYCotizar() {
    await precargarProfit();
    await updateCotizacion();
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
