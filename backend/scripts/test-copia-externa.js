#!/usr/bin/env node
/**
 * test-copia-externa.js — la copia de la base que sale del VPS, y el aviso cuando se corta.
 *
 * POR QUÉ ESTE TEST EXISTE
 * Todo backup falla de la misma manera: en silencio. Deja de correr un martes, nadie se
 * entera, y se descubre tres meses después cuando hay que restaurar. Las dos piezas que
 * evitan eso son las que se prueban acá:
 *
 *   1. verificar-backup.js — abre el archivo y decide si sirve REALMENTE para restaurar.
 *      Se prueba plantando backups rotos a propósito: vacío, truncado, que no es una base,
 *      íntegro pero sin datos, y al que le faltan filas contra producción. El truncado es
 *      el importante: pesa, tiene fecha de hoy y se ve perfecto en un `ls`.
 *
 *   2. El chequeo del panel de salud — que lea la marca que deja el script y ponga ROJO
 *      cuando la copia externa falló o dejó de correr. Antes este chequeo avisaba en
 *      ámbar permanente, y un aviso encendido siempre es un aviso que nadie mira.
 *
 * Lo que NO prueba: que rclone suba a OneDrive de verdad. Eso depende de una cuenta y se
 * verifica a mano una vez, cuando se configura.
 *
 *   cd backend && npm run test-copia-externa
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3969;
const BASE = `http://localhost:${PORT}`;
const DIR = '/tmp/nova-copia-externa-test';
const DB = path.join(DIR, 'nova.db');
const DIR_BACKUPS = path.join(DIR, 'backups');
const MARCA = path.join(DIR_BACKUPS, '.copia-externa.json');
const TOKEN = 'token-test-copia-externa';
const VERIFICADOR = path.join(__dirname, 'verificar-backup.js');

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Corre el verificador y devuelve { sirve, problemas } sin que el exit 1 tumbe el test.
function verificar(archivo, contra) {
  const args = [VERIFICADOR, archivo, '--json'];
  if (contra) args.push('--contra', contra);
  try {
    return { salida: JSON.parse(execFileSync('node', args, { encoding: 'utf8' }).trim()), codigo: 0 };
  } catch (e) {
    const txt = String(e.stdout || '').trim();
    let salida = null;
    try { salida = JSON.parse(txt); } catch { /* el verificador murió sin decir nada */ }
    return { salida, codigo: e.status === undefined ? -1 : e.status };
  }
}

function escribirMarca(obj) {
  fs.writeFileSync(MARCA, JSON.stringify(obj, null, 2));
}
const haceHoras = (h) => new Date(Date.now() - h * 3600000).toISOString();

async function main() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR_BACKUPS, { recursive: true });
  prepararDb(DB);

  console.log('\n1. El verificador acepta un backup bueno\n');

  const bueno = path.join(DIR, 'bueno.db');
  fs.copyFileSync(DB, bueno);
  const rBueno = verificar(bueno, DB);
  check('un backup sano pasa', rBueno.salida && rBueno.salida.sirve === true,
    JSON.stringify(rBueno.salida && rBueno.salida.problemas));
  check('y sale con código 0', rBueno.codigo === 0, `código ${rBueno.codigo}`);
  check('informa la integridad', rBueno.salida && rBueno.salida.integridad === 'ok');
  check('informa cuántas filas tiene de cada tabla clave',
    rBueno.salida && typeof rBueno.salida.filas.envios === 'number' &&
    typeof rBueno.salida.filas.clientes === 'number');

  console.log('\n2. Y rechaza los rotos, que es para lo que sirve\n');

  const vacio = path.join(DIR, 'vacio.db');
  fs.writeFileSync(vacio, '');
  check('un archivo de 0 bytes lo rechaza', verificar(vacio).salida.sirve === false);

  const noEsBase = path.join(DIR, 'noesbase.db');
  fs.writeFileSync(noEsBase, 'Error 502 Bad Gateway. Esto no es una base de datos.');
  const rNoEs = verificar(noEsBase);
  check('un archivo que no es SQLite lo rechaza', rNoEs.salida.sirve === false);
  check('y lo dice con esas palabras',
    rNoEs.salida.problemas.some((p) => /no es una base SQLite/.test(p)),
    JSON.stringify(rNoEs.salida.problemas));

  // El caso que importa: pesa, tiene fecha de hoy, se ve perfecto en un `ls`.
  const truncado = path.join(DIR, 'truncado.db');
  const entero = fs.readFileSync(DB);
  fs.writeFileSync(truncado, entero.subarray(0, Math.floor(entero.length / 2)));
  const rTrunc = verificar(truncado);
  check('un backup truncado a la mitad lo rechaza', rTrunc.salida.sirve === false);
  check('el truncado pesa y parece sano por fuera (por eso hace falta abrirlo)',
    fs.statSync(truncado).size > 50000);
  check('sale con código 1, que es lo que frena la subida', rTrunc.codigo === 1, `código ${rTrunc.codigo}`);

  const inexistente = verificar(path.join(DIR, 'no_existe_nada.db'));
  check('un archivo que no existe lo rechaza', inexistente.salida.sirve === false);

  console.log('\n3. Íntegro pero inservible\n');

  // Una base vacía pasa el integrity_check con honores. No sirve como respaldo.
  const vaciaPeroSana = path.join(DIR, 'sana_vacia.db');
  fs.copyFileSync(DB, vaciaPeroSana);
  await new Promise((res, rej) => {
    const d = new sqlite3.Database(vaciaPeroSana);
    d.run('DELETE FROM envios', (e) => (e ? rej(e) : d.close(() => res())));
  });
  const rVacia = verificar(vaciaPeroSana);
  check('una base íntegra pero con envios vacío NO se da por buena',
    rVacia.salida.sirve === false, JSON.stringify(rVacia.salida.problemas));
  check('la integridad da ok igual (por eso no alcanza con integrity_check)',
    rVacia.salida.integridad === 'ok');

  // Y el caso feo: un backup que quedó a mitad de camino.
  const incompleto = path.join(DIR, 'incompleto.db');
  fs.copyFileSync(DB, incompleto);
  await new Promise((res, rej) => {
    const d = new sqlite3.Database(incompleto);
    d.run('DELETE FROM envios WHERE id > (SELECT MIN(id) + 2 FROM envios)',
      (e) => (e ? rej(e) : d.close(() => res())));
  });
  const rInc = verificar(incompleto, DB);
  check('un backup al que le faltan filas contra producción lo agarra',
    rInc.salida.sirve === false, JSON.stringify(rInc.salida.problemas));
  check('sin --contra ese mismo archivo pasaría (por eso se compara)',
    verificar(incompleto).salida.sirve === true);

  console.log('\n4. El panel de salud y la copia externa\n');

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
  await abrirSesion(DB, TOKEN);
  // El panel pide permiso: se fuerza admin para que el test hable del chequeo y no del login.
  await new Promise((res) => {
    const d = new sqlite3.Database(DB);
    d.run("UPDATE usuarios SET rol='admin' WHERE id=(SELECT usuario_id FROM sesiones LIMIT 1)",
      () => d.close(() => res()));
  });

  const pedirBackups = async () => {
    const r = await fetch(BASE + '/api/salud', { headers: { cookie: `nova_session=${TOKEN}` } });
    if (r.status !== 200) return { httpStatus: r.status };
    const data = await r.json();
    return data.chequeos.find((c) => c.id === 'backups') || {};
  };

  // El servidor hace un backup al arrancar, así que la parte local está sana.
  const sinMarca = await pedirBackups();
  check('sin copia externa configurada queda en ámbar', sinMarca.severidad === 'ambar',
    `${sinMarca.severidad} · ${sinMarca.resumen}`);
  check('y lo dice con todas las letras',
    /No hay copia fuera del VPS/.test(sinMarca.resumen || ''), sinMarca.resumen);

  escribirMarca({ ok: true, cuando: haceHoras(2), archivo: 'nova_backup_x.db.gz', tamano_kb: 21, destino: 'onedrive:Nova Backups', copias_remotas: 47, error: null });
  const conMarca = await pedirBackups();
  check('con la copia externa al día se pone en verde', conMarca.severidad === 'ok',
    `${conMarca.severidad} · ${conMarca.resumen}`);
  check('dice cuántas copias hay afuera y de cuándo',
    /47 copia\(s\)/.test(conMarca.resumen) && /2 h/.test(conMarca.resumen), conMarca.resumen);

  escribirMarca({ ok: true, cuando: haceHoras(24), archivo: 'x.gz', tamano_kb: 21, destino: 'onedrive:Nova Backups', copias_remotas: 47, error: null });
  check('un atraso normal de un día NO dispara falsa alarma',
    (await pedirBackups()).severidad === 'ok');

  // Lo que este test viene a cubrir: que dejar de correr se vea.
  escribirMarca({ ok: true, cuando: haceHoras(24 * 6), archivo: 'x.gz', tamano_kb: 21, destino: 'onedrive:Nova Backups', copias_remotas: 47, error: null });
  const cortada = await pedirBackups();
  check('si dejó de correr hace 6 días se pone en ROJO', cortada.severidad === 'rojo',
    `${cortada.severidad} · ${cortada.resumen}`);
  check('y dice hace cuántos días', /6 día\(s\)/.test(cortada.resumen), cortada.resumen);

  escribirMarca({ ok: false, cuando: haceHoras(1), archivo: '', tamano_kb: 0, destino: 'onedrive:Nova Backups', copias_remotas: 0, error: 'rclone no pudo subir el archivo' });
  const fallada = await pedirBackups();
  check('si la última corrida falló se pone en ROJO', fallada.severidad === 'rojo',
    `${fallada.severidad} · ${fallada.resumen}`);
  check('y muestra el motivo del fallo', /rclone no pudo subir/.test(fallada.resumen), fallada.resumen);

  fs.writeFileSync(MARCA, '{esto no es json');
  const rota = await pedirBackups();
  check('una marca ilegible se trata como fallo, no como éxito', rota.severidad === 'rojo',
    `${rota.severidad} · ${rota.resumen}`);

  fs.unlinkSync(MARCA);
  check('si se borra la marca vuelve al ámbar de antes',
    (await pedirBackups()).severidad === 'ambar');

  console.log('\n5. No se rompió el chequeo que ya existía\n');

  escribirMarca({ ok: true, cuando: haceHoras(1), archivo: 'x.gz', tamano_kb: 21, destino: 'onedrive:Nova Backups', copias_remotas: 47, error: null });
  const conLocales = await pedirBackups();
  check('sigue contando los backups locales del VPS', Number(conLocales.cantidad) > 0,
    String(conLocales.cantidad));
  check('sigue listando los archivos con tamaño y fecha',
    Array.isArray(conLocales.detalle) && conLocales.detalle.length > 0 &&
    conLocales.detalle[0].tamano_kb !== undefined);

  // Backup local viejo + copia externa al día: el rojo local tiene que seguir mandando.
  for (const f of fs.readdirSync(DIR_BACKUPS).filter((x) => x.startsWith('nova_backup_'))) {
    const p = path.join(DIR_BACKUPS, f);
    const viejo = new Date(Date.now() - 48 * 3600000);
    fs.utimesSync(p, viejo, viejo);
  }
  const localViejo = await pedirBackups();
  check('un backup local viejo sigue dando rojo aunque la copia externa esté bien',
    localViejo.severidad === 'rojo', `${localViejo.severidad} · ${localViejo.resumen}`);
  check('y el resumen habla de las dos cosas por separado',
    /día\(s\) de antigüedad/.test(localViejo.resumen) && /Copia fuera del VPS OK/.test(localViejo.resumen),
    localViejo.resumen);

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  matarSrv();
  await esperarSrvMuerto();
  // Ver test-api-documentos-dhl.js: nada de process.exit() a mano en Windows.
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
