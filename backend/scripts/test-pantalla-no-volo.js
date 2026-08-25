#!/usr/bin/env node
/**
 * test-pantalla-no-volo.js — el botón "NO VOLÓ" en un navegador de verdad.
 *
 * El endpoint y el efecto sobre las estadísticas los cubre test-no-volo.js. Esto controla
 * lo otro, que es lo que la oficina va a ver:
 *
 *   · que el botón esté DENTRO del detalle del envío (fue el pedido: "algún botón rojo
 *     al que se llegue desde adentro del detalle del envío"),
 *   · que al marcarlo el renglón se pinte y aparezca la leyenda NO VOLÓ,
 *   · que el NÚMERO DE SALIDA no se mueva ni se tache — el envío 27 sigue siendo el 27,
 *   · y que el mismo botón lo deshaga.
 *
 *   cd backend && node scripts/test-pantalla-no-volo.js
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
const sqlite3 = require('sqlite3');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3958;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_no_volo.db';
const TOKEN = 'token-test-pantalla-no-volo';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); }
  else { fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera A QUE PASE la cosa, no a que pase el reloj. */
async function esperarQue(fn, ms = 8000) {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn().catch(() => false)) return true;
    // eslint-disable-next-line no-await-in-loop
    await esperar(200);
  }
  return false;
}

function sql(query, params = []) {
  return new Promise((res, rej) => {
    const d = new sqlite3.Database(DB);
    d.all(query, params, (e, r) => { d.close(() => (e ? rej(e) : res(r || []))); });
  });
}

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = ''; let logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch { /* ya estaba */ } };
  process.on('exit', matarSrv);

  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  const uid = await abrirSesion(DB, TOKEN);
  await sql("UPDATE usuarios SET usuario='marcela' WHERE id=?", [uid]);

  const hoy = new Date().toISOString().slice(0, 10);
  const cli = await (await fetch(`${BASE}/api/clientes`, {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'NO VOLO PANTALLA', tarifa_pct: 80 }),
  })).json();

  const nuevo = (guia) => fetch(`${BASE}/api/envios`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'DHL', tipo_envio: 'exportacion',
      numero_guia: guia, pais_destino: 'Estados Unidos',
      peso_real: 6, largo: 30, ancho: 20, alto: 20, total_cobrado: 250,
    }),
  }).then((r) => r.json());

  const e1 = await nuevo('9910000011');
  const e2 = await nuevo('9910000029');

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
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) {
      errores.push(m.text());
    }
  });
  // Los dos confirm() del botón se aceptan solos; si alguno quedara sin atender, el
  // navegador se congela y el test se cuelga sin decir por qué.
  page.on('dialog', (d) => d.accept());

  const filaDe = (id) => page.$(`tr[data-envio-id="${id}"]`);
  const claseFila = async (id) => ((await filaDe(id)) ? (await (await filaDe(id)).getAttribute('class')) || '' : '');
  const numSalDe = async (id) =>
    page.$eval(`tr[data-envio-id="${id}"] td.numsal-cell`, (el) => el.textContent.trim());

  console.log('\n1. El botón está adentro del detalle del envío\n');

  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(2500);
  const numAntes1 = await numSalDe(e1.id);
  const numAntes2 = await numSalDe(e2.id);

  await page.click('text=9910000011');
  await esperar(900);
  check('se abre el modal del envío', !!(await page.$('#sal-edit-overlay:not(.hidden)')));
  check('el botón NO VOLÓ está en el pie del modal', !!(await page.$('#sal-modal-no-volo')));
  check('y dice NO VOLÓ', /NO VOL/.test(await page.textContent('#sal-modal-no-volo')));
  check('el aviso de "no voló" todavía no se ve',
    await page.$eval('#saled-no-volo-note', (el) => el.classList.contains('hidden')));

  console.log('\n2. Al marcarlo se pinta el renglón y aparece la leyenda\n');

  await page.click('#sal-modal-no-volo');
  const pintada = await esperarQue(async () => /row-no-volo/.test(await claseFila(e1.id)));
  check('el renglón queda pintado', pintada, await claseFila(e1.id));
  check('la fila muestra la leyenda NO VOLÓ',
    /NO VOL/.test(await page.$eval(`tr[data-envio-id="${e1.id}"]`, (el) => el.textContent)));
  check('el otro envío queda como estaba', !/row-no-volo/.test(await claseFila(e2.id)));

  console.log('\n3. El número de salida no se toca\n');

  check('el envío conserva su número', (await numSalDe(e1.id)) === numAntes1,
    `era ${numAntes1}, ahora ${await numSalDe(e1.id)}`);
  check('y el de abajo tampoco se corre', (await numSalDe(e2.id)) === numAntes2,
    `era ${numAntes2}, ahora ${await numSalDe(e2.id)}`);
  check('el número NO se ve tachado (sí el resto de los importes)',
    await page.$eval(`tr[data-envio-id="${e1.id}"] td.numsal-cell`,
      (el) => getComputedStyle(el).textDecorationLine !== 'line-through'));

  console.log('\n4. El mismo botón lo deshace\n');

  await page.click('text=9910000011');
  await esperar(900);
  check('al reabrir, el botón ofrece deshacer',
    /deshacer/i.test(await page.textContent('#sal-modal-no-volo')));
  const nota = await page.textContent('#saled-no-volo-note');
  check('y el aviso dice quién lo marcó', /marcela/.test(nota), nota.trim().slice(0, 120));

  await page.click('#sal-modal-no-volo');
  const despintada = await esperarQue(async () => !/row-no-volo/.test(await claseFila(e1.id)));
  check('el renglón vuelve a la normalidad', despintada, await claseFila(e1.id));
  const enBase = await sql('SELECT no_volo, total_cobrado FROM envios WHERE id = ?', [e1.id]);
  check('en la base quedó desmarcado', Number(enBase[0].no_volo) === 0);
  check('y el precio de venta nunca se borró', Number(enBase[0].total_cobrado) > 0);

  console.log('\n5. Sin errores de JavaScript\n');
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  await browser.close();
  matarSrv();
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
