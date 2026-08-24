/**
 * cotizador-link.model.js — los links de cotización que se le dan a un cliente.
 *
 * Es la PRIMERA puerta sin contraseña del sistema, así que este modelo es el que
 * sostiene las reglas de seguridad (el porqué largo está en schema.sql):
 *   · el código es un token aleatorio de 128 bits — no hay nada adivinable;
 *   · `validarParaUso` es el ÚNICO camino por el que una consulta pública llega a un
 *     link: chequea activo + vencimiento + tope diario en un solo lugar;
 *   · el tope es POR DÍA y POR LINK: corta un abuso (o un bot) sin molestar a la señora
 *     de las diez cotizaciones.
 */
const crypto = require('crypto');
const { getDb } = require('../db');

const COURIERS = ['ambos', 'dhl', 'ups', 'ups_exp', 'ups_sav'];

/* Tope de consultas por día por link. 100 cotizaciones en un día es muchísimo para una
   persona y nada para un scraper: si un cliente de verdad lo alcanza, que llame. */
const TOPE_DIARIO = 100;

function hoy() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Los servicios del motor que ofrece un link según su campo `couriers`. */
function serviciosDe(couriers) {
  switch (couriers) {
    case 'dhl': return ['DHL'];
    case 'ups': return ['UPS_EXP', 'UPS_SAV'];
    case 'ups_exp': return ['UPS_EXP'];
    case 'ups_sav': return ['UPS_SAV'];
    default: return ['DHL', 'UPS_EXP', 'UPS_SAV'];
  }
}

async function crear({ cliente_id, nombre, couriers, profit_pct, dias, nombrar }, usuario) {
  const db = getDb();
  const codigo = crypto.randomBytes(16).toString('hex');
  const d = new Date();
  d.setDate(d.getDate() + (Number(dias) > 0 ? Number(dias) : 30));
  const p = (n) => String(n).padStart(2, '0');
  const vence = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const res = await db
    .prepare(
      `INSERT INTO cotizador_links
         (codigo, cliente_id, nombre, couriers, nombrar, profit_pct, vence_en, usuario_id, usuario)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      codigo,
      cliente_id ?? null,
      nombre ?? null,
      COURIERS.includes(couriers) ? couriers : 'ambos',
      nombrar === false || nombrar === 0 ? 0 : 1,
      profit_pct ?? null,
      vence,
      (usuario && usuario.id) || null,
      (usuario && usuario.usuario) || null
    );
  return obtener(res.lastInsertRowid);
}

async function obtener(id) {
  return getDb().prepare('SELECT * FROM cotizador_links WHERE id = ?').get(id);
}

async function listarDeCliente(clienteId) {
  return getDb()
    .prepare('SELECT * FROM cotizador_links WHERE cliente_id = ? ORDER BY creado_en DESC')
    .all(clienteId);
}

async function darDeBaja(id) {
  const res = await getDb()
    .prepare(`UPDATE cotizador_links
                 SET activo = 0, baja_en = datetime('now','localtime')
               WHERE id = ? AND activo = 1`)
    .run(id);
  return (res.changes ?? 0) > 0;
}

/**
 * El único camino de una consulta pública a un link. Devuelve:
 *   { ok: true, link }                     — se puede usar
 *   { ok: false, motivo: 'no-existe' }     — código desconocido (404)
 *   { ok: false, motivo: 'dado-de-baja' }  — la oficina lo apagó (410)
 *   { ok: false, motivo: 'vencido' }       — pasó su fecha (410)
 *   { ok: false, motivo: 'tope' }          — tope diario alcanzado (429)
 */
async function validarParaUso(codigo) {
  const db = getDb();
  const link = await db.prepare('SELECT * FROM cotizador_links WHERE codigo = ?').get(codigo);
  if (!link) return { ok: false, motivo: 'no-existe' };
  if (!link.activo) return { ok: false, motivo: 'dado-de-baja' };
  if (link.vence_en < hoy()) return { ok: false, motivo: 'vencido' };
  const consultasHoy = link.dia_consultas === hoy() ? link.consultas_hoy : 0;
  if (consultasHoy >= TOPE_DIARIO) return { ok: false, motivo: 'tope' };
  return { ok: true, link };
}

/** Suma una consulta a los contadores (total e "hoy"). Se llama al COTIZAR, no al abrir. */
async function registrarConsulta(id) {
  await getDb()
    .prepare(
      `UPDATE cotizador_links
          SET consultas = consultas + 1,
              consultas_hoy = CASE WHEN dia_consultas = ? THEN consultas_hoy + 1 ELSE 1 END,
              dia_consultas = ?
        WHERE id = ?`
    )
    .run(hoy(), hoy(), id);
}

module.exports = {
  COURIERS, TOPE_DIARIO, serviciosDe,
  crear, obtener, listarDeCliente, darDeBaja, validarParaUso, registrarConsulta,
};
