// Fechas locales del servidor.
//
// El VPS está en -03 (verificado con `date` el 27/07/2026), y el esquema usa
// datetime('now','localtime') en todos los DEFAULT. Pero el código JS venía usando
// `new Date().toISOString().slice(0,10)` para "hoy", y **toISOString() devuelve SIEMPRE
// UTC, sin importar la zona horaria del servidor**. Entre las 21:00 y las 23:59 hora de
// Buenos Aires eso devuelve el día SIGUIENTE.
//
// Casos concretos que provocaba:
//   · una liquidación confirmada el 31 a las 22:00 quedaba fechada el 1 del mes siguiente,
//     y por lo tanto en el mes de facturación equivocado;
//   · `fecha_facturado` de una carga de facturas de noche quedaba un día adelantada;
//   · el dashboard con período "hoy" apuntaba a mañana y salía vacío.
//
// Para un courier que opera de tarde, esto pasaba todos los días.
//
// Es la contraparte de NovaUtils.hoyLocal() del frontend (frontend/js/main.js).

function hoyLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Fecha local corrida N días (negativo = hacia atrás), 'YYYY-MM-DD'.
function hoyLocalMas(dias, base = new Date()) {
  const d = new Date(base);
  d.setDate(d.getDate() + dias);
  return hoyLocal(d);
}

module.exports = { hoyLocal, hoyLocalMas };
