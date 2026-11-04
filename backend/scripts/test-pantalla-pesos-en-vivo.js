#!/usr/bin/env node
/**
 * test-pantalla-pesos-en-vivo.js — peso volumétrico y facturable del modal de Salidas
 * (04/11/2026). Caso de administración: a un envío de UN bulto le corregían las medidas
 * para que el facturable diera lo que cobró DHL, apretaban "Recalcular costo" y "no movía
 * nada". Eran dos cosas:
 *
 *   1. Backend: si el bulto único tenía fila real en envio_bultos (semáforo puesto, guía por
 *      bulto…), Recalcular leía LAS MEDIDAS GUARDADAS en vez de las del modal; y el guardado
 *      actualizaba envios pero no esa fila, así que la grilla y el próximo Recalcular seguían
 *      con las viejas.
 *   2. Pantalla: los campos grises no se movían hasta Recalcular. Ahora se actualizan en
 *      vivo mientras se tipea (misma regla que el backend), con el aviso de que el costo
 *      sigue necesitando Recalcular.
 *
 *   cd backend && node scripts/test-pantalla-pesos-en-vivo.js
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.log('⚠ playwright no está instalado — se saltea (necesita navegador de verdad).');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3993;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_pesos_en_vivo.db';
const TOKEN = 'token-test-pesos-en-vivo';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const cerca = (a, b, tol = 0.0011) => Math.abs(Number(a) - Number(b)) < tol;

async function main() {
  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);
  const esperarSrvMuerto = () => new Promise((res) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return res();
    srv.once('exit', res);
    setTimeout(res, 2000);
  });
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const hoy = new Date().toISOString().slice(0, 10);
  const j = async (url, opts) => { const r = await fetch(BASE + url, { headers: H, ...opts }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  const cli = (await j('/api/clientes', { method: 'POST', body: JSON.stringify({ nombre: 'PESOS EN VIVO', tarifa_pct: 80 }) })).body;
  // El caso real (CASABLANCA, 02/10): 10,5 kg de balanza, 48×41×41 → vol 16,138 → facturable 16,5.
  const env = (await j('/api/envios', {
    method: 'POST',
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'DHL', tipo_envio: 'exportacion',
      numero_guia: '6857643590', pais_destino: 'Estados Unidos',
      peso_real: 10.5, largo: 48, ancho: 41, alto: 41,
    }),
  })).body;
  check('el envío se crea con facturable 16,5', cerca(env.peso_facturable, 16.5), String(env.peso_facturable));

  console.log('\n1. Backend: bulto único CON fila real en envio_bultos\n');

  // El semáforo materializa la fila del bulto 1 (así estaba el envío de la oficina: "Verde").
  const sem = await j(`/api/salidas/envios/${env.id}/estado-bulto-unico`, { method: 'PATCH', body: JSON.stringify({ estado_caja: 'verde' }) });
  check('el semáforo crea la fila del bulto 1', sem.status === 201 && sem.body && sem.body.id && sem.body.estado_caja === 'verde', JSON.stringify(sem.body));
  const bultoId = sem.body.id;

  // Recalcular con las medidas del modal (alto 41 → 40): 48×41×40 = 78.720 → 15,744 → 16,0.
  const rc = await j(`/api/salidas/${env.id}/recalcular`, {
    method: 'POST',
    body: JSON.stringify({ courier: 'DHL', pais_destino: 'Estados Unidos', fob: 232, asegurado: 1, entrega: 'normal', remota: 0, ddp: 0, residencial: 0, peso_real: 10.5, largo: 48, ancho: 41, alto: 40 }),
  });
  check('Recalcular usa las medidas del modal, no las de la fila: facturable 16,0', rc.status === 200 && cerca(rc.body.peso_facturable, 16), `${rc.status} ${JSON.stringify(rc.body).slice(0, 160)}`);
  check('y volumétrico 15,744', cerca(rc.body.peso_volumetrico, 15.744), String(rc.body.peso_volumetrico));

  // Un recálculo que NO manda medidas (solo DDP, clientes viejos) sigue leyendo las guardadas.
  const rc2 = await j(`/api/salidas/${env.id}/recalcular`, { method: 'POST', body: JSON.stringify({ ddp: 1 }) });
  check('un recálculo sin medidas sigue usando las guardadas (16,5)', rc2.status === 200 && cerca(rc2.body.peso_facturable, 16.5), String(rc2.body.peso_facturable));

  // Guardar con las medidas nuevas (campos sueltos, sin `bultos`, como manda el modal de bulto único).
  const pt = await j(`/api/salidas/${env.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ peso_real: 10.5, largo: 48, ancho: 41, alto: 40, peso_facturable: 16, peso_volumetrico: 15.744 }),
  });
  check('el PATCH con medidas sueltas se acepta', pt.status === 200, JSON.stringify(pt.body));
  const lista = (await j(`/api/salidas?desde=${hoy}&hasta=${hoy}`)).body;
  const fila = (Array.isArray(lista) ? lista : []).find((x) => x.id === env.id) || {};
  const b1 = (fila.bultos || [])[0] || {};
  check('la fila del bulto 1 quedó espejada: alto 40', Number(b1.alto) === 40 && b1.id === bultoId, JSON.stringify(b1));
  check('y su volumétrico es el nuevo (15,744), que es lo que muestra la grilla', cerca(b1.peso_volumetrico, 15.744), String(b1.peso_volumetrico));
  check('el envío también: facturable 16,0', cerca(fila.peso_facturable, 16), String(fila.peso_facturable));
  const rc3 = await j(`/api/salidas/${env.id}/recalcular`, { method: 'POST', body: JSON.stringify({ ddp: 0 }) });
  check('el próximo Recalcular sin medidas ya lee 16,0', cerca(rc3.body.peso_facturable, 16), String(rc3.body.peso_facturable));

  // Multi-bulto: el PATCH con `bultos` sigue por su camino (no toca el espejo).
  const env2 = (await j('/api/envios', {
    method: 'POST',
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'DHL', tipo_envio: 'exportacion', numero_guia: '6857643600', pais_destino: 'Estados Unidos',
      peso_real: 8, bultos: [{ peso_real: 4, largo: 30, ancho: 20, alto: 20 }, { peso_real: 4, largo: 30, ancho: 20, alto: 20 }],
    }),
  })).body;
  const l2 = (await j(`/api/salidas?desde=${hoy}&hasta=${hoy}`)).body.find((x) => x.id === env2.id);
  const pt2 = await j(`/api/salidas/${env2.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ peso_real: 8, bultos: l2.bultos.map((b, i) => ({ id: b.id, peso_real: 4, largo: 30, ancho: 20, alto: i === 0 ? 25 : 20 })) }),
  });
  const l2b = (await j(`/api/salidas?desde=${hoy}&hasta=${hoy}`)).body.find((x) => x.id === env2.id);
  check('multi-bulto: el PATCH con `bultos` actualiza cada fila como siempre', pt2.status === 200 && Number(l2b.bultos[0].alto) === 25 && Number(l2b.bultos[1].alto) === 20, JSON.stringify(l2b.bultos.map((b) => b.alto)));

  console.log('\n2. Pantalla: volumétrico y facturable se mueven mientras se tipea\n');

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text());
  });
  page.on('dialog', (d) => d.accept());

  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  await page.click('text=6857643590');
  await esperar(1000);
  check('se abre el modal del envío', !!(await page.$('#sal-edit-overlay:not(.hidden)')));
  check('abre con facturable 16,0 (lo guardado)', cerca(await page.inputValue('#saled-peso-facturable'), 16), await page.inputValue('#saled-peso-facturable'));
  const statusAntes = (await page.textContent('#saled-recalc-status')).trim();
  check('sin tocar nada no hay aviso', statusAntes === '', statusAntes);

  await page.fill('#saled-alto', '41');
  await esperar(200);
  check('alto 41 → volumétrico 16,138 al instante', cerca(await page.inputValue('#saled-peso-volumetrico'), 16.138), await page.inputValue('#saled-peso-volumetrico'));
  check('y facturable 16,5 (medio kilo para arriba)', cerca(await page.inputValue('#saled-peso-facturable'), 16.5), await page.inputValue('#saled-peso-facturable'));
  const aviso = (await page.textContent('#saled-recalc-status')).trim();
  check('avisa "16.0 kg → 16.5 kg" y que hay que Recalcular', /16\.0 kg → 16\.5 kg/.test(aviso) && /Recalcular/.test(aviso), aviso);

  await page.fill('#saled-alto', '40');
  await esperar(200);
  check('vuelve a 40 → facturable 16,0', cerca(await page.inputValue('#saled-peso-facturable'), 16), await page.inputValue('#saled-peso-facturable'));
  const aviso2 = (await page.textContent('#saled-recalc-status')).trim();
  check('con las medidas originales el aviso se va', aviso2 === '' || !/→/.test(aviso2), aviso2);

  // Balanza manda cuando supera al volumétrico: 17,2 → 17,5.
  await page.fill('#saled-peso-real', '17.2');
  await esperar(200);
  check('balanza 17,2 > volumétrico → facturable 17,5', cerca(await page.inputValue('#saled-peso-facturable'), 17.5), await page.inputValue('#saled-peso-facturable'));
  await page.fill('#saled-peso-real', '10.5');
  await page.fill('#saled-alto', '41');
  await esperar(200);

  // Recalcular con el modal en 48×41×41: el backend da lo mismo que la vista previa, y el aviso se reemplaza.
  await page.click('#saled-recalcular');
  await esperar(2500);
  check('Recalcular confirma 16,5 (backend = vista previa)', cerca(await page.inputValue('#saled-peso-facturable'), 16.5), await page.inputValue('#saled-peso-facturable'));
  const statusRc = (await page.textContent('#saled-recalc-status')).trim();
  check('el estado pasa a ser el del Recalcular ("Desglose actualizado" o "Sin cambios")', /Desglose actualizado|Sin cambios/.test(statusRc), statusRc);
  const flete = Number(await page.inputValue('#saled-flete'));
  check('el flete quedó calculado (> 0)', flete > 0, String(flete));

  await page.click('#sal-modal-save');
  await esperar(2500);
  const fin = (await j(`/api/salidas?desde=${hoy}&hasta=${hoy}`)).body.find((x) => x.id === env.id);
  check('guardado: envío 48×41×41 con facturable 16,5', Number(fin.alto) === 41 && cerca(fin.peso_facturable, 16.5), `${fin.alto} / ${fin.peso_facturable}`);
  check('y la fila del bulto 1 espejada (alto 41, vol 16,138)', Number(fin.bultos[0].alto) === 41 && cerca(fin.bultos[0].peso_volumetrico, 16.138), JSON.stringify(fin.bultos[0]));

  console.log('\n3. Multi-bulto: también en vivo, por bulto\n');
  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  await page.click('text=6857643600');
  await esperar(1000);
  // 30×20×25 = 3 → max(4, 3) = 4 ; 30×20×20 = 2,4 → 4 ; total 8.
  check('abre con facturable 8,0', cerca(await page.inputValue('#saled-peso-facturable'), 8), await page.inputValue('#saled-peso-facturable'));
  await page.fill('#saled-bultos-container [data-bidx="0"][data-field="peso_real"]', '4.1');
  await esperar(200);
  check('bulto 1 en 4,1 kg → 4,5 + 4 = 8,5 al instante', cerca(await page.inputValue('#saled-peso-facturable'), 8.5), await page.inputValue('#saled-peso-facturable'));
  await page.fill('#saled-bultos-container [data-bidx="1"][data-field="alto"]', '50');
  await esperar(200);
  // 30×20×50 = 6 → 6 ; total 4,5 + 6 = 10,5 ; volumétrico 3 + 6 = 9.
  check('bulto 2 a 50 de alto → facturable 10,5', cerca(await page.inputValue('#saled-peso-facturable'), 10.5), await page.inputValue('#saled-peso-facturable'));
  check('y volumétrico total 9,0', cerca(await page.inputValue('#saled-peso-volumetrico'), 9), await page.inputValue('#saled-peso-volumetrico'));

  console.log('\n4. Sin errores de JavaScript\n');
  check('ningún error en pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await browser.close();
  matarSrv();
  await esperarSrvMuerto();
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
