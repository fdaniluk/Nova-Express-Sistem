const RECOLECTORES = ['Juanqui', 'Felipe', 'Ricardo', 'Marcelo'];
// 'cobranza': el chofer va sólo a buscar plata. Comparte la cadena de chofer del
// tipo 'normal' (derivarEstado no lo trata especial); su particularidad es que la
// plata se carga aparte con el botón "Cargar cobranza" (módulo Cobranzas).
// 'ninguna': no hay recolección — el caso típico es una IMPORTACIÓN, que nadie pasa a
// buscar, pero que operaciones necesita en su módulo para seguir los checks (datos,
// guía, proforma, despachado). Se crea DESDE Operaciones y NUNCA aparece en la pantalla
// de Pickups (el GET de pickups la excluye).
const TIPOS_RECOLECCION = ['normal', 'cliente', 'courier', 'cobranza', 'ninguna'];
// Entrega de una importación (04/09, pedido de Felipe): la caja YA está en el depósito y
// hay que llevarla a lo del cliente en Buenos Aires. Es la otra punta de 'ninguna': aquella
// es la impo vista desde Operaciones antes de que llegue; ésta es la salida del depósito.
// Comparte la cadena de chofer del 'normal' (Ricardo → visto → en camioneta), pero el
// último paso es 'entregado' en vez de 'en_deposito', NUNCA aparece en Operaciones y
// no toca el estado_operativo de ningún envío. Se marca con pickups.entrega_impo = 1.
// Solo tiene sentido con tipo 'normal' (la lleva el chofer) o 'cliente' (la retira él).
const TIPOS_ENTREGA = ['normal', 'cliente'];

function derivarEstado(confirmado_juanqui, en_deposito_at, tipo_recoleccion = 'normal', entrega_impo = 0) {
  // 'courier': lo levanta UPS/DHL. Estado terminal, sin cadena ni confirmaciones.
  if (tipo_recoleccion === 'courier') return 'courier';
  // 'ninguna': no hay recolección (impo). Terminal, igual que courier.
  if (tipo_recoleccion === 'ninguna') return 'sin_recoleccion';
  if (en_deposito_at) return entrega_impo ? 'entregado' : 'en_deposito';
  // 'cliente': lo trae el cliente. Sin cadena de chofer (ricardo/visto/juanqui);
  // solo el paso de depósito lo saca de 'pendiente'.
  if (tipo_recoleccion === 'cliente') return 'pendiente';
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

  const { confirmar_ricardo, confirmar_juanqui, confirmar_deposito, confirmar_visto, recolector } = body;
  const updates = {};

  const tipo = current.tipo_recoleccion || 'normal';
  const esEntrega = !!current.entrega_impo;

  // 'courier' es terminal: no admite ninguna confirmación (no tiene botones).
  if (tipo === 'courier') {
    const err = new Error('Pickup tipo courier no admite confirmaciones');
    err.status = 400;
    throw err;
  }

  // 'cliente' solo admite el paso de depósito (reversible); no entra en la cadena de chofer.
  if (tipo === 'cliente' &&
      (confirmar_ricardo !== undefined || confirmar_visto !== undefined || confirmar_juanqui !== undefined)) {
    const err = new Error('Pickup tipo cliente solo admite el paso de depósito');
    err.status = 400;
    throw err;
  }

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
      updates.visto_juanqui_at   = null;
      updates.confirmado_juanqui = null;
      updates.en_deposito_at = null;
      updates.recolector = null;
    }
  }

  if (confirmar_visto !== undefined) {
    if (confirmar_visto) {
      const ricardoActual = 'confirmado_ricardo' in updates ? updates.confirmado_ricardo : current.confirmado_ricardo;
      if (!ricardoActual) {
        const err = new Error('No se puede marcar como visto sin confirmación de Ricardo');
        err.status = 400;
        throw err;
      }
      updates.visto_juanqui_at = await getTimestamp(db);
    } else {
      // Deshacer visto limpia también los pasos posteriores
      updates.visto_juanqui_at   = null;
      updates.confirmado_juanqui = null;
      updates.en_deposito_at     = null;
    }
  }

  if (confirmar_juanqui !== undefined) {
    if (confirmar_juanqui) {
      updates.confirmado_juanqui = await getTimestamp(db);
      // Autocompletar visto si todavía no fue marcado
      const vistoActual = 'visto_juanqui_at' in updates ? updates.visto_juanqui_at : current.visto_juanqui_at;
      if (!vistoActual) {
        updates.visto_juanqui_at = updates.confirmado_juanqui;
      }
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
  updates.estado = derivarEstado(nextJuanqui, nextDeposito, tipo, esEntrega ? 1 : 0);

  const wasDeposito  = !!current.en_deposito_at;
  const willDeposito = !!nextDeposito;

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await db.prepare(`UPDATE pickups SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), id);

  // Side-effect sobre envios: solo cambia cuando el estado de depósito cambia.
  // Para tipo 'cliente' puede no haber envío nuestro asociado: el UPDATE matchea por
  // cliente_id+fecha y, si no hay filas, afecta 0 sin fallar. (courier no llega acá.)
  // Una ENTREGA de importación no lo hace nunca: el último paso es "entregado al
  // cliente", no "llegó al depósito", y marcaría en_deposito a una exportación del
  // mismo cliente cargada ese día.
  if (esEntrega) {
    // nada que tocar en envios
  } else if (!wasDeposito && willDeposito) {
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

module.exports = { RECOLECTORES, TIPOS_RECOLECCION, TIPOS_ENTREGA, derivarEstado, procesarConfirmacion };
