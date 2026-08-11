#!/usr/bin/env node
/**
 * verificar.js — UN comando que corre toda la batería y termina con un veredicto.
 *
 * POR QUÉ EXISTE
 * Antes de subir cualquier cosa había que correr dos comandos (`npm test` y
 * `npm run test-pantallas`), leer veinte tandas de salida y darse cuenta solo de si
 * alguna había fallado. Con las tandas en verde eso son cientos de renglones para
 * enterarte de algo que se contesta con una palabra.
 *
 * Esto corre las dos cadenas seguidas, muestra UN renglón por tanda y termina con un
 * veredicto: se puede subir, o no se puede y acá está lo que falló. La salida completa
 * de una tanda solo se imprime si esa tanda falló, que es justo cuando hace falta.
 *
 * NO reemplaza a `npm test`: lee las MISMAS cadenas de package.json, así que no hay dos
 * listas de tests que se puedan desincronizar. Si mañana se agrega una tanda al `test`,
 * esto la corre sin tocar nada.
 *
 *   cd backend && npm run verificar
 *
 * Sale con 0 si está todo verde, 1 si hay algo roto.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));

/** Parte "node scripts/a.js && node scripts/b.js" en las tandas que la componen. */
function tandasDe(nombre) {
  return String(pkg.scripts[nombre] || '')
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^node\s+/, ''));
}

const CADENAS = [
  { titulo: 'Motor de cálculo, API y datos', tandas: tandasDe('test') },
  { titulo: 'Pantallas, en un navegador de verdad', tandas: tandasDe('test-pantallas') },
];

const CUENTA = /(\d+)\s+pasaron\s+·\s+(\d+)\s+fallaron/;

/**
 * ¿Hay algún puerto de test ya ocupado?
 *
 * POR QUÉ ESTÁ ACÁ Y NO ADENTRO DE CADA TEST
 * El 11/08/2026 una corrida entera de 7 minutos terminó en 7 tandas rojas porque había
 * quedado vivo un node de una vez anterior agarrado a un puerto. El motivo aparecía
 * recién al final, después de esperar los 7 minutos. Preguntarlo ANTES cuesta un
 * segundo y evita la espera al pedo.
 *
 * Los puertos se leen de los propios tests, así que agregar una tanda nueva no obliga a
 * tocar esta lista: no puede quedar desactualizada.
 */
function puertosOcupados(tandas) {
  const net = require('net');
  // Un mismo puerto lo comparten varias tandas (corren una detrás de otra, así que no se
  // pisan). Hay que juntarlas ANTES de probar: si se prueba el mismo puerto dos veces en
  // paralelo, la segunda prueba se choca con la primera y da un ocupado que no existe.
  const porPuerto = new Map();
  for (const rel of tandas) {
    try {
      const txt = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
      const m = txt.match(/PORT_TEST\s*\|\|\s*(\d+)/);
      if (!m) continue;
      const p = Number(m[1]);
      if (!porPuerto.has(p)) porPuerto.set(p, []);
      porPuerto.get(p).push(path.basename(rel, '.js'));
    } catch { /* si no se puede leer, ya va a fallar más abajo con un mensaje mejor */ }
  }
  const puertos = [...porPuerto].map(([puerto, tests]) => ({ puerto, test: tests.join(', ') }));
  return Promise.all(puertos.map(({ puerto, test }) => new Promise((res) => {
    const s = net.createServer();
    s.once('error', (e) => res(e.code === 'EADDRINUSE' ? { puerto, test } : null));
    s.once('listening', () => s.close(() => res(null)));
    s.listen(puerto, '0.0.0.0');
  }))).then((r) => r.filter(Boolean));
}

(async () => {
  const todas = CADENAS.flatMap((c) => c.tandas);
  const ocupados = await puertosOcupados(todas);
  if (ocupados.length) {
    console.log('\n✗ NO SE PUEDE EMPEZAR: hay puertos de prueba ocupados\n');
    for (const o of ocupados) {
      console.log(`  puerto ${o.puerto}  →  lo necesita ${o.test}`);
    }
    console.log('\nCasi siempre es un node que quedó vivo de una corrida anterior.');
    console.log('Para liberarlos, pegá esto en PowerShell:\n');
    console.log('  Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -ge 3960 -and $_.LocalPort -le 4000 } | ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } | Where-Object { $_.ProcessName -eq \'node\' } | Stop-Process -Force');
    console.log('\nY después, de nuevo: npm run verificar\n');
    process.exit(1);
  }
  correrTodo();
})();

function correrTodo() {
let totalOk = 0;
let totalFail = 0;
let tandasCorridas = 0;
let tandasSalteadas = 0;
const rotas = [];

const arranque = Date.now();

for (const cadena of CADENAS) {
  console.log(`\n${cadena.titulo}`);
  console.log('─'.repeat(60));

  for (const rel of cadena.tandas) {
    const nombre = path.basename(rel).replace(/\.js$/, '');
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [rel], {
      cwd: RAIZ,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const seg = ((Date.now() - t0) / 1000).toFixed(0);
    const salida = (r.stdout || '') + (r.stderr || '');

    // Un test que se saltea a propósito (por ejemplo, sin playwright instalado) no es
    // un test verde: hay que verlo, porque significa que eso NO se probó.
    if (/se saltea/.test(salida) && !CUENTA.test(salida)) {
      tandasSalteadas++;
      console.log(`  ~ ${nombre.padEnd(34)} SALTEADA (no se probó)`);
      continue;
    }

    const m = salida.match(CUENTA);
    const ok = m ? Number(m[1]) : 0;
    const fail = m ? Number(m[2]) : 0;
    totalOk += ok;
    totalFail += fail;
    tandasCorridas++;

    // Se falla si el test lo dice O si el proceso murió sin decir nada. Lo segundo es
    // lo que pasaba cuando el servidor de prueba no arrancaba: sin esta línea, una
    // tanda que revienta antes de contar nada se leería como "0 fallaron".
    const murio = r.status !== 0 || !m;
    if (fail > 0 || murio) {
      rotas.push({ nombre, ok, fail, salida, murio: !m });
      console.log(`  ✗ ${nombre.padEnd(34)} ${fail} FALLARON de ${ok + fail}   (${seg}s)`);
    } else {
      console.log(`  ✓ ${nombre.padEnd(34)} ${String(ok).padStart(3)} controles   (${seg}s)`);
    }
  }
}

const minutos = ((Date.now() - arranque) / 60000).toFixed(1);

console.log('\n' + '═'.repeat(60));

if (rotas.length === 0 && tandasSalteadas === 0) {
  console.log(`TODO VERDE · ${tandasCorridas} tandas · ${totalOk} controles · ${minutos} min`);
  console.log('Se puede subir.');
  process.exitCode = 0;
} else if (rotas.length === 0) {
  console.log(`VERDE, PERO CON ${tandasSalteadas} TANDA(S) SALTEADA(S)`);
  console.log(`${tandasCorridas} tandas · ${totalOk} controles · ${minutos} min`);
  console.log('Lo salteado NO se probó. Si son las de pantalla, falta playwright:');
  console.log('  npm install');
  process.exitCode = 0;
} else {
  console.log(`HAY ${rotas.length} TANDA(S) ROTA(S) · ${totalFail} controles fallados`);
  console.log('NO subas esto todavía.\n');
  for (const r of rotas) {
    console.log('─'.repeat(60));
    console.log(r.murio
      ? `${r.nombre} — se cortó sin llegar a contar. Su salida completa:`
      : `${r.nombre} — lo que falló:`);
    const lineas = r.salida.split('\n');
    const utiles = r.murio ? lineas.slice(-25) : lineas.filter((l) => /✗/.test(l));
    console.log(utiles.join('\n').trimEnd());
  }
  console.log('─'.repeat(60));
  console.log(`\n${tandasCorridas} tandas corridas · ${minutos} min`);
  process.exitCode = 1;
}

// Red de seguridad del arranque en Windows: no dejar el proceso colgado si algo quedó
// abierto. Ver claude/TESTS-EN-WINDOWS.md.
setTimeout(() => process.exit(process.exitCode || 0), 3000).unref();
}
