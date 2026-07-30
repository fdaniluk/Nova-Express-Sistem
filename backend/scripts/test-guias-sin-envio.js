#!/usr/bin/env node
/**
 * test-guias-sin-envio.js — la pantalla de guías facturadas sin envío.
 *
 * Cada fila de esa pantalla es una guía que el courier COBRÓ y que no tiene envío en el
 * sistema: o el envío nunca se cargó (y no se le facturó a nadie), o la guía se tipeó mal.
 *
 * La prueba carga la factura de ejemplo contra una base donde faltan envíos a propósito, y
 * verifica que aparezcan. El caso que más importa es el del error de tipeo: se carga un
 * envío con la guía mal escrita y se controla que el sistema sugiera "¿quisiste decir…?".
 *
 *   cd backend && npm run test-guias-sin-envio
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT_TEST || 3999;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_sin_envio.db';
const TOKEN = 'token-test-sin-envio';
const PDF = path.join(__dirname, '..', '..', 'facturas-ejemplo', 'factura_test_ups.pdf');

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const H = () => ({ 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` });

async function main() {
  if (!fs.existsSync(PDF)) {
    console.error(`✗ No se encontró la factura de ejemplo: ${PDF}`);
    process.exit(1);
  }

  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  const cerrar = (c) => { try { srv.kill(); } catch {} process.exit(c); };

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await esperar(300);
  }

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await q('INSERT OR REPLACE INTO sesiones (token_hash,usuario_id,expira_en) VALUES (?,?,?)',
    [crypto.createHash('sha256').update(TOKEN).digest('hex'), 1, new Date(Date.now() + 36e5).toISOString()]);
  const [cli] = await q('SELECT id FROM clientes ORDER BY id LIMIT 1');

  // Escenario determinista: la factura de ejemplo es REAL, así que varias de sus guías
  // ya existen como envíos en la copia de producción. Se sacan todas para armar el caso
  // desde cero (esto toca una copia en /tmp, nunca la base de verdad).
  await q('DELETE FROM factura_guias');
  await q('DELETE FROM facturas_cargadas');
  const { extraerFacturaUPS } = require('../src/services/factura-ups.service.js');
  const facturaPrevia = await extraerFacturaUPS(fs.readFileSync(PDF));
  for (const g of facturaPrevia.guias) {
    await q('DELETE FROM envio_bultos WHERE envio_id IN (SELECT id FROM envios WHERE numero_guia = ?)', [g.numero_guia]);
    await q('DELETE FROM envios WHERE numero_guia = ?', [g.numero_guia]);
  }

  // ── Escenario ──────────────────────────────────────────────────────────────
  // La factura trae 10 guías. Se cargan DOS envíos:
  //   · uno con la guía bien escrita   → tiene que cruzarse y NO aparecer
  //   · uno con la guía MAL tipeada    → la de la factura queda sin envío, y el sistema
  //     tiene que sugerir este envío como "¿quisiste decir?"
  const BIEN = '1Z327W096790199567';
  const MAL_REAL = '1Z327W096797411680';           // como viene en la factura
  const MAL_CARGADA = '1Z327W096797411689';        // como la tipeó la oficina (último dígito)

  const alta = async (guia) => {
    const res = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
      body: JSON.stringify({
        cliente_id: cli.id, fecha: '2026-05-20', tipo_envio: 'exportacion', courier: 'UPS',
        numero_guia: guia, pais_destino: 'ESTADOS UNIDOS', peso_real: 5,
        largo: 30, ancho: 20, alto: 20, total_cobrado: 200, servicio_ups: 'UPS_EXP',
      }) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const a1 = await alta(BIEN);
  const a2 = await alta(MAL_CARGADA);
  check('se cargaron los dos envíos de prueba', a1.status === 201 && a2.status === 201,
    `${a1.status} ${JSON.stringify(a1.json).slice(0,90)} / ${a2.status} ${JSON.stringify(a2.json).slice(0,90)}`);

  // ── Cargar la factura ──────────────────────────────────────────────────────
  console.log('\n1. Cargar la factura\n');

  const fd = new FormData();
  fd.append('pdf', new Blob([fs.readFileSync(PDF)], { type: 'application/pdf' }), 'factura.pdf');
  fd.append('sobreescribir', 'false');
  const rc = await fetch(BASE + '/api/facturas/cargar', {
    method: 'POST', headers: { Cookie: `nova_session=${TOKEN}` }, body: fd });
  const carga = await rc.json().catch(() => ({}));
  check('la factura se cargó', rc.ok, `${rc.status} ${JSON.stringify(carga).slice(0, 160)}`);
  // el resumen de /cargar llama `guardadas` a las guías que sí encontraron su envío
  check('cruzó el envío con la guía bien escrita', (carga.guardadas ?? 0) >= 1,
    `guardadas=${carga.guardadas} · no encontradas=${carga.no_encontradas}`);
  check('el resto quedó sin envío', (carga.no_encontradas ?? 0) >= 8,
    `no encontradas=${carga.no_encontradas}`);

  // ── La pantalla ────────────────────────────────────────────────────────────
  console.log('\n2. La pantalla las muestra DESPUÉS de cargar (que es lo que faltaba)\n');

  const r = await fetch(BASE + '/api/facturas/sin-envio', { headers: H() });
  const res = await r.json().catch(() => ({}));
  check('el endpoint responde', r.ok, `${r.status}`);
  check('devuelve las guías sin envío', (res.guias || []).length >= 8,
    `${(res.guias || []).length}`);
  check('suma cuánta plata representan', res.costo_total > 0, `${res.costo_total}`);
  console.log(`\n   ${res.total} guías sin envío · USD ${res.costo_total} facturados\n`);

  check('la guía que sí se cruzó NO aparece',
    !(res.guias || []).some((g) => g.numero_guia === BIEN));

  // ── La guía mal tipeada aparece ────────────────────────────────────────────
  console.log('3. La guía mal tipeada queda listada\n');

  const conTypo = (res.guias || []).find((g) => g.numero_guia === MAL_REAL);
  check('la guía que la oficina cargó mal aparece como sin envío', !!conTypo,
    (res.guias || []).map((g) => g.numero_guia).join(', ').slice(0, 120));

  // ── NO se sugiere ningún parecido ──────────────────────────────────────────
  //
  // Se probó y se sacó a pedido de Felipe (29/07): todas las guías de Nova comparten el
  // prefijo y solo cambian los últimos dígitos, así que dos guías LEGÍTIMAS y distintas
  // pueden diferir en un caracter. Sugerir un "parecido" llevaría a corregir un envío que
  // estaba bien. Esta prueba existe para que no vuelva a colarse.
  console.log('\n4. No se sugiere ningún envío parecido\n');

  check('ninguna fila trae una sugerencia de envío',
    (res.guias || []).every((g) => g.posible_envio === undefined),
    JSON.stringify((res.guias || []).find((g) => g.posible_envio) || {}).slice(0, 120));

  const campos = Object.keys((res.guias || [])[0] || {});
  check('la respuesta solo trae los datos de la guía facturada',
    !campos.some((c) => /posible|sugerid|parecid/i.test(c)), campos.join(', '));

  db.close();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  cerrar(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
