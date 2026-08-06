#!/usr/bin/env node
/**
 * test-pantalla-seguro-cliente.js — el seguro negociado por cliente, en un navegador de verdad.
 *
 * La regla de cálculo la cubre test-seguro-cliente.js. Esto controla lo otro: que la oficina
 * pueda efectivamente cargarlo, verlo explicado, que sobreviva a recargar y que el cotizador
 * cobre lo que dice la pantalla. Una regla perfecta con un campo que no guarda no le sirve a
 * nadie.
 *
 * El caso real: Gianastasio y Cueros tienen 1% negociado en vez del 1,5% de lista.
 *
 *   cd backend && node scripts/test-pantalla-seguro-cliente.js
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.log('⚠ playwright no está instalado — se saltea (necesita navegador de verdad).');
  process.exit(0);
}

const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3971;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_seguro_cliente.db';
const TOKEN = 'token-test-pantalla-seguro';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);
  // Ver test-api-documentos-dhl.js: en Windows hay que esperar a que el hijo muera de verdad.
  const esperarSrvMuerto = () => new Promise((res) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return res();
    srv.once('exit', res);
    setTimeout(res, 2000);
  });

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await esperar(300);
  }
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

  const cli = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H,
    body: JSON.stringify({ nombre: 'SEGURO PANTALLA TEST', tarifa_pct: 80 }),
  })).json();

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    // El CDN de xlsx no se puede bajar en un entorno sin internet; no es un error de la app.
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) {
      errores.push(m.text());
    }
  });

  console.log('\n1. Los campos están y explican la regla\n');

  await page.goto(`${BASE}/pages/clientes-perfil.html?id=${cli.id}`);
  await esperar(2200);
  await page.click('text=Editar tarifas');
  await esperar(1200);

  check('está el campo de porcentaje', !!(await page.$('#tarifas-seguro-pct')));
  check('está el campo de mínimo', !!(await page.$('#tarifas-seguro-min')));
  const hint0 = await page.textContent('#tarifas-seguro-hint');
  check('sin seguro propio, el cartel explica la escala de cada courier',
    /escala de cada courier/.test(hint0) && /17,50/.test(hint0), hint0);
  check('el botón de quitar arranca oculto',
    await page.$eval('#btn-borrar-seguro', (e) => e.classList.contains('hidden')));

  console.log('\n2. Cargar 1% con mínimo 10\n');

  await page.fill('#tarifas-seguro-pct', '1');
  await page.fill('#tarifas-seguro-min', '10');
  await page.click('#btn-guardar-seguro');
  await esperar(1500);

  const hint1 = await page.textContent('#tarifas-seguro-hint');
  check('el cartel pasa a decir el 1% y el mínimo',
    /1% del valor declarado/.test(hint1) && /minimo USD 10/.test(hint1), hint1);
  check('el cartel avisa que reemplaza la escala del courier',
    /Reemplaza la escala/.test(hint1), hint1);
  check('aparece el botón de quitar',
    !(await page.$eval('#btn-borrar-seguro', (e) => e.classList.contains('hidden'))));

  const guardado = await (await fetch(`${BASE}/api/clientes/${cli.id}`, { headers: H })).json();
  check('quedó guardado en la base',
    Number(guardado.seguro_pct_propio) === 1 && Number(guardado.seguro_min_propio) === 10,
    JSON.stringify({ p: guardado.seguro_pct_propio, m: guardado.seguro_min_propio }));

  await page.reload();
  await esperar(2200);
  await page.click('text=Editar tarifas');
  await esperar(1200);
  check('sobrevive a recargar la página',
    (await page.inputValue('#tarifas-seguro-pct')) === '1' &&
    (await page.inputValue('#tarifas-seguro-min')) === '10');

  console.log('\n3. El cotizador cobra lo que dice la pantalla\n');

  // Se cotiza por el MISMO endpoint que usa el cotizador, con el cliente ya cargado.
  // El endpoint no devuelve el seguro en un campo propio: viene dentro de `extras`, que es
  // la lista de [etiqueta, monto] que arma el motor. En UPS la etiqueta es "Seguro".
  const seguroDe = (r) => {
    const fila = (r.extras || []).find((e) => String(e[0]).startsWith('Seguro'));
    return fila ? Number(fila[1]) : null;
  };
  const cotizarRaw = async (fob) => (await (await fetch(BASE + '/api/liquidaciones/cotizar', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      pais: 'Estados Unidos', tipo: 'export', servicio: 'UPS_EXP',
      pesoFacturable: 5, fob, fuelPct: 35.25, profitPct: 0,
      bultos: [{ peso_real: 5, largo: 30, ancho: 25, alto: 20 }],
      cliente_id: cli.id, profitManual: false,
    }),
  })).json());
  const cotizar = async (fob) => seguroDe(await cotizarRaw(fob));

  const s2000 = await cotizar(2000);
  check('valor declarado 2.000 → seguro USD 20 (antes 30)',
    Math.abs(Number(s2000) - 20) < 0.01, `seguro=${s2000}`);
  const s500 = await cotizar(500);
  check('valor declarado 500 → seguro USD 10 (antes UPS 15 / DHL 17,50)',
    Math.abs(Number(s500) - 10) < 0.01, `seguro=${s500}`);
  check('el endpoint devuelve el seguro propio para el cotizador',
    !!(await (await fetch(
      `${BASE}/api/clientes/${cli.id}/profit-resolve?servicio=UPS_EXP&tipo=export&zona=2&pf=5`,
      { headers: H })).json()).seguroPropio);

  console.log('\n4. Se puede volver atrás\n');

  await page.click('#btn-borrar-seguro');
  await esperar(1500);
  const borrado = await (await fetch(`${BASE}/api/clientes/${cli.id}`, { headers: H })).json();
  check('el botón de quitar lo borra de verdad',
    borrado.seguro_pct_propio === null && borrado.seguro_min_propio === null,
    JSON.stringify({ p: borrado.seguro_pct_propio, m: borrado.seguro_min_propio }));

  const vuelta = await cotizar(500);
  check('y el cliente vuelve a la escala del courier (UPS 15)',
    Math.abs(Number(vuelta) - 15) < 0.01, `seguro=${vuelta}`);

  console.log('\n5. No rompe lo que estaba al lado\n');

  await page.fill('#tarifas-fuel-input', '31');
  await page.click('#btn-guardar-fuel');
  await esperar(1200);
  const conFuel = await (await fetch(`${BASE}/api/clientes/${cli.id}`, { headers: H })).json();
  check('el fuel propio sigue funcionando', Number(conFuel.fuel_pct_propio) === 31);

  console.log('\n6. Sin errores de JavaScript\n');
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await browser.close();
  matarSrv();
  await esperarSrvMuerto();
  // Ver test-api-documentos-dhl.js: nada de process.exit() a mano.
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
