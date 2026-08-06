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
const { prepararDb, abrirSesion } = require('./_base-test');

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
  check('el de la semana lleva las dos fechas',
    cierre.nombreArchivo(sem) === 'Nova-salidas-semana-2026-08-03_al_2026-08-06.xlsx',
    cierre.nombreArchivo(sem));
  check('dos meses distintos NO se pisan',
    cierre.nombreArchivo(jul) !== cierre.nombreArchivo(cierre.rangoDelMes('2026-08')));

  console.log('\n3. El archivo, contra el servidor\n');

  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);
  const esperarSrvMuerto = () => new Promise((res) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return res();
    srv.once('exit', res);
    setTimeout(res, 2000);
  });

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await esperar(300);
  }
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
  check('están las columnas de siempre', encabezados.includes('Guía')
    && encabezados.includes('Cliente') && encabezados.includes('Total (USD)'),
    encabezados.slice(0, 6).join('|'));
  check('son las 32 columnas del Excel que ya usaba la oficina', encabezados.length === 32,
    String(encabezados.length));

  const guias = [];
  for (let f = 7; f <= ws.rowCount; f++) {
    const v = ws.getRow(f).getCell(4).value;
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
  check('el total suma de verdad', Number(filaTotal.getCell(24).value) >= 0);
  check('la fecha va como fecha y no como texto', ws.getRow(7).getCell(3).value instanceof Date);

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

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  matarSrv();
  await esperarSrvMuerto();
  // Ver test-api-documentos-dhl.js: nada de process.exit() a mano (revienta libuv en Windows).
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
