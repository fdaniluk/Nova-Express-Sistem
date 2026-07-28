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

function showAlert(container, message, type = 'error') {
  if (!container) return;
  container.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
  setTimeout(() => {
    container.innerHTML = '';
  }, 6000);
}

function tipoCobroLabel(t) {
  const map = { D: 'Diario', S: 'Semanal', Q: 'Quincenal', CC: 'Cuenta Corriente' };
  return map[t] || t;
}

function tipoEnvioLabel(t) {
  return t === 'importacion' ? 'Importación' : 'Exportación';
}

window.NovaUtils = {
  formatMoney,
  formatDate,
  hoyLocal,
  mesLocal,
  showAlert,
  tipoCobroLabel,
  tipoEnvioLabel,
};
