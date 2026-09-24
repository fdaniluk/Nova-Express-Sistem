// Mercado Pago → pagos_entrantes (24/09/2026). SOLO LECTURA: consulta los cobros que
// entraron a la cuenta de Nova; no crea pagos, no transfiere, no toca nada en MP.
//
// Credencial: MP_ACCESS_TOKEN en el .env del VPS (Access Token de PRODUCCIÓN de una
// aplicación creada con la cuenta de Nova en mercadopago.com.ar/developers). Sin token,
// todo esto queda apagado y la pantalla lo dice.
//
// Cómo decide qué es "plata que entró": pagos aprobados donde Nova es el que COBRA
// (collector_id = el usuario dueño del token). Lo que Nova paga a otros queda afuera.
// Cada cobro se guarda con su id de MP: aunque se consulte diez veces, entra una sola.
const { getDb } = require('../db');

const API = 'https://api.mercadopago.com';
const token = () => (process.env.MP_ACCESS_TOKEN || '').trim();
const configurado = () => Boolean(token());

async function llamar(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token()}` } });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Mercado Pago: ${msg}`), { status: res.status === 401 ? 502 : 502 });
  }
  return data;
}

let miId = null;
async function usuarioMp() {
  if (!miId) {
    const me = await llamar('/users/me');
    miId = me && me.id;
  }
  return miId;
}

const soloDigitos = (s) => String(s || '').replace(/\D/g, '');

// Fecha local AAAA-MM-DD del cobro (MP devuelve ISO con zona).
function fechaLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '').slice(0, 10);
  return d.toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
}

// Pasa un "payment" de MP a una fila de pagos_entrantes (o null si no es plata que entró).
function aEntrante(p, collectorId) {
  if (!p || p.status !== 'approved') return null;
  if (collectorId && p.collector_id && Number(p.collector_id) !== Number(collectorId)) return null;
  const importe = Number(p.transaction_amount);
  if (!(importe > 0)) return null;
  const payer = p.payer || {};
  const ident = payer.identification || {};
  const nombre = [payer.first_name, payer.last_name].filter(Boolean).join(' ').trim()
    || (p.point_of_interaction && p.point_of_interaction.transaction_data && p.point_of_interaction.transaction_data.bank_info
      && p.point_of_interaction.transaction_data.bank_info.payer && p.point_of_interaction.transaction_data.bank_info.payer.long_name)
    || null;
  return {
    fuente: 'mercadopago',
    id_externo: String(p.id),
    fecha: fechaLocal(p.date_approved || p.date_created),
    importe: Math.round(importe * 100) / 100,
    moneda: p.currency_id === 'USD' ? 'USD' : 'ARS',
    cuit_emisor: soloDigitos(ident.number) || null,
    nombre_emisor: nombre,
    email_emisor: payer.email || null,
    referencia: p.description || p.external_reference || null,
    medio_detalle: [p.operation_type, p.payment_method_id, p.payment_type_id].filter(Boolean).join(' · '),
    crudo: JSON.stringify(p).slice(0, 20000),
  };
}

// Trae los cobros de los últimos `dias` días y guarda los que no estaban.
async function sincronizar({ dias = 3 } = {}) {
  if (!configurado()) return { configurado: false, nuevos: 0, vistos: 0 };
  const db = getDb();
  const collector = await usuarioMp();
  const desde = new Date(Date.now() - dias * 86400000).toISOString();
  const hasta = new Date().toISOString();
  let offset = 0;
  let vistos = 0;
  let nuevos = 0;
  const LIMITE = 100;
  for (let pagina = 0; pagina < 50; pagina++) {
    const q = new URLSearchParams({
      sort: 'date_created', criteria: 'desc', range: 'date_created',
      begin_date: desde, end_date: hasta, limit: String(LIMITE), offset: String(offset),
    });
    const data = await llamar(`/v1/payments/search?${q}`);
    const resultados = (data && data.results) || [];
    for (const p of resultados) {
      vistos++;
      const e = aEntrante(p, collector);
      if (!e) continue;
      const r = await db.prepare(
        `INSERT OR IGNORE INTO pagos_entrantes (fuente, id_externo, fecha, importe, moneda, cuit_emisor, nombre_emisor,
           email_emisor, referencia, medio_detalle, crudo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(e.fuente, e.id_externo, e.fecha, e.importe, e.moneda, e.cuit_emisor, e.nombre_emisor,
        e.email_emisor, e.referencia, e.medio_detalle, e.crudo);
      if (r.changes) nuevos++;
    }
    const total = data && data.paging ? Number(data.paging.total) : resultados.length;
    offset += LIMITE;
    if (!resultados.length || offset >= total) break;
  }
  const ahora = new Date().toLocaleString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
  await db.prepare(
    `INSERT INTO integraciones_estado (clave, valor, actualizado_at) VALUES ('mercadopago_ultima', ?, ?)
     ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_at = excluded.actualizado_at`
  ).run(JSON.stringify({ nuevos, vistos, ok: true }), ahora);
  return { configurado: true, nuevos, vistos, at: ahora };
}

async function estado() {
  const row = await getDb().prepare("SELECT valor, actualizado_at FROM integraciones_estado WHERE clave = 'mercadopago_ultima'").get();
  return { configurado: configurado(), ultima: row ? { ...JSON.parse(row.valor || '{}'), at: row.actualizado_at } : null };
}

async function registrarError(msg) {
  const ahora = new Date().toLocaleString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
  await getDb().prepare(
    `INSERT INTO integraciones_estado (clave, valor, actualizado_at) VALUES ('mercadopago_ultima', ?, ?)
     ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_at = excluded.actualizado_at`
  ).run(JSON.stringify({ ok: false, error: String(msg).slice(0, 300) }), ahora);
}

module.exports = { configurado, sincronizar, estado, registrarError, aEntrante };
