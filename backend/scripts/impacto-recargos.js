#!/usr/bin/env node
/**
 * impacto-recargos.js — recotiza TODOS los envíos de la base con el motor viejo y con el
 * nuevo, y muestra cuáles cambian de precio y por cuánto.
 *
 * No escribe nada. Solo lee. Sirve para saber, antes de subir, a cuántos envíos reales
 * les cambia el número y en qué dirección.
 *
 *   node scripts/impacto-recargos.js <ruta-motor-viejo> [ruta-db]
 */

const path = require('path');
const sqlite3 = require('sqlite3');

const VIEJO = process.argv[2] || '/mnt/user-data/uploads/GitHub/Nova-Express-Sistem/shared/cotizador/cotizador-core.js';
const DB = process.argv[3] || '/root/prod/prod.db';

const nuevo = require('../../shared/cotizador/cotizador-core.js');
const viejo = require(path.resolve(VIEJO));

const db = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

const SERVICIO = { DHL: 'DHL', UPS: 'UPS_EXP' };

function dimsDe(b) {
  return [Number(b.largo) || 0, Number(b.ancho) || 0, Number(b.alto) || 0].sort((x, y) => y - x);
}

(async () => {
  const envios = await q(`
    SELECT id, numero_guia, fecha, courier, tipo_envio, pais_destino,
           peso_real, peso_facturable, largo, ancho, alto,
           fuel_pct, porcentaje, seguro, remota, ddp, total_cobrado
    FROM envios ORDER BY id`);

  const bultos = await q('SELECT envio_id, peso_real, largo, ancho, alto FROM envio_bultos');
  const porEnvio = new Map();
  for (const b of bultos) {
    if (!porEnvio.has(b.envio_id)) porEnvio.set(b.envio_id, []);
    porEnvio.get(b.envio_id).push(b);
  }

  const cambios = [];
  let sinZona = 0, iguales = 0;

  for (const e of envios) {
    const piezas = porEnvio.get(e.id) || [{
      peso_real: e.peso_real, largo: e.largo, ancho: e.ancho, alto: e.alto,
    }];
    const bultosProc = piezas.map((b) => ({ dims: dimsDe(b), pr: Number(b.peso_real) || 0 }));

    const params = {
      pais: e.pais_destino,
      tipo: e.tipo_envio === 'importacion' ? 'import' : 'export',
      pf: Number(e.peso_facturable) || Number(e.peso_real) || 0,
      fob: 0,
      fuelPct: Number(e.fuel_pct) || 0,
      profitPct: Number(e.porcentaje) || 0,
      bultosProc,
      remota: !!e.remota,
      ddp: !!e.ddp,
    };

    const servicio = SERVICIO[e.courier];
    if (!servicio) continue;
    const a = viejo.cotizarServicio(servicio, params);
    const b = nuevo.cotizarServicio(servicio, params);
    if (!a || !b) { sinZona++; continue; }

    const dif = b.total - a.total;
    if (Math.abs(dif) < 0.005) { iguales++; continue; }
    cambios.push({ e, antes: a.total, ahora: b.total, dif });
  }

  console.log(`\nEnvíos analizados: ${envios.length}`);
  console.log(`  sin cambio de precio: ${iguales}`);
  console.log(`  sin zona resoluble:   ${sinZona}`);
  console.log(`  CAMBIAN de precio:    ${cambios.length}\n`);

  const suben = cambios.filter((c) => c.dif > 0);
  const bajan = cambios.filter((c) => c.dif < 0);
  const sum = (xs) => xs.reduce((s, c) => s + c.dif, 0);

  console.log(`  suben:  ${String(suben.length).padStart(3)} envíos · ${sum(suben).toFixed(2).padStart(10)} USD`);
  console.log(`  bajan:  ${String(bajan.length).padStart(3)} envíos · ${sum(bajan).toFixed(2).padStart(10)} USD`);
  console.log(`  neto:   ${' '.repeat(15)}${sum(cambios).toFixed(2).padStart(10)} USD\n`);

  const porPais = new Map();
  for (const c of cambios) {
    const k = `${c.e.courier} · ${c.e.pais_destino} · ${c.e.tipo_envio}`;
    if (!porPais.has(k)) porPais.set(k, { n: 0, dif: 0 });
    const v = porPais.get(k); v.n++; v.dif += c.dif;
  }
  console.log('  Por destino:');
  console.log('  ' + '─'.repeat(66));
  [...porPais.entries()].sort((x, y) => Math.abs(y[1].dif) - Math.abs(x[1].dif))
    .forEach(([k, v]) => console.log(`  ${k.padEnd(46)} ${String(v.n).padStart(3)} env  ${v.dif.toFixed(2).padStart(10)}`));

  console.log('\n  Los 12 cambios más grandes, uno por uno:');
  console.log('  ' + '─'.repeat(78));
  console.log('  guía            fecha        destino                antes      ahora        dif');
  cambios.sort((x, y) => Math.abs(y.dif) - Math.abs(x.dif)).slice(0, 12).forEach((c) => {
    console.log(`  ${String(c.e.numero_guia).padEnd(15)} ${String(c.e.fecha).padEnd(12)} ` +
      `${String(c.e.pais_destino).slice(0, 20).padEnd(21)} ${c.antes.toFixed(2).padStart(9)} ` +
      `${c.ahora.toFixed(2).padStart(10)} ${c.dif.toFixed(2).padStart(10)}`);
  });

  db.close();
  console.log('');
})().catch((e) => { console.error(e); process.exit(1); });
