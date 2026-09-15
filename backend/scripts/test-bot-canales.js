#!/usr/bin/env node
/**
 * test-bot-canales.js — el asistente por teléfono: vinculación, permisos y webhooks
 * (15/09/2026). Corre con BOT_MOCK=1, como las otras tandas del asistente.
 *
 * Acá lo que está en juego es quién puede hablarle al bot. Cuando esto salga por WhatsApp,
 * el número del bot lo va a tener cualquiera que lo reciba reenviado: lo único que separa a
 * la oficina de un desconocido es el vínculo. Por eso el orden de lo que se prueba:
 *
 *  1. QUE UN TELÉFONO SIN VINCULAR NO OBTENGA NADA. Ni datos, ni una cotización, ni un
 *     "no encontré esa guía" (que ya diría que la guía no existe). Solo el aviso.
 *  2. QUE EL CÓDIGO SEA UNA LLAVE DE VERDAD: de un solo uso, con vencimiento, y que uno
 *     inventado no sirva.
 *  3. QUE LOS PERMISOS SEAN LOS DEL USUARIO DEL VÍNCULO. Por teléfono no hay sesión: se
 *     abre una efímera. Si esa sesión tuviera permisos propios, el teléfono sería una
 *     puerta trasera. Se prueba con un empleado sin ver_dashboard.
 *  4. QUE LA SESIÓN EFÍMERA SE BORRE. Si queda viva, el token de un mensaje sirve para
 *     entrar al sistema.
 *  5. Que el hilo se mantenga (el "sí" que confirma un pickup tiene que caer en la misma
 *     conversación) y que la escritura siga siendo en dos pasos también por teléfono.
 *  6. Que los webhooks estén cerrados: canal apagado 404, secreto equivocado 403.
 *
 *   cd backend && node scripts/test-bot-canales.js
 */
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3927;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_bot_canales.db';
const TOKEN = 'token-test-canales-admin';
const TOKEN2 = 'token-test-canales-empleado';

/* OJO: esto va ANTES de requerir nada de src/. `config/index.js` lee DB_PATH cuando se
   carga, así que si el require pasa primero, el servicio del bot abre la base equivocada
   (la de `database/nova.db`) y desde este proceso no se ve nada de lo que escribió el
   servidor de prueba. */
process.env.DB_PATH = DB;
/* Este proceso llama a `recibirMensaje` como si fuera el servidor (es lo que hace el
   webhook de WhatsApp), así que necesita el mismo entorno: el motor de mentira y el puerto
   al que las herramientas le pegan por dentro. */
process.env.BOT_MOCK = '1';
process.env.PORT = String(PORT);

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production',
      BOT_MOCK: '1', ANTHROPIC_API_KEY: '',
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_WEBHOOK_SECRETO: '', WHATSAPP_TOKEN: '', WHATSAPP_PHONE_ID: '',
      WHATSAPP_VERIFY_TOKEN: 'verificame',
    },
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

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const run = (q, p = []) => new Promise((res, rej) => db.run(q, p, (e) => (e ? rej(e) : res())));
  const get = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => (e ? rej(e) : res(r))));
  await run("UPDATE usuarios SET usuario = 'felipe', rol = 'admin', ver_dashboard = 1, ver_salud = 1 WHERE id = 1");
  await run("INSERT OR IGNORE INTO usuarios (id, usuario, password_hash, rol, ver_dashboard) VALUES (2, 'gabriela', 'x', 'empleado', 0)");
  await run('INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?,?,?)',
    [crypto.createHash('sha256').update(TOKEN2).digest('hex'), 2, new Date(Date.now() + 36e5).toISOString()]);
  await run("INSERT OR REPLACE INTO configuracion_nova (id, fuel_pct, fecha_actualizacion) VALUES (1, 30, datetime('now'))");

  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const H2 = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN2}` };
  const post = (ruta, body, h = H) => fetch(BASE + ruta, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const hoy = require('../src/utils/fecha').hoyLocal();

  const cli = await (await post('/api/clientes', {
    nombre: 'CANALES S.A.', tarifa_pct: 60, tipo_cobro: 'CC', direccion_recoleccion: 'Mitre 500, Bella Vista',
  })).json();
  await post('/api/envios', {
    cliente_id: cli.id, fecha: hoy, courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion',
    pais_destino: 'España', peso_real: 4, largo: 30, ancho: 20, alto: 20, fob: 80, total_cobrado: 150,
    numero_guia: '1Z555AA10123456701',
  });

  /* El teléfono le escribe al bot. Esto es EXACTAMENTE lo que va a hacer el webhook de
     WhatsApp: mismo servicio, misma función. */
  const canales = require('../src/services/bot-canales.service');
  await require('../src/db').initDb();
  const telefono = (texto, id = '5491165002047', canal = 'whatsapp') =>
    canales.recibirMensaje({ canal, identificador: id, texto });

  // ── 1 ──────────────────────────────────────────────────────────────────────
  console.log('\n1. Un teléfono sin vincular no obtiene nada\n');
  const r1 = await telefono('cómo viene la guía 1Z555AA10123456701');
  check('contesta que no está vinculado', /no te tengo vinculado/i.test(r1.respuesta), r1.respuesta);
  check('   y NO dice nada de la guía', !/CANALES|España|150/.test(r1.respuesta), r1.respuesta);
  check('   ni queda marcado como vinculado', r1.vinculado === false);
  check('   ni abrió conversación', (await get('SELECT COUNT(*) n FROM bot_conversaciones')).n === 0);
  const r1b = await telefono('123456');
  check('un código inventado tampoco sirve', /no sirve/i.test(r1b.respuesta), r1b.respuesta);

  // ── 2 ──────────────────────────────────────────────────────────────────────
  console.log('\n2. El código de vinculación\n');
  const cod = await (await post('/api/bot/vinculos', { canal: 'whatsapp', etiqueta: 'mi celular' })).json();
  check('el panel devuelve un código de 6 dígitos y su vencimiento', /^\d{6}$/.test(cod.codigo) && !!cod.vence_en, JSON.stringify(cod));
  const lista1 = await (await fetch(BASE + '/api/bot/vinculos', { headers: H })).json();
  check('aparece como pendiente en la lista', lista1.length === 1 && lista1[0].estado === 'pendiente', JSON.stringify(lista1));
  const r2 = await telefono(cod.codigo);
  check('mandarlo por el canal vincula el teléfono', r2.vinculado === true && /vinculado/i.test(r2.respuesta), r2.respuesta);
  check('   y el aviso dice con qué usuario quedó', /felipe/i.test(r2.respuesta), r2.respuesta);
  const lista2 = await (await fetch(BASE + '/api/bot/vinculos', { headers: H })).json();
  check('la lista lo muestra activo y con el teléfono tapado', lista2[0].estado === 'activo' && lista2[0].identificador === '…2047', JSON.stringify(lista2));
  check('   y ya no muestra el código', lista2[0].codigo === null);
  const r2b = await telefono(cod.codigo);
  check('el mismo código no vuelve a usarse (ya es un mensaje común)', !/vinculado como/i.test(r2b.respuesta), r2b.respuesta);
  const vencido = await (await post('/api/bot/vinculos', { canal: 'telegram' })).json();
  await run("UPDATE bot_vinculos SET codigo_vence_en = '2000-01-01 00:00:00' WHERE codigo = ?", [vencido.codigo]);
  const r2c = await telefono(vencido.codigo, '777777', 'telegram');
  check('un código vencido lo dice y no vincula', /venció/i.test(r2c.respuesta) && r2c.vinculado !== true, r2c.respuesta);

  // ── 3 ──────────────────────────────────────────────────────────────────────
  console.log('\n3. Vinculado: contesta con los permisos de ESE usuario\n');
  const r3 = await telefono('cómo viene la guía 1Z555AA10123456701');
  check('ahora sí contesta la guía', /1Z555AA10123456701/.test(r3.respuesta) && /CANALES/.test(r3.respuesta), r3.respuesta);
  const r3b = await telefono('cómo viene la venta de hoy');
  check('y la venta (felipe es admin con ver_dashboard)', /venta/i.test(r3b.respuesta) && /USD/.test(r3b.respuesta), r3b.respuesta);
  // El teléfono de una empleada sin ver_dashboard
  const codG = await (await post('/api/bot/vinculos', { canal: 'whatsapp', etiqueta: 'celu gabriela' }, H2)).json();
  await canales.recibirMensaje({ canal: 'whatsapp', identificador: '5491199990000', texto: codG.codigo });
  const r3c = await telefono('venta de hoy', '5491199990000');
  check('el teléfono de una empleada sin permiso NO saca la venta',
    !/USD \d/.test(r3c.respuesta) && /403|permiso|dashboard/i.test(r3c.respuesta), r3c.respuesta);
  const r3d = await telefono('guía 1Z555AA10123456701', '5491199990000');
  check('   pero sí puede consultar una guía', /1Z555AA10123456701/.test(r3d.respuesta), r3d.respuesta);

  // ── 4 ──────────────────────────────────────────────────────────────────────
  console.log('\n4. La sesión efímera no queda viva\n');
  const sesiones = await get('SELECT COUNT(*) n FROM sesiones');
  check('después de atender no quedan sesiones de más (solo las dos de prueba)', sesiones.n === 2, String(sesiones.n));

  // ── 5 ──────────────────────────────────────────────────────────────────────
  console.log('\n5. El hilo y la escritura en dos pasos\n');
  const conv = await get("SELECT * FROM bot_conversaciones WHERE usuario_id = 1 ORDER BY id DESC LIMIT 1");
  check('la conversación quedó marcada con el canal whatsapp', conv.canal === 'whatsapp', conv.canal);
  check('   y los mensajes del teléfono van todos al mismo hilo',
    (await get('SELECT COUNT(*) n FROM bot_conversaciones WHERE usuario_id = 1')).n === 1);
  const antes = (await get('SELECT COUNT(*) n FROM pickups')).n;
  const r5 = await telefono(`cargá un pickup para el cliente ${cli.id} mañana de 15 a 18`);
  check('propone el pickup y pregunta', /lo cargo/i.test(r5.respuesta), r5.respuesta);
  check('   sin grabar nada', (await get('SELECT COUNT(*) n FROM pickups')).n === antes);
  const r5b = await telefono('sí');
  check('el "sí" del teléfono lo carga', /cargado/i.test(r5b.respuesta), r5b.respuesta);
  check('   y quedó en la base', (await get('SELECT COUNT(*) n FROM pickups')).n === antes + 1);
  const pk = await get('SELECT * FROM pickups ORDER BY id DESC LIMIT 1');
  check('   con la marca de quién lo pidió', /a pedido de felipe/i.test(pk.notas || ''), pk.notas);

  // ── 6 ──────────────────────────────────────────────────────────────────────
  console.log('\n6. Dar de baja un teléfono\n');
  const mio = (await (await fetch(BASE + '/api/bot/vinculos', { headers: H })).json()).find((v) => v.identificador === '…2047');
  const baja = await fetch(`${BASE}/api/bot/vinculos/${mio.id}`, { method: 'DELETE', headers: H });
  check('el dueño lo puede dar de baja', baja.status === 200, String(baja.status));
  const r6 = await telefono('venta de hoy');
  check('   y desde ahí el teléfono no obtiene más nada', /no te tengo vinculado/i.test(r6.respuesta), r6.respuesta);
  const ajeno = await fetch(`${BASE}/api/bot/vinculos/999`, { method: 'DELETE', headers: H2 });
  check('un vínculo que no existe da 404', ajeno.status === 404, String(ajeno.status));

  // ── 7 ──────────────────────────────────────────────────────────────────────
  console.log('\n7. Los webhooks están cerrados\n');
  const wTel = await post('/api/bot/webhook/telegram/loquesea', { message: { text: 'hola', chat: { id: 1 } } }, { 'Content-Type': 'application/json' });
  check('Telegram apagado (sin token en el .env): 404', wTel.status === 404, String(wTel.status));
  const wWa = await post('/api/bot/webhook/whatsapp', { entry: [] }, { 'Content-Type': 'application/json' });
  check('WhatsApp apagado: 404', wWa.status === 404, String(wWa.status));
  const verifyOk = await fetch(`${BASE}/api/bot/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verificame&hub.challenge=12345`);
  check('la verificación de Meta con el token correcto devuelve el desafío',
    verifyOk.status === 200 && (await verifyOk.text()) === '12345', String(verifyOk.status));
  const verifyMal = await fetch(`${BASE}/api/bot/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=12345`);
  check('   con el token equivocado, 403', verifyMal.status === 403, String(verifyMal.status));
  const sinSesion = await fetch(BASE + '/api/bot/vinculos');
  check('la lista de teléfonos sigue pidiendo sesión (401)', sinSesion.status === 401, String(sinSesion.status));

  // ── 8 ──────────────────────────────────────────────────────────────────────
  console.log('\n8. El simulador del panel usa el mismo camino\n');
  const codSim = await (await post('/api/bot/vinculos', { canal: 'prueba', etiqueta: 'simulador' })).json();
  const sim1 = await (await post('/api/bot/simular', { canal: 'prueba', texto: codSim.codigo })).json();
  check('el simulador vincula con el código igual que un teléfono', sim1.vinculado === true, JSON.stringify(sim1));
  const sim2 = await (await post('/api/bot/simular', { canal: 'prueba', texto: 'guía 1Z555AA10123456701' })).json();
  check('   y después contesta', /1Z555AA10123456701/.test(sim2.respuesta), sim2.respuesta);
  /* El freno que importa: el simulador no puede hacerse pasar por el teléfono de otro.
     Gabriela pide simular con el identificador de Felipe y aun así le contesta como
     Gabriela (o le dice que no está vinculada). */
  const suplantar = await (await post('/api/bot/simular',
    { canal: 'whatsapp', identificador: '5491165002047', texto: 'venta de hoy' }, H2)).json();
  check('el simulador ignora el canal y el teléfono que le manden',
    !/USD \d/.test(suplantar.respuesta), suplantar.respuesta);

  await new Promise((res) => db.close(() => res()));
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
