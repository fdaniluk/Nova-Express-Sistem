#!/usr/bin/env node
/**
 * test-pantalla-entrega-impo.js — la entrega de una importación desde Pickups (04/09/2026).
 *
 * Pedido de Felipe: "desde la parte de PickUps exista la opción de cargar la entrega de una
 * importación: un envío que ya está en el depósito y se tiene que entregar en lo del
 * cliente acá en Buenos Aires, por lo tanto no pasa por Operaciones. De 30 envíos, 1 o 2
 * deben ser impo: un casillero despintado que se pinta".
 *
 * Lo que cuida esta tanda:
 *   1. El dato (pickups.entrega_impo): nace 0, se guarda por POST y PUT, se normaliza.
 *   2. Con la marca puesta: Operaciones NO la ve (ni ese día ni como rezagada), aunque
 *      alguien mande mostrar_en_operaciones=1; tipo courier/cobranza → 400.
 *   3. La cadena del chofer es la misma (Ricardo → visto → camioneta) y el último paso
 *      deja estado 'entregado', no 'en_deposito'; y NO toca el estado_operativo de un
 *      envío del mismo cliente cargado ese día (un pickup normal sí lo hace).
 *   4. La pantalla: el casillero en el modal, la tarjeta con el chip ENTREGA IMPO y el
 *      botón "Entregado", el contador del resumen, y la vista semana.
 *
 *   cd backend && node scripts/test-pantalla-entrega-impo.js
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

const PORT = process.env.PORT_TEST || 3953;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_entrega_impo.db';
const TOKEN = 'token-test-entrega-impo';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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
  const post = (url, body) => fetch(BASE + '/api' + url, { method: 'POST', headers: H, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const put = (url, body) => fetch(BASE + '/api' + url, { method: 'PUT', headers: H, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const patch = (url, body) => fetch(BASE + '/api' + url, { method: 'PATCH', headers: H, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const get = (url) => fetch(BASE + '/api' + url, { headers: H }).then((r) => r.json());

  // Un lunes de la semana que viene, para que la pantalla lo muestre sin pelearse con
  // el fin de semana (la vista día solo tiene lunes a viernes).
  const hoy = new Date();
  const lunes = new Date(hoy);
  lunes.setDate(hoy.getDate() + ((8 - hoy.getDay()) % 7 || 7));
  const fecha = iso(lunes);

  const cli = (await post('/clientes', { nombre: 'IMPORTADORA ENTREGA', tarifa_pct: 75, tipo_cobro: 'CC' })).body;
  const base = { cliente_id: cli.id, direccion: 'Av. Corrientes 1234, CABA', fecha, hora_inicio: '10:00', hora_fin: '12:00', courier: 'DHL' };

  console.log('\n1. El dato: nace apagado, se guarda pintado, se normaliza\n');
  const normal = await post('/pickups', { ...base, mostrar_en_operaciones: 1 });
  check('un pickup normal nace con entrega_impo = 0', normal.status === 201 && Number(normal.body.entrega_impo) === 0, JSON.stringify(normal.body).slice(0, 120));

  const ent = await post('/pickups', { ...base, entrega_impo: 1, mostrar_en_operaciones: 1, notas: 'Caja DHL de Miami' });
  check('la entrega se crea con entrega_impo = 1', ent.status === 201 && Number(ent.body.entrega_impo) === 1, JSON.stringify(ent.body).slice(0, 120));
  check('aunque manden mostrar_en_operaciones=1, queda en 0', Number(ent.body.mostrar_en_operaciones) === 0);
  check('nace pendiente', ent.body.estado === 'pendiente');

  const basura = await post('/pickups', { ...base, entrega_impo: 'sí' });
  check('basura en entrega_impo se descarta (queda 0)', basura.status === 201 && Number(basura.body.entrega_impo) === 0);

  const courier = await post('/pickups', { ...base, entrega_impo: 1, tipo_recoleccion: 'courier' });
  check('entrega + courier → 400', courier.status === 400, JSON.stringify(courier.body));
  const cobranza = await post('/pickups', { ...base, entrega_impo: 1, tipo_recoleccion: 'cobranza' });
  check('entrega + cobranza → 400', cobranza.status === 400);
  const retira = await post('/pickups', { ...base, entrega_impo: 1, tipo_recoleccion: 'cliente', hora_inicio: '14:00', hora_fin: '15:00' });
  check('entrega + la retira el cliente → OK', retira.status === 201 && retira.body.tipo_recoleccion === 'cliente');

  console.log('\n2. Operaciones no la ve; Pickups sí\n');
  const ops = await get(`/operaciones?fecha=${fecha}`);
  check('Operaciones ve el pickup normal', ops.pickups.some((p) => p.id === normal.body.id));
  check('Operaciones NO ve la entrega', !ops.pickups.some((p) => p.id === ent.body.id));
  const manana = new Date(lunes); manana.setDate(lunes.getDate() + 1);
  const opsManana = await get(`/operaciones?fecha=${iso(manana)}`);
  check('ni la arrastra como rezagada al día siguiente', !(opsManana.rezagados || []).some((p) => p.id === ent.body.id),
    JSON.stringify((opsManana.rezagados || []).map((p) => p.id)));
  const lista = await get(`/pickups?desde=${fecha}&hasta=${fecha}`);
  check('Pickups sí la lista, con la marca', lista.some((p) => p.id === ent.body.id && Number(p.entrega_impo) === 1));

  console.log('\n3. El PUT conserva y cambia la marca\n');
  const putSin = await put(`/pickups/${ent.body.id}`, { notas: 'cambio de nota nomás' });
  check('PUT sin entrega_impo la conserva', putSin.status === 200 && Number(putSin.body.entrega_impo) === 1);
  const putOper = await put(`/pickups/${ent.body.id}`, { mostrar_en_operaciones: 1 });
  check('PUT con mostrar_en_operaciones=1 sigue sin ir a Operaciones', Number(putOper.body.mostrar_en_operaciones) === 0);
  const putCourier = await put(`/pickups/${ent.body.id}`, { tipo_recoleccion: 'courier' });
  check('PUT a courier con la marca puesta → 400', putCourier.status === 400);
  const putPinta = await put(`/pickups/${normal.body.id}`, { entrega_impo: 1 });
  check('se puede pintar un pickup existente', Number(putPinta.body.entrega_impo) === 1 && Number(putPinta.body.mostrar_en_operaciones) === 0);
  const putDespinta = await put(`/pickups/${normal.body.id}`, { entrega_impo: 0, mostrar_en_operaciones: 1 });
  check('y despintarlo (vuelve a Operaciones)', Number(putDespinta.body.entrega_impo) === 0 && Number(putDespinta.body.mostrar_en_operaciones) === 1);

  console.log('\n4. La cadena del chofer termina en "entregado" y no toca los envíos\n');
  // Un envío de exportación del MISMO cliente, el MISMO día, pendiente en depósito: el
  // pickup normal lo pasa a en_deposito al confirmar depósito; la entrega no lo toca.
  const envio = (await post('/envios', {
    cliente_id: cli.id, fecha, courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_EXP',
    numero_guia: '1Z000ENTREGAIMPO01', pais_destino: 'Estados Unidos', peso_real: 5, largo: 30, ancho: 20, alto: 15,
    fob: 0, total_cobrado: 150,
  })).body;
  const estadoEnvio = async () => (await get(`/envios/${envio.id}`)).estado_operativo;
  check('el envío arranca pendiente', (await estadoEnvio()) === 'pendiente', await estadoEnvio());

  let r = await patch(`/pickups/${ent.body.id}`, { confirmar_ricardo: true, recolector: 'Juanqui' });
  check('Ricardo confirma y asigna chofer', r.status === 200 && r.body.recolector === 'Juanqui' && r.body.estado === 'pendiente', JSON.stringify(r.body).slice(0, 100));
  r = await patch(`/pickups/${ent.body.id}`, { confirmar_juanqui: true });
  check('en camioneta (salió del depósito)', r.body.estado === 'en_camioneta');
  r = await patch(`/pickups/${ent.body.id}`, { confirmar_deposito: true });
  check('el último paso deja estado "entregado"', r.body.estado === 'entregado', r.body.estado);
  check('con su hora', !!r.body.en_deposito_at);
  check('y el envío del cliente sigue pendiente (no lo tocó)', (await estadoEnvio()) === 'pendiente', await estadoEnvio());
  r = await patch(`/pickups/${ent.body.id}`, { confirmar_deposito: false });
  check('se puede deshacer', r.body.estado === 'en_camioneta' && !r.body.en_deposito_at);
  r = await patch(`/pickups/${ent.body.id}`, { confirmar_deposito: true });

  // Control: el pickup normal del mismo cliente y día SÍ mueve el envío.
  await patch(`/pickups/${normal.body.id}`, { confirmar_ricardo: true, recolector: 'Felipe' });
  await patch(`/pickups/${normal.body.id}`, { confirmar_juanqui: true });
  r = await patch(`/pickups/${normal.body.id}`, { confirmar_deposito: true });
  check('control: el pickup normal termina en "en_deposito"', r.body.estado === 'en_deposito');
  check('control: y ese sí pasa el envío a en_deposito', (await estadoEnvio()) === 'en_deposito', await estadoEnvio());

  // La que retira el cliente: solo el paso final, que se llama "retirada".
  r = await patch(`/pickups/${retira.body.id}`, { confirmar_deposito: true });
  check('la que retira el cliente también termina en "entregado"', r.body.estado === 'entregado', r.body.estado);

  console.log('\n5. La pantalla\n');
  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) errores.push(m.text());
  });
  page.on('dialog', (d) => d.accept());

  await page.goto(`${BASE}/pages/pickups.html`);
  await esperar(2500);
  // Ir al lunes de la prueba: la pantalla arranca en la semana actual, así que el lunes
  // que viene está una semana adelante (o dos, si hoy es domingo y la semana ya cerró).
  let pill = await page.$(`.day-pill[data-ymd="${fecha}"]`);
  for (let i = 0; i < 2 && !pill; i++) {
    await page.click('#btn-next-week');
    await esperar(1000);
    pill = await page.$(`.day-pill[data-ymd="${fecha}"]`);
  }
  check('la pantalla muestra el día de la prueba', !!pill);
  if (pill) { await pill.click(); await esperar(800); }

  const cardEnt = await page.$(`#pickup-card-${ent.body.id}`);
  check('la tarjeta de la entrega está', !!cardEnt);
  const htmlEnt = cardEnt ? await cardEnt.innerHTML() : '';
  check('con el chip ENTREGA IMPO', /ENTREGA IMPO/.test(htmlEnt));
  check('con "Entregar en:" delante de la dirección', /Entregar en: Av\. Corrientes/.test(htmlEnt));
  check('y el último paso dice "Entregado", no "En depósito"', /✓ Entregado \d\d:\d\d/.test(htmlEnt) && !/En depósito/.test(htmlEnt), htmlEnt.replace(/\s+/g, ' ').slice(0, 300));
  check('la tarjeta lleva la clase entrega-impo', cardEnt ? await cardEnt.evaluate((el) => el.classList.contains('entrega-impo')) : false);

  const cardNormal = await page.$(`#pickup-card-${normal.body.id}`);
  const htmlNormal = cardNormal ? await cardNormal.innerHTML() : '';
  check('el pickup normal sigue diciendo "En depósito" y sin chip', /✓ En depósito/.test(htmlNormal) && !/ENTREGA IMPO/.test(htmlNormal));

  const cardRetira = await page.$(`#pickup-card-${retira.body.id}`);
  const htmlRetira = cardRetira ? await cardRetira.innerHTML() : '';
  check('la que retira el cliente dice "Retirada"', /✓ Retirada \d\d:\d\d/.test(htmlRetira) && /retirada por el cliente/.test(htmlRetira), htmlRetira.replace(/\s+/g, ' ').slice(0, 300));

  const entEl = await page.$('#count-ent');
  const entVisible = entEl ? await entEl.isVisible() : false;
  const entTexto = entEl ? await entEl.textContent() : '';
  check('el resumen cuenta "2/2 entregas impo"', entVisible && /2\/2 entregas impo/.test(entTexto), entTexto);
  const depTexto = await page.textContent('#count-dep');
  check('y "en depósito" cuenta solo el normal (1)', /✓ 1 en depósito/.test(depTexto), depTexto);

  // El modal: el casillero, y lo que cambia al pintarlo.
  await page.click('#btn-nuevo-pickup');
  await esperar(500);
  check('el modal tiene el casillero apagado de entrada', (await page.isChecked('#m-entrega-impo')) === false);
  check('y "Mostrar en Operaciones" a la vista', await page.isVisible('#m-mostrar-operaciones-group'));
  await page.check('#m-entrega-impo');
  await esperar(200);
  check('pintado: "Mostrar en Operaciones" se esconde', !(await page.isVisible('#m-mostrar-operaciones-group')));
  check('y queda apagado', (await page.isChecked('#m-mostrar-operaciones')) === false);
  const opcionesVisibles = await page.$$eval('#m-tipo-recoleccion option', (os) => os.filter((o) => !o.hidden && !o.disabled).map((o) => o.value));
  check('el tipo se reduce a chofer / cliente', opcionesVisibles.join(',') === 'normal,cliente', opcionesVisibles.join(','));
  check('con el rótulo "Cómo se entrega"', (await page.textContent('#m-tipo-recoleccion-label')).trim() === 'Cómo se entrega');
  await page.uncheck('#m-entrega-impo');
  await esperar(200);
  const opcionesTodas = await page.$$eval('#m-tipo-recoleccion option', (os) => os.filter((o) => !o.hidden && !o.disabled).map((o) => o.value));
  check('despintado: vuelven las cuatro opciones', opcionesTodas.length === 4, opcionesTodas.join(','));
  check('y vuelve "Mostrar en Operaciones"', await page.isVisible('#m-mostrar-operaciones-group'));

  // Guardar una entrega desde el modal, de punta a punta.
  await page.selectOption('#m-cliente', String(cli.id));
  await esperar(600);
  await page.fill('#m-direccion', 'Av. Corrientes 1234, CABA');
  await page.fill('#m-fecha', fecha);
  await page.fill('#m-hora-inicio', '16:00');
  await page.fill('#m-hora-fin', '17:00');
  await page.check('#m-entrega-impo');
  await page.click('#btn-modal-guardar');
  await esperar(1500);
  const listaTras = await get(`/pickups?desde=${fecha}&hasta=${fecha}`);
  const creadaModal = listaTras.find((p) => p.hora_inicio === '16:00');
  check('guardada desde el modal con la marca', !!creadaModal && Number(creadaModal.entrega_impo) === 1 && Number(creadaModal.mostrar_en_operaciones) === 0,
    JSON.stringify(creadaModal || {}).slice(0, 120));
  const entTexto2 = await page.textContent('#count-ent');
  check('el resumen pasa a "2/3 entregas impo"', /2\/3 entregas impo/.test(entTexto2), entTexto2);

  // Vista semana: el chip IMPO y "Entregado".
  await page.click('#btn-vista-semana');
  await esperar(600);
  const semana = await page.textContent('#semana-list');
  check('la vista semana marca IMPO y dice Entregado', /IMPO/.test(semana) && /Entregado/.test(semana));

  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await browser.close();
  matarSrv();
  await esperarSrvMuerto();
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
