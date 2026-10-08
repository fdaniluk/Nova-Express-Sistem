// DHL Express por API — MyDHL API (08/10/2026). Primera etapa: TRACKING, para que el semáforo
// de Salidas se pinte solo también en los envíos DHL (hasta ahora era solo UPS).
//
// Credenciales en .env (las da DHL al aprobar la app en developer.dhl.com):
//   DHL_API_KEY, DHL_API_SECRET        → Basic auth (key:secret), igual para test y prod
//   DHL_API_ENTORNO=test|prod          → test usa /mydhlapi/test (500 llamadas por día)
//   DHL_CUENTA_EXPO / DHL_CUENTA_EXPO_50 / DHL_CUENTA_IMPO / DHL_CUENTA_IMPO_50
//
// Misma forma de salida que ups.service.getTracking, así tracking-auto los trata igual:
//   { guia, estado, tipo, ubicacion, fecha, hora, servicio, movimientos, paquetes[] }
// y el mismo semáforo: rojo (sin escanear) · amarillo (en tránsito) · verde (entregado).

const crypto = require('crypto');

const DHL_API_BASE = (process.env.DHL_API_BASE || 'https://express.api.dhl.com/mydhlapi').replace(/\/+$/, '');

function hayCredenciales() {
  return Boolean((process.env.DHL_API_KEY || '').trim() && (process.env.DHL_API_SECRET || '').trim());
}

function baseUrl() {
  const entorno = (process.env.DHL_API_ENTORNO || 'test').trim().toLowerCase();
  return entorno === 'prod' || entorno === 'produccion' || entorno === 'production' ? DHL_API_BASE : `${DHL_API_BASE}/test`;
}

function headers() {
  const key = (process.env.DHL_API_KEY || '').trim();
  const secret = (process.env.DHL_API_SECRET || '').trim();
  if (!key || !secret) throw new Error('Faltan credenciales DHL_API_KEY / DHL_API_SECRET en .env');
  return {
    Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
    Accept: 'application/json',
    'Message-Reference': crypto.randomUUID(),
    'Message-Reference-Date': new Date().toUTCString(),
    'Plugin-Name': 'nova-express-sistema',
    'Plugin-Version': '1.0',
  };
}

// Guía DHL: 10 dígitos (las de Nova empiezan en 27, 30, 55, 57, 87, 94…).
const DHL_GUIA_REGEX = /^\d{10}$/;

// Fechas de DHL: "2026-09-08" y horas "14:32:00".
const fmtFecha = (d) => (d && /^\d{4}-\d{2}-\d{2}/.test(String(d)) ? String(d).slice(0, 10) : null);
const fmtHora = (t) => (t && /^\d{2}:\d{2}/.test(String(t)) ? String(t).slice(0, 5) : null);

// El semáforo a partir del último evento de DHL. Códigos de evento (typeCode) de MyDHL:
//   OK = entregado · PU = retirado · PL/DF/AF/CR/WC/… = en tránsito · RT = devuelto
//   Sin eventos (o solo "SD" / shipment data received, la etiqueta existe) = sin escanear.
function semaforoDeEstadoDHL(tipo, descripcion) {
  const t = String(tipo || '').toUpperCase();
  const d = String(descripcion || '');
  if (t === 'OK' || /\bdelivered\b|entregad/i.test(d)) return 'verde';
  if (!t && !d) return null;
  if (t === 'SD' || /shipment information received|datos del env[ií]o recibidos|shipment data received/i.test(d)) return 'rojo';
  return 'amarillo';
}

function ubicacionDe(ev) {
  const sa = Array.isArray(ev?.serviceArea) ? ev.serviceArea[0] : ev?.serviceArea;
  return sa?.description || sa?.code || null;
}

// Convierte la respuesta de MyDHL (shipments[0]) a la forma que usa el sistema.
function normalizarTrackingDHL(numeroGuia, data) {
  const sh = data?.shipments?.[0];
  if (!sh) throw new Error('No se encontró información del envío en la respuesta de DHL');
  const eventos = Array.isArray(sh.events) ? sh.events.slice() : [];
  // DHL los manda del más viejo al más nuevo; el "último" es el que pinta el semáforo.
  const ultimo = eventos.length ? eventos[eventos.length - 1] : null;
  const movimientos = eventos.map((ev) => ({
    tipo: ev?.typeCode || null,
    estado: ev?.description || null,
    ubicacion: ubicacionDe(ev),
    fecha: fmtFecha(ev?.date),
    hora: fmtHora(ev?.time),
  })).reverse(); // más nuevo primero, como UPS
  const paquetes = (Array.isArray(sh.pieces) ? sh.pieces : []).map((p) => {
    const evs = Array.isArray(p?.events) ? p.events : [];
    const u = evs.length ? evs[evs.length - 1] : ultimo;
    return {
      guia: p?.trackingNumber || null,
      tipo: u?.typeCode || null,
      estado: u?.description || null,
      ubicacion: ubicacionDe(u),
      fecha: fmtFecha(u?.date),
      hora: fmtHora(u?.time),
      semaforo: semaforoDeEstadoDHL(u?.typeCode, u?.description),
    };
  });
  const entregado = ultimo && semaforoDeEstadoDHL(ultimo.typeCode, ultimo.description) === 'verde';
  return {
    guia: numeroGuia,
    courier: 'DHL',
    estado: ultimo?.description || (sh.status ? String(sh.status) : 'Sin información'),
    tipo: ultimo?.typeCode || null,
    ubicacion: ubicacionDe(ultimo),
    fecha: fmtFecha(ultimo?.date),
    hora: fmtHora(ultimo?.time),
    servicio: sh.productCode ? `DHL ${sh.productCode}${sh.description ? ' — ' + sh.description : ''}` : (sh.description || null),
    peso: sh.totalWeight != null ? `${sh.totalWeight} ${sh.unitOfMeasurements || 'kg'}` : null,
    fechaEntrega: entregado ? fmtFecha(ultimo.date) : null,
    firmadoPor: entregado ? (ultimo.signedBy || null) : null,
    origen: sh.shipperDetails?.postalAddress?.cityName || null,
    destino: sh.receiverDetails?.postalAddress?.cityName || null,
    movimientos,
    paquetes,
  };
}

// GET /shipments/{guia}/tracking — todos los checkpoints, detalle completo.
async function getTrackingDHL(numeroGuia) {
  const guia = String(numeroGuia || '').trim();
  if (!DHL_GUIA_REGEX.test(guia)) throw new Error('Número de guía DHL inválido');
  const url = `${baseUrl()}/shipments/${encodeURIComponent(guia)}/tracking?trackingView=all-checkpoints&levelOfDetail=all`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detalle = text;
    try { const j = JSON.parse(text); detalle = j.detail || j.title || j.message || text; } catch { /* texto plano */ }
    console.warn(`[dhl.tracking] guía ${guia} falló (${res.status}): ${String(detalle).slice(0, 200)}`);
    throw new Error(`DHL tracking falló (${res.status}): ${String(detalle).slice(0, 200)}`);
  }
  const data = await res.json();
  return normalizarTrackingDHL(guia, data);
}

// Para tracking-auto: misma función para un bulto o varios (DHL ya devuelve las piezas).
const getPaquetesEnvioDHL = getTrackingDHL;

module.exports = { getTrackingDHL, getPaquetesEnvioDHL, normalizarTrackingDHL, semaforoDeEstadoDHL, hayCredenciales, DHL_GUIA_REGEX, baseUrl };
