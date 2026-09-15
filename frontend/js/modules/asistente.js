/**
 * asistente.js — el panel de chat de la oficina (14/09/2026).
 *
 * Es una pantalla FINA a propósito: no sabe nada de guías, ventas ni pickups. Manda el
 * texto a `POST /api/bot/mensaje` y muestra lo que vuelve. Todo lo que el asistente puede
 * hacer vive en el servidor (backend/src/services/bot.service.js), con la sesión de la
 * persona. Si algún día se suma Telegram, es el mismo motor con otra cara.
 *
 * Lo que sí cuida esta pantalla:
 *   · avisar cuando el asistente no está configurado (sin clave) en vez de fallar mudo;
 *   · mostrar el cartel ámbar mientras hay una carga PENDIENTE de confirmar, para que se
 *     entienda que el próximo "sí" graba;
 *   · retomar una conversación de la lista sin perder el hilo.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const mensajesEl = $('asi-mensajes');
  const listaEl = $('asi-conversaciones');
  const form = $('asi-form');
  const texto = $('asi-texto');
  const btnEnviar = $('asi-enviar');
  const pendienteEl = $('asi-pendiente');
  const avisoEl = $('asi-aviso');
  const estadoEl = $('asi-estado');
  const bienvenida = $('asi-bienvenida');

  /* ── El teléfono (15/09/2026) ──────────────────────────────────────────────────
     Dos preguntas distintas, y conviene no mezclarlas:
       · `esPantallaChica()` es de ANCHO: decide si el menú y el lateral son hojas.
       · `esTactil()` es de DEDO: decide si Enter manda o baja de línea. En un teclado
         de teléfono el Enter es "nueva línea" para todo el mundo (WhatsApp incluido),
         y mandar sin querer un mensaje a medio escribir es molesto. */
  const esPantallaChica = () => window.matchMedia('(max-width: 700px)').matches;
  const esTactil = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  let conversacionId = null;
  let enviando = false;
  /* 'panel' = esta pantalla. 'telefono' = el simulador: lo que se escribe entra por el
     MISMO camino que van a usar Telegram y WhatsApp (el servidor fuerza el canal de
     prueba y el teléfono del usuario logueado). */
  let modo = 'panel';
  const chatEl = document.querySelector('.asi-chat');

  const fmtFecha = (s) => {
    if (!s) return '';
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    return m ? `${m[3]}/${m[2]} ${m[4]}:${m[5]}` : s;
  };

  function scrollAbajo() { mensajesEl.scrollTop = mensajesEl.scrollHeight; }

  function pintarMensaje(rol, txt, herramientas = [], clase = '') {
    if (bienvenida) bienvenida.hidden = true;
    const div = document.createElement('div');
    div.className = `asi-msg ${rol}${clase ? ' ' + clase : ''}${modo === 'telefono' ? ' tel' : ''}`;
    div.textContent = txt;
    if (herramientas && herramientas.length) {
      const h = document.createElement('span');
      h.className = 'herr';
      h.textContent = 'usó: ' + herramientas.join(', ');
      div.appendChild(h);
    }
    mensajesEl.appendChild(div);
    scrollAbajo();
    return div;
  }

  function pintarPendiente(p) {
    if (!p) { pendienteEl.hidden = true; pendienteEl.textContent = ''; return; }
    const d = p.datos || {};
    pendienteEl.innerHTML = `<b>Pendiente de confirmar:</b> pickup para <b>${escapar(p.cliente_nombre || '')}</b> el ${escapar(d.fecha || '')} de ${escapar(d.hora_inicio || '')} a ${escapar(d.hora_fin || '')} en ${escapar(d.direccion || '')}. Respondé <b>sí</b> para cargarlo o <b>no</b> para descartarlo.`;
    pendienteEl.hidden = false;
  }

  function escapar(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function limpiarChat() {
    mensajesEl.querySelectorAll('.asi-msg').forEach((n) => n.remove());
    if (bienvenida) bienvenida.hidden = false;
    pintarPendiente(null);
  }

  async function cargarEstado() {
    try {
      const e = await NovaAPI.bot.estado();
      if (e.mock) { estadoEl.textContent = 'modo de prueba (mock)'; estadoEl.className = 'asi-estado mock'; }
      else if (e.disponible) { estadoEl.textContent = 'listo · ' + e.modelo; estadoEl.className = 'asi-estado ok'; }
      else { estadoEl.textContent = 'sin configurar'; estadoEl.className = 'asi-estado error'; }
      estadoEl.title = estadoEl.textContent;   // en el teléfono se ve como un puntito
      if (e.canales) canalesDisponibles = e.canales;
      /* Sin clave el MODELO no contesta, pero la pantalla NO se bloquea: vincular un
         teléfono (mandar el código de 6 dígitos) y el simulador no necesitan modelo, y
         cuando el mensaje sí lo necesita el servidor devuelve un 503 con el motivo. */
      if (e.sin_clave) {
        avisoEl.innerHTML = 'El asistente no está configurado: falta <code>ANTHROPIC_API_KEY</code> en el <code>.env</code> del servidor. '
          + 'Hasta que esté, no va a poder contestar preguntas, pero sí podés vincular teléfonos y probar el simulador.';
        avisoEl.hidden = false;
      }
    } catch (err) {
      estadoEl.textContent = 'sin conexión'; estadoEl.className = 'asi-estado error';
    }
  }

  async function cargarLista() {
    try {
      const lista = await NovaAPI.bot.conversaciones();
      listaEl.innerHTML = '';
      if (!lista.length) { listaEl.innerHTML = '<li class="vacio">Todavía no hay conversaciones.</li>'; return; }
      for (const c of lista) {
        const li = document.createElement('li');
        li.dataset.id = c.id;
        if (c.id === conversacionId) li.classList.add('activa');
        li.innerHTML = `<span class="t">${escapar(c.titulo || '(sin título)')}</span><span class="f">${escapar(fmtFecha(c.actualizado_en))}${c.usuario ? ' · ' + escapar(c.usuario) : ''}</span>`;
        li.addEventListener('click', () => abrir(c.id));
        listaEl.appendChild(li);
      }
    } catch (err) {
      listaEl.innerHTML = `<li class="vacio">No se pudo cargar la lista: ${escapar(err.message || err)}</li>`;
    }
  }

  async function abrir(id) {
    try {
      const c = await NovaAPI.bot.conversacion(id);
      conversacionId = c.id;
      limpiarChat();
      for (const m of c.mensajes) pintarMensaje(m.rol, m.texto, m.rol === 'assistant' ? m.herramientas : []);
      pintarPendiente(c.pendiente);
      listaEl.querySelectorAll('li').forEach((li) => li.classList.toggle('activa', Number(li.dataset.id) === c.id));
      cerrarHojas();
      if (!esTactil()) texto.focus();
    } catch (err) {
      pintarMensaje('assistant', 'No pude abrir esa conversación: ' + (err.message || err), [], 'error');
    }
  }

  function nueva() {
    if (modo === 'telefono') cambiarModo('panel');
    conversacionId = null;
    limpiarChat();
    listaEl.querySelectorAll('li').forEach((li) => li.classList.remove('activa'));
    cerrarHojas();
    if (!esTactil()) texto.focus();
  }

  async function enviar() {
    const t = texto.value.trim();
    if (!t || enviando) return;
    enviando = true;
    btnEnviar.disabled = true;
    pintarMensaje('user', t);
    texto.value = '';
    ajustarAlto();
    const pensando = pintarMensaje('assistant', 'Pensando', [], 'pensando');
    try {
      if (modo === 'telefono') {
        const r = await NovaAPI.bot.simular(t);
        pensando.remove();
        pintarMensaje('assistant', r.respuesta || '(sin respuesta)', r.herramientas || []);
        pintarPendiente(r.pendiente);
        if (r.recien_vinculado) { cargarVinculos(); notaModo(''); }
        else if (r.vinculado === false) notaModo('este teléfono todavía no está vinculado');
        return;
      }
      const r = await NovaAPI.bot.mensaje(t, conversacionId);
      const esNueva = conversacionId !== r.conversacion_id;
      conversacionId = r.conversacion_id;
      pensando.remove();
      pintarMensaje('assistant', r.texto, r.herramientas);
      pintarPendiente(r.pendiente);
      if (esNueva) await cargarLista();
      else {
        const li = listaEl.querySelector(`li[data-id="${conversacionId}"] .f`);
        if (li) li.textContent = fmtFecha(new Date().toISOString().replace('T', ' '));
      }
    } catch (err) {
      pensando.remove();
      pintarMensaje('assistant', (err.message || String(err)), [], 'error');
    } finally {
      enviando = false;
      btnEnviar.disabled = false;
      if (!esTactil()) texto.focus();   // no reabrir el teclado después de cada respuesta
    }
  }

  function ajustarAlto() {
    texto.style.height = 'auto';
    texto.style.height = Math.min(texto.scrollHeight, 140) + 'px';
  }

  /* ── Pestañas del lateral ─────────────────────────────────────────────────────── */
  function cambiarTab(nombre) {
    document.querySelectorAll('.asi-tabs button').forEach((b) => b.classList.toggle('activa', b.dataset.tab === nombre));
    document.querySelectorAll('.asi-tab').forEach((d) => { d.hidden = d.dataset.panel !== nombre; });
    if (nombre === 'telefonos') cargarVinculos();
  }
  document.querySelectorAll('.asi-tabs button').forEach((b) => b.addEventListener('click', () => cambiarTab(b.dataset.tab)));

  /* ── Teléfonos vinculados ─────────────────────────────────────────────────────── */
  const vinculosEl = $('asi-vinculos');
  const codigoEl = $('asi-codigo');
  let canalesDisponibles = { prueba: true, telegram: false, whatsapp: false };

  async function cargarVinculos() {
    try {
      const lista = await NovaAPI.bot.vinculos();
      vinculosEl.innerHTML = '';
      if (!lista.length) { vinculosEl.innerHTML = '<li class="vacio">Todavía no hay teléfonos vinculados.</li>'; return; }
      for (const v of lista) {
        const li = document.createElement('li');
        if (v.estado === 'pendiente') li.classList.add('pendiente');
        const detalle = v.estado === 'pendiente'
          ? `esperando el código ${v.codigo}`
          : `${v.identificador || ''}${v.ultimo_uso_en ? ' · último uso ' + fmtFecha(v.ultimo_uso_en) : ''}`;
        li.innerHTML = `<span class="v-datos"><span class="v-canal">${escapar(v.canal)}</span>`
          + `${v.etiqueta ? ' · ' + escapar(v.etiqueta) : ''}`
          + `<span class="v-detalle">${escapar(detalle)}${v.usuario ? ' · ' + escapar(v.usuario) : ''}</span></span>`;
        const baja = document.createElement('button');
        baja.type = 'button'; baja.className = 'v-baja'; baja.title = 'Dar de baja'; baja.textContent = '✕';
        baja.addEventListener('click', async () => {
          if (!confirm('¿Dar de baja este teléfono? Desde ese número el asistente deja de contestar.')) return;
          try { await NovaAPI.bot.desvincular(v.id); cargarVinculos(); }
          catch (err) { alert(err.message || err); }
        });
        li.appendChild(baja);
        vinculosEl.appendChild(li);
      }
    } catch (err) {
      vinculosEl.innerHTML = `<li class="vacio">No se pudo cargar: ${escapar(err.message || err)}</li>`;
    }
  }

  const INSTRUCCIONES = {
    prueba: 'Escribí ese número acá abajo con el simulador de teléfono prendido.',
    telegram: 'Abrí el chat del bot en Telegram y mandale ese número.',
    whatsapp: 'Mandale ese número por WhatsApp al número del bot.',
  };

  async function sacarCodigo(canal, etiqueta) {
    const r = await NovaAPI.bot.vincular(canal, etiqueta);
    codigoEl.innerHTML = `Código para vincular <b>${escapar(canal)}</b>:<b class="num">${escapar(r.codigo)}</b>`
      + `${escapar(INSTRUCCIONES[canal] || '')} Vence en ${r.minutos} minutos.`;
    codigoEl.hidden = false;
    cargarVinculos();
    return r;
  }

  $('asi-vincular').addEventListener('click', async () => {
    const canal = $('asi-canal').value;
    if (canal !== 'prueba' && !canalesDisponibles[canal]) {
      alert(`El canal ${canal} todavía no está configurado en el servidor. Se puede vincular igual, pero recién va a contestar cuando esté.`);
    }
    try { await sacarCodigo(canal, $('asi-etiqueta').value); }
    catch (err) { alert(err.message || err); }
  });

  /* ── Desde dónde se escribe ───────────────────────────────────────────────────── */
  function notaModo(txt) { $('asi-modo-nota').textContent = txt || ''; }

  async function cambiarModo(nuevo) {
    if (modo === nuevo) return;
    modo = nuevo;
    document.querySelectorAll('.asi-modo button').forEach((b) => b.classList.toggle('activa', b.dataset.modo === nuevo));
    chatEl.classList.toggle('telefono', nuevo === 'telefono');
    limpiarChat();
    notaModo('');
    if (nuevo === 'telefono') {
      conversacionId = null;
      listaEl.querySelectorAll('li').forEach((li) => li.classList.remove('activa'));
      pintarMensaje('assistant', 'Simulador de teléfono. Lo que escribas entra por el mismo camino que va a usar WhatsApp: si este teléfono no está vinculado, el asistente no te va a contestar nada.', []);
      try {
        const lista = await NovaAPI.bot.vinculos();
        const activo = lista.some((v) => v.canal === 'prueba' && v.estado === 'activo');
        if (!activo) {
          const r = await sacarCodigo('prueba', 'simulador');
          cambiarTab('telefonos');
          pintarMensaje('assistant', `Para vincularlo, mandá acá el código ${r.codigo} (como lo haría alguien desde su teléfono).`, []);
        }
      } catch (err) { notaModo(err.message || String(err)); }
    }
    if (!esTactil()) texto.focus();
  }
  document.querySelectorAll('.asi-modo button').forEach((b) => b.addEventListener('click', () => cambiarModo(b.dataset.modo)));

  form.addEventListener('submit', (ev) => { ev.preventDefault(); enviar(); });
  texto.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey) return;
    if (esTactil()) return;              // en el teléfono el Enter baja de línea
    ev.preventDefault();
    enviar();
  });
  texto.addEventListener('input', ajustarAlto);
  $('asi-nueva').addEventListener('click', nueva);
  document.querySelectorAll('.asi-sugerencias button').forEach((b) => {
    b.addEventListener('click', () => {
      texto.value = b.dataset.sug || '';
      ajustarAlto();
      texto.focus();   // acá sí: la persona tocó una sugerencia para seguir escribiendo
      // Las que terminan con espacio son para completar (la guía); las otras se mandan.
      if (!/\s$/.test(texto.value)) enviar();
    });
  });

  /* ── Hojas del teléfono: el menú del sistema y el lateral ───────────────────────
     En pantalla grande no hacen nada (las dos cosas están siempre a la vista); acá solo
     se prenden y apagan clases, y el CSS las desliza. */
  const fondo = $('asi-fondo');
  function cerrarHojas() {
    document.body.classList.remove('menu-abierto', 'panel-abierto');
    if (fondo) fondo.hidden = true;
  }
  function abrirHoja(cual) {
    const yaEstaba = document.body.classList.contains(cual);
    cerrarHojas();
    if (yaEstaba) return;
    document.body.classList.add(cual);
    if (fondo) fondo.hidden = false;
  }
  if (fondo) fondo.addEventListener('click', cerrarHojas);
  $('asi-menu').addEventListener('click', () => abrirHoja('menu-abierto'));
  $('asi-panel').addEventListener('click', () => abrirHoja('panel-abierto'));
  $('asi-cerrar-panel').addEventListener('click', cerrarHojas);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') cerrarHojas(); });
  /* Al girar el teléfono o pasar a pantalla grande, una hoja abierta queda de adorno. */
  window.addEventListener('resize', () => { if (!esPantallaChica()) cerrarHojas(); });

  /* ── El alto de verdad ───────────────────────────────────────────────────────────
     `100vh` en iOS mide la pantalla SIN la barra del navegador, así que la barra de
     escribir queda tapada; y cuando se abre el teclado, `100dvh` tampoco siempre achica.
     `visualViewport` es lo único que mide lo que de verdad se ve. El CSS usa
     --vh-real y cae a 100dvh si el navegador no la tiene. */
  const vv = window.visualViewport;
  if (vv) {
    const medir = () => {
      document.documentElement.style.setProperty('--vh-real', vv.height + 'px');
      scrollAbajo();
    };
    vv.addEventListener('resize', medir);
    medir();
  }

  cargarEstado();
  cargarLista();
  /* Enfocar al abrir levanta el teclado apenas entrás y no se ve nada más: en el
     teléfono se enfoca recién cuando la persona toca el cuadro. */
  /* En el teléfono el Enter baja de línea, así que el cartelito del cuadro no puede
     seguir diciendo lo contrario — y encima ocupaba tres renglones. */
  if (esTactil()) texto.placeholder = 'Escribí qué necesitás…';
  if (!esTactil()) texto.focus();
})();
