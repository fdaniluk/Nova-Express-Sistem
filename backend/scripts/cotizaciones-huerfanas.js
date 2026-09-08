#!/usr/bin/env node
/**
 * cotizaciones-huerfanas.js — cotizaciones guardadas SIN cliente (08/09/2026).
 *
 * Hasta el 08/09, guardar sin cliente pedía un nombre tipeado y la cotización quedaba
 * en la base sin cliente_id: invisible en el perfil y en el panel de Cargar envío. Este
 * script las lista y, si se le indica, las asigna a un cliente (lo mismo que hace
 * PATCH /api/cotizaciones/:id con cliente_id).
 *
 *   cd backend && node scripts/cotizaciones-huerfanas.js                 → las lista
 *   cd backend && node scripts/cotizaciones-huerfanas.js --clientes      → lista clientes (id y nombre)
 *   cd backend && node scripts/cotizaciones-huerfanas.js --asignar=12:34 → la CTZ id 12 al cliente 34
 *     (se pueden pasar varias: --asignar=12:34 --asignar=15:7)
 *
 * En el servidor corre contra la base de producción (la misma que el sistema). No borra
 * nada; cada asignación queda en el historial de la cotización.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { initDb, getDb, closeDb } = require('../src/db');
const ctz = require('../src/models/cotizacion.model');

function usd(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
  await initDb();
  const args = process.argv.slice(2);
  const db = getDb();

  if (args.includes('--clientes')) {
    const rows = await db.prepare("SELECT id, nombre, nombre_nova FROM clientes WHERE activo = 1 ORDER BY nombre COLLATE NOCASE").all();
    console.log(`\n${rows.length} clientes activos\n`);
    for (const c of rows) console.log(`  ${String(c.id).padStart(4)}  ${c.nombre}${c.nombre_nova ? `  (${c.nombre_nova})` : ''}`);
    await closeDb();
    return;
  }

  const asignaciones = args.filter((a) => a.startsWith('--asignar=')).map((a) => a.slice('--asignar='.length).split(':').map(Number));
  for (const [ctzId, clienteId] of asignaciones) {
    if (!ctzId || !clienteId) { console.log(`  ✗ --asignar mal escrito (esperaba idCotizacion:idCliente)`); continue; }
    try {
      const r = await ctz.asignarCliente(ctzId, clienteId, { usuario: 'script' });
      if (!r) console.log(`  ✗ la cotización #${ctzId} no existe`);
      else console.log(`  ✓ CTZ-${r.numero} → ${r.cliente_nombre_actual || r.cliente_nombre} (cliente ${clienteId})`);
    } catch (e) {
      console.log(`  ✗ #${ctzId}: ${e.message}`);
    }
  }

  const lista = await ctz.listar({ sin_cliente: true });
  console.log(`\n${lista.length} cotización(es) sin cliente asignado\n`);
  for (const q of lista) {
    const ops = (q.opciones_resumen || []).map((o) => `${o.servicio} ${usd(o.total)}`).join(' · ');
    console.log(`  id ${String(q.id).padStart(4)}  CTZ-${q.numero}  ${String(q.creado_en).slice(0, 10)}  "${q.cliente_nombre || '(sin nombre)'}"  ${q.pais}  ${Number(q.peso_facturable).toFixed(1)} kg  ${ops}${q.profit && q.profit.manual ? `  [profit manual ${q.profit.pct}%]` : ''}  ${q.estado}`);
  }
  if (lista.length) console.log('\nPara asignar: node scripts/cotizaciones-huerfanas.js --asignar=<id>:<idCliente>  (ids de cliente con --clientes)');
  await closeDb();
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
