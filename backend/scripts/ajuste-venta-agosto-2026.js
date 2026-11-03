#!/usr/bin/env node
/**
 * ajuste-venta-agosto-2026.js — pone en el sistema la venta que se cobró desde la planilla.
 *
 * QUÉ RESUELVE (03/11/2026)
 * Agosto 2026 se cobró desde la planilla SALIDAS_2026.xlsx (hoja AGOSTO 2026, columna T).
 * Al comparar guía por guía contra el sistema, 134 de los 168 envíos con venta coinciden
 * al centavo y 34 tienen otro número (recalculados en el sistema con otra tarifa/peso que
 * la que se usó al cobrar). Felipe (03/11): "respetá lo que dicen las salidas". Este script
 * pisa total_cobrado de esos 34 con el valor de la planilla. Ninguno está liquidado en el
 * sistema; si alguno lo estuviera, se saltea y se avisa.
 *
 * CÓMO SE USA (en el VPS, dentro de backend/)
 *   node scripts/ajuste-venta-agosto-2026.js            → solo informa, no toca nada
 *   node scripts/ajuste-venta-agosto-2026.js --aplicar  → escribe
 *
 * FRENOS (cada fila se aplica SOLO si pasan todos; si no, se saltea y se informa)
 *   - la guía existe una sola vez y es de agosto 2026
 *   - no está en una liquidación CONFIRMADA (un borrador no congela plata: al retomarlo la
 *     vista previa se recalcula con la venta nueva; solo se avisa cuál es)
 *   - su total_cobrado actual es el que tenía el sistema cuando se hizo la comparación
 *     (si alguien lo tocó en el medio, no se pisa a ciegas)
 * Si el envío tenía un desglose de venta a mano (venta_json), se borra: ya no cerraría
 * con el total nuevo (misma regla que el PATCH de Salidas).
 */
const APLICAR = process.argv.includes('--aplicar');

// [guía, venta que tenía el sistema el 03/11, venta de la planilla]
const AJUSTES = [
  ['1Z327W096791388879', 394.86, 386.50],   // 5   Zappala
  ['1Z327W096799204454', 665.88, 734.95],   // 22  MAXIMO
  ['1Z327W096793524128', 402.83, 533.57],   // 28  Zappala
  ['1Z327W096790429504', 83.52, 89.42],     // 29  CAVALIER
  ['9743171491', 190.86, 175.40],           // 33  CASABLANCA
  ['1Z327W096793903469', 170.68, 174.13],   // 42  FAGLIANO
  ['4128809941', 98.78, 80.83],             // 43  CASABLANCA
  ['5082253411', 98.78, 80.83],             // 49  CASABLANCA
  ['1Z327W096798435117', 104.46, 105.78],   // 51  Camila Medina
  ['1Z327W096796367892', 502.00, 619.92],   // 54  Zappala
  ['1Z327W096795091075', 248.56, 281.75],   // 55  Zappala
  ['1Z327W096797076650', 75.74, 87.09],     // 56  FAGLIANO
  ['1Z327W096793875884', 606.73, 592.78],   // 58  DIASPRO
  ['1Z327W096792920522', 118.60, 123.44],   // 66  FAGLIANO
  ['1Z327W096792669626', 146.27, 124.21],   // 76  FAGLIANO
  ['3573415613', 475.21, 456.64],           // 77  CASABLANCA
  ['3573403816', 573.15, 554.08],           // 78  CASABLANCA
  ['1Z327W096797364839', 611.74, 597.70],   // 79  DIASPRO
  ['1Z327W096792603651', 48.78, 144.48],    // 87  Irixcore / Botonera Malaver
  ['1Z327W096797531416', 634.30, 680.57],   // 92  DIASPRO
  ['1Z327W096793396535', 97.05, 104.06],    // 96  CAVALIER
  ['1Z327W096795918244', 117.27, 125.11],   // 97  FAGLIANO
  ['1Z327W096790951636', 458.23, 507.13],   // 101 DIASPRO
  ['1Z327W096791060598', 274.00, 365.01],   // 110 PIO ALVAREZ
  ['1Z327W096799945627', 107.00, 95.87],    // 111 CASABLANCA
  ['1Z327W096795198442', 302.48, 259.95],   // 112 CASABLANCA
  ['1Z327W096796499679', 325.38, 318.45],   // 113 CASABLANCA
  ['1Z327W096792853579', 168.17, 142.15],   // 117 CASABLANCA
  ['1Z327W096795897964', 114.53, 121.96],   // 135 CAVALIER
  ['1Z327W096792976937', 1472.84, 1356.71], // 143 STANZIANO
  ['1Z327W096796411806', 164.48, 154.35],   // 160 FAGLIANO
  ['1Z327W096799243788', 214.40, 211.73],   // 161 FAGLIANO
  ['1Z327W096790991987', 87.85, 82.81],     // 162 FAGLIANO
  ['1Z327W096794078243', 364.28, 380.00],   // 172 EMILIANO PENAZZI
];

const usd = (v) => `USD ${Number(v).toFixed(2)}`;
const igual = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

(async () => {
  const { initDb, getDb, closeDb } = require('../src/db');
  await initDb();
  const db = getDb();

  const aplicables = [];
  const salteados = [];
  for (const [guia, esperado, nuevo] of AJUSTES) {
    const filas = await db.prepare(
      `SELECT e.id, e.fecha, e.total_cobrado, e.venta_json, e.liquidado, c.nombre AS cliente,
              (SELECT GROUP_CONCAT(l.id) FROM liquidacion_items li JOIN liquidaciones l ON l.id = li.liquidacion_id
                WHERE li.envio_id = e.id AND l.estado = 'confirmada') AS confirmadas,
              (SELECT GROUP_CONCAT(l.id) FROM liquidacion_items li JOIN liquidaciones l ON l.id = li.liquidacion_id
                WHERE li.envio_id = e.id AND l.estado = 'borrador') AS borradores
         FROM envios e LEFT JOIN clientes c ON c.id = e.cliente_id
        WHERE e.numero_guia = ?`
    ).all(guia);
    const motivo = (() => {
      if (filas.length === 0) return 'la guía no está en el sistema';
      if (filas.length > 1) return `la guía está ${filas.length} veces`;
      const f = filas[0];
      if (!String(f.fecha || '').startsWith('2026-08')) return `no es de agosto (fecha ${f.fecha})`;
      // Misma regla que el PATCH de Salidas: la plata se congela con la liquidación
      // CONFIRMADA. Un borrador no congela nada (se rehace al abrirlo), solo se avisa.
      if (f.liquidado || f.confirmadas) return `está liquidado (liquidación confirmada #${f.confirmadas || '?'})`;
      if (!igual(f.total_cobrado, esperado)) return `el total actual es ${usd(f.total_cobrado)}, no ${usd(esperado)} (alguien lo cambió después de la comparación)`;
      return null;
    })();
    if (motivo) salteados.push({ guia, motivo, fila: filas[0] });
    else aplicables.push({ guia, nuevo, fila: filas[0] });
  }

  console.log(`\nAjuste de venta de agosto 2026 — ${APLICAR ? 'APLICANDO' : 'solo informe (sin --aplicar no se escribe nada)'}\n`);
  console.log(`Se ajustan ${aplicables.length} de ${AJUSTES.length}:`);
  for (const a of aplicables) {
    const f = a.fila;
    console.log(`  ${String(f.cliente || '').padEnd(28)} ${a.guia.padEnd(20)} ${usd(f.total_cobrado).padStart(13)} → ${usd(a.nuevo)}${f.venta_json ? '  (se borra el desglose a mano)' : ''}${f.borradores ? `  [en borrador #${f.borradores}]` : ''}`);
  }
  const enBorrador = [...new Set(aplicables.filter((a) => a.fila.borradores).flatMap((a) => a.fila.borradores.split(',')))];
  if (enBorrador.length) {
    console.log(`\nOJO: ${aplicables.filter((a) => a.fila.borradores).length} de estos envíos están en borradores de liquidación (#${enBorrador.join(', #')}).`);
    console.log('No pasa nada: al retomar un borrador la vista previa se recalcula con la venta nueva (el total guardado del borrador es solo informativo).');
  }
  if (salteados.length) {
    console.log(`\nSalteados (${salteados.length}):`);
    for (const s of salteados) console.log(`  ${s.guia}${s.fila ? ` (${s.fila.cliente || ''})` : ''}: ${s.motivo}`);
  }
  const antes = aplicables.reduce((s, a) => s + Number(a.fila.total_cobrado), 0);
  const despues = aplicables.reduce((s, a) => s + Number(a.nuevo), 0);
  console.log(`\nVenta de esos envíos: ${usd(antes)} → ${usd(despues)} (${despues >= antes ? '+' : '−'}${usd(Math.abs(despues - antes))})`);

  if (APLICAR && aplicables.length) {
    await db.transaction(async () => {
      for (const a of aplicables) {
        const r = await db.prepare(
          "UPDATE envios SET total_cobrado = ?, venta_json = NULL, updated_at = datetime('now', 'localtime') WHERE id = ? AND ABS(total_cobrado - ?) < 0.011"
        ).run(a.nuevo, a.fila.id, a.fila.total_cobrado);
        if (r.changes !== 1) throw new Error(`No se pudo actualizar el envío ${a.fila.id} (${a.guia}); se deshace todo.`);
      }
    });
    console.log(`\nListo: ${aplicables.length} envíos actualizados.`);
  } else if (!APLICAR) {
    console.log('\nPara escribir: node scripts/ajuste-venta-agosto-2026.js --aplicar');
  }
  await closeDb();
})().catch(async (e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
