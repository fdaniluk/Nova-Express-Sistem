const RECOLECTORES = ['Juanqui', 'Felipe', 'Ricardo', 'Marcelo'];

function derivarEstado(confirmado_juanqui, en_deposito_at) {
  if (en_deposito_at) return 'en_deposito';
  if (confirmado_juanqui) return 'en_camioneta';
  return 'pendiente';
}

async function getTimestamp(db) {
  const row = await db.prepare("SELECT datetime('now','localtime') AS ts").get();
  return row.ts;
}

/**
 * Procesa confirmar_ricardo / confirmar_juanqui / confirmar_deposito con regla de cadena.
 * @returns {object} pickup actualizado, o null si no existe.
 * @throws {Error} con .status = 400 para errores de validación.
 */
async function procesarConfirmacion(db, id, body) {
  const current = await db.prepare('SELECT * FROM pickups WHERE id = ?').get(id);
  if (!current) return null;

  const { confirmar_ricardo, confirmar_juanqui, confirmar_deposito, recolector } = body;
  const updates = {};

  if (confirmar_ricardo !== undefined) {
    if (confirmar_ricardo) {
      updates.confirmado_ricardo = await getTimestamp(db);
      if (recolector !== undefined) {
        if (!RECOLECTORES.includes(recolector)) {
          const err = new Error(`Recolector inválido. Valores permitidos: ${RECOLECTORES.join(', ')}`);
          err.status = 400;
          throw err;
        }
        updates.recolector = recolector;
      }
    } else {
      // Desconfirmar Ricardo limpia toda la cadena
      updates.confirmado_ricardo = null;
      updates.confirmado_juanqui = null;
      updates.en_deposito_at = null;
      updates.recolector = null;
    }
  }

  if (confirmar_juanqui !== undefined) {
    if (confirmar_juanqui) {
      updates.confirmado_juanqui = await getTimestamp(db);
    } else {
      // Desconfirmar Juanqui limpia también depósito
      updates.confirmado_juanqui = null;
      updates.en_deposito_at = null;
    }
  }

  if (confirmar_deposito !== undefined) {
    if (confirmar_deposito) {
      updates.en_deposito_at = await getTimestamp(db);
    } else {
      updates.en_deposito_at = null;
    }
  }

  if (Object.keys(updates).length === 0) {
    const err = new Error('No hay campos para actualizar');
    err.status = 400;
    throw err;
  }

  // Estado resultante derivado de timestamps
  const nextJuanqui  = 'confirmado_juanqui' in updates ? updates.confirmado_juanqui : current.confirmado_juanqui;
  const nextDeposito = 'en_deposito_at'     in updates ? updates.en_deposito_at     : current.en_deposito_at;
  updates.estado = derivarEstado(nextJuanqui, nextDeposito);

  const wasDeposito  = !!current.en_deposito_at;
  const willDeposito = !!nextDeposito;

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await db.prepare(`UPDATE pickups SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), id);

  // Side-effect sobre envios: solo cambia cuando el estado de depósito cambia
  if (!wasDeposito && willDeposito) {
    await db.prepare(
      `UPDATE envios SET estado_operativo = 'en_deposito'
       WHERE cliente_id = ? AND fecha = ? AND estado_operativo = 'pendiente'`
    ).run(current.cliente_id, current.fecha);
  } else if (wasDeposito && !willDeposito) {
    await db.prepare(
      `UPDATE envios SET estado_operativo = 'pendiente'
       WHERE cliente_id = ? AND fecha = ? AND estado_operativo = 'en_deposito'`
    ).run(current.cliente_id, current.fecha);
  }

  return db.prepare('SELECT * FROM pickups WHERE id = ?').get(id);
}

module.exports = { RECOLECTORES, derivarEstado, procesarConfirmacion };
