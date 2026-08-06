#!/usr/bin/env node
/**
 * verificar-backup.js — dice si un archivo de backup sirve REALMENTE para restaurar.
 *
 * POR QUÉ EXISTE
 * Un backup roto se ve exactamente igual que uno bueno en un `ls`: el archivo está, pesa
 * algo, tiene fecha de hoy. La diferencia aparece el día que hay que restaurarlo, que es
 * el peor día posible para enterarse. Esto lo abre y lo revisa antes de que sea la única
 * copia que queda.
 *
 * QUÉ MIRA, de más barato a más caro:
 *
 *  1. Que exista y no esté vacío.
 *  2. Que SQLite lo pueda abrir (un archivo truncado a la mitad falla acá).
 *  3. PRAGMA integrity_check — recorre las páginas y los índices. Es la prueba de fondo.
 *  4. Que estén las tablas que importan y que tengan filas. Una base íntegra pero vacía
 *     pasa el integrity_check con honores y no sirve para nada.
 *  5. Opcional (--contra <base_viva>): que no le falten filas contra la base de
 *     producción. Es el chequeo que agarra el caso feo — el backup que se hizo bien pero
 *     de una base equivocada, o que quedó a mitad de camino.
 *
 * USO
 *   node scripts/verificar-backup.js <archivo.db>
 *   node scripts/verificar-backup.js <archivo.db> --contra /ruta/nova.db
 *   node scripts/verificar-backup.js <archivo.db> --json
 *
 * Sale con 0 si el backup sirve, 1 si no. El script de la copia externa se apoya en eso:
 * si esto falla, NO sube el archivo, para no pisar una copia buena con una rota.
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

// Las tablas sin las cuales el sistema no es el sistema. Si alguna de estas no está o
// quedó en cero, el archivo no sirve como respaldo aunque SQLite lo dé por sano.
const TABLAS_CLAVE = ['clientes', 'envios', 'usuarios'];

// Tablas que tienen que existir pero que pueden estar legítimamente vacías (una oficina
// que todavía no liquidó nada, por ejemplo).
const TABLAS_PRESENTES = ['liquidaciones'];

// Cuánto puede encoger el backup contra la base viva sin que sea sospechoso. Entre que
// se hace la copia y que se cuenta la base pueden entrar envíos nuevos, así que el
// backup siempre tiene *igual o menos*. Lo que no puede es faltarle un pedazo grande.
const TOLERANCIA_FILAS = 0.98;

const args = process.argv.slice(2);
const modoJson = args.includes('--json');
const idxContra = args.indexOf('--contra');
const dbContra = idxContra !== -1 ? args[idxContra + 1] : null;
const archivo = args.find((a) => !a.startsWith('--') && a !== dbContra);

const problemas = [];
const detalle = {};

function abrir(ruta) {
  return new Promise((resolve, reject) => {
    const d = new sqlite3.Database(ruta, sqlite3.OPEN_READONLY, (err) => {
      if (err) reject(err);
      else resolve(d);
    });
  });
}
const todas = (d, sql) => new Promise((res, rej) => d.all(sql, [], (e, r) => (e ? rej(e) : res(r || []))));
const cerrar = (d) => new Promise((res) => d.close(() => res()));

async function contarTablas(ruta) {
  const d = await abrir(ruta);
  try {
    const tablas = (await todas(d, "SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name);
    const conteos = {};
    for (const t of [...TABLAS_CLAVE, ...TABLAS_PRESENTES]) {
      if (!tablas.includes(t)) { conteos[t] = null; continue; }
      const [{ n }] = await todas(d, `SELECT COUNT(*) AS n FROM "${t}"`);
      conteos[t] = n;
    }
    return { tablas, conteos };
  } finally {
    await cerrar(d);
  }
}

async function main() {
  if (!archivo) {
    console.error('Uso: node scripts/verificar-backup.js <archivo.db> [--contra <base_viva>] [--json]');
    process.exit(2);
  }

  // ── 1. El archivo ────────────────────────────────────────────────────────
  if (!fs.existsSync(archivo)) {
    problemas.push(`el archivo no existe: ${archivo}`);
    return terminar();
  }
  const st = fs.statSync(archivo);
  detalle.archivo = path.basename(archivo);
  detalle.tamano_kb = Math.round(st.size / 1024);
  detalle.fecha = st.mtime.toISOString().slice(0, 19).replace('T', ' ');
  if (st.size === 0) {
    problemas.push('el archivo está vacío (0 bytes)');
    return terminar();
  }
  // Una base SQLite arranca siempre con esta firma. Si no está, ni vale la pena abrirla:
  // suele ser un archivo a medio escribir o un HTML de error que quedó con nombre .db.
  const cabecera = Buffer.alloc(16);
  const fd = fs.openSync(archivo, 'r');
  fs.readSync(fd, cabecera, 0, 16, 0);
  fs.closeSync(fd);
  if (cabecera.toString('utf8', 0, 15) !== 'SQLite format 3') {
    problemas.push('el archivo no es una base SQLite (la cabecera no coincide)');
    return terminar();
  }

  // ── 2 y 3. Que abra y que esté íntegro ───────────────────────────────────
  let d;
  try {
    d = await abrir(archivo);
  } catch (e) {
    problemas.push(`SQLite no lo puede abrir: ${e.message}`);
    return terminar();
  }
  try {
    const r = await todas(d, 'PRAGMA integrity_check');
    const resultado = (r[0] && (r[0].integrity_check || Object.values(r[0])[0])) || '';
    detalle.integridad = String(resultado);
    if (String(resultado).toLowerCase() !== 'ok') {
      problemas.push(`integrity_check devolvió "${resultado}"`);
    }
  } catch (e) {
    problemas.push(`no se pudo correr integrity_check: ${e.message}`);
  } finally {
    await cerrar(d);
  }
  if (problemas.length) return terminar();

  // ── 4. Que tenga adentro lo que tiene que tener ──────────────────────────
  const { tablas, conteos } = await contarTablas(archivo);
  detalle.tablas = tablas.length;
  detalle.filas = conteos;

  for (const t of TABLAS_CLAVE) {
    if (conteos[t] === null) problemas.push(`falta la tabla ${t}`);
    else if (conteos[t] === 0) problemas.push(`la tabla ${t} está vacía`);
  }
  for (const t of TABLAS_PRESENTES) {
    if (conteos[t] === null) problemas.push(`falta la tabla ${t}`);
  }

  // ── 5. Contra la base viva ───────────────────────────────────────────────
  if (dbContra) {
    if (!fs.existsSync(dbContra)) {
      problemas.push(`no se encontró la base viva para comparar: ${dbContra}`);
    } else {
      const viva = await contarTablas(dbContra);
      detalle.filas_produccion = viva.conteos;
      for (const t of TABLAS_CLAVE) {
        const enBackup = conteos[t];
        const enViva = viva.conteos[t];
        if (typeof enBackup !== 'number' || typeof enViva !== 'number' || enViva === 0) continue;
        if (enBackup < enViva * TOLERANCIA_FILAS) {
          problemas.push(
            `${t}: el backup tiene ${enBackup} filas contra ${enViva} de producción `
            + `(le falta más del ${Math.round((1 - TOLERANCIA_FILAS) * 100)}%)`,
          );
        }
      }
    }
  }

  return terminar();
}

function terminar() {
  const sirve = problemas.length === 0;
  const salida = { sirve, ...detalle, problemas };

  if (modoJson) {
    console.log(JSON.stringify(salida));
  } else {
    console.log(`\nBackup: ${detalle.archivo || archivo}`);
    if (detalle.tamano_kb !== undefined) console.log(`  Tamaño: ${detalle.tamano_kb} KB · ${detalle.fecha}`);
    if (detalle.integridad) console.log(`  Integridad: ${detalle.integridad}`);
    if (detalle.filas) {
      const partes = Object.entries(detalle.filas)
        .map(([t, n]) => `${t}=${n === null ? 'FALTA' : n}`).join(' · ');
      console.log(`  Contenido: ${partes}`);
    }
    if (sirve) {
      console.log('\n  ✓ El backup sirve para restaurar.\n');
    } else {
      console.log('\n  ✗ ESTE BACKUP NO SIRVE:');
      for (const p of problemas) console.log(`      · ${p}`);
      console.log('');
    }
  }

  process.exitCode = sirve ? 0 : 1;
  setTimeout(() => process.exit(sirve ? 0 : 1), 3000).unref();
}

main().catch((e) => {
  problemas.push(`error inesperado: ${e.message}`);
  terminar();
});
