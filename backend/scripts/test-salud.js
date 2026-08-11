#!/usr/bin/env node
/**
 * test-salud.js — el panel de salud.
 *
 * QUÉ VERIFICA Y POR QUÉ ASÍ
 *
 * Un panel de alertas tiene un modo de fallar que es peor que no existir: decir "está
 * todo bien" cuando no miró. Por eso el test no se conforma con "el endpoint responde
 * 200". Para cada chequeo se **planta el problema a propósito** en una base controlada y
 * se exige que lo encuentre, con el conteo exacto. Un chequeo que no puede fallar en el
 * test tampoco sirve en producción.
 *
 * Además se verifica lo contrario: sobre una base limpia, ningún chequeo inventa
 * problemas. Un panel que grita siempre entrena a ignorarlo.
 *
 * La base es propia del test y se construye de cero (NO se copia la de producción):
 * los conteos tienen que ser exactos y no pueden depender de qué datos haya ese día.
 *
 *   cd backend && npm run test-salud
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3987;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_salud.db';
const TOKEN = 'token-test-salud';
const TOKEN_EMP = 'token-test-salud-empleado';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function abrir(dbPath) {
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(dbPath);
  return {
    q: (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r)))),
    close: () => new Promise((res) => db.close(() => res())),
  };
}

// Fecha local 'YYYY-MM-DD' corrida N días. Misma regla que utils/fecha.js: nunca
// toISOString(), que devuelve UTC y adelanta un día después de las 21:00.
function fechaMas(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function getChequeo(data, id) {
  return data.chequeos.find((c) => c.id === id);
}

async function pedirSalud(token = TOKEN) {
  const r = await fetch(BASE + '/api/salud', { headers: { cookie: `nova_session=${token}` } });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
}

async function main() {
  // Base de cero, sin arrastrar nada de una corrida anterior (incluido el WAL: si
  // sobrevive, SQLite lo reproduce sobre la base nueva y aparecen filas fantasma).
  for (const f of [DB, DB + '-wal', DB + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
  const dirBackups = path.join(path.dirname(DB), 'backups');

  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Se guarda lo que el servidor escribe: es el unico lugar donde esta el motivo si no
  // arranca. La linea de 'listo' sale por stdout y es lo que espera esperarServidor().
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  // Windows: llamar srv.kill() DOS VECES sobre el mismo handle revienta libuv con
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
  // Pasaba porque el cierre explícito mata el server y, acto seguido, process.exit() dispara
  // este mismo handler, que lo vuelve a matar cuando el handle ya se está cerrando. En Linux
  // no se notaba; en Windows cortaba el `npm test` entero a mitad de la cadena, sin que
  // ningún test hubiera fallado. El guard hace que solo la primera llamada tenga efecto.
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);
  // Matar al server NO es instantaneo: kill() manda la senal y el proceso hijo tarda en
  // morir. Si se llama process.exit() antes de que muera, Node se cae en Windows con
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src/win/async.c, line 94
  // porque el handle del hijo se esta cerrando cuando el proceso ya arranco a salir. No
  // falla ningun test: se muere Node y corta la cadena del `npm test` a la mitad. Esta
  // funcion espera al 'exit' del hijo (con tope de 2 s por si quedara colgado) para que el
  // handle este cerrado ANTES de salir.
  const esperarSrvMuerto = () => new Promise((res) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return res();
    srv.once('exit', res);
    setTimeout(res, 2000);
  });

  // Antes habia un bucle de 40 intentos contra /api/health que seguia de largo pasara lo
  // que pasara: si el servidor tardaba mas de 12 segundos en arrancar —en Windows, con la
  // base creandose y el antivirus mirando, pasa— el test continuaba igual y reventaba mas
  // adelante con un ECONNREFUSED o un 'no such table' que no tenian nada que ver.
  // Ver scripts/_base-test.js.
  await esperarServidor(srv, BASE, () => logErr, () => logOut);

  const { q, close } = abrir(DB);

  // Usuarios: un admin y un empleado sin permiso, con sus sesiones.
  await q("INSERT INTO usuarios (id, usuario, password_hash, rol, ver_dashboard, editar_config, ver_salud) VALUES (1,'tester','x','admin',1,1,0)");
  await q("INSERT INTO usuarios (id, usuario, password_hash, rol, ver_dashboard, editar_config, ver_salud) VALUES (2,'empleado','x','empleado',0,0,0)");
  const sesion = (tok, uid) => q(
    'INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?,?,?)',
    [crypto.createHash('sha256').update(tok).digest('hex'), uid, new Date(Date.now() + 36e5).toISOString()]
  );
  await sesion(TOKEN, 1);
  await sesion(TOKEN_EMP, 2);

  // schema.sql siembra un "Cliente Demo" con tarifa_pct = 0, que el chequeo de margen
  // marca (con razon). Se saca para que el punto 1 mida lo que dice medir: una base
  // limpia de verdad. El chequeo de margen se prueba aparte, en el punto 2.
  await q("DELETE FROM clientes WHERE nombre = 'Cliente Demo'");

  // ── 0. Permisos ─────────────────────────────────────────────────────────────
  console.log('\n0. Quién puede entrar\n');

  const sinCookie = await fetch(BASE + '/api/salud');
  check('sin sesión devuelve 401', sinCookie.status === 401, String(sinCookie.status));

  const empleado = await pedirSalud(TOKEN_EMP);
  check('un empleado sin ver_salud devuelve 403', empleado.status === 403, String(empleado.status));

  const admin = await pedirSalud();
  check('el admin entra aunque tenga ver_salud = 0', admin.status === 200, String(admin.status));

  await q('UPDATE usuarios SET ver_salud = 1 WHERE id = 2');
  const empleadoOk = await pedirSalud(TOKEN_EMP);
  check('con ver_salud = 1 el empleado entra', empleadoOk.status === 200, String(empleadoOk.status));
  await q('UPDATE usuarios SET ver_salud = 0 WHERE id = 2');

  // ── 1. Base limpia: no inventa problemas ────────────────────────────────────
  console.log('\n1. Sobre una base sin problemas, no inventa ninguno\n');

  const limpio = (await pedirSalud()).body;
  // 14 desde el 06/08/2026, cuando se sumó "cierres" (los meses archivados fuera del
  // sistema). Este número se toca a mano a propósito: si alguien agrega un chequeo y no
  // actualiza el test, el test se lo recuerda.
  check('devuelve los 14 chequeos', limpio.chequeos.length === 14, String(limpio.chequeos.length));
  check('ninguno falló al correr', limpio.resumen.error === 0,
    limpio.chequeos.filter((c) => c.error).map((c) => `${c.id}: ${c.error}`).join(' | '));

  // Todos los chequeos de base tienen que dar OK. Hay dos excepciones deliberadas, y las
  // dos dicen algo cierto sobre una base recién creada:
  //   · backups → mientras no haya copia fuera del servidor, avisa. Se apaga solo cuando
  //     corre scripts/copia-externa.sh (lo cubre test-copia-externa.js).
  //   · cierres → una base nueva no tiene ningún mes archivado todavía.
  const IGNORAR = ['backups', 'cierres'];
  const falsosPositivos = limpio.chequeos.filter(
    (c) => c.severidad !== 'ok' && !IGNORAR.includes(c.id));
  check('ningún chequeo se enciende sin motivo', falsosPositivos.length === 0,
    falsosPositivos.map((c) => `${c.id} (${c.severidad}): ${c.resumen}`).join(' | '));

  check('cada chequeo dice a qué grupo pertenece',
    limpio.chequeos.every((c) => ['plata', 'datos', 'higiene'].includes(c.grupo)));

  // ── 2. Ahora se planta un problema de cada tipo ─────────────────────────────
  console.log('\n2. Se planta un problema de cada tipo y se exige que lo encuentre\n');

  await q("INSERT INTO clientes (id, nombre, tipo_cobro, activo, tarifa_pct) VALUES (1,'Cliente Uno','D',1,25)");
  await q("INSERT INTO clientes (id, nombre, tipo_cobro, activo, tarifa_pct) VALUES (2,'Cliente Dos','D',1,25)");

  // (1) Un envío en dos liquidaciones — el caso de los borradores #12 y #30.
  await q(`INSERT INTO envios (id, cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, peso_real,
             total_cobrado, flete, seguro, fuel)
           VALUES (10, 1, ?, 'UPS', 'exportacion', '1ZDUPLICADO', 'US', 5, 500, 300, 20, 100)`, [fechaMas(-3)]);
  await q(`INSERT INTO liquidaciones (id, cliente_id, periodo_desde, periodo_hasta, fecha, total, estado)
           VALUES (100, 1, ?, ?, ?, 500, 'confirmada')`, [fechaMas(-10), fechaMas(-1), fechaMas(-3)]);
  await q(`INSERT INTO liquidaciones (id, cliente_id, periodo_desde, periodo_hasta, fecha, total, estado)
           VALUES (101, 1, ?, ?, ?, 500, 'borrador')`, [fechaMas(-40), fechaMas(-31), fechaMas(-30)]);
  await q('INSERT INTO liquidacion_items (liquidacion_id, envio_id, total_usd, fuel_pct_usado) VALUES (100, 10, 500, 32)');
  await q('INSERT INTO liquidacion_items (liquidacion_id, envio_id, total_usd, fuel_pct_usado) VALUES (101, 10, 500, 32)');

  // (2) Una guía facturada sin envío + (3) una factura que no cuadra +
  // (13) la MISMA factura cargada dos veces.
  await q(`INSERT INTO facturas_cargadas (id, courier, numero_factura, fecha_factura, cantidad_guias, total_declarado)
           VALUES (200, 'UPS', 'F-001', ?, 1, 1000)`, [fechaMas(-5)]);
  await q(`INSERT INTO factura_guias (factura_id, numero_guia, pais, peso_facturado, costo_total, encontrada)
           VALUES (200, '1ZHUERFANA', 'US', 10, 900, 0)`);
  await q(`INSERT INTO facturas_cargadas (id, courier, numero_factura, fecha_factura, cantidad_guias, total_declarado)
           VALUES (201, 'UPS', 'F-001', ?, 1, 1000)`, [fechaMas(-5)]);
  await q(`INSERT INTO factura_guias (factura_id, numero_guia, pais, peso_facturado, costo_total, encontrada)
           VALUES (201, '1ZHUERFANA', 'US', 10, 900, 0)`);

  // (4) Un desvío de costo fuera de tolerancia sin revisar. Costo estimado 420
  // (300 flete + 20 seguro + 100 fuel), facturado 900 → +114 %, muy por encima del 10 %.
  await q(`INSERT INTO envios (id, cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, peso_real,
             total_cobrado, flete, seguro, fuel, costo_facturado, estado_revision)
           VALUES (11, 1, ?, 'UPS', 'exportacion', '1ZDESVIO', 'US', 5, 600, 300, 20, 100, 900, NULL)`, [fechaMas(-4)]);

  // (5) Fuel congelado distinto al de Configuración.
  const [cfg] = await q("SELECT fuel_pct FROM configuracion WHERE courier = 'UPS'");
  await q(`INSERT INTO envios (id, cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, peso_real,
             total_cobrado, flete, fuel_pct)
           VALUES (12, 1, ?, 'UPS', 'exportacion', '1ZFUELVIEJO', 'US', 2, 100, 80, ?)`,
  [fechaMas(-10), (cfg ? cfg.fuel_pct : 30) + 7]);

  // (6) Un cliente activo sin margen ninguno.
  await q("INSERT INTO clientes (id, nombre, tipo_cobro, activo, tarifa_pct) VALUES (3,'Sin Margen','D',1,NULL)");

  // (7) Un cliente en modo por kilo sin un solo rango cargado.
  await q("INSERT INTO clientes (id, nombre, tipo_cobro, activo, tarifa_pct, modo_tarifa) VALUES (4,'Por Kilo Vacio','D',1,20,'por_kg')");

  // (8) Dos clientes con el mismo nombre en distinta capitalización.
  await q("INSERT INTO clientes (id, nombre, tipo_cobro, activo, tarifa_pct) VALUES (5,'GERSCOVICH','D',1,20)");
  await q("INSERT INTO clientes (id, nombre, tipo_cobro, activo, tarifa_pct) VALUES (6,'Gerscovich','D',1,20)");

  // (9) Un envío de un mes ya cerrado, sin precio y sin liquidar.
  await q(`INSERT INTO envios (id, cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, peso_real, total_cobrado)
           VALUES (13, 1, ?, 'DHL', 'exportacion', '1ZSINPRECIO', 'BR', 3, 0)`, [fechaMas(-70)]);

  // (12) Una fila huérfana, como las 4 que dejó el script de vaciado del 30/06.
  await q('INSERT INTO envio_bultos (envio_id, numero_bulto, peso_real, largo, ancho, alto) VALUES (99999, 1, 5, 10, 10, 10)');

  const con = (await pedirSalud()).body;

  const c1 = getChequeo(con, 'envio_en_varias_liquidaciones');
  check('(1) encuentra el envío en dos liquidaciones', c1.severidad === 'rojo' && c1.cantidad === 1, c1.resumen);
  check('(1) dice cuánta plata se refacturaría', c1.monto === 500, String(c1.monto));
  check('(1) muestra las dos liquidaciones con su estado',
    /100:confirmada/.test(c1.detalle[0].liquidaciones) && /101:borrador/.test(c1.detalle[0].liquidaciones),
    c1.detalle[0].liquidaciones);

  const c2 = getChequeo(con, 'guias_sin_envio');
  check('(2) encuentra la guía facturada sin envío', c2.severidad === 'rojo' && c2.cantidad === 1, c2.resumen);
  check('(2) NO duplica la plata aunque la guía esté en dos cargas de la misma factura',
    c2.detalle[0].costo === 900 && /900\.00/.test(c2.resumen), c2.resumen);

  const c3 = getChequeo(con, 'facturas_no_cuadran');
  check('(3) detecta que la factura no cuadra contra el total declarado',
    c3.severidad === 'rojo' && c3.cantidad >= 1, c3.resumen);
  check('(3) informa la diferencia exacta (1000 declarado − 900 en guías = 100)',
    c3.detalle.some((f) => f.diferencia === 100), JSON.stringify(c3.detalle[0]));

  const c13 = getChequeo(con, 'facturas_duplicadas');
  check('(13) detecta la factura cargada dos veces', c13.severidad === 'rojo' && c13.cantidad === 1, c13.resumen);
  check('(13) cuantifica la plata contada de más', c13.monto === 900, String(c13.monto));

  const c4 = getChequeo(con, 'desvios_sin_revisar');
  check('(4) encuentra el desvío de costo sin revisar', c4.severidad === 'rojo' && c4.cantidad === 1, c4.resumen);
  check('(4) informa cuánto facturó de más el courier', c4.detalle[0].de_mas === 480,
    String(c4.detalle[0].de_mas));

  const c5 = getChequeo(con, 'fuel_desfasado');
  check('(5) encuentra el envío con el fuel desfasado', c5.severidad === 'ambar' && c5.cantidad === 1, c5.resumen);

  const c6 = getChequeo(con, 'clientes_sin_margen');
  check('(6) encuentra el cliente sin margen', c6.severidad === 'ambar' && c6.cantidad === 1, c6.resumen);

  const c7 = getChequeo(con, 'clientes_por_kg_sin_tarifa');
  check('(7) encuentra el cliente por kilo sin tarifa', c7.severidad === 'rojo' && c7.cantidad === 1, c7.resumen);

  const c8 = getChequeo(con, 'clientes_duplicados');
  check('(8) encuentra los dos clientes con el mismo nombre', c8.severidad === 'ambar' && c8.cantidad === 1, c8.resumen);

  const c9 = getChequeo(con, 'envios_sin_precio');
  check('(9) encuentra el envío de mes cerrado sin precio', c9.severidad === 'ambar' && c9.cantidad === 1, c9.resumen);

  const c11 = getChequeo(con, 'borradores_viejos');
  check('(11) encuentra la liquidación en borrador de hace 30 días', c11.severidad === 'ambar' && c11.cantidad === 1, c11.resumen);

  const c12 = getChequeo(con, 'huerfanos');
  check('(12) encuentra la fila huérfana', c12.severidad === 'ambar' && c12.cantidad === 1, c12.resumen);

  check('el semáforo cuenta bien los rojos', con.resumen.rojo === 6, JSON.stringify(con.resumen));

  // ── 3. El mes en curso NO cuenta como "sin precio" ──────────────────────────
  // Cargar el envío sin precio y ponérselo al liquidar es el flujo normal. Si el panel
  // marcara eso, marcaría 118 de 134 envíos de un mes cualquiera y sería inservible.
  console.log('\n3. El flujo normal del mes en curso no se marca como problema\n');

  await q(`INSERT INTO envios (id, cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, peso_real, total_cobrado)
           VALUES (14, 1, ?, 'DHL', 'exportacion', '1ZDEHOY', 'BR', 3, 0)`, [fechaMas(0)]);
  const hoy = (await pedirSalud()).body;
  check('un envío de hoy sin precio no dispara ninguna alerta',
    getChequeo(hoy, 'envios_sin_precio').cantidad === 1,
    getChequeo(hoy, 'envios_sin_precio').resumen);

  // ── 4. Un desvío A FAVOR nuestro no se marca ────────────────────────────────
  // Misma regla que el semáforo de Salidas. Si el courier facturó de menos, no hay nada
  // que reclamar y no tiene sentido gastar la atención de nadie en eso.
  console.log('\n4. Un desvío a favor nuestro no se marca\n');

  await q(`INSERT INTO envios (id, cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, peso_real,
             total_cobrado, flete, seguro, fuel, costo_facturado, estado_revision)
           VALUES (15, 1, ?, 'UPS', 'exportacion', '1ZAFAVOR', 'US', 5, 600, 300, 20, 100, 200, NULL)`, [fechaMas(-4)]);
  const afavor = (await pedirSalud()).body;
  check('el courier facturando de MENOS no enciende la alerta',
    getChequeo(afavor, 'desvios_sin_revisar').cantidad === 1,
    getChequeo(afavor, 'desvios_sin_revisar').resumen);

  // ── 5. Un chequeo que se rompe no puede tapar a los demás ───────────────────
  // Es la regla más importante del panel: el modo de fallar que importa no es que un
  // chequeo se rompa, es que al romperse se lleve puesto el resto y la pantalla quede
  // en verde. Se rompe uno a propósito (se le saca la tabla que consulta) y se exige
  // que el panel siga contestando, que ese chequeo se reporte como roto, y que los
  // demás sigan detectando lo suyo.
  console.log('\n5. Un chequeo roto se reporta como roto y no tumba al resto\n');

  await q('ALTER TABLE cobranzas RENAME TO cobranzas_guardada');
  const roto = await pedirSalud();
  check('el panel sigue respondiendo 200', roto.status === 200, String(roto.status));
  const cRoto = getChequeo(roto.body, 'huerfanos');
  check('el chequeo roto se marca como error, no como OK', cRoto.severidad === 'error', cRoto.severidad);
  check('el error se muestra, no se traga', !!cRoto.error, String(cRoto.error));
  check('el resumen del chequeo roto NO dice que está todo bien',
    !/no hay|todo/i.test(cRoto.resumen), cRoto.resumen);
  check('los demás chequeos siguen detectando lo suyo',
    getChequeo(roto.body, 'envio_en_varias_liquidaciones').cantidad === 1);
  check('el semáforo cuenta el chequeo roto aparte', roto.body.resumen.error === 1,
    JSON.stringify(roto.body.resumen));
  await q('ALTER TABLE cobranzas_guardada RENAME TO cobranzas');

  // ── 6. El endpoint de resumen (la franja del Dashboard) ─────────────────────
  console.log('\n6. El resumen que consume la franja del Dashboard\n');

  const rres = await fetch(BASE + '/api/salud/resumen', { headers: { cookie: `nova_session=${TOKEN}` } });
  const res = await rres.json();
  check('devuelve el semáforo', rres.status === 200 && res.resumen.rojo === 6, JSON.stringify(res.resumen));
  check('lista los chequeos en rojo con su título', res.rojos.length === 6 && res.rojos.every((x) => x.titulo));
  check('no arrastra el detalle de las filas', !JSON.stringify(res).includes('1ZDUPLICADO'));

  // ── 7. Backups ──────────────────────────────────────────────────────────────
  // El chequeo mira el disco, no la base. Se le envejece el último backup a mano para
  // comprobar que el día que el backup deje de correr, se sepa ese día.
  console.log('\n7. Backups: un backup viejo se marca en rojo\n');

  if (fs.existsSync(dirBackups)) {
    const archivos = fs.readdirSync(dirBackups).filter((f) => f.startsWith('nova_backup_')).sort();
    if (archivos.length) {
      const ultimo = path.join(dirBackups, archivos[archivos.length - 1]);
      const viejo = new Date(Date.now() - 5 * 24 * 3600 * 1000);
      fs.utimesSync(ultimo, viejo, viejo);
      const cb = getChequeo((await pedirSalud()).body, 'backups');
      check('un backup de hace 5 días se marca en rojo', cb.severidad === 'rojo', cb.resumen);
      check('dice de cuántos días es', /día/.test(cb.resumen), cb.resumen);
      const ahora = new Date();
      fs.utimesSync(ultimo, ahora, ahora);
    } else {
      check('había backups para envejecer', false, 'la carpeta estaba vacía');
    }
  } else {
    check('la carpeta de backups existe después de arrancar el server', false, dirBackups);
  }

  // ── 8. Solo lectura ─────────────────────────────────────────────────────────
  // El panel avisa; la corrección la hace una persona. Si alguna vez alguien le agrega
  // un "arreglar solo", este test tiene que fallar.
  console.log('\n8. El panel no escribe nada\n');

  const antes = await q('SELECT (SELECT COUNT(*) FROM envios) e, (SELECT COUNT(*) FROM liquidaciones) l, (SELECT COUNT(*) FROM clientes) c, (SELECT COUNT(*) FROM factura_guias) f');
  await pedirSalud();
  await pedirSalud();
  const despues = await q('SELECT (SELECT COUNT(*) FROM envios) e, (SELECT COUNT(*) FROM liquidaciones) l, (SELECT COUNT(*) FROM clientes) c, (SELECT COUNT(*) FROM factura_guias) f');
  check('correr el panel dos veces no cambia ni una fila',
    JSON.stringify(antes[0]) === JSON.stringify(despues[0]),
    JSON.stringify(antes[0]) + ' vs ' + JSON.stringify(despues[0]));

  const metodos = await Promise.all(['POST', 'PATCH', 'DELETE', 'PUT'].map((m) =>
    fetch(BASE + '/api/salud', { method: m, headers: { cookie: `nova_session=${TOKEN}` } })
      .then((r) => `${m}:${r.status}`)));
  check('no hay ningún método de escritura expuesto',
    metodos.every((x) => x.endsWith(':404') || x.endsWith(':405')), metodos.join(' '));

  await close();
  matarSrv();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await esperarSrvMuerto();
  // Ni siquiera acá se llama process.exit(): matar el proceso a mano es lo que venía
  // reventando en Windows. Se deja el código de salida y Node termina solo cuando no le
  // queda nada pendiente, que es cuando ya no hay ningún handle a medio cerrar.
  // El timer es la red de seguridad por si algo quedara vivo (sockets keep-alive de
  // fetch, por ejemplo): va con .unref(), así NO sostiene el proceso —si no hay nada
  // más, Node sale igual al instante— y solo actúa si a los 3 s todavía sigue en pie.
  process.exitCode = (fail === 0 ? 0 : 1);
  setTimeout(() => process.exit((fail === 0 ? 0 : 1)), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
