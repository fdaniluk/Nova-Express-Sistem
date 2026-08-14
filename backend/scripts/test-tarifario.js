#!/usr/bin/env node
/**
 * test-tarifario.js — el tarifario que se le manda AL CLIENTE.
 *
 * QUÉ ES
 * Desde el perfil del cliente se arma una grilla de precios de venta por peso y destino
 * para mandarle al cliente (`services/tarifario.service.js`). Es la cara del sistema hacia
 * afuera: un número mal puesto acá se le promete por escrito a alguien que no es de la casa.
 *
 * QUÉ SE PRUEBA, en orden de riesgo:
 *
 *  1. QUE LA CELDA SEA LO QUE EL SISTEMA VA A COBRAR. Cada precio se compara, celda por
 *     celda, contra el motor llamado a mano para ese peso, esa zona y ese servicio. Si el
 *     tarifario se separa del motor, el cliente paga un número y el papel dice otro.
 *  2. QUE NO SE ESCAPE UN COSTO NI UN MARGEN. El JSON no puede traer profit, flete de
 *     costo ni precio por kilo rotulado: la oficina manda este archivo por WhatsApp.
 *  3. QUE EL PRECIO POR KILO CARGADO GANE (la regla del 13/08), también acá.
 *  4. QUE LA MEMORIA POR TRAMOS NO CAMBIE NINGÚN NÚMERO. El servicio agrupa las consultas
 *     por intervalo entre cortes para no tardar diez segundos; si esa agrupación se comiera
 *     un corte —sobre todo los de las filas viejas de rango libre, tipo 20-32— el tarifario
 *     mostraría el precio del tramo de al lado.
 *  5. QUE LAS ZONAS DEL COMBINADO NO MIENTAN. DHL y UPS zonifican distinto: EE.UU. es zona
 *     3 en DHL y 2 en UPS. Una columna que mezcle las dos sin traducir no significa nada.
 *  6. Que el rango y el paso salgan como se pidieron, y que un rango absurdo se rechace.
 *  7. Que el Excel salga.
 *
 *   cd backend && npm run test-tarifario     (EN POWERSHELL, no en el servidor)
 */

const { spawn } = require('child_process');
const path = require('path');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const { cotizarServicio } = require('../../shared/cotizador/cotizador-core');

const PORT = process.env.PORT_TEST || 3991;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_tarifario.db';
const TOKEN = 'token-test-tarifario';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
// El servidor de prueba queda vivo si el test se corta por un error, y entonces el proceso
// nunca termina y la tanda se cuelga. Se guarda acá para poder matarlo desde el catch.
let matarServidor = () => {};
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else {
    fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`);
  }
}

const PCT = 70;          // cliente por porcentaje
const CLI_PCT = 901;
const CLI_KG = 902;      // cliente con precio por kilo y un corte raro, tipo PIO

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
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

  await run("INSERT INTO clientes (id, nombre, tipo_cobro, tarifa_pct, activo) VALUES (?,?,?,?,1)",
    [CLI_PCT, 'TARIFARIO PORCENTAJE', 'CC', PCT]);
  await run("INSERT INTO clientes (id, nombre, tipo_cobro, tarifa_pct, activo) VALUES (?,?,?,?,1)",
    [CLI_KG, 'TARIFARIO POR KILO', 'CC', 50]);

  // El caso PIO: tramos propios con un corte comercial en 32 kg y precios por kilo cargados
  // sobre ellos. Es el que rompe una memoria mal hecha.
  for (const [min, max] of [[0, 20], [20, 32], [32, null]]) {
    await run('INSERT INTO cliente_tramos (cliente_id, peso_min, peso_max) VALUES (?,?,?)', [CLI_KG, min, max]);
  }
  await run("INSERT INTO tarifa_kg_overrides (cliente_id, servicio, tipo, zona, peso_min, peso_max, precio_kg) VALUES (?,?,?,?,?,?,?)",
    [CLI_KG, 'DHL', 'export', null, 20, 32, 7.02]);
  await run("INSERT INTO tarifa_kg_overrides (cliente_id, servicio, tipo, zona, peso_min, peso_max, precio_kg) VALUES (?,?,?,?,?,?,?)",
    [CLI_KG, 'DHL', 'export', null, 32, null, 4.86]);

  const J = async (u) => {
    const r = await fetch(BASE + u, { headers: H });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // ── 1. La celda es exactamente lo que cotiza el motor ────────────────────────────────
  console.log('\n1. Cada celda es lo que el sistema va a cobrar\n');

  const t1 = await J(`/api/clientes/${CLI_PCT}/tarifario?servicios=DHL&desde=0.5&hasta=12&documentos=0`);
  check('el tarifario responde', t1.status === 200, JSON.stringify(t1.body).slice(0, 120));
  const paquetes = (t1.body.tablas || []).find((t) => t.titulo.startsWith('Paquetes'));
  check('trae la tabla de paquetes', Boolean(paquetes));

  let diferencias = 0; let ejemplo = '';
  for (const fila of paquetes.filas) {
    for (let z = 1; z <= 6; z += 1) {
      const esperado = cotizarServicio('DHL', {
        tipo: 'export', pf: fila.peso, zonaOverride: z,
        fuelPct: 0, fob: 0, bultosProc: [], profitPct: PCT, contenido: 'paquete',
      });
      const dio = fila.precios[z - 1];
      const debe = Math.round(esperado.conGan * 100) / 100;
      if (Math.abs(dio - debe) > 0.005) {
        diferencias += 1;
        if (!ejemplo) ejemplo = `${fila.peso} kg zona ${z}: tarifario ${dio} vs motor ${debe}`;
      }
    }
  }
  check(`las ${paquetes.filas.length * 6} celdas coinciden con el motor, una por una`,
    diferencias === 0, ejemplo);

  // ── 2. Ni costos ni márgenes ─────────────────────────────────────────────────────────
  console.log('\n2. Nada que no pueda ver el cliente\n');

  const crudo = JSON.stringify(t1.body).toLowerCase();
  for (const palabra of ['profit', 'costo', 'fletebase', 'margen', 'utilidad', 'precio_kg', 'preciokg']) {
    check(`el JSON no dice "${palabra}"`, !crudo.includes(palabra));
  }

  // El tarifario es flete de venta PELADO: sin fuel, sin seguro, sin GoGreen. Si alguna vez
  // se colara el total del motor, el número sería más alto que este.
  const conTodo = cotizarServicio('DHL', {
    tipo: 'export', pf: 10, zonaOverride: 1, fuelPct: 30, fob: 5000,
    bultosProc: [], profitPct: PCT,
  });
  const fila10 = paquetes.filas.find((f) => f.peso === 10);
  check('el precio del tarifario es el flete de venta pelado, no el total',
    fila10.precios[0] < conTodo.total, `${fila10.precios[0]} vs total ${conTodo.total}`);

  // ── 3. El precio por kilo cargado gana también en el tarifario ───────────────────────
  console.log('\n3. El precio por kilo cargado se cobra (regla del 13/08)\n');

  const t2 = await J(`/api/clientes/${CLI_KG}/tarifario?servicios=DHL&desde=20&hasta=40&paso=1&documentos=0`);
  const filasKg = t2.body.tablas[0].filas;
  const f25 = filasKg.find((f) => f.peso === 25);
  const f40 = filasKg.find((f) => f.peso === 40);
  check('25 kg se cobran a USD 7,02 el kilo', Math.abs(f25.precios[0] - 25 * 7.02) < 0.02,
    `dio ${f25.precios[0]}, esperaba ${(25 * 7.02).toFixed(2)}`);
  check('40 kg se cobran a USD 4,86 el kilo (el otro tramo)',
    Math.abs(f40.precios[0] - 40 * 4.86) < 0.02, `dio ${f40.precios[0]}, esperaba ${(40 * 4.86).toFixed(2)}`);
  check('el precio por kilo vale para las seis zonas por igual',
    new Set(f25.precios.map((p) => p.toFixed(2))).size === 1, JSON.stringify(f25.precios));

  // ── 4. La memoria por tramos no corre ningún corte ───────────────────────────────────
  console.log('\n4. La memoria por intervalos no mueve el corte de 32 kg\n');

  const f32 = filasKg.find((f) => f.peso === 32);
  const f33 = filasKg.find((f) => f.peso === 33);
  check('32 kg todavía es el tramo de 7,02 (límite superior inclusivo)',
    Math.abs(f32.precios[0] - 32 * 7.02) < 0.02, `dio ${f32.precios[0]}`);
  check('33 kg ya es el tramo de 4,86',
    Math.abs(f33.precios[0] - 33 * 4.86) < 0.02, `dio ${f33.precios[0]}`);
  check('el precio BAJA al pasar el corte, como está cargado',
    f33.precios[0] < f32.precios[0]);

  // ── 5. Las zonas del tarifario combinado ─────────────────────────────────────────────
  console.log('\n5. DHL y UPS zonifican distinto y el combinado lo traduce\n');

  const tarifarioService = require('../src/services/tarifario.service');
  const eq3 = tarifarioService.zonasEquivalentes(3, 'UPS_EXP', 'export');
  check('la zona 3 de Nova (EE.UU./Canadá/México) cae en la 2 de UPS', eq3.includes(2),
    JSON.stringify(eq3));
  check('la zona 3 de Nova en DHL es la 3 de DHL',
    JSON.stringify(tarifarioService.zonasEquivalentes(3, 'DHL', 'export')) === '[3]');

  const comb = await J(`/api/clientes/${CLI_PCT}/tarifario?servicios=DHL,UPS_EXP&combinar=1&base=alto&desde=1&hasta=3&documentos=0`);
  const soloDhl = await J(`/api/clientes/${CLI_PCT}/tarifario?servicios=DHL&desde=1&hasta=3&documentos=0`);
  const soloUps = await J(`/api/clientes/${CLI_PCT}/tarifario?servicios=UPS_EXP&desde=1&hasta=3&documentos=0`);
  let combOk = true; let detalle = '';
  comb.body.tablas[0].filas.forEach((f, i) => {
    f.precios.forEach((p, z) => {
      const a = soloDhl.body.tablas[0].filas[i].precios[z];
      const b = soloUps.body.tablas[0].filas[i].precios[z];
      // 'alto' nunca puede dar menos que cualquiera de los dos por separado. Puede dar MÁS
      // que el de UPS de esa misma columna, porque UPS zonifica distinto y se toma el peor
      // país de la zona.
      if (p < Math.max(a, b) - 0.02) { combOk = false; detalle = `${f.peso} kg col ${z + 1}: ${p} < max(${a},${b})`; }
    });
  });
  check('la base "alto" nunca queda por debajo de un servicio suelto', combOk, detalle);
  check('el tarifario combinado no nombra el servicio', comb.body.tablas[0].servicio === null);

  // ── 6. Rango y paso ──────────────────────────────────────────────────────────────────
  console.log('\n6. Desde, hasta y cada cuánto\n');

  const t3 = await J(`/api/clientes/${CLI_PCT}/tarifario?servicios=DHL&desde=50&hasta=60&paso=5&documentos=0`);
  check('el paso de 5 kg da 50, 55 y 60',
    JSON.stringify(t3.body.tablas[0].filas.map((f) => f.peso)) === '[50,55,60]',
    JSON.stringify(t3.body.tablas[0].filas.map((f) => f.peso)));

  const t4 = await J(`/api/clientes/${CLI_PCT}/tarifario?servicios=DHL&desde=29&hasta=33&paso=auto&documentos=0`);
  check('el paso automático usa medios kilos hasta 30 y kilos enteros arriba',
    JSON.stringify(t4.body.tablas[0].filas.map((f) => f.peso)) === '[29,29.5,30,31,32,33]',
    JSON.stringify(t4.body.tablas[0].filas.map((f) => f.peso)));

  const t5 = await J(`/api/clientes/${CLI_PCT}/tarifario?servicios=DHL&desde=0.5&hasta=400&paso=0.5`);
  check('un rango absurdo se rechaza con un mensaje, no revienta', t5.status === 400,
    JSON.stringify(t5.body));

  const t6 = await J(`/api/clientes/${CLI_PCT}/tarifario?servicios=NADA`);
  check('un servicio inexistente se rechaza', t6.status === 400, JSON.stringify(t6.body));

  const t7 = await J('/api/clientes/99999/tarifario?servicios=DHL');
  check('un cliente que no existe da 404', t7.status === 404);

  // ── 7. El Excel ──────────────────────────────────────────────────────────────────────
  console.log('\n7. La salida en Excel\n');

  const xls = await fetch(`${BASE}/api/clientes/${CLI_PCT}/tarifario.xlsx?servicios=DHL&desde=0.5&hasta=5`, { headers: H });
  const buf = Buffer.from(await xls.arrayBuffer());
  check('el Excel responde 200', xls.status === 200);
  check('es un xlsx de verdad (empieza con PK)', buf.slice(0, 2).toString() === 'PK');
  check('viene como archivo adjunto con nombre',
    /attachment; filename=/.test(xls.headers.get('content-disposition') || ''));

  // ── 8. El registro de lo emitido ─────────────────────────────────────────────────────
  // La mitad del valor del registro es que guarda LA GRILLA, no las opciones: las tarifas
  // cambian, y reabrir una emisión tiene que mostrar los precios de ESE día.
  console.log('\n8. Emitir deja registro, y la emisión guarda los precios del día\n');

  const P = async (u, body) => {
    const r = await fetch(BASE + u, { method: 'POST', headers: H, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const opciones = { servicios: 'DHL', desde: '0.5', hasta: '3', documentos: '0', marca: 'nova', vence: '30' };
  const em = await P(`/api/clientes/${CLI_PCT}/tarifario/emitir`, opciones);
  check('emitir responde 201 con un id', em.status === 201 && em.body.id > 0, JSON.stringify(em.body));

  const lista = await J(`/api/clientes/${CLI_PCT}/tarifario/emitidos`);
  check('la emisión aparece en la lista del cliente',
    lista.status === 200 && lista.body.some((e) => e.id === em.body.id));
  check('la lista dice el formato y las opciones',
    lista.body[0].formato === 'pdf' && lista.body[0].opciones.servicios === 'DHL',
    JSON.stringify(lista.body[0]).slice(0, 120));

  const emitido = await J(`/api/tarifario/emitidos/${em.body.id}`);
  check('la emisión completa trae la grilla', emitido.status === 200
    && emitido.body.datos.tablas[0].filas.length > 0);
  const precioEmitido = emitido.body.datos.tablas[0].filas[0].precios[0];

  // La prueba de fuego: le cambiamos el profit al cliente y la emisión NO se mueve.
  await run('UPDATE clientes SET tarifa_pct = 200 WHERE id = ?', [CLI_PCT]);
  const emitidoDespues = await J(`/api/tarifario/emitidos/${em.body.id}`);
  const vivoDespues = await J(`/api/clientes/${CLI_PCT}/tarifario?servicios=DHL&desde=0.5&hasta=3&documentos=0`);
  check('la tarifa del cliente cambió y el tarifario VIVO lo refleja',
    vivoDespues.body.tablas[0].filas[0].precios[0] > precioEmitido);
  check('pero la emisión guardada sigue diciendo el precio de aquel día',
    emitidoDespues.body.datos.tablas[0].filas[0].precios[0] === precioEmitido,
    `guardado ${emitidoDespues.body.datos.tablas[0].filas[0].precios[0]} vs original ${precioEmitido}`);
  await run('UPDATE clientes SET tarifa_pct = ? WHERE id = ?', [PCT, CLI_PCT]);

  const cuenta = await q('SELECT COUNT(*) AS n FROM tarifario_emitidos WHERE cliente_id = ?', [CLI_PCT]);
  check('bajar el Excel también quedó registrado', Number(cuenta[0].n) >= 2, `hay ${cuenta[0].n}`);

  // ── 9. Los presets del panel ─────────────────────────────────────────────────────────
  console.log('\n9. Los presets guardan y devuelven las opciones\n');

  const PUT = async (u, body) => {
    const r = await fetch(BASE + u, { method: 'PUT', headers: H, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const g1 = await PUT('/api/tarifario/presets', { nombre: 'Cliente nuevo', opciones });
  check('guardar un preset responde 201', g1.status === 201, JSON.stringify(g1.body));
  const lp = await J('/api/tarifario/presets');
  const preset = lp.body.find((p) => p.nombre === 'Cliente nuevo');
  check('el preset aparece con sus opciones', Boolean(preset) && preset.opciones.hasta === '3');

  await PUT('/api/tarifario/presets', { nombre: 'Cliente nuevo', opciones: { ...opciones, hasta: '50' } });
  const lp2 = await J('/api/tarifario/presets');
  check('guardar con el mismo nombre lo pisa (no duplica)',
    lp2.body.filter((p) => p.nombre === 'Cliente nuevo').length === 1
    && lp2.body.find((p) => p.nombre === 'Cliente nuevo').opciones.hasta === '50');

  check('un preset sin nombre se rechaza',
    (await PUT('/api/tarifario/presets', { opciones })).status === 400);

  const del = await fetch(`${BASE}/api/tarifario/presets/${preset.id}`, { method: 'DELETE', headers: H });
  check('borrar un preset lo saca de la lista', del.status === 200
    && !(await J('/api/tarifario/presets')).body.some((p) => p.id === preset.id));

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
