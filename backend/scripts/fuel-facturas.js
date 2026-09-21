// Informe de solo lectura: que % de fuel cobro UPS en cada factura cargada, guia por guia.
// Sirve para saber si el fuel es uno fijo por mes o cambia por semana.
// Uso: node scripts/fuel-facturas.js            (todas las facturas de flete UPS)
//      node scripts/fuel-facturas.js --desde=2026-08-01
// No escribe nada en la base.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { initDb, getDb, closeDb } = require('../src/db');

const esFuel = (n) => /COMBUST|FUEL/i.test(n);
const esSurge = (n) => /SURGE|INCREMENTO DE VOLUMEN/i.test(n);
const pct = (a, b) => (b > 0 ? (a / b) * 100 : null);
const r1 = (x) => (x == null ? '-' : x.toFixed(1));

function semana(fecha) {
  if (!fecha) return 'sin fecha';
  const d = new Date(fecha.slice(0, 10) + 'T12:00:00');
  const dia = (d.getDay() + 6) % 7; // lunes = 0
  d.setDate(d.getDate() - dia);
  return d.toISOString().slice(0, 10);
}

function moda(vals) {
  const c = {};
  for (const v of vals) { const k = r1(v); c[k] = (c[k] || 0) + 1; }
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}% x${n}`).join(' · ');
}

async function main() {
  await initDb();
  const db = getDb();
  const desde = (process.argv.find((a) => a.startsWith('--desde=')) || '--desde=2000-01-01').slice(8);

  const facturas = await db.prepare(
    "SELECT id, numero_factura, fecha_factura, cantidad_guias FROM facturas_cargadas WHERE courier = 'UPS' AND tipo = 'flete' AND (fecha_factura IS NULL OR fecha_factura >= ?) ORDER BY fecha_factura, numero_factura"
  ).all(desde);

  const porSemana = {};
  const nombres = {};

  for (const f of facturas) {
    const guias = await db.prepare(
      'SELECT g.numero_guia, g.neto, g.cargos_json, e.fecha AS fecha_envio FROM factura_guias g LEFT JOIN envios e ON e.id = g.envio_id WHERE g.factura_id = ?'
    ).all(f.id);
    const vals = [];
    for (const g of guias) {
      let cargos = [];
      try { cargos = JSON.parse(g.cargos_json || '[]'); } catch (_) {}
      let fuel = 0, surge = 0, hayFuel = false;
      for (const c of cargos) {
        nombres[c.nombre] = (nombres[c.nombre] || 0) + 1;
        if (esFuel(c.nombre)) { fuel += Number(c.monto) || 0; hayFuel = true; }
        else if (esSurge(c.nombre)) surge += Number(c.monto) || 0;
      }
      if (!hayFuel || !(g.neto > 0)) continue;
      const p = pct(fuel, g.neto + surge);
      vals.push(p);
      const s = semana(g.fecha_envio);
      (porSemana[s] = porSemana[s] || []).push(p);
    }
    console.log(`\nFactura ${f.numero_factura || '?'}  (${f.fecha_factura || 'sin fecha'})  ${guias.length} guias, ${vals.length} con fuel`);
    if (vals.length) console.log(`  fuel sobre neto+surge:  ${moda(vals)}`);
  }

  console.log('\n\nPor SEMANA DE DESPACHO del envio (lunes de esa semana):');
  for (const s of Object.keys(porSemana).sort()) console.log(`  ${s}  ${moda(porSemana[s])}`);

  console.log('\n\nNombres de cargo vistos (para chequear que fuel y surge se reconocen bien):');
  for (const [n, c] of Object.entries(nombres).sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(5)}  ${n}${esFuel(n) ? '   <- FUEL' : esSurge(n) ? '   <- SURGE' : ''}`);

  await closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });
