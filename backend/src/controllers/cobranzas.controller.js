// Módulo Cobranzas — cuenta corriente por cliente (etapa 1: consultas + comprobantes
// manuales + tipo de cambio). Recibos, imputación y cheques llegan en la etapa 2.
const cc = require('../models/cuenta-corriente.model');
const recibos = require('../models/recibos.model');
const entrantes = require('../models/entrantes.model');
const mp = require('../services/mercadopago.service');
const { getDb } = require('../db');

function esFecha(f) {
  if (typeof f !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const d = new Date(`${f}T00:00:00`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10);
}

// GET /api/cobranzas/saldos?libro=CF|SF&todos=1&tipo_cobro=CC
async function saldos(req, res, next) {
  try {
    const { libro, todos, tipo_cobro } = req.query;
    if (libro && !cc.LIBROS.includes(libro)) return res.status(400).json({ error: 'libro debe ser CF o SF' });
    const rows = await cc.saldosPorCliente({ libro: libro || null, soloConSaldo: todos !== '1', tipo_cobro: tipo_cobro || null });
    const total = rows.reduce((a, r) => ({
      saldo_cf: a.saldo_cf + r.saldo_cf, saldo_sf: a.saldo_sf + r.saldo_sf,
      a_favor_cf: a.a_favor_cf + r.a_favor_cf, a_favor_sf: a.a_favor_sf + r.a_favor_sf,
    }), { saldo_cf: 0, saldo_sf: 0, a_favor_cf: 0, a_favor_sf: 0 });
    res.json({ clientes: rows, total });
  } catch (e) { next(e); }
}

async function clienteExiste(id) {
  return Boolean(await getDb().prepare('SELECT id FROM clientes WHERE id = ?').get(id));
}

// GET /api/cobranzas/clientes/:id/pendientes
async function pendientes(req, res, next) {
  try {
    if (!(await clienteExiste(req.params.id))) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(await cc.pendientesCliente(req.params.id));
  } catch (e) { next(e); }
}

// GET /api/cobranzas/clientes/:id/historial?libro=&desde=&hasta=&anulados=1
async function historial(req, res, next) {
  try {
    if (!(await clienteExiste(req.params.id))) return res.status(404).json({ error: 'Cliente no encontrado' });
    const { libro, desde, hasta, anulados } = req.query;
    if (libro && !cc.LIBROS.includes(libro)) return res.status(400).json({ error: 'libro debe ser CF o SF' });
    if (desde && !esFecha(desde)) return res.status(400).json({ error: 'desde inválida' });
    if (hasta && !esFecha(hasta)) return res.status(400).json({ error: 'hasta inválida' });
    res.json({ movimientos: await cc.historialCliente(req.params.id, { libro: libro || null, desde: desde || null, hasta: hasta || null, incluirAnulados: anulados === '1' }) });
  } catch (e) { next(e); }
}

// POST /api/cobranzas/comprobantes — carga manual de FA / ND / NC / AC.
async function crearComprobante(req, res, next) {
  try {
    const b = req.body || {};
    if (!b.cliente_id || !(await clienteExiste(b.cliente_id))) return res.status(400).json({ error: 'cliente_id inválido' });
    if (!cc.LIBROS.includes(b.libro)) return res.status(400).json({ error: 'libro debe ser CF o SF' });
    if (!['FA', 'ND', 'NC', 'AC'].includes(b.tipo)) return res.status(400).json({ error: 'tipo debe ser FA, ND, NC o AC' });
    if (!esFecha(b.fecha)) return res.status(400).json({ error: 'fecha inválida (YYYY-MM-DD)' });
    const importe = Number(b.importe);
    if (!(importe > 0)) return res.status(400).json({ error: 'importe debe ser mayor a 0' });
    if (b.moneda && !['ARS', 'USD'].includes(b.moneda)) return res.status(400).json({ error: 'moneda debe ser ARS o USD' });
    if (b.referencia_id) {
      const ref = await cc.obtenerComprobante(b.referencia_id);
      if (!ref || Number(ref.cliente_id) !== Number(b.cliente_id)) return res.status(400).json({ error: 'referencia_id no es un comprobante de este cliente' });
    }
    const id = await cc.crearComprobante({
      cliente_id: Number(b.cliente_id), libro: b.libro, tipo: b.tipo, letra: b.letra || null,
      punto_venta: b.punto_venta || null, numero: b.numero || null, fecha: b.fecha,
      moneda: b.moneda || null, importe, referencia_id: b.referencia_id ? Number(b.referencia_id) : null,
      descripcion: b.descripcion || null, usuario: req.usuario ? req.usuario.usuario : null,
      razon_social_id: Number(b.razon_social_id) || null,
    });
    res.status(201).json(await cc.obtenerComprobante(id));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
}

// GET /api/cobranzas/tipo-cambio · POST /api/cobranzas/tipo-cambio
async function listarTC(req, res, next) {
  try { res.json({ cotizaciones: await cc.listarTipoCambio() }); } catch (e) { next(e); }
}
async function guardarTC(req, res, next) {
  try {
    const { fecha, compra, venta, promedio, fuente } = req.body || {};
    if (!esFecha(fecha)) return res.status(400).json({ error: 'fecha inválida' });
    const v = venta == null ? null : Number(venta);
    const c = compra == null ? null : Number(compra);
    const p = promedio == null ? null : Number(promedio);
    if (v == null || !(v > 0)) return res.status(400).json({ error: 'venta es obligatoria y mayor a 0' });
    res.json(await cc.guardarTipoCambio({ fecha, compra: c, venta: v, promedio: p, fuente: fuente || 'manual' }));
  } catch (e) { next(e); }
}

// ── Pagos (entrega 3) ────────────────────────────────────────────────────────────
const conError = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
};

// POST /api/cobranzas/pagos — multipart: campo `datos` (JSON) + un archivo por valor.
const cargarPago = conError(async (req, res) => {
  let datos;
  try { datos = JSON.parse(req.body && req.body.datos ? req.body.datos : '{}'); } catch (e) { return res.status(400).json({ error: 'datos inválidos' }); }
  const archivos = {};
  for (const f of req.files || []) archivos[f.fieldname] = f;
  const id = await recibos.cargarPago(datos, archivos, req.usuario);
  res.status(201).json(await recibos.obtenerRecibo(id));
});

const bandejaPagos = conError(async (req, res) => { res.json({ pagos: await recibos.bandeja() }); });

const obtenerPago = conError(async (req, res) => {
  const r = await recibos.obtenerRecibo(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Pago inexistente' });
  res.json(r);
});

const confirmarPago = conError(async (req, res) => { res.json(await recibos.confirmarPago(Number(req.params.id), req.usuario)); });

const eliminarPago = conError(async (req, res) => {
  res.json(await recibos.eliminarPago(Number(req.params.id), (req.body || {}).motivo, req.usuario));
});

const pagosCliente = conError(async (req, res) => {
  res.json({ pagos: await recibos.pagosCliente(Number(req.params.id), { incluirEliminados: req.query.eliminados === '1' }) });
});

// GET /api/cobranzas/adjuntos/:valorId — el comprobante, solo con sesión.
const adjunto = conError(async (req, res) => {
  const ruta = await recibos.adjuntoDeValor(Number(req.params.valorId));
  if (!ruta) return res.status(404).json({ error: 'Sin comprobante' });
  res.sendFile(ruta, { headers: { 'Cache-Control': 'private, max-age=3600' } });
});

// ── Pagos que entraron solos ─────────────────────────────────────────────────────
const ESTADOS_ENTRANTE = ['nuevo', 'revisado', 'descartado'];
const listarEntrantes = conError(async (req, res) => {
  const estado = ESTADOS_ENTRANTE.includes(req.query.estado) ? req.query.estado : 'nuevo';
  res.json({ entrantes: await entrantes.listar({ estado }), mercadopago: await mp.estado() });
});
const sincronizarEntrantes = conError(async (req, res) => {
  if (!mp.configurado()) return res.status(409).json({ error: 'Mercado Pago todavía no está conectado (falta el token en el servidor)' });
  try {
    res.json(await mp.sincronizar({ dias: Math.min(60, Number(req.body && req.body.dias) || 7) }));
  } catch (e) {
    await mp.registrarError(e.message);
    throw e;
  }
});
const sugerenciaEntrante = conError(async (req, res) => { res.json(await entrantes.sugerencia(Number(req.params.id))); });
const clienteEntrante = conError(async (req, res) => {
  res.json(await entrantes.asignarCliente(Number(req.params.id), Number((req.body || {}).cliente_id)));
});
const descartarEntrante = conError(async (req, res) => {
  res.json(await entrantes.descartar(Number(req.params.id), (req.body || {}).motivo, req.usuario));
});
const reabrirEntrante = conError(async (req, res) => { res.json(await entrantes.reabrir(Number(req.params.id))); });

module.exports = {
  saldos, pendientes, historial, crearComprobante, listarTC, guardarTC,
  cargarPago, bandejaPagos, obtenerPago, confirmarPago, eliminarPago, pagosCliente, adjunto,
  listarEntrantes, sincronizarEntrantes, sugerenciaEntrante, clienteEntrante, descartarEntrante, reabrirEntrante,
};
