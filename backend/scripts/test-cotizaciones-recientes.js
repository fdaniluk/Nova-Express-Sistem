#!/usr/bin/env node
/**
 * test-cotizaciones-recientes.js — el panel de "qué se le cotizó a este cliente".
 *
 * QUÉ ES (idea de Felipe, 25/08/2026)
 * La lista de cotizaciones guardadas vivía abajo del cotizador y ahí no le servía a nadie:
 * *"pocas veces uno va a volver al perfil del cliente para ver una cotización"*. El momento
 * en que hace falta es cuando administración está CARGANDO EL ENVÍO: con el destino, el
 * peso y las medidas a la vista, reconoce cuál es este envío y se lleva el precio.
 *
 * QUÉ SE PRUEBA, en orden de riesgo:
 *
 *  1. QUE SIN TILDAR NO APAREZCA. La tilde arranca apagada a propósito: el cotizador se
 *     usa para tantear y un historial lleno de tanteos no deja reconocer nada. Si el
 *     default se diera vuelta, el panel se llenaría de basura y nadie lo miraría más.
 *  2. QUE NO SE ESCAPE NUESTRO COSTO. El panel manda lo justo para reconocer el envío.
 *     `entrada` lleva la ganancia aplicada y `opciones` el costo: ninguna de las dos puede
 *     viajar entera. Es la misma regla que sostiene la lista y el link del cliente.
 *  3. QUE LA VENTANA DE 30 DÍAS CORTE BIEN, y que sean días CORRIDOS y no mes calendario
 *     (pedido textual). Una cotización de hace 40 días no puede aparecer.
 *  4. QUE NO SE MEZCLEN LOS CLIENTES. Traerle a la oficina el precio de otro cliente es
 *     el peor error posible de esta pantalla.
 *  5. Que venga lo que hace falta para reconocer el envío: destino, zona, peso, medidas
 *     de los bultos, y el precio de cada servicio.
 *
 *   cd backend && npm run test-cotizaciones-recientes     (EN POWERSHELL, no en el servidor)
 */

const { spawn } = require('child_process');
const path = require('path');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3955;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_ctz_recientes.db';
const TOKEN = 'token-test-ctz-recientes';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
let matarServidor = () => {};
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else {
    fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`);
  }
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

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));

  await run("INSERT INTO clientes (id, nombre, tipo_cobro, tarifa_pct, activo) VALUES (970, 'CTZR UNO', 'CC', 70, 1)");
  await run("INSERT INTO clientes (id, nombre, tipo_cobro, tarifa_pct, activo) VALUES (971, 'CTZR DOS', 'CC', 70, 1)");

  /* Una cotización como la que manda el cotizador: dos servicios, un bulto con medidas,
     y adentro de `entrada` la ganancia aplicada (que es lo que NO puede salir). */
  const cotizar = async (clienteId, extra = {}) => {
    const r = await fetch(`${BASE}/api/cotizaciones`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        cliente_id: clienteId,
        pais: 'Estados Unidos', tipo_envio: 'exportacion', contenido: 'paquete',
        zona: '2', peso_facturable: 8, cantidad_bultos: 1, valor_declarado: 1000,
        entrada: {
          bultos: [{ pr: 4, l: 40, a: 30, al: 32, pv: 7.7, pf: 8 }],
          ganancia_pct: 137, fuel_fuente: 'nova',
        },
        opciones: [
          { servicio: 'UPS Worldwide Expedited', total: 198.44, pf: 8, zona: 2, costo: 83.11 },
          { servicio: 'DHL', total: 210.00, pf: 8, zona: 2, costo: 90.00 },
        ],
        ...extra,
      }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const recientes = async (clienteId, query = '') => {
    const r = await fetch(`${BASE}/api/cotizaciones/cliente/${clienteId}/recientes${query}`, { headers: H });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // ── 1. La tilde ─────────────────────────────────────────────────────────────────────
  console.log('\n1. Sin tildar no entra al historial del cliente\n');

  const sinTilde = await cotizar(970);
  check('la cotización sin tilde se guarda igual', sinTilde.status === 201,
    JSON.stringify(sinTilde.body).slice(0, 120));
  check('pero NO aparece en el panel del cliente', (await recientes(970)).body.length === 0);
  check('y en la lista general sigue estando (no se perdió)',
    (await (await fetch(`${BASE}/api/cotizaciones?cliente_id=970`, { headers: H })).json()).length === 1);

  const conTilde = await cotizar(970, { viaja_al_cliente: 1 });
  check('la tildada se guarda', conTilde.status === 201);
  const lista = (await recientes(970)).body;
  check('y ahora sí aparece en el panel', lista.length === 1, `vinieron ${lista.length}`);
  check('es la que corresponde', lista[0].numero === conTilde.body.numero);

  // ── 2. Lo que NO puede salir ────────────────────────────────────────────────────────
  console.log('\n2. El panel no manda nuestro costo ni la ganancia\n');

  const crudo = JSON.stringify(lista);
  check('🔴 no viaja el costo de ninguna opción', !/"costo"/.test(crudo),
    (crudo.match(/.{0,40}costo.{0,40}/) || [''])[0]);
  check('🔴 no viaja la ganancia aplicada', !/ganancia_pct|137/.test(crudo),
    (crudo.match(/.{0,40}(ganancia_pct|137).{0,40}/) || [''])[0]);
  check('no viaja `entrada` entera', lista[0].entrada === undefined);
  check('ni `opciones` entera', lista[0].opciones === undefined);

  // ── 3. Los 30 días corridos ─────────────────────────────────────────────────────────
  console.log('\n3. La ventana son días corridos, no mes calendario\n');

  const vieja = await cotizar(970, { viaja_al_cliente: 1 });
  await run("UPDATE cotizaciones SET creado_en = datetime('now','localtime','-40 days') WHERE id = ?",
    [vieja.body.id]);
  const media = await cotizar(970, { viaja_al_cliente: 1 });
  await run("UPDATE cotizaciones SET creado_en = datetime('now','localtime','-10 days') WHERE id = ?",
    [media.body.id]);

  const treinta = (await recientes(970)).body.map((x) => x.numero);
  check('la de hace 40 días queda afuera', !treinta.includes(vieja.body.numero), JSON.stringify(treinta));
  check('la de hace 10 días entra', treinta.includes(media.body.numero), JSON.stringify(treinta));
  check('vienen las 2 que corresponden', treinta.length === 2, `vinieron ${treinta.length}`);

  const noventa = (await recientes(970, '?dias=90')).body.map((x) => x.numero);
  check('pidiendo 90 días aparece también la vieja', noventa.includes(vieja.body.numero),
    JSON.stringify(noventa));
  check('y vienen ordenadas de la más nueva a la más vieja',
    (await recientes(970, '?dias=90')).body
      .every((x, i, arr) => i === 0 || arr[i - 1].creado_en >= x.creado_en));

  // ── 4. Los clientes no se mezclan ───────────────────────────────────────────────────
  console.log('\n4. Nunca el precio de otro cliente\n');

  const otro = await cotizar(971, { viaja_al_cliente: 1 });
  const delDos = (await recientes(971)).body;
  check('el cliente 971 ve la suya', delDos.length === 1 && delDos[0].numero === otro.body.numero);
  check('🔴 y NO ve ninguna del 970',
    !delDos.some((x) => x.numero === conTilde.body.numero), JSON.stringify(delDos.map((x) => x.numero)));
  check('el 970 tampoco ve la del 971',
    !(await recientes(970)).body.some((x) => x.numero === otro.body.numero));

  // ── 5. Lo que sirve para reconocer el envío ─────────────────────────────────────────
  console.log('\n5. Trae lo que hace falta para reconocer el envío\n');

  const f = (await recientes(970)).body.find((x) => x.numero === conTilde.body.numero);
  check('el destino', f.pais === 'Estados Unidos');
  check('la zona', String(f.zona) === '2');
  check('el peso facturable', Number(f.peso_facturable) === 8);
  check('el valor declarado', Number(f.valor_declarado) === 1000);
  check('las medidas del bulto', Array.isArray(f.bultos) && f.bultos.length === 1
    && f.bultos[0].l === 40 && f.bultos[0].a === 30 && f.bultos[0].al === 32,
    JSON.stringify(f.bultos));
  check('el precio de cada servicio', Array.isArray(f.opciones_resumen)
    && f.opciones_resumen.length === 2
    && f.opciones_resumen.some((o) => o.total === 198.44)
    && f.opciones_resumen.some((o) => o.total === 210),
    JSON.stringify(f.opciones_resumen));
  check('y el estado, para distinguir una aceptada de una emitida', f.estado === 'emitida');

  // ── 6. La marca es POR OPCIÓN ───────────────────────────────────────────────────────
  /* Pedido de Felipe (26/08): *"si yo lo pongo en el general, me va a guardar tres
     cotizaciones innecesariamente"*. Se cotiza DHL + UPS rápido + UPS lento y al cliente
     se le pasa UNA. La cotización se guarda entera (es el respaldo), pero al panel sube
     solo lo tildado. */
  console.log('\n6. La tilde es por opción, no por cotización entera\n');

  const unaSola = await cotizar(970, {
    opciones: [
      { servicio: 'UPS Worldwide Expedited', total: 111.11, pf: 8, zona: 2, costo: 50, viaja: 1 },
      { servicio: 'UPS Worldwide Saver', total: 122.22, pf: 8, zona: 2, costo: 55, viaja: 0 },
      { servicio: 'DHL', total: 133.33, pf: 8, zona: 2, costo: 60, viaja: 0 },
    ],
  });
  const fUna = (await recientes(970)).body.find((x) => x.numero === unaSola.body.numero);
  check('la cotización aparece en el panel', !!fUna);
  check('🔴 y trae UNA sola opción, la tildada',
    fUna && fUna.opciones_resumen.length === 1 && fUna.opciones_resumen[0].total === 111.11,
    JSON.stringify(fUna && fUna.opciones_resumen));

  const guardadaEntera = await (await fetch(`${BASE}/api/cotizaciones/${unaSola.body.id}`, { headers: H })).json();
  const opsGuardadas = JSON.parse(guardadaEntera.opciones);
  check('pero por dentro se guardaron las TRES (es el respaldo de lo que se mandó)',
    opsGuardadas.length === 3, `quedaron ${opsGuardadas.length}`);
  check('y cada una con su marca', opsGuardadas.filter((o) => o.viaja).length === 1);

  const ninguna = await cotizar(970, {
    opciones: [
      { servicio: 'DHL', total: 144.44, pf: 8, zona: 2, costo: 60, viaja: 0 },
      { servicio: 'UPS Worldwide Saver', total: 155.55, pf: 8, zona: 2, costo: 65, viaja: 0 },
    ],
  });
  check('sin ninguna opción tildada, la cotización NO ensucia el panel',
    !(await recientes(970)).body.some((x) => x.numero === ninguna.body.numero));
  check('aunque se guardó igual', (await (await fetch(
    `${BASE}/api/cotizaciones/${ninguna.body.id}`, { headers: H })).json()).numero === ninguna.body.numero);

  // ── 7. Bordes ───────────────────────────────────────────────────────────────────────
  console.log('\n7. Parámetros inválidos\n');

  check('dias con texto da 400', (await recientes(970, '?dias=hola')).status === 400);
  check('dias en cero da 400', (await recientes(970, '?dias=0')).status === 400);
  check('un cliente que no existe devuelve lista vacía, no error',
    (await recientes(99999)).status === 200 && (await recientes(99999)).body.length === 0);

  await new Promise((res) => db.close(() => res()));
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
