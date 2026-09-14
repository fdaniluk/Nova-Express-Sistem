#!/usr/bin/env node
/**
 * test-bot.js — el asistente de la oficina, de punta a punta con el motor de mentira
 * (14/09/2026).
 *
 * El asistente (services/bot.service.js) entiende un pedido, elige una herramienta y la
 * herramienta llama a la API del sistema con la cookie de la persona. Acá se corre con
 * `BOT_MOCK=1`: un motor determinista que reconoce el pedido por patrones y usa LAS MISMAS
 * herramientas que usaría Claude. Así se prueba todo el circuito sin clave, sin red y sin
 * gastar. Lo que esta tanda NO prueba es cuán bien entiende el modelo de verdad: eso se
 * prueba a mano, con la clave puesta.
 *
 * QUÉ CUIDA, en orden de riesgo:
 *
 *  1. QUE UNA ESCRITURA NUNCA PASE SIN CONFIRMAR. Cargar un pickup es proponer + "sí".
 *     Si "sí" grabara sin propuesta, o la propuesta grabara sola, el asistente cargaría
 *     cosas que nadie pidió. Y queda quién lo pidió en las notas.
 *  2. QUE LA COTIZACIÓN NO FILTRE EL MARGEN. La ruta interna de cotizar devuelve costo y
 *     profit; lo que ve el modelo pasa por lista blanca. Si se rompe, el asistente puede
 *     repetirle el margen a un cliente.
 *  3. Que los totales que cuenta sean LOS DEL MOTOR (se comparan con la ruta de cotizar
 *     directa, no con un número escrito acá).
 *  4. Que los permisos sean los de siempre: un usuario sin ver_dashboard no saca la
 *     venta por el asistente. Y cada uno ve solo sus conversaciones.
 *  5. Que sin clave y sin mock el asistente diga que no está configurado (503), no que
 *     reviente.
 *
 *   cd backend && node scripts/test-bot.js
 */
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3930;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_bot.db';
const TOKEN = 'token-test-bot-admin';
const TOKEN2 = 'token-test-bot-empleado';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production', BOT_MOCK: '1', ANTHROPIC_API_KEY: '' },
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

  // Un segundo usuario, empleado sin permisos, con su sesión.
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const run = (q, p = []) => new Promise((res, rej) => db.run(q, p, function (e) { e ? rej(e) : res(this); }));
  const get = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => (e ? rej(e) : res(r))));
  const all = (q, p = []) => new Promise((res, rej) => db.all(q, p, (e, r) => (e ? rej(e) : res(r))));
  await run("UPDATE usuarios SET rol = 'admin', ver_dashboard = 1, ver_salud = 1 WHERE id = 1");
  await run("INSERT OR IGNORE INTO usuarios (id, usuario, password_hash, rol, ver_dashboard) VALUES (2, 'empleado', 'x', 'empleado', 0)");
  await run('INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?,?,?)',
    [crypto.createHash('sha256').update(TOKEN2).digest('hex'), 2, new Date(Date.now() + 36e5).toISOString()]);
  await run("INSERT OR REPLACE INTO configuracion_nova (id, fuel_pct, fecha_actualizacion) VALUES (1, 30, datetime('now'))");

  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const H2 = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN2}` };
  const post = (ruta, body, h = H) => fetch(BASE + ruta, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const chat = async (texto, conversacion_id, h = H) => {
    const r = await post('/api/bot/mensaje', { texto, conversacion_id }, h);
    const j = await r.json();
    return { status: r.status, ...j };
  };
  const hoy = require('../src/utils/fecha').hoyLocal();

  // Datos: un cliente con dirección, dos envíos.
  const cli = await (await post('/api/clientes', {
    nombre: 'BOTERO S.A.', tarifa_pct: 60, tipo_cobro: 'CC', direccion_recoleccion: 'Av. Siempreviva 742, Bella Vista',
  })).json();
  const alta = async (extra) => (await post('/api/envios', {
    cliente_id: cli.id, fecha: hoy, courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion',
    pais_destino: 'Brasil', peso_real: 10, largo: 40, ancho: 30, alto: 30, fob: 100, total_cobrado: 250, ...extra,
  })).json();
  const e1 = await alta({ numero_guia: '1Z999AA10123456784' });
  const e2 = await alta({ numero_guia: '1Z999AA10123456785', total_cobrado: 180, peso_real: 5 });
  check('(fixture) los dos envíos existen', e1.id && e2.id, JSON.stringify([e1, e2]).slice(0, 200));

  // ── 1 ──────────────────────────────────────────────────────────────────────
  console.log('\n1. Estado y frenos básicos\n');
  const est = await (await fetch(BASE + '/api/bot/estado', { headers: H })).json();
  check('el estado dice que está en modo mock y disponible', est.mock === true && est.disponible === true, JSON.stringify(est));
  const sinSesion = await fetch(BASE + '/api/bot/estado');
  check('sin sesión no hay asistente (401)', sinSesion.status === 401, String(sinSesion.status));
  const vacio = await chat('   ');
  check('un mensaje vacío es 400', vacio.status === 400, String(vacio.status));
  // Sin clave y sin mock: el service lo dice sin reventar (se prueba el service directo).
  const bot = require('../src/services/bot.service');
  const guardado = { m: process.env.BOT_MOCK, k: process.env.ANTHROPIC_API_KEY };
  process.env.BOT_MOCK = ''; process.env.ANTHROPIC_API_KEY = '';
  const e503 = bot.estado();
  check('sin clave y sin mock el estado dice sin_clave y no disponible', e503.sin_clave === true && e503.disponible === false, JSON.stringify(e503));
  process.env.BOT_MOCK = guardado.m; process.env.ANTHROPIC_API_KEY = guardado.k;

  // ── 2 ──────────────────────────────────────────────────────────────────────
  console.log('\n2. Consultar una guía\n');
  const g = await chat('cómo viene la guía 1Z999AA10123456784?');
  check('contesta 200 y abre una conversación', g.status === 200 && g.conversacion_id > 0, JSON.stringify(g).slice(0, 200));
  check('usó buscar_envios', g.herramientas.includes('buscar_envios'), g.herramientas.join(','));
  check('el texto trae la guía, el cliente y el destino',
    /1Z999AA10123456784/.test(g.texto) && /BOTERO/.test(g.texto) && /Brasil/.test(g.texto), g.texto);
  check('   y dice que está sin liquidar', /sin liquidar/.test(g.texto), g.texto);
  const g2 = await chat('y la guía 1Z000000000000000?', g.conversacion_id);
  check('una guía que no existe: lo dice, no inventa', /no encontré/i.test(g2.texto), g2.texto);
  check('   en la MISMA conversación', g2.conversacion_id === g.conversacion_id);
  const porCliente = await chat('guía BOTERO');
  check('buscar por nombre de cliente trae los dos envíos', /2 envío/.test(porCliente.texto), porCliente.texto);

  // ── 3 ──────────────────────────────────────────────────────────────────────
  console.log('\n3. La venta del día\n');
  const v = await chat('cómo viene la venta de hoy');
  check('usó venta_periodo', v.herramientas.includes('venta_periodo'), v.herramientas.join(','));
  const ana = await (await fetch(`${BASE}/api/dashboard/analitica?periodo=rango&desde=${hoy}&hasta=${hoy}`, { headers: H })).json();
  const ventaEsperada = Math.round(Number(ana.kpis.venta) * 100) / 100;
  check('los envíos y la venta son los del dashboard (mismo período)',
    new RegExp(`${ana.kpis.envios} envíos`).test(v.texto) && v.texto.includes(`USD ${ventaEsperada}`),
    `dashboard: ${ana.kpis.envios} · ${ventaEsperada} | bot: ${v.texto}`);
  const vEmp = await chat('venta de hoy', null, H2);
  check('un empleado sin ver_dashboard NO saca la venta (mismo permiso que la pantalla)',
    vEmp.status === 200 && /venta_periodo/.test(vEmp.herramientas.join()) && !/envíos ·/.test(vEmp.texto) && /403|permiso|dashboard/i.test(vEmp.texto),
    vEmp.texto);

  // ── 4 ──────────────────────────────────────────────────────────────────────
  console.log('\n4. Cotizar: los totales del motor, sin el margen\n');
  const c = await chat(`cotizame 10 kg 40x30x30 a Brasil, cliente ${cli.id}, fob 100`);
  check('usó cotizar', c.herramientas.includes('cotizar'), c.herramientas.join(','));
  check('devuelve las tres opciones', /DHL Express/.test(c.texto) && /Expedited/.test(c.texto) && /Saver/.test(c.texto), c.texto);
  // Los mismos números que la ruta de cotizar, calculados por el motor.
  const directo = await (await post('/api/liquidaciones/cotizar', {
    servicio: 'UPS_EXP', tipo: 'export', pais: 'Brasil', pesoFacturable: 10, fob: 100, cliente_id: cli.id,
    bultos: [{ peso_real: 10, largo: 40, ancho: 30, alto: 30 }], contenido: 'paquete', fuenteFuel: 'nova',
  })).json();
  const totalDirecto = Math.round(Number(directo.precioFinal) * 100) / 100;
  check('el total de UPS Expedited es el del motor (ruta directa)', c.texto.includes(`USD ${totalDirecto}`), `motor ${totalDirecto} | bot: ${c.texto}`);
  check('   y el facturable es 10 kg (40×30×30 = 7,2 vol; gana el real)', /10 kg facturables/.test(c.texto), c.texto);
  // La lista blanca: lo que llega al modelo (el tool_result guardado) no trae costo ni profit.
  const filas = await all('SELECT contenido FROM bot_mensajes WHERE conversacion_id = ? ORDER BY id', [c.conversacion_id]);
  const toolResult = filas.map((f) => f.contenido).find((t) => /tool_result/.test(t) && /opciones/.test(t)) || '';
  check('lo que vio el modelo NO trae fleteBase, profitPct ni costo',
    toolResult && !/precioBase|profitMonto|utilidad|profit_aplicado|precio_kg|fleteBase/.test(toolResult), toolResult.slice(0, 300));
  check('   y el texto tampoco habla de profit ni de margen', !/profit|margen|costo/i.test(c.texto), c.texto);
  const sinCli = await chat('cotizame 10 kg a Brasil');
  check('sin cliente y sin % de ganancia lo pide, no cotiza con cualquier cosa',
    /ganancia|profit_pct/i.test(sinCli.texto) && !/Expedited/.test(sinCli.texto), sinCli.texto);
  const conPct = await chat('cotizame 10 kg a Brasil con 50 %');
  check('con ganancia manual cotiza', /Expedited/.test(conPct.texto), conPct.texto);

  // ── 5 ──────────────────────────────────────────────────────────────────────
  console.log('\n5. Los pendientes de la oficina\n');
  const p = await chat('qué pendientes hay');
  check('usó pendientes', p.herramientas.includes('pendientes'), p.herramientas.join(','));
  check('cuenta los pickups del día y lo que falta liquidar', /pickups 0/.test(p.texto) && /sin liquidar 2 envíos de 1 clientes/.test(p.texto), p.texto);

  // ── 6 ──────────────────────────────────────────────────────────────────────
  console.log('\n6. Cargar un pickup: NUNCA sin confirmar\n');
  const antes = (await get('SELECT COUNT(*) n FROM pickups')).n;
  const pr = await chat(`cargá un pickup para el cliente ${cli.id} mañana de 14 a 17`);
  check('propone y pregunta "¿lo cargo?"', pr.herramientas.includes('proponer_pickup') && /lo cargo/i.test(pr.texto), pr.texto);
  check('   usa la dirección de recolección del cliente', /Siempreviva/.test(pr.texto), pr.texto);
  check('   queda como pendiente en la conversación', pr.pendiente && pr.pendiente.tipo === 'pickup', JSON.stringify(pr.pendiente));
  check('   y NO grabó nada todavía', (await get('SELECT COUNT(*) n FROM pickups')).n === antes);
  const no = await chat('no, dejalo', pr.conversacion_id);
  check('"no" cancela la pendiente', no.herramientas.includes('cancelar_pendiente') && no.pendiente === null, no.texto);
  check('   y sigue sin grabar', (await get('SELECT COUNT(*) n FROM pickups')).n === antes);
  const siSuelto = await chat('sí', pr.conversacion_id);
  check('un "sí" sin propuesta pendiente NO carga nada', (await get('SELECT COUNT(*) n FROM pickups')).n === antes, siSuelto.texto);
  const pr2 = await chat(`pickup cliente ${cli.id} mañana de 9 a 12 en Calle Falsa 123`, pr.conversacion_id);
  check('vuelve a proponer con la dirección dicha', /Calle Falsa 123/.test(pr2.texto) && pr2.pendiente, pr2.texto);
  const si = await chat('sí, cargalo', pr.conversacion_id);
  check('"sí" confirma y graba', si.herramientas.includes('confirmar_pickup') && /cargado/i.test(si.texto), si.texto);
  const fila = await get('SELECT * FROM pickups ORDER BY id DESC LIMIT 1');
  check('   la fila tiene el cliente, la fecha de mañana y el horario',
    fila && fila.cliente_id === cli.id && fila.fecha === require('../src/utils/fecha').hoyLocalMas(1) && fila.hora_inicio === '09:00' && fila.hora_fin === '12:00',
    JSON.stringify(fila));
  check('   y en las notas queda quién lo pidió', /Cargado por el asistente a pedido de tester/.test(fila.notas || ''), fila.notas);
  check('   la pendiente se limpió', si.pendiente === null);
  const otraVez = await chat('sí', pr.conversacion_id);
  check('otro "sí" después no duplica el pickup', (await get('SELECT COUNT(*) n FROM pickups')).n === antes + 1, otraVez.texto);
  // Ahora el pendiente lo muestra
  const p2 = await chat(`pendientes de ${require('../src/utils/fecha').hoyLocalMas(1)}`);
  check('el pickup cargado aparece entre los pendientes de mañana', /pickups 1 \(1 sin confirmar\)/.test(p2.texto), p2.texto);

  // ── 7 ──────────────────────────────────────────────────────────────────────
  console.log('\n7. Conversaciones: cada uno ve las suyas\n');
  const lista = await (await fetch(BASE + '/api/bot/conversaciones', { headers: H })).json();
  check('el admin lista sus conversaciones con un título', Array.isArray(lista) && lista.length >= 5 && lista.every((x) => typeof x.titulo === 'string'), JSON.stringify(lista).slice(0, 200));
  const una = await (await fetch(`${BASE}/api/bot/conversaciones/${pr.conversacion_id}`, { headers: H })).json();
  check('una conversación trae sus mensajes solo con texto (sin bloques crudos)',
    una.mensajes.length >= 6 && una.mensajes.every((m) => typeof m.texto === 'string' && ['user', 'assistant'].includes(m.rol)), JSON.stringify(una).slice(0, 300));
  check('   los mensajes del asistente dicen qué herramienta usaron', una.mensajes.some((m) => m.rol === 'assistant' && m.herramientas.includes('confirmar_pickup')));
  const ajena = await fetch(`${BASE}/api/bot/conversaciones/${pr.conversacion_id}`, { headers: H2 });
  check('el empleado no ve la conversación del admin (404)', ajena.status === 404, String(ajena.status));
  const sigueAjena = await chat('hola', pr.conversacion_id, H2);
  check('   ni puede seguirla: le abre una propia', sigueAjena.conversacion_id !== pr.conversacion_id, String(sigueAjena.conversacion_id));

  await new Promise((res) => db.close(() => res()));
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
