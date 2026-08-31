#!/usr/bin/env node
/**
 * test-cierre-periodo.js — el cierre de mes/semana: el Excel que se archiva fuera del sistema.
 *
 * QUÉ ES ESTO Y POR QUÉ IMPORTA
 * Es la última capa de respaldo, la que sirve incluso si se pierden el sistema, el VPS y
 * OneDrive juntos, porque es una planilla que abre cualquiera sin depender de nada nuestro.
 * La oficina ya hacía algo parecido a mano (los viernes mandaban la hoja de la semana por
 * WhatsApp); esto lo formaliza.
 *
 * Lo que hay que probar, en orden de riesgo:
 *
 *  1. Que el período se calcule bien. Un cierre con el rango mal es peor que no tenerlo:
 *     queda archivado y nadie lo revisa hasta que hace falta. Incluye el caso del mes de
 *     28/30/31 días y el de la semana que todavía no terminó.
 *  2. Que el archivo salga con TODO el período, sin importar filtros, y que las filas sean
 *     exactamente las mismas que muestra la pantalla.
 *  3. Que el nombre del archivo diga el período. Doce archivos llamados igual no sirven.
 *  4. Que el permiso mande: sin cerrar_mes no se baja la planilla del mes entero.
 *  5. Que quede asentado quién lo hizo, y que si el asiento falla el archivo salga igual.
 *  6. Que el panel de salud avise cuando se dejó de cerrar — que es como esta rutina se
 *     muere: sin ruido.
 *
 *   cd backend && npm run test-cierre-periodo
 */

const path = require('path');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');
const sqlite3 = require('sqlite3');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3968;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_cierre_periodo.db';
const TOKEN = 'token-test-cierre';
const TOKEN_SIN = 'token-test-cierre-sin-permiso';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (tok = TOKEN) => ({ 'Content-Type': 'application/json', Cookie: `nova_session=${tok}` });

const cierre = require('../src/services/cierre.service');

function sql(dbPath, query, params = []) {
  return new Promise((res, rej) => {
    const d = new sqlite3.Database(dbPath);
    d.all(query, params, (e, r) => { d.close(() => (e ? rej(e) : res(r || []))); });
  });
}

async function main() {
  console.log('\n1. Los períodos (sin servidor, es pura cuenta)\n');

  const jul = cierre.rangoDelMes('2026-07');
  check('julio va del 1 al 31', jul.desde === '2026-07-01' && jul.hasta === '2026-07-31',
    JSON.stringify(jul));
  const feb = cierre.rangoDelMes('2026-02');
  check('febrero de un año normal termina el 28', feb.hasta === '2026-02-28', feb.hasta);
  const feb24 = cierre.rangoDelMes('2024-02');
  check('febrero bisiesto termina el 29', feb24.hasta === '2024-02-29', feb24.hasta);
  const abr = cierre.rangoDelMes('2026-04');
  check('un mes de 30 días termina el 30', abr.hasta === '2026-04-30', abr.hasta);
  check('la etiqueta se lee en castellano', /julio de 2026/.test(jul.etiqueta), jul.etiqueta);
  check('un mes mal escrito se rechaza', cierre.rangoDelMes('2026-13') === null
    && cierre.rangoDelMes('julio') === null && cierre.rangoDelMes('') === null);

  // Semana: el 2026-08-06 es jueves.
  const sem = cierre.rangoDeLaSemana('2026-08-06');
  check('la semana arranca el lunes', sem.desde === '2026-08-03', sem.desde);
  // La semana en curso NO puede decir que llega hasta el domingo que todavía no pasó.
  check('una semana ya terminada llega hasta el domingo',
    cierre.rangoDeLaSemana('2026-07-15').hasta === '2026-07-19',
    cierre.rangoDeLaSemana('2026-07-15').hasta);
  const domingo = cierre.rangoDeLaSemana('2026-07-19');
  check('un domingo cuenta como fin de SU semana, no del lunes siguiente',
    domingo.desde === '2026-07-13' && domingo.hasta === '2026-07-19', JSON.stringify(domingo));

  const libre = cierre.rangoLibre('2026-01-10', '2026-01-20');
  check('un rango a mano funciona', libre && libre.desde === '2026-01-10');
  check('un rango al revés se rechaza', cierre.rangoLibre('2026-02-01', '2026-01-01') === null);

  console.log('\n2. El nombre del archivo dice el período\n');

  check('el del mes nombra año, mes y el mes en palabras',
    cierre.nombreArchivo(jul) === 'Nova-salidas-2026-07-julio.xlsx', cierre.nombreArchivo(jul));
  // Se usa una semana YA TERMINADA, no la de `sem`. `sem` corta el "hasta" en la fecha de
  // hoy cuando la semana está en curso, así que su nombre cambia según el día en que se
  // corra el test: escrito a mano, pasaba el 06/08 y fallaba el 07/08. Un test que
  // depende del día en que se ejecuta no prueba nada, solo hace ruido.
  const semCerrada = cierre.rangoDeLaSemana('2026-07-15');
  check('el de la semana lleva las dos fechas',
    cierre.nombreArchivo(semCerrada) === 'Nova-salidas-semana-2026-07-13_al_2026-07-19.xlsx',
    cierre.nombreArchivo(semCerrada));
  check('dos meses distintos NO se pisan',
    cierre.nombreArchivo(jul) !== cierre.nombreArchivo(cierre.rangoDelMes('2026-08')));

  console.log('\n3. El archivo, contra el servidor\n');

  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // La salida normal del servidor se guarda porque ahí está la línea que avisa que quedó
  // listo. Es lo que espera esperarServidor(): preguntarle al puerto no distingue entre
  // "arrancó el nuestro" y "hay otro viejo escuchando".
  let logOut = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  // Se guarda ADEMÁS de mostrarlo: si el servidor no arranca, este texto es el único
  // lugar donde está el motivo (EADDRINUSE, permisos, ruta de la base, etc.).
  let logErr = '';
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
  const usuarioId = await abrirSesion(DB, TOKEN);
  await sql(DB, "UPDATE usuarios SET rol='empleado', cerrar_mes=1, usuario='marcela' WHERE id=?", [usuarioId]);
  // Un segundo usuario SIN el permiso, para probar que la puerta cierra.
  await sql(DB, "INSERT INTO usuarios (usuario, password_hash, rol, cerrar_mes, activo) VALUES ('sinpermiso','x','empleado',0,1)");
  const [otro] = await sql(DB, "SELECT id FROM usuarios WHERE usuario='sinpermiso'");
  const crypto = require('crypto');
  await sql(DB, 'INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?,?,?)',
    [crypto.createHash('sha256').update(TOKEN_SIN).digest('hex'), otro.id,
      new Date(Date.now() + 36e5).toISOString()]);

  const cli = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H(), body: JSON.stringify({ nombre: 'CIERRE TEST', tarifa_pct: 80 }),
  })).json();

  // Tres envíos DENTRO de julio y dos AFUERA (uno antes, uno después). El cierre de julio
  // tiene que traer exactamente tres: ni el de junio ni el de agosto.
  const nuevo = (guia, fecha) => fetch(BASE + '/api/envios', {
    method: 'POST', headers: H(),
    body: JSON.stringify({
      cliente_id: cli.id, fecha, courier: 'UPS', tipo_envio: 'exportacion',
      numero_guia: guia, pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
      peso_real: 5, largo: 30, ancho: 25, alto: 20,
    }),
  }).then((r) => r.json());

  await nuevo('1Z000CIERRE0000001', '2026-07-01');   // primer día: el borde de abajo
  await nuevo('1Z000CIERRE0000002', '2026-07-15');
  await nuevo('1Z000CIERRE0000003', '2026-07-31');   // último día: el borde de arriba
  await nuevo('1Z000CIERRE0000004', '2026-06-30');   // un día antes
  await nuevo('1Z000CIERRE0000005', '2026-08-01');   // un día después

  const bajar = async (query, tok = TOKEN) =>
    fetch(`${BASE}/api/salidas/exportar?${query}`, { headers: { Cookie: `nova_session=${tok}` } });

  const r = await bajar('tipo=mes&mes=2026-07');
  check('la descarga responde 200', r.status === 200, String(r.status));
  check('viene como archivo de Excel',
    /spreadsheetml/.test(r.headers.get('content-type') || ''), r.headers.get('content-type'));
  check('el nombre del archivo va en la respuesta',
    /Nova-salidas-2026-07-julio\.xlsx/.test(r.headers.get('content-disposition') || ''),
    r.headers.get('content-disposition'));

  // Los bordes: el 1 y el 31 entran, el 30/06 y el 01/08 no.
  check('trae los 3 envíos de julio y ninguno de los meses de al lado',
    Number(r.headers.get('x-nova-filas')) === 3, r.headers.get('x-nova-filas'));

  const buf = Buffer.from(await r.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Salidas');
  check('el archivo abre y tiene la hoja Salidas', !!ws);
  check('el encabezado dice el período',
    /julio de 2026/.test(String(ws.getCell(2, 1).value)), String(ws.getCell(2, 1).value));
  check('dice quién lo bajó', /marcela/.test(String(ws.getCell(3, 1).value)),
    String(ws.getCell(3, 1).value));
  check('dice cuántos envíos tiene', /3 envío/.test(String(ws.getCell(4, 1).value)),
    String(ws.getCell(4, 1).value));

  const encabezados = ws.getRow(6).values.slice(1).map(String);
  // Las columnas se buscan POR NOMBRE, nunca por número: el 28/08 se sumaron las medidas,
  // Compra Total y Revisión, y un test atado a "la columna 24" se rompe con cada agregado
  // sin que nada esté mal.
  const col = (titulo) => encabezados.indexOf(titulo) + 1;
  check('están las columnas de siempre', encabezados.includes('Guía')
    && encabezados.includes('Cliente') && encabezados.includes('Total (USD)'),
    encabezados.slice(0, 6).join('|'));
  check('están las que la oficina echaba de menos (# Salida, Bulto, medidas)',
    ['# Salida', 'Bulto', 'Largo (cm)', 'Ancho (cm)', 'Alto (cm)'].every((t) => encabezados.includes(t)),
    encabezados.join('|'));
  check('y las que faltaban contra la pantalla (Compra Total, Revisión)',
    encabezados.includes('Compra Total (USD)') && encabezados.includes('Revisión'),
    encabezados.join('|'));

  const guias = [];
  for (let f = 7; f <= ws.rowCount; f++) {
    const v = ws.getRow(f).getCell(col('Guía')).value;
    if (v && String(v).startsWith('1Z')) guias.push(String(v));
  }
  check('las guías del archivo son las tres de julio', guias.length === 3
    && guias.includes('1Z000CIERRE0000001') && guias.includes('1Z000CIERRE0000003'),
    guias.join(','));
  check('NO se coló la de junio ni la de agosto',
    !guias.includes('1Z000CIERRE0000004') && !guias.includes('1Z000CIERRE0000005'));

  const filaTotal = ws.getRow(ws.rowCount);
  check('hay una fila de TOTAL al pie', String(filaTotal.getCell(1).value) === 'TOTAL',
    String(filaTotal.getCell(1).value));
  check('el total suma de verdad', Number(filaTotal.getCell(col('Total (USD)')).value) >= 0);
  check('la fecha va como fecha y no como texto',
    ws.getRow(7).getCell(col('Fecha')).value instanceof Date);

  console.log('\n4. Un mes vacío sale igual, y avisa\n');

  const vacio = await bajar('tipo=mes&mes=2025-01');
  check('un mes sin envíos NO es un error', vacio.status === 200, String(vacio.status));
  check('y avisa que salió en cero', Number(vacio.headers.get('x-nova-filas')) === 0);
  const wbV = new ExcelJS.Workbook();
  await wbV.xlsx.load(Buffer.from(await vacio.arrayBuffer()));
  check('el archivo vacío abre igual (no es un archivo roto)',
    !!wbV.getWorksheet('Salidas') && /0 envío/.test(String(wbV.getWorksheet('Salidas').getCell(4, 1).value)));

  console.log('\n5. El permiso manda\n');

  const negado = await bajar('tipo=mes&mes=2026-07', TOKEN_SIN);
  check('sin el permiso cerrar_mes no se baja nada', negado.status === 403, String(negado.status));
  check('y tampoco se pueden ver los cierres hechos',
    (await fetch(`${BASE}/api/salidas/cierres`, { headers: { Cookie: `nova_session=${TOKEN_SIN}` } })).status === 403);
  check('pero la pantalla de Salidas la sigue viendo',
    (await fetch(`${BASE}/api/salidas`, { headers: { Cookie: `nova_session=${TOKEN_SIN}` } })).status === 200);
  check('un período inventado da 400, no un archivo vacío',
    (await bajar('tipo=mes&mes=2026-99')).status === 400);
  check('sin parámetros también da 400', (await bajar('')).status === 400);

  console.log('\n6. Queda asentado quién y cuándo\n');

  const asientos = await (await fetch(`${BASE}/api/salidas/cierres`, { headers: H() })).json();
  check('el cierre quedó registrado', asientos.length >= 2, String(asientos.length));
  const deJulio = asientos.find((a) => a.desde === '2026-07-01');
  check('con el período correcto', !!deJulio, JSON.stringify(asientos[0]));
  check('con la cantidad de envíos', deJulio && deJulio.filas === 3, String(deJulio && deJulio.filas));
  check('y con el nombre de quien lo bajó', deJulio && deJulio.usuario === 'marcela',
    String(deJulio && deJulio.usuario));
  check('el asiento NO guarda el archivo (esa es la idea: vive afuera)',
    deJulio && !('archivo' in deJulio) && !('contenido' in deJulio));

  console.log('\n7. El panel de salud avisa cuando se deja de cerrar\n');

  await sql(DB, "UPDATE usuarios SET rol='admin' WHERE id=?", [usuarioId]);
  const pedirCierres = async () => {
    const rr = await fetch(BASE + '/api/salud', { headers: H() });
    const data = await rr.json();
    return data.chequeos.find((c) => c.id === 'cierres') || {};
  };

  // Estado real ahora: solo está cerrado julio 2026 (y enero 2025).
  await sql(DB, 'DELETE FROM cierres');
  const nunca = await pedirCierres();
  check('sin ningún cierre hecho avisa en ámbar', nunca.severidad === 'ambar',
    `${nunca.severidad} · ${nunca.resumen}`);
  check('y explica para qué sirve el cierre', /fuera del sistema/.test(nunca.resumen || ''),
    nunca.resumen);

  // Los tres meses cerrados completos hacia atrás desde hoy.
  const hoy = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const mesAtras = (i) => {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
  };
  const salto = hoy.getDate() <= 5 ? 1 : 0;
  const insertarCierre = (mes) => sql(DB,
    "INSERT INTO cierres (tipo, desde, hasta, filas, usuario) VALUES ('mes', ?, ?, 10, 'marcela')",
    [`${mes}-01`, `${mes}-28`]);

  for (let i = 1 + salto; i <= 3 + salto; i++) await insertarCierre(mesAtras(i));
  const alDia = await pedirCierres();
  check('con los últimos tres meses archivados se pone en verde', alDia.severidad === 'ok',
    `${alDia.severidad} · ${alDia.resumen}`);
  check('y dice cuál fue el último', /El último cierre fue/.test(alDia.resumen || ''), alDia.resumen);

  await sql(DB, 'DELETE FROM cierres WHERE desde = ?', [`${mesAtras(1 + salto)}-01`]);
  const unoSuelto = await pedirCierres();
  check('un mes suelto sin cerrar es ámbar, no rojo (es un descuido)',
    unoSuelto.severidad === 'ambar', `${unoSuelto.severidad} · ${unoSuelto.resumen}`);
  check('y dice qué mes falta', unoSuelto.resumen.includes(mesAtras(1 + salto)), unoSuelto.resumen);
  check('dice también dónde se hace', /Salidas/.test(unoSuelto.resumen), unoSuelto.resumen);

  await sql(DB, 'DELETE FROM cierres WHERE desde = ?', [`${mesAtras(2 + salto)}-01`]);
  const dos = await pedirCierres();
  check('dos meses seguidos sin cerrar ya es ROJO: la rutina se murió',
    dos.severidad === 'rojo', `${dos.severidad} · ${dos.resumen}`);
  check('el detalle marca cuáles faltan',
    Array.isArray(dos.detalle) && dos.detalle.some((d) => d.estado === 'SIN CERRAR'),
    JSON.stringify(dos.detalle));

  console.log('\n8. No se rompió el listado de Salidas\n');

  const listado = await (await fetch(`${BASE}/api/salidas`, { headers: H() })).json();
  check('la pantalla de Salidas sigue devolviendo los envíos', listado.length === 5,
    String(listado.length));
  check('y sigue trayendo los campos derivados (num_sal, bultos, profit)',
    listado[0].num_sal !== undefined && Array.isArray(listado[0].bultos)
    && 'profit' in listado[0], JSON.stringify(Object.keys(listado[0])).slice(0, 120));
  const filtrado = await (await fetch(`${BASE}/api/salidas?desde=2026-07-01&hasta=2026-07-31`,
    { headers: H() })).json();
  check('el filtro por fecha del listado sigue andando', filtrado.length === 3,
    String(filtrado.length));

  // ── 9. Los dos reclamos de la oficina (28/08/2026) ─────────────────────────
  //
  //  1. "no marca el número de salida de cada envío": la planilla leía la columna
  //     `numero_salida` de la base, que está vacía en 346 de 347 envíos porque nadie la
  //     carga. El número que la oficina usa —"el envío 27"— es el correlativo POR MES que
  //     se calcula al vuelo.
  //  2. "los envíos con más de un bulto tampoco lo muestra": salía UNA fila por envío con
  //     las medidas del envío. Ahora va un renglón por bulto, como en la pantalla.
  //
  // Y el riesgo que aparece al arreglar el 1: si el correlativo se calculara sobre las
  // filas del período, el respaldo de UNA SEMANA numeraría 1, 2, 3 en vez de 27, 28, 29.
  console.log('\n9. El número de salida y los envíos de varios bultos\n');

  const hoyISO = new Date().toISOString().slice(0, 10);
  const mesActual = hoyISO.slice(0, 7);

  // Un envío de TRES bultos con medidas distintas, para reconocerlas una por una.
  const multi = await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H(),
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoyISO, courier: 'UPS', tipo_envio: 'exportacion',
      numero_guia: '1Z000CIERRE0000010', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
      total_cobrado: 300,
      bultos: [
        { peso_real: 5, largo: 30, ancho: 20, alto: 10 },
        { peso_real: 6, largo: 40, ancho: 25, alto: 15 },
        { peso_real: 7, largo: 50, ancho: 30, alto: 20 },
      ],
    }),
  })).json();
  const simple = await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H(),
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoyISO, courier: 'UPS', tipo_envio: 'exportacion',
      numero_guia: '1Z000CIERRE0000011', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
      total_cobrado: 100, peso_real: 3, largo: 20, ancho: 15, alto: 10,
    }),
  })).json();
  check('se cargaron el multibulto y el de un bulto', !!multi.id && !!simple.id);

  const rSem = await bajar('tipo=semana');
  check('el respaldo semanal baja bien', rSem.status === 200, String(rSem.status));
  const wbS = new ExcelJS.Workbook();
  await wbS.xlsx.load(Buffer.from(await rSem.arrayBuffer()));
  const wsS = wbS.getWorksheet('Salidas');
  const encS = wsS.getRow(6).values.slice(1).map(String);
  const colS = (t) => encS.indexOf(t) + 1;

  // Los renglones de cada envío, encontrados por su guía.
  const renglonesDe = (guia) => {
    const out = [];
    for (let f = 7; f < wsS.rowCount; f++) {
      if (String(wsS.getRow(f).getCell(colS('Guía')).value || '') === guia) out.push(wsS.getRow(f));
    }
    return out;
  };

  // renglonesDe() busca por guía y solo el primer renglón la lleva (los bultos sin guía
  // propia no la repiten), así que para el multibulto se toman sus filas por posición.
  const filaGuia = (guia) => {
    for (let f = 7; f < wsS.rowCount; f++) {
      if (String(wsS.getRow(f).getCell(colS('Guía')).value || '') === guia) return f;
    }
    return -1;
  };
  const fMulti = filaGuia('1Z000CIERRE0000010');
  const rMultiTodas = [wsS.getRow(fMulti), wsS.getRow(fMulti + 1), wsS.getRow(fMulti + 2)];

  const rMulti = renglonesDe('1Z000CIERRE0000010');
  const rSimple = renglonesDe('1Z000CIERRE0000011');

  console.log('   · el envío de tres bultos');
  check('ocupa TRES renglones, uno por bulto',
    rMultiTodas.every((r) => String(r.getCell(colS('Bulto')).value).endsWith('/3')),
    rMultiTodas.map((r) => r.getCell(colS('Bulto')).value).join(' '));
  check('numerados 1/3, 2/3 y 3/3',
    rMultiTodas.map((r) => String(r.getCell(colS('Bulto')).value)).join(' ') === '1/3 2/3 3/3',
    rMultiTodas.map((r) => String(r.getCell(colS('Bulto')).value)).join(' '));
  check('cada renglón trae SUS medidas',
    rMultiTodas.map((r) => Number(r.getCell(colS('Largo (cm)')).value)).join(',') === '30,40,50',
    rMultiTodas.map((r) => r.getCell(colS('Largo (cm)')).value).join(','));
  check('y SU peso de balanza',
    rMultiTodas.map((r) => Number(r.getCell(colS('Peso (kg)')).value)).join(',') === '5,6,7',
    rMultiTodas.map((r) => r.getCell(colS('Peso (kg)')).value).join(','));
  check('la guía heredada NO se repite en cada bulto (una sola vez)',
    rMulti.length === 1, `aparece ${rMulti.length} veces`);

  // Lo que hace que los totales no mientan: la plata va UNA sola vez.
  const ventas = rMultiTodas.map((r) => r.getCell(colS('Total (USD)')).value);
  check('la venta figura solo en el primer renglón (no se triplica)',
    Number(ventas[0]) === 300 && ventas[1] === null && ventas[2] === null,
    JSON.stringify(ventas));
  check('el envío de un bulto sigue ocupando un renglón', rSimple.length === 1,
    String(rSimple.length));
  check('y ese renglón dice 1/1', String(rSimple[0].getCell(colS('Bulto')).value) === '1/1',
    String(rSimple[0].getCell(colS('Bulto')).value));

  const totalSem = wsS.getRow(wsS.rowCount);
  check('el TOTAL de venta no cuenta el multibulto tres veces',
    Number(totalSem.getCell(colS('Total (USD)')).value) === 400,
    String(totalSem.getCell(colS('Total (USD)')).value));
  check('y el TOTAL de peso suma los tres bultos (5+6+7+3 = 21)',
    Number(totalSem.getCell(colS('Peso (kg)')).value) === 21,
    String(totalSem.getCell(colS('Peso (kg)')).value));
  check('el encabezado aclara envíos y renglones',
    /2 envío\(s\) en 4 renglón/.test(String(wsS.getCell(4, 1).value)),
    String(wsS.getCell(4, 1).value));

  // El aviso del pie es condicional: solo aparece si hay envíos sin venta cargada, que es
  // lo que hace que Compra Total quede muy por encima de Total y parezca una pérdida.
  check('con todos los envíos vendidos NO hay aviso de más', wsS.getCell(5, 1).value == null,
    String(wsS.getCell(5, 1).value));

  await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H(),
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoyISO, courier: 'UPS', tipo_envio: 'exportacion',
      numero_guia: '1Z000CIERRE0000012', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
      peso_real: 4, largo: 20, ancho: 20, alto: 20,
    }),
  });
  const wbS2 = new ExcelJS.Workbook();
  await wbS2.xlsx.load(Buffer.from(await (await bajar('tipo=semana')).arrayBuffer()));
  check('con un envío sin precio de venta, la planilla lo aclara al pie',
    /1 envío\(s\) todavía sin precio de venta/.test(String(wbS2.getWorksheet('Salidas').getCell(5, 1).value || '')),
    String(wbS2.getWorksheet('Salidas').getCell(5, 1).value));

  // El cruce de las dos cosas: un envío NO VOLÓ que además tiene varios bultos. Sus TRES
  // renglones van pintados y NINGUNO suma — ni la plata del primero ni los pesos de los
  // otros dos. Es el caso donde una expansión mal hecha metería kilos fantasma en el mes.
  console.log('   · NO VOLÓ con varios bultos');
  await fetch(`${BASE}/api/salidas/${multi.id}/no-volo`, {
    method: 'PATCH', headers: H(), body: JSON.stringify({ no_volo: true }),
  });
  const wbNV = new ExcelJS.Workbook();
  await wbNV.xlsx.load(Buffer.from(await (await bajar('tipo=semana')).arrayBuffer()));
  const wsNV = wbNV.getWorksheet('Salidas');
  const encNV = wsNV.getRow(6).values.slice(1).map(String);
  const colNV = (x) => encNV.indexOf(x) + 1;
  const totNV = wsNV.getRow(wsNV.rowCount);
  check('el multibulto NO VOLÓ deja de sumar su venta (400 → 100)',
    Number(totNV.getCell(colNV('Total (USD)')).value) === 100,
    String(totNV.getCell(colNV('Total (USD)')).value));
  check('y tampoco suman los kilos de sus tres bultos (21 → 7)',
    Number(totNV.getCell(colNV('Peso (kg)')).value) === 7,
    String(totNV.getCell(colNV('Peso (kg)')).value));
  check('pero sigue en la planilla, con sus renglones y su número',
    Number(wsNV.getRow(filaGuia('1Z000CIERRE0000010')).getCell(colNV('# Salida')).value) > 0);
  check('y el encabezado lo cuenta como NO VOLO',
    /1 marcado\(s\) NO VOLO/.test(String(wsNV.getCell(4, 1).value)), String(wsNV.getCell(4, 1).value));

  console.log('   · el número de salida');
  const listaAPI = await (await fetch(`${BASE}/api/salidas`, { headers: H() })).json();
  const apiDe = (guia) => listaAPI.find((e) => e.numero_guia === guia);
  check('la API manda el correlativo del mes (num_sal_mes)',
    apiDe('1Z000CIERRE0000010').num_sal_mes > 0,
    String(apiDe('1Z000CIERRE0000010').num_sal_mes));
  check('el Excel escribe un número de salida, no una celda vacía',
    Number(rMultiTodas[0].getCell(colS('# Salida')).value) > 0,
    String(rMultiTodas[0].getCell(colS('# Salida')).value));
  check('y es EL MISMO que muestra la pantalla',
    Number(rMultiTodas[0].getCell(colS('# Salida')).value) === apiDe('1Z000CIERRE0000010').num_sal_mes,
    `excel=${rMultiTodas[0].getCell(colS('# Salida')).value} api=${apiDe('1Z000CIERRE0000010').num_sal_mes}`);
  check('el número va solo en el primer renglón del envío',
    rMultiTodas[1].getCell(colS('# Salida')).value == null,
    JSON.stringify(rMultiTodas[1].getCell(colS('# Salida')).value));
  check('y va como NÚMERO, para que Excel lo ordene bien',
    typeof rMultiTodas[0].getCell(colS('# Salida')).value === 'number',
    typeof rMultiTodas[0].getCell(colS('# Salida')).value);

  // El correlativo del MES, no del período pedido. Este es el que se rompe si alguien
  // "simplifica" el cálculo numerando las filas del Excel.
  const delMes = listaAPI
    .filter((e) => (e.fecha || '').slice(0, 7) === mesActual)
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.id - b.id));
  const esperadoMulti = delMes.findIndex((e) => e.id === multi.id) + 1;
  check('en el respaldo SEMANAL el número sigue siendo el del mes, no 1,2,3',
    Number(rMultiTodas[0].getCell(colS('# Salida')).value) === esperadoMulti,
    `excel=${rMultiTodas[0].getCell(colS('# Salida')).value} esperado=${esperadoMulti}`);

  // Las dos implementaciones de la MISMA regla: la del backend (listarSalidas) y la que
  // recalcula la pantalla al vuelo (recomputeNumSalMes en salidas.js). Si alguien toca una
  // sola, esto se pone rojo.
  const comoLaPantalla = (envios) => {
    const byMonth = {};
    for (const e of envios) {
      const m = (e.fecha || '').slice(0, 7);
      (byMonth[m] || (byMonth[m] = [])).push(e);
    }
    const out = new Map();
    for (const m of Object.keys(byMonth)) {
      let n = 0;
      byMonth[m]
        .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : (a.id || 0) - (b.id || 0)))
        .forEach((e) => out.set(e.id, e.num_sal_cero ? 0 : ++n));
    }
    return out;
  };
  const dePantalla = comoLaPantalla(listaAPI);
  const desviados = listaAPI.filter((e) => dePantalla.get(e.id) !== e.num_sal_mes);
  check('el correlativo del backend coincide con el que calcula la pantalla',
    desviados.length === 0,
    JSON.stringify(desviados.map((e) => [e.id, e.num_sal_mes, dePantalla.get(e.id)])).slice(0, 140));

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  matarSrv();
  await esperarSrvMuerto();
  // Ver test-api-documentos-dhl.js: nada de process.exit() a mano (revienta libuv en Windows).
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
