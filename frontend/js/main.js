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
