#!/usr/bin/env node
/**
 * test-operaciones-sueltos.js — los envíos SIN pickup de Operaciones y el resumen de
 * Pickups que no confunde (los dos pedidos del 26/08/2026).
 *
 * QUÉ ES
 * 1. Operaciones necesita seguir envíos que NADIE pasa a buscar (el caso típico: una
 *    importación). Antes no tenían dónde existir: no hay pickup, así que no había
 *    tarjeta. Ahora se cargan desde el propio módulo de Operaciones, y la pantalla de
 *    Pickups NUNCA los muestra — ahí se organiza a los choferes, y esto no lo mueve
 *    ningún chofer.
 * 2. En Pickups, un envío que trae el cliente o que levanta UPS/DHL aparecía como
 *    "sin confirmar" en el resumen del día y "Sin asignar" en la tarjeta — el día estaba
 *    completo y la pantalla decía que faltaba alguien.
 *
 * QUÉ SE PRUEBA, en orden de riesgo:
 *
 *  1. QUE EL SUELTO NUNCA APAREZCA EN PICKUPS. Si se filtrara mal, los choferes verían
 *     recolecciones que no existen y saldrían a buscarlas.
 *  2. Que operaciones lo vea, con sus checks funcionando y el arrastre de rezagados.
 *  3. Que borrar solo funcione para los sueltos: un pickup de verdad no se puede borrar
 *     por esta puerta.
 *  4. Que el resumen del día cuente los cliente/courier APARTE, y que la tarjeta no
 *     diga más "Sin asignar" para algo que no lleva chofer.
 *
 *   cd backend && npm run test-operaciones-sueltos     (EN POWERSHELL, no en el servidor)
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch { chromium = null; }

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3949;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_ops_sueltos.db';
const TOKEN = 'token-test-ops-sueltos';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
let matarServidor = () => {};
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else {
    fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`);
  }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function hoyYMD(dias = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

  const cli = await (await fetch(`${BASE}/api/clientes`, {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'OPS SUELTOS', tarifa_pct: 80 }),
  })).json();
  const hoy = hoyYMD();

  const post = (url, body) => fetch(`${BASE}/api${url}`, { method: 'POST', headers: H, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  // ── 1. El suelto vive en Operaciones y NUNCA en Pickups ─────────────────────────────
  console.log('\n1. El envío sin pickup no aparece en la pantalla de los choferes\n');

  const suelto = await post('/operaciones/sueltos', {
    cliente_id: cli.id, fecha: hoy, titulo: 'Impo 3 cajas repuestos',
  });
  check('se crea desde operaciones', suelto.status === 201, JSON.stringify(suelto.body).slice(0, 100));
  check('nace de tipo "ninguna" y estado terminal',
    suelto.body.tipo_recoleccion === 'ninguna' && suelto.body.estado === 'sin_recoleccion');

  const enPickups = await (await fetch(`${BASE}/api/pickups?desde=${hoy}&hasta=${hoy}`, { headers: H })).json();
  check('🔴 la pantalla de Pickups NO lo muestra',
    !enPickups.some((p) => p.id === suelto.body.id), `vinieron ${enPickups.length}`);

  const ops = await (await fetch(`${BASE}/api/operaciones?fecha=${hoy}`, { headers: H })).json();
  check('operaciones SÍ lo ve', ops.pickups.some((p) => p.id === suelto.body.id));
  check('con su descripción', ops.pickups.find((p) => p.id === suelto.body.id).titulo === 'Impo 3 cajas repuestos');

  // ── 2. Los checks y el arrastre funcionan como en cualquier tarjeta ─────────────────
  console.log('\n2. Los checks y los rezagados funcionan igual que siempre\n');

  const patch = await fetch(`${BASE}/api/operaciones/pickups/${suelto.body.id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ check_datos: 1, check_guia: 1 }),
  });
  check('los checks se marcan', patch.status === 200);
  const trasPatch = (await (await fetch(`${BASE}/api/operaciones?fecha=${hoy}`, { headers: H })).json())
    .pickups.find((p) => p.id === suelto.body.id);
  check('y quedan guardados', Number(trasPatch.check_datos) === 1 && Number(trasPatch.check_guia) === 1);

  const viejo = await post('/operaciones/sueltos', { cliente_id: cli.id, fecha: hoyYMD(-3), titulo: 'Impo vieja' });
  const opsHoy = await (await fetch(`${BASE}/api/operaciones?fecha=${hoy}`, { headers: H })).json();
  check('un suelto de hace 3 días sin despachar se arrastra como rezagado',
    opsHoy.rezagados.some((p) => p.id === viejo.body.id));

  // ── 3. Borrar: solo los sueltos ─────────────────────────────────────────────────────
  console.log('\n3. Borrar solo alcanza a los sueltos\n');

  const pickupReal = await post('/pickups', {
    cliente_id: cli.id, direccion: 'Av. Siempreviva 742', fecha: hoy,
    hora_inicio: '10:00', hora_fin: '12:00',
  });
  check('hay un pickup de verdad para comparar', pickupReal.status === 201, JSON.stringify(pickupReal.body).slice(0, 80));

  const borrarReal = await fetch(`${BASE}/api/operaciones/sueltos/${pickupReal.body.id}`, { method: 'DELETE', headers: H });
  check('🔴 un pickup de verdad NO se puede borrar por esta puerta', borrarReal.status === 400);

  const borrarSuelto = await fetch(`${BASE}/api/operaciones/sueltos/${viejo.body.id}`, { method: 'DELETE', headers: H });
  check('el suelto sí se borra', borrarSuelto.status === 200);
  check('y desaparece de operaciones',
    !(await (await fetch(`${BASE}/api/operaciones?fecha=${hoy}`, { headers: H })).json())
      .rezagados.some((p) => p.id === viejo.body.id));

  check('sin cliente da 400', (await post('/operaciones/sueltos', { fecha: hoy })).status === 400);
  check('cliente inexistente da 404',
    (await post('/operaciones/sueltos', { cliente_id: 99999, fecha: hoy })).status === 404);

  // ── 4. El resumen de Pickups no confunde ────────────────────────────────────────────
  console.log('\n4. El resumen del día: cliente/courier aparte, sin "Sin asignar"\n');

  await post('/pickups', {
    cliente_id: cli.id, direccion: 'Depósito', fecha: hoy,
    hora_inicio: '09:00', hora_fin: '10:00', tipo_recoleccion: 'cliente',
  });
  await post('/pickups', {
    cliente_id: cli.id, direccion: 'Oficina', fecha: hoy,
    hora_inicio: '11:00', hora_fin: '12:00', tipo_recoleccion: 'courier',
  });

  if (!chromium) {
    console.log('  ⚠ playwright no está instalado — la parte de pantalla se saltea.');
  } else {
    const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
      '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
    const exe = cand.find((p) => fs.existsSync(p));
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', (e) => errores.push(String(e)));
    await page.goto(`${BASE}/pages/pickups.html`, { waitUntil: 'networkidle' });
    await esperar(1500);

    const pend = await page.textContent('#count-pend');
    check('el "sin confirmar" cuenta SOLO el pickup normal (1, no 3)',
      /● 1 sin confirmar/.test(pend), pend);
    const gris = await page.textContent('#count-gris');
    check('los cliente/courier tienen su propia cuenta gris', /◼ 2 cliente\/courier/.test(gris), gris);
    check('que está visible', await page.$eval('#count-gris', (e) => e.style.display !== 'none'));

    const tiras = await page.$$eval('.pickup-rec-stripe', (els) => els.map((x) => x.textContent.trim()));
    check('la tarjeta del courier dice quién lo mueve', tiras.includes('UPS/DHL'), JSON.stringify(tiras));
    check('la del cliente también', tiras.includes('Lo trae el cliente'), JSON.stringify(tiras));
    check('🔴 y "Sin asignar" queda solo para el pickup normal',
      tiras.filter((t) => t === 'Sin asignar').length === 1, JSON.stringify(tiras));
    check('el suelto de operaciones tampoco aparece acá',
      !(await page.textContent('#pickups-dia-list')).includes('Impo 3 cajas'));
    check('sin errores de JavaScript', errores.length === 0, errores.slice(0, 2).join(' | '));
    await browser.close();
  }

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
