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
    confirmar: (id) => api.post(`/liquidaciones/${id}/confirmar`),
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
  },
};

api.dashboard = {
  metricas: (periodo) => api.get(`/dashboard/metricas?periodo=${periodo}`),
};

window.NovaAPI = api;
