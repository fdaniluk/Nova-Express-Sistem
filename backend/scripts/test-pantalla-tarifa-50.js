#!/usr/bin/env node
/**
 * test-pantalla-tarifa-50.js — la tarifa DHL "MAS 50 KGS" de punta a punta (01/09/2026).
 *
 * El motor ya lo cuida `test-tarifa-50.js`. Lo que esta tanda cuida es el camino largo:
 * que la elección se CONGELE en el envío (columna `tarifa_50`), que viaje hasta Salidas,
 * que se recalcule cuando cambia el peso, y que las pantallas lo muestren donde va —
 * en la tira interna del cotizador y en la grilla, NUNCA en la tarjeta que se le manda
 * al cliente por imagen.
 *
 * Por qué se congela y no se recalcula al mostrar: lo cargado antes del 01/09 salió por
 * la cuenta de siempre. Si la grilla dedujera el chip del peso, marcaría envíos viejos
 * como despachados por una cuenta que en su momento no se usó.
 *
 *   cd backend && node scripts/test-pantalla-tarifa-50.js
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3943;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_tarifa_50.db';
const TOKEN = 'token-test-tarifa50';
const RAIZ = path.join(__dirname, '..', '..');

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

async function main() {
  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  let muerto = false;
  const matar = () => { if (muerto) return; muerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matar);

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await esperar(300);
  }
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const hoy = new Date().toISOString().slice(0, 10);

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const get = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => (e ? rej(e) : res(r))));

  const cli = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H,
    body: JSON.stringify({ nombre: 'TARIFA 50', tarifa_pct: 100, tipo_cobro: 'CC' }),
  })).json();

  let guiaSeq = 1;
  const alta = async (extra = {}) => (await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'DHL', tipo_envio: 'exportacion',
      numero_guia: String(1000000000 + (guiaSeq++)),
      pais_destino: 'España', peso_real: 60, largo: 50, ancho: 40, alto: 30,
      fob: 0, total_cobrado: 1200, ...extra,
    }),
  })).json());

  console.log('\n1. La elección se congela en el envío\n');
  const grande = await alta();
  const fGrande = await get('SELECT tarifa_50, flete, extras_json FROM envios WHERE id = ?', [grande.id]);
  check('60 kg a España queda marcado como tarifa +50', fGrande.tarifa_50 === 1, String(fGrande.tarifa_50));
  check('con el flete del tarifario +50 (396,00)', Math.abs(fGrande.flete - 396) < 0.02, String(fGrande.flete));
  check('y sin GoGreen en el costo congelado',
    !/gogreen/i.test(fGrande.extras_json || ''), String(fGrande.extras_json));

  const chico = await alta({ peso_real: 40, total_cobrado: 800 });
  const fChico = await get('SELECT tarifa_50, extras_json FROM envios WHERE id = ?', [chico.id]);
  check('40 kg NO va por la +50', fChico.tarifa_50 === 0, String(fChico.tarifa_50));
  check('y sigue pagando GoGreen', /gogreen/i.test(fChico.extras_json || ''), String(fChico.extras_json));

  const impo = await alta({ tipo_envio: 'importacion', pais_destino: 'China' });
  const fImpo = await get('SELECT tarifa_50 FROM envios WHERE id = ?', [impo.id]);
  check('una importación de 60 kg no se marca (esa tarifa es otra)', fImpo.tarifa_50 === 0, String(fImpo.tarifa_50));

  console.log('\n2. Se recalcula cuando cambia el peso\n');
  // Se edita por PUT /api/envios/:id, que es el que RECOTIZA. El PATCH de Salidas guarda
  // números a mano (la oficina corrige un flete) y a propósito no recalcula nada.
  await fetch(`${BASE}/api/envios/${chico.id}`, {
    method: 'PUT', headers: H, body: JSON.stringify({ peso_real: 70 }),
  });
  const subio = await get('SELECT tarifa_50, extras_json FROM envios WHERE id = ?', [chico.id]);
  check('de 40 a 70 kg pasa a tarifa +50', subio.tarifa_50 === 1, String(subio.tarifa_50));
  check('y el GoGreen desaparece del costo', !/gogreen/i.test(subio.extras_json || ''), String(subio.extras_json));

  await fetch(`${BASE}/api/envios/${grande.id}`, {
    method: 'PUT', headers: H, body: JSON.stringify({ peso_real: 20 }),
  });
  const bajo = await get('SELECT tarifa_50, extras_json FROM envios WHERE id = ?', [grande.id]);
  check('bajar de 60 a 20 kg lo saca de la +50', bajo.tarifa_50 === 0, String(bajo.tarifa_50));
  check('y le devuelve el GoGreen', /gogreen/i.test(bajo.extras_json || ''), String(bajo.extras_json));

  console.log('\n3. Llega a Salidas\n');
  const salidas = await (await fetch(`${BASE}/api/salidas?desde=${hoy}&hasta=${hoy}`, { headers: H })).json();
  const filas = Array.isArray(salidas) ? salidas : (salidas.envios || salidas.data || []);
  const fila70 = filas.find((f) => f.id === chico.id);
  const fila20 = filas.find((f) => f.id === grande.id);
  check('la API de Salidas devuelve tarifa_50', fila70 && fila70.tarifa_50 !== undefined, JSON.stringify(fila70 && Object.keys(fila70).slice(0, 5)));
  check('en 1 para el de 70 kg', fila70 && fila70.tarifa_50 === 1, String(fila70 && fila70.tarifa_50));
  check('y en 0 para el de 20 kg', fila20 && fila20.tarifa_50 === 0, String(fila20 && fila20.tarifa_50));

  console.log('\n4. El cotizador del alta de envío lo avisa\n');
  const cot = await (await fetch(`${BASE}/api/liquidaciones/cotizar`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      servicio: 'DHL', tipo: 'export', pais: 'España', pesoFacturable: 60,
      fob: 0, fuelPct: 39.5, profitPct: 100, cliente_id: cli.id,
      bultos: [{ peso_real: 60, largo: 50, ancho: 40, alto: 30 }],
    }),
  })).json();
  check('la cotización de 60 kg trae tarifa50 = true', cot.tarifa50 === true, JSON.stringify(cot.tarifa50));
  check('y el texto del aviso', /otra cuenta/i.test(cot.avisoTarifa50 || ''), String(cot.avisoTarifa50));

  const cotChico = await (await fetch(`${BASE}/api/liquidaciones/cotizar`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      servicio: 'DHL', tipo: 'export', pais: 'España', pesoFacturable: 20,
      fob: 0, fuelPct: 39.5, profitPct: 100, cliente_id: cli.id,
      bultos: [{ peso_real: 20, largo: 50, ancho: 40, alto: 30 }],
    }),
  })).json();
  check('la de 20 kg no avisa nada', !cotChico.tarifa50 && !cotChico.avisoTarifa50,
    `${cotChico.tarifa50} / ${cotChico.avisoTarifa50}`);

  console.log('\n5. Dónde se muestra (y dónde NO)\n');
  const salidasJs = leer('frontend/js/modules/salidas.js');
  check('Salidas dibuja el chip +50 en la fila', /tarifa50Chip\(e\)/.test(salidasJs));
  check('leyéndolo de la columna congelada, no del peso',
    /if \(!e\.tarifa_50\) return ''/.test(salidasJs));
  const mainCss = leer('frontend/css/main.css');
  check('el chip tiene estilo', /\.chip-tarifa50/.test(mainCss));
  check('y el cartel también', /\.aviso-tarifa50/.test(mainCss));

  const cotHtml = leer('frontend/pages/cotizador.html');
  check('el cotizador manda el aviso a la TIRA INTERNA',
    /if\(lineaInterna\|\|tarifa50Texto\)profitPorServicio\.push/.test(cotHtml));
  check('y el texto del aviso aparece una sola vez (no se filtra a la tarjeta)',
    (cotHtml.match(/la guia se emite por la OTRA cuenta/g) || []).length === 1,
    String((cotHtml.match(/la guia se emite por la OTRA cuenta/g) || []).length));
  check('la tarjeta del cliente no nombra la cuenta',
    !/tarifa50/i.test(cotHtml.split('const extrasHtml=')[1].split('const tira=')[0] || ''));

  const enviosJs = leer('frontend/js/modules/envios.js');
  check('el panel de Cargar envío muestra el cartel', /res\.tarifa50/.test(enviosJs) && /aviso-tarifa50/.test(enviosJs));

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  matar();
  await esperar(300);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
