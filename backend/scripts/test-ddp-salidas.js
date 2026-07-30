#!/usr/bin/env node
/**
 * test-ddp-salidas.js — el checkbox DDP del modal de edición de Salidas.
 *
 * Prueba las dos puntas y, sobre todo, la trampa: `ddp` existía en la tabla pero la consulta
 * de Salidas no lo devolvía. Con el checkbox agregado y sin ese campo, el modal lo mostraba
 * siempre destildado y al guardar BORRABA el DDP de los envíos que sí lo tenían.
 *
 *   cd backend && npm run test-ddp-salidas
 */

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT_TEST || 3993;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_ddp_salidas.db';
const TOKEN = 'token-test-ddp-salidas';

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
  const cerrar = (c) => { try { srv.kill(); } catch {} process.exit(c); };

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await esperar(300);
  }

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await q('INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?,?,?)',
    [crypto.createHash('sha256').update(TOKEN).digest('hex'), 1, new Date(Date.now() + 36e5).toISOString()]);
  const [cli] = await q('SELECT id FROM clientes ORDER BY id LIMIT 1');

  const marca = 'TDDP' + String(process.pid).slice(-5);
  const base = {
    cliente_id: cli.id, fecha: '2026-07-29', tipo_envio: 'exportacion',
    pais_destino: 'ESTADOS UNIDOS', peso_real: 3, courier: 'UPS', tipo_paquete: 'm',
    largo: 30, ancho: 20, alto: 20,
  };

  console.log('\n1. Alta con DDP y lectura desde Salidas\n');

  let r = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
    body: JSON.stringify({ ...base, numero_guia: marca + 'A', ddp: 1 }) });
  const conDdp = await r.json();
  check('se puede dar de alta un envío con DDP', r.status === 201, JSON.stringify(conDdp).slice(0, 120));

  const salidas = async () => (await (await fetch(BASE + '/api/salidas', { headers: H() })).json());
  const buscar = (lista, id) => (Array.isArray(lista) ? lista : lista.envios || lista.data || []).find((e) => e.id === id);

  let fila = buscar(await salidas(), conDdp.id);
  check('Salidas devuelve el campo ddp', fila && fila.ddp !== undefined,
    fila ? `ddp=${JSON.stringify(fila.ddp)}` : 'no se encontró el envío');
  check('y viene en true para el envío que se cargó con DDP', fila && fila.ddp === true,
    fila ? String(fila.ddp) : '-');

  console.log('\n2. La trampa: guardar sin tocar el DDP no lo tiene que borrar\n');

  // Esto es lo que manda el modal al guardar: incluye ddp con el valor del checkbox.
  // Como ahora el checkbox se precarga con el valor real, mandar 1 lo conserva.
  r = await fetch(`${BASE}/api/salidas/${conDdp.id}`, { method: 'PATCH', headers: H(),
    body: JSON.stringify({ observaciones: 'edicion sin tocar el ddp', ddp: 1 }) });
  check('el PATCH acepta ddp', r.ok, `${r.status}`);
  fila = buscar(await salidas(), conDdp.id);
  check('el DDP sigue en true después de guardar', fila && fila.ddp === true,
    fila ? String(fila.ddp) : '-');

  console.log('\n3. Se puede sacar y volver a poner\n');

  r = await fetch(`${BASE}/api/salidas/${conDdp.id}`, { method: 'PATCH', headers: H(),
    body: JSON.stringify({ ddp: 0 }) });
  fila = buscar(await salidas(), conDdp.id);
  check('destildarlo lo pasa a false', r.ok && fila && fila.ddp === false, fila ? String(fila.ddp) : '-');

  r = await fetch(`${BASE}/api/salidas/${conDdp.id}`, { method: 'PATCH', headers: H(),
    body: JSON.stringify({ ddp: 1 }) });
  fila = buscar(await salidas(), conDdp.id);
  check('volver a tildarlo lo pasa a true', r.ok && fila && fila.ddp === true, fila ? String(fila.ddp) : '-');

  console.log('\n4. El recálculo cobra el DDP\n');

  // Para esta parte va un envío DHL: recalcular uno de UPS exige tener guardado el servicio
  // (Expedited o Saver), y el alta por API no lo pide.
  r = await fetch(BASE + '/api/envios', { method: 'POST', headers: H(),
    body: JSON.stringify({ ...base, numero_guia: marca + 'B', courier: 'DHL', ddp: 1 }) });
  const envioDHL = await r.json();
  check('alta del envío DHL para el recálculo', r.status === 201, JSON.stringify(envioDHL).slice(0, 120));

  const recalc = async (id, body) => {
    const res = await fetch(`${BASE}/api/salidas/${id}/recalcular`, { method: 'POST', headers: H(),
      body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const conDDP = await recalc(envioDHL.id, { ddp: 1, remota: 0, asegurado: 0 });
  const sinDDP = await recalc(envioDHL.id, { ddp: 0, remota: 0, asegurado: 0 });
  const tot = (x) => Number(x.json?.total ?? x.json?.desglose?.total ?? NaN);
  check('recalcular con DDP cuesta 24.05 más que sin DDP',
    Number.isFinite(tot(conDDP)) && Number.isFinite(tot(sinDDP))
      && Math.abs((tot(conDDP) - tot(sinDDP)) - 24.05) < 0.02,
    `con ${tot(conDDP)} · sin ${tot(sinDDP)} · dif ${(tot(conDDP) - tot(sinDDP)).toFixed(2)}`);

  db.close();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  cerrar(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
