/**
 * termica.js — imprimir la etiqueta térmica DIRECTO, por el plugin de UPS (11/09/2026).
 *
 * La oficina imprime las térmicas de CampusShip con el "UPS Thermal Printer plugin": un
 * servicio que corre en cada PC en http://127.0.0.1:4349. CampusShip abre una ventanita de
 * ese servicio (listPrinters), la ventanita le pide la etiqueta y hace
 *   POST http://127.0.0.1:4349/print   printerName=<nombre>&labelBytes=<etiqueta>
 * (lo vimos en el código de esa ventana, "Codigo print.html", 11/09). Acá hacemos lo mismo
 * desde el sistema: el ZPL sale de /api/guias/:id/etiqueta.zpl y va al plugin. Sin ventana
 * de imprimir, sin elegir papel: la etiqueta sale de la impresora.
 *
 * Cada PC guarda su impresora en localStorage (la Bixolon en una, la Zebra en la otra).
 * El nombre es el que lista el plugin, sin espacios ni símbolos ("BIXOLONSRP770IIIBPLZ").
 * La primera vez Chrome pregunta si el sitio puede hablar con la red local: hay que
 * permitirlo. La respuesta del plugin no se puede leer (otro origen), así que el sistema
 * avisa "enviado" y la prueba es que salga el papel.
 */
window.NovaTermica = (() => {
  const PLUGIN = 'http://127.0.0.1:4349';
  const LIST_URL = `${PLUGIN}/listPrinters?loc=es_AR&app=www.campusship&name=labelWindow&pref=UPSThermal2844`;
  const K = { impresora: 'nova.termica.impresora', formato: 'nova.termica.formato' };
  const ls = { get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin storage */ } } };

  function impresora() { return ls.get(K.impresora); }
  /** 'base64' (como se lo pasa CampusShip al plugin) o 'texto' (el ZPL tal cual). */
  function formato() { return ls.get(K.formato) || 'base64'; }
  function configurada() { return !!impresora(); }

  /** Pide la lista al plugin. Si el plugin no deja leer la respuesta (CORS), tira. */
  async function listar() {
    const r = await fetch(LIST_URL, { cache: 'no-store' });
    const html = await r.text();
    const out = []; const re = /<option value='([^']*)' label='([^']*)'>([^<]*)<\/option>/g; let m;
    while ((m = re.exec(html))) out.push({ tipo: m[1], etiqueta: m[2], nombre: m[3].trim() });
    return out;
  }

  /** Manda la etiqueta al plugin, EXACTAMENTE como lo hace la ventana de UPS (sin codificar). */
  async function enviar(labelBytes, nombre) {
    const body = `printerName=${nombre}&labelBytes=${labelBytes}`;
    await fetch(`${PLUGIN}/print`, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  }

  async function zplDeGuia(id, giro180) {
    const b64 = formato() === 'base64';
    const url = NovaAPI.guias.etiquetaZplUrl(id, { b64, giro180 });
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`No pude traer la etiqueta (${r.status})`);
    return r.text();
  }

  /** Imprime la(s) etiqueta(s) de una guía. Devuelve el nombre de la impresora usada. */
  async function imprimirGuia(id, opts = {}) {
    const nombre = impresora();
    if (!nombre) { await configurar(); if (!impresora()) throw new Error('Sin impresora configurada'); }
    const datos = await zplDeGuia(id, !!opts.giro180);
    await enviar(datos, impresora());
    return impresora();
  }

  /** Etiqueta de prueba chiquita (texto), para saber si el camino al plugin funciona. */
  async function imprimirPrueba() {
    const zpl = '^XA^PW812^LL1218^FO60,80^A0N,60,60^FDNOVA EXPRESS^FS^FO60,160^A0N,36,36^FDPrueba de impresora termica^FS^FO60,220^A0N,28,28^FDSi lee esto, el sistema imprime directo.^FS^FO60,300^GB690,3,3^FS^XZ';
    const datos = formato() === 'base64' ? btoa(zpl) : zpl;
    await enviar(datos, impresora());
  }

  // ── Configuración (modal): elegir la impresora de ESTA compu ─────────────────
  function configurar() {
    return new Promise((resolve) => {
      const viejo = document.getElementById('termica-modal'); if (viejo) viejo.remove();
      const m = document.createElement('div'); m.id = 'termica-modal'; m.className = 'termica-overlay';
      m.innerHTML = `
        <div class="termica-modal">
          <h3>Impresora térmica de esta compu</h3>
          <p class="termica-sub">Es la misma que usa UPS (CampusShip). Cada compu guarda la suya.</p>
          <div class="termica-fila">
            <button type="button" class="btn btn-secondary btn-sm" id="termica-buscar">Buscar impresoras</button>
            <span id="termica-estado" class="termica-estado"></span>
          </div>
          <select id="termica-lista" class="termica-select hidden"></select>
          <label class="termica-lbl">Nombre de la impresora (como lo muestra el plugin de UPS, sin espacios)</label>
          <input type="text" id="termica-nombre" class="termica-input" placeholder="BIXOLONSRP770IIIBPLZ" value="${impresora().replace(/"/g, '&quot;')}">
          <label class="termica-lbl">Cómo mandar la etiqueta</label>
          <select id="termica-formato" class="termica-select">
            <option value="base64">Codificada (como CampusShip)</option>
            <option value="texto">Texto ZPL tal cual</option>
          </select>
          <p class="termica-ayuda">Si no aparece nada al buscar, abrí <a href="${LIST_URL}" target="_blank" rel="noopener">esta ventana del plugin de UPS</a> y copiá el nombre que muestra el desplegable (sin espacios ni guiones). Si no abre, el plugin de UPS no está corriendo en esta compu.</p>
          <div class="termica-acciones">
            <button type="button" class="btn btn-secondary btn-sm" id="termica-prueba">Imprimir prueba</button>
            <span style="flex:1"></span>
            <button type="button" class="btn btn-secondary btn-sm" id="termica-cerrar">Cerrar</button>
            <button type="button" class="btn btn-primary btn-sm" id="termica-guardar">Guardar</button>
          </div>
        </div>`;
      document.body.appendChild(m);
      const $ = (id) => m.querySelector(`#${id}`);
      $('termica-formato').value = formato();
      const estado = (t, mal) => { const e = $('termica-estado'); e.textContent = t; e.classList.toggle('mal', !!mal); };
      $('termica-buscar').onclick = async () => {
        estado('Buscando…');
        try {
          const lista = await listar();
          if (!lista.length) { estado('El plugin no listó impresoras.', true); return; }
          const sel = $('termica-lista'); sel.innerHTML = lista.map((p) => `<option value="${p.nombre}">${p.etiqueta} (${p.tipo})</option>`).join('');
          sel.classList.remove('hidden'); sel.onchange = () => { $('termica-nombre').value = sel.value; };
          const zpl = lista.find((p) => p.tipo === 'zpl') || lista[0]; sel.value = zpl.nombre; $('termica-nombre').value = zpl.nombre;
          estado(`${lista.length} impresora(s).`);
        } catch (e) {
          estado('No pude leer la lista del plugin (normal: no deja leerla desde otro sitio). Escribí el nombre a mano.', true);
        }
      };
      const guardar = () => { ls.set(K.impresora, $('termica-nombre').value.trim().replace(/[^A-Za-z0-9]/g, '')); ls.set(K.formato, $('termica-formato').value); };
      $('termica-prueba').onclick = async () => {
        guardar();
        if (!impresora()) { estado('Poné el nombre de la impresora.', true); return; }
        estado('Enviando prueba…');
        try { await imprimirPrueba(); estado('Prueba enviada. Si no salió papel, probá el otro formato.'); } catch (e) { estado(`No pude hablar con el plugin (${e.message}). ¿Está corriendo? ¿Chrome pidió permiso de red local?`, true); }
      };
      $('termica-guardar').onclick = () => { guardar(); m.remove(); resolve(true); };
      $('termica-cerrar').onclick = () => { m.remove(); resolve(false); };
    });
  }

  return { imprimirGuia, imprimirPrueba, configurar, configurada, impresora, formato, listar, enviar };
})();
