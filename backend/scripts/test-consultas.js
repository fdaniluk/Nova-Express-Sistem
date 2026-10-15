#!/usr/bin/env node
// Consultas de la publicidad (14/10/2026): un teléfono sin vínculo que escribe por WhatsApp
// va al filtro (audiencia 'prospecto'): el bot pregunta, anota, y deriva o cierra. Derivada
// → el bot se calla y la oficina contesta desde la pantalla. Con BOT_MOCK=1: prueba el
// circuito, no cuán bien entiende el modelo.
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const PORT = process.env.PORT_TEST || 3986;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_consultas.db';
const TOKEN = 'token-test-consultas';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production', BOT_MOCK: '1', ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let lo = '', le = ''; srv.stdout.on('data', (d) => { lo += d; }); srv.stderr.on('data', (d) => { le += d; });
  const matar = () => { try { srv.kill(); } catch {} };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => le, () => lo);
  await abrirSesion(DB, TOKEN);
  const J = (m, u, b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const sim = (tel, texto, nombre) => J('POST', '/api/consultas/simular', { telefono: tel, texto, nombre });

  console.log('\n1. Una consulta que vale\n');
  let r = await sim('5491155550001', 'Hola', 'Marta');
  check('un teléfono sin vínculo NO recibe "no te tengo vinculado": lo atiende el filtro', r.status === 200 && r.body.prospecto === true && !/vinculad/.test(r.body.respuesta), JSON.stringify(r.body));
  check('la consulta se crea en estado bot', r.body.estado === 'bot' && r.body.consulta_id > 0);
  const id1 = r.body.consulta_id;
  r = await sim('5491155550001', 'Quiero mandar muestras de cuero');
  check('anota qué manda y pregunta lo siguiente', (r.body.herramientas || []).includes('anotar_consulta') && /país|pais|dónde|donde/i.test(r.body.respuesta), JSON.stringify(r.body));
  r = await sim('5491155550001', 'A Italia');
  r = await sim('5491155550001', 'Unos 8 kilos');
  r = await sim('5491155550001', 'Somos una empresa, mandamos seguido');
  check('con los datos completos la deriva y se despide nombrando a Felipe', r.body.estado === 'derivada' && /Felipe/.test(r.body.respuesta), JSON.stringify(r.body));
  let c = (await J('GET', `/api/consultas/${id1}`)).body;
  check('la consulta guarda los datos anotados (qué, destino, peso, tipo)', c.datos.que_envia && /Italia/.test(c.datos.destino) && c.datos.peso && c.datos.tipo === 'empresa', JSON.stringify(c.datos));
  check('con resumen y motivo para Felipe', c.resumen && c.motivo, JSON.stringify([c.resumen, c.motivo]));
  check('y el hilo entero visible (persona y bot)', c.mensajes.length >= 8 && c.mensajes[0].rol === 'user' && c.mensajes.some((m) => m.rol === 'assistant'), String(c.mensajes.length));
  r = await sim('5491155550001', '¿Y cuánto sale?');
  check('derivada: el bot se CALLA (no contesta) y el mensaje queda en el hilo', r.body.silencio === true && r.body.respuesta === '', JSON.stringify(r.body));
  c = (await J('GET', `/api/consultas/${id1}`)).body;
  check('el mensaje nuevo está en el hilo y la lectura lo marca leído', c.mensajes[c.mensajes.length - 1].texto === '¿Y cuánto sale?' && c.no_leidos === 0);
  r = await J('POST', `/api/consultas/${id1}/responder`, { texto: 'Hola Marta, soy Felipe. Te paso el valor en un rato.' });
  check('la oficina responde desde la pantalla: queda en el hilo y pasa a atendida', r.status === 200 && (await J('GET', `/api/consultas/${id1}`)).body.estado === 'atendida', JSON.stringify(r.body));
  c = (await J('GET', `/api/consultas/${id1}`)).body;
  check('la respuesta humana se distingue del bot', c.mensajes[c.mensajes.length - 1].rol === 'assistant' && c.mensajes[c.mensajes.length - 1].humano, JSON.stringify(c.mensajes[c.mensajes.length - 1]));
  r = await sim('5491155550001', 'Dale, gracias');
  check('atendida: el bot sigue callado', r.body.silencio === true);

  console.log('\n2. Una que no es para Nova\n');
  r = await sim('5491155550002', 'Hola, quiero traer una compra de Amazon');
  check('la cierra con amabilidad', r.body.estado === 'cerrada' && (r.body.herramientas || []).includes('cerrar_consulta') && r.body.respuesta.length > 10, JSON.stringify(r.body));
  r = await sim('5491155550002', '¿Seguro?');
  check('cerrada hace poco: no vuelve a arrancar el bot', r.body.silencio === true);

  console.log('\n3. Pide una persona\n');
  r = await sim('5491155550003', 'Quiero hablar con alguien');
  check('pedir hablar con alguien deriva', r.body.estado === 'derivada');

  console.log('\n4. Lista, resumen, estados y reglas\n');
  const lista = (await J('GET', '/api/consultas')).body;
  check('la lista trae las 3', lista.length === 3 && lista.every((x) => x.telefono && x.estado));
  const der = (await J('GET', '/api/consultas?estado=derivada')).body;
  check('filtra por estado', der.length === 1 && der[0].telefono === '5491155550003');
  const res = (await J('GET', '/api/consultas/resumen')).body;
  check('resumen: 1 derivada', res.derivadas === 1, JSON.stringify(res));
  r = await J('POST', `/api/consultas/${id1}/estado`, { estado: 'bot' });
  check('"devolver al bot" vuelve a estado bot', r.body.estado === 'bot');
  r = await sim('5491155550001', 'Perdón, ¿me cotizás?');
  check('y el bot vuelve a contestar', r.body.silencio !== true && r.body.respuesta.length > 0, JSON.stringify(r.body));
  r = await J('POST', `/api/consultas/${id1}/estado`, { estado: 'cerrada', motivo: 'no contestó' });
  check('cerrar a mano guarda el motivo', r.body.estado === 'cerrada' && r.body.motivo === 'no contestó');
  const reg = (await J('GET', '/api/consultas/reglas')).body;
  check('las reglas arrancan con el texto por defecto', reg.texto === reg.por_defecto && /derivar/i.test(reg.texto));
  r = await J('PUT', '/api/consultas/reglas', { texto: 'VALE: todo lo que sea exportación de vinos.' });
  check('se pueden cambiar', r.status === 200 && (await J('GET', '/api/consultas/reglas')).body.texto === 'VALE: todo lo que sea exportación de vinos.');
  const consultas = require('../src/services/consultas.service');
  const prompt = consultas.systemPrompt({ datos: { que_envia: 'vino' } }, 'VALE: todo lo que sea exportación de vinos.');
  check('el prompt del filtro lleva las reglas y lo que ya se sabe, y prohíbe precios', /exportación de vinos/.test(prompt) && /que_envia: vino/.test(prompt) && /PROHIBIDO: dar precios/.test(prompt));

  console.log('\n5. Seguridad\n');
  const bot = require('../src/services/bot.service');
  const defs = bot.definicionesPara('prospecto').map((d) => d.name);
  check('el prospecto solo ve sus 3 herramientas (nada de envíos, venta ni cotizar)', defs.length === 3 && defs.every((n) => /consulta/.test(n)), defs.join(','));
  check('el simulador del Asistente (sin pedir prospecto) sigue pidiendo vínculo', /vinculad/.test(((await J('POST', '/api/bot/simular', { texto: 'hola' })).body || {}).respuesta || ''));
  r = await sim('12', 'hola');
  check('teléfono inválido → 400', r.status === 400);

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  matar();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 1000).unref();
})().catch((e) => { console.error('✗', e); process.exit(1); });
