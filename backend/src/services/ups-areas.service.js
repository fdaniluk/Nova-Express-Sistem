// Áreas de entrega de UPS: dado país + código postal (o ciudad), dice si UPS cobra
// recargo de área extendida / remota en destino. Tabla ups_areas (ver schema.sql).
//
// Cómo se busca:
//   · Se normaliza el CP: mayúsculas, sin espacios ni guiones. En países con CP numérico
//     (Argentina, EE.UU., Brasil, España…) se comparan los dígitos como número, así "B1917"
//     o "1917" caen en el rango 1917–1917. En países alfanuméricos (Canadá, Reino Unido)
//     se compara el texto contra el rango, recortado al largo del rango.
//   · Si no hay match por CP y viene ciudad, se busca por ciudad (Bahamas, Brunei, etc.).
//   · Si no hay nada → zona 'normal'.
// Mapeo a la zona de entrega del cotizador (calcZonaEntrega en cotizador-core.js):
//   remota / remota_extendida → 'remota'; no_metropolitana / entrega / entrega_extendida
//   → 'extendida'. UPS cobra distinto cada uno pero el sistema hoy tiene dos tarifas.
const { getDb } = require('../db');
const { isoDePais } = require('../utils/paisesIso');

const ZONA_POR_RECARGO = {
  remota: 'remota', remota_extendida: 'remota',
  no_metropolitana: 'extendida', entrega: 'extendida', entrega_extendida: 'extendida',
};
const ETIQUETA = {
  remota: 'Área remota', remota_extendida: 'Área remota extendida',
  no_metropolitana: 'Área no metropolitana', entrega: 'Área de entrega', entrega_extendida: 'Área de entrega extendida',
};

function normalizarCp(cp) {
  return String(cp ?? '').toUpperCase().replace(/[\s-]/g, '');
}
function sinAcentos(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
}

async function buscarArea({ pais, cp, ciudad }) {
  const db = getDb();
  const iso = isoDePais(pais);
  const out = { iso, pais, cp: cp || null, ciudad: ciudad || null, recargo: null, recargo_origen: null, zona: 'normal', etiqueta: null, match: null };
  if (!iso) return out;

  const cpN = normalizarCp(cp);
  let fila = null;
  if (cpN) {
    const digitos = cpN.replace(/\D/g, '');
    if (digitos) {
      const n = Number(digitos);
      fila = await db.prepare(
        `SELECT * FROM ups_areas WHERE iso = ? AND numerico = 1 AND cp_desde_num <= ? AND cp_hasta_num >= ?
         ORDER BY (cp_hasta_num - cp_desde_num) LIMIT 1`
      ).get(iso, n, n);
    }
    if (!fila) {
      // Alfanumérico: el CP del usuario recortado al largo del rango tiene que caer entre desde y hasta.
      fila = await db.prepare(
        `SELECT * FROM ups_areas WHERE iso = ? AND numerico = 0 AND cp_desde <> ''
           AND substr(?, 1, length(cp_desde)) >= cp_desde AND substr(?, 1, length(cp_hasta)) <= cp_hasta
         ORDER BY length(cp_desde) DESC LIMIT 1`
      ).get(iso, cpN, cpN);
    }
    if (fila) out.match = 'cp';
  }
  if (!fila && ciudad) {
    const c = sinAcentos(ciudad);
    const filas = await db.prepare("SELECT * FROM ups_areas WHERE iso = ? AND ciudad <> ''").all(iso);
    fila = filas.find((f) => sinAcentos(f.ciudad) === c) || filas.find((f) => c.includes(sinAcentos(f.ciudad)) || sinAcentos(f.ciudad).includes(c)) || null;
    if (fila) out.match = 'ciudad';
  }
  if (!fila) return out;
  out.recargo = fila.recargo_destino;
  out.recargo_origen = fila.recargo_origen || null;
  out.zona = ZONA_POR_RECARGO[fila.recargo_destino] || 'normal';
  out.etiqueta = ETIQUETA[fila.recargo_destino] || fila.recargo_destino;
  return out;
}

async function resumen() {
  const db = getDb();
  const total = (await db.prepare('SELECT COUNT(*) AS n FROM ups_areas').get()).n;
  const paises = (await db.prepare('SELECT COUNT(DISTINCT iso) AS n FROM ups_areas').get()).n;
  return { total, paises };
}

module.exports = { buscarArea, resumen, ZONA_POR_RECARGO };
