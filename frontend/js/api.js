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
    confirmar: (id) => request(`/liquidaciones/${id}/confirmar`, { method: 'PATCH' }),
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
  resolver: (id, params) => {
    const q = new URLSearchParams(params).toString();
    return api.get(`/clientes/${id}/profit-resolve?${q}`);
  },
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
  actualizarEstado: (id, estado_revision) =>
    request(`/facturas/guias/${id}/estado`, { method: 'PATCH', body: { estado_revision } }),
};

window.NovaAPI = api;
