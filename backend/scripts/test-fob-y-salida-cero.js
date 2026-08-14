#!/usr/bin/env node
/**
 * test-fob-y-salida-cero.js — los dos pedidos de administración del 14/08/2026.
 *
 * QUÉ ES
 * 1. El VALOR DECLARADO (fob) se puede editar desde Salidas. El seguro sale de él, así
 *    que es un campo que mueve plata: editarlo tiene que recalcular el seguro, y en un
 *    envío liquidado tiene que quedar congelado como el resto de la plata.
 * 2. El "SIN NUMERAR" (salida 0) se puede marcar desde el alta del envío, no solo
 *    después desde Salidas.
 *
 * QUÉ SE PRUEBA, en orden de riesgo:
 *
 *  1. QUE EL RECÁLCULO CON OTRO FOB CAMBIE EL SEGURO, y que dé exactamente lo que dice
 *     el motor. Si el fob del modal no llegara al recálculo, el seguro mostrado sería el
 *     del valor viejo: se guardaría un número que no corresponde a nada.
 *  2. QUE EL PATCH GUARDE EL FOB. Sin esto la edición es decorativa.
 *  3. QUE UN ENVÍO LIQUIDADO RECHACE EL CAMBIO DE FOB (409). El seguro de una
 *     liquidación confirmada no puede moverse por la puerta de atrás.
 *  4. QUE EL ALTA CON num_sal_cero LO GUARDE, y que el alta sin él quede en 0.
 *  5. Que un fob inválido (negativo, texto) se rechace con 400 en los dos caminos.
 *
 *   cd backend && npm run test-fob-salida-cero     (EN POWERSHELL, no en el servidor)
 */

const { spawn } = require('child_process');
const path = require('path');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const { calcSeguroDHL } = require('../../shared/cotizador/cotizador-core');

const PORT = process.env.PORT_TEST || 3997;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_fob_salida_cero.db';
const TOKEN = 'token-test-fob';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
let matarServidor = () => {};
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else {
    fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`);
  }
}

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = ''; let logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; });
  let muerto = false;
  const matar = () => { if (muerto) return; muerto = true; try { srv.kill(); } catch { /* ya estaba */ } };
  matarServidor = matar;
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));

  await run("INSERT INTO clientes (id, nombre, tipo_cobro, tarifa_pct, activo) VALUES (950, 'FOB TEST', 'CC', 70, 1)");

  const alta = async (guia, extra = {}) => {
    const r = await fetch(`${BASE}/api/envios`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        cliente_id: 950, fecha: '2026-08-14', tipo_envio: 'exportacion',
        pais_destino: 'BRASIL', courier: 'DHL', tipo_paquete: 'm',
        numero_guia: guia, peso_real: 5, largo: 30, ancho: 20, alto: 20,
        total_cobrado: 300, ...extra,
      }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const leer = async (id) => (await q('SELECT * FROM envios WHERE id = ?', [id]))[0];
  const patch = async (id, body) => {
    const r = await fetch(`${BASE}/api/salidas/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const recalc = async (id, body) => {
    const r = await fetch(`${BASE}/api/salidas/${id}/recalcular`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // ── 1. El recálculo con otro fob cambia el seguro, y da lo que dice el motor ─────────
  console.log('\n1. Cambiar el valor declarado recalcula el seguro\n');

  const e1 = await alta('FOB-A', { fob: 0 });
  check('el alta con fob 0 entra', e1.status === 201, JSON.stringify(e1.body).slice(0, 100));
  const id1 = e1.body.id;

  const r0 = await recalc(id1, {});
  check('recalcular SIN mandar fob usa el guardado (seguro 0)',
    r0.status === 200 && Number(r0.body.seguro || 0) === 0, JSON.stringify(r0.body).slice(0, 120));

  const r2000 = await recalc(id1, { fob: 2000 });
  const esperado = calcSeguroDHL(2000).monto;
  check('con fob 2000 el seguro es el del motor, centavo por centavo',
    r2000.status === 200 && Math.abs(Number(r2000.body.seguro) - esperado) < 0.005,
    `dio ${r2000.body && r2000.body.seguro}, motor dice ${esperado}`);
  check('y es mayor que cero (el mínimo de DHL)', Number(r2000.body.seguro) > 0);

  // ── 2. El PATCH guarda el fob ────────────────────────────────────────────────────────
  console.log('\n2. El PATCH de Salidas guarda el valor declarado\n');

  const p1 = await patch(id1, { fob: 2000, seguro: r2000.body.seguro });
  check('el PATCH con fob entra', p1.status === 200, JSON.stringify(p1.body).slice(0, 120));
  const g1 = await leer(id1);
  check('el fob quedó guardado', Number(g1.fob) === 2000, String(g1.fob));
  check('el seguro guardado es el recalculado',
    Math.abs(Number(g1.seguro) - esperado) < 0.005, String(g1.seguro));

  const pv = await patch(id1, { fob: null });
  check('fob null se guarda como 0 (sin valor declarado), no revienta',
    pv.status === 200 && Number((await leer(id1)).fob) === 0);

  // ── 3. Envío liquidado: el fob queda congelado ───────────────────────────────────────
  console.log('\n3. En un envío liquidado el valor declarado está congelado\n');

  const e2 = await alta('FOB-B', { fob: 1000 });
  await run('UPDATE envios SET liquidado = 1 WHERE id = ?', [e2.body.id]);

  const p409 = await patch(e2.body.id, { fob: 5000 });
  check('cambiar el fob de un liquidado da 409', p409.status === 409, `status=${p409.status}`);
  check('y el mensaje nombra al fob', /fob/i.test((p409.body && p409.body.error) || ''),
    (p409.body && p409.body.error || '').slice(0, 90));
  check('el fob no se movió', Number((await leer(e2.body.id)).fob) === 1000);

  const pIgual = await patch(e2.body.id, { fob: 1000 });
  check('mandar el MISMO fob en un liquidado no se rechaza (no cambia nada)',
    pIgual.status === 200, `status=${pIgual.status}`);

  // ── 4. El alta con "sin numerar" ─────────────────────────────────────────────────────
  console.log('\n4. La salida 0 se puede marcar desde el alta\n');

  const e3 = await alta('FOB-C', { num_sal_cero: 1 });
  check('el alta con num_sal_cero entra', e3.status === 201);
  check('quedó marcado sin numerar', Number((await leer(e3.body.id)).num_sal_cero) === 1);
  check('un alta normal queda en 0 (no se contagia)',
    Number((await leer(id1)).num_sal_cero) === 0);

  const pu = await fetch(`${BASE}/api/envios/${e3.body.id}`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ num_sal_cero: 0 }),
  });
  check('la edición desde Cargar envío puede destildarla', pu.status === 200
    && Number((await leer(e3.body.id)).num_sal_cero) === 0, `status=${pu.status}`);

  // ── 5. Valores inválidos ─────────────────────────────────────────────────────────────
  console.log('\n5. Un valor declarado inválido se rechaza con un mensaje\n');

  check('fob negativo en el PATCH da 400', (await patch(id1, { fob: -5 })).status === 400);
  check('fob texto en el PATCH da 400', (await patch(id1, { fob: 'hola' })).status === 400);
  check('fob negativo en el recálculo da 400', (await recalc(id1, { fob: -1 })).status === 400);

  await new Promise((res) => db.close(() => res()));
  // El formato lo lee verificar.js para sumar las tandas: no cambiarlo.
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exitCode = fail ? 1 : 0;
  matar();
  setTimeout(() => {}, 200).unref();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  matarServidor();
});
