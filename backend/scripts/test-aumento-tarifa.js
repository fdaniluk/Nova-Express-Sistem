#!/usr/bin/env node
// Aumento de tarifa en bloque (20/10/2026): un % sobre el PRECIO DE VENTA del cliente,
// aplicado al % general, a las celdas de las tres matrices y a los precios por kilo.
//   · la vista previa no escribe y muestra antes → después
//   · +10 % en el precio: 50 % → 65 %; 12,00 USD/kg → 13,20
//   · el motor cotiza exactamente 10 % más de flete de venta (porcentaje y por kilo)
//   · se puede elegir qué tablas; lo no tildado no se toca
//   · queda registrado; el último se deshace y restaura los valores exactos
//   · no se deshace uno que no es el último, ni si alguien tocó un valor a mano después
//   · pantalla: botón, vista previa, aplicar, "Último aumento", deshacer
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3973;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_aumento_tarifa.db';
const TOKEN = 'token-test-aumento';
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const cerca = (a, b, t = 0.011) => Math.abs(Number(a) - Number(b)) <= t;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  // Cliente con de todo: general 50 %, celdas de % en dos matrices, un precio por kilo.
  const cli = (await J('POST', '/clientes', { nombre: 'AUMENTO SA', tarifa_pct: 50, tipo_cobro: 'CC' })).body;
  await J('PUT', `/clientes/${cli.id}/profit-matrix`, { servicio: 'DHL', tipo: 'export', profit_pct: 60 });                       // tabla
  await J('PUT', `/clientes/${cli.id}/profit-matrix`, { servicio: 'DHL', tipo: 'export', zona: 3, profit_pct: 70 });              // zona (EE.UU. en DHL)
  await J('PUT', `/clientes/${cli.id}/profit-matrix`, { servicio: 'UPS_EXP', tipo: 'export', peso_min: 20, peso_max: 25, profit_pct: 40 }); // banda
  await J('PUT', `/clientes/${cli.id}/profit-matrix`, { servicio: 'UPS_EXP', tipo: 'import', zona: 3, profit_pct: 30 });
  await J('PUT', `/clientes/${cli.id}/tarifa-kg`, { servicio: 'UPS_SAVER', tipo: 'export', peso_min: 0, peso_max: 5, precio_kg: 12 });
  const vacio = (await J('POST', '/clientes', { nombre: 'VACIO SA', tarifa_pct: 0, tipo_cobro: 'D' })).body;

  const cotizar = (extra) => J('POST', '/liquidaciones/cotizar', { cliente_id: cli.id, pais: 'Estados Unidos', tipo: 'export', fob: 100, fuelPct: 20, contenido: 'paquete', ...extra });
  const antesDHL = (await cotizar({ servicio: 'DHL', pesoFacturable: 10, bultos: [{ peso_real: 10, largo: 10, ancho: 10, alto: 10 }] })).body;
  const antesUPS = (await cotizar({ servicio: 'UPS_EXP', pesoFacturable: 22, bultos: [{ peso_real: 22, largo: 10, ancho: 10, alto: 10 }] })).body;
  const antesKg = (await cotizar({ servicio: 'UPS_SAV', pesoFacturable: 4, bultos: [{ peso_real: 4, largo: 10, ancho: 10, alto: 10 }] })).body;
  check('fixture: cotiza antes (DHL z3 70 %, UPS_EXP 20-25 kg 40 %, Saver por kilo 12)', antesDHL.profit_aplicado === 70 && antesUPS.profit_aplicado === 40 && antesKg.precio_kg_aplicado === 12, JSON.stringify([antesDHL.profit_aplicado, antesUPS.profit_aplicado, antesKg.precio_kg_aplicado]));

  console.log('\n1. Vista previa\n');
  let r = await J('POST', `/clientes/${cli.id}/tarifa-aumento/preview`, { pct: 10 });
  check('responde 200 con el total de cambios (1 general + 4 celdas + 1 por kilo)', r.status === 200 && r.body.total_cambios === 6, JSON.stringify(r.body).slice(0, 200));
  check('general 50 → 65 (el precio sube 10 %, no 10 puntos)', r.body.general.antes === 50 && r.body.general.despues === 65, JSON.stringify(r.body.general));
  const f = (serv, tipo, zona, pmin) => r.body.filas_pct.find((x) => x.servicio === serv && x.tipo === tipo && x.zona === zona && x.peso_min === pmin);
  check('celdas: 60 → 76, 70 → 87, 40 → 54, 30 → 43', f('DHL', 'export', null, null).despues === 76 && f('DHL', 'export', 3, null).despues === 87 && f('UPS_EXP', 'export', null, 20).despues === 54 && f('UPS_EXP', 'import', 3, null).despues === 43, JSON.stringify(r.body.filas_pct.map((x) => [x.antes, x.despues])));
  check('por kilo: 12 → 13,20', r.body.filas_kg.length === 1 && r.body.filas_kg[0].despues === 13.2, JSON.stringify(r.body.filas_kg));
  check('por_tabla cuenta qué tiene cada matriz', r.body.por_tabla.find((t) => t.servicio === 'DHL' && t.tipo === 'export').celdas_pct === 2 && r.body.por_tabla.find((t) => t.servicio === 'UPS_SAVER' && t.tipo === 'export').celdas_kg === 1);
  const db0 = await J('GET', `/clientes/${cli.id}`);
  check('la previa NO escribe (general sigue en 50)', db0.body.tarifa_pct === 50);
  r = await J('POST', `/clientes/${cli.id}/tarifa-aumento/preview`, { pct: 7, general: false, kg: false, tablas: [{ servicio: 'UPS_EXP', tipo: 'export' }] });
  check('eligiendo solo UPS Expedited export, sin general ni por kilo: 1 cambio, 40 → 49,8', r.body.total_cambios === 1 && r.body.filas_pct[0].despues === 49.8 && r.body.filas_kg.length === 0 && !r.body.general.cambia, JSON.stringify(r.body.filas_pct));
  r = await J('POST', `/clientes/${cli.id}/tarifa-aumento/preview`, { pct: -10 });
  check('negativo = bajar: 50 → 35, 12 → 10,80', r.body.general.despues === 35 && r.body.filas_kg[0].despues === 10.8);
  r = await J('POST', `/clientes/${cli.id}/tarifa-aumento/preview`, { pct: 0 });
  check('0 % → 400', r.status === 400);
  r = await J('POST', `/clientes/${cli.id}/tarifa-aumento/preview`, { pct: 500 });
  check('500 % → 400', r.status === 400);
  r = await J('POST', `/clientes/${cli.id}/tarifa-aumento/preview`, { pct: 10, tablas: [{ servicio: 'FEDEX', tipo: 'export' }] });
  check('tabla inválida → 400', r.status === 400);
  r = await J('POST', `/clientes/99999/tarifa-aumento/preview`, { pct: 10 });
  check('cliente inexistente → 404', r.status === 404);

  console.log('\n2. Aplicar\n');
  r = await J('POST', `/clientes/${vacio.id}/tarifa-aumento`, { pct: 10 });
  check('cliente sin general ni matriz: 400, nada que aumentar', r.status === 400, JSON.stringify(r.body));
  r = await J('POST', `/clientes/${cli.id}/tarifa-aumento`, { pct: 10 });
  check('aplica +10 %: 200, 6 cambios, devuelve aumento_id', r.status === 200 && r.body.total_cambios === 6 && r.body.aumento_id > 0, JSON.stringify(r.body).slice(0, 200));
  const a1 = r.body.aumento_id;
  const c1 = (await J('GET', `/clientes/${cli.id}`)).body;
  check('general quedó en 65', c1.tarifa_pct === 65, String(c1.tarifa_pct));
  const m = (await J('GET', `/clientes/${cli.id}/profit-matrix?servicio=DHL&tipo=export`)).body;
  check('matriz DHL export: tabla 76, zona 3 → 87', m.general_tabla.profit_pct === 76 && m.overrides.find((o) => o.zona === 3).profit_pct === 87, JSON.stringify(m));
  const mk = (await J('GET', `/clientes/${cli.id}/tarifa-kg?servicio=UPS_SAVER&tipo=export`)).body;
  const filaKg = (mk.overrides || mk.filas || []).find((o) => o.precio_kg != null) || (mk.general_tabla && mk.general_tabla.precio_kg != null ? mk.general_tabla : null);
  check('precio por kilo quedó en 13,20', filaKg && filaKg.precio_kg === 13.2, JSON.stringify(mk).slice(0, 200));
  const dDHL = (await cotizar({ servicio: 'DHL', pesoFacturable: 10, bultos: [{ peso_real: 10, largo: 10, ancho: 10, alto: 10 }] })).body;
  const dUPS = (await cotizar({ servicio: 'UPS_EXP', pesoFacturable: 22, bultos: [{ peso_real: 22, largo: 10, ancho: 10, alto: 10 }] })).body;
  const dKg = (await cotizar({ servicio: 'UPS_SAV', pesoFacturable: 4, bultos: [{ peso_real: 4, largo: 10, ancho: 10, alto: 10 }] })).body;
  // El flete de venta del motor es el que sube 10 % exacto (el total lleva seguro y extras fijos).
  const campo = 'flete_venta';
  check(`el motor cotiza 10 % más de flete de venta (campo ${campo}) en DHL (% por zona)`, campo && cerca(dDHL[campo] / antesDHL[campo], 1.1, 0.001), `${antesDHL[campo]} → ${dDHL[campo]}`);
  check('   en UPS Expedited (% por banda)', campo && cerca(dUPS[campo] / antesUPS[campo], 1.1, 0.001), `${antesUPS[campo]} → ${dUPS[campo]}`);
  check('   en UPS Saver (precio por kilo)', campo && cerca(dKg[campo] / antesKg[campo], 1.1, 0.001), `${antesKg[campo]} → ${dKg[campo]}`);
  check('   y el costo del flete no cambió', cerca(dDHL.flete_costo, antesDHL.flete_costo) && cerca(dKg.flete_costo, antesKg.flete_costo));
  let h = (await J('GET', `/clientes/${cli.id}/tarifa-aumento`)).body;
  check('historial: 1 aumento, +10 %, 6 cambios, sin revertir', h.length === 1 && h[0].pct === 10 && h[0].cambios === 6 && !h[0].revertido_en, JSON.stringify(h));

  // Segundo aumento, parcial.
  r = await J('POST', `/clientes/${cli.id}/tarifa-aumento`, { pct: 5, general: false, kg: false, tablas: [{ servicio: 'DHL', tipo: 'export' }] });
  check('segundo aumento +5 % solo DHL export: 2 cambios', r.status === 200 && r.body.total_cambios === 2, JSON.stringify(r.body).slice(0, 150));
  const a2 = r.body.aumento_id;
  const m2 = (await J('GET', `/clientes/${cli.id}/profit-matrix?servicio=DHL&tipo=export`)).body;
  check('DHL export: 76 → 84,8 y 87 → 96,35; el general sigue en 65', m2.general_tabla.profit_pct === 84.8 && m2.overrides.find((o) => o.zona === 3).profit_pct === 96.35 && (await J('GET', `/clientes/${cli.id}`)).body.tarifa_pct === 65, JSON.stringify(m2));

  console.log('\n3. Deshacer\n');
  r = await J('POST', `/clientes/${cli.id}/tarifa-aumento/${a1}/revertir`, {});
  check('deshacer uno que no es el último → 400', r.status === 400, JSON.stringify(r.body));
  r = await J('POST', `/clientes/${cli.id}/tarifa-aumento/${a2}/revertir`, {});
  check('deshacer el último (+5 %) → 200', r.status === 200 && r.body.revertido, JSON.stringify(r.body));
  const m3 = (await J('GET', `/clientes/${cli.id}/profit-matrix?servicio=DHL&tipo=export`)).body;
  check('DHL export volvió a 76 y 87', m3.general_tabla.profit_pct === 76 && m3.overrides.find((o) => o.zona === 3).profit_pct === 87, JSON.stringify(m3));
  r = await J('POST', `/clientes/${cli.id}/tarifa-aumento/${a2}/revertir`, {});
  check('deshacerlo dos veces → 400', r.status === 400);
  // Alguien toca una celda a mano después del +10 %: no se puede deshacer y no se toca nada.
  await J('PUT', `/clientes/${cli.id}/profit-matrix`, { servicio: 'UPS_EXP', tipo: 'import', zona: 3, profit_pct: 50 });
  r = await J('POST', `/clientes/${cli.id}/tarifa-aumento/${a1}/revertir`, {});
  check('con una celda tocada a mano después: 400 y dice cuál', r.status === 400 && /UPS_EXP import/.test(r.body.error), JSON.stringify(r.body));
  check('   y no cambió nada (general sigue 65, la celda sigue 50)', (await J('GET', `/clientes/${cli.id}`)).body.tarifa_pct === 65 && (await J('GET', `/clientes/${cli.id}/profit-matrix?servicio=UPS_EXP&tipo=import`)).body.overrides[0].profit_pct === 50);
  await J('PUT', `/clientes/${cli.id}/profit-matrix`, { servicio: 'UPS_EXP', tipo: 'import', zona: 3, profit_pct: 43 });
  r = await J('POST', `/clientes/${cli.id}/tarifa-aumento/${a1}/revertir`, {});
  check('vuelta la celda a 43, deshacer el +10 % → 200', r.status === 200, JSON.stringify(r.body));
  const c4 = (await J('GET', `/clientes/${cli.id}`)).body;
  const m4 = (await J('GET', `/clientes/${cli.id}/profit-matrix?servicio=DHL&tipo=export`)).body;
  const mk4 = (await J('GET', `/clientes/${cli.id}/tarifa-kg?servicio=UPS_SAVER&tipo=export`)).body;
  const fk4 = (mk4.overrides || mk4.filas || []).find((o) => o.precio_kg != null) || (mk4.general_tabla && mk4.general_tabla.precio_kg != null ? mk4.general_tabla : null);
  check('todo volvió a los valores originales: 50 / 60 / 70 / 12', c4.tarifa_pct === 50 && m4.general_tabla.profit_pct === 60 && m4.overrides.find((o) => o.zona === 3).profit_pct === 70 && fk4 && fk4.precio_kg === 12, JSON.stringify([c4.tarifa_pct, m4, fk4]));
  const vDHL = (await cotizar({ servicio: 'DHL', pesoFacturable: 10, bultos: [{ peso_real: 10, largo: 10, ancho: 10, alto: 10 }] })).body;
  check('y el motor cotiza igual que al principio', campo && cerca(vDHL[campo], antesDHL[campo]), `${antesDHL[campo]} vs ${vDHL[campo]}`);
  h = (await J('GET', `/clientes/${cli.id}/tarifa-aumento`)).body;
  check('historial: los 2 figuran como deshechos', h.length === 2 && h.every((x) => x.revertido_en), JSON.stringify(h.map((x) => [x.pct, !!x.revertido_en])));

  console.log('\n4. Pantalla\n');
  const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (mm) => { if (mm.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource|fonts\.g/.test(mm.text())) errores.push(mm.text()); });
  page.on('dialog', (dlg) => dlg.accept());
  await page.goto(`${BASE}/pages/clientes-perfil.html?id=${cli.id}`);
  await esperar(2500);
  check('hay botón "Aumentar tarifa"', !!(await page.$('#btn-aumentar-tarifa')));
  check('sin aumentos vivos, la tarjeta dice que el último fue deshecho', /deshecho/.test(await page.textContent('#tarifas-ultimo-aumento')), await page.textContent('#tarifas-ultimo-aumento'));
  await page.click('#btn-aumentar-tarifa');
  await esperar(800);
  check('se abre el modal con los tildes de qué tiene el cliente', !(await page.$eval('#aumento-modal', (el) => el.classList.contains('hidden'))) && (await page.$$('#aumento-que input[type=checkbox]')).length === 8);
  check('   el botón Aplicar está deshabilitado hasta escribir el %', await page.$eval('#aumento-aplicar', (b) => b.disabled));
  await page.fill('#aumento-pct', '10');
  await esperar(900);
  const prevTxt = await page.textContent('#aumento-preview');
  check('la vista previa muestra 50,00 % → 65,00 % y 12,00 → 13,20', /50,00 %/.test(prevTxt) && /65,00 %/.test(prevTxt) && /13,20/.test(prevTxt), prevTxt.slice(0, 300));
  check('   y dice cuántos valores cambian', /6 valor/.test(await page.textContent('#aumento-total')), await page.textContent('#aumento-total'));
  // Destildar UPS Expedited importación: baja a 5.
  await page.click('#aumento-que input[data-k="UPS_EXP|import"]');
  await esperar(900);
  check('destildar una tabla la saca de la vista previa (5 valores)', /5 valor/.test(await page.textContent('#aumento-total')), await page.textContent('#aumento-total'));
  await page.click('#aumento-aplicar');
  await esperar(1500);
  check('se aplica y el modal se cierra', await page.$eval('#aumento-modal', (el) => el.classList.contains('hidden')));
  const c5 = (await J('GET', `/clientes/${cli.id}`)).body;
  const m5 = (await J('GET', `/clientes/${cli.id}/profit-matrix?servicio=UPS_EXP&tipo=import`)).body;
  check('en la base: general 65, y la tabla destildada sigue en 30 (su valor original)', c5.tarifa_pct === 65 && m5.overrides[0].profit_pct === 30, JSON.stringify([c5.tarifa_pct, m5.overrides]));
  check('la tarjeta muestra "Último aumento: +10 %" con botón Deshacer', /Último aumento: \+10 %/.test(await page.textContent('#tarifas-ultimo-aumento')) && !!(await page.$('#btn-deshacer-aumento')), await page.textContent('#tarifas-ultimo-aumento'));
  check('el resumen de arriba dice 65 %', /65 % sobre el flete/.test(await page.textContent('#tarifas-resumen')), await page.textContent('#tarifas-resumen'));
  await page.click('#btn-deshacer-aumento');
  await esperar(1500);
  check('Deshacer vuelve el general a 50', (await J('GET', `/clientes/${cli.id}`)).body.tarifa_pct === 50);
  check('   y la pantalla lo refleja', /50 % sobre el flete/.test(await page.textContent('#tarifas-resumen')) && /deshecho/.test(await page.textContent('#tarifas-ultimo-aumento')));
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  await browser.close(); matar();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('✗', e); process.exit(1); });
