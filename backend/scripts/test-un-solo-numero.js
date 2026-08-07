#!/usr/bin/env node
/**
 * test-un-solo-numero.js — LA REGLA NÚMERO UNO: el mismo envío da el mismo precio,
 * lo pida quien lo pida.
 *
 * ═══ POR QUÉ HACÍA FALTA ═══
 *
 * Ya existe test-motor-unico.js, y no alcanzó. Ese test llama al MOTOR directamente con
 * los mismos datos de entrada escritos a mano, y comprueba que da lo mismo por los tres
 * caminos. Y da lo mismo — el motor nunca fue el problema.
 *
 * El problema estaba UN PASO ANTES: cada pantalla armaba los datos de entrada por su
 * cuenta, y se fueron desviando de a una sin que ningún test se enterara:
 *
 *   · Cargar envío no mandaba `contenido` → un documento DHL salía hasta 60% más caro.
 *   · Cargar envío no mandaba `ddp` → el envío se cargaba sin el cargo.
 *   · "Calcular venta" de Salidas mandaba fuel 0 cuando el envío no tenía fuel congelado
 *     (los envíos viejos lo tienen vacío) → sugería el precio SIN combustible: USD 89 de
 *     menos en un envío de 30 kg, con un número que se veía perfectamente razonable.
 *   · La precarga del profit preguntaba sin el país → sin país no hay zona, sin zona no
 *     hay celda de la matriz: la pantalla mostraba 75% y el sistema cobraba 70%.
 *
 * Los cuatro son el MISMO error. Los cuatro pasaron todos los tests. Por eso este test no
 * parte de datos escritos a mano: parte de un ENVÍO REAL y compara lo que devuelve cada
 * camino, exactamente como lo llama cada pantalla. Si alguno se desvía un centavo, falla.
 *
 * ═══ QUÉ CUBRE ═══
 *
 * Para cada escenario, los cuatro caminos que devuelven un precio:
 *   1. Cargar envío        — cotiza antes de guardar
 *   2. Calcular venta      — recotiza un envío ya cargado, desde Salidas
 *   3. Cotizador manual    — la pantalla suelta
 *   4. profit-resolve      — la precarga que MUESTRA el profit (no cobra, pero si dice
 *                            otro número que el que se cobra, alguien va a facturar mal)
 *
 * Los escenarios son los casos que rompieron de verdad, más los bordes de siempre.
 *
 *   cd backend && npm run test-un-solo-numero
 */

const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3966;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_un_solo_numero.db';
const TOKEN = 'token-test-un-solo-numero';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const cerca = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) <= tol;

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [require('path').join(__dirname, '..', 'src', 'server.js')], {
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

  const J = async (m, u, b) => (await fetch(BASE + u, {
    method: m, headers: H, body: b ? JSON.stringify(b) : undefined,
  })).json();

  // Fuel de configuración conocido, para poder afirmar de dónde salió cada número.
  await J('PUT', '/api/configuracion/fuel/UPS', { fuel_pct: 39.5 });
  await J('PUT', '/api/configuracion/fuel/DHL', { fuel_pct: 39.5 });

  // El cliente del caso real: 75% general, pero una CELDA de la matriz con 70% para la
  // zona 2 en la banda de 25-30 kg. Que el general y la celda sean distintos es lo que
  // hace visible el bug: si fueran iguales, resolver mal la zona no se notaría.
  const cli = await J('POST', '/api/clientes', { nombre: 'REGLA UNO', tarifa_pct: 75 });
  await J('PUT', `/api/clientes/${cli.id}/profit-matrix`,
    { servicio: 'UPS_EXP', tipo: 'export', zona: 2, peso_min: 25, peso_max: 30, profit_pct: 70 });

  console.log('\n1. El caso que encontró la oficina: envío viejo sin fuel congelado\n');

  // Se crea el envío y después se le BORRA el fuel, que es como están los envíos cargados
  // antes de que el sistema lo congelara. Es el caso que producía el precio sin combustible.
  const env = await J('POST', '/api/envios', {
    cliente_id: cli.id, fecha: '2026-08-07', courier: 'UPS', tipo_envio: 'exportacion',
    numero_guia: '1Z000REGLA0000001', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
    peso_real: 30, largo: 10, ancho: 10, alto: 10, fob: 0,
  });
  const sqlite3 = require('sqlite3');
  await new Promise((res) => {
    const d = new sqlite3.Database(DB);
    d.run('UPDATE envios SET fuel_pct = NULL WHERE id = ?', [env.id], () => d.close(() => res()));
  });

  // Camino 2 — "Calcular venta" de Salidas: manda el envio_id y NO manda el fuel.
  const calcVenta = await J('POST', '/api/liquidaciones/cotizar', {
    pais: 'Estados Unidos', tipo: 'export', servicio: 'UPS_EXP', pesoFacturable: 30, fob: 0,
    bultos: [{ peso_real: 30, largo: 10, ancho: 10, alto: 10 }],
    cliente_id: cli.id, envio_id: env.id, profitPct: 0, profitManual: false,
    ddp: false, proteccionDoc: false, entrega: 'normal', contenido: 'paquete',
  });
  // Camino 1 — Cargar envío: manda el fuel de configuración.
  const cargar = await J('POST', '/api/liquidaciones/cotizar', {
    pais: 'Estados Unidos', tipo: 'export', servicio: 'UPS_EXP', pesoFacturable: 30, fob: 0,
    fuelPct: 39.5, bultos: [{ peso_real: 30, largo: 10, ancho: 10, alto: 10 }],
    cliente_id: cli.id, profitPct: 0, profitManual: false,
    ddp: false, proteccionDoc: false, entrega: 'normal', contenido: 'paquete',
  });

  check('el envío sin fuel congelado YA NO cotiza en 0', calcVenta.fuel_aplicado !== 0,
    `fuel aplicado ${calcVenta.fuel_aplicado}`);
  check('toma el fuel de configuración del courier', cerca(calcVenta.fuel_aplicado, 39.5),
    `${calcVenta.fuel_aplicado} (origen: ${calcVenta.fuel_origen})`);
  check('y dice de dónde lo sacó', calcVenta.fuel_origen === 'configuracion',
    calcVenta.fuel_origen);
  check('Calcular venta y Cargar envío dan EL MISMO precio',
    cerca(calcVenta.precioFinal, cargar.precioFinal),
    `venta ${calcVenta.precioFinal} · cargar ${cargar.precioFinal}`);

  console.log('\n2. El profit: lo que se MUESTRA y lo que se COBRA\n');

  const resolveSinPais = await J('GET',
    `/api/clientes/${cli.id}/profit-resolve?servicio=UPS_EXP&tipo=export&pf=30`);
  const resolveConPais = await J('GET',
    `/api/clientes/${cli.id}/profit-resolve?servicio=UPS_EXP&tipo=export&pf=30&pais=Estados%20Unidos`);

  check('con el país, la precarga encuentra la celda de la matriz',
    Number(resolveConPais.profitPct) === 70 && resolveConPais.origen === 'celda',
    `${resolveConPais.profitPct}% (${resolveConPais.origen})`);
  check('el profit que se MUESTRA es el que se COBRA',
    Number(resolveConPais.profitPct) === Number(cargar.profit_aplicado),
    `muestra ${resolveConPais.profitPct}% · cobra ${cargar.profit_aplicado}%`);
  check('sin país sigue cayendo al general (por eso la pantalla tiene que mandarlo)',
    Number(resolveSinPais.profitPct) === 75, `${resolveSinPais.profitPct}%`);
  check('los tres caminos aplican el mismo profit',
    calcVenta.profit_aplicado === cargar.profit_aplicado
    && cargar.profit_aplicado === 70,
    `venta ${calcVenta.profit_aplicado} · cargar ${cargar.profit_aplicado}`);
  check('y todos dicen que salió de la celda',
    calcVenta.profit_origen === 'celda' && cargar.profit_origen === 'celda');

  console.log('\n3. Los cuatro caminos, sobre los casos que ya rompieron antes\n');

  // Cada escenario se cotiza por los cuatro caminos. La forma de llamar cambia (es lo que
  // hace cada pantalla); el número NO puede cambiar.
  const ESCENARIOS = [
    { nombre: 'documento DHL de 0,5 kg (el caso del `contenido`)',
      envio: { courier: 'DHL', tipo_envio: 'exportacion', pais_destino: 'Estados Unidos',
        tipo_paquete: 'd', peso_real: 0.5, largo: 20, ancho: 15, alto: 2, fob: 100 },
      pf: 0.5, servicio: 'DHL', contenido: 'documento' },
    { nombre: 'envío con DDP (el caso del `ddp`)',
      envio: { courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion',
        pais_destino: 'Estados Unidos', peso_real: 8, largo: 30, ancho: 25, alto: 20,
        fob: 500, ddp: 1 },
      pf: 8, servicio: 'UPS_EXP', ddp: true },
    { nombre: 'envío pesado en zona con celda propia (30 kg, zona 2)',
      envio: { courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'exportacion',
        pais_destino: 'Estados Unidos', peso_real: 30, largo: 10, ancho: 10, alto: 10, fob: 0 },
      pf: 30, servicio: 'UPS_EXP' },
    { nombre: 'entrega extendida a un país lejano',
      envio: { courier: 'DHL', tipo_envio: 'exportacion', pais_destino: 'Kenia',
        peso_real: 12, largo: 40, ancho: 30, alto: 30, fob: 800, entrega: 'extendida' },
      pf: 12, servicio: 'DHL', entrega: 'extendida' },
    { nombre: 'importación desde China',
      envio: { courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_envio: 'importacion',
        pais_destino: 'China', peso_real: 20, largo: 40, ancho: 40, alto: 30, fob: 300 },
      pf: 20, servicio: 'UPS_EXP', tipo: 'import' },
  ];

  let n = 2;
  for (const esc of ESCENARIOS) {
    n += 1;
    const e = await J('POST', '/api/envios', {
      cliente_id: cli.id, fecha: '2026-08-07', numero_guia: `1Z000REGLA000${n}00`, ...esc.envio,
    });
    const tipo = esc.tipo || 'export';
    const bultos = [{
      peso_real: esc.envio.peso_real, largo: esc.envio.largo,
      ancho: esc.envio.ancho, alto: esc.envio.alto,
    }];
    const comun = {
      pais: esc.envio.pais_destino, tipo, servicio: esc.servicio, pesoFacturable: esc.pf,
      fob: esc.envio.fob, bultos, cliente_id: cli.id, profitPct: 0, profitManual: false,
    };

    // 1. Cargar envío: arma todo a mano, con el fuel de configuración.
    const a = await J('POST', '/api/liquidaciones/cotizar', {
      ...comun, fuelPct: 39.5,
      contenido: esc.contenido || 'paquete', ddp: !!esc.ddp,
      proteccionDoc: false, entrega: esc.entrega || 'normal',
    });
    // 2. Calcular venta: manda el envio_id y deja que el servidor complete.
    const b = await J('POST', '/api/liquidaciones/cotizar', {
      ...comun, envio_id: e.id,
      contenido: esc.contenido || 'paquete', ddp: !!esc.ddp,
      proteccionDoc: false, entrega: esc.entrega || 'normal',
    });
    // 3. Calcular venta EN CRUDO: solo el envio_id. Es la prueba de fondo de que el
    //    servidor puede reconstruir la cotización entera sin que la pantalla le diga nada.
    const c = await J('POST', '/api/liquidaciones/cotizar', {
      envio_id: e.id, pesoFacturable: esc.pf, profitManual: false,
    });
    // 4. Cotizador manual: sin envío, todo explícito.
    const d = await J('POST', '/api/liquidaciones/cotizar', {
      ...comun, fuelPct: 39.5,
      contenido: esc.contenido || 'paquete', ddp: !!esc.ddp,
      proteccionDoc: false, entrega: esc.entrega || 'normal',
    });

    const iguales = cerca(a.precioFinal, b.precioFinal) && cerca(b.precioFinal, c.precioFinal)
      && cerca(c.precioFinal, d.precioFinal);
    check(`${esc.nombre}: los cuatro caminos dan ${Number(a.precioFinal).toFixed(2)}`, iguales,
      `cargar ${a.precioFinal} · venta ${b.precioFinal} · solo-id ${c.precioFinal} · manual ${d.precioFinal}`);
    check(`${esc.nombre}: mismo profit en los cuatro`,
      a.profit_aplicado === b.profit_aplicado && b.profit_aplicado === c.profit_aplicado
      && c.profit_aplicado === d.profit_aplicado,
      `${a.profit_aplicado} · ${b.profit_aplicado} · ${c.profit_aplicado} · ${d.profit_aplicado}`);
    check(`${esc.nombre}: mismo fuel en los cuatro`,
      cerca(a.fuel_aplicado, b.fuel_aplicado) && cerca(b.fuel_aplicado, c.fuel_aplicado)
      && cerca(c.fuel_aplicado, d.fuel_aplicado),
      `${a.fuel_aplicado} · ${b.fuel_aplicado} · ${c.fuel_aplicado} · ${d.fuel_aplicado}`);

    // Y el profit que MUESTRA la precarga tiene que ser el que se cobra.
    const servResolve = esc.servicio === 'UPS_SAV' ? 'UPS_SAVER' : esc.servicio;
    const pre = await J('GET', `/api/clientes/${cli.id}/profit-resolve`
      + `?servicio=${servResolve}&tipo=${tipo}&pf=${esc.pf}`
      + `&pais=${encodeURIComponent(esc.envio.pais_destino)}`);
    check(`${esc.nombre}: el profit que se muestra es el que se cobra`,
      Number(pre.profitPct) === Number(a.profit_aplicado),
      `muestra ${pre.profitPct} · cobra ${a.profit_aplicado}`);
  }

  console.log('\n4. El fuel: la cadena completa, en orden\n');

  const cliFuel = await J('POST', '/api/clientes', { nombre: 'FUEL PROPIO', tarifa_pct: 50 });
  // El fuel propio no se carga en el alta sino en la ficha del cliente, igual que en la pantalla.
  await J('PUT', `/api/clientes/${cliFuel.id}`, { fuel_pct_propio: 12 });
  const envFuel = await J('POST', '/api/envios', {
    cliente_id: cliFuel.id, fecha: '2026-08-07', courier: 'UPS', tipo_envio: 'exportacion',
    numero_guia: '1Z000REGLAFUEL001', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
    peso_real: 10, largo: 30, ancho: 25, alto: 20, fob: 0,
  });
  const conPropio = await J('POST', '/api/liquidaciones/cotizar',
    { envio_id: envFuel.id, pesoFacturable: 10, fuelPct: 39.5, profitManual: false });
  check('el fuel propio del cliente gana sobre todo lo demás',
    cerca(conPropio.fuel_aplicado, 12) && conPropio.fuel_origen === 'cliente',
    `${conPropio.fuel_aplicado} (${conPropio.fuel_origen})`);

  const congelado = await J('POST', '/api/liquidaciones/cotizar',
    { envio_id: env.id, pesoFacturable: 30, profitManual: false });
  check('sin fuel propio ni congelado, manda la configuración',
    cerca(congelado.fuel_aplicado, 39.5) && congelado.fuel_origen === 'configuracion',
    `${congelado.fuel_aplicado} (${congelado.fuel_origen})`);

  // Un envío CON fuel congelado se recotiza con el suyo, no con el de hoy: un envío de
  // mayo no puede cambiar de precio porque en agosto subió el combustible.
  await new Promise((res) => {
    const d = new sqlite3.Database(DB);
    d.run('UPDATE envios SET fuel_pct = 22 WHERE id = ?', [env.id], () => d.close(() => res()));
  });
  const conCongelado = await J('POST', '/api/liquidaciones/cotizar',
    { envio_id: env.id, pesoFacturable: 30, profitManual: false });
  check('un envío con su fuel congelado se recotiza con ESE, no con el de hoy',
    cerca(conCongelado.fuel_aplicado, 22) && conCongelado.fuel_origen === 'envio',
    `${conCongelado.fuel_aplicado} (${conCongelado.fuel_origen})`);

  const cero = await J('POST', '/api/liquidaciones/cotizar', {
    pais: 'Estados Unidos', tipo: 'export', servicio: 'UPS_EXP', pesoFacturable: 10,
    fob: 0, fuelPct: 0, bultos: [{ peso_real: 10, largo: 30, ancho: 25, alto: 20 }],
    profitPct: 50, profitManual: true,
  });
  check('un 0 escrito a propósito se respeta (no se pisa con la configuración)',
    Number(cero.fuel_aplicado) === 0, `${cero.fuel_aplicado} (${cero.fuel_origen})`);

  console.log('\n5. La zona sale del país, en todos lados igual\n');

  const zonaCot = await J('POST', '/api/liquidaciones/cotizar', {
    pais: 'Estados Unidos', tipo: 'export', servicio: 'UPS_EXP', pesoFacturable: 30, fob: 0,
    zona: 6, bultos: [{ peso_real: 30, largo: 10, ancho: 10, alto: 10 }],
    cliente_id: cli.id, profitManual: false, fuelPct: 39.5,
  });
  check('mandar una zona equivocada NO pisa la que resuelve el país',
    Number(zonaCot.zona_aplicada) === 2, `zona aplicada ${zonaCot.zona_aplicada}`);
  check('y por eso sigue tomando la celda de zona 2', zonaCot.profit_aplicado === 70,
    `${zonaCot.profit_aplicado}%`);

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  matarSrv();
  await esperarSrvMuerto();
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
