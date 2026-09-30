// Días hábiles de la oficina (29/09/2026): lunes a viernes menos feriados nacionales y
// días no laborables con fines turísticos (puentes). Lo usa la proyección del mes del
// Dashboard: julio 2026 tuvo 9 y 10 sin envíos y agosto el 17; contarlos como hábiles
// hacía que la proyección de esos meses saliera baja.
//
// Fuente 2026: calendario oficial (argentina.gob.ar/feriados, publicado por La Nación),
// con los trasladables ya movidos. 2027: solo los inamovibles y los que dependen de la
// Pascua; los trasladables y los puentes se agregan cuando salga el decreto (a fin de año).
const FERIADOS = new Set([
  // 2026
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-03-23', '2026-03-24', '2026-04-02', '2026-04-03',
  '2026-05-01', '2026-05-25', '2026-06-15', '2026-06-20', '2026-07-09', '2026-07-10', '2026-08-17',
  '2026-10-12', '2026-11-09', '2026-11-23', '2026-12-07', '2026-12-08', '2026-12-25',
  // 2027 (parcial: falta el decreto de trasladables y puentes)
  '2027-01-01', '2027-02-08', '2027-02-09', '2027-03-24', '2027-03-26', '2027-04-02', '2027-05-01',
  '2027-05-25', '2027-06-20', '2027-07-09', '2027-12-08', '2027-12-25',
]);

function esHabil(fecha) {
  const f = String(fecha).slice(0, 10);
  const dow = new Date(`${f}T12:00:00`).getDay();
  return dow !== 0 && dow !== 6 && !FERIADOS.has(f);
}

function sumarUnDia(fecha) {
  const d = new Date(`${fecha}T12:00:00`); d.setDate(d.getDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Días hábiles entre dos fechas 'YYYY-MM-DD', la segunda EXCLUSIVA.
function habilesEntre(desde, hastaExcl) {
  let n = 0;
  for (let d = desde; d < hastaExcl; d = sumarUnDia(d)) if (esHabil(d)) n++;
  return n;
}

module.exports = { FERIADOS, esHabil, habilesEntre };
