/* Estados de EE.UU. y provincias de Canadá: nombre → código de 2 letras, que es lo que UPS
   exige en StateProvinceCode (16/10/2026, pedido de administración: en la página de UPS
   escribís "Texas" y te pone TX solo; en el sistema había que saberse el código).

   Una sola fuente para la pantalla de Guías (sugiere y convierte mientras se escribe) y el
   servidor (convierte antes de mandar a UPS y rechaza lo que no reconoce). Acepta el nombre
   en inglés o en castellano, con o sin acentos, y el código mismo. */
(function (raiz) {
  const US = {
    AL: ['Alabama'], AK: ['Alaska'], AZ: ['Arizona'], AR: ['Arkansas'], CA: ['California'],
    CO: ['Colorado'], CT: ['Connecticut'], DE: ['Delaware'], FL: ['Florida'], GA: ['Georgia'],
    HI: ['Hawaii', 'Hawai'], ID: ['Idaho'], IL: ['Illinois'], IN: ['Indiana'], IA: ['Iowa'],
    KS: ['Kansas'], KY: ['Kentucky'], LA: ['Louisiana', 'Luisiana'], ME: ['Maine'], MD: ['Maryland'],
    MA: ['Massachusetts'], MI: ['Michigan'], MN: ['Minnesota'], MS: ['Mississippi', 'Misisipi'],
    MO: ['Missouri', 'Misuri'], MT: ['Montana'], NE: ['Nebraska'], NV: ['Nevada'],
    NH: ['New Hampshire', 'Nuevo Hampshire'], NJ: ['New Jersey', 'Nueva Jersey'],
    NM: ['New Mexico', 'Nuevo Mexico'], NY: ['New York', 'Nueva York'],
    NC: ['North Carolina', 'Carolina del Norte'], ND: ['North Dakota', 'Dakota del Norte'],
    OH: ['Ohio'], OK: ['Oklahoma'], OR: ['Oregon'], PA: ['Pennsylvania', 'Pensilvania'],
    RI: ['Rhode Island'], SC: ['South Carolina', 'Carolina del Sur'], SD: ['South Dakota', 'Dakota del Sur'],
    TN: ['Tennessee'], TX: ['Texas', 'Tejas'], UT: ['Utah'], VT: ['Vermont'], VA: ['Virginia'],
    WA: ['Washington'], WV: ['West Virginia', 'Virginia Occidental'], WI: ['Wisconsin'], WY: ['Wyoming'],
    DC: ['District of Columbia', 'Washington DC', 'Distrito de Columbia'], PR: ['Puerto Rico'],
  };
  const CA = {
    AB: ['Alberta'], BC: ['British Columbia', 'Columbia Britanica'], MB: ['Manitoba'],
    NB: ['New Brunswick', 'Nuevo Brunswick'], NL: ['Newfoundland and Labrador', 'Newfoundland', 'Terranova y Labrador'],
    NS: ['Nova Scotia', 'Nueva Escocia'], NT: ['Northwest Territories', 'Territorios del Noroeste'],
    NU: ['Nunavut'], ON: ['Ontario'], PE: ['Prince Edward Island', 'Isla del Principe Eduardo'],
    QC: ['Quebec'], SK: ['Saskatchewan'], YT: ['Yukon'],
  };
  const TABLAS = { US, CA };
  const limpiar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

  // Devuelve el código (TX) para lo que se escribió ("Texas", "tejas", "tx", "TX"), o null si
  // no se reconoce. iso: 'US' | 'CA'; sin iso busca en las dos tablas.
  function codigoDeEstado(texto, iso) {
    const t = limpiar(texto);
    if (!t) return null;
    const tablas = iso && TABLAS[iso] ? [TABLAS[iso]] : [US, CA];
    for (const tabla of tablas) {
      if (t.length === 2 && tabla[t.toUpperCase()]) return t.toUpperCase();
      for (const [cod, nombres] of Object.entries(tabla)) {
        if (nombres.some((n) => limpiar(n) === t)) return cod;
      }
    }
    return null;
  }
  // El nombre en inglés de un código, para mostrar "Texas → TX".
  function nombreDeEstado(codigo, iso) {
    const c = String(codigo || '').toUpperCase();
    const tablas = iso && TABLAS[iso] ? [TABLAS[iso]] : [US, CA];
    for (const tabla of tablas) if (tabla[c]) return tabla[c][0];
    return null;
  }
  // Lista para el autocompletado de la pantalla: [{ codigo, nombre }], ordenada por nombre.
  function listaDeEstados(iso) {
    const tablas = iso && TABLAS[iso] ? [TABLAS[iso]] : [US, CA];
    const out = [];
    for (const tabla of tablas) for (const [codigo, nombres] of Object.entries(tabla)) out.push({ codigo, nombre: nombres[0] });
    return out.sort((a, b) => a.nombre.localeCompare(b.nombre));
  }
  const api = { codigoDeEstado, nombreDeEstado, listaDeEstados, US, CA };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.NovaEstados = api;
}(typeof window !== 'undefined' ? window : this));
