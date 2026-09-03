#!/usr/bin/env node
/**
 * test-cruce-tarifa-50.js — el MISMO envío por todos los caminos del sistema (01/09/2026).
 *
 * Salió de un pedido de Felipe apenas se desplegó la tarifa +50: *"revisá que en todos
 * los lados donde esta tarifa vaya a modificar algo haya quedado todo bien y esté dando
 * todo el mismo número"*.
 *
 * La regla número uno del sistema es que todos los cotizadores den el mismo número. El
 * motor es uno solo, pero eso por sí solo no alcanza: lo que puede desviarse es lo que
 * cada pantalla le manda y lo que cada módulo hace después con el resultado. Esta tanda
 * agarra UN envío de más de 50 kg —el caso donde la tarifa nueva cambia el precio— y lo
 * hace pasar por los seis caminos:
 *
 *   1. el cotizador manual (el motor directo)
 *   2. el panel de precio de Cargar envío (cotizarEnvio)
 *   3. el costo que se congela en el envío (desglosarCosto)
 *   4. el envío realmente cargado por la API, y lo que muestra Salidas
 *   5. la liquidación
 *   6. el tarifario que se le manda al cliente y el link público de cotización
 *
 * Los seis tienen que cerrar en el mismo número, y las identidades del sistema
 * (venta − profit = costo · flete+seguro+fuel+adicionales = total) tienen que seguir
 * valiendo con el GoGreen afuera.
 *
 * Y una cosa que NO tiene que pasar: que al cliente le llegue, por el link público, que
 * el envío sale por otra cuenta de DHL. Eso es interno.
 *
 *   cd backend && node scripts/test-cruce-tarifa-50.js
 */

const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3945, BASE = `http://localhost:${PORT}`, DB = process.env.DB_PATH_TEST || '/tmp/test_cruce_50.db', TOKEN = 'token-test-cruce50';
let ok = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } };
const cerca = (a, b, t = 0.02) => Math.abs(Number(a) - Number(b)) <= t;
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
const R2 = n => Math.round(n * 100) / 100;

const core = require('../../shared/cotizador/cotizador-core');
const calc = require('../src/services/calculos.service');

// El envío de prueba: DHL exportación, España (zona 4), 60 kg, un bulto.
const PAIS = 'España', KG = 60, FUEL = 39.5, PROFIT = 100;
const BULTO = { pesoReal: KG, largo: 50, ancho: 40, alto: 30 };
const BULTO_PROC = [{ dims: [50, 40, 30], pr: KG }];

async function main() {
  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  process.on('exit', () => { try { srv.kill(); } catch {} });
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
  const get = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => e ? rej(e) : res(r)));

  // ── 1. EL MOTOR (cotizador manual) ────────────────────────────────────────
  console.log('\n1. El motor — cotizador manual\n');
  const m = core.cotizarServicio('DHL', {
    pais: PAIS, tipo: 'export', pf: KG, fob: 0, fuelPct: FUEL, profitPct: PROFIT, bultosProc: BULTO_PROC,
  });
  const m0 = core.cotizarServicio('DHL', {
    pais: PAIS, tipo: 'export', pf: KG, fob: 0, fuelPct: FUEL, profitPct: 0, bultosProc: BULTO_PROC,
  });
  console.log(`     flete ${m.fleteBase} · gogreen ${m.goGreen} · total venta ${R2(m.total)} · total costo ${R2(m0.total)}`);
  check('usa la tarifa +50', m.tarifa50 === true);
  check('flete 396,00 (PDF)', cerca(m.fleteBase, 396));
  check('sin GoGreen', m.goGreen === 0);

  // ── 2. cotizarEnvio (panel de precio de Cargar envío / API cotizar) ───────
  console.log('\n2. Cargar envío — el panel de precio\n');
  const ce = calc.cotizarEnvio({
    pais: PAIS, tipo: 'export', servicio: 'DHL', pesoFacturable: KG, fob: 0,
    fuelPct: FUEL, profitPct: PROFIT, bultos: [BULTO],
  });
  check('el precio final es el MISMO que el del cotizador', cerca(ce.precioFinal, m.total), `${ce.precioFinal} vs ${R2(m.total)}`);
  check('avisa la tarifa +50', ce.tarifa50 === true);
  check('zona igual', ce.zona === m.zona);

  // ── 3. desglosarCosto (lo que se congela en el envío) ─────────────────────
  console.log('\n3. El costo congelado del envío\n');
  const dc = calc.desglosarCosto({
    pais: PAIS, tipo: 'export', servicio: 'DHL', pesoFacturable: KG, fob: 0,
    fuelPct: FUEL, bultos: [BULTO],
  });
  check('el costo es el del motor a profit 0', cerca(dc.total, m0.total), `${dc.total} vs ${R2(m0.total)}`);
  check('flete congelado 396,00', cerca(dc.flete, 396), String(dc.flete));
  check('marca tarifa_50', dc.tarifa_50 === 1);
  check('ningún renglón de GoGreen', !dc.extras.some(e => e.tipo === 'gogreen'), JSON.stringify(dc.extras));
  check('venta − profit = costo (la identidad del sistema)',
    cerca(ce.precioFinal - ce.profitMonto, dc.total), `${R2(ce.precioFinal - ce.profitMonto)} vs ${dc.total}`);
  check('flete + seguro + fuel + adicionales = total (el desglose cierra)',
    cerca(dc.flete + dc.seguro + dc.fuel + dc.adicionales, dc.total));

  // ── 4. El envío cargado de verdad ─────────────────────────────────────────
  console.log('\n4. El envío cargado por la API\n');
  const cli = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'AUD 50', tarifa_pct: PROFIT, tipo_cobro: 'CC' }),
  })).json();
  const venta = R2(m.total);
  const env = await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'DHL', tipo_envio: 'exportacion',
      numero_guia: '1000000501', pais_destino: PAIS, peso_real: KG, largo: 50, ancho: 40, alto: 30,
      fob: 0, total_cobrado: venta, fuel_pct: FUEL,
    }),
  })).json();
  const fila = await get('SELECT flete, seguro, fuel, adicionales, tarifa_50, total_cobrado, extras_json FROM envios WHERE id=?', [env.id]);
  check('el envío guarda el flete del motor', cerca(fila.flete, dc.flete), `${fila.flete} vs ${dc.flete}`);
  check('y el fuel del motor', cerca(fila.fuel, dc.fuel), `${fila.fuel} vs ${dc.fuel}`);
  check('y los adicionales del motor', cerca(fila.adicionales, dc.adicionales), `${fila.adicionales} vs ${dc.adicionales}`);
  check('y la marca de tarifa +50', fila.tarifa_50 === 1);

  // ── 5. Salidas ────────────────────────────────────────────────────────────
  console.log('\n5. Salidas — el bloque de plata\n');
  const sal = await (await fetch(`${BASE}/api/salidas?desde=${hoy}&hasta=${hoy}`, { headers: H })).json();
  const filas = Array.isArray(sal) ? sal : (sal.envios || sal.data || []);
  const f = filas.find(x => x.id === env.id);
  check('la compra estimada es el costo congelado', cerca(f.compra_estimada ?? f.compra_total, dc.total),
    `${f.compra_estimada ?? f.compra_total} vs ${dc.total}`);
  check('el profit estimado es venta − compra', cerca(f.profit_estimado, venta - dc.total),
    `${f.profit_estimado} vs ${R2(venta - dc.total)}`);
  check('y coincide con el profit que dijo el cotizador', cerca(f.profit_estimado, ce.profitMonto),
    `${f.profit_estimado} vs ${ce.profitMonto}`);
  check('la fila trae el chip +50', f.tarifa_50 === 1);

  // ── 6. Liquidación ────────────────────────────────────────────────────────
  console.log('\n6. Liquidación\n');
  const prev = await (await fetch(`${BASE}/api/liquidaciones/preview`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ cliente_id: cli.id, desde: hoy, hasta: hoy, envio_ids: [env.id] }),
  })).json();
  const it = (prev.items || [])[0];
  check('la liquidación toma el envío', !!it, JSON.stringify(Object.keys(prev)).slice(0, 120));
  if (it) {
    check('el desglose cierra en lo cobrado', cerca(it.flete + it.fuel + it.seguro + it.adicional, venta),
      `${R2(it.flete + it.fuel + it.seguro + it.adicional)} vs ${venta}`);
    check('no recotiza: el total es el cargado', cerca(it.total_usd ?? it.total, venta),
      String(it.total_usd ?? it.total));
    check('la utilidad interna coincide con el profit estimado',
      cerca(it.utilidad_usd, venta - dc.total), `${it.utilidad_usd} vs ${R2(venta - dc.total)}`);
  }

  // ── 7. Tarifario del cliente ──────────────────────────────────────────────
  console.log('\n7. Tarifario para el cliente\n');
  const t = await (await fetch(
    `${BASE}/api/clientes/${cli.id}/tarifario?servicios=DHL&tipo=export&desde=49&hasta=61&paso=1`,
    { headers: H })).json();
  const txt = JSON.stringify(t);
  const conGan0 = core.cotizarServicio('DHL', {
    pais: PAIS, tipo: 'export', pf: KG, fob: 0, fuelPct: 0, profitPct: PROFIT, bultosProc: [],
  }).conGan;
  const conGan50 = core.cotizarServicio('DHL', {
    pais: PAIS, tipo: 'export', pf: 50, fob: 0, fuelPct: 0, profitPct: PROFIT, bultosProc: [],
  }).conGan;
  check('el tarifario trae la celda de 60 kg con el precio de la +50',
    txt.includes(String(R2(conGan0))), `busco ${R2(conGan0)} · ${txt.slice(0, 200)}`);
  check('y la de 50 kg con el precio de siempre',
    txt.includes(String(R2(conGan50))), `busco ${R2(conGan50)}`);
  check('la celda de 60 kg es el flete de venta pelado (396 × 2)', cerca(conGan0, 792), String(conGan0));

  // ── 8. Link público ───────────────────────────────────────────────────────
  console.log('\n8. Link público de cotización\n');
  const link = await (await fetch(`${BASE}/api/cotizador-links`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ cliente_id: cli.id, couriers: 'dhl', nombrar: 1, dias: 30 }),
  })).json();
  const tok = link.codigo || link.token || (link.link && (link.link.codigo || link.link.token));
  let pub = null;
  if (tok) {
    pub = await (await fetch(`${BASE}/api/publico/cotizador/${tok}/cotizar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'export', pais: PAIS, valor: 0, fuel: FUEL, bultos: [{ pr: KG, l: 50, a: 40, al: 30 }] }),
    })).json();
  }
  if (pub && pub.opciones && pub.opciones.length) {
    const o = pub.opciones[0];
    check('el total público es el mismo del cotizador', cerca(o.total, m.total), `${o.total} vs ${R2(m.total)}`);
    const crudo = JSON.stringify(pub).toLowerCase();
    check('y NO le filtra al cliente que es otra cuenta',
      !crudo.includes('cuenta') && !crudo.includes('tarifa50') && !crudo.includes('+50'),
      JSON.stringify(pub).slice(0, 200));
    check('tampoco le cobra un GoGreen que no existe',
      !crudo.includes('gogreen') && !crudo.includes('ambiental'),
      JSON.stringify(o.extras));
  } else {
    check('el link público cotiza', false, JSON.stringify(link).slice(0, 200) + ' | ' + JSON.stringify(pub).slice(0, 200));
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  try { srv.kill(); } catch {}
  await esperar(300);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
