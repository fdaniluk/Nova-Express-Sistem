#!/usr/bin/env node
/**
 * test-guias-datos.js — Guías, ETAPA 1: los datos y la proforma (08/09/2026, GUIAS-UPS.md).
 *
 * Lo que la oficina tipea hoy dos veces (en la página de UPS y en el Excel de la proforma)
 * pasa a guardarse una vez:
 *   · remitente completo en el cliente (teléfono y provincia, además de lo que ya había);
 *   · libreta de destinatarios por cliente (/api/clientes/:id/destinatarios);
 *   · contenido, destinatario y renglones de la proforma en el envío (items);
 *   · la proforma sale del sistema: JSON y hoja A4 para imprimir.
 *
 *   cd backend && node scripts/test-guias-datos.js
 */

const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3935;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_guias_datos.db';
const TOKEN = 'token-test-guias-datos';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}

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
  const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
  const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: H, body: JSON.stringify(b) });
  const put = (u, b) => fetch(BASE + u, { method: 'PUT', headers: H, body: JSON.stringify(b) });
  const get = (u) => fetch(BASE + u, { headers: H });
  const del = (u) => fetch(BASE + u, { method: 'DELETE', headers: H });

  console.log('\n1. El cliente guarda el remitente completo (teléfono y provincia)\n');
  const cli = await j(await post('/api/clientes', {
    nombre: 'ZAPPALA TEST SRL', tarifa_pct: 70, cuit: '30-11111111-9',
    direccion_recoleccion: 'Av. Prueba 123', codigo_postal: '1661', localidad: 'Bella Vista',
    provincia: 'Buenos Aires', telefono: '+54 11 4000-0000', contacto: 'Ana', email: 'ana@zappala.test',
  }));
  check('POST /clientes acepta telefono y provincia', cli.telefono === '+54 11 4000-0000' && cli.provincia === 'Buenos Aires', JSON.stringify(cli).slice(0, 200));
  const cli2 = await j(await put(`/api/clientes/${cli.id}`, { telefono: '+54 11 4999-9999' }));
  check('PUT /clientes cambia el teléfono y respeta la provincia', cli2.telefono === '+54 11 4999-9999' && cli2.provincia === 'Buenos Aires');

  console.log('\n2. Libreta de destinatarios por cliente\n');
  let r = await post(`/api/clientes/${cli.id}/destinatarios`, { nombre: '', pais: 'Reino Unido' });
  check('sin nombre → 400', r.status === 400, String(r.status));
  r = await post(`/api/clientes/${cli.id}/destinatarios`, { nombre: 'ACME LTD' });
  check('sin país → 400', r.status === 400, String(r.status));
  r = await post('/api/clientes/999999/destinatarios', { nombre: 'X', pais: 'Y' });
  check('cliente inexistente → 404', r.status === 404, String(r.status));

  r = await post(`/api/clientes/${cli.id}/destinatarios`, {
    nombre: 'ACME LTD', contacto: 'John Smith', direccion1: '10 Downing St', direccion2: 'Floor 2',
    codigo_postal: 'SW1A 2AA', ciudad: 'London', pais: 'Reino Unido', telefono: '+44 20 7000 0000',
    email: 'john@acme.test', tax_id: 'GB123456789',
  });
  const d1 = await j(r);
  check('alta de destinatario → 201 con id', r.status === 201 && d1.id > 0, JSON.stringify(d1).slice(0, 200));
  check('  guarda el tax id en su propio campo', d1.tax_id === 'GB123456789');
  const d2 = await j(await post(`/api/clientes/${cli.id}/destinatarios`, { nombre: 'BETA INC', pais: 'USA', ciudad: 'Miami', estado: 'FL', codigo_postal: '33126' }));
  check('segundo destinatario', d2.id > d1.id);

  let lista = await j(await get(`/api/clientes/${cli.id}/destinatarios`));
  check('GET lista los dos, por nombre', lista.length === 2 && lista[0].nombre === 'ACME LTD', JSON.stringify(lista.map((x) => x.nombre)));

  const d1b = await j(await put(`/api/clientes/${cli.id}/destinatarios/${d1.id}`, { telefono: '+44 20 7111 1111' }));
  check('PUT parcial cambia el teléfono y conserva el resto', d1b.telefono === '+44 20 7111 1111' && d1b.direccion1 === '10 Downing St');
  r = await put(`/api/clientes/${cli.id}/destinatarios/${d1.id}`, { nombre: '' });
  check('PUT con nombre vacío → 400', r.status === 400, String(r.status));

  // Otro cliente no ve ni toca la libreta de este.
  const otro = await j(await post('/api/clientes', { nombre: 'OTRO CLIENTE', tarifa_pct: 70 }));
  const listaOtro = await j(await get(`/api/clientes/${otro.id}/destinatarios`));
  check('otro cliente tiene la libreta vacía', Array.isArray(listaOtro) && listaOtro.length === 0);
  r = await put(`/api/clientes/${otro.id}/destinatarios/${d1.id}`, { nombre: 'HACK' });
  check('otro cliente no puede editar un destinatario ajeno → 404', r.status === 404, String(r.status));

  console.log('\n3. El envío guarda destinatario, contenido y renglones de la proforma\n');
  r = await post('/api/envios', {
    cliente_id: cli.id, fecha: '2026-09-08', courier: 'UPS', tipo_envio: 'exportacion', servicio_ups: 'UPS_SAV',
    numero_guia: '1ZGUIASDATOS0001', pais_destino: 'Reino Unido', fob: 350, total_cobrado: 0,
    bultos: [{ peso_real: 4, largo: 30, ancho: 20, alto: 20 }],
    destinatario_id: d1.id, contenido: 'Cueros curtidos',
    items: [
      { cantidad: 2, descripcion: 'Leather hides', valor_unitario: 100 },
      { cantidad: 3, descripcion: 'Leather samples', valor_unitario: 50 },
      { cantidad: 1, descripcion: '   ', valor_unitario: 999 },   // renglón vacío: se descarta
    ],
  });
  const env = await j(r);
  check('POST /envios → 201', r.status === 201, JSON.stringify(env).slice(0, 200));
  check('  devuelve destinatario_id y contenido', env.destinatario_id === d1.id && env.contenido === 'Cueros curtidos');
  check('  devuelve el destinatario completo', env.destinatario && env.destinatario.nombre === 'ACME LTD');
  check('  devuelve 2 renglones (el vacío se descarta)', Array.isArray(env.items) && env.items.length === 2, JSON.stringify(env.items));
  check('  el costo del envío se calculó igual que siempre', Number(env.flete) > 0 && Number(env.peso_facturable) > 0, `flete ${env.flete} pf ${env.peso_facturable}`);

  lista = await j(await get(`/api/clientes/${cli.id}/destinatarios`));
  check('el destinatario usado pasa primero en la libreta (ultimo_uso)', lista[0].id === d1.id && lista[0].ultimo_uso, JSON.stringify(lista.map((x) => [x.nombre, x.ultimo_uso])));

  const env2 = await j(await put(`/api/envios/${env.id}`, { observaciones: 'nota', items: [{ cantidad: 5, descripcion: 'Leather hides', valor_unitario: 80 }] }));
  check('PUT con items reemplaza los renglones', env2.items.length === 1 && Number(env2.items[0].cantidad) === 5, JSON.stringify(env2.items));
  check('  y conserva destinatario y contenido', env2.destinatario_id === d1.id && env2.contenido === 'Cueros curtidos');
  check('  sin recalcular el costo (no cambió nada que lo mueva)', Number(env2.flete) === Number(env.flete));
  const env3 = await j(await put(`/api/envios/${env.id}`, { destinatario_id: d2.id, proforma_numero: '79122210' }));
  check('PUT cambia el destinatario y pone el Nº de proforma', env3.destinatario.nombre === 'BETA INC' && env3.proforma_numero === '79122210');
  const env4 = await j(await put(`/api/envios/${env.id}`, { destinatario_id: d1.id }));
  check('PUT sin items no toca los renglones', env4.items.length === 1);

  console.log('\n4. La proforma (JSON y hoja para imprimir)\n');
  const p = await j(await get(`/api/envios/${env.id}/proforma`));
  check('GET /envios/:id/proforma → shipper con el cliente', p.shipper.nombre === 'ZAPPALA TEST SRL' && p.shipper.cuit === '30-11111111-9' && p.shipper.provincia === 'Buenos Aires', JSON.stringify(p.shipper));
  check('  consignee con el destinatario', p.consignee.nombre === 'ACME LTD' && p.consignee.direccion === '10 Downing St, Floor 2' && p.consignee.pais === 'Reino Unido', JSON.stringify(p.consignee));
  check('  Nº y fecha', p.numero === '79122210' && p.fecha_texto === '08/09/2026', `${p.numero} ${p.fecha_texto}`);
  check('  renglones con total = cantidad × unitario', p.renglones.length === 1 && p.renglones[0].total === 400, JSON.stringify(p.renglones));
  check('  TOTAL USD', p.total === 400, String(p.total));
  check('  origen ARGENTINA y manufacturer = shipper', p.pais_origen === 'ARGENTINA' && p.manufacturer.cuit === '30-11111111-9');

  r = await get(`/api/envios/${env.id}/proforma.html`);
  const html = await r.text();
  check('GET /envios/:id/proforma.html → HTML', r.status === 200 && /text\/html/.test(r.headers.get('content-type')), r.headers.get('content-type'));
  check('  dice COMMERCIAL INVOICE', /COMMERCIAL INVOICE/.test(html));
  check('  con shipper, consignee y renglones', /ZAPPALA TEST SRL/.test(html) && /ACME LTD/.test(html) && /Leather hides/.test(html) && /400\.00/.test(html));
  check('  COUNTRY OF ORIGIN: ARGENTINA', /COUNTRY OF ORIGIN: ARGENTINA/.test(html));
  check('  sin avisos (tiene destinatario y renglones)', !/class="avisos"/.test(html));
  check('  escapa HTML', !/<script/.test(html));

  // Envío sin destinatario ni renglones: la proforma igual sale (un renglón con el FOB).
  const envPelado = await j(await post('/api/envios', {
    cliente_id: cli.id, fecha: '2026-09-08', courier: 'DHL', tipo_envio: 'exportacion',
    numero_guia: '1234567890', pais_destino: 'Alemania', fob: 120, total_cobrado: 0,
    bultos: [{ peso_real: 1, largo: 10, ancho: 10, alto: 10 }], contenido: 'Muestras de cuero',
  }));
  const p2 = await j(await get(`/api/envios/${envPelado.id}/proforma`));
  check('envío sin renglones → un renglón con el contenido y el FOB', p2.renglones.length === 1 && p2.renglones[0].descripcion === 'Muestras de cuero' && p2.total === 120, JSON.stringify(p2.renglones));
  check('  país del destino aunque no haya destinatario', p2.consignee.pais === 'Alemania' && p2.sin_destinatario === true, JSON.stringify(p2.consignee));
  const html2 = await (await get(`/api/envios/${envPelado.id}/proforma.html`)).text();
  check('  la hoja avisa que faltan destinatario y renglones', /class="avisos"/.test(html2) && /no tiene destinatario/.test(html2));
  r = await get('/api/envios/999999/proforma');
  check('envío inexistente → 404', r.status === 404, String(r.status));

  console.log('\n5. Borrado en blando de la libreta\n');
  r = await del(`/api/clientes/${cli.id}/destinatarios/${d2.id}`);
  check('DELETE → ok', r.status === 200);
  lista = await j(await get(`/api/clientes/${cli.id}/destinatarios`));
  check('  ya no aparece en la lista', lista.length === 1 && lista[0].id === d1.id);
  lista = await j(await get(`/api/clientes/${cli.id}/destinatarios?todos=1`));
  check('  pero sigue con ?todos=1 (activo=0)', lista.length === 2 && lista.find((x) => x.id === d2.id).activo === 0);
  const env5 = await j(await get(`/api/envios/${env.id}`));
  check('  y el envío que lo tenía sigue viéndolo', env5.destinatario_id === d1.id && env5.destinatario);

  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
