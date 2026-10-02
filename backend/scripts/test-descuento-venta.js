#!/usr/bin/env node
/**
 * test-descuento-venta.js — descuento especial sobre el flete de venta (02/10/2026).
 *
 * Pedido de Felipe: para clientes que ya tienen tarifa cargada y a los que se les hace un
 * precio puntual. El % se tipea en el cotizador, viaja en la cotización guardada y, al
 * cargar el envío desde esa cotización, el sistema lo vuelve a aplicar aunque el peso haya
 * cambiado (30 kg cotizados con 10 % → el envío pesó 40 kg → 40 kg con 10 % off).
 *
 *   cd backend && node scripts/test-descuento-venta.js
 */
const { spawn } = require('child_process');
const path = require('path');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const core = require('../../shared/cotizador/cotizador-core.js');

const PORT = process.env.PORT_TEST || 3961;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_descuento_venta.db';
const TOKEN = 'token-test-descuento';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
let matarServidor = () => {};
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else {
    fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`);
  }
}
const cerca = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) < tol;

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
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));
  const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await run("INSERT INTO clientes (id, nombre, tipo_cobro, tarifa_pct, activo) VALUES (980, 'DESCUENTO SA', 'CC', 50, 1)");
  const J = async (metodo, u, body) => {
    const r = await fetch(BASE + u, { method: metodo, headers: H, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // ── 1. El motor ──────────────────────────────────────────────────────────────────────
  console.log('\n1. Motor (cotizador-core)\n');
  const base = { pais: 'Estados Unidos', tipo: 'export', pf: 30, fob: 100, fuelPct: 20, profitPct: 50, bultosProc: [{ dims: [10, 10, 10], pr: 30, pf: 30 }], contenido: 'paquete' };
  const sin = core.cotizarServicio('UPS_EXP', base);
  const con = core.cotizarServicio('UPS_EXP', { ...base, descuentoPct: 10 });
  check('el flete de lista es el mismo con y sin descuento', cerca(con.conGanLista, sin.conGan), `${con.conGanLista} vs ${sin.conGan}`);
  check('el flete de venta baja exactamente el 10 %', cerca(con.conGan, sin.conGan * 0.9) && cerca(con.descuentoMonto, sin.conGan * 0.1), `${con.conGan} / ${con.descuentoMonto}`);
  check('el fuel sigue al flete rebajado y el seguro no cambia', cerca(con.fuelMonto, (con.conGan + con.surge) * 0.2) && cerca(con.seguro, sin.seguro));
  check('el total baja 10 % × flete × (1 + fuel)', cerca(con.total, sin.total - sin.conGan * 0.1 * 1.2), `${con.total} vs ${sin.total}`);
  check('sin descuento no aparece nada (descuentoPct 0, monto 0)', sin.descuentoPct === 0 && sin.descuentoMonto === 0);
  const dhl = core.cotizarServicio('DHL', { ...base, pais: 'Alemania', descuentoPct: 25 });
  check('DHL: también sobre el flete', cerca(dhl.conGan, dhl.conGanLista * 0.75) && dhl.descuentoPct === 25);
  const porKg = core.cotizarServicio('UPS_EXP', { ...base, precioKgVenta: 8, descuentoPct: 10 });
  check('tarifa por kilo: el descuento es sobre precio × kilos', cerca(porKg.conGanLista, 240) && cerca(porKg.conGan, 216));

  // ── 2. El endpoint de cotizar ─────────────────────────────────────────────────────────
  console.log('\n2. POST /liquidaciones/cotizar\n');
  const cuerpo = { cliente_id: 980, servicio: 'UPS_EXP', pais: 'Estados Unidos', tipo: 'export', pesoFacturable: 30, fob: 100, fuelPct: 20, contenido: 'paquete', bultos: [{ peso_real: 30, largo: 10, ancho: 10, alto: 10 }] };
  const c0 = (await J('POST', '/api/liquidaciones/cotizar', cuerpo)).body;
  const c10 = (await J('POST', '/api/liquidaciones/cotizar', { ...cuerpo, descuentoPct: 10 })).body;
  check('devuelve descuento_aplicado, descuento_pct y descuento_monto', c10.descuento_aplicado === 10 && c10.descuento_pct === 10 && c10.descuento_monto > 0, JSON.stringify({ a: c10.descuento_aplicado, p: c10.descuento_pct, m: c10.descuento_monto }));
  check('la utilidad baja lo mismo que el precio', cerca(c0.precioFinal - c10.precioFinal, c0.profitMonto - c10.profitMonto), `${c0.precioFinal - c10.precioFinal} vs ${c0.profitMonto - c10.profitMonto}`);
  check('el precio base (sin profit) no cambia', cerca(c0.precioBase, c10.precioBase));
  const c150 = (await J('POST', '/api/liquidaciones/cotizar', { ...cuerpo, descuentoPct: 150 })).body;
  check('más de 100 se recorta a 100 (flete de venta 0)', c150.descuento_aplicado === 100);

  // ── 3. La cotización guardada y el panel ─────────────────────────────────────────────
  console.log('\n3. Cotización guardada → panel del cliente\n');
  const ctz = await J('POST', '/api/cotizaciones', {
    cliente_id: 980, pais: 'Estados Unidos', tipo_envio: 'exportacion', contenido: 'paquete',
    zona: '2', peso_facturable: 30, cantidad_bultos: 1, valor_declarado: 100, viaja_al_cliente: 1,
    entrada: { bultos: [{ pr: 30, l: 10, a: 10, al: 10, pv: 0.2, pf: 30 }], ganancia_pct: 50, descuento_pct: 10, fuel_fuente: 'manual' },
    opciones: [{ viaja: 1, servicio: 'UPS Worldwide Expedited', total: c10.precioFinal, pf: 30, zona: 2, costo: 100, descuento_pct: 10, descuento_monto: c10.descuento_monto }],
  });
  check('se guarda', ctz.status === 201, JSON.stringify(ctz.body).slice(0, 100));
  const rec = (await J('GET', '/api/cotizaciones/cliente/980/recientes')).body;
  check('el panel trae datos.descuento_pct = 10 y la opción también', rec.length === 1 && rec[0].datos.descuento_pct === 10 && rec[0].opciones_resumen[0].descuento_pct === 10, JSON.stringify(rec[0] && rec[0].datos));

  // ── 4. El envío ──────────────────────────────────────────────────────────────────────
  console.log('\n4. El envío conserva el descuento y "Calcular venta" lo respeta\n');
  const alta = await J('POST', '/api/envios', {
    cliente_id: 980, fecha: '2026-10-02', courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion', tipo_paquete: 'm',
    numero_guia: '1Z000DESC00000001', pais_destino: 'Estados Unidos', cantidad_bultos: 1, peso_real: 40, largo: 10, ancho: 10, alto: 10,
    fob: 100, total_cobrado: 300, descuento_venta_pct: 10,
  });
  check('POST /envios acepta descuento_venta_pct', alta.status === 201, JSON.stringify(alta.body).slice(0, 120));
  const envioId = alta.body.id;
  const fila = await get('SELECT descuento_venta_pct FROM envios WHERE id = ?', [envioId]);
  check('queda guardado en envios.descuento_venta_pct', fila && Number(fila.descuento_venta_pct) === 10, JSON.stringify(fila));
  const sal = (await J('GET', '/api/salidas?desde=2026-10-02&hasta=2026-10-02')).body.find((e) => e.id === envioId);
  check('Salidas lo devuelve en la fila', sal && Number(sal.descuento_venta_pct) === 10);
  const cv = (await J('POST', '/api/liquidaciones/cotizar', { envio_id: envioId, fuelPct: 20 })).body;
  check('cotizar con envio_id (sin mandar el %) aplica el 10 % guardado — es la recotización a 40 kg', cv.descuento_aplicado === 10 && cv.descuento_pct === 10, JSON.stringify({ a: cv.descuento_aplicado, p: cv.descuento_pct }));
  const cv0 = (await J('POST', '/api/liquidaciones/cotizar', { envio_id: envioId, fuelPct: 20, descuentoPct: 0 })).body;
  check('mandar descuentoPct 0 en el body lo saca (el body pisa al envío)', cv0.descuento_aplicado === 0);
  const edit = await J('PUT', `/api/envios/${envioId}`, { descuento_venta_pct: 0 });
  const fila2 = await get('SELECT descuento_venta_pct FROM envios WHERE id = ?', [envioId]);
  check('PUT con 0 lo borra (NULL)', edit.status === 200 && (fila2.descuento_venta_pct === null), JSON.stringify(fila2));
  const edit2 = await J('PUT', `/api/envios/${envioId}`, { observaciones: 'x' });
  const fila3 = await get('SELECT descuento_venta_pct FROM envios WHERE id = ?', [envioId]);
  check('PUT sin el campo no lo toca', edit2.status === 200 && fila3.descuento_venta_pct === null);

  matar();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => {}, 200).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exitCode = 1; matarServidor(); });
