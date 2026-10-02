// Profit y porcentaje derivados AL VUELO desde el desglose congelado (Parte A)
// y total_cobrado, para que nunca queden desfasados si se edita el precio.
// Fuente ÚNICA de verdad del profit por envío: lo usa la vista Salidas para pintar
// cada fila y el Dashboard para agregar la utilidad por cliente/período. Debe
// coincidir al centavo entre ambas.
//
// Precedencia del profit (de arriba hacia abajo; la primera que aplica gana):
//   1. COSTO REAL (rama nueva, Etapa 3): si el envío tiene estado_revision =
//      'revisado_ok' y costo_facturado != null, la utilidad se calcula contra lo que
//      REALMENTE pagamos a UPS → profit = venta − costo_facturado, y se marca
//      profit_real = true. Esta rama gana sobre la foto congelada de la liquidación
//      (esa precedencia la aplica el dashboard mirando profit_real; ver utilidadEnvio).
//      SOLO 'revisado_ok' dispara esto: 'pendiente'/'a_revisar'/'reclamar' siguen con
//      la estimación (si la guía está en reclamo sostenemos que nuestro número es el
//      correcto, sería absurdo calcular la utilidad con el número que estamos peleando).
//   2/3. COSTO ESTIMADO (comportamiento histórico, profit_real = false):
//      costo      = flete - descuento + seguro + fuel + derechos + adicionales + otros
//      profit     = total_cobrado - costo
//      porcentaje = profit / costo * 100   (margen sobre el costo)
// Si el costo es 0 o no hay total_cobrado, no se calcula: se devuelve lo que
// tenga la columna en la DB (envíos viejos importados, o envíos cuyos costos viven
// en liquidacion_items y no en envios) o vacío.
// Espera row.total = total_cobrado (alias del SELECT) y las columnas de costo planas.
// Opcionales para la rama nueva: row.estado_revision, row.costo_facturado y
// row.venta_liq (SUM de liquidacion_items.total_usd de la liquidación confirmada).
// Costo ESTIMADO por nosotros a partir del desglose congelado. Es la fórmula que
// usa la rama estimada de deriveProfit; se expone aparte para que el Dashboard pueda
// pedir el costo estimado de CUALQUIER envío (incluso uno 'revisado_ok', donde
// deriveProfit devuelve el costo real y no el estimado) sin re-tipear la fórmula y
// arriesgar que quede desalineada con la utilidad. Fuente única de la estimación.
function costoEstimado(row) {
  return (row.flete || 0) - (row.descuento || 0) + (row.seguro || 0)
    + (row.fuel || 0) + (row.derechos || 0) + (row.adicionales || 0) + (row.otros || 0)
    + cargosPost(row);
}

// ── Cargos posteriores (01/10/2026) ────────────────────────────────────────────────
// Los extracargos que aparecen DESPUÉS de cargado el envío (manejo, sobrepeso, impuestos
// DDP…, tabla envio_cargos) son plata del envío al que pertenecen, se cobren en su propia
// liquidación o en la siguiente del cliente. Van al costo, sin profit: suman lo mismo a la
// venta y a la compra del envío, y la utilidad no cambia. Antes (25/09) solo existían en la
// liquidación y el envío no los reflejaba en Salidas ni en el Dashboard.
// Espera row.cargos_post (SUM de los no anulados) y row.cargos_ddp (los de origen
// impuestos_ddp), que salen de SUBQUERY_CARGOS.
function cargosPost(row) { return Number(row.cargos_post) || 0; }
function cargosDdp(row) { return Number(row.cargos_ddp) || 0; }

// Venta COMPLETA del envío: lo cobrado (congelado en la liquidación si la hay) + cargos
// posteriores. Es la que muestran Salidas (Venta Total) y el Dashboard (Venta).
function ventaEnvio(row) {
  const base = row.venta_liq != null ? Number(row.venta_liq) : (Number(row.total) || 0);
  return Math.round((base + cargosPost(row)) * 100) / 100;
}
// Compra COMPLETA del envío: la real aprobada (factura del courier + los impuestos DDP,
// que UPS factura aparte) o la estimada (que ya incluye los cargos).
function compraEnvio(row) {
  if (row.estado_revision === 'revisado_ok' && row.costo_facturado != null) {
    return Math.round((Number(row.costo_facturado) + cargosDdp(row)) * 100) / 100;
  }
  return costoEstimado(row);
}

function deriveProfit(row) {
  // RAMA NUEVA (Etapa 3): costo real de la factura UPS ya aprobada. costo_facturado 0
  // es un valor válido (se pagó 0) → se habilita con != null, no con truthiness.
  if (row.estado_revision === 'revisado_ok' && row.costo_facturado != null) {
    // Venta CORRECTA = lo que realmente se le cobró al cliente. Si el envío está
    // liquidado, la liquidación pudo sumar un adicional manual encima de total_cobrado
    // y esa venta completa quedó congelada en liquidacion_items.total_usd (row.venta_liq).
    // Sin liquidación (o sin ese dato) se usa total_cobrado. Solo se LEE la liquidación:
    // no se toca ningún monto.
    // + los cargos posteriores que el courier factura con el flete (todos menos los
    // impuestos DDP, que vienen en otra factura y no están en costo_facturado).
    const ventaBase = row.venta_liq != null ? row.venta_liq : row.total;
    const venta = ventaBase != null ? ventaBase + cargosPost(row) - cargosDdp(row) : null;
    if (venta != null) {
      const costoReal = row.costo_facturado;
      const profit = Math.round((venta - costoReal) * 100) / 100;
      // costo real 0 → margen indefinido (no dividir por cero); se deja null.
      const porcentaje = costoReal !== 0 ? Math.round((profit / costoReal) * 10000) / 100 : null;
      return { compra_total: costoReal, profit, porcentaje, profit_real: true };
    }
    // Aprobada pero sin venta cargada: no se puede calcular el real → cae a la estimación.
  }

  // RAMA ESTIMADA (histórica, sin cambios de número): costo derivado del desglose.
  const costo = costoEstimado(row);
  if (costo === 0 || row.total == null || row.total === 0) {
    return { compra_total: costo, profit: row.profit ?? null, porcentaje: row.porcentaje ?? null, profit_real: false };
  }
  // La venta estimada también lleva los cargos posteriores (al costo: se anulan con los
  // que ya están dentro de `costo` y la utilidad queda igual que sin ellos).
  const profit = Math.round((row.total + cargosPost(row) - costo) * 100) / 100;
  const porcentaje = Math.round((profit / costo) * 10000) / 100;
  return { compra_total: costo, profit, porcentaje, profit_real: false };
}

// LA DOBLE VISTA (31/08, pedido de la oficina): los DOS profits a la vez, siempre.
//
// deriveProfit devuelve UN solo número que cambia de fórmula cuando la revisión se
// aprueba — y ese cambio silencioso fue lo que confundió a la oficina ("me sobrescribió
// el profit"). Esto devuelve los dos por separado, para que la pantalla los muestre
// lado a lado y ninguno pise al otro:
//   - profit_estimado / porcentaje_estimado / compra_estimada: SIEMPRE la estimación
//     nuestra (venta − compra estimada del desglose congelado), sin importar el estado
//     de revisión. Es deriveProfit con la rama real enmascarada.
//   - profit_real_monto / porcentaje_real: venta − costo_facturado, disponible desde el
//     momento en que la factura del courier se cruza (no espera el tilde de revisión:
//     es informativo). null si no hay factura o no hay venta.
// La venta de la rama real es la misma que usa deriveProfit: la congelada de la
// liquidación si existe (venta_liq), si no total_cobrado.
// deriveProfit NO cambia: el Dashboard y las alertas siguen agregando con su
// precedencia de siempre (real aprobado > liquidación > estimado).
function profitDoble(row) {
  const est = deriveProfit({ ...row, estado_revision: null });
  const out = {
    compra_estimada: est.compra_total,
    profit_estimado: est.profit,
    porcentaje_estimado: est.porcentaje,
    profit_real_monto: null,
    porcentaje_real: null,
  };
  if (row.costo_facturado != null) {
    const ventaBase = row.venta_liq != null ? row.venta_liq : row.total;
    const venta = ventaBase != null ? ventaBase + cargosPost(row) - cargosDdp(row) : null;
    if (venta != null) {
      out.profit_real_monto = Math.round((venta - row.costo_facturado) * 100) / 100;
      out.porcentaje_real = row.costo_facturado !== 0
        ? Math.round((out.profit_real_monto / row.costo_facturado) * 10000) / 100
        : null;
    }
  }
  return out;
}

// Utilidad de UN envío para agregar (Dashboard y Comisiones usan ESTA función, así los
// dos coinciden al centavo). Precedencia: costo real aprobado → liquidación confirmada →
// estimación. Si nada se puede calcular, 0 (no null) para no romper la suma.
// Espera row.total, row.utilidad_liq (SUM liquidacion_items.utilidad_usd de la liq.
// confirmada) y las columnas que pide deriveProfit.
function utilidadEnvio(row) {
  const { profit, profit_real } = deriveProfit(row);
  if (profit_real) return profit;
  if (row.utilidad_liq != null) return row.utilidad_liq;
  return profit == null ? 0 : profit;
}

// Venta y utilidad de la LIQUIDACIÓN CONFIRMADA de cada envío, como subconsulta lista para
// un LEFT JOIN (alias de columnas: envio_id, utilidad_usd, venta_liq). Fuente única desde
// el 29/09/2026 para Salidas, Dashboard, Comisiones, Analítica y el perfil del cliente.
// venta_liq es la venta PROPIA del envío: total_usd del ítem MENOS los cargos posteriores
// que entraron en ese ítem (01/10: todos, no solo los impuestos DDP), porque los cargos se
// suman aparte con SUBQUERY_CARGOS, estén en esta liquidación o en la siguiente del cliente.
const SUBQUERY_LIQUIDACION = `
  SELECT li.envio_id,
         SUM(li.utilidad_usd) AS utilidad_usd,
         SUM(li.total_usd) - COALESCE(SUM((SELECT SUM(ec.monto) FROM envio_cargos ec
                                           WHERE ec.envio_id = li.envio_id
                                             AND ec.anulado_at IS NULL AND ec.liquidacion_id = li.liquidacion_id)), 0) AS venta_liq
  FROM liquidacion_items li
  WHERE li.liquidacion_id IN (SELECT id FROM liquidaciones WHERE estado = 'confirmada')
  GROUP BY li.envio_id`;

// Cargos posteriores vigentes (no anulados) por envío, para el mismo LEFT JOIN (alias:
// envio_id, cargos_post, cargos_ddp). Se suman a la venta y a la compra del envío.
const SUBQUERY_CARGOS = `
  SELECT ec.envio_id,
         SUM(ec.monto) AS cargos_post,
         SUM(CASE WHEN ec.origen = 'impuestos_ddp' THEN ec.monto ELSE 0 END) AS cargos_ddp
  FROM envio_cargos ec
  WHERE ec.anulado_at IS NULL
  GROUP BY ec.envio_id`;
// Los dos JOIN juntos y las columnas que aportan, para no repetirlos en cada consulta.
const JOIN_LIQ_Y_CARGOS = `
  LEFT JOIN (${SUBQUERY_LIQUIDACION}) li ON li.envio_id = e.id
  LEFT JOIN (${SUBQUERY_CARGOS}) cp ON cp.envio_id = e.id`;
const COLS_LIQ_Y_CARGOS = `li.utilidad_usd AS utilidad_liq, li.venta_liq AS venta_liq, cp.cargos_post AS cargos_post, cp.cargos_ddp AS cargos_ddp`;

module.exports = {
  SUBQUERY_LIQUIDACION, SUBQUERY_CARGOS, JOIN_LIQ_Y_CARGOS, COLS_LIQ_Y_CARGOS,
  deriveProfit, costoEstimado, profitDoble, utilidadEnvio, ventaEnvio, compraEnvio, cargosPost, cargosDdp };
