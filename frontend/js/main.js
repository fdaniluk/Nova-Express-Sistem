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
