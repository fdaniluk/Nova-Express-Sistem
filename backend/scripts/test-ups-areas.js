// test-ups-areas.js — búsqueda de áreas de entrega UPS por CP / ciudad (02/10/2026).
// Corre sobre una copia de la base (la tabla ups_areas se carga sola si está vacía).
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-areas-'));
fs.copyFileSync(path.join(__dirname, '..', '..', 'database', 'nova.db'), path.join(tmp, 'nova.db'));
process.env.DB_PATH = path.join(tmp, 'nova.db');
const { initDb } = require('../src/db');
const svc = require('../src/services/ups-areas.service');

let ok = 0, fail = 0;
function check(nombre, cond, det) {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fail++; console.log(`  ✗ ${nombre}${det ? '  → ' + det : ''}`); }
}

(async () => {
  await initDb();
  const b = (pais, cp, ciudad) => svc.buscarArea({ pais, cp, ciudad });
  let r;

  console.log('\n1. CP numérico: prefijos y formatos\n');
  r = await b('Brasil', '07500-000');
  check('Brasil: el CEP completo "07500-000" cae en el rango de 5 dígitos (07500)', r.zona === 'remota' && r.match === 'cp', JSON.stringify(r));
  r = await b('Brasil', '01310-100');
  check('Brasil: 01310 (centro de San Pablo) sin recargo', r.zona === 'normal');
  r = await b('Argentina', 'B1917ABC');
  check('Argentina: "B1917ABC" = 1917 (no metropolitana → extendida)', r.zona === 'extendida');
  r = await b('España', '08001');
  check('España: 08001 (Barcelona) sin recargo', r.zona === 'normal');

  console.log('\n2. Alfanuméricos\n');
  r = await b('Reino Unido', 'AB33 4AA');
  check('Reino Unido: AB33 (Aberdeenshire) por prefijo', r.zona !== 'normal' && r.match === 'cp', JSON.stringify(r));

  console.log('\n3. Países listados por ciudad\n');
  r = await b('Chile', 'Ancud');
  check('Chile: la ciudad tipeada en el campo CP se busca como ciudad', r.zona === 'extendida' && r.match === 'ciudad', JSON.stringify(r));
  r = await b('Chile', '1234567', 'Ancud');
  check('Chile: CP sin match + ciudad aparte → por ciudad', r.match === 'ciudad');
  r = await b('Colombia', 'Apartadó');
  check('Colombia: con acento también', r.match === 'ciudad');

  console.log('\n4. EE.UU.: informativo, no marca zona\n');
  r = await b('Estados Unidos', '10001');
  check('Manhattan figura en la lista pero zona queda normal e informativo', r.zona === 'normal' && r.informativo === true && /Área de entrega/.test(r.etiqueta), JSON.stringify(r));
  r = await b('Estados Unidos', '10001-1234');
  check('ZIP+4 se recorta a 5', r.informativo === true);
  r = await b('Estados Unidos', '33166');
  check('ZIP que no está en la lista → normal sin leyenda', r.zona === 'normal' && !r.informativo && !r.etiqueta);

  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
