const { getDb } = require('../db');
const configuracionModel = require('./configuracion.model');
const envioModel = require('./envio.model');
const { redondear2, cotizarEnvio } = require('../services/calculos.service');
const { descomponerVenta, detallarAdicional, surgeDe } = require('../utils/desgloseVenta');
const { hoyLocal } = require('../utils/fecha');
const ccModel = require('./cuenta-corriente.model');
const cargosModel = require('./envio-cargos.model');

// Migración automática: agrega columnas nuevas si no existen
// Los renglones del desglose tienen que sumar EXACTAMENTE la columna Adicional. Centavos
// de redondeo se absorben en el renglón más grande; una diferencia mayor va como "Ajuste"
// con signo (es lo que la oficina movió a mano, o lo que cambió el envío después).
function cerrarDetalle(lineas, adicional) {
  const out = (Array.isArray(lineas) ? lineas : []).map((l) => ({ ...l, monto: redondear2(l.monto) }));
  const suma = redondear2(out.reduce((s, l) => s + l.monto, 0));
  const dif = redondear2((Number(adicional) || 0) - suma);
  if (Math.abs(dif) < 0.005) return out;
  if (Math.abs(dif) < 0.05 && out.length) {
    const mayor = out.reduce((a, b) => (b.monto > a.monto ? b : a));
    mayor.monto = redondear2(mayor.monto + dif);
    return out;
  }
  const ajuste = out.find((l) => l.tipo === 'ajuste');
  if (ajuste) ajuste.monto = redondear2(ajuste.monto + dif);
  else out.push({ tipo: 'ajuste', label: 'Ajuste', monto: dif });
  return out.filter((l) => Math.abs(l.monto) >= 0.005);
}

async function migrarColumnas() {
  const db = getDb();
  // Anulación de liquidaciones confirmadas (10/11/2026). La columna `estado` tiene un CHECK
  // ('borrador','confirmada') que SQLite no deja cambiar sin rehacer la tabla, así que la
  // anulada se guarda como estado 'borrador' + anulada_at: todo lo que suma plata filtra por
  // 'confirmada' y la deja afuera sola; lo que mira borradores filtra además anulada_at IS NULL.
  // Hacia afuera (API y pantallas) el estado es 'anulada'.
  const colsLiq = (await db.prepare("PRAGMA table_info(liquidaciones)").all()).map((c) => c.name);
  for (const col of ['anulada_at', 'anulada_por', 'anulada_motivo']) {
    if (!colsLiq.includes(col)) await db.prepare(`ALTER TABLE liquidaciones ADD COLUMN ${col} TEXT`).run();
  }
  const rows = await db.prepare("PRAGMA table_info(liquidacion_items)").all();
  const cols = rows.map(c => c.name);
  if (!cols.includes('precio_cotizado')) {
    await db.prepare("ALTER TABLE liquidacion_items ADD COLUMN precio_cotizado REAL").run();
  }
  if (!cols.includes('profit_pct')) {
    await db.prepare("ALTER TABLE liquidacion_items ADD COLUMN profit_pct REAL").run();
  }
  if (!cols.includes('utilidad_usd')) {
    await db.prepare("ALTER TABLE liquidacion_items ADD COLUMN utilidad_usd REAL").run();
  }
  if (!cols.includes('servicio_cotizado')) {
    await db.prepare("ALTER TABLE liquidacion_items ADD COLUMN servicio_cotizado TEXT").run();
  }
  // Desglose del Adicional CONGELADO al crear (auditoría 05/11/2026): antes se derivaba en
  // vivo del envío al leer la liquidación, e ignoraba la venta ajustada a mano, así que el
  // Excel del cliente podía mostrar una columna (138,70) y renglones que sumaban otra cosa
  // (161,84). Los ítems viejos (NULL) se siguen derivando, pero cerrando contra la columna.
  if (!cols.includes('adicional_detalle_json')) {
    await db.prepare("ALTER TABLE liquidacion_items ADD COLUMN adicional_detalle_json TEXT").run();
  }
  // Otros conceptos (28/10/2026, pedido de Felipe): líneas a mano de la liquidación —
  // concepto + monto— que se le cobran al cliente AL COSTO, sin ganancia, y salen con su
  // nombre en pantalla y en el Excel. El caso: el cliente manda la mercadería por
  // encomienda y Nova la paga; se le suma a la liquidación y queda claro de dónde viene.
  // Son de la liquidación entera (no de un envío): un envío con un cargo propio usa los
  // cargos posteriores de Salidas.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS liquidacion_conceptos (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      liquidacion_id INTEGER NOT NULL REFERENCES liquidaciones(id) ON DELETE CASCADE,
      concepto       TEXT NOT NULL,
      monto          REAL NOT NULL,
      created_at     TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_liquidacion_conceptos_liq ON liquidacion_conceptos(liquidacion_id);
  `);
}

// Normaliza los "otros conceptos" que manda la pantalla: nombre obligatorio, monto > 0.
function normalizarConceptos(lista) {
  if (!Array.isArray(lista)) return [];
  return lista.map((c, i) => {
    const concepto = String((c && c.concepto) || '').trim();
    const monto = redondear2(Number(c && c.monto));
    if (!concepto) { const e = new Error(`Concepto ${i + 1}: escribí el nombre (qué se cobra)`); e.status = 400; throw e; }
    if (!(monto > 0)) { const e = new Error(`"${concepto}": el importe tiene que ser mayor a cero`); e.status = 400; throw e; }
    if (concepto.length > 120) { const e = new Error(`"${concepto.slice(0, 30)}…": el concepto es demasiado largo (máx. 120)`); e.status = 400; throw e; }
    return { concepto, monto };
  });
}
async function conceptosDe(liquidacionId, db = getDb()) {
  const filas = await db.prepare('SELECT id, concepto, monto FROM liquidacion_conceptos WHERE liquidacion_id = ? ORDER BY id').all(liquidacionId);
  return filas.map((f) => ({ id: f.id, concepto: f.concepto, monto: redondear2(f.monto) }));
}

// NOTA: acá vivía descomponerPrecioBase(), que rehacía por su cuenta el GoGreen
// (pf × 0.98) y la composición flete/fuel/seguro de DHL y UPS. Era un SEGUNDO motor:
// si cambiaba una tarifa en cotizador-core.js, esto seguía con el número viejo.
// Ya no lo llamaba nadie (la liquidación lee los valores congelados del envío, no
// recotiza), así que se eliminó. Si alguna vez hay que descomponer un precio, se hace
// con el motor compartido, no con una copia.

// Liquidación = documento de cara al cliente: LEE los valores ya guardados del envío y
// los presenta de forma que el desglose cierre EXACTO en total_cobrado. NO recotiza: no
// llama al motor cotizarEnvio, no usa descomponerPrecioBase, no lee clientes.tarifa_pct,
// no aplica ningún profit. El profit ya está incluido en total_cobrado (lo cargó el dueño)
// y no se expone al cliente.
//
// Detalle del dato: las columnas flete/fuel/seguro/adicionales del envío se congelan en el
// alta con desglosarCosto(profitPct:0) → son el COSTO base y suman MENOS que total_cobrado
// (la diferencia es el profit). Por eso no se pueden leer tal cual para el desglose cliente.
// Criterio (definido por el dueño): seguro y adicionales (cargos itemizados reales) se
// muestran tal cual; flete+fuel balancean el resto para que la suma = total_cobrado.
// `cargosDetalle`: los cargos manuales de esta liquidación para el envío ([{descripcion, monto}]),
// solo para rotular el desglose; el monto que cuenta es `adicional` (la suma).
// `fuelExtra`: diferencias de fuel informadas por el courier (cargos posteriores de tipo
// fuel, 04/11/2026): se suman a la columna FUEL del ítem y al total, no al Adicional.
async function calcularItem(envio, adicional = 0, cargosDetalle = [], fuelExtra = 0) {
  // Fuel% del desglose: si el envío tiene fuel_pct propio (congelado al cargarlo) se usa ESE
  // y NO se lee config (un envío viejo se liquida con el fuel de su época, no con el de hoy).
  // Si es NULL (envíos previos a la columna), se cae al reparto proporcional con el fuel de
  // config, que es la conducta histórica que ya cerraba en total_cobrado.
  let fuelPct;
  if (envio.fuel_pct !== null && envio.fuel_pct !== undefined) {
    fuelPct = envio.fuel_pct;
  } else {
    const fuelCfg = await configuracionModel.obtenerFuel(envio.courier);
    fuelPct = fuelCfg?.fuel_pct ?? 0;
  }

  // Adicional manual de la fila (input ADICIONAL USD): EXTRA que el dueño agrega a mano en
  // esta liquidación, encima de lo cobrado. No está incluido en total_cobrado → se suma.
  const adicManual = redondear2(adicional);

  // Descomposición canónica de la venta (helper read-only compartido con Salidas). Parte
  // total_cobrado en flete/fuel/seguro/adicional con el fuel_pct ya resuelto arriba. NO
  // recotiza ni aplica profit: el profit ya está dentro de total_cobrado.
  const datosVenta = {
    total_cobrado: envio.total_cobrado,
    // Cliente con seguro propio: la línea "Seguro" de cara al cliente es el monto
    // negociado congelado en el envío (seguro_venta), no la escala de lista (seguro =
    // COSTO del desglose del alta). NULL = cliente sin seguro propio → escala de lista,
    // el comportamiento de siempre.
    seguro: envio.seguro_venta ?? envio.seguro,
    adicionales: envio.adicionales,
    derechos: envio.derechos,
    otros: envio.otros,
    fuel_pct: fuelPct,
    // El desglose por tipo del alta: con él, el fuel del surge va a Adicional y el flete
    // queda en kg × precio (ver utils/desgloseVenta.js). Sin él, reparto histórico.
    extras: envio.extras_json,
    // Desglose de venta ajustado a mano desde Salidas (02/11): si cierra con el total, manda.
    venta_json: envio.venta_json,
  };
  const venta = descomponerVenta(datosVenta);
  // Qué compone el Adicional, línea por línea (surge con su fuel, GoGreen, manejo, remota,
  // derechos, otros…) + el extra manual de esta liquidación. Pedido de Felipe (07/09): que
  // la liquidación desglose los adicionales, en pantalla y en el Excel.
  const adicionalDetalle = detallarAdicional(datosVenta);
  const totalCobrado = venta.total;   // = redondear2(envio.total_cobrado || 0)
  const seguro = venta.seguro;
  const flete = venta.flete;
  const fuelDif = redondear2(fuelExtra);
  const fuel = redondear2(venta.fuel + fuelDif);
  // Adicionales itemizados guardados (surge en extras_json, derechos, otros). NO se duplican
  // con el adicional manual: ese es un cargo aparte que se agrega aparte.
  const adicGuardado = venta.adicional;

  // Columna Adicional de cara al cliente: cargos guardados + extra manual de la fila.
  const adicionalItem = redondear2(adicGuardado + adicManual);
  if (adicManual > 0) {
    const conNombre = (cargosDetalle || []).filter((c) => Number(c.monto) > 0);
    if (conNombre.length) {
      for (const c of conNombre) adicionalDetalle.push({ tipo: c.tipo || 'manual', label: c.descripcion || 'Adicional de esta liquidación', monto: redondear2(c.monto) });
    } else {
      adicionalDetalle.push({ tipo: 'manual', label: 'Adicional de esta liquidación', monto: adicManual });
    }
  }
  // Total = lo que el cliente pagó + el extra manual agregado en esta liquidación + la
  // diferencia de fuel. Invariante: flete + fuel + seguro + adicionalItem = totalUsd.
  const totalUsd = redondear2(totalCobrado + adicManual + fuelDif);

  // Servicio para columnas internas/persistencia (no se muestra al cliente).
  const servicioCotizado = envio.courier === 'DHL' ? 'DHL' : (envio.servicio_ups || null);

  // Métricas internas (NO se muestran al cliente: ni en el preview ni en el Excel). Se siguen
  // calculando y persistiendo para no romper el schema de liquidacion_items y para uso interno.
  // costoBase = desglose al costo congelado en el alta; utilidad = lo cobrado − costo.
  const costoBase = redondear2(
    (envio.flete || 0) + (envio.fuel || 0) + (envio.seguro || 0) +
    (envio.adicionales || 0) + (envio.derechos || 0) + (envio.otros || 0) -
    (envio.descuento || 0)
  );
  const utilidadUsd = redondear2(totalCobrado - costoBase);
  const profitPct = costoBase > 0 ? redondear2((utilidadUsd / costoBase) * 100) : null;

  return {
    envio_id: envio.id,
    flete,
    fuel,
    seguro,
    adicional: adicionalItem,
    adicional_detalle: adicionalDetalle,
    fuel_diferencia: fuelDif,
    total_usd: totalUsd,
    fuel_pct_usado: fuelPct,
    precio_cotizado: totalCobrado,
    profit_pct: profitPct,     // interno: no se muestra al cliente
    utilidad_usd: utilidadUsd, // interno: no se muestra al cliente
    servicio_cotizado: servicioCotizado,
    envio,
  };
}

/**
 * Pendiente 52 (12/09/2026): qué BORRADORES ya contienen alguno de estos envíos.
 * Pasó con Cueros Santa Cruz (#57 y #58) y GIANNASTACIO (#44 y #64): un envío sin liquidar
 * sigue apareciendo en Pendientes aunque ya esté en un borrador, así que la oficina armaba
 * un segundo borrador con los mismos envíos sin enterarse. El 409 de confirmar solo frena
 * lo ya liquidado; esto avisa ANTES, al armar.
 * Devuelve [{ id, fecha, created_at, periodo_desde, periodo_hasta, envio_ids, guias }].
 */
async function borradoresConEnvios(envio_ids) {
  if (!envio_ids || !envio_ids.length) return [];
  const db = getDb();
  const placeholders = envio_ids.map(() => '?').join(',');
  const filas = await db
    .prepare(
      `SELECT l.id, l.fecha, l.created_at, l.periodo_desde, l.periodo_hasta,
              li.envio_id, e.numero_guia
       FROM liquidacion_items li
       JOIN liquidaciones l ON l.id = li.liquidacion_id
       JOIN envios e ON e.id = li.envio_id
       WHERE l.estado = 'borrador' AND l.anulada_at IS NULL AND li.envio_id IN (${placeholders})
       ORDER BY l.id, li.envio_id`
    )
    .all(...envio_ids);
  const porBorrador = new Map();
  for (const f of filas) {
    if (!porBorrador.has(f.id)) {
      porBorrador.set(f.id, {
        id: f.id, fecha: f.fecha, created_at: f.created_at,
        periodo_desde: f.periodo_desde, periodo_hasta: f.periodo_hasta,
        envio_ids: [], guias: [],
      });
    }
    const b = porBorrador.get(f.id);
    b.envio_ids.push(f.envio_id);
    b.guias.push(f.numero_guia);
  }
  return [...porBorrador.values()];
}

async function preview({ cliente_id, envio_ids = [], cargos = [], cotizaciones = [], conceptos = [], cargos_anteriores_ids = null }) {
  const db = getDb();
  const conceptosOk = normalizarConceptos(conceptos);
  const total_conceptos = redondear2(conceptosOk.reduce((s, c) => s + c.monto, 0));
  envio_ids = Array.isArray(envio_ids) ? envio_ids : [];
  // Sin envíos (05/10/2026, pedido de Felipe): se puede armar una liquidación SOLO con los
  // cargos de envíos anteriores del cliente (el envío fue en julio, el extracargo llegó en
  // agosto y en agosto el cliente no tuvo envíos). Si tampoco hay cargos, se corta abajo.
  const placeholders = envio_ids.map(() => '?').join(',');
  const envios = envio_ids.length ? await db
    .prepare(
      `SELECT e.*, COALESCE(d.nombre, e.destinatario_nombre) AS destinatario_nombre
       FROM envios e
       LEFT JOIN destinatarios d ON d.id = e.destinatario_id
       WHERE e.id IN (${placeholders}) AND e.cliente_id = ? AND e.liquidado = 0 AND e.no_volo = 0`
    )
    .all(...envio_ids, cliente_id) : [];

  if (envios.length !== envio_ids.length) {
    const err = new Error('Algunos envíos no existen, no pertenecen al cliente, ya están liquidados o están marcados como "no voló"');
    err.status = 400;
    throw err;
  }

  const cargoMap = {};
  const cargosPorEnvio = {};
  for (const c of cargos) {
    cargoMap[c.envio_id] = (cargoMap[c.envio_id] || 0) + (Number(c.monto) || 0);
    (cargosPorEnvio[c.envio_id] = cargosPorEnvio[c.envio_id] || []).push(c);
  }
  // Cargos posteriores (25/09/2026): lo que se agregó desde Salidas o los impuestos DDP
  // que facturó UPS después de cargar el envío. Los de ESTOS envíos entran en su ítem,
  // al costo, con su nombre. Los pendientes de envíos del cliente que YA se liquidaron
  // van aparte, en "Cargos de envíos anteriores", y se suman al total.
  // Rótulo SIN la fecha "informado el…" (04/11/2026, pedido de Felipe): dentro de la
  // liquidación del propio envío esa fecha es solo el día en que se cargó la factura y
  // confunde. La fecha queda en "Cargos de envíos anteriores", donde sí explica algo.
  // Diferencia de fuel: va a la columna FUEL del ítem, no al Adicional.
  const pendPorEnvio = await cargosModel.pendientesDeEnvios(envio_ids, db);
  const cargosEnviosIds = [];
  const fuelMap = {};
  for (const [envioId, lista] of Object.entries(pendPorEnvio)) {
    for (const c of lista) {
      cargosEnviosIds.push(c.id);
      if (cargosModel.esFuel(c)) { fuelMap[envioId] = (fuelMap[envioId] || 0) + c.monto; continue; }
      cargoMap[envioId] = (cargoMap[envioId] || 0) + c.monto;
      (cargosPorEnvio[envioId] = cargosPorEnvio[envioId] || []).push({ envio_id: Number(envioId), monto: c.monto, descripcion: c.label || 'Cargo', tipo: 'cargo', cargo_id: c.id });
    }
  }
  // Cargos de envíos anteriores OPCIONALES (03/11/2026, pedido de Felipe: cargaron un cargo
  // a Giannastacio, liquidaron un envío después y el cargo entró sin que lo quisieran).
  // La pantalla manda los ids tildados en `cargos_anteriores_ids`; sin el parámetro (API
  // vieja, scripts) entran todos, como hasta ahora. Los destildados siguen pendientes.
  const pendientesAnteriores = await cargosModel.pendientesAnterioresDeCliente(cliente_id, db);
  const elegidos = Array.isArray(cargos_anteriores_ids) ? new Set(cargos_anteriores_ids.map(Number)) : null;
  const cargos_anteriores = elegidos ? pendientesAnteriores.filter((c) => elegidos.has(Number(c.id))) : pendientesAnteriores;
  const total_cargos_anteriores = redondear2(cargos_anteriores.reduce((s, c) => s + c.monto, 0));
  if (!envios.length && !cargos_anteriores.length && !conceptosOk.length) {
    const err = new Error(pendientesAnteriores.length && elegidos
      ? 'No hay nada para liquidar: no hay envíos seleccionados ni cargos de envíos anteriores tildados, ni otros conceptos.'
      : 'No hay nada para liquidar: ni envíos seleccionados, ni cargos pendientes de envíos anteriores de este cliente, ni otros conceptos.');
    err.status = 400;
    throw err;
  }

  // `cotizaciones` se sigue aceptando para no romper la API y el botón manual "Cotizar"
  // por fila, pero la liquidación YA NO recotiza: el desglose se arma leyendo lo guardado
  // en el envío (ver calcularItem). El flujo automático de preview no depende del cotizador.
  void cotizaciones;

  const items = await Promise.all(
    envios.map((e) => calcularItem(e, cargoMap[e.id] || 0, cargosPorEnvio[e.id] || [], fuelMap[e.id] || 0))
  );
  for (const it of items) it.cargos_posteriores = pendPorEnvio[it.envio_id] || [];
  const total_envios = redondear2(items.reduce((s, i) => s + i.total_usd, 0));
  // Los otros conceptos van al total y a NADA más: ni a la utilidad (son al costo) ni a
  // ningún envío.
  const total = redondear2(total_envios + total_cargos_anteriores + total_conceptos);
  const utilidadTotal = redondear2(items.reduce((s, i) => s + (i.utilidad_usd || 0), 0));
  // Pendiente 52: la vista previa avisa si alguno de estos envíos ya está en otro borrador.
  const en_borrador = await borradoresConEnvios(envio_ids);
  const cliFmt = await db.prepare('SELECT liquidacion_formato FROM clientes WHERE id = ?').get(cliente_id);
  return {
    items, total, total_envios, cargos_anteriores, total_cargos_anteriores,
    cargos_anteriores_pendientes: pendientesAnteriores.length,
    conceptos: conceptosOk, total_conceptos,
    utilidad_total: utilidadTotal, cantidad: items.length, en_borrador,
    // Formato preferido del cliente (16/10): la pantalla lo usa para pre-tildar "detallado".
    formato_sugerido: (cliFmt && cliFmt.liquidacion_formato) || 'estandar',
    // Interno: ids de envio_cargos que esta vista previa metió en los ítems (crear los ata).
    _cargos_envios_ids: cargosEnviosIds,
  };
}

async function crear({
  cliente_id, periodo_desde, periodo_hasta, envio_ids, cargos = [], cotizaciones = [], confirmar = false,
  reemplazar_borradores = [], permitir_duplicado = false, usuario = null, formato = null, conceptos = [],
  cargos_anteriores_ids = null,
}) {
  await migrarColumnas();
  // Pendiente 52: si algún envío ya está en OTRO borrador, no se arma un segundo en
  // silencio. La pantalla recibe 409 con la lista y ofrece borrar el viejo; vuelve con
  // `reemplazar_borradores: [ids]` y acá se borran primero. `permitir_duplicado` deja
  // crearlo igual (queda el chequeo del panel de salud para marcarlo).
  const reemplazar = new Set((reemplazar_borradores || []).map(Number));
  const previos = await borradoresConEnvios(envio_ids);
  const bloquean = previos.filter((b) => !reemplazar.has(b.id));
  if (bloquean.length && !permitir_duplicado) {
    const lista = bloquean.map((b) => `#${b.id} (${b.fecha}, ${b.guias.length} envío${b.guias.length === 1 ? '' : 's'}: ${b.guias.join(', ')})`).join('; ');
    const err = new Error(`Estos envíos ya están en otro borrador: ${lista}. Borrá ese borrador o sacalos de la selección.`);
    err.status = 409;
    err.borradores = bloquean;
    throw err;
  }
  for (const b of previos) {
    if (reemplazar.has(b.id)) await eliminarBorrador(b.id);
  }
  const previewData = await preview({ cliente_id, envio_ids, cargos, cotizaciones, conceptos, cargos_anteriores_ids });
  // ⚠️ Defecto 3 de AUDITORIA-NUMEROS.md: un envío sin precio entraba a la liquidación,
  // se confirmaba en CERO y quedaba liquidado para siempre — esa plata no se facturaba
  // nunca más. Choca de lleno con los envíos sin pesar (total_cobrado = 0 por diseño):
  // liquidar el mes antes de que lleguen los pesos los daba por cobrados en cero.
  // El borrador se permite (sirve para ir armando); CONFIRMAR con ítems en cero, no.
  if (confirmar) validarSinCeros(previewData.items);
  const db = getDb();

  const id = await db.transaction(async () => {
    const liqResult = await db
      .prepare(
        `INSERT INTO liquidaciones (cliente_id, periodo_desde, periodo_hasta, total, estado, formato)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        cliente_id,
        periodo_desde,
        periodo_hasta,
        previewData.total,
        confirmar ? 'confirmada' : 'borrador',
        // Formato del Excel (16/10): el que pidió la pantalla; si no, el preferido del cliente.
        formato === 'detallado' || formato === 'estandar' ? formato : ((await db.prepare('SELECT liquidacion_formato FROM clientes WHERE id = ?').get(cliente_id)) || {}).liquidacion_formato || 'estandar'
      );
    const liquidacionId = liqResult.lastInsertRowid;

    const insertItem = db.prepare(
      `INSERT INTO liquidacion_items
        (liquidacion_id, envio_id, flete, fuel, seguro, adicional, total_usd, fuel_pct_usado,
         precio_cotizado, profit_pct, utilidad_usd, servicio_cotizado, adicional_detalle_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertCargo = db.prepare(
      `INSERT INTO cargos_adicionales (envio_id, liquidacion_id, descripcion, monto) 
       VALUES (?, ?, ?, ?)`
    );

    const cargoByEnvio = {};
    for (const c of cargos) {
      if (!cargoByEnvio[c.envio_id]) cargoByEnvio[c.envio_id] = [];
      cargoByEnvio[c.envio_id].push(c);
    }

    for (const item of previewData.items) {
      await insertItem.run(
        liquidacionId,
        item.envio_id,
        item.flete,
        item.fuel,
        item.seguro,
        item.adicional,
        item.total_usd,
        item.fuel_pct_usado,
        item.precio_cotizado,
        item.profit_pct,
        item.utilidad_usd,
        item.servicio_cotizado,
        JSON.stringify(cerrarDetalle(item.adicional_detalle, item.adicional))
      );
      const list = cargoByEnvio[item.envio_id] || [];
      for (const c of list) {
        await insertCargo.run(item.envio_id, liquidacionId, c.descripcion || 'Adicional', c.monto);
      }
      // La fila espejo "Cargo adicional" no se escribe si el Adicional viene de un cargo
      // posterior (ese ya tiene su propia fila en envio_cargos, con nombre).
      const conCargoPosterior = (item.cargos_posteriores || []).length > 0;
      if (item.adicional > 0 && list.length === 0 && !conCargoPosterior) {
        await insertCargo.run(item.envio_id, liquidacionId, 'Cargo adicional', item.adicional);
      }
    }

    // Otros conceptos (28/10): líneas propias de la liquidación, al costo.
    const insertConcepto = db.prepare('INSERT INTO liquidacion_conceptos (liquidacion_id, concepto, monto) VALUES (?, ?, ?)');
    for (const c of previewData.conceptos) await insertConcepto.run(liquidacionId, c.concepto, c.monto);

    // Cargos posteriores: quedan atados a esta liquidación (los de sus envíos y los de
    // envíos anteriores del cliente). Si el borrador se borra, se sueltan (eliminarBorrador).
    await cargosModel.asignarLiquidacion(
      previewData._cargos_envios_ids.concat(previewData.cargos_anteriores.map((c) => c.id)), liquidacionId, db
    );

    if (confirmar) {
      // hoyLocal(): toISOString() es UTC y dejaba una liquidación confirmada el 31 a las
      // 22:00 fechada el 1 del mes siguiente.
      const fecha = hoyLocal();
      await envioModel.marcarLiquidados(envio_ids, liquidacionId, fecha);
      await db.prepare('UPDATE liquidaciones SET fecha_confirmacion = ? WHERE id = ?').run(fecha, liquidacionId);
      // Cuenta corriente: la liquidación confirmada es el débito del libro del cliente.
      await ccModel.registrarDebitoLiquidacion(db, liquidacionId, { usuario });
    }

    return liquidacionId;
  });

  return buscarPorId(id);
}

// Rechaza con 409 una lista de ítems donde alguno quedó en cero. El mensaje nombra las
// guías: la oficina tiene que poder ver cuáles destildar o cargarles el precio.
function validarSinCeros(items) {
  const enCero = items.filter((i) => !(Number(i.total_usd) > 0));
  if (enCero.length > 0) {
    const guias = enCero.map((i) => i.numero_guia || (i.envio && i.envio.numero_guia) || `envío ${i.envio_id}`).join(', ');
    const err = new Error(
      `No se puede confirmar: ${enCero.length} envío(s) sin precio de venta (total USD 0): ${guias}. ` +
      'Cargales el precio o sacalos de la liquidación. Si se confirmara así, quedarían ' +
      'liquidados en cero y no se facturarían nunca.'
    );
    err.status = 409;
    throw err;
  }
}

// `envioIdsEsperados` (opcional) es LO QUE LA PANTALLA CREE que tiene este borrador.
// Sospecha 6 de AUDITORIA-NUMEROS.md — EL BORRADOR PEGADO, confirmada el 15/08: exportar
// creaba el borrador y guardaba su id; si después se cambiaba la selección, la vista
// previa mostraba la selección nueva pero Confirmar confirmaba el borrador VIEJO. Lo que
// se confirmaba no era lo que se estaba viendo. Ahora la pantalla manda su selección y,
// si no coincide con los ítems del borrador, esto corta con 409 en vez de confirmar otra
// cosa. Sin el parámetro (API vieja, scripts) se confirma como siempre.
async function confirmar(id, envioIdsEsperados = null, usuario = null, formato = null) {
  const db = getDb();
  const liq = await buscarPorId(id);
  if (!liq) return null;
  if (liq.estado === 'anulada') {
    const err = new Error('La liquidación está anulada: no se puede confirmar. Armá una nueva con esos envíos.');
    err.status = 409;
    throw err;
  }
  if (liq.estado === 'confirmada') {
    const err = new Error('La liquidación ya está confirmada');
    err.status = 400;
    throw err;
  }

  const envioIds = liq.items.map((i) => i.envio_id);

  if (Array.isArray(envioIdsEsperados)) {
    const enBorrador = new Set(envioIds.map(Number));
    const enPantalla = new Set(envioIdsEsperados.map(Number));
    const igual = enBorrador.size === enPantalla.size
      && [...enBorrador].every((x) => enPantalla.has(x));
    if (!igual) {
      const err = new Error(
        'La selección de envíos cambió después de crear este borrador: lo que está en '
        + 'pantalla no es lo que tiene el borrador. Volvé a calcular la vista previa y '
        + 'confirmá de nuevo.'
      );
      err.status = 409;
      throw err;
    }
  }

  // ⚠️ Defecto 2 de AUDITORIA-NUMEROS.md — EL MISMO ENVÍO FACTURADO DOS VECES. Crear un
  // borrador no marca nada; el envío queda libre y puede entrar en OTRO borrador. Al
  // confirmar el segundo, marcarLiquidados no pisaba nada (tiene WHERE liquidado = 0)
  // pero la liquidación entera se confirmaba igual, con sus ítems, y el cliente recibía
  // la misma guía cobrada dos veces. Reproducido el 07/08: dos confirmadas de USD 500
  // con los mismos envíos. Acá se vuelve a chequear ANTES de confirmar.
  const yaLiquidados = envioIds.length ? await db
    .prepare(
      `SELECT e.id, e.numero_guia, e.liquidacion_id FROM envios e
       WHERE e.id IN (${envioIds.map(() => '?').join(',')}) AND e.liquidado = 1`
    )
    .all(...envioIds) : [];
  if (yaLiquidados.length > 0) {
    const guias = yaLiquidados.map((e) => `${e.numero_guia} (liquidación #${e.liquidacion_id})`).join(', ');
    const err = new Error(
      `No se puede confirmar: ${yaLiquidados.length} envío(s) ya están liquidados en otra ` +
      `liquidación: ${guias}. Borrá este borrador o sacá esos envíos.`
    );
    err.status = 409;
    throw err;
  }

  // Defecto 3: confirmar un borrador con ítems en cero también se frena acá.
  validarSinCeros(liq.items);
  // Liquidación solo de cargos (05/10) o solo de otros conceptos (28/10): sin envíos tiene
  // que tener al menos una línea.
  if (!liq.items.length && !(liq.cargos_anteriores || []).length && !(liq.conceptos || []).length) {
    const err = new Error('No se puede confirmar: la liquidación no tiene envíos, cargos ni otros conceptos.');
    err.status = 409;
    throw err;
  }

  // Cargos posteriores (25/09): si después de armar el borrador entró un cargo (un
  // extracargo desde Salidas o los impuestos DDP de una factura), no se confirma sin
  // que la oficina lo vea. Se pide recalcular: la vista previa nueva lo incluye sola.
  // Desde el 03/11/2026 los cargos de envíos anteriores son OPCIONALES: uno que ya existía
  // cuando se armó el borrador y quedó afuera, quedó afuera a propósito (destildado) y no
  // frena. Sí frena uno que ENTRÓ después de armar el borrador (eso es lo que la oficina
  // todavía no vio), y siempre los cargos de los envíos que están en la liquidación.
  const todosFuera = await cargosModel.pendientesFueraDe(id, liq.cliente_id, envioIds, db);
  const armado = String(liq.created_at || '');
  const nuevos = todosFuera.filter((c) => {
    const deEnvioIncluido = c.envio_id != null && envioIds.map(Number).includes(Number(c.envio_id));
    if (deEnvioIncluido) return true;
    return !armado || String(c.creado_at || '') > armado;
  });
  if (nuevos.length) {
    const lista = nuevos.map((c) => `${c.numero_guia ? c.numero_guia : 'envío ' + c.envio_id}: ${c.label} USD ${c.monto.toFixed(2)}`).join('; ');
    const err = new Error(
      `Hay ${nuevos.length === 1 ? 'un cargo nuevo' : nuevos.length + ' cargos nuevos'} que este borrador no tiene (${lista}). ` +
      'Apretá Calcular de nuevo para incluirlos y después confirmá.'
    );
    err.status = 409;
    throw err;
  }

  // BORRADOR DESACTUALIZADO (auditoría 05/11/2026, liq #239): el borrador se armó, después
  // la oficina corrigió el envío (medidas, precio) y confirmó el borrador tal cual estaba:
  // la liquidación salió con la venta vieja mientras la pantalla mostraba la nueva. Acá se
  // recalcula cada envío con lo que tiene HOY y, si la plata cambió, se frena: hay que
  // volver a Calcular (la pantalla descarta el borrador y arma uno nuevo).
  const desactualizados = await itemsDesactualizados(liq, db);
  if (desactualizados.length) {
    const lista = desactualizados.map((d) => `${d.numero_guia}: ${d.antes.toFixed(2)} → ${d.ahora.toFixed(2)}`).join('; ');
    const err = new Error(
      `${desactualizados.length === 1 ? 'Un envío cambió' : desactualizados.length + ' envíos cambiaron'} después de armar este borrador (${lista}). ` +
      'Apretá Calcular de nuevo para armarlo con los valores actuales y después confirmá.'
    );
    err.status = 409;
    err.codigo = 'borrador_desactualizado';
    err.desactualizados = desactualizados;
    throw err;
  }

  const fecha = hoyLocal();

  await db.transaction(async () => {
    await db.prepare(
      `UPDATE liquidaciones SET estado = 'confirmada', fecha_confirmacion = ?,
       formato = COALESCE(?, formato),
       updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    ).run(fecha, formato === 'detallado' || formato === 'estandar' ? formato : null, id);
    await envioModel.marcarLiquidados(envioIds, id, fecha);
    // Cuenta corriente: la liquidación confirmada es el débito del libro del cliente.
    await ccModel.registrarDebitoLiquidacion(db, id, { usuario });
  });
  return buscarPorId(id);
}

// Compara cada ítem del borrador con lo que daría HOY el mismo envío: flete, fuel, seguro
// y el precio cotizado (total cobrado). El extra manual de la liquidación y los cargos
// posteriores no entran en la comparación (los cargos nuevos los frena el otro control).
async function itemsDesactualizados(liq, db = getDb()) {
  const out = [];
  for (const it of liq.items || []) {
    const envio = await db.prepare('SELECT * FROM envios WHERE id = ?').get(it.envio_id);
    if (!envio) continue;
    const fuelDif = redondear2((await cargosModel.listarDeEnvio(envio.id, db))
      .filter((c) => c.estado !== 'anulado' && c.liquidacion_id === liq.id && cargosModel.esFuel(c))
      .reduce((s, c) => s + (Number(c.monto) || 0), 0));
    const ahora = await calcularItem(envio, 0, [], fuelDif);
    const distinto = ['flete', 'fuel', 'seguro'].some((k) => Math.abs(redondear2(ahora[k]) - redondear2(it[k])) >= 0.011)
      || Math.abs(redondear2(ahora.precio_cotizado) - redondear2(it.precio_cotizado)) >= 0.011;
    if (distinto) out.push({ envio_id: envio.id, numero_guia: envio.numero_guia, antes: redondear2(it.precio_cotizado), ahora: redondear2(ahora.precio_cotizado) });
  }
  return out;
}

async function buscarPorId(id) {
  const db = getDb();
  const liq = await db
    .prepare(
      `SELECT l.*, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre, c.tipo_cobro
       FROM liquidaciones l
       JOIN clientes c ON c.id = l.cliente_id
       WHERE l.id = ?`
    )
    .get(id);
  if (!liq) return null;

  const items = await db
    .prepare(
      `SELECT li.*, e.numero_guia, e.fecha, e.pais_destino, e.zona, e.tipo_envio,
              e.peso_facturable, e.fob, e.courier, e.total_cobrado,
              e.extras_json, e.adicionales AS envio_adicionales, e.derechos AS envio_derechos,
              e.otros AS envio_otros, e.seguro AS envio_seguro, e.seguro_venta AS envio_seguro_venta,
              e.venta_json AS envio_venta_json,
              COALESCE(d.nombre, e.destinatario_nombre) AS destinatario_nombre
       FROM liquidacion_items li
       JOIN envios e ON e.id = li.envio_id
       LEFT JOIN destinatarios d ON d.id = e.destinatario_id
       WHERE li.liquidacion_id = ?
       ORDER BY e.fecha, e.numero_guia`
    )
    .all(id);

  const cargos = await db
    .prepare('SELECT * FROM cargos_adicionales WHERE liquidacion_id = ?')
    .all(id);
  // Cargos posteriores de esta liquidación: los de sus envíos se suman a `cargos` (rotulan
  // el desglose del ítem, igual que los manuales); los de envíos anteriores van aparte.
  // Sin la fecha "informado el…" (04/11); las diferencias de fuel no van acá: están sumadas
  // en la columna FUEL del ítem (se informan aparte en fuel_diferencia).
  const posteriores = await cargosModel.deLiquidacion(id, db);
  const fuelPorEnvio = {};
  for (const c of posteriores.enItems) {
    if (cargosModel.esFuel(c)) { (fuelPorEnvio[c.envio_id] = fuelPorEnvio[c.envio_id] || []).push({ envio_id: c.envio_id, descripcion: c.label || 'Diferencia de fuel', monto: c.monto, tipo: 'cargo', cargo_id: c.id }); continue; }
    cargos.push({ envio_id: c.envio_id, descripcion: c.label || 'Cargo', monto: c.monto, tipo: 'cargo', cargo_id: c.id });
  }

  // Detalle del Adicional de cada ítem (07/09): se deriva del envío con el MISMO helper que
  // usó el cálculo (read-only, no toca lo confirmado). Los envíos liquidados tienen la plata
  // congelada, así que el detalle es el de siempre. El extra manual sale de cargos_adicionales.
  for (const it of items) {
    // Desglose congelado al crear (05/11/2026): es el que vio la vista previa y no cambia
    // aunque el envío se edite después. Los ítems anteriores se derivan del envío.
    let congelado = null;
    try { congelado = it.adicional_detalle_json ? JSON.parse(it.adicional_detalle_json) : null; } catch { congelado = null; }
    if (Array.isArray(congelado)) {
      it.adicional_detalle = cerrarDetalle(congelado, it.adicional);
      it.fuel_diferencia = redondear2((fuelPorEnvio[it.envio_id] || []).reduce((s, c) => s + Number(c.monto), 0));
      delete it.extras_json; delete it.envio_adicionales; delete it.envio_derechos;
      delete it.envio_otros; delete it.envio_seguro; delete it.envio_seguro_venta; delete it.envio_venta_json; delete it.adicional_detalle_json;
      continue;
    }
    const detalle = detallarAdicional({
      total_cobrado: it.total_cobrado,
      seguro: it.envio_seguro_venta ?? it.envio_seguro,
      adicionales: it.envio_adicionales,
      derechos: it.envio_derechos,
      otros: it.envio_otros,
      fuel_pct: it.fuel_pct_usado,
      extras: it.extras_json,
      // Venta ajustada a mano: sin esto el desglose no cerraba con la columna (auditoría 05/11).
      venta_json: it.envio_venta_json,
    });
    // La parte MANUAL es lo que la columna guardada tiene de más respecto del desglose del
    // envío. OJO: cargos_adicionales guarda también una fila espejo "Cargo adicional" con la
    // columna entera cuando no hubo extras manuales (ver crear()), así que no se puede leer
    // esa tabla a ciegas: se usa solo si sus filas suman exactamente la parte manual.
    let derivado = redondear2(detalle.reduce((s, d) => s + d.monto, 0));
    let manual = redondear2((Number(it.adicional) || 0) - derivado);
    // Liquidaciones anteriores al "surge con fuel" (junio–septiembre 2026): la columna
    // Adicional guardada tiene el surge PELADO, sin su fuel. Si lo que sobra es exactamente
    // el fuel del surge, era eso: se muestra el surge sin fuel y no hace falta "Ajuste".
    const surgeLinea = detalle.find((d) => d.tipo === 'surge');
    if (surgeLinea && manual < -0.005) {
      const surgeRaw = redondear2(surgeDe(it.extras_json));
      const fuelDelSurge = redondear2(surgeRaw * (Number(it.fuel_pct_usado) || 0) / 100);
      if (fuelDelSurge > 0 && Math.abs(manual + fuelDelSurge) < 0.011) {
        surgeLinea.monto = surgeRaw;
        surgeLinea.label = 'Surge fee';
        derivado = redondear2(detalle.reduce((s, d) => s + d.monto, 0));
        manual = redondear2((Number(it.adicional) || 0) - derivado);
      }
    }
    // Diferencias de fuel del envío: desde el 04/11 están sumadas en la columna FUEL del
    // ítem. Una liquidación anterior a ese día las tiene dentro del Adicional: se reconoce
    // porque la parte manual las necesita para cerrar, y en ese caso siguen como línea.
    const fuelFilas = fuelPorEnvio[it.envio_id] || [];
    const sumaFuel = redondear2(fuelFilas.reduce((s, c) => s + Number(c.monto), 0));
    let filas = cargos.filter((c) => c.envio_id === it.envio_id && Number(c.monto) > 0);
    let sumaFilas = redondear2(filas.reduce((s, c) => s + Number(c.monto), 0));
    let fuelDif = sumaFuel;
    if (fuelFilas.length && manual > 0.005 && Math.abs(sumaFilas - manual) >= 0.011 && Math.abs(sumaFilas + sumaFuel - manual) < 0.011) {
      filas = filas.concat(fuelFilas);
      sumaFilas = redondear2(sumaFilas + sumaFuel);
      fuelDif = 0;
    }
    if (manual > 0.005) {
      if (filas.length && Math.abs(sumaFilas - manual) < 0.011) {
        for (const c of filas) detalle.push({ tipo: c.tipo || 'manual', label: c.descripcion || 'Adicional de esta liquidación', monto: redondear2(c.monto) });
      } else {
        detalle.push({ tipo: 'manual', label: 'Adicional de esta liquidación', monto: manual });
      }
    }
    // Pase lo que pase, los renglones cierran con la columna: si el envío cambió después
    // de liquidarse, la diferencia va como "Ajuste" y el cliente nunca ve dos números.
    it.adicional_detalle = cerrarDetalle(detalle, it.adicional);
    it.fuel_diferencia = fuelDif;
    delete it.extras_json; delete it.envio_adicionales; delete it.envio_derechos;
    delete it.envio_otros; delete it.envio_seguro; delete it.envio_seguro_venta; delete it.envio_venta_json; delete it.adicional_detalle_json;
  }

  const total_envios = redondear2(items.reduce((s, it) => s + (Number(it.total_usd) || 0), 0));
  const cargos_anteriores = posteriores.anteriores;
  const total_cargos_anteriores = redondear2(cargos_anteriores.reduce((s, c) => s + c.monto, 0));
  const conceptos = await conceptosDe(id, db);
  const total_conceptos = redondear2(conceptos.reduce((s, c) => s + c.monto, 0));
  return { ...liq, estado: liq.anulada_at ? 'anulada' : liq.estado, items, cargos, cargos_anteriores, total_envios, total_cargos_anteriores, conceptos, total_conceptos };
}

async function listar(filtros = {}) {
  const db = getDb();
  let sql = `
    SELECT l.*, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre, c.tipo_cobro,
           (SELECT COUNT(*) FROM liquidacion_items WHERE liquidacion_id = l.id) AS cantidad_envios,
           (SELECT COUNT(*) FROM envio_cargos x LEFT JOIN envios e ON e.id = x.envio_id
             WHERE x.liquidacion_id = l.id AND x.anulado_at IS NULL AND (x.envio_id IS NULL OR (e.liquidacion_id IS NOT NULL AND e.liquidacion_id <> l.id))) AS cantidad_cargos_anteriores
    FROM liquidaciones l
    JOIN clientes c ON c.id = l.cliente_id
    WHERE 1=1`;
  const params = [];

  if (filtros.cliente_id) {
    sql += ' AND l.cliente_id = ?';
    params.push(filtros.cliente_id);
  }
  if (filtros.fecha_desde) {
    sql += ' AND l.fecha >= ?';
    params.push(filtros.fecha_desde);
  }
  if (filtros.fecha_hasta) {
    sql += ' AND l.fecha <= ?';
    params.push(filtros.fecha_hasta);
  }
  if (filtros.estado === 'anulada') {
    sql += ' AND l.anulada_at IS NOT NULL';
  } else if (filtros.estado) {
    sql += ' AND l.estado = ? AND l.anulada_at IS NULL';
    params.push(filtros.estado);
  }

  sql += ' ORDER BY l.fecha DESC, l.id DESC';
  const rows = await db.prepare(sql).all(...params);
  return rows.map((r) => (r.anulada_at ? { ...r, estado: 'anulada' } : r));
}

/**
 * ANULA una liquidación confirmada (10/11/2026, pedido de Felipe: "para casos en los que
 * haya errores"). Cualquier usuario con acceso a Liquidaciones, sin límite de tiempo.
 * No se borra nada: queda en el historial como "anulada" con quién, cuándo y por qué.
 *   · Los envíos vuelven a "sin liquidar" (se pueden corregir y liquidar de nuevo).
 *   · Los cargos posteriores que entraron en ella vuelven a pendientes.
 *   · En la cuenta corriente NO se borra el débito: se asienta una nota de crédito por el
 *     mismo importe contra la LQ y su saldo queda en cero.
 *   · Deja de contar en Dashboard, Comisiones y Analítica (todo eso filtra 'confirmada').
 * Freno: si la LQ ya tiene pagos imputados (o una NC), primero hay que deshacer eso en
 * Cobranzas; si no, quedaría un pago aplicado a una deuda que ya no existe.
 */
async function anular(id, { usuario = null, motivo = '' } = {}) {
  const db = getDb();
  const liq = await buscarPorId(id);
  if (!liq) return null;
  const fallo = (msg, status = 409) => { const e = new Error(msg); e.status = status; return e; };
  if (liq.estado === 'anulada') throw fallo('La liquidación ya está anulada.');
  if (liq.estado !== 'confirmada') throw fallo('Es un borrador: no hace falta anularlo, se borra.');
  motivo = String(motivo || '').trim();
  if (motivo.length < 3) throw fallo('Escribí el motivo de la anulación.', 400);
  if (motivo.length > 300) motivo = motivo.slice(0, 300);

  const cpte = await db.prepare('SELECT * FROM cc_comprobantes WHERE liquidacion_id = ? AND anulado_at IS NULL').get(id);
  if (cpte) {
    const imput = await db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(importe), 0) AS total FROM cc_recibo_imputaciones
       WHERE comprobante_id = ? AND estado <> 'revertida'`
    ).get(cpte.id);
    const cobrado = redondear2((Number(cpte.importe) || 0) - (Number(cpte.saldo) || 0));
    if ((imput && imput.n > 0) || cobrado > 0.005) {
      const cuanto = redondear2(Math.max(cobrado, imput ? Number(imput.total) || 0 : 0));
      throw fallo(
        `No se puede anular: la liquidación #${liq.id} ya tiene pagos o notas de crédito aplicados en la cuenta corriente `
        + `(USD ${cuanto.toFixed(2)}). Primero hay que deshacer eso en Cobranzas.`
      );
    }
  }

  const envioIds = liq.items.map((i) => i.envio_id);
  const hoy = hoyLocal();
  await db.transaction(async () => {
    await db.prepare(
      `UPDATE liquidaciones SET estado = 'borrador', anulada_at = datetime('now', 'localtime'),
         anulada_por = ?, anulada_motivo = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    ).run(usuario, motivo, id);
    // Los envíos de ESTA liquidación vuelven a pendientes (solo los que apuntan a ella).
    await db.prepare(
      `UPDATE envios SET liquidado = 0, fecha_liquidacion = NULL, liquidacion_id = NULL,
         updated_at = datetime('now', 'localtime')
       WHERE liquidacion_id = ?`
    ).run(id);
    // Los cargos posteriores vuelven a pendientes: los levanta la próxima liquidación.
    await cargosModel.liberarDeLiquidacion(id, db);
    // Cuenta corriente: contraasiento. La LQ queda con saldo 0 y la NC la referencia.
    if (cpte) {
      await db.prepare(
        `INSERT INTO cc_comprobantes (cliente_id, razon_social_id, libro, tipo, numero, fecha, moneda,
           importe, tc_dia, importe_usd, importe_ars, saldo, referencia_id, descripcion, origen, creado_por)
         VALUES (?, ?, ?, 'NC', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'sistema', ?)`
      ).run(
        cpte.cliente_id, cpte.razon_social_id, cpte.libro, `NC-LQ-${id}`, hoy, cpte.moneda,
        cpte.importe, cpte.tc_dia, cpte.importe_usd, cpte.importe_ars, cpte.id,
        `Anulación de la liquidación #${id}: ${motivo}`, usuario
      );
      await db.prepare('UPDATE cc_comprobantes SET saldo = 0 WHERE id = ?').run(cpte.id);
    }
  });
  return { ...(await buscarPorId(id)), envios_liberados: envioIds.length };
}

/**
 * Borra un BORRADOR. Una confirmada no se toca por acá: sus envíos están marcados y el
 * cliente ya recibió el Excel — eso es una anulación, otro trabajo. Borrar un borrador es
 * seguro por construcción: crear un borrador no marca ningún envío.
 */
async function eliminarBorrador(id) {
  const db = getDb();
  const liq = await buscarPorId(id);
  if (!liq) return null;
  if (liq.estado === 'anulada') {
    const err = new Error('La liquidación está anulada: queda en el historial como registro, no se borra.');
    err.status = 409;
    throw err;
  }
  if (liq.estado === 'confirmada') {
    const err = new Error('La liquidación está confirmada: no se puede borrar. Si tiene un error, anulala desde el historial.');
    err.status = 409;
    throw err;
  }
  await db.transaction(async () => {
    await db.prepare('DELETE FROM liquidacion_items WHERE liquidacion_id = ?').run(id);
    // Los cargos adicionales pertenecen al ENVÍO; al morir el borrador quedan sueltos
    // (liquidacion_id NULL) y los levanta el próximo, igual que sus envíos.
    // Los cargos manuales viven solo en el borrador (preview los toma del body, nadie relee
    // filas sueltas): al borrarlo se borran, en vez de quedar huérfanos (29/09/2026).
    await db.prepare('DELETE FROM cargos_adicionales WHERE liquidacion_id = ?').run(id);
    await db.prepare('DELETE FROM liquidacion_conceptos WHERE liquidacion_id = ?').run(id);
    // Los cargos posteriores vuelven a pendientes: los levanta la próxima liquidación.
    await cargosModel.liberarDeLiquidacion(id, db);
    await db.prepare('DELETE FROM liquidaciones WHERE id = ?').run(id);
  });
  return true;
}

module.exports = {
  migrarColumnas,
  eliminarBorrador,
  anular,
  borradoresConEnvios,
  preview,
  crear,
  confirmar,
  buscarPorId,
  listar,
  calcularItem,
  cotizarEnvio,
};
