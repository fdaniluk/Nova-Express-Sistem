// Utilidades compartidas Nova Express

function formatMoney(n) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(n || 0);
}

// Fecha de HOY en hora local, formato 'YYYY-MM-DD'.
//
// NO usar `new Date().toISOString().slice(0,10)` para esto: toISOString() devuelve UTC
// y Buenos Aires es UTC−3, así que entre las 21:00 y las 23:59 hora local devuelve el
// día SIGUIENTE. Para un courier que opera de tarde eso pasaba todos los días: envíos
// guardados con la fecha de mañana, el semáforo de antigüedad de Salidas contando un día
// de más (rojo un día antes), y una liquidación confirmada el 31 a las 22:00 quedando
// fechada el 1 del mes siguiente.
function hoyLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Mes actual en hora local, 'YYYY-MM'. Mismo motivo que hoyLocal().
function mesLocal(d = new Date()) {
  return hoyLocal(d).slice(0, 7);
}

function formatDate(d) {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${day}/${m}/${y}`;
}

// Los errores NO se borran solos (29/09/2026): a los 6 s desaparecían listas largas (los
// errores de UPS al emitir una guía) antes de que la oficina las leyera. Llevan una × para
// cerrarlos. Los avisos de éxito/info sí se van a los 6 s. Cada aviso nuevo cancela el
// temporizador del anterior (antes el viejo borraba el nuevo antes de tiempo).
function showAlert(container, message, type = 'error') {
  if (!container) return;
  clearTimeout(container._novaAlertTimer);
  const cerrable = type === 'error' || type === 'danger';
  container.innerHTML = `<div class="alert alert-${type}">${cerrable ? '<button type="button" class="alert-cerrar" aria-label="Cerrar">×</button>' : ''}${message}</div>`;
  if (cerrable) {
    const b = container.querySelector('.alert-cerrar');
    if (b) b.addEventListener('click', () => { container.innerHTML = ''; });
  } else {
    container._novaAlertTimer = setTimeout(() => { container.innerHTML = ''; }, 6000);
  }
}

function tipoCobroLabel(t) {
  const map = { D: 'Diario', S: 'Semanal', Q: 'Quincenal', CC: 'Cuenta Corriente' };
  return map[t] || t;
}


window.NovaUtils = {
  formatMoney,
  formatDate,
  hoyLocal,
  mesLocal,
  showAlert,
  tipoCobroLabel,
};

// ── Menú plegable (27/10/2026) ───────────────────────────────────────────────
// Pliega la barra de módulos a solo íconos para que las tablas anchas (Salidas) tengan más
// lugar. El estado se guarda por navegador (localStorage nova_menu = 'plegado'). El botón
// se inserta acá y no en cada HTML para que valga en las 20 pantallas a la vez.
(function menuPlegable() {
  const layout = document.querySelector('.app-layout');
  const sidebar = layout && layout.querySelector('.sidebar');
  if (!sidebar) return;
  const KEY = 'nova_menu';
  let plegado = false;
  try { plegado = localStorage.getItem(KEY) === 'plegado'; } catch {}
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'sidebar-toggle'; btn.id = 'sidebar-toggle';
  const pintar = () => {
    layout.classList.toggle('sb-colapsado', plegado);
    btn.innerHTML = plegado
      ? '<span class="st-ico" aria-hidden="true">›</span>'
      : '<span class="st-txt">Plegar menú</span><span class="st-ico" aria-hidden="true">‹</span>';
    btn.title = plegado ? 'Desplegar el menú' : 'Plegar el menú (deja solo los íconos)';
    btn.setAttribute('aria-expanded', plegado ? 'false' : 'true');
    // Con el menú plegado, el nombre del módulo queda como tooltip del ícono.
    sidebar.querySelectorAll('.nav-item').forEach((a) => {
      const txt = a.querySelector('span:last-child');
      if (txt) a.title = plegado ? txt.textContent.trim() : '';
    });
  };
  btn.addEventListener('click', () => {
    plegado = !plegado;
    try { localStorage.setItem(KEY, plegado ? 'plegado' : 'abierto'); } catch {}
    pintar();
  });
  const brand = sidebar.querySelector('.sidebar-brand');
  if (brand) brand.insertAdjacentElement('afterend', btn); else sidebar.prepend(btn);
  pintar();
})();

// ── Cambio de módulo más rápido (03/11/2026) ─────────────────────────────────
// 1) Pre-carga: al pasar el mouse por un ítem del menú, Chrome baja el HTML de esa
//    pantalla antes del clic (speculation rules, solo el documento; los datos los pide
//    la pantalla cuando se abre, así nunca se muestran viejos). Otros navegadores lo
//    ignoran.
// 2) Tablas vacías: el tbody que arranca sin filas se marca "nova-cargando" (gris animado,
//    main.css) y se desmarca solo apenas el módulo escribe algo adentro.
(function cambioDeModulo() {
  try {
    if (window.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules')) {
      const s = document.createElement('script');
      s.type = 'speculationrules';
      s.textContent = JSON.stringify({
        prefetch: [{ where: { selector_matches: '.sidebar-nav a' }, eagerness: 'moderate' }],
      });
      document.head.appendChild(s);
    }
  } catch {}

  document.querySelectorAll('table thead ~ tbody').forEach((tb) => {
    if (tb.children.length || tb.textContent.trim()) return;
    tb.classList.add('nova-cargando');
    const obs = new MutationObserver(() => { tb.classList.remove('nova-cargando'); obs.disconnect(); });
    obs.observe(tb, { childList: true, characterData: true, subtree: true });
    // Por las dudas (módulo que nunca escribe): a los 8 s se saca igual.
    setTimeout(() => { tb.classList.remove('nova-cargando'); obs.disconnect(); }, 8000);
  });
})();

// ── La flecha "atrás" del navegador vuelve UN paso dentro del sistema (03/11/2026) ──────
// Pedido de Felipe: en el Dashboard tocó una tarjeta (se abre el panel del detalle), quiso
// volver con la flecha de Chrome y lo mandó al módulo anterior. Lo mismo con cualquier
// modal o pestaña: la gente no se acostumbra a buscar el botón del sistema.
//
// Cómo funciona, sin tocar cada módulo:
//   1) PESTAÑAS: un clic en cualquier `button[data-tab]` deja un paso en el historial.
//      "Atrás" vuelve a la pestaña anterior (se hace clic en ella por el usuario).
//   2) CAPAS (modales, paneles): un observador mira el DOM; cuando aparece un elemento
//      fijo que tapa al menos un tercio de la pantalla (el fondo de un modal, el panel
//      del detalle) deja un paso en el historial. "Atrás" lo cierra apretando su botón
//      de cerrar/cancelar (el mismo camino que a mano, así el módulo limpia su estado);
//      si no tiene, manda Escape; si tampoco, lo esconde. Si se cierra a mano, el paso
//      sobrante se saca solo para que el siguiente "atrás" sí cambie de módulo.
// Las capas que aparecen juntas (fondo + panel) cuentan como UNA.
(function atrasDelNavegador() {
  if (!window.history || !window.MutationObserver) return;
  const TAB_ACTIVA = ['active', 'activa', 'on'];
  let restaurando = false; // clic programático: no dejar paso
  let ignorarPop = 0;      // history.back() propio: no cerrar nada
  let n = 0;               // contador de capas; el estado guarda hasta cuál está abierta
  const abiertas = [];     // [{ n, els: [el, …] }]

  const estado = () => (history.state && typeof history.state === 'object') ? history.state : {};
  const tabActiva = () => document.querySelector(TAB_ACTIVA.map((c) => `button[data-tab].${c}`).join(', '));

  // ── 1) Pestañas ──
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b || restaurando) return;
    const actual = tabActiva();
    if (actual && actual.dataset.tab === b.dataset.tab) return;
    try { history.pushState({ ...estado(), novaTab: b.dataset.tab, novaCapa: 0 }, ''); } catch {}
  }, true);
  const inicial = tabActiva();
  if (inicial && estado().novaTab === undefined) {
    try { history.replaceState({ ...estado(), novaTab: inicial.dataset.tab, novaCapa: 0 }, ''); } catch {}
  }

  // ── 2) Capas ──
  const esCapa = (el) => {
    if (!(el instanceof Element) || el.classList.contains('sidebar') || el.closest('.sidebar')) return false;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width * r.height >= (innerWidth * innerHeight) / 3;
  };
  const visible = (el) => el.isConnected && esCapa(el);
  const cerrar = (el) => {
    const btn = el.querySelector('[id$="-close"], [id$="-cerrar"], [id$="-cancel"], [id$="-cancelar"], .modal-close, .cerrar, [aria-label="Cerrar"], [data-cerrar]');
    if (btn) { btn.click(); return; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (visible(el)) el.classList.add('hidden');
  };
  const candidatos = (muts) => {
    const set = new Set();
    for (const m of muts) {
      if (m.type === 'attributes') set.add(m.target);
      for (const nodo of m.addedNodes) if (nodo instanceof Element) { set.add(nodo); nodo.querySelectorAll('[class],[style]').forEach((x) => set.add(x)); }
    }
    return set;
  };
  const obs = new MutationObserver((muts) => {
    // Las que se cerraron a mano: sacar el paso sobrante del historial.
    for (let i = abiertas.length - 1; i >= 0; i--) {
      const g = abiertas[i];
      if (g.els.some(visible)) continue;
      abiertas.splice(i, 1);
      if (!g.porPop && estado().novaCapa === g.n) { ignorarPop++; try { history.back(); } catch { ignorarPop--; } }
    }
    // Las que aparecieron: un paso nuevo (todas las de esta tanda, juntas).
    const nuevas = [];
    for (const el of candidatos(muts)) {
      if (!visible(el) || abiertas.some((g) => g.els.includes(el))) continue;
      if (el.closest('[data-nova-sin-historial]')) continue;
      nuevas.push(el);
    }
    if (nuevas.length) {
      n++;
      abiertas.push({ n, els: nuevas, porPop: false });
      try { history.pushState({ ...estado(), novaCapa: n }, ''); } catch {}
    }
  });
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'], childList: true, subtree: true });

  window.addEventListener('popstate', (e) => {
    if (ignorarPop > 0) { ignorarPop--; return; }
    const st = (e.state && typeof e.state === 'object') ? e.state : {};
    const hasta = Number(st.novaCapa) || 0;
    // Capas abiertas después del estado al que volvimos: se cierran.
    for (let i = abiertas.length - 1; i >= 0; i--) {
      const g = abiertas[i];
      if (g.n <= hasta) continue;
      g.porPop = true;
      g.els.filter(visible).forEach(cerrar);
    }
    if (st.novaTab) {
      const b = document.querySelector(`button[data-tab="${CSS.escape(st.novaTab)}"]`);
      const actual = tabActiva();
      if (b && (!actual || actual !== b)) { restaurando = true; try { b.click(); } finally { restaurando = false; } }
    }
  });
})();
