#!/usr/bin/env node
/**
 * cargar-tarifarios-viejos.js — carga EXACTA de los tarifarios viejos (29/09/2026).
 *
 * Para cada planilla de `scripts/datos/planillas_precios_viejos.json` (precio de flete de
 * la planilla vieja por cada 0,5 kg y zona, ya con el multiplicador de Liquidación!K8):
 *   1. pone al cliente en paso 0,5 kg hasta 70 kg (cambiarPasoTramos), y
 *   2. carga la matriz UPS Expedited exportación completa: por celda,
 *        % = precio_planilla(peso, zona) / costo_UPS_Expedited_hoy(peso, zona) − 1
 *      (el costo es el MISMO que usa el motor: getUPS de cotizador-core). El tramo abierto
 *      70+ toma el % del precio de 70 kg.
 * Con eso el sistema reproduce el precio viejo al centavo en todos los pesos hasta 70 kg.
 *
 * Uso:  node scripts/cargar-tarifarios-viejos.js            (contra la base del .env / por defecto)
 *       node scripts/cargar-tarifarios-viejos.js --solo=ADRIANA,CAVALIER
 *       node scripts/cargar-tarifarios-viejos.js --simular  (no escribe: solo informa)
 * Idempotente: se puede correr de nuevo.
 */
const path = require('path');
const fs = require('fs');
const { initDb, getDb } = require('../src/db');
const P = require('../src/services/profit.service');
const core = require('../../shared/cotizador/cotizador-core.js');

const args = process.argv.slice(2);
const simular = args.includes('--simular');
const soloArg = args.find((a) => a.startsWith('--solo='));
const solo = soloArg ? soloArg.slice(7).split(',').map((s) => s.trim()) : null;

const costoUps = (pf, zona) => core.getUPS(core.UPS_E_LIQD, core.UPS_E_PK, core.UPS_E_MN, zona, pf);
const r2 = (n) => Math.round(n * 100) / 100;

(async () => {
  await initDb();
  const db = getDb();
  const datos = JSON.parse(fs.readFileSync(path.join(__dirname, 'datos', 'planillas_precios_viejos.json'), 'utf8'));
  const resumen = [];
  for (const [key, pl] of Object.entries(datos)) {
    if (solo && !solo.includes(key)) continue;
    if (!pl.cliente_ids || !pl.cliente_ids.length || /^NO CARGADO/.test(pl.nota || '')) { resumen.push([key, '—', 'salteado: ' + (pl.nota || 'sin cliente')]); continue; }
    const precio = new Map(pl.precios.map(([w, z, p]) => [`${w}|${z}`, p]));
    const tramos = P.generarTramosPaso(0.5, 70);
    const celdas = [];
    let faltan = 0;
    for (const t of tramos) {
      const w = t.max === null ? 70 : t.max;
      for (const z of [1, 2, 3, 4, 5, 6]) {
        const p = precio.get(`${w}|${z}`);
        if (p == null) { faltan++; continue; }
        const c = costoUps(w, z);
        if (!(c > 0)) { faltan++; continue; }
        celdas.push({ zona: z, peso_min: t.min, peso_max: t.max, profit_pct: r2((p / c - 1) * 100) });
      }
    }
    for (const id of pl.cliente_ids) {
      const cli = await db.prepare('SELECT id, nombre FROM clientes WHERE id = ?').get(id);
      if (!cli) { resumen.push([key, id, 'CLIENTE INEXISTENTE']); continue; }
      if (simular) { resumen.push([key, id, `${cli.nombre}: ${celdas.length} celdas (simulado)${faltan ? ', faltan ' + faltan : ''}`]); continue; }
      await P.cambiarPasoTramos(id, { paso: 0.5, hasta: 70 });
      const r = await P.cargarMatrizMasiva(id, { servicio: 'UPS_EXP', tipo: 'export', celdas, reemplazar: true });
      // Verificación: 12 pesos al azar tienen que dar el precio de la planilla al centavo.
      let peor = 0;
      for (const [w, z, p] of pl.precios.filter((_, i) => i % 71 === 0)) {
        const res = await P.resolverProfit({ clienteId: id, servicio: 'UPS_EXP', tipo: 'export', zona: z, pesoFacturable: w });
        const nuevo = costoUps(w, z) * (1 + res.profitPct / 100);
        peor = Math.max(peor, Math.abs(nuevo - p));
      }
      resumen.push([key, id, `${cli.nombre}: ${r.celdas} celdas, paso 0,5 kg, desvío máx. USD ${peor.toFixed(2)}${faltan ? ', sin precio en ' + faltan : ''}`]);
    }
  }
  for (const [k, id, msg] of resumen) console.log(`${k.padEnd(16)} ${String(id).padEnd(5)} ${msg}`);
  process.exit(0);
})().catch((e) => { console.error('FALLÓ:', e); process.exit(1); });
