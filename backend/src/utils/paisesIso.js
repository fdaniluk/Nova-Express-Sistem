// Nombre del país tal como lo usa el sistema (las claves de ZONAS_UPS / ZONAS_DHL del
// cotizador) → código ISO 3166-1 alfa-2, que es lo que pide la API de UPS en CountryCode.
// Guías, etapa 2 (08/09/2026). Si un destinatario tiene un país que no está acá, la
// oficina puede escribir directamente el código de dos letras en el campo país.
const ISO = {
  'Afganistán': 'AF', 'Albania': 'AL', 'Alemania': 'DE', 'Andorra': 'AD', 'Angola': 'AO',
  'Anguila': 'AI', 'Antigua': 'AG', 'Antigua y Barbuda': 'AG', 'Arabia Saudita': 'SA',
  'Argelia': 'DZ', 'Argentina': 'AR', 'Armenia': 'AM', 'Aruba': 'AW', 'Australia': 'AU',
  'Austria': 'AT', 'Azerbaiyán': 'AZ', 'Bahamas': 'BS', 'Bahréin': 'BH', 'Bangladesh': 'BD',
  'Barbados': 'BB', 'Belarús': 'BY', 'Bélgica': 'BE', 'Belice': 'BZ', 'Benín': 'BJ',
  'Bermuda': 'BM', 'Bolivia': 'BO', 'Bonaire': 'BQ', 'Bosnia-Herzegovina': 'BA',
  'Botswana': 'BW', 'Brasil': 'BR', 'Brunei': 'BN', 'Bulgaria': 'BG', 'Burkina Faso': 'BF',
  'Burundi': 'BI', 'Bután': 'BT', 'Cabo Verde': 'CV', 'Camboya': 'KH', 'Camerún': 'CM',
  'Canadá': 'CA', 'Chad': 'TD', 'Chile': 'CL', 'China': 'CN', 'Chipre': 'CY',
  'Ciudad del Vaticano': 'VA', 'Colombia': 'CO', 'Comoros': 'KM', 'Congo': 'CG',
  'Corea del Sur': 'KR', 'Costa Rica': 'CR', 'Costa de Marfil': 'CI', 'Croacia': 'HR',
  'Cuba': 'CU', 'Curasao': 'CW', 'Dinamarca': 'DK', 'Dominica': 'DM', 'Ecuador': 'EC',
  'Egipto': 'EG', 'El Salvador': 'SV', 'Emiratos Árabes Unidos': 'AE', 'Eritrea': 'ER',
  'Eslovaquia': 'SK', 'Eslovenia': 'SI', 'España': 'ES', 'Estados Unidos': 'US', 'USA': 'US',
  'Estonia': 'EE', 'Etiopía': 'ET', 'Fiji': 'FJ', 'Filipinas': 'PH', 'Finlandia': 'FI',
  'Francia': 'FR', 'Gabón': 'GA', 'Gambia': 'GM', 'Georgia': 'GE', 'Ghana': 'GH',
  'Gibraltar': 'GI', 'Granada': 'GD', 'Grecia': 'GR', 'Groenlandia': 'GL', 'Guadalupe': 'GP',
  'Guam': 'GU', 'Guatemala': 'GT', 'Guayana Francesa': 'GF', 'Guyana Francesa': 'GF',
  'Guinea': 'GN', 'Guinea-Bissau': 'GW', 'Guinea Ecuatorial': 'GQ', 'Guyana': 'GY',
  'Haití': 'HT', 'Honduras': 'HN', 'Hong Kong': 'HK', 'Hungría': 'HU', 'India': 'IN',
  'Indonesia': 'ID', 'Irak': 'IQ', 'Irán': 'IR', 'Irlanda': 'IE', 'Isla de Reunión': 'RE',
  'Isla Malvinas': 'FK', 'Islandia': 'IS', 'Islas Caimán': 'KY', 'Islas Canarias': 'ES',
  'Islas Cook': 'CK', 'Islas Feroe': 'FO', 'Islas Marshall': 'MH', 'Islas Salomón': 'SB',
  'Islas Turcas y Caicos': 'TC', 'Islas Vírgenes Británicas': 'VG', 'Islas Vírgenes (EE.UU.)': 'VI',
  'Israel': 'IL', 'Italia': 'IT', 'Jamaica': 'JM', 'Japón': 'JP', 'Jersey': 'JE',
  'Jordania': 'JO', 'Kazajistán': 'KZ', 'Kenia': 'KE', 'Kirguistán': 'KG', 'Kiribati': 'KI',
  'Kosovo': 'XK', 'Kuwait': 'KW', 'Laos': 'LA', 'Lesotho': 'LS', 'Letonia': 'LV',
  'Líbano': 'LB', 'Liberia': 'LR', 'Liechtenstein': 'LI', 'Lituania': 'LT', 'Luxemburgo': 'LU',
  'Macao': 'MO', 'Macedonia': 'MK', 'Macedonia del Norte': 'MK', 'Madagascar': 'MG',
  'Malasia': 'MY', 'Malaui': 'MW', 'Maldivas': 'MV', 'Mali': 'ML', 'Malta': 'MT',
  'Marruecos': 'MA', 'Martinica': 'MQ', 'Mauricio': 'MU', 'Mauritania': 'MR', 'Mayotte': 'YT',
  'México': 'MX', 'Micronesia': 'FM', 'Moldova': 'MD', 'Mónaco': 'MC', 'Mongolia': 'MN',
  'Montenegro': 'ME', 'Montserrat': 'MS', 'Mozambique': 'MZ', 'Myanmar': 'MM', 'Namibia': 'NA',
  'Nepal': 'NP', 'Nicaragua': 'NI', 'Níger': 'NE', 'Nigeria': 'NG', 'Niue': 'NU',
  'Noruega': 'NO', 'Nueva Caledonia': 'NC', 'Nueva Zelanda': 'NZ', 'Omán': 'OM',
  'Pakistán': 'PK', 'Palau': 'PW', 'Panamá': 'PA', 'Papúa Nueva Guinea': 'PG', 'Paraguay': 'PY',
  'Países Bajos': 'NL', 'Perú': 'PE', 'Polonia': 'PL', 'Portugal': 'PT', 'Puerto Rico': 'PR',
  'Qatar': 'QA', 'Reino Unido': 'GB', 'República Centroafricana': 'CF', 'República Checa': 'CZ',
  'República Dominicana': 'DO', 'Ruanda': 'RW', 'Rumania': 'RO', 'Rusia': 'RU', 'Samoa': 'WS',
  'Samoa Americana': 'AS', 'San Bartolomé': 'BL', 'San Eustaquio': 'BQ', 'San Marino': 'SM',
  'San Vicente': 'VC', 'San Vicente y Las Granadinas': 'VC', 'Santa Lucía': 'LC',
  'Senegal': 'SN', 'Serbia': 'RS', 'Seychelles': 'SC', 'Sierra Leona': 'SL', 'Singapur': 'SG',
  'Somalia': 'SO', 'Sri Lanka': 'LK', 'St. Kitts': 'KN', 'St. Kitts y Nevis': 'KN',
  'St. Maarten': 'SX', 'Sudáfrica': 'ZA', 'Sudán': 'SD', 'Sudán del Sur': 'SS', 'Suecia': 'SE',
  'Suiza': 'CH', 'Suriname': 'SR', 'Tahití': 'PF', 'Tailandia': 'TH', 'Taiwán': 'TW',
  'Tanzania': 'TZ', 'Tayikistán': 'TJ', 'Timor Oriental': 'TL', 'Togo': 'TG', 'Tonga': 'TO',
  'Trinidad y Tobago': 'TT', 'Túnez': 'TN', 'Turquía': 'TR', 'Tuvalu': 'TV', 'Ucrania': 'UA',
  'Uganda': 'UG', 'Uruguay': 'UY', 'Uzbekistán': 'UZ', 'Vanuatu': 'VU', 'Venezuela': 'VE',
  'Vietnam': 'VN', 'Yemen': 'YE', 'Zambia': 'ZM', 'Zimbabue': 'ZW',
};

function sinAcentos(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

const POR_CLAVE = new Map(Object.entries(ISO).map(([k, v]) => [sinAcentos(k), v]));

/** Código ISO-2 del país, o null si no se conoce. Acepta el nombre o el código directo. */
function isoDePais(pais) {
  const p = String(pais ?? '').trim();
  if (!p) return null;
  if (/^[A-Za-z]{2}$/.test(p)) return p.toUpperCase();
  return POR_CLAVE.get(sinAcentos(p)) || null;
}

module.exports = { isoDePais, ISO };
