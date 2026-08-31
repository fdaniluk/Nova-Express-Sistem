let _token = null;
let _tokenExpiry = 0;

const UPS_API_BASE = (process.env.UPS_API_BASE || 'https://onlinetools.ups.com').trim();

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const clientId = (process.env.UPS_CLIENT_ID || '').trim();
  const clientSecret = (process.env.UPS_CLIENT_SECRET || '').trim();

  if (!clientId || !clientSecret) {
    throw new Error('Faltan credenciales UPS_CLIENT_ID / UPS_CLIENT_SECRET en .env');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(`${UPS_API_BASE}/security/v1/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UPS auth falló (${res.status}): ${text}`);
  }

  const data = await res.json();
  _token = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _token;
}

async function getTracking(numeroGuia) {
  const token = await getToken();

  const url = `${UPS_API_BASE}/api/track/v1/details/${encodeURIComponent(numeroGuia)}?locale=en_US&returnSignature=false`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      transId: `nova-${Date.now()}`,
      transactionSrc: 'nova-express',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const codigos = parseUpsErrores(text);
    if (codigos) {
      console.warn(`[ups.tracking] guia ${numeroGuia} rechazada por UPS: ${codigos}`);
    } else {
      console.warn(`[ups.tracking] guia ${numeroGuia} falló (${res.status}): ${text}`);
    }
    throw new Error(`UPS tracking falló (${res.status}): ${text}`);
  }

  const data = await res.json();
  const shipment = data.trackResponse?.shipment?.[0];
  if (!shipment) throw new Error('No se encontró información del envío en la respuesta UPS');

  const pkg = shipment.package?.[0];
  const activity = pkg?.activity?.[0];

  const addr = activity?.location?.address || {};
  const ubicacion = [addr.city, addr.stateProvince, addr.countryCode]
    .filter(Boolean).join(', ') || null;

  const fecha = fmtFecha(activity?.date);

  // Campos ampliados (no rompen los 4 de arriba) ───────────────────────────────
  const servicio = pkg?.service?.description || null;

  const w = pkg?.weight;
  const peso = (w?.weight != null && w?.unitOfMeasurement != null)
    ? `${w.weight} ${w.unitOfMeasurement}`
    : null;

  const deliveryDates = pkg?.deliveryDate || [];
  const estimada = deliveryDates.find((dd) => dd?.type === 'SDD' || dd?.type === 'RDD');
  const entrega = deliveryDates.find((dd) => dd?.type === 'DEL');
  const fechaEstimada = fmtFecha(estimada?.date);
  const fechaEntrega = fmtFecha(entrega?.date);

  const detalleEntrega = pkg?.deliveryInformation?.location || null;

  const movimientos = (pkg?.activity || []).map((act) => {
    const a = act?.location?.address || {};
    return {
      estado: act?.status?.description || null,
      ubicacion: [a.city, a.stateProvince, a.countryCode].filter(Boolean).join(', ') || null,
      fecha: fmtFecha(act?.date),
      hora: fmtHora(act?.time),
    };
  });

  return {
    guia: numeroGuia,
    estado: activity?.status?.description || 'Sin información',
    // Código de tipo de la actividad más reciente, tal como lo manda UPS:
    //   M/MV = manifest (la etiqueta existe pero nadie la escaneó) · I = en tránsito ·
    //   P = pickup · O = out for delivery · X = excepción · D = entregado · RS = devuelto
    // Es lo que usa el semáforo automático; la descripción es solo para humanos.
    tipo: activity?.status?.type || null,
    ubicacion,
    fecha,
    servicio,
    peso,
    fechaEstimada,
    fechaEntrega,
    detalleEntrega,
    movimientos,
  };
}

// Body de error UPS -> "TV1002 Invalid inquiry number, TV0021 ..." (null si no parsea).
function parseUpsErrores(text) {
  if (!text) return null;
  try {
    const body = JSON.parse(text);
    const errores = body?.response?.errors;
    if (!Array.isArray(errores) || errores.length === 0) return null;
    return errores
      .map((e) => [e?.code, e?.message].filter(Boolean).join(' '))
      .filter(Boolean)
      .join(', ') || null;
  } catch {
    return null;
  }
}

// "YYYYMMDD" -> "YYYY-MM-DD" (null si falta o no tiene el largo esperado).
function fmtFecha(d) {
  if (!d || d.length < 8) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// "HHMMSS" -> "HH:MM" (null si falta o no tiene el largo esperado).
function fmtHora(t) {
  if (!t || t.length < 4) return null;
  return `${t.slice(0, 2)}:${t.slice(2, 4)}`;
}

// El semáforo de Salidas a partir del tipo de estado de UPS (pedido de Felipe, 31/08):
//   rojo     = sin escanear (la guía existe, UPS todavía no la tocó)
//   amarillo = en tránsito (cualquier escaneo real que no sea la entrega)
//   verde    = entregada
// Un tipo desconocido o vacío cae en amarillo SOLO si hay descripción (algo pasó); si no
// hay nada de nada, null: el que llama decide no tocar el semáforo.
function semaforoDeEstado(tipo, descripcion) {
  const t = String(tipo || '').toUpperCase();
  if (t === 'M' || t === 'MV') return 'rojo';
  if (t === 'D') return 'verde';
  if (t) return 'amarillo';
  return descripcion ? 'amarillo' : null;
}

module.exports = { getToken, getTracking, semaforoDeEstado };
