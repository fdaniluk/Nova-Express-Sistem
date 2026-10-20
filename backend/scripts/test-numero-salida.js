#!/usr/bin/env node
// Número de salida a mano (20/10/2026, pedido de la oficina): en el modal de Salidas se
// escribe el #Sal que se quiere y el envío pasa a esa posición del mes; los demás se corren.
//   · la regla compartida (shared/salidas/numeracion.js): clave automática fecha+id, clave a
//     mano entre los vecinos, los "sin numerar" no cuentan
//   · PATCH /salidas/:id con numero_salida = N → el envío queda N y el resto corrido
//   · poner el número que ya tiene no cambia nada; cambiar la fecha lo devuelve al orden
//     automático; "sin numerar" también
//   · el GET devuelve numero_salida = num_sal_mes (lo que muestra el modal)
//   · pantalla: editar el Nro. Salida reordena la tabla sin recargar
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ playwright no está instalado — se saltea.'); process.exit(0); }
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const N = require('../../shared/salidas/numeracion');
const PORT = process.env.PORT_TEST || 3976;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_numero_salida.db';
const TOKEN = 'token-test-numsal';
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n1. La regla compartida\n');
  const l = [{ id: 1, fecha: '2026-10-01' }, { id: 2, fecha: '2026-10-02' }, { id: 3, fecha: '2026-10-03' }, { id: 4, fecha: '2026-10-03', num_sal_cero: 1 }, { id: 5, fecha: '2026-10-04' }];
  const nums = (lista) => [...N.numerarPorMes(lista)].map(([id, n]) => `${id}:${n}`).join(' ');
  check('sin posiciones a mano: por fecha e id, el sin numerar da 0', nums(l) === '1:1 2:2 3:3 4:0 5:4', nums(l));
  l[2].orden_salida = N.claveParaNumero(l[2], l, 1);
  check('el 3 pedido como #1 queda primero y los demás se corren', nums(l) === '3:1 1:2 2:3 4:0 5:4', nums(l));
  l[4].orden_salida = N.claveParaNumero(l[4], l, 2);
  check('el 5 pedido como #2 entra entre el 3 y el 1', nums(l) === '3:1 5:2 1:3 2:4 4:0', nums(l));
  l[0].orden_salida = N.claveParaNumero(l[0], l, 99);
  check('un número mayor que la cantidad lo manda al final', nums(l) === '3:1 5:2 2:3 4:0 1:4', nums(l));
  l[0].orden_salida = null;
  check('sin clave a mano vuelve a su clave por fecha (los que siguen a mano se quedan donde los pusieron)', nums(l) === '3:1 5:2 1:3 2:4 4:0', nums(l));

  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const J = (m, u, b) => fetch(BASE + '/api' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  console.log('\n2. API\n');
  const cli = (await J('POST', '/clientes', { nombre: 'NUMSAL SA', tarifa_pct: 50, tipo_cobro: 'CC' })).body;
  const base = { cliente_id: cli.id, tipo_envio: 'exportacion', pais_destino: 'BRASIL', courier: 'DHL', tipo_paquete: 'm', peso_real: 5, largo: 30, ancho: 20, alto: 20, total_cobrado: 300 };
  const alta = async (guia, fecha, extra = {}) => (await J('POST', '/envios', { ...base, numero_guia: guia, fecha, ...extra })).body;
  const a = await alta('1Z0000NUMSAL000001', '2026-11-02');
  const b = await alta('1Z0000NUMSAL000002', '2026-11-03');
  const c = await alta('1Z0000NUMSAL000003', '2026-11-04');
  const d = await alta('1Z0000NUMSAL000004', '2026-11-05');
  const otroMes = await alta('1Z0000NUMSAL000005', '2026-12-01');
  const lista = async () => {
    const r = (await J('GET', '/salidas?desde=2026-11-01&hasta=2026-12-31')).body;
    const mios = r.filter((e) => /NUMSAL/.test(e.numero_guia));
    return Object.fromEntries(mios.map((e) => [e.numero_guia.slice(-1), e.num_sal_mes]));
  };
  const todos = (await J('GET', '/salidas?desde=2026-11-01&hasta=2026-12-31')).body;
  check('el GET devuelve numero_salida = num_sal_mes', todos.filter((e) => /NUMSAL/.test(e.numero_guia)).every((e) => e.numero_salida === e.num_sal_mes), JSON.stringify(todos.map((e) => [e.numero_salida, e.num_sal_mes])));
  check('de entrada: 1,2,3,4 por fecha; el de diciembre es 1 en su mes', JSON.stringify(await lista()) === JSON.stringify({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 1 }), JSON.stringify(await lista()));
  let r = await J('PATCH', `/salidas/${d.id}`, { numero_salida: 2 });
  check('PATCH numero_salida 2 al 4º → 200 y devuelve orden_salida', r.status === 200 && typeof r.body.orden_salida === 'number', JSON.stringify(r.body));
  check('   queda 2 y el resto se corre: 1,3,4,2', JSON.stringify(await lista()) === JSON.stringify({ 1: 1, 2: 3, 3: 4, 4: 2, 5: 1 }), JSON.stringify(await lista()));
  r = await J('PATCH', `/salidas/${d.id}`, { numero_salida: 2, total_cobrado: 310 });
  check('editar otra cosa con el mismo número no lo mueve (sin orden_salida en la respuesta)', r.status === 200 && !('orden_salida' in r.body) && JSON.stringify(await lista()) === JSON.stringify({ 1: 1, 2: 3, 3: 4, 4: 2, 5: 1 }), JSON.stringify(r.body));
  r = await J('PATCH', `/salidas/${a.id}`, { numero_salida: 4 });
  check('el 1º pedido como 4 → 4; queda d=1, b=2, c=3, a=4', JSON.stringify(await lista()) === JSON.stringify({ 1: 4, 2: 2, 3: 3, 4: 1, 5: 1 }), JSON.stringify(await lista()));
  r = await J('PATCH', `/salidas/${d.id}`, { fecha: '2026-11-06' });
  check('cambiarle la fecha lo devuelve al orden automático (último por fecha) y la respuesta trae orden_salida null', r.body.orden_salida === null && JSON.stringify(await lista()) === JSON.stringify({ 1: 3, 2: 1, 3: 2, 4: 4, 5: 1 }), JSON.stringify(await lista()));
  r = await J('PATCH', `/salidas/${a.id}`, { num_sal_cero: 1 });
  check('"sin numerar" da 0, no consume número y borra la posición a mano', JSON.stringify(await lista()) === JSON.stringify({ 1: 0, 2: 1, 3: 2, 4: 3, 5: 1 }), JSON.stringify(await lista()));
  r = await J('PATCH', `/salidas/${a.id}`, { num_sal_cero: 0, numero_salida: 1 });
  check('volver a numerarlo pidiendo el 1 en la misma edición', JSON.stringify(await lista()) === JSON.stringify({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 1 }), JSON.stringify(await lista()));
  r = await J('PATCH', `/salidas/${c.id}`, { fecha: '2026-12-15', numero_salida: 1 });
  check('fecha a otro mes + número 1: queda 1 en diciembre y el de diciembre pasa a 2', JSON.stringify(await lista()) === JSON.stringify({ 1: 1, 2: 2, 3: 1, 4: 3, 5: 2 }), JSON.stringify(await lista()));
  r = await J('PATCH', `/salidas/${c.id}`, { numero_salida: 0 });
  check('numero_salida 0 se ignora (no mueve)', r.status === 200 && JSON.stringify(await lista()) === JSON.stringify({ 1: 1, 2: 2, 3: 1, 4: 3, 5: 2 }));

  console.log('\n3. Pantalla\n');
  const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource|fonts\.g/.test(m.text())) errores.push(m.text()); });
  page.on('dialog', (dlg) => dlg.accept());
  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  const irAlMes = async (mes) => { const t = (await page.$$('.month-tab')).filter(async () => true); for (const x of await page.$$('.month-tab')) { if ((await x.getAttribute('data-mes')) === mes || (await x.innerText()).toLowerCase().includes(mes === '2026-11' ? 'nov' : 'dic')) { await x.click(); await esperar(800); return true; } } return false; };
  await irAlMes('2026-11');
  const numsPantalla = () => page.$$eval('.salidas-table tbody tr', (trs) => Object.fromEntries(trs.filter((tr) => /NUMSAL/.test(tr.innerText)).map((tr) => { const g = tr.innerText.match(/1Z0000NUMSAL00000(\d)/); return [g ? g[1] : '?', tr.querySelector('td[data-col="numero_salida"]').innerText.trim()]; })));
  let np = await numsPantalla();
  check('la pantalla muestra noviembre como el servidor: a=1, b=2, d=3', np['1'] === '1' && np['2'] === '2' && np['4'] === '3', JSON.stringify(np));
  // Abrir el envío d (#3, el MÁS NUEVO: por fecha ya está arriba de todo) y pedirle el 1. Si
  // la tabla solo cambiara el número y no la fila, d seguiría arriba: es lo que vio Felipe
  // el 20/10 (Cliente Demo con el 75 primero de la lista).
  const filasAntes = await page.$$eval('.salidas-table tbody tr', (trs) => trs.map((tr) => (tr.innerText.match(/1Z0000NUMSAL00000(\d)/) || [])[1]).filter(Boolean).join(''));
  check('de entrada las filas van por fecha, la más nueva arriba: d, b, a → "421"', filasAntes === '421', filasAntes);
  const trs = await page.$$('.salidas-table tbody tr');
  let trD = null;
  for (const tr of trs) { if ((await tr.innerText()).includes('1Z0000NUMSAL000004')) { trD = tr; break; } }
  check('encuentra la fila de d', !!trD);
  await (await trD.$('td[data-col="numero_guia"]') || trD).click();
  await esperar(1200);
  const abierto = await page.$('#saled-numero-salida');
  check('se abre el modal con el Nro. Salida = 3', abierto && (await page.inputValue('#saled-numero-salida')) === '3', abierto ? await page.inputValue('#saled-numero-salida') : 'sin modal');
  const ordenFilas = () => page.$$eval('.salidas-table tbody tr', (trs) => trs.map((tr) => (tr.innerText.match(/1Z0000NUMSAL00000(\d)/) || [])[1]).filter(Boolean).join(''));
  if (abierto) {
    await page.fill('#saled-numero-salida', '1');
    await page.click('#sal-modal-save');
    await esperar(2000);
    np = await numsPantalla();
    check('al guardar, la tabla renumera sin recargar: d=1, a=2, b=3', np['4'] === '1' && np['1'] === '2' && np['2'] === '3', JSON.stringify(np));
    check('   y la FILA de d baja al final (b, a, d → "214"), aunque su fecha sea la más nueva', (await ordenFilas()) === '214', await ordenFilas());
    check('   y el servidor dice lo mismo', JSON.stringify(await lista()) === JSON.stringify({ 1: 2, 2: 3, 3: 1, 4: 1, 5: 2 }), JSON.stringify(await lista()));
    await page.reload(); await esperar(3000);
    await irAlMes('2026-11');
    np = await numsPantalla();
    check('después de recargar sigue igual (números)', np['4'] === '1' && np['1'] === '2' && np['2'] === '3', JSON.stringify(np));
    check('   y el orden de las filas también', (await ordenFilas()) === '214', await ordenFilas());
  }
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  await browser.close(); matar();
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('✗', e); process.exit(1); });
