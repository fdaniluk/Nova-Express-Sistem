#!/usr/bin/env node
/**
 * test-api-documentos-dhl.js — prueba la regla "documentos solo por DHL" contra la API.
 *
 * La pantalla ya la bloquea, pero la pantalla se puede saltear (pestaña vieja en cache,
 * llamada directa). Esto verifica el freno del backend en los tres caminos que escriben:
 *   POST  /api/envios          (alta desde Cargar envío)
 *   PUT   /api/envios/:id      (edición desde Cargar envío)
 *   PATCH /api/salidas/:id     (edición desde Salidas)
 *
 *   cd backend && node scripts/test-api-documentos-dhl.js
 */

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT_TEST || 3992;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_api_doc.db';
const TOKEN = 'token-test-api-documentos';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const H = () => ({ 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` });

async function main() {
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  const cerrar = (code) => { try { srv.kill(); } catch {} process.exit(code); };

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await esperar(300);
  }

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) =>
    db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const hash = crypto.createHash('sha256').update(TOKEN).digest('hex');
  await q('INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?,?,?)',
    [hash, 1, new Date(Date.now() + 3600e3).toISOString()]);
  const [cli] = await q('SELECT id FROM clientes ORDER BY id LIMIT 1');

  const marca = 'TDOC' + String(process.pid).slice(-5);
  const base = {
    cliente_id: cli.id, fecha: '2026-07-28', tipo_envio: 'exportacion',
    pais_destino: 'ESTADOS UNIDOS', peso_real: 0.5,
  };

  console.log('\n1. POST /api/envios — alta\n');

  let r = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
    body: JSON.stringify({ ...base, numero_guia: marca + 'A', courier: 'UPS', tipo_paquete: 'd' }) });
  let j = await r.json().catch(() => ({}));
  check('rechaza documento + UPS con 400', r.status === 400, `${r.status} ${JSON.stringify(j)}`);
  check('el mensaje explica la regla', /documento/i.test(j.error || ''), j.error);

  r = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
    body: JSON.stringify({ ...base, numero_guia: marca + 'B', courier: 'DHL', tipo_paquete: 'd' }) });
  const envioDoc = await r.json().catch(() => ({}));
  check('acepta documento + DHL', r.status === 201, `${r.status} ${JSON.stringify(envioDoc)}`);

  r = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
    body: JSON.stringify({ ...base, numero_guia: marca + 'C', courier: 'UPS', tipo_paquete: 'm' }) });
  const envioMerc = await r.json().catch(() => ({}));
  check('acepta mercadería + UPS', r.status === 201, `${r.status} ${JSON.stringify(envioMerc)}`);

  console.log('\n2. PUT /api/envios/:id — edición\n');

  // el documento que ya existe en DHL: intentar pasarlo a UPS sin tocar tipo_paquete
  r = await fetch(`${BASE}/api/envios/${envioDoc.id}`, { method: 'PUT', headers: H(),
    body: JSON.stringify({ courier: 'UPS' }) });
  j = await r.json().catch(() => ({}));
  check('rechaza cambiar a UPS un envío que ya es documento', r.status === 400,
    `${r.status} ${JSON.stringify(j)}`);

  // el paquete que está en UPS: intentar marcarlo como documento sin tocar courier
  r = await fetch(`${BASE}/api/envios/${envioMerc.id}`, { method: 'PUT', headers: H(),
    body: JSON.stringify({ tipo_paquete: 'd' }) });
  j = await r.json().catch(() => ({}));
  check('rechaza marcar como documento un envío que está en UPS', r.status === 400,
    `${r.status} ${JSON.stringify(j)}`);

  // cambio válido: pasar el de UPS a DHL + documento en una sola operación
  r = await fetch(`${BASE}/api/envios/${envioMerc.id}`, { method: 'PUT', headers: H(),
    body: JSON.stringify({ tipo_paquete: 'd', courier: 'DHL' }) });
  check('acepta pasar a documento + DHL en la misma edición', r.ok,
    `${r.status} ${JSON.stringify(await r.json().catch(() => ({})))}`);

  console.log('\n3. PATCH /api/salidas/:id — edición desde Salidas\n');

  r = await fetch(`${BASE}/api/salidas/${envioDoc.id}`, { method: 'PATCH', headers: H(),
    body: JSON.stringify({ courier: 'UPS' }) });
  j = await r.json().catch(() => ({}));
  check('rechaza pasar a UPS un documento', r.status === 400, `${r.status} ${JSON.stringify(j)}`);

  r = await fetch(`${BASE}/api/salidas/${envioDoc.id}`, { method: 'PATCH', headers: H(),
    body: JSON.stringify({ observaciones: 'prueba regla documentos' }) });
  check('deja editar otros campos del documento', r.ok,
    `${r.status} ${JSON.stringify(await r.json().catch(() => ({})))}`);

  // mercadería + UPS sigue siendo editable con normalidad
  r = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
    body: JSON.stringify({ ...base, numero_guia: marca + 'D', courier: 'UPS', tipo_paquete: 'm' }) });
  const otro = await r.json().catch(() => ({}));
  r = await fetch(`${BASE}/api/salidas/${otro.id}`, { method: 'PATCH', headers: H(),
    body: JSON.stringify({ courier: 'DHL' }) });
  check('no molesta a la mercadería (UPS → DHL sigue permitido)', r.ok,
    `${r.status} ${JSON.stringify(await r.json().catch(() => ({})))}`);

  db.close();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  cerrar(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
