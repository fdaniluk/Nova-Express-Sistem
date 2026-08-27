const API_BASE = `${window.location.origin}/api`;

async function request(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const config = {
    headers: {},
    ...options,
  };

  if (config.body && !(config.body instanceof FormData)) {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(config.body);
  }

  const res = await fetch(url, config);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    location.replace('/pages/login.html');
    throw new Error('Sesión expirada');
  }
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      const data = await res.json();
      msg = data.error || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.blob();
}

const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  delete: (path) => request(path, { method: 'DELETE' }),

  clientes: {
    listar: () => api.get('/clientes'),
    obtener: (id) => api.get(`/clientes/${id}`),
    crear: (data) => api.post('/clientes', data),
    actualizar: (id, data) => api.put(`/clientes/${id}`, data),
    eliminar: (id) => api.delete(`/clientes/${id}`),
    perfil: (id) => api.get(`/clientes/${id}/perfil`),
  },

  envios: {
    listar: (params) => {
      const q = new URLSearchParams(params).toString();
      return api.get(`/envios${q ? `?${q}` : ''}`);
    },
    obtener: (id) => api.get(`/envios/${id}`),
    crear: (data) => api.post('/envios', data),
    actualizar: (id, data) => api.put(`/envios/${id}`, data),
    calcularPesos: (data) => api.post('/envios/calcular-pesos', data),
    importar: (file) => {
      const fd = new FormData();
      fd.append('archivo', file);
      return request('/envios/importar', { method: 'POST', body: fd });
    },
  },

  liquidaciones: {
    pendientes: (params) => {
      const q = new URLSearchParams(params).toString();
      return api.get(`/liquidaciones/pendientes${q ? `?${q}` : ''}`);
    },
    preview: (data) => api.post('/liquidaciones/preview', data),
    crear: (data) => api.post('/liquidaciones', data),
    cotizar: (data) => api.post('/liquidaciones/cotizar', data),
    // `envio_ids` es la selección que la pantalla está mostrando: el backend la compara
    // con el borrador y rechaza con 409 si difieren (el "borrador pegado").
    confirmar: (id, envio_ids) => request(`/liquidaciones/${id}/confirmar`, { method: 'PATCH', body: envio_ids ? { envio_ids } : undefined }),
    eliminarBorrador: (id) => api.delete(`/liquidaciones/${id}`),
    listar: (params) => {
      const q = new URLSearchParams(params).toString();
      return api.get(`/liquidaciones${q ? `?${q}` : ''}`);
    },
    obtener: (id) => api.get(`/liquidaciones/${id}`),
    exportarUrl: (id) => `${API_BASE}/liquidaciones/${id}/export`,
  },

  configuracion: {
    fuel: () => api.get('/configuracion/fuel'),
    actualizarFuel: (courier, fuel_pct) =>
      api.put(`/configuracion/fuel/${courier}`, { fuel_pct }),
    historialFuel: (courier) => {
      const q = courier ? `?courier=${courier}` : '';
      return api.get(`/configuracion/fuel/historial${q}`);
    },
    umbral: () => api.get('/configuracion/umbral'),
    actualizarUmbral: (courier, ganancia_minima_pct) =>
      api.put(`/configuracion/umbral/${courier}`, { ganancia_minima_pct }),
    historialUmbral: (courier) => {
      const q = courier ? `?courier=${courier}` : '';
      return api.get(`/configuracion/umbral/historial${q}`);
    },
    tolerancias: () => api.get('/configuracion/tolerancias'),
    actualizarTolerancias: (
      courier, tolerancia_peso_pct, tolerancia_costo_pct,
      tolerancia_costo_usd, tolerancia_peso_kg
    ) =>
      api.put(`/configuracion/tolerancias/${courier}`, {
        tolerancia_peso_pct,
        tolerancia_costo_pct,
        tolerancia_costo_usd,
        tolerancia_peso_kg,
      }),
  },
};

api.clientes.direcciones = {
  listar: (clienteId) => api.get(`/clientes/${clienteId}/direcciones`),
  agregar: (clienteId, dir) =>
    api.post(`/clientes/${clienteId}/direcciones`, { direccion: dir }),
  borrar: (clienteId, dirId) =>
    api.delete(`/clientes/${clienteId}/direcciones/${dirId}`),
};

api.clientes.profit = {
  matriz: (id, servicio, tipo) => {
    const q = new URLSearchParams({ servicio, tipo }).toString();
    return api.get(`/clientes/${id}/profit-matrix?${q}`);
  },
  guardar: (id, body) => api.put(`/clientes/${id}/profit-matrix`, body),
  // api.delete no acepta body; se usa request() directo para enviar las coordenadas.
  borrar: (id, body) => request(`/clientes/${id}/profit-matrix`, { method: 'DELETE', body }),
  // Resuelve la tarifa de VENTA del cliente. Devuelve { modo, profitPct, precioKg,
  // origen, advertencia, fuelPctPropio }: el backend decide solo si ese cliente cobra
  // por porcentaje o por precio por kilo.
  resolver: (id, params) => {
    const q = new URLSearchParams(params).toString();
    return api.get(`/clientes/${id}/profit-resolve?${q}`);
  },
};

// Tarifa en USD por kilo, para los clientes con modo_tarifa = 'por_kg'.
api.clientes.tarifaKg = {
  matriz: (id, servicio, tipo) => {
    const q = new URLSearchParams({ servicio, tipo }).toString();
    return api.get(`/clientes/${id}/tarifa-kg?${q}`);
  },
  guardar: (id, body) => api.put(`/clientes/${id}/tarifa-kg`, body),
  borrar: (id, body) => request(`/clientes/${id}/tarifa-kg`, { method: 'DELETE', body }),
};

// El tarifario que se le manda AL CLIENTE. Solo lectura; el servidor devuelve precios de
// venta ya resueltos (nunca costos ni margenes). `qs` son las opciones del panel.
api.clientes.tarifario = (id, qs) => api.get(`/clientes/${id}/tarifario?${qs}`);
api.clientes.tarifarioExcelUrl = (id, qs) => `${API_BASE}/clientes/${id}/tarifario.xlsx?${qs}`;
// Emitir = generar la grilla Y dejarla registrada (quien, cuando, y la hoja completa).
api.clientes.tarifarioEmitir = (id, opciones) => api.post(`/clientes/${id}/tarifario/emitir`, opciones);
api.clientes.tarifarioEmitidos = (id) => api.get(`/clientes/${id}/tarifario/emitidos`);
// Lo del tarifario que no cuelga de un cliente: presets del panel y emisiones por id.
api.tarifario = {
  emitido: (id) => api.get(`/tarifario/emitidos/${id}`),
  presets: () => api.get('/tarifario/presets'),
  guardarPreset: (nombre, opciones) => api.put('/tarifario/presets', { nombre, opciones }),
  borrarPreset: (id) => api.delete(`/tarifario/presets/${id}`),
};

// Tramos de peso del cliente. Los usan las DOS matrices: la de porcentaje y la de kilo.
// Un cliente sin tramos propios hereda los por defecto; la respuesta dice cual es el caso.
api.clientes.tramos = {
  obtener: (id) => api.get(`/clientes/${id}/tramos`),
  guardar: (id, tramos) => api.put(`/clientes/${id}/tramos`, { tramos }),
};

api.dashboard = {
  metricas: (params) => {
    const p = typeof params === 'string' ? { periodo: params } : params || {};
    const q = new URLSearchParams(p).toString();
    return api.get(`/dashboard/metricas${q ? `?${q}` : ''}`);
  },
  meses: () => api.get('/dashboard/meses'),
};

api.pickups = {
  listar: (desde, hasta) => api.get(`/pickups?desde=${desde}&hasta=${hasta}`),
  crear: (data) => api.post('/pickups', data),
  editar: (id, data) => api.put(`/pickups/${id}`, data),
  borrar: (id) => api.delete(`/pickups/${id}`),
  confirmar: (id, data) => api.patch(`/pickups/${id}`, data),
};

api.operaciones = {
  delDia: (fecha) => api.get(`/operaciones?fecha=${fecha}`),
  actualizarEnvio: (id, data) => request(`/operaciones/envios/${id}`, { method: 'PATCH', body: data }),
  actualizarPickup: (id, data) => request(`/operaciones/pickups/${id}`, { method: 'PATCH', body: data }),
  // Envios SIN pickup (impo y parecidos): tarjetas propias de operaciones, que la
  // pantalla de Pickups nunca muestra.
  crearSuelto: (data) => api.post('/operaciones/sueltos', data),
  borrarSuelto: (id) => api.delete(`/operaciones/sueltos/${id}`),
};

api.salidas = {
  listar: (params) => {
    const q = params ? new URLSearchParams(params).toString() : '';
    return api.get(`/salidas${q ? `?${q}` : ''}`);
  },
  actualizar: (id, data) => request(`/salidas/${id}`, { method: 'PATCH', body: data }),
  recalcular: (id, data) => request(`/salidas/${id}/recalcular`, { method: 'POST', body: data }),
  actualizarBulto: (id, data) => request(`/salidas/bultos/${id}`, { method: 'PATCH', body: data }),
  actualizarEstadoBultoUnico: (envioId, data) =>
    request(`/salidas/envios/${envioId}/estado-bulto-unico`, { method: 'PATCH', body: data }),
  eliminar: (id) => request(`/salidas/${id}`, { method: 'DELETE' }),
  // NO VOLO: marcar / desmarcar un envio que no salio. no_volo: 1 marca, 0 deshace.
  noVolo: (id, noVolo) =>
    request(`/salidas/${id}/no-volo`, { method: 'PATCH', body: { no_volo: noVolo ? 1 : 0 } }),
};

api.tracking = {
  ups: (guia) => api.get(`/tracking/ups/${encodeURIComponent(guia)}`),
};

api.cobranzas = {
  listar: (filtros = {}) => {
    const params = {};
    if (filtros.cliente_id) params.cliente_id = filtros.cliente_id;
    if (filtros.desde) params.desde = filtros.desde;
    if (filtros.hasta) params.hasta = filtros.hasta;
    const q = new URLSearchParams(params).toString();
    return api.get(`/cobranzas${q ? `?${q}` : ''}`);
  },
  crear: (data) => api.post('/cobranzas', data),
  actualizar: (id, data) => api.patch(`/cobranzas/${id}`, data),
  eliminar: (id) => api.delete(`/cobranzas/${id}`),
};

api.facturas = {
  chequear: (file) => {
    const fd = new FormData();
    fd.append('pdf', file);
    return request('/facturas/chequear', { method: 'POST', body: fd });
  },
  cargar: (file, sobreescribir) => {
    const fd = new FormData();
    fd.append('pdf', file);
    fd.append('sobreescribir', sobreescribir ? 'true' : 'false');
    return request('/facturas/cargar', { method: 'POST', body: fd });
  },
  guias: () => api.get('/facturas/guias'),
  // Guías que el courier facturó y que no tienen envío en el sistema.
  sinEnvio: () => api.get('/facturas/sin-envio'),
  actualizarEstado: (id, estado_revision) =>
    request(`/facturas/guias/${id}/estado`, { method: 'PATCH', body: { estado_revision } }),
};

// Panel de salud. Solo lectura: no hay POST/PATCH/DELETE a proposito.
api.salud = {
  chequear: () => api.get('/salud'),
  // Solo el semaforo, para la franja del Dashboard.
  resumen: () => api.get('/salud/resumen'),
};

// Cotizaciones guardadas y el precio acordado (caso Asaplast). El cotizador no
// persistia nada: sin esto, el precio que el cliente ACEPTO no existia en ningun lado y
// el de Salidas —recalculado con las medidas reales— era el unico que quedaba.
api.cotizaciones = {
  listar: (params) => {
    // OJO: URLSearchParams convierte undefined en el STRING "undefined". Si se le pasa
    // {estado: undefined} el servidor filtra por estado='undefined' y devuelve cero filas
    // sin ningun error a la vista. Se limpian los vacios antes de armar la query.
    const limpio = {};
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') limpio[k] = v;
    });
    const q = new URLSearchParams(limpio).toString();
    return api.get(`/cotizaciones${q ? `?${q}` : ''}`);
  },
  obtener: (id) => api.get(`/cotizaciones/${id}`),
  // Las aceptadas de un cliente que todavia no se usaron en ningun envio.
  aceptadasDe: (clienteId) => api.get(`/cotizaciones/cliente/${clienteId}/aceptadas`),
  // Las de los ultimos N dias corridos (30 por defecto) que la oficina marco para que
  // queden en el historial del cliente. Es lo que muestran Cargar envio y Salidas.
  recientesDe: (clienteId, dias) =>
    api.get(`/cotizaciones/cliente/${clienteId}/recientes${dias ? `?dias=${dias}` : ''}`),
  crear: (data) => api.post('/cotizaciones', data),
  // `servicio` es cual de las opciones eligio el cliente. El TOTAL no viaja: lo saca el
  // servidor de la opcion guardada, asi el precio acordado no se puede tipear.
  aceptar: (id, servicio) => api.post(`/cotizaciones/${id}/aceptar`, { servicio }),
  cambiarEstado: (id, estado) => api.patch(`/cotizaciones/${id}/estado`, { estado }),
  // Que opciones de una guardada viajan al historial del cliente ([{servicio, viaja}]).
  marcar: (id, marcas) => api.patch(`/cotizaciones/${id}/marcas`, { marcas }),
  editar: (id, data) => api.patch(`/cotizaciones/${id}`, data),
  eliminar: (id) => api.delete(`/cotizaciones/${id}`),
};

// Links de cotizacion para clientes (la puerta publica). Esta parte es la de OFICINA,
// con sesion; la cara publica va directo por fetch a /api/publico y no pasa por aca.
api.cotizadorLinks = {
  deCliente: (clienteId) => api.get(`/cotizador-links/cliente/${clienteId}`),
  crear: (data) => api.post('/cotizador-links', data),
  darDeBaja: (id) => api.post(`/cotizador-links/${id}/baja`),
};

window.NovaAPI = api;
