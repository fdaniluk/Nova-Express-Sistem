#!/usr/bin/env node
/**
 * test-desglose-venta-surge.js — el flete de la liquidación tiene que ser kg × precio (02/09/2026).
 *
 * De dónde salió: la oficina liquidó al cliente de cueros (precio por kilo) con el sistema
 * y comparó contra su Excel. El TOTAL cerraba, pero el flete de la liquidación daba 3 a
 * 11 USD más que kg × precio en cada envío. Siempre exactamente surge × fuel / (1 + fuel).
 *
 * La causa: el surge de UPS lleva combustible (UPS lo factura así, y el motor hace lo
 * mismo). El costo congelado guarda el surge PELADO en `adicionales` y su fuel dentro de
 * la columna `fuel`. Al descomponer la venta restando el surge pelado, el fuel del surge
 * no tenía dónde ir y caía adentro del flete.
 *
 * Lo que cuida esta tanda: el flete de la liquidación es kg × precio (o flete de tabla ×
 * (1 + profit)) EXACTO, el fuel del surge viaja junto al surge en Adicional, el total no se
 * mueve ni un centavo, Salidas y la liquidación reparten igual, y los envíos viejos sin
 * desglose por tipo siguen cerrando como siempre.
 *
 *   cd backend && node scripts/test-desglose-venta-surge.js
 */

const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const { descomponerVenta, surgeDe } = require('../src/utils/desgloseVenta');
const core = require('../../shared/cotizador/cotizador-core');

const PORT = process.env.PORT_TEST || 3948;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_desglose_surge.db';
const TOKEN = 'token-test-surge';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const cerca = (a, b, t = 0.011) => Math.abs(Number(a) - Number(b)) <= t;
const R2 = (n) => Math.round(n * 100) / 100;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const cierra = (d) => cerca(d.flete + d.fuel + d.seguro + d.adicional, d.total);

async function main() {
  console.log('\n1. La cuenta, sola (el caso de cueros: Canadá, 28,5 kg, 5,22 USD/kg, fuel 36,5%)\n');
  const KG = 28.5, PRECIO = 5.22, F = 36.5;
  const ex = [{ tipo: 'surge', monto: 14.25 }, { tipo: 'manejo', monto: 27.65 }];
  const total = R2((KG * PRECIO + 14.25) * (1 + F / 100) + 27.65);
  const con = descomponerVenta({ total_cobrado: total, seguro: 0, adicionales: 41.9, fuel_pct: F, extras: ex });
  check('el flete es kg × precio, clavado', cerca(con.flete, KG * PRECIO), `${con.flete} vs ${R2(KG * PRECIO)}`);
  check('el fuel es el % sobre ese flete', cerca(con.fuel, con.flete * F / 100), `${con.fuel}`);
  check('el adicional trae el surge CON su fuel + el manejo',
    cerca(con.adicional, 14.25 * (1 + F / 100) + 27.65), `${con.adicional}`);
  check('y la suma cierra en el total', cierra(con));

  const sin = descomponerVenta({ total_cobrado: total, seguro: 0, adicionales: 41.9, fuel_pct: F });
  check('sin desglose por tipo (envío viejo) reparte como siempre y también cierra',
    cierra(sin) && cerca(sin.flete, KG * PRECIO + 14.25 * (F / 100) / (1 + F / 100)), `${sin.flete}`);
  check('la diferencia entre los dos es exactamente el fuel del surge repartido',
    cerca(sin.flete - con.flete, 3.81, 0.02), `${R2(sin.flete - con.flete)} (la oficina vio 3,81)`);

  const dhl = descomponerVenta({ total_cobrado: 500, seguro: 17.5, adicionales: 58.8, fuel_pct: F,
    extras: [{ tipo: 'gogreen', monto: 58.8 }] });
  const dhlViejo = descomponerVenta({ total_cobrado: 500, seguro: 17.5, adicionales: 58.8, fuel_pct: F });
  check('DHL (sin surge) no cambia ni un centavo', cerca(dhl.flete, dhlViejo.flete) && cerca(dhl.adicional, dhlViejo.adicional));
  check('acepta el JSON crudo de la columna', cerca(descomponerVenta({ total_cobrado: total, adicionales: 41.9, fuel_pct: F, extras: JSON.stringify(ex) }).flete, KG * PRECIO));
  check('un JSON roto no rompe: reparte como viejo', cierra(descomponerVenta({ total_cobrado: total, adicionales: 41.9, fuel_pct: F, extras: '{no' })));
  check('surgeDe suma solo el surge', surgeDe(ex) === 14.25 && surgeDe(null) === 0 && surgeDe('x') === 0);
  check('con fuel 0 no hay nada que mover', cerca(descomponerVenta({ total_cobrado: 200, adicionales: 14.25, fuel_pct: 0, extras: ex }).flete, 185.75));

  // ── De punta a punta ─────────────────────────────────────────────────────────
  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  let muerto = false;
  const matar = () => { if (muerto) return; muerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matar);
  // Hasta 60 segundos, no 12. En Windows el PRIMER arranque de node del día puede tardar
  // (el antivirus escanea node_modules la primera vez que se carga), y con 12 s el test
  // reventaba con un ECONNREFUSED que parecía del cortafuegos. Si igual no llega, se dice
  // en una línea, no con un stack de fetch.
  // Espera la línea de "listo" que imprime NUESTRO servidor (no un /api/health que puede
  // contestar otro node vivo en el puerto), hasta 60 s: en Windows el primer arranque de
  // node del día tarda y con 12 s el test reventaba con un ECONNREFUSED que parecía del
  // cortafuegos. Ver scripts/_base-test.js.
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const hoy = new Date().toISOString().slice(0, 10);
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const run = (q, p = []) => new Promise((res, rej) => db.run(q, p, function (e) { e ? rej(e) : res(this); }));
  const get = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => (e ? rej(e) : res(r))));

  console.log('\n2. Un cliente por kilo, de punta a punta (alta → liquidación → Salidas)\n');
  const cli = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'CUEROS TEST', tarifa_pct: 100, tipo_cobro: 'CC' }),
  })).json();
  await run("UPDATE clientes SET modo_tarifa = 'por_kg' WHERE id = ?", [cli.id]);
  await run('INSERT INTO tarifa_kg_overrides (cliente_id, servicio, tipo, zona, peso_min, peso_max, precio_kg) VALUES (?, ?, ?, NULL, NULL, NULL, ?)',
    [cli.id, 'UPS_EXP', 'export', PRECIO]);

  const env = await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion',
      numero_guia: '1Z327W0967939251XX', pais_destino: 'Canadá',
      peso_real: KG, largo: 40, ancho: 30, alto: 20, fob: 0, total_cobrado: 0, fuel_pct: F,
    }),
  })).json();
  check('el envío se cargó', !!env.id, JSON.stringify(env).slice(0, 120));

  // La venta la calcula el circuito real: "Calcular venta" de Salidas = cotizar({ envio_id }).
  const cot = await (await fetch(BASE + '/api/liquidaciones/cotizar', {
    method: 'POST', headers: H, body: JSON.stringify({ envio_id: env.id }),
  })).json();
  check('cotiza por kilo con el precio del cliente', cot.modo_venta === 'por_kg' && cerca(cot.precio_kg_aplicado, PRECIO),
    `${cot.modo_venta} / ${cot.precio_kg_aplicado}`);
  check('con el fuel congelado del envío', cerca(cot.fuel_aplicado, F), String(cot.fuel_aplicado));
  await fetch(`${BASE}/api/salidas/${env.id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ total_cobrado: cot.precioFinal }),
  });

  const fila = await get('SELECT flete, fuel, seguro, adicionales, extras_json, total_cobrado FROM envios WHERE id = ?', [env.id]);
  const surgeGuardado = surgeDe(fila.extras_json);
  check('el costo congelado tiene el surge por tipo', surgeGuardado > 0, String(fila.extras_json));
  check('y el surge es 0,50 por kilo facturable', cerca(surgeGuardado, 0.5 * KG), String(surgeGuardado));

  const prev = await (await fetch(`${BASE}/api/liquidaciones/preview`, {
    method: 'POST', headers: H, body: JSON.stringify({ cliente_id: cli.id, envio_ids: [env.id] }),
  })).json();
  const it = (prev.items || [])[0];
  check('la liquidación toma el envío', !!it);
  check('EL FLETE DE LA LIQUIDACIÓN ES kg × precio', it && cerca(it.flete, KG * PRECIO), `${it && it.flete} vs ${R2(KG * PRECIO)}`);
  check('el fuel es el % sobre ese flete', it && cerca(it.fuel, it.flete * F / 100), `${it && it.fuel}`);
  check('el adicional trae el surge con su fuel', it && cerca(it.adicional, R2((fila.adicionales - surgeGuardado) + surgeGuardado * (1 + F / 100))),
    `${it && it.adicional}`);
  check('y la suma cierra en lo cobrado', it && cerca(it.flete + it.fuel + it.seguro + it.adicional, cot.precioFinal),
    `${it && R2(it.flete + it.fuel + it.seguro + it.adicional)} vs ${cot.precioFinal}`);

  const sal = await (await fetch(`${BASE}/api/salidas?desde=${hoy}&hasta=${hoy}`, { headers: H })).json();
  const filas = Array.isArray(sal) ? sal : (sal.envios || sal.data || []);
  const f = filas.find((x) => x.id === env.id);
  check('el bloque Venta de Salidas reparte IGUAL que la liquidación',
    f && f.venta_desglose && cerca(f.venta_desglose.flete, it.flete) && cerca(f.venta_desglose.adicional, it.adicional),
    JSON.stringify(f && f.venta_desglose));

  console.log('\n3. Un cliente por porcentaje: el flete es tabla × (1 + profit)\n');
  const cliPct = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'PCT TEST', tarifa_pct: 80, tipo_cobro: 'CC' }),
  })).json();
  const envPct = await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cliPct.id, fecha: hoy, courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion',
      numero_guia: '1Z327W0967939252XX', pais_destino: 'Canadá',
      peso_real: 10, largo: 30, ancho: 20, alto: 15, fob: 0, total_cobrado: 0, fuel_pct: F,
    }),
  })).json();
  const cotPct = await (await fetch(BASE + '/api/liquidaciones/cotizar', {
    method: 'POST', headers: H, body: JSON.stringify({ envio_id: envPct.id }),
  })).json();
  await fetch(`${BASE}/api/salidas/${envPct.id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ total_cobrado: cotPct.precioFinal }),
  });
  const filaPct = await get('SELECT flete FROM envios WHERE id = ?', [envPct.id]);
  const prevPct = await (await fetch(`${BASE}/api/liquidaciones/preview`, {
    method: 'POST', headers: H, body: JSON.stringify({ cliente_id: cliPct.id, envio_ids: [envPct.id] }),
  })).json();
  const itPct = (prevPct.items || [])[0];
  // Tolerancia de 2 centavos: el flete se reconstruye dividiendo un total ya redondeado a
  // 2 decimales por (1 + fuel), así que puede caer un centavo al lado del producto exacto.
  check('flete de venta = flete de tabla × 1,80 (± 1 centavo de redondeo)', itPct && cerca(itPct.flete, filaPct.flete * 1.8, 0.02),
    `${itPct && itPct.flete} vs ${R2(filaPct.flete * 1.8)}`);
  check('y la suma cierra', itPct && cerca(itPct.flete + itPct.fuel + itPct.seguro + itPct.adicional, cotPct.precioFinal));

  console.log('\n4. Lo que ya está liquidado no se mueve\n');
  const liq = await (await fetch(BASE + '/api/liquidaciones', {
    method: 'POST', headers: H,
    body: JSON.stringify({ cliente_id: cli.id, envio_ids: [env.id], periodo_desde: hoy, periodo_hasta: hoy, confirmar: true }),
  })).json();
  const liqId = liq.id || (liq.liquidacion && liq.liquidacion.id);
  check('se confirmó una liquidación', !!liqId, JSON.stringify(liq).slice(0, 120));
  const itemAntes = await get('SELECT flete, adicional FROM liquidacion_items WHERE liquidacion_id = ? AND envio_id = ?', [liqId, env.id]);
  // Se le borra el desglose por tipo al envío: si la liquidación recalculara, cambiaría.
  await run('UPDATE envios SET extras_json = NULL WHERE id = ?', [env.id]);
  const leida = await (await fetch(`${BASE}/api/liquidaciones/${liqId}`, { headers: H })).json();
  const itemLeido = (leida.items || []).find((x) => x.envio_id === env.id);
  check('el ítem confirmado se lee tal cual quedó guardado (no recalcula)',
    itemLeido && cerca(itemLeido.flete, itemAntes.flete) && cerca(itemLeido.adicional, itemAntes.adicional),
    JSON.stringify(itemLeido && { flete: itemLeido.flete, adicional: itemLeido.adicional }));

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  matar();
  await esperar(300);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
