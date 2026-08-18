#!/usr/bin/env node
/**
 * revisar-envios.js — deuda 20: revisar los envíos YA CARGADOS por si algo se cobró mal.
 *
 * Es un INFORME DE SOLO LECTURA (la base se abre OPEN_READONLY: no puede escribir ni
 * queriendo). No arregla nada: dice QUÉ envíos hay que mirar y por qué. Las correcciones
 * se deciden después, una por una, mirando este informe.
 *
 * Qué busca (herencia directa de AUDITORIA-NUMEROS.md):
 *   1. tipo_envio y direccion contándose historias distintas (impos importadas por
 *      planilla antes del 18/08 quedaban como 'exportacion').
 *   2. Impos UPS con la zona de la tabla de EXPORTACIÓN (el importador viejo). La zona
 *      guardada actúa de override en los recálculos: costo de otra fila de la matriz.
 *   3. Envíos UPS con servicio_ups NULL: el costo se congeló asumiendo Expedited; si
 *      alguno era Saver, está subestimado.
 *   4. Envíos con peso y SIN costo (no debería quedar ninguno después de cb1aaa3).
 *   5. Envíos con venta cargada pero utilidad NEGATIVA (venta < costo estimado).
 *   6. Envíos con peso y sin precio de venta (plata que todavía no se cobró).
 *   7. Asegurados con valor declarado > 100 y seguro en cero.
 *
 * Uso:
 *   node scripts/revisar-envios.js                      # desde backend/, usa database/nova.db
 *   DB_PATH=/otra/base.db node scripts/revisar-envios.js
 *
 * En el VPS (la base real): cd /root/Nova-Express-Sistem/backend && node scripts/revisar-envios.js
 */

const path = require('path');
const sqlite3 = require('sqlite3');
const { buscarZona } = require('../src/services/calculos.service');
const { normalizarDestino } = require('../src/utils/paises');
const { deriveProfit, costoEstimado } = require('../src/utils/profit');
const { ZONAS_UPS, ZONAS_UPS_I } = require('../../shared/cotizador/cotizador-core');

const ROOT = path.join(__dirname, '..', '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'database', 'nova.db');
const TOPE_LISTADO = 25; // cuántas filas mostrar por sección; el total se informa igual

function open(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (err) => (err ? reject(err) : resolve(db)));
  });
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toFixed(2));

function seccion(titulo, filas, dibujar) {
  console.log(`\n── ${titulo}`);
  if (filas.length === 0) { console.log('   ✓ ninguno'); return; }
  console.log(`   ⚠ ${filas.length} envío${filas.length === 1 ? '' : 's'}:`);
  for (const f of filas.slice(0, TOPE_LISTADO)) console.log(`   · ${dibujar(f)}`);
  if (filas.length > TOPE_LISTADO) console.log(`   … y ${filas.length - TOPE_LISTADO} más`);
}

async function main() {
  console.log('REVISIÓN DE ENVÍOS CARGADOS (solo lectura)');
  console.log(`base: ${DB_PATH}`);
  const db = await open(DB_PATH);

  // venta_liq: la venta congelada de la liquidación confirmada (total_cobrado + adicional
  // manual), pre-agregada por envío. deriveProfit la usa en la rama de costo real, igual
  // que el Dashboard, para que este informe diga los mismos números que las pantallas.
  const envios = await all(db, `
    SELECT e.*, e.total_cobrado AS total,
           COALESCE(NULLIF(c.nombre_nova,''), c.nombre) AS cliente_nombre,
           li.venta_liq AS venta_liq
    FROM envios e
    JOIN clientes c ON c.id = e.cliente_id
    LEFT JOIN (
      SELECT envio_id, SUM(total_usd) AS venta_liq
      FROM liquidacion_items
      WHERE liquidacion_id IN (SELECT id FROM liquidaciones WHERE estado = 'confirmada')
      GROUP BY envio_id
    ) li ON li.envio_id = e.id
    ORDER BY e.fecha DESC, e.id DESC`);
  console.log(`envíos: ${envios.length}`);

  const etiqueta = (e) =>
    `#${e.id} ${e.numero_guia || 'sin guía'} · ${e.fecha} · ${e.cliente_nombre} · ${e.courier}`;

  // 1. tipo_envio ↔ direccion incoherentes
  const incoherentes = envios.filter((e) => {
    const dir = e.direccion || 'expo';
    const tipo = e.tipo_envio === 'importacion' ? 'impo' : 'expo';
    return dir !== tipo;
  });
  seccion('1. tipo_envio y direccion no coinciden (impos que cotizan como expo, o al revés)',
    incoherentes, (e) => `${etiqueta(e)} · tipo_envio=${e.tipo_envio} pero direccion=${e.direccion}`);

  // 2. Impos UPS con zona de la tabla de exportación
  const impoUpsMal = [];
  for (const e of envios) {
    if (e.courier !== 'UPS') continue;
    const esImpo = e.direccion === 'impo' || e.tipo_envio === 'importacion';
    if (!esImpo || e.zona === null || e.zona === undefined || e.zona === '') continue;
    // El país de ORIGEN de la impo: se re-resuelve del texto guardado, igual que el importador.
    const { origen } = normalizarDestino(e.destino_raw || e.pais_destino, e.observaciones);
    const pais = origen || e.pais_destino;
    const zonaImpo = buscarZona(ZONAS_UPS_I, pais);
    const zonaExpo = buscarZona(ZONAS_UPS, pais);
    if (zonaImpo === undefined) continue; // país que no resuelve: no se puede afirmar nada
    if (Number(e.zona) !== Number(zonaImpo)) {
      impoUpsMal.push({ ...e, _pais: pais, _zonaImpo: zonaImpo, _zonaExpo: zonaExpo });
    }
  }
  seccion('2. Impos UPS con zona equivocada (guardada ≠ tabla de importación)',
    impoUpsMal, (e) => `${etiqueta(e)} · ${e._pais}: guardada ${e.zona}, corresponde ${e._zonaImpo}`
      + (Number(e.zona) === Number(e._zonaExpo) ? ' (es la de EXPO: vino del importador viejo)' : ''));

  // 3. UPS sin variante de servicio
  const upsSinServicio = envios.filter((e) => e.courier === 'UPS' && !e.servicio_ups);
  seccion('3. Envíos UPS con servicio_ups NULL (costo congelado asumiendo Expedited)',
    upsSinServicio, (e) => `${etiqueta(e)} · flete ${fmt(e.flete)} · total ${fmt(e.total)}`);

  // 4. Con peso y sin costo
  const sinCosto = envios.filter((e) => Number(e.peso_facturable) > 0 && !(Number(e.flete) > 0));
  seccion('4. Con peso facturable y SIN costo congelado (no debería quedar ninguno)',
    sinCosto, (e) => `${etiqueta(e)} · ${e.peso_facturable} kg · país "${e.pais_destino}" · zona ${e.zona ?? '—'}`);

  // 5. Venta cargada pero utilidad negativa
  const margenNegativo = envios
    .filter((e) => Number(e.total) > 0)
    .map((e) => ({ e, p: deriveProfit(e) }))
    .filter(({ p }) => p.profit !== null && p.profit !== undefined && p.profit < 0)
    .sort((a, b) => a.p.profit - b.p.profit);
  seccion('5. Utilidad NEGATIVA (venta < costo; misma fórmula que Salidas/Dashboard)',
    margenNegativo, ({ e, p }) => `${etiqueta(e)} · venta ${fmt(e.total)} · costo ${fmt(p.compra_total)} · pierde ${fmt(-p.profit)}${p.profit_real ? ' (costo REAL de factura)' : ''}`);

  // 6. Con peso y sin precio de venta
  const sinVenta = envios.filter((e) => Number(e.peso_facturable) > 0 && !(Number(e.total) > 0) && !e.liquidado);
  seccion('6. Con peso y SIN precio de venta (plata sin cobrar; no entran a liquidación por cb1aaa3)',
    sinVenta, (e) => `${etiqueta(e)} · ${e.peso_facturable} kg · costo estimado ${fmt(costoEstimado(e))}`);

  // 7. Asegurado con valor declarado y seguro en cero
  const sinSeguro = envios.filter((e) => Number(e.asegurado) === 1 && Number(e.fob) > 100 && !(Number(e.seguro) > 0));
  seccion('7. Asegurados con valor declarado > 100 y seguro en CERO',
    sinSeguro, (e) => `${etiqueta(e)} · fob ${fmt(e.fob)} · seguro ${fmt(e.seguro)}`);

  const total = incoherentes.length + impoUpsMal.length + upsSinServicio.length
    + sinCosto.length + margenNegativo.length + sinVenta.length + sinSeguro.length;
  console.log('\n────────────────────────────────────────');
  if (total === 0) {
    console.log('✓ NADA PARA REVISAR: las 7 búsquedas dieron vacías.');
  } else {
    console.log(`⚠ ${total} caso${total === 1 ? '' : 's'} para revisar (el detalle está arriba).`);
    console.log('Este informe NO cambió nada: las correcciones se deciden mirando cada caso.');
  }

  await close(db);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
