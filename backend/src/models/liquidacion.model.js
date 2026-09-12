const { getDb } = require('../db');
const configuracionModel = require('./configuracion.model');
const envioModel = require('./envio.model');
const { redondear2, cotizarEnvio } = require('../services/calculos.service');
const { descomponerVenta, detallarAdicional } = require('../utils/desgloseVenta');
const { hoyLocal } = require('../utils/fecha');

// Migración automática: agrega columnas nuevas si no existen
async function migrarColumnas() {
  const db = getDb();
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
async function calcularItem(envio, adicional = 0, cargosDetalle = []) {
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
  };
  const venta = descomponerVenta(datosVenta);
  // Qué compone el Adicional, línea por línea (surge con su fuel, GoGreen, manejo, remota,
  // derechos, otros…) + el extra manual de esta liquidación. Pedido de Felipe (07/09): que
  // la liquidación desglose los adicionales, en pantalla y en el Excel.
  const adicionalDetalle = detallarAdicional(datosVenta);
  const totalCobrado = venta.total;   // = redondear2(envio.total_cobrado || 0)
  const seguro = venta.seguro;
  const flete = venta.flete;
  const fuel = venta.fuel;
  // Adicionales itemizados guardados (surge en extras_json, derechos, otros). NO se duplican
  // con el adicional manual: ese es un cargo aparte que se agrega aparte.
  const adicGuardado = venta.adicional;

  // Columna Adicional de cara al cliente: cargos guardados + extra manual de la fila.
  const adicionalItem = redondear2(adicGuardado + adicManual);
  if (adicManual > 0) {
    const conNombre = (cargosDetalle || []).filter((c) => Number(c.monto) > 0);
    if (conNombre.length) {
      for (const c of conNombre) adicionalDetalle.push({ tipo: 'manual', label: c.descripcion || 'Adicional de esta liquidación', monto: redondear2(c.monto) });
    } else {
      adicionalDetalle.push({ tipo: 'manual', label: 'Adicional de esta liquidación', monto: adicManual });
    }
  }
  // Total = lo que el cliente pagó + el extra manual agregado en esta liquidación.
  // Invariante: flete + fuel + seguro + adicionalItem = total_cobrado + adicManual = totalUsd.
  const totalUsd = redondear2(totalCobrado + adicManual);

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
       WHERE l.estado = 'borrador' AND li.envio_id IN (${placeholders})
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

async function preview({ cliente_id, envio_ids, cargos = [], cotizaciones = [] }) {
  const db = getDb();
  const placeholders = envio_ids.map(() => '?').join(',');
  const envios = await db
    .prepare(
      `SELECT * FROM envios
       WHERE id IN (${placeholders}) AND cliente_id = ? AND liquidado = 0 AND no_volo = 0`
    )
    .all(...envio_ids, cliente_id);

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

  // `cotizaciones` se sigue aceptando para no romper la API y el botón manual "Cotizar"
  // por fila, pero la liquidación YA NO recotiza: el desglose se arma leyendo lo guardado
  // en el envío (ver calcularItem). El flujo automático de preview no depende del cotizador.
  void cotizaciones;

  const items = await Promise.all(
    envios.map((e) => calcularItem(e, cargoMap[e.id] || 0, cargosPorEnvio[e.id] || []))
  );
  const total = redondear2(items.reduce((s, i) => s + i.total_usd, 0));
  const utilidadTotal = redondear2(items.reduce((s, i) => s + (i.utilidad_usd || 0), 0));
  // Pendiente 52: la vista previa avisa si alguno de estos envíos ya está en otro borrador.
  const en_borrador = await borradoresConEnvios(envio_ids);
  return { items, total, utilidad_total: utilidadTotal, cantidad: items.length, en_borrador };
}

async function crear({
  cliente_id, periodo_desde, periodo_hasta, envio_ids, cargos = [], cotizaciones = [], confirmar = false,
  reemplazar_borradores = [], permitir_duplicado = false,
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
  const previewData = await preview({ cliente_id, envio_ids, cargos, cotizaciones });
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
        `INSERT INTO liquidaciones (cliente_id, periodo_desde, periodo_hasta, total, estado)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        cliente_id,
        periodo_desde,
        periodo_hasta,
        previewData.total,
        confirmar ? 'confirmada' : 'borrador'
      );
    const liquidacionId = liqResult.lastInsertRowid;

    const insertItem = db.prepare(
      `INSERT INTO liquidacion_items
        (liquidacion_id, envio_id, flete, fuel, seguro, adicional, total_usd, fuel_pct_usado,
         precio_cotizado, profit_pct, utilidad_usd, servicio_cotizado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        item.servicio_cotizado
      );
      const list = cargoByEnvio[item.envio_id] || [];
      for (const c of list) {
        await insertCargo.run(item.envio_id, liquidacionId, c.descripcion || 'Adicional', c.monto);
      }
      if (item.adicional > 0 && list.length === 0) {
        await insertCargo.run(item.envio_id, liquidacionId, 'Cargo adicional', item.adicional);
      }
    }

    if (confirmar) {
      // hoyLocal(): toISOString() es UTC y dejaba una liquidación confirmada el 31 a las
      // 22:00 fechada el 1 del mes siguiente.
      const fecha = hoyLocal();
      await envioModel.marcarLiquidados(envio_ids, liquidacionId, fecha);
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
    const guias = enCero.map((i) => i.numero_guia || `envío ${i.envio_id}`).join(', ');
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
async function confirmar(id, envioIdsEsperados = null) {
  const db = getDb();
  const liq = await buscarPorId(id);
  if (!liq) return null;
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
  const yaLiquidados = await db
    .prepare(
      `SELECT e.id, e.numero_guia, e.liquidacion_id FROM envios e
       WHERE e.id IN (${envioIds.map(() => '?').join(',')}) AND e.liquidado = 1`
    )
    .all(...envioIds);
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

  const fecha = hoyLocal();

  await db.transaction(async () => {
    await db.prepare(
      `UPDATE liquidaciones SET estado = 'confirmada', updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    ).run(id);
    await envioModel.marcarLiquidados(envioIds, id, fecha);
  });
  return buscarPorId(id);
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
              e.otros AS envio_otros, e.seguro AS envio_seguro, e.seguro_venta AS envio_seguro_venta
       FROM liquidacion_items li
       JOIN envios e ON e.id = li.envio_id
       WHERE li.liquidacion_id = ?
       ORDER BY e.fecha, e.numero_guia`
    )
    .all(id);

  const cargos = await db
    .prepare('SELECT * FROM cargos_adicionales WHERE liquidacion_id = ?')
    .all(id);

  // Detalle del Adicional de cada ítem (07/09): se deriva del envío con el MISMO helper que
  // usó el cálculo (read-only, no toca lo confirmado). Los envíos liquidados tienen la plata
  // congelada, así que el detalle es el de siempre. El extra manual sale de cargos_adicionales.
  for (const it of items) {
    const detalle = detallarAdicional({
      total_cobrado: it.total_cobrado,
      seguro: it.envio_seguro_venta ?? it.envio_seguro,
      adicionales: it.envio_adicionales,
      derechos: it.envio_derechos,
      otros: it.envio_otros,
      fuel_pct: it.fuel_pct_usado,
      extras: it.extras_json,
    });
    // La parte MANUAL es lo que la columna guardada tiene de más respecto del desglose del
    // envío. OJO: cargos_adicionales guarda también una fila espejo "Cargo adicional" con la
    // columna entera cuando no hubo extras manuales (ver crear()), así que no se puede leer
    // esa tabla a ciegas: se usa solo si sus filas suman exactamente la parte manual.
    const derivado = redondear2(detalle.reduce((s, d) => s + d.monto, 0));
    const manual = redondear2((Number(it.adicional) || 0) - derivado);
    if (manual > 0.005) {
      const filas = cargos.filter((c) => c.envio_id === it.envio_id && Number(c.monto) > 0);
      const sumaFilas = redondear2(filas.reduce((s, c) => s + Number(c.monto), 0));
      if (filas.length && Math.abs(sumaFilas - manual) < 0.011) {
        for (const c of filas) detalle.push({ tipo: 'manual', label: c.descripcion || 'Adicional de esta liquidación', monto: redondear2(c.monto) });
      } else {
        detalle.push({ tipo: 'manual', label: 'Adicional de esta liquidación', monto: manual });
      }
    }
    it.adicional_detalle = detalle;
    delete it.extras_json; delete it.envio_adicionales; delete it.envio_derechos;
    delete it.envio_otros; delete it.envio_seguro; delete it.envio_seguro_venta;
  }

  return { ...liq, items, cargos };
}

async function listar(filtros = {}) {
  const db = getDb();
  let sql = `
    SELECT l.*, COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre, c.tipo_cobro,
           (SELECT COUNT(*) FROM liquidacion_items WHERE liquidacion_id = l.id) AS cantidad_envios
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
  if (filtros.estado) {
    sql += ' AND l.estado = ?';
    params.push(filtros.estado);
  }

  sql += ' ORDER BY l.fecha DESC, l.id DESC';
  return db.prepare(sql).all(...params);
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
  if (liq.estado === 'confirmada') {
    const err = new Error('La liquidación está confirmada: no se puede borrar (habría que anularla, y eso es otra operación).');
    err.status = 409;
    throw err;
  }
  await db.transaction(async () => {
    await db.prepare('DELETE FROM liquidacion_items WHERE liquidacion_id = ?').run(id);
    // Los cargos adicionales pertenecen al ENVÍO; al morir el borrador quedan sueltos
    // (liquidacion_id NULL) y los levanta el próximo, igual que sus envíos.
    await db.prepare('UPDATE cargos_adicionales SET liquidacion_id = NULL WHERE liquidacion_id = ?').run(id);
    await db.prepare('DELETE FROM liquidaciones WHERE id = ?').run(id);
  });
  return true;
}

module.exports = {
  migrarColumnas,
  eliminarBorrador,
  borradoresConEnvios,
  preview,
  crear,
  confirmar,
  buscarPorId,
  listar,
  calcularItem,
  cotizarEnvio,
};
