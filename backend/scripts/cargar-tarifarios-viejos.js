#!/usr/bin/env node
/**
 * cargar-tarifarios-viejos.js — carga EXACTA de los tarifarios viejos (29/09/2026, corregido 01/10).
 *
 * Para cada planilla de `scripts/datos/planillas_precios_viejos.json` (precio de flete de
 * la planilla vieja por cada 0,5 kg y COLUMNA de la hoja c+p, ya con el multiplicador de
 * Liquidación!K8):
 *   1. pone al cliente en paso 0,5 kg hasta 70 kg (cambiarPasoTramos), y
 *   2. carga la matriz exportación completa: por celda,
 *        % = precio_planilla(peso, columna(zona)) / costo_hoy(peso, zona) − 1
 *      (el costo es el MISMO que usa el motor: cotizador-core). El tramo abierto 70+ toma
 *      el % del precio de 70 kg.
 * Con eso el sistema reproduce el precio del liquidador al centavo en todos los pesos hasta 70 kg.
 *
 * ── Zonas: por qué la columna NO es la zona (corrección 01/10) ──────────────────────────
 * En el liquidador la oficina NO tipea la zona del courier sino una REGIÓN:
 *   1 Mercosur · 2 Resto de Sudamérica/Caribe · 3 Norteamérica · 4 Europa · 5 Resto del mundo
 * y el precio sale de VLOOKUP(peso, 'tarif 0808', región+1), donde 'tarif 0808' B..F son las
 * columnas B, C, D, E y **G** de c+p (la F / zona 5 de c+p no se usa nunca). A su vez c+p
 * tiene las columnas C y D CRUZADAS respecto de la hoja COSTO (c+p C = COSTO zona 3,
 * c+p D = COSTO zona 2), que es justamente lo que convierte el orden de zonas UPS
 * (2 = Norteamérica, 3 = resto de América) al orden de regiones. Verificado en las 60
 * planillas 2026: la cadena es idéntica en todas.
 *
 * El JSON guarda el valor de la columna c+p 1..6. Para cada zona del sistema hay que leer
 * la columna que el liquidador usaría para esa región:
 *   · UPS (zonas del motor): 1 Mercosur→col 1 · 2 Norteamérica→col 3 · 3 Caribe/Centro/
 *     resto Sudamérica→col 2 · 4 Europa→col 4 · 5 Asia-Pacífico y 6 resto→col 6 (región 5).
 *   · DHL (zonas del motor, planillas DHL): 1→1 · 2→2 · 3→3 · 4→4 · 5 y 6→col 6. En los
 *     liquidadores DHL la oficina tipea la zona DHL, que coincide con la región salvo 5/6.
 *     OJO: esos liquidadores heredan el cruce C/D de la plantilla UPS, así que la columna 2
 *     lleva el COSTO DHL de zona 3 y la 3 el de zona 2; el sistema reproduce el liquidador
 *     tal cual (es lo que la oficina cobra hoy), pero conviene revisarlo con Felipe.
 * La carga del 28/09 usaba columna = zona (identidad): por eso EE.UU. (zona 2) salía con
 * el precio de la columna 2 (= región Resto de Sudamérica) y Asia con la columna 5.
 *
 * Qué se carga por planilla:
 *   · planillas UPS (sin `servicio` o `servicio: "UPS_EXP"`): matriz UPS Expedited Y UPS
 *     Saver con el mismo precio (el liquidador tiene una sola tarifa y la oficina cobra lo
 *     mismo vaya por Expedited o por Saver);
 *   · planillas DHL (`servicio: "DHL"`): matriz DHL;
 *   · `tambien_dhl: true` en una planilla UPS: además la matriz DHL con el precio de la
 *     planilla UPS promediado por zona DHL (Fagliano, 29/09).
 *
 * Uso:  node scripts/cargar-tarifarios-viejos.js            (contra la base del .env / por defecto)
 *       node scripts/cargar-tarifarios-viejos.js --solo=ADRIANA,CAVALIER
 *       node scripts/cargar-tarifarios-viejos.js --simular  (no escribe: solo informa)
 * Idempotente: se puede correr de nuevo (reemplaza la matriz de cada servicio que carga).
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

// Zona del motor → columna de c+p que usa el liquidador (ver cabecera).
const COL_UPS = { 1: 1, 2: 3, 3: 2, 4: 4, 5: 6, 6: 6 };
const COL_DHL = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 6, 6: 6 };

const r2 = (n) => Math.round(n * 100) / 100;
const costoUpsExp = (pf, zona) => core.getUPS(core.UPS_E_LIQD, core.UPS_E_PK, core.UPS_E_MN, zona, pf);
const costoUpsSaver = (pf, zona) => core.getUPS(core.UPS_SE_LIQD, core.UPS_SE_PK, core.UPS_SE_MN, zona, pf);

const PAIS_POR_ZONA_DHL = {};
for (const [pais, zd] of Object.entries(core.ZONAS_DHL)) if (!PAIS_POR_ZONA_DHL[zd]) PAIS_POR_ZONA_DHL[zd] = pais;
function costoDhl(pf, zona) {
  const r = core.cotizarServicio('DHL', { pais: PAIS_POR_ZONA_DHL[zona], tipo: 'export', pf, fob: 0, fuelPct: 0, profitPct: 0,
    bultosProc: [{ dims: [10, 10, 10], pr: pf, pf }], contenido: 'paquete' });
  return r ? r.fleteBase : null;
}
const COSTO = { UPS_EXP: costoUpsExp, UPS_SAVER: costoUpsSaver, DHL: costoDhl };

// ── Planilla UPS aplicada a DHL (`tambien_dhl: true`; Fagliano, 29/09) ──
// La planilla está por región UPS y DHL tiene sus propias 6 zonas, que no coinciden país a
// país. Para cada zona DHL se toma el precio de la planilla promediado sobre los países de
// esa zona (según la columna que le toca a la zona UPS de cada país).
function precioPlanillaPorZonaDhl(precio, w) {
  const porZona = {};
  for (const [pais, zd] of Object.entries(core.ZONAS_DHL)) {
    const zu = core.ZONAS_UPS[pais];
    const p = zu != null ? precio.get(`${w}|${COL_UPS[zu]}`) : null;
    if (p == null) continue;
    porZona[zd] = porZona[zd] || { suma: 0, n: 0 };
    porZona[zd].suma += p; porZona[zd].n++;
  }
  const out = {};
  for (const [zd, a] of Object.entries(porZona)) out[zd] = a.suma / a.n;
  return out;
}

// Celdas de la matriz de un servicio: precio de la columna que corresponde a cada zona
// sobre el costo de hoy de ese servicio en esa zona.
function armarCeldas(precio, tramos, servicio, cols) {
  const celdas = []; let faltan = 0;
  for (const t of tramos) {
    const w = t.max === null ? 70 : t.max;
    for (const z of [1, 2, 3, 4, 5, 6]) {
      const p = precio.get(`${w}|${cols[z]}`);
      const c = p == null ? null : COSTO[servicio](w, z);
      if (p == null || !(c > 0)) { faltan++; continue; }
      celdas.push({ zona: z, peso_min: t.min, peso_max: t.max, profit_pct: r2((p / c - 1) * 100) });
    }
  }
  return { celdas, faltan };
}

(async () => {
  await initDb();
  const db = getDb();
  const datos = JSON.parse(fs.readFileSync(path.join(__dirname, 'datos', 'planillas_precios_viejos.json'), 'utf8'));
  const resumen = [];
  for (const [key, pl] of Object.entries(datos)) {
    if (solo && !solo.includes(key)) continue;
    if (!pl.cliente_ids || !pl.cliente_ids.length || /^NO CARGADO/.test(pl.nota || '')) { resumen.push([key, '—', 'salteado: ' + (pl.nota || 'sin cliente')]); continue; }
    const esDhl = pl.servicio === 'DHL';
    const precio = new Map(pl.precios.map(([w, z, p]) => [`${w}|${z}`, p]));
    const tramos = P.generarTramosPaso(0.5, 70);
    // Qué matrices salen de esta planilla.
    const cargas = esDhl
      ? [['DHL', armarCeldas(precio, tramos, 'DHL', COL_DHL)]]
      : [['UPS_EXP', armarCeldas(precio, tramos, 'UPS_EXP', COL_UPS)], ['UPS_SAVER', armarCeldas(precio, tramos, 'UPS_SAVER', COL_UPS)]];
    const principal = cargas[0][1].celdas;
    const faltan = cargas[0][1].faltan;
    for (const id of pl.cliente_ids) {
      const cli = await db.prepare('SELECT id, nombre, tarifa_pct FROM clientes WHERE id = ?').get(id);
      if (!cli) { resumen.push([key, id, 'CLIENTE INEXISTENTE']); continue; }
      if (simular) { resumen.push([key, id, `${cli.nombre}: ${cargas.map(([s, c]) => `${s} ${c.celdas.length}`).join(' + ')} celdas (simulado)${faltan ? ', faltan ' + faltan : ''}`]); continue; }
      await P.cambiarPasoTramos(id, { paso: 0.5, hasta: 70 });
      const partes = [];
      for (const [servicio, { celdas }] of cargas) {
        const r = await P.cargarMatrizMasiva(id, { servicio, tipo: 'export', celdas, reemplazar: true });
        partes.push(`${servicio} ${r.celdas}`);
      }
      if (!esDhl && pl.tambien_dhl) {
        const celdasDhl = [];
        for (const t of tramos) {
          const w = t.max === null ? 70 : t.max;
          const pz = precioPlanillaPorZonaDhl(precio, w);
          for (const z of [1, 2, 3, 4, 5, 6]) {
            const p = pz[z]; const c = costoDhl(w, z);
            if (p == null || !(c > 0)) continue;
            celdasDhl.push({ zona: z, peso_min: t.min, peso_max: t.max, profit_pct: r2((p / c - 1) * 100) });
          }
        }
        const rd = await P.cargarMatrizMasiva(id, { servicio: 'DHL', tipo: 'export', celdas: celdasDhl, reemplazar: true });
        const pcts = celdasDhl.map((c) => c.profit_pct);
        partes.push(`DHL ${rd.celdas} desde UPS (% entre ${Math.min(...pcts)} y ${Math.max(...pcts)})`);
      }
      // Respaldo para lo que la matriz no cubre (importación, el otro courier): la mediana
      // de la matriz en clientes.tarifa_pct — solo si el cliente no tiene ninguno.
      if (!(Number(cli.tarifa_pct) > 0) && principal.length) {
        const ord = principal.map((c) => c.profit_pct).sort((a, b) => a - b);
        const mediana = r2(ord[Math.floor(ord.length / 2)]);
        await db.prepare('UPDATE clientes SET tarifa_pct = ? WHERE id = ?').run(mediana, id);
        console.log(`  ${cli.nombre}: tarifa general de respaldo ${mediana} % (mediana de la matriz)`);
      }
      // Verificación: una muestra de celdas tiene que dar el precio de la planilla al centavo,
      // leyendo la columna por la zona como lo haría el liquidador.
      const servicioV = esDhl ? 'DHL' : 'UPS_EXP';
      const colsV = esDhl ? COL_DHL : COL_UPS;
      let peor = 0;
      for (const t of tramos.filter((_, i) => i % 11 === 0)) {
        const w = t.max === null ? 70 : t.max;
        for (const z of [1, 2, 3, 4, 5, 6]) {
          const p = precio.get(`${w}|${colsV[z]}`);
          if (p == null) continue;
          const res = await P.resolverProfit({ clienteId: id, servicio: servicioV, tipo: 'export', zona: z, pesoFacturable: w });
          const nuevo = COSTO[servicioV](w, z) * (1 + res.profitPct / 100);
          peor = Math.max(peor, Math.abs(nuevo - p));
        }
      }
      resumen.push([key, id, `${cli.nombre}: ${partes.join(' + ')} celdas, paso 0,5 kg, desvío máx. USD ${peor.toFixed(2)}${faltan ? ', sin precio en ' + faltan : ''}`]);
    }
  }
  for (const [k, id, msg] of resumen) console.log(`${k.padEnd(16)} ${String(id).padEnd(5)} ${msg}`);
  process.exit(0);
})().catch((e) => { console.error('FALLÓ:', e); process.exit(1); });
