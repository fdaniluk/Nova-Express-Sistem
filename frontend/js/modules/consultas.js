/**
 * consultas.js — la pantalla de las consultas de la publicidad (14/10/2026).
 *
 * Lista a la izquierda (por estado), el hilo a la derecha. Las que el asistente derivó
 * ("Para Felipe") son las que importan: acá se ve el resumen que armó el bot, la charla
 * entera, y se contesta por el mismo WhatsApp. Al contestar, el bot deja de hablar en esa
 * consulta ('atendida'). "Volver al bot" se la devuelve; "Cerrar" la archiva.
 *
 * Pantalla fina: toda la lógica (quién decide, qué puede decir el bot) vive en
 * backend/src/services/consultas.service.js. El simulador de abajo (solo admin) escribe
 * por el MISMO camino que va a usar el webhook de WhatsApp.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const listaEl = $('con-consultas');
  const mensajesEl = $('con-mensajes');
  const form = $('con-form');
  const texto = $('con-texto');
  const avisoEl = $('con-aviso');
  const esPantallaChica = () => window.matchMedia('(max-width: 700px)').matches;
  const esTactil = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  let filtro = 'derivada';
  let actual = null;        // la consulta abierta
  let enviando = false;
  let timer = null;

  const ESTADO = { bot: 'Con el bot', derivada: 'Para Felipe', atendida: 'Atendida', cerrada: 'Cerrada' };
  const fmtFecha = (s) => {
    if (!s) return '';
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    return m ? `${m[3]}/${m[2]} ${m[4]}:${m[5]}` : s;
  };
  const fmtTel = (t) => {
    const d = String(t || '').replace(/\D/g, '');
    if (/^549\d{10}$/.test(d)) return `+54 9 ${d.slice(3, 5)} ${d.slice(5, 9)}-${d.slice(9)}`;
    return d ? '+' + d : '';
  };
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function aviso(txt, tipo = 'info') {
    if (!txt) { avisoEl.hidden = true; return; }
    avisoEl.textContent = txt;
    avisoEl.className = 'asi-aviso ' + tipo;
    avisoEl.hidden = false;
  }

  /* ── Estado del canal ─────────────────────────────────────────────────────────── */
  async function cargarEstado() {
    try {
      const e = await NovaAPI.bot.estado();
      const wa = e.canales && e.canales.whatsapp;
      $('con-estado').textContent = !e.disponible ? 'Asistente sin clave' : wa ? 'WhatsApp conectado' : 'WhatsApp apagado (modo prueba)';
      if (!e.disponible) aviso('El asistente no está configurado (falta la clave en el servidor): las consultas nuevas no se van a contestar solas.', 'error');
    } catch (err) { $('con-estado').textContent = ''; }
  }

  /* ── Lista ────────────────────────────────────────────────────────────────────── */
  async function cargarLista() {
    let filas = [];
    try { filas = await NovaAPI.consultas.listar(filtro); } catch (err) { aviso('No se pudieron cargar las consultas: ' + err.message, 'error'); return; }
    listaEl.innerHTML = filas.map((c) => `
      <li data-id="${c.id}" class="${actual && actual.id === c.id ? 'activa' : ''}">
        <div class="n"><span>${esc(c.nombre || fmtTel(c.telefono))}</span>${c.no_leidos ? `<span class="badge">${c.no_leidos}</span>` : ''}</div>
        <div class="r">${esc(c.resumen || (c.datos && c.datos.que_envia ? c.datos.que_envia + (c.datos.destino ? ' → ' + c.datos.destino : '') : 'Sin datos todavía'))}</div>
        <div class="f">${ESTADO[c.estado] || c.estado} · ${fmtFecha(c.ultimo_mensaje_en || c.actualizado_en)}</div>
      </li>`).join('');
    $('con-vacio').hidden = filas.length > 0;
    listaEl.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => { abrir(Number(li.dataset.id)); cerrarHojas(); }));
    actualizarBadge();
  }

  async function actualizarBadge() {
    try {
      const r = await NovaAPI.consultas.resumen();
      const b = $('nav-consultas-badge');
      if (!b) return;
      const n = (r.derivadas || 0);
      b.textContent = String(n);
      b.hidden = !n;
      $('con-filtros').querySelector('[data-estado="derivada"]').textContent = n ? `Para Felipe (${n})` : 'Para Felipe';
    } catch { /* sin badge */ }
  }

  /* ── El hilo ──────────────────────────────────────────────────────────────────── */
  function pintarMensajes(mensajes) {
    mensajesEl.querySelectorAll('.asi-msg').forEach((n) => n.remove());
    $('con-bienvenida').hidden = true;
    for (const m of mensajes) {
      const div = document.createElement('div');
      div.className = `asi-msg ${m.rol}${m.humano ? ' humano' : ''}`;
      const quien = document.createElement('span');
      quien.className = 'quien';
      quien.textContent = m.rol === 'user' ? `${(actual && actual.nombre) || 'Prospecto'} · ${fmtFecha(m.creado_en)}` : `${m.humano ? (typeof m.humano === 'string' ? m.humano : 'Oficina') : 'Asistente'} · ${fmtFecha(m.creado_en)}`;
      div.appendChild(quien);
      div.appendChild(document.createTextNode(m.texto));
      mensajesEl.appendChild(div);
    }
    mensajesEl.scrollTop = mensajesEl.scrollHeight;
  }

  function pintarCabecera(c) {
    $('con-cabecera').hidden = false;
    $('con-nombre').textContent = c.nombre || fmtTel(c.telefono);
    $('con-tel').textContent = c.nombre ? fmtTel(c.telefono) : '';
    const chip = $('con-estado-chip');
    chip.textContent = ESTADO[c.estado] || c.estado;
    chip.className = 'con-estado-chip ' + c.estado;
    const ver = (id, si) => { $(id).style.display = si ? '' : 'none'; };
    ver('con-tomar', c.estado === 'bot');
    ver('con-volver', c.estado !== 'bot');
    ver('con-cerrar', c.estado !== 'cerrada');
    form.hidden = false;
    const d = c.datos || {};
    const partes = [['Qué manda', d.que_envia], ['Sentido', d.sentido === 'exportacion' ? 'exportación' : d.sentido === 'importacion' ? 'importación' : null], ['Destino', d.destino], ['Peso', d.peso], ['Tipo', d.tipo], ['Frecuencia', d.frecuencia], ['Notas', d.notas]].filter((p) => p[1] && p[1] !== 'no_dice');
    const res = $('con-resumen');
    if (c.resumen || partes.length) {
      res.hidden = false;
      res.innerHTML = `${c.resumen ? `<div>${esc(c.resumen)}${c.motivo ? ` <i>(${esc(c.motivo)})</i>` : ''}</div>` : ''}${partes.length ? `<div class="d">${partes.map((p) => `<span><b>${p[0]}:</b> ${esc(p[1])}</span>`).join('')}</div>` : ''}`;
    } else res.hidden = true;
  }

  async function abrir(id) {
    try {
      actual = await NovaAPI.consultas.obtener(id);
    } catch (err) { aviso('No se pudo abrir la consulta: ' + err.message, 'error'); return; }
    pintarCabecera(actual);
    pintarMensajes(actual.mensajes || []);
    listaEl.querySelectorAll('li').forEach((li) => li.classList.toggle('activa', Number(li.dataset.id) === id));
    const li = listaEl.querySelector(`li[data-id="${id}"] .badge`);
    if (li) li.remove();
    actualizarBadge();
    if (!esTactil()) texto.focus();
  }

  /* ── Contestar ────────────────────────────────────────────────────────────────── */
  async function responder() {
    const t = texto.value.trim();
    if (!t || !actual || enviando) return;
    enviando = true; $('con-enviar').disabled = true;
    try {
      const r = await NovaAPI.consultas.responder(actual.id, t);
      texto.value = '';
      if (r.entrega && r.entrega.entregado === false && r.entrega.motivo !== 'canal de prueba') aviso('Quedó guardado pero NO se pudo mandar por WhatsApp: ' + (r.entrega.motivo || 'error ' + r.entrega.status), 'error');
      else aviso('');
      await abrir(actual.id);
      await cargarLista();
    } catch (err) { aviso('No se pudo mandar: ' + err.message, 'error'); } finally { enviando = false; $('con-enviar').disabled = false; }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); responder(); });
  texto.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !esTactil()) { e.preventDefault(); responder(); } });

  async function cambiarEstado(estado) {
    if (!actual) return;
    let motivo;
    if (estado === 'cerrada') { motivo = prompt('¿Por qué se cierra? (opcional)') || ''; }
    try {
      await NovaAPI.consultas.estado(actual.id, estado, motivo);
      await abrir(actual.id);
      await cargarLista();
    } catch (err) { aviso('No se pudo cambiar el estado: ' + err.message, 'error'); }
  }
  $('con-tomar').addEventListener('click', () => cambiarEstado('derivada'));
  $('con-volver').addEventListener('click', () => cambiarEstado('bot'));
  $('con-cerrar').addEventListener('click', () => cambiarEstado('cerrada'));

  /* ── Filtros ──────────────────────────────────────────────────────────────────── */
  $('con-filtros').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-estado]');
    if (!b) return;
    filtro = b.dataset.estado;
    $('con-filtros').querySelectorAll('button').forEach((x) => x.classList.toggle('activa', x === b));
    cargarLista();
  });

  /* ── Reglas del filtro ────────────────────────────────────────────────────────── */
  let reglasDefecto = '';
  $('con-reglas-btn').addEventListener('click', async () => {
    try {
      const r = await NovaAPI.consultas.reglas();
      reglasDefecto = r.por_defecto;
      $('con-reglas-texto').value = r.texto;
      $('con-reglas-modal').classList.remove('hidden');
      const admin = window.currentUser && window.currentUser.rol === 'admin';
      $('con-reglas-texto').readOnly = !admin;
      $('con-reglas-guardar').style.display = admin ? '' : 'none';
      $('con-reglas-defecto').style.display = admin ? '' : 'none';
    } catch (err) { aviso('No se pudieron leer las reglas: ' + err.message, 'error'); }
  });
  $('con-reglas-cerrar').addEventListener('click', () => $('con-reglas-modal').classList.add('hidden'));
  $('con-reglas-defecto').addEventListener('click', () => { $('con-reglas-texto').value = reglasDefecto; });
  $('con-reglas-guardar').addEventListener('click', async () => {
    try {
      await NovaAPI.consultas.guardarReglas($('con-reglas-texto').value);
      $('con-reglas-modal').classList.add('hidden');
      aviso('Reglas guardadas. Se aplican desde el próximo mensaje.', 'ok');
    } catch (err) { aviso('No se pudieron guardar: ' + err.message, 'error'); }
  });

  /* ── Simulador (solo admin) ───────────────────────────────────────────────────── */
  function mostrarSimulador() {
    const admin = window.currentUser && window.currentUser.rol === 'admin';
    $('con-sim').hidden = !admin;
  }
  $('con-sim-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const tel = $('con-sim-tel').value.trim(), t = $('con-sim-texto').value.trim();
    if (!tel || !t) return;
    $('con-sim-enviar').disabled = true;
    try {
      const r = await NovaAPI.consultas.simular(tel, t, $('con-sim-nombre').value.trim());
      $('con-sim-resp').textContent = r.silencio ? '(el bot no contesta: la consulta está derivada, atendida o cerrada)' : 'Bot: ' + (r.respuesta || '—');
      $('con-sim-texto').value = '';
      await cargarLista();
      if (r.consulta_id) await abrir(r.consulta_id);
    } catch (err) { $('con-sim-resp').textContent = 'Error: ' + err.message; } finally { $('con-sim-enviar').disabled = false; }
  });
  window.addEventListener('nova:usuario', mostrarSimulador);
  if (window.currentUser) mostrarSimulador();

  /* ── Hojas del teléfono (igual que el Asistente) ──────────────────────────────── */
  const fondo = $('asi-fondo');
  function cerrarHojas() { document.body.classList.remove('menu-abierto', 'panel-abierto'); if (fondo) fondo.hidden = true; }
  function abrirHoja(cual) { const ya = document.body.classList.contains(cual); cerrarHojas(); if (ya) return; document.body.classList.add(cual); if (fondo) fondo.hidden = false; }
  if (fondo) fondo.addEventListener('click', cerrarHojas);
  $('con-menu').addEventListener('click', () => abrirHoja('menu-abierto'));
  $('con-panel').addEventListener('click', () => abrirHoja('panel-abierto'));
  $('con-cerrar-panel').addEventListener('click', cerrarHojas);
  window.addEventListener('resize', () => { if (!esPantallaChica()) cerrarHojas(); });

  /* Refresco suave: cada 30 s la lista (llegan mensajes mientras la pantalla está abierta). */
  timer = setInterval(() => { cargarLista(); if (actual && document.visibilityState === 'visible') abrir(actual.id); }, 30000);
  window.addEventListener('beforeunload', () => clearInterval(timer));

  cargarEstado();
  cargarLista();
})();
