// ── Panel de salud ──────────────────────────────────────────────────────────
//
// Corre un conjunto de chequeos de SOLO LECTURA sobre la base y el disco, y devuelve
// para cada uno una severidad, un conteo y el detalle de las filas involucradas.
//
// El motivo de que exista: los 9 limitadores que se venían arrastrando (envíos en dos
// liquidaciones, backups sin copia, clientes sin margen, guías facturadas sin envío)
// los encontró una auditoría manual. Una auditoría manual no se repite todas las
// semanas. Esto sí.
//
// TRES REGLAS que hay que respetar al agregar un chequeo:
//
//   1. **Nunca escribe.** Ni un UPDATE, ni un DELETE, ni un INSERT. El panel avisa;
//      la corrección la hace una persona en la pantalla que corresponde. Un panel que
//      "arregla solo" es un panel en el que nadie mira lo que arregló.
//
//   2. **Un chequeo que falla no puede tapar a los demás.** Cada uno corre dentro de
//      su propio try/catch y, si explota, se reporta con severidad 'error' y el mensaje
//      del error a la vista. Es exactamente el problema que tenían los backups: el
//      error se tragaba en silencio y nadie se enteraba hasta el día de restaurar.
//      Un chequeo roto tiene que gritar, no desaparecer.
//
//   3. **Cada alerta dice dónde se arregla.** El campo `link` apunta a la pantalla
//      concreta. Un aviso sin acción posible es ruido, y el ruido entrena a ignorar
//      el panel entero.
//
// Severidades: 'rojo' (plata en juego o riesgo de pérdida de datos) · 'ambar' (algo
// que hay que atender pero no sangra hoy) · 'ok' · 'error' (el chequeo no pudo correr).

const fs = require('fs');
const path = require('path');
const { getDb } = require('../db');
const config = require('../config');
const { hoyLocal, hoyLocalMas } = require('../utils/fecha');

// Tope de filas de detalle por chequeo. Si hay más, se informa cuántas quedaron afuera
// (`truncado`) — nunca se recorta en silencio: un panel que dice "5 casos" cuando hay
// 300 es peor que no tener panel.
const MAX_DETALLE = 50;

// Días en borrador a partir de los cuales una liquidación se considera olvidada.
// Elegido por Felipe el 03/08: una semana en borrador ya es raro.
const DIAS_BORRADOR = 7;

// Antigüedad máxima aceptable del último backup, en horas. El backup corre solo dentro
// de la app una vez por día; 26 h da margen para que la corrida del día se haya hecho
// un rato más tarde que la de ayer sin disparar una falsa alarma.
const HORAS_BACKUP = 26;

// Lo mismo, pero para la copia que sale del VPS a OneDrive (scripts/copia-externa.sh).
// Corre por cron una vez por día; 36 h deja pasar un atraso o un reinicio sin dar una
// falsa alarma, y no deja pasar dos días seguidos sin copia afuera.
const HORAS_COPIA_EXTERNA = 36;

function r2(n) {
  return Math.round((n || 0) * 100) / 100;
}

// Envuelve un chequeo para que su error quede A LA VISTA en vez de tumbar el panel.
async function correr(meta, fn) {
  try {
    const r = await fn();
    return { ...meta, ...r };
  } catch (err) {
    console.error(`[salud] El chequeo "${meta.id}" falló:`, err);
    return {
      ...meta,
      severidad: 'error',
      cantidad: null,
      resumen: 'Este chequeo no pudo correr, así que no sabemos si hay problema o no.',
      error: err.message,
      detalle: [],
    };
  }
}

// Recorta el detalle al tope y deja dicho cuántas filas quedaron afuera.
function acotar(filas) {
  if (filas.length <= MAX_DETALLE) return { detalle: filas, truncado: 0 };
  return { detalle: filas.slice(0, MAX_DETALLE), truncado: filas.length - MAX_DETALLE };
}

// ── 1. Un envío en más de una liquidación ───────────────────────────────────
// El limitador L1. Envíos 31 y 147 en producción: cada uno en un borrador y en una
// confirmada. Confirmar el borrador refactura el envío entero.
//
// ⚠️ La versión anterior de este comentario decía "hoy no se duplica plata": ERA FALSO.
// La auditoría del 07/08 reprodujo dos liquidaciones confirmadas con los mismos envíos,
// USD 500 cada una. Desde el 13/08 `confirmar()` rechaza envíos ya liquidados (409), así
// que los borradores duplicados que existan dejaron de poder confirmarse — pero este
// chequeo sigue haciendo falta para verlos y limpiarlos.
//
// Se reporta ROJO siempre que haya más de un item, incluso si solo uno está confirmado:
// el riesgo es justamente el borrador que todavía nadie confirmó.
async function chequeoEnvioEnVariasLiquidaciones(db) {
  const filas = await db.prepare(`
    SELECT
      li.envio_id,
      COUNT(*)                         AS items,
      SUM(li.total_usd)                AS total_items,
      e.numero_guia,
      c.nombre                         AS cliente,
      GROUP_CONCAT(l.id || ':' || l.estado, ', ') AS liquidaciones,
      SUM(CASE WHEN l.estado = 'confirmada' THEN 1 ELSE 0 END) AS confirmadas
    FROM liquidacion_items li
    JOIN liquidaciones l ON l.id = li.liquidacion_id
    LEFT JOIN envios   e ON e.id = li.envio_id
    LEFT JOIN clientes c ON c.id = e.cliente_id
    GROUP BY li.envio_id
    HAVING COUNT(*) > 1
    ORDER BY SUM(li.total_usd) DESC
  `).all();

  if (!filas.length) {
    return { severidad: 'ok', cantidad: 0, resumen: 'Ningún envío está cargado en dos liquidaciones.', detalle: [] };
  }

  // Plata en riesgo = lo que se volvería a facturar si se confirmaran los items que
  // hoy están en borrador. Es el número que hace que esto sea rojo y no ámbar.
  const enRiesgo = r2(filas.reduce((acc, f) => {
    const promedio = (f.total_items || 0) / (f.items || 1);
    return acc + promedio * Math.max(0, f.items - 1);
  }, 0));

  return {
    severidad: 'rojo',
    cantidad: filas.length,
    resumen:
      `${filas.length} envío(s) cargados en más de una liquidación. `
      + `Si se confirman los duplicados se refacturan unos USD ${enRiesgo.toFixed(2)}.`,
    monto: enRiesgo,
    ...acotar(filas.map((f) => ({
      envio: f.numero_guia || `#${f.envio_id}`,
      cliente: f.cliente || '—',
      liquidaciones: f.liquidaciones,
      veces: f.items,
      monto: r2(f.total_items),
    }))),
  };
}

// ── 2. Guías que el courier facturó y no tienen envío ───────────────────────
// Plata que ya pagamos y que no está atada a ningún envío, así que no se le cobró a
// nadie. El backend las venía guardando (`factura_guias.encontrada = 0`); la pantalla
// que las muestra existe desde el 30/07, pero hay que acordarse de entrar.
// Se agrupa por numero_guia, NO por fila. Si una factura se cargo dos veces (ver el
// chequeo `facturas_duplicadas`) la misma guia tiene dos filas en `factura_guias`, y
// contar filas duplicaria la plata informada. La guia es la unidad real, no la fila.
async function chequeoGuiasSinEnvio(db) {
  const filas = await db.prepare(`
    SELECT fg.numero_guia,
           MAX(fg.pais)           AS pais,
           MAX(fg.peso_facturado) AS peso_facturado,
           MAX(fg.costo_total)    AS costo_total,
           MAX(f.numero_factura)  AS numero_factura,
           MAX(f.fecha_factura)   AS fecha_factura,
           COUNT(*)               AS filas
    FROM factura_guias fg
    LEFT JOIN facturas_cargadas f ON f.id = fg.factura_id
    WHERE fg.encontrada = 0
    GROUP BY fg.numero_guia
    ORDER BY MAX(fg.costo_total) DESC
  `).all();

  if (!filas.length) {
    return { severidad: 'ok', cantidad: 0, resumen: 'Todas las guías facturadas tienen su envío cargado.', detalle: [] };
  }

  const total = r2(filas.reduce((a, f) => a + (f.costo_total || 0), 0));
  return {
    severidad: 'rojo',
    cantidad: filas.length,
    monto: total,
    resumen:
      `${filas.length} guía(s) facturadas sin envío en el sistema, por USD ${total.toFixed(2)}. `
      + 'Es plata pagada al courier que no se le facturó a ningún cliente.',
    ...acotar(filas.map((f) => ({
      guia: f.numero_guia,
      pais: f.pais || '—',
      kg: f.peso_facturado,
      costo: r2(f.costo_total),
      factura: f.numero_factura || '—',
    }))),
  };
}

// ── 3. Facturas del courier que no cuadran ──────────────────────────────────
// La suma de las guías (más la percepción repartida) tiene que dar el total declarado
// de la factura. Cuando no da, la diferencia son cargos que estamos pagando y no
// estamos imputando a ningún envío: el margen queda inflado por esa diferencia.
//
// Depende de que la carga haya guardado `total_declarado`. Las facturas cargadas antes
// de que existiera esa columna no se pueden verificar, y se informan aparte en vez de
// darlas por buenas.
async function chequeoFacturasQueNoCuadran(db) {
  const filas = await db.prepare(`
    SELECT
      f.id, f.numero_factura, f.fecha_factura, f.total_declarado,
      COALESCE(SUM(fg.costo_total), 0) AS suma_guias,
      COALESCE(SUM(fg.percepcion), 0)  AS suma_percepcion,
      COUNT(fg.id)                     AS guias,
      SUM(CASE WHEN fg.costo_total IS NULL THEN 1 ELSE 0 END) AS sin_costo
    FROM facturas_cargadas f
    LEFT JOIN factura_guias fg ON fg.factura_id = f.id
    GROUP BY f.id
    ORDER BY f.fecha_factura DESC
  `).all();

  const sinTotal = filas.filter((f) => f.total_declarado == null);
  const descuadradas = filas
    .filter((f) => f.total_declarado != null)
    .map((f) => ({ ...f, dif: r2(f.total_declarado - (f.suma_guias + f.suma_percepcion)) }))
    .filter((f) => Math.abs(f.dif) >= 0.05);

  const conAgujeros = filas.filter((f) => f.sin_costo > 0);

  if (!descuadradas.length && !sinTotal.length && !conAgujeros.length) {
    return { severidad: 'ok', cantidad: 0, resumen: 'Todas las facturas cargadas cuadran con el detalle por guía.', detalle: [] };
  }

  const partes = [];
  if (descuadradas.length) {
    const dif = r2(descuadradas.reduce((a, f) => a + Math.abs(f.dif), 0));
    partes.push(`${descuadradas.length} factura(s) no cuadran por USD ${dif.toFixed(2)} en total`);
  }
  if (conAgujeros.length) partes.push(`${conAgujeros.length} con guías sin costo`);
  if (sinTotal.length) partes.push(`${sinTotal.length} cargadas antes de que se guardara el total, no verificables`);

  const detalle = [
    ...descuadradas.map((f) => ({
      factura: f.numero_factura || `#${f.id}`,
      fecha: f.fecha_factura || '—',
      total_factura: r2(f.total_declarado),
      suma_guias: r2(f.suma_guias + f.suma_percepcion),
      diferencia: f.dif,
      nota: 'No cuadra',
    })),
    ...conAgujeros.filter((f) => !descuadradas.some((d) => d.id === f.id)).map((f) => ({
      factura: f.numero_factura || `#${f.id}`,
      fecha: f.fecha_factura || '—',
      total_factura: f.total_declarado != null ? r2(f.total_declarado) : null,
      suma_guias: r2(f.suma_guias + f.suma_percepcion),
      diferencia: null,
      nota: `${f.sin_costo} guía(s) sin costo`,
    })),
    ...sinTotal.filter((f) => f.sin_costo === 0).map((f) => ({
      factura: f.numero_factura || `#${f.id}`,
      fecha: f.fecha_factura || '—',
      total_factura: null,
      suma_guias: r2(f.suma_guias + f.suma_percepcion),
      diferencia: null,
      nota: 'Sin total guardado, no verificable',
    })),
  ];

  return {
    // Descuadre real = rojo (es plata). Solo "no verificable" = ámbar.
    severidad: descuadradas.length || conAgujeros.length ? 'rojo' : 'ambar',
    cantidad: detalle.length,
    resumen: `${partes.join('. ')}.`,
    ...acotar(detalle),
  };
}

// ── 4. Desvíos contra la factura sin revisar ────────────────────────────────
// Misma regla que el semáforo de Salidas, a propósito: rojo solo si el courier facturó
// de MÁS (a favor nuestro no se pinta nunca) y supera al menos uno de los dos umbrales
// del courier (% o absoluto). Si acá se usara otra regla, el panel y la pantalla se
// contradirían y ganaría el que mira último.
async function chequeoDesviosSinRevisar(db) {
  const tolRows = await db.prepare('SELECT courier, tolerancia_costo_pct, tolerancia_costo_usd, tolerancia_peso_pct, tolerancia_peso_kg FROM configuracion').all();
  const tol = {};
  for (const t of tolRows) tol[t.courier] = t;

  const envios = await db.prepare(`
    SELECT e.id, e.numero_guia, e.courier, e.estado_revision, e.costo_facturado,
           e.peso_facturable, e.peso_facturado,
           e.flete, e.descuento, e.seguro, e.fuel, e.derechos, e.adicionales, e.otros,
           c.nombre AS cliente
    FROM envios e
    LEFT JOIN clientes c ON c.id = e.cliente_id
    WHERE e.costo_facturado IS NOT NULL
      AND (e.estado_revision IS NULL OR e.estado_revision = 'pendiente')
  `).all();

  const { costoEstimado } = require('../utils/profit');
  const filas = [];
  for (const e of envios) {
    const t = tol[e.courier] || {};
    const base = costoEstimado(e);
    if (!base) continue;
    const abs = e.costo_facturado - base;
    const pct = (abs / base) * 100;
    const superaPct = t.tolerancia_costo_pct != null && pct > t.tolerancia_costo_pct;
    const superaAbs = t.tolerancia_costo_usd != null && abs > t.tolerancia_costo_usd;
    if (abs > 0 && (superaPct || superaAbs)) {
      filas.push({
        guia: e.numero_guia || `#${e.id}`,
        cliente: e.cliente || '—',
        courier: e.courier,
        estimado: r2(base),
        facturado: r2(e.costo_facturado),
        de_mas: r2(abs),
        desvio: `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`,
      });
    }
  }
  filas.sort((a, b) => b.de_mas - a.de_mas);

  if (!filas.length) {
    return { severidad: 'ok', cantidad: 0, resumen: 'No hay desvíos de costo fuera de tolerancia esperando revisión.', detalle: [] };
  }
  const total = r2(filas.reduce((a, f) => a + f.de_mas, 0));
  return {
    severidad: 'rojo',
    cantidad: filas.length,
    monto: total,
    resumen:
      `${filas.length} envío(s) donde el courier facturó USD ${total.toFixed(2)} de más que lo estimado, `
      + 'y nadie los revisó todavía.',
    ...acotar(filas),
  };
}

// ── 5. Fuel congelado distinto al de Configuración ──────────────────────────
// El fuel se congela en el envío al momento de cargarlo, y eso está bien. El problema
// es cuando se congeló un valor que ya no existía: en producción aparecieron 4 envíos
// con 39 % cuando la configuración decía 33 %, porque el frontend tenía el 39
// hardcodeado. Este chequeo mira solo los últimos 60 días — más atrás la diferencia es
// legítima (el fuel cambió 5 veces en 2 meses).
async function chequeoFuelDesfasado(db) {
  const cfg = await db.prepare('SELECT courier, fuel_pct FROM configuracion').all();
  const actual = {};
  for (const c of cfg) actual[c.courier] = c.fuel_pct;

  const desde = hoyLocalMas(-60);
  const envios = await db.prepare(`
    SELECT e.id, e.numero_guia, e.fecha, e.courier, e.fuel_pct, c.nombre AS cliente
    FROM envios e
    LEFT JOIN clientes c ON c.id = e.cliente_id
    WHERE e.fecha >= ? AND e.fuel_pct IS NOT NULL
    ORDER BY e.fecha DESC
  `).all(desde);

  const filas = envios
    .filter((e) => actual[e.courier] != null && Math.abs(e.fuel_pct - actual[e.courier]) > 0.001)
    .map((e) => ({
      guia: e.numero_guia || `#${e.id}`,
      cliente: e.cliente || '—',
      fecha: e.fecha,
      courier: e.courier,
      fuel_del_envio: e.fuel_pct,
      fuel_de_config: actual[e.courier],
    }));

  if (!filas.length) {
    return { severidad: 'ok', cantidad: 0, resumen: 'Todos los envíos de los últimos 60 días usan el fuel de Configuración.', detalle: [] };
  }
  return {
    severidad: 'ambar',
    cantidad: filas.length,
    resumen:
      `${filas.length} envío(s) de los últimos 60 días quedaron con un fuel distinto al de Configuración. `
      + 'Puede ser un cambio legítimo de fuel a mitad de período, o un valor hardcodeado disparando.',
    ...acotar(filas),
  };
}

// ── 6. Clientes activos sin margen configurado ──────────────────────────────
// El limitador L4. El profit automático del cotizador existe desde principios de julio
// y sirve para los clientes que tienen el dato cargado. Los que no lo tienen cotizan
// con lo que haya. La función está; los datos no.
async function chequeoClientesSinMargen(db) {
  const cols = (await db.prepare('PRAGMA table_info(clientes)').all()).map((c) => c.name);
  const tieneModo = cols.includes('modo_tarifa');

  const filas = await db.prepare(`
    SELECT c.id, c.nombre, c.tarifa_pct,
           (SELECT COUNT(*) FROM profit_overrides po WHERE po.cliente_id = c.id) AS overrides
    FROM clientes c
    WHERE c.activo = 1
      ${tieneModo ? "AND COALESCE(c.modo_tarifa, 'porcentaje') = 'porcentaje'" : ''}
      AND (c.tarifa_pct IS NULL OR c.tarifa_pct = 0)
    ORDER BY c.nombre COLLATE NOCASE
  `).all();

  const sinNada = filas.filter((f) => !f.overrides);
  if (!sinNada.length) {
    return { severidad: 'ok', cantidad: 0, resumen: 'Todos los clientes activos tienen margen configurado.', detalle: [] };
  }

  const totalActivos = (await db.prepare('SELECT COUNT(*) n FROM clientes WHERE activo = 1').get()).n;
  return {
    severidad: 'ambar',
    cantidad: sinNada.length,
    resumen:
      `${sinNada.length} de ${totalActivos} clientes activos no tienen ni porcentaje ni matriz de margen. `
      + 'El cotizador automático no les puede calcular la ganancia.',
    ...acotar(sinNada.map((f) => ({ cliente: f.nombre, tarifa_pct: f.tarifa_pct ?? '—', matriz: f.overrides }))),
  };
}

// ── 7. Clientes en modo "por kilo" sin tarifa cargada ───────────────────────
// El agujero más silencioso de los que hay. Un cliente marcado como "precio fijo por
// kilo" al que le falta el rango cotiza igual: el motor cae al porcentaje de ganancia
// y sigue. Está hecho a propósito (mejor eso que cotizar cero), pero si nadie mira el
// cartel, el cliente termina pagando una tarifa que no es la suya y nadie se entera.
async function chequeoClientesPorKgSinTarifa(db) {
  const tablas = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).map((t) => t.name);
  const cols = (await db.prepare('PRAGMA table_info(clientes)').all()).map((c) => c.name);
  if (!cols.includes('modo_tarifa') || !tablas.includes('tarifa_kg_overrides')) {
    return {
      severidad: 'ok',
      cantidad: 0,
      resumen: 'La tarifa por kilo todavía no está migrada en esta base; no hay nada que chequear.',
      detalle: [],
    };
  }

  const filas = await db.prepare(`
    SELECT c.id, c.nombre,
           (SELECT COUNT(*) FROM tarifa_kg_overrides t WHERE t.cliente_id = c.id) AS rangos
    FROM clientes c
    WHERE c.activo = 1 AND c.modo_tarifa = 'por_kg'
    ORDER BY c.nombre COLLATE NOCASE
  `).all();

  const vacios = filas.filter((f) => !f.rangos);
  if (!vacios.length) {
    return { severidad: 'ok', cantidad: 0, resumen: 'Los clientes en modo por kilo tienen sus rangos cargados.', detalle: [] };
  }
  return {
    severidad: 'rojo',
    cantidad: vacios.length,
    resumen:
      `${vacios.length} cliente(s) están en modo "precio por kilo" pero no tienen ni un rango cargado. `
      + 'Cotizan con el porcentaje de ganancia, que no es la tarifa que se les acordó.',
    ...acotar(vacios.map((f) => ({ cliente: f.nombre, rangos_cargados: f.rangos }))),
  };
}

// ── 8. Clientes duplicados ──────────────────────────────────────────────────
// GERSCOVICH/Gerscovich y OPEN POLO/Open Polo. Parten la facturación de un mismo
// cliente en dos, y el margen configurado en uno no aplica al otro.
async function chequeoClientesDuplicados(db) {
  const filas = await db.prepare(`
    SELECT LOWER(TRIM(nombre)) AS clave,
           COUNT(*) AS n,
           GROUP_CONCAT(nombre, ' | ') AS nombres,
           GROUP_CONCAT(id, ', ')      AS ids
    FROM clientes
    GROUP BY LOWER(TRIM(nombre))
    HAVING COUNT(*) > 1
    ORDER BY clave
  `).all();

  if (!filas.length) {
    return { severidad: 'ok', cantidad: 0, resumen: 'No hay clientes con el mismo nombre.', detalle: [] };
  }
  return {
    severidad: 'ambar',
    cantidad: filas.length,
    resumen: `${filas.length} nombre(s) de cliente cargados más de una vez. Parten la facturación en dos.`,
    ...acotar(filas.map((f) => ({ nombres: f.nombres, ids: f.ids, veces: f.n }))),
  };
}

// ── 9. Envíos de meses cerrados sin precio de venta ─────────────────────────
// Cargar el envío sin precio y ponérselo al liquidar es el flujo normal, así que el mes
// en curso NO cuenta. Lo que no es normal es que quede así un mes que ya cerró: ese
// envío no se le cobró a nadie.
async function chequeoEnviosSinPrecio(db) {
  const primerDiaMes = `${hoyLocal().slice(0, 7)}-01`;
  const filas = await db.prepare(`
    SELECT e.id, e.numero_guia, e.fecha, e.courier, c.nombre AS cliente, e.liquidacion_id
    FROM envios e
    LEFT JOIN clientes c ON c.id = e.cliente_id
    WHERE e.fecha < ?
      AND (e.total_cobrado IS NULL OR e.total_cobrado = 0)
      AND e.liquidacion_id IS NULL
      -- Un envio marcado NO VOLO no se le cobra a nadie a proposito: no es un olvido.
      AND e.no_volo = 0
    ORDER BY e.fecha
  `).all(primerDiaMes);

  if (!filas.length) {
    return { severidad: 'ok', cantidad: 0, resumen: 'Todos los envíos de meses cerrados tienen precio o están liquidados.', detalle: [] };
  }
  return {
    severidad: 'ambar',
    cantidad: filas.length,
    resumen:
      `${filas.length} envío(s) de meses ya cerrados quedaron sin precio de venta y sin liquidar. `
      + 'Son envíos que se despacharon y no se le cobraron a nadie.',
    ...acotar(filas.map((f) => ({
      guia: f.numero_guia || `#${f.id}`,
      cliente: f.cliente || '—',
      fecha: f.fecha,
      courier: f.courier,
    }))),
  };
}

// ── 10. Backups ─────────────────────────────────────────────────────────────
// El limitador L2. Mira dos cosas distintas:
//
//  · Las copias LOCALES, las que hace la app sola en el disco del VPS: que haya una
//    reciente, que la serie no se haya cortado, y que la última no haya encogido de
//    golpe (un backup truncado se ve igual de bien que uno bueno en un `ls`).
//
//  · La copia EXTERNA, la que scripts/copia-externa.sh manda a OneDrive todos los días.
//    Es la única que sobrevive a que se pierda el VPS entero. Este chequeo lee la marca
//    que deja ese script, no OneDrive: le alcanza con saber si el trabajo corrió y cómo
//    le fue.
//
// La copia externa es lo que decide el color de fondo. Un backup local impecable con la
// copia externa cortada hace una semana NO es un backup: es una copia en el mismo disco
// que la cosa que se puede perder. Antes esto avisaba en ámbar permanente, y un aviso
// que está siempre encendido es un aviso que nadie mira.
function leerCopiaExterna(dir) {
  const marca = path.join(dir, '.copia-externa.json');
  if (!fs.existsSync(marca)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(marca, 'utf8'));
    const cuando = new Date(m.cuando);
    return {
      ok: m.ok === true,
      error: m.error || null,
      destino: m.destino || '—',
      archivo: m.archivo || '',
      copias: Number(m.copias_remotas) || 0,
      horas: Number.isNaN(cuando.getTime()) ? null : (Date.now() - cuando.getTime()) / 3600000,
      cuando: Number.isNaN(cuando.getTime()) ? '—' : cuando.toISOString().slice(0, 16).replace('T', ' '),
    };
  } catch (e) {
    return { ok: false, error: `la marca de la copia externa está ilegible (${e.message})`, horas: null, copias: 0, destino: '—', archivo: '', cuando: '—' };
  }
}

function chequeoBackups() {
  const dir = path.join(path.dirname(config.dbPath), 'backups');
  if (!fs.existsSync(dir)) {
    return {
      severidad: 'rojo',
      cantidad: 0,
      resumen: `No existe la carpeta de backups (${dir}). No hay ninguna copia de la base.`,
      detalle: [],
    };
  }

  const archivos = fs.readdirSync(dir)
    .filter((f) => f.startsWith('nova_backup_') && f.endsWith('.db'))
    .sort()
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { archivo: f, tamano_kb: Math.round(st.size / 1024), fecha: st.mtime };
    });

  if (!archivos.length) {
    return { severidad: 'rojo', cantidad: 0, resumen: 'La carpeta de backups está vacía.', detalle: [] };
  }

  const ultimo = archivos[archivos.length - 1];
  const horas = (Date.now() - ultimo.fecha.getTime()) / 3600000;
  const problemas = [];
  let severidad = 'ok';

  if (horas > HORAS_BACKUP) {
    severidad = 'rojo';
    problemas.push(`el último backup tiene ${Math.floor(horas / 24)} día(s) de antigüedad`);
  }

  // Encogimiento de golpe respecto del anterior: > 10 % menos es sospechoso.
  if (archivos.length > 1) {
    const previo = archivos[archivos.length - 2];
    if (previo.tamano_kb > 0 && ultimo.tamano_kb < previo.tamano_kb * 0.9) {
      severidad = 'rojo';
      problemas.push(`el último backup pesa ${ultimo.tamano_kb} KB contra ${previo.tamano_kb} KB del anterior`);
    }
  }

  // ── La copia que se va del VPS ────────────────────────────────────────────
  const ext = leerCopiaExterna(dir);
  let resumenExterna;

  if (!ext) {
    // Nunca corrió: es el estado que había antes de armar esto.
    if (severidad === 'ok') severidad = 'ambar';
    resumenExterna = 'No hay copia fuera del VPS: las copias están todas en el mismo disco que la base.';
  } else if (!ext.ok) {
    severidad = 'rojo';
    resumenExterna = `La copia a ${ext.destino} FALLÓ (${ext.cuando}): ${ext.error || 'sin detalle'}.`;
  } else if (ext.horas === null || ext.horas > HORAS_COPIA_EXTERNA) {
    severidad = 'rojo';
    const dias = ext.horas === null ? '?' : Math.floor(ext.horas / 24);
    resumenExterna = `La copia a ${ext.destino} dejó de correr: la última fue hace ${dias} día(s) (${ext.cuando}).`;
  } else {
    resumenExterna =
      `Copia fuera del VPS OK: ${ext.copias} copia(s) en ${ext.destino}, `
      + `la última hace ${ext.horas < 1 ? 'menos de una hora' : `${Math.round(ext.horas)} h`}.`;
  }

  return {
    severidad,
    cantidad: archivos.length,
    resumen:
      `${archivos.length} backup(s) en el VPS, el último de hace `
      + `${horas < 1 ? 'menos de una hora' : `${Math.round(horas)} h`}`
      + `${problemas.length ? `; ${problemas.join('; ')}` : ''}. ${resumenExterna}`,
    ...acotar(archivos.slice(-10).reverse().map((a) => ({
      archivo: a.archivo,
      tamano_kb: a.tamano_kb,
      fecha: a.fecha.toISOString().slice(0, 16).replace('T', ' '),
    }))),
  };
}

// ── 10.b Cierres de mes sin hacer ───────────────────────────────────────────
// El cierre de mes es la copia que NO depende de nosotros: la planilla que administración
// baja y guarda en su computadora, y que sirve incluso si se pierden el sistema, el VPS y
// OneDrive juntos. Su punto débil es obvio y humano: depende de que alguien se acuerde.
//
// Esta clase de rutina no se abandona de golpe, se abandona de a poco. Por eso el chequeo
// mira los ÚLTIMOS TRES MESES CERRADOS y no solo el anterior: un mes suelto sin cerrar es
// un descuido, dos o tres es una costumbre que se murió.
//
// Los primeros días del mes no cuentan: nadie cierra julio el 1 de agosto a la mañana.
const DIAS_GRACIA_CIERRE = 5;

async function chequeoCierres(db) {
  const hoy = new Date(`${hoyLocal()}T12:00:00`);
  const p = (n) => String(n).padStart(2, '0');

  // Los meses completos hacia atrás. Si estamos dentro de la gracia, el mes recién
  // terminado todavía no se le reclama a nadie.
  const saltar = hoy.getDate() <= DIAS_GRACIA_CIERRE ? 1 : 0;
  const meses = [];
  for (let i = 1 + saltar; i <= 3 + saltar; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    meses.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}`);
  }

  const filas = await db.prepare(`
    SELECT tipo, desde, hasta, filas, usuario, creado_en
    FROM cierres WHERE tipo = 'mes' ORDER BY desde DESC LIMIT 24`).all();
  const cerrados = new Set(filas.map((f) => String(f.desde).slice(0, 7)));
  const faltan = meses.filter((m) => !cerrados.has(m));

  if (!filas.length) {
    return {
      severidad: 'ambar',
      cantidad: meses.length,
      resumen:
        'Nunca se hizo un cierre de mes. Es la copia que se guarda fuera del sistema, en '
        + 'la computadora de administración: la única que sirve si se pierde todo lo demás.',
      detalle: meses.map((m) => ({ mes: m, estado: 'sin cerrar' })),
    };
  }

  const ultimo = filas[0];
  const detalle = meses.map((m) => {
    const f = filas.find((x) => String(x.desde).slice(0, 7) === m);
    return f
      ? { mes: m, estado: 'cerrado', envios: f.filas, por: f.usuario || '—', cuando: f.creado_en }
      : { mes: m, estado: 'SIN CERRAR', envios: '—', por: '—', cuando: '—' };
  });

  if (!faltan.length) {
    return {
      severidad: 'ok',
      cantidad: 0,
      resumen:
        `Los últimos ${meses.length} meses están archivados. El último cierre fue `
        + `${String(ultimo.desde).slice(0, 7)} (${ultimo.filas} envíos, por ${ultimo.usuario || '—'}).`,
      ...acotar(detalle),
    };
  }

  return {
    severidad: faltan.length >= 2 ? 'rojo' : 'ambar',
    cantidad: faltan.length,
    resumen:
      `${faltan.length === 1 ? 'Falta el cierre de' : 'Faltan los cierres de'} ${faltan.join(', ')}. `
      + `El último que se archivó fue ${String(ultimo.desde).slice(0, 7)}. `
      + 'Se baja desde Salidas, con el botón "Cierre · Mes".',
    ...acotar(detalle),
  };
}

// ── 11. Liquidaciones en borrador olvidadas ─────────────────────────────────
async function chequeoBorradoresViejos(db) {
  const corte = hoyLocalMas(-DIAS_BORRADOR);
  const filas = await db.prepare(`
    SELECT l.id, l.fecha, l.total, l.periodo_desde, l.periodo_hasta,
           c.nombre AS cliente,
           (SELECT COUNT(*) FROM liquidacion_items li WHERE li.liquidacion_id = l.id) AS envios
    FROM liquidaciones l
    LEFT JOIN clientes c ON c.id = l.cliente_id
    WHERE l.estado = 'borrador'
      AND COALESCE(l.fecha, DATE(l.created_at)) < ?
    ORDER BY l.fecha
  `).all(corte);

  if (!filas.length) {
    return { severidad: 'ok', cantidad: 0, resumen: `No hay liquidaciones en borrador de más de ${DIAS_BORRADOR} días.`, detalle: [] };
  }
  return {
    severidad: 'ambar',
    cantidad: filas.length,
    resumen:
      `${filas.length} liquidación(es) llevan más de ${DIAS_BORRADOR} días en borrador. `
      + 'O se olvidaron, o hay algo trabado.',
    ...acotar(filas.map((f) => ({
      liquidacion: `#${f.id}`,
      cliente: f.cliente || '—',
      fecha: f.fecha || '—',
      envios: f.envios,
      total: r2(f.total),
    }))),
  };
}

// ── 12. Filas huérfanas ─────────────────────────────────────────────────────
// El limitador L6: 4 filas de `envio_bultos` (53-56) sobrevivieron al script de vaciado
// del 30/06 porque `PRAGMA foreign_keys` es por conexión y ese script no la prendió.
// El daño concreto es chico; lo que importa es que un script suelto contra la base
// puede volver a hacerlo, y este chequeo lo detecta la próxima vez.
async function chequeoHuerfanos(db) {
  const consultas = [
    ['envio_bultos sin envío', 'SELECT COUNT(*) n FROM envio_bultos b LEFT JOIN envios e ON e.id = b.envio_id WHERE e.id IS NULL'],
    ['liquidacion_items sin envío', 'SELECT COUNT(*) n FROM liquidacion_items li LEFT JOIN envios e ON e.id = li.envio_id WHERE e.id IS NULL'],
    ['liquidacion_items sin liquidación', 'SELECT COUNT(*) n FROM liquidacion_items li LEFT JOIN liquidaciones l ON l.id = li.liquidacion_id WHERE l.id IS NULL'],
    ['factura_guias sin factura', 'SELECT COUNT(*) n FROM factura_guias fg LEFT JOIN facturas_cargadas f ON f.id = fg.factura_id WHERE f.id IS NULL'],
    ['envíos sin cliente', 'SELECT COUNT(*) n FROM envios e LEFT JOIN clientes c ON c.id = e.cliente_id WHERE c.id IS NULL'],
    ['pickups sin cliente', 'SELECT COUNT(*) n FROM pickups p LEFT JOIN clientes c ON c.id = p.cliente_id WHERE c.id IS NULL'],
    ['cobranzas sin cliente', 'SELECT COUNT(*) n FROM cobranzas co LEFT JOIN clientes c ON c.id = co.cliente_id WHERE c.id IS NULL'],
  ];

  const filas = [];
  for (const [nombre, sql] of consultas) {
    const { n } = await db.prepare(sql).get();
    if (n > 0) filas.push({ relacion: nombre, filas: n });
  }

  if (!filas.length) {
    return { severidad: 'ok', cantidad: 0, resumen: 'No hay filas huérfanas en la base.', detalle: [] };
  }
  const total = filas.reduce((a, f) => a + f.filas, 0);
  return {
    severidad: 'ambar',
    cantidad: total,
    resumen:
      `${total} fila(s) apuntan a un registro que ya no existe. `
      + 'Suele ser el rastro de un script corrido a mano contra la base.',
    detalle: filas,
    truncado: 0,
  };
}

// ── 13. La misma factura del courier cargada más de una vez ─────────────────
// Encontrado el 03/08 probando el panel contra la base local: la factura UPS
// 0020-00074402 está cargada DOS veces, como dos cabeceras distintas, con sus 10 guías
// cada una — 20 filas de detalle para 10 guías reales.
//
// El motivo: al cargar una factura ya cargada, la app pide confirmación ("marcá
// sobreescribir"), pero "sobreescribir" solo saltea el aviso. **No borra la carga
// anterior**: inserta una segunda cabecera al lado de la primera. El nombre promete un
// reemplazo y lo que hace es un duplicado.
//
// Efecto: todo lo que sume sobre `factura_guias` cuenta esa plata dos veces. Es
// exactamente lo que pasó acá: la lista de guías facturadas sin envío mostraba 8 guías
// por USD 3.077 cuando en realidad son 4 por USD 1.538.
//
// Este chequeo detecta el estado; el arreglo del flujo de carga es otro trabajo.
async function chequeoFacturasDuplicadas(db) {
  const filas = await db.prepare(`
    SELECT numero_factura,
           COUNT(*)                          AS veces,
           GROUP_CONCAT(id, ', ')            AS ids,
           GROUP_CONCAT(fecha_carga, ' | ')  AS cargas,
           SUM(cantidad_guias)               AS guias_sumadas
    FROM facturas_cargadas
    WHERE numero_factura IS NOT NULL AND numero_factura <> ''
    GROUP BY numero_factura
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
  `).all();

  if (!filas.length) {
    return { severidad: 'ok', cantidad: 0, resumen: 'Ninguna factura del courier está cargada más de una vez.', detalle: [] };
  }

  // Plata contada de más: lo que aportan las cargas repetidas por encima de la primera.
  const demas = await db.prepare(`
    SELECT COALESCE(SUM(fg.costo_total), 0) AS total
    FROM factura_guias fg
    WHERE fg.factura_id NOT IN (
      SELECT MIN(id) FROM facturas_cargadas
      WHERE numero_factura IS NOT NULL AND numero_factura <> ''
      GROUP BY numero_factura
    )
  `).get();

  return {
    severidad: 'rojo',
    cantidad: filas.length,
    monto: r2(demas.total),
    resumen:
      `${filas.length} factura(s) del courier están cargadas más de una vez. `
      + `Toda suma sobre el detalle cuenta USD ${r2(demas.total).toFixed(2)} de más. `
      + 'Volver a cargar una factura con "sobreescribir" NO reemplaza la carga anterior: agrega otra.',
    ...acotar(filas.map((f) => ({
      factura: f.numero_factura,
      veces: f.veces,
      ids: f.ids,
      cargas: f.cargas,
      guias_sumadas: f.guias_sumadas,
    }))),
  };
}

// ── Orquestador ─────────────────────────────────────────────────────────────

const GRUPOS = { plata: 'Plata', datos: 'Datos que faltan', higiene: 'Higiene del sistema' };

async function correrChequeos() {
  const db = getDb();

  const chequeos = await Promise.all([
    correr({ id: 'envio_en_varias_liquidaciones', grupo: 'plata', titulo: 'Envíos en más de una liquidación',
      link: { href: 'liquidaciones.html', texto: 'Ir a Liquidaciones' } }, () => chequeoEnvioEnVariasLiquidaciones(db)),

    correr({ id: 'guias_sin_envio', grupo: 'plata', titulo: 'Guías facturadas sin envío cargado',
      link: { href: 'facturas.html', texto: 'Ir a Facturas' } }, () => chequeoGuiasSinEnvio(db)),

    correr({ id: 'facturas_no_cuadran', grupo: 'plata', titulo: 'Facturas del courier que no cuadran',
      link: { href: 'facturas.html', texto: 'Ir a Facturas' } }, () => chequeoFacturasQueNoCuadran(db)),

    correr({ id: 'facturas_duplicadas', grupo: 'plata', titulo: 'Facturas del courier cargadas dos veces',
      link: { href: 'facturas.html', texto: 'Ir a Facturas' } }, () => chequeoFacturasDuplicadas(db)),

    correr({ id: 'desvios_sin_revisar', grupo: 'plata', titulo: 'Desvíos contra la factura sin revisar',
      link: { href: 'salidas.html', texto: 'Ir a Salidas' } }, () => chequeoDesviosSinRevisar(db)),

    correr({ id: 'fuel_desfasado', grupo: 'plata', titulo: 'Envíos con un fuel distinto al de Configuración',
      link: { href: 'salidas.html', texto: 'Ir a Salidas' } }, () => chequeoFuelDesfasado(db)),

    correr({ id: 'clientes_sin_margen', grupo: 'datos', titulo: 'Clientes activos sin margen configurado',
      link: { href: 'clientes.html', texto: 'Ir a Clientes' } }, () => chequeoClientesSinMargen(db)),

    correr({ id: 'clientes_por_kg_sin_tarifa', grupo: 'datos', titulo: 'Clientes por kilo sin tarifa cargada',
      link: { href: 'clientes.html', texto: 'Ir a Clientes' } }, () => chequeoClientesPorKgSinTarifa(db)),

    correr({ id: 'clientes_duplicados', grupo: 'datos', titulo: 'Clientes cargados dos veces',
      link: { href: 'clientes.html', texto: 'Ir a Clientes' } }, () => chequeoClientesDuplicados(db)),

    correr({ id: 'envios_sin_precio', grupo: 'datos', titulo: 'Envíos de meses cerrados sin precio de venta',
      link: { href: 'salidas.html', texto: 'Ir a Salidas' } }, () => chequeoEnviosSinPrecio(db)),

    correr({ id: 'backups', grupo: 'higiene', titulo: 'Backups de la base',
      link: null }, async () => chequeoBackups()),

    correr({ id: 'cierres', grupo: 'higiene', titulo: 'Cierres de mes archivados',
      link: { href: 'salidas.html', texto: 'Ir a Salidas' } }, () => chequeoCierres(db)),

    correr({ id: 'borradores_viejos', grupo: 'higiene', titulo: 'Liquidaciones en borrador olvidadas',
      link: { href: 'liquidaciones.html', texto: 'Ir a Liquidaciones' } }, () => chequeoBorradoresViejos(db)),

    correr({ id: 'huerfanos', grupo: 'higiene', titulo: 'Filas huérfanas en la base',
      link: null }, () => chequeoHuerfanos(db)),
  ]);

  const resumen = { rojo: 0, ambar: 0, ok: 0, error: 0 };
  for (const c of chequeos) resumen[c.severidad] = (resumen[c.severidad] || 0) + 1;

  return {
    generado_en: new Date().toISOString(),
    dias_borrador: DIAS_BORRADOR,
    resumen,
    grupos: GRUPOS,
    chequeos,
  };
}

module.exports = { correrChequeos, MAX_DETALLE, DIAS_BORRADOR };
