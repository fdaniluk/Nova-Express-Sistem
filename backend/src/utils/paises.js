// Diccionario de alias de países → nombre canónico
const ALIASES = {
  // USA
  'usa': 'USA',
  'eeuu': 'USA',
  'estados unidos': 'USA',
  'united states': 'USA',
  'us': 'USA',
  // UK
  'uk': 'Reino Unido',
  'reino unido': 'Reino Unido',
  'united kingdom': 'Reino Unido',
  'england': 'Reino Unido',
  'gran bretana': 'Reino Unido',
  // Europa
  'alemania': 'Alemania',
  'germany': 'Alemania',
  'francia': 'Francia',
  'france': 'Francia',
  'italia': 'Italia',
  'italy': 'Italia',
  'espana': 'España',
  'spain': 'España',
  'holanda': 'Países Bajos',
  'netherlands': 'Países Bajos',
  'belgica': 'Bélgica',
  'belgium': 'Bélgica',
  'suiza': 'Suiza',
  'switzerland': 'Suiza',
  'suecia': 'Suecia',
  'sweden': 'Suecia',
  'noruega': 'Noruega',
  'norway': 'Noruega',
  'portugal': 'Portugal',
  'austria': 'Austria',
  'dinamarca': 'Dinamarca',
  'denmark': 'Dinamarca',
  'finlandia': 'Finlandia',
  'finland': 'Finlandia',
  'polonia': 'Polonia',
  'poland': 'Polonia',
  'republica checa': 'Rep. Checa',
  'czech republic': 'Rep. Checa',
  'hungria': 'Hungría',
  'hungary': 'Hungría',
  'grecia': 'Grecia',
  'greece': 'Grecia',
  'rumania': 'Rumanía',
  'romania': 'Rumanía',
  'turquia': 'Turquía',
  'turkey': 'Turquía',
  // Asia
  'china': 'China',
  'japon': 'Japón',
  'japan': 'Japón',
  'corea del sur': 'Corea del Sur',
  'south korea': 'Corea del Sur',
  'korea': 'Corea del Sur',
  'india': 'India',
  'israel': 'Israel',
  'emiratos arabes': 'EAU',
  'uae': 'EAU',
  'dubai': 'EAU',
  'hong kong': 'Hong Kong',
  'singapur': 'Singapur',
  'singapore': 'Singapur',
  'taiwan': 'Taiwán',
  // Oceanía
  'australia': 'Australia',
  'nueva zelanda': 'Nueva Zelanda',
  'new zealand': 'Nueva Zelanda',
  // Américas
  'canada': 'Canadá',
  'mexico': 'México',
  'brasil': 'Brasil',
  'brazil': 'Brasil',
  'chile': 'Chile',
  'colombia': 'Colombia',
  'peru': 'Perú',
  'uruguay': 'Uruguay',
  'paraguay': 'Paraguay',
  'bolivia': 'Bolivia',
  'venezuela': 'Venezuela',
  'ecuador': 'Ecuador',
  'panama': 'Panamá',
  'costa rica': 'Costa Rica',
  'guatemala': 'Guatemala',
  'cuba': 'Cuba',
  'puerto rico': 'Puerto Rico',
  // África
  'sudafrica': 'Sudáfrica',
  'south africa': 'Sudáfrica',
  'marruecos': 'Marruecos',
  'morocco': 'Marruecos',
};

function normalizeStr(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function capitalize(s) {
  return String(s || '')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Detecta si el string de destino indica una importación (viene a Argentina)
function esImpo(raw) {
  const lower = normalizeStr(raw);
  // "argentina" explícita, o variantes comunes de "arg"
  return (
    lower.includes('argentina') ||
    /\-\s*arg(\s|$)/.test(lower) ||
    /\s+arg(\s|$)/.test(lower)
  );
}

// Extrae el país de origen de un string tipo "japon-argentina", "usa - arg"
function extraerOrigen(raw) {
  const separators = /\s*[-–—]\s*/;
  const parts = raw.split(separators);
  // Tomar la parte que NO sea "argentina" ni "arg"
  for (const p of parts) {
    if (!esImpo(p)) {
      const norm = normalizeStr(p);
      return ALIASES[norm] || capitalize(p);
    }
  }
  return null;
}

/**
 * Normaliza un string de destino crudo.
 * Retorna { destino, destino_raw, direccion, origen }
 *
 * destino:     nombre canónico del país (para EXPO: destino; para IMPO: país de origen)
 * destino_raw: valor original sin modificar
 * direccion:   'impo' | 'expo'
 * origen:      para IMPO, el país de origen; null para EXPO
 */
function normalizarDestino(raw, observaciones) {
  const rawStr = String(raw || '').trim();
  if (!rawStr || rawStr === '—') {
    return { destino: '—', destino_raw: rawStr, direccion: 'expo', origen: null };
  }

  const obs = normalizeStr(observaciones || '');
  const impoDesdeObs = obs.includes('impo') && !obs.includes('no es nuestra');
  const importacion = esImpo(rawStr) || impoDesdeObs;

  let destino;
  let origen = null;

  if (importacion) {
    origen = extraerOrigen(rawStr);
    if (!origen) {
      destino = 'Argentina (IMPO)';
    } else {
      destino = `${origen} → ARG`;
    }
  } else {
    const norm = normalizeStr(rawStr);
    destino = ALIASES[norm] || capitalize(rawStr);
  }

  return {
    destino,
    destino_raw: rawStr,
    direccion: importacion ? 'impo' : 'expo',
    origen,
  };
}

module.exports = { normalizarDestino, ALIASES, esImpo, normalizeStr };
