// Utilidades compartidas Nova Express

function formatMoney(n) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(n || 0);
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

window.NovaUtils = { formatMoney, formatDate, showAlert, tipoCobroLabel, tipoEnvioLabel };
