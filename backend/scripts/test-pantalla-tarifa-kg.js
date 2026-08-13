#!/usr/bin/env node
/**
 * test-pantalla-tarifa-kg.js — el perfil del cliente en modo "precio por kilo",
 * en un navegador de verdad.
 *
 * El motor y el resolvedor los cubre test-tarifa-por-kg.js. Esto controla lo otro: que la
 * oficina pueda efectivamente cambiar el modo, cargar un rango y ver el precio en la
 * grilla. Una API perfecta con una pantalla que no guarda no le sirve a nadie.
 *
 *   cd backend && npm run test-pantalla-tarifa-kg
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.log('⚠ playwright no está instalado — se saltea (necesita navegador de verdad).');
  process.exit(0);
}

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
// Arranque común: base de test fresca (copia de producción) y sesión válida.
// Ver scripts/_base-test.js para por qué hace falta.
const { prepararDb, abrirSesion } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3986;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_tarifa_kg.db';
const TOKEN = 'token-test-tarifa-kg';

// Cuántos tramos tiene un cliente que NO tiene tramos propios, o sea el juego por defecto:
// de 5 en 5 hasta 30 kg, después 30-40 y 40-50 de a diez, y al final 50+. Son NUEVE.
//
// El 12/08/2026 esto decía 11 durante unas horas, porque el juego por defecto se había
// movido a los tramos finos. Los datos cargados siguen apoyados en los nueve cortes de
// siempre, así que mover el default deja sin precio a los envíos de 35-40 y 45-50 kg —uno
// de cada diez— sin que falle ningún test. Los finos se le ponen a cada cliente con
// `scripts/migrar-tramos.js`. Ver `test-datos-viejos.js`.
//
// Se declara acá una sola vez en vez de repetir el número por la pantalla, y en el punto
// 7-bis se contrasta contra lo que dice el backend: si mañana el juego cambia, el test
// falla en un lugar solo y con un mensaje que se entiende.
const TRAMOS_HEREDADOS = 9;

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Base de test: copia FRESCA de la de producción en cada corrida.
  prepararDb(DB);

  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  // Si el test se corta por un error, el servidor tiene que morir igual: si queda vivo se
  // queda con el puerto y la corrida siguiente le habla al servidor VIEJO, con la base
  // vieja, y falla con 401 sin motivo aparente.
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

  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await esperar(300);
  }

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await abrirSesion(DB, TOKEN);
  const [cliente] = await q('SELECT id, nombre FROM clientes WHERE activo = 1 ORDER BY id LIMIT 1');
  await q('DELETE FROM tarifa_kg_overrides WHERE cliente_id = ?', [cliente.id]);
  await q("UPDATE clientes SET modo_tarifa = 'porcentaje', fuel_pct_propio = NULL WHERE id = ?", [cliente.id]);
  // `db.close()` de sqlite3 NO es sincronico: encola el cierre en un hilo del pool y avisa
  // por un handle async de libuv. Si el proceso arranca a salir antes de que ese aviso
  // llegue, el hilo termina llamando uv_async_send sobre un handle que YA se esta cerrando
  // y en Windows eso revienta con:
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
  // No falla ningun test: se muere Node y corta la cadena del `npm test` a la mitad. En
  // Linux la carrera casi siempre sale bien y por eso no se veia. Esperar el callback del
  // close es la sincronizacion que faltaba.
  await new Promise((res) => db.close(() => res()));

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errores.push('console: ' + m.text()); });

  // ── 1. Arranca en modo porcentaje, como siempre ─────────────────────────────
  console.log('\n1. El perfil abre en modo porcentaje\n');
  await page.goto(`${BASE}/pages/clientes-perfil.html?id=${cliente.id}`, { waitUntil: 'networkidle' });
  await esperar(1200);
  await page.click('#btn-editar-tarifas');
  await esperar(1200);

  check('ya NO hay selector de modo: lo que se carga es lo que se cobra',
    await page.evaluate(() => !document.getElementById('tarifas-modo-select')));

  // El selector de modo ya no existe: el modo del cliente solo decide si el cotizador
  // avisa al caer al porcentaje. Para los flujos que lo necesitan se cambia por base.
  const cambiarModo = async (modo) => {
    await new Promise((res, rej) => {
      const d2 = new (require('sqlite3').Database)(DB);
      d2.run('UPDATE clientes SET modo_tarifa = ? WHERE id = ?', [modo, cliente.id],
        (e) => d2.close(() => (e ? rej(e) : res())));
    });
    await page.reload({ waitUntil: 'networkidle' });
    await esperar(800);
    await page.click('#btn-editar-tarifas');
    await esperar(1200);
  };

  // LO CENTRAL DEL 13/08: la matriz entera está de una. Los tres servicios son secciones
  // apiladas en la misma página; los botones de arriba solo llevan, no ocultan.
  check('las TRES secciones de servicio están en la página a la vez',
    await page.evaluate(() => !!document.getElementById('sec-DHL')
      && !!document.getElementById('sec-UPS_EXP') && !!document.getElementById('sec-UPS_SAVER')));
  check('la exportación se ve rotulada en cada sección',
    (await page.$$eval('.tipo-tag', (t) => t.filter((x) => /exportaci/i.test(x.textContent)).length)) === 3);
  check('la impo sin datos es una línea, no una tabla vacía',
    (await page.$$('.tarifa-impo-vacia')).length === 3);
  check('hay una leyenda de colores en la barra',
    (await page.$$('#tarifas-tabs .tarifas-key')).length >= 3);

  const bandasPct = await page.evaluate(() =>
    [...document.querySelectorAll('#sec-DHL td.banda-label')].map((t) => t.textContent.trim()));
  check('se ven los tramos heredados en DHL', bandasPct.length === TRAMOS_HEREDADOS, bandasPct.join(' | '));
  const celdaPct = await page.evaluate(() => {
    const td = document.querySelector('#sec-DHL td.tarifa-cell:not(.col-todas) .cell-val');
    return td ? td.textContent.trim() : null;
  });
  check('las celdas muestran porcentajes', /%$/.test(celdaPct || ''), String(celdaPct));

  // La pantalla abre en VISTA: se mira lo que se cobra, no se edita nada.
  check('está el conmutador con sus tres botones',
    (await page.$$('#tarifas-vista .vista-btn')).length === 3);
  check('arranca en "Lo que se cobra"',
    await page.evaluate(() => document.querySelector('#tarifas-vista .vista-btn.on').dataset.vista === 'cobra'));
  check('en la vista no hay cruces de borrar', (await page.$$('.cell-del')).length === 0);
  await page.click('#sec-DHL td.tarifa-cell:not(.col-todas)');
  await esperar(300);
  check('y el clic en una celda NO abre un editor',
    (await page.$$('#sec-DHL td.tarifa-cell input')).length === 0);

  // ── 2. Cambiar a precio por kilo ────────────────────────────────────────────
  console.log('\n2. Pasarlo a precio por kilo\n');
  await cambiarModo('por_kg');

  const bandasKg = await page.evaluate(() =>
    [...document.querySelectorAll('#sec-DHL td.banda-label')].map((t) => t.textContent.trim()));
  check('en modo por kilo se ven LOS MISMOS tramos', bandasKg.length === TRAMOS_HEREDADOS, bandasKg.join(' | '));
  // La celda muestra UN número: lo que se cobra. Sin precio por kilo, el porcentaje con
  // el que cae, en gris (por-pct). Nada de dos valores juntos.
  check('sin precio por kilo, la celda muestra el porcentaje que cobra, en gris',
    await page.evaluate(() => {
      const td = document.querySelector('#sec-DHL td.tarifa-cell.por-pct .cell-val');
      return td && /%$/.test(td.textContent.trim());
    }));
  check('y ninguna celda muestra dos valores', (await page.$$('.cell-sub')).length === 0);

  // El general editable está en la edición, no en la vista.
  await page.click('#tarifas-vista .vista-btn[data-vista="kg"]');
  await esperar(400);
  check('en "Editar precio por kilo" el general de cada tabla es USD/kg',
    /USD\/kg/.test(await page.textContent('#sec-DHL .tarifa-general-linea')),
    await page.textContent('#sec-DHL .tarifa-general-linea'));
  check('y los tramos sin precio quedan vacíos, no desaparecen',
    (await page.textContent('#sec-DHL')).includes('—'));

  // ── 3. Cargar el rango del ejemplo real: 1 a 10 kg a USD 5 ──────────────────
  // Cada tabla (servicio + tipo) tiene sus propios rangos, igual que la matriz de profit.
  // Se carga en UPS Expedited Expo, que es la que después cotiza el cotizador.
  console.log('\n3. Cargar el tramo 5-10 kg a USD 5 el kilo en UPS Expedited Expo\n');
  await page.click('#tarifas-tabs .tab[data-serv="UPS_EXP"]');
  await esperar(600);
  check('el botón de UPS Express lleva a su sección (nada se recarga ni se oculta)',
    await page.evaluate(() => document.getElementById('sec-UPS_EXP').getBoundingClientRect().top < 300
      && !!document.getElementById('sec-DHL')));

  // La columna "Todas" pone el precio del tramo para las seis zonas de un clic. Es lo que
  // antes hacía la barra de rangos, sin poder inventar un tramo que no existe.
  check('existe la columna "Todas"', !!(await page.$('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"].col-todas[data-min="5"]')));
  await page.click('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"].col-todas[data-min="5"]');
  await esperar(400);
  await page.fill('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"].col-todas[data-min="5"] input', '5');
  await page.press('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"].col-todas[data-min="5"] input', 'Enter');
  await esperar(1500);

  const valores = await page.$$eval('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-min="5"]:not(.col-todas) .cell-val',
    (v) => v.map((x) => x.textContent.trim()));
  check('las seis zonas de 5-10 kg muestran USD 5.00',
    valores.length === 6 && valores.every((v) => v === 'USD 5.00'), valores.join(' | '));

  const otroTramo = await page.$$eval('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-min="20"]:not(.col-todas) .cell-val',
    (v) => v.map((x) => x.textContent.trim()));
  check('y los demás tramos siguen sin precio por kilo',
    otroTramo.every((v) => /—/.test(v)), otroTramo.join(' | '));

  // ── 4. Pisar una zona puntual ───────────────────────────────────────────────
  console.log('\n4. Pisar el precio de una zona\n');
  await page.click('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-zona="3"][data-min="5"]');
  await esperar(400);
  await page.fill('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-zona="3"][data-min="5"] input', '7.5');
  await page.press('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-zona="3"][data-min="5"] input', 'Enter');
  await esperar(1500);

  const trasEditar = await page.evaluate(() =>
    [...document.querySelectorAll('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-min="5"]:not(.col-todas)')].map((td) => ({
      zona: td.dataset.zona,
      val: td.querySelector('.cell-val').textContent.trim(),
      propio: td.classList.contains('propio'),
    })));
  const z3 = trasEditar.find((c) => c.zona === '3');
  check('la zona 3 queda en USD 7.50', z3 && z3.val === 'USD 7.50', JSON.stringify(z3));
  check('y se marca como propia (se puede quitar)', z3 && z3.propio, JSON.stringify(z3));
  check('las otras zonas no se movieron',
    trasEditar.filter((c) => c.zona !== '3').every((c) => c.val === 'USD 5.00'),
    trasEditar.map((c) => c.val).join(' | '));

  // ── 5. Fuel propio del cliente ──────────────────────────────────────────────
  console.log('\n4-bis. El caso MIXTO: una zona por kilo, el resto por porcentaje\n');

  // El motor lo soportaba desde siempre (resolverTarifaKg devuelve null y resolverTarifaVenta
  // cae al porcentaje), pero desde la pantalla no se podía armar: el alta creaba siempre la
  // fila de "todas las zonas". Con el selector nuevo se carga un rango para UNA zona sola.
  const ayuda = await page.textContent('#tarifas-grid-ayuda');
  check('la ayuda dice que la celda muestra lo que se cobra',
    /lo que se cobra/i.test(ayuda), ayuda);
  check('y que se edita con el botón Editar',
    /Editar/i.test(ayuda), ayuda);

  // Una sola zona con precio por kilo y las otras cinco por porcentaje, en el tramo 40-50.
  await page.click('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-zona="1"][data-min="40"]');
  await esperar(400);
  await page.fill('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-zona="1"][data-min="40"] input', '8');
  await page.press('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-zona="1"][data-min="40"] input', 'Enter');
  await esperar(2000);

  // La VISTA del caso mixto: una zona con su precio por kilo, las otras cinco en gris con
  // el porcentaje que cobran de verdad. Un solo número por celda.
  await page.click('#tarifas-vista .vista-btn[data-vista="cobra"]');
  await esperar(400);
  const fila40 = await page.$$eval('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-min="40"]:not(.col-todas)',
    (els) => els.map((td) => ({ zona: td.dataset.zona,
      val: td.querySelector('.cell-val').textContent.trim(),
      porPct: td.classList.contains('por-pct') })));
  check('la zona elegida muestra su precio por kilo',
    (fila40.find((c) => c.zona === '1') || {}).val === 'USD 8.00',
    JSON.stringify(fila40.find((c) => c.zona === '1')));
  const grises = fila40.filter((c) => c.porPct && /%$/.test(c.val)).length;
  check('las otras cinco zonas muestran el porcentaje que cobran, en gris', grises === 5, `grises=${grises}`);
  await page.click('#tarifas-vista .vista-btn[data-vista="kg"]');
  await esperar(400);

  console.log('\n4-ter. Un precio en USD 0 se marca y se avisa: vende el flete gratis\n');

  // Pasó con PIO ALVAREZ: 21 celdas en 0 que nadie veía. Ahora la pantalla las cuenta
  // arriba en rojo y pinta la celda. Un 0 no es "sin precio".
  await page.click('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-zona="5"][data-min="10"]');
  await esperar(400);
  await page.fill('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-zona="5"][data-min="10"] input', '0');
  await page.press('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-zona="5"][data-min="10"] input', 'Enter');
  await esperar(1500);

  check('la celda en 0 queda marcada en rojo',
    await page.evaluate(() => {
      const td = document.querySelector('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-zona="5"][data-min="10"]');
      return td && td.classList.contains('cero');
    }));
  const alerta0 = await page.evaluate(() => {
    const a = document.getElementById('tarifas-alerta');
    return a && a.style.display !== 'none' ? a.textContent : null;
  });
  check('y arriba aparece el aviso de flete gratis',
    /USD 0/.test(alerta0 || '') && /GRATIS/i.test(alerta0 || ''), String(alerta0).slice(0, 90));

  await page.click('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-zona="5"][data-min="10"] .cell-del');
  await esperar(1500);
  check('al quitar el 0 el aviso se va',
    await page.evaluate(() => document.getElementById('tarifas-alerta').style.display === 'none'));

  console.log('\n5. Fuel propio del cliente\n');

  // Guardar el fuel dispara un PUT y DESPUÉS una recarga del perfil entero. Esperar un
  // número fijo de milisegundos es apostar a que la máquina llegue: el 12/08/2026 esta tanda
  // falló en la máquina de Felipe —2 o 3 veces más lenta que la del contenedor— con la
  // pantalla todavía sin recargar. No había nada roto, el test iba apurado.
  //
  // ⚠️ Y OJO CON QUÉ SE ESPERA. El primer intento de arreglo esperaba a que el campo dijera
  // "25"… pero el campo YA decía 25, porque lo acababa de escribir el propio test. La espera
  // terminaba al instante y la carrera se mudaba al control siguiente. La señal que sirve es
  // la que SOLO puede venir del servidor: el botón de quitar el fuel, que `renderModo()`
  // muestra u oculta según lo que devolvió la recarga. Si el guardado no llegó, no aparece.
  const esperarBotonQuitar = (visible) => page.waitForFunction(
    (v) => {
      const b = document.getElementById('btn-borrar-fuel');
      return !!b && b.classList.contains('hidden') !== v;
    },
    visible, { timeout: 15000 }
  ).then(() => true).catch(() => false);

  await page.fill('#tarifas-fuel-input', '25');
  await page.click('#btn-guardar-fuel');
  check('aparece el botón para quitarlo', await esperarBotonQuitar(true));
  check('se guarda y queda escrito en el campo',
    (await page.inputValue('#tarifas-fuel-input')) === '25',
    `quedó "${await page.inputValue('#tarifas-fuel-input')}"`);

  await page.click('#btn-borrar-fuel');
  check('al quitarlo desaparece el botón', await esperarBotonQuitar(false));
  check('y el campo queda vacío',
    (await page.inputValue('#tarifas-fuel-input')) === '',
    `quedó "${await page.inputValue('#tarifas-fuel-input')}"`);

  // ── 6. El cotizador aplica la tarifa por kilo ───────────────────────────────
  console.log('\n6. El cotizador cobra el precio por kilo\n');
  await page.goto(BASE + '/pages/cotizador.html', { waitUntil: 'networkidle' });
  await esperar(1200);
  await page.selectOption('#cliente', String(cliente.id));
  await page.selectOption('#pais', 'Estados Unidos');
  await page.selectOption('#couriers', 'ups_exp');
  await page.fill('#fuel', '39.5');
  await page.fill('.b-peso', '6');
  await page.fill('.b-largo', '30');
  await page.fill('.b-ancho', '20');
  await page.fill('.b-alto', '10');
  await page.click('.btn-calc');
  await esperar(2500);

  const texto = await page.textContent('#results');
  check('la cotización dice que es tarifa por kilo', /por kilo/i.test(texto || ''),
    (texto || '').slice(0, 120));
  check('muestra el flete como kilos × precio', /6\.0 kg × USD 5\.00/.test(texto || ''),
    (texto || '').slice(0, 200));
  check('y el flete internacional da USD 30.00', /Flete internacional[^$]*USD 30\.00/.test(texto || ''),
    (texto || '').match(/Flete internacional.{0,60}/)?.[0] || '');
  console.log(`      ${(texto || '').match(/Flete internacional.{0,50}/)?.[0] || ''}`);

  // ── 7. Un peso fuera de todo rango avisa, no cotiza cero ────────────────────
  console.log('\n7. Un peso sin rango cargado avisa\n');
  await page.fill('.b-peso', '60');
  await page.click('.btn-calc');
  await esperar(2500);

  const aviso = await page.evaluate(() => {
    const e = document.getElementById('error-msg');
    return e && e.style.display !== 'none' ? e.textContent : null;
  });
  // El texto del aviso se reformuló el 04/08 a algo neutro ("no tiene precio por kilo
  // cargado"), porque desde que se puede cargar un rango para una zona sola esto también es
  // el caso MIXTO y es deliberado. Lo que importa es que el aviso SALGA y diga con qué
  // porcentaje se cotizó.
  check('sale el aviso de que esa zona va por porcentaje',
    /no tiene precio por kilo/i.test(aviso || '') && /porcentaje de ganancia/i.test(aviso || ''),
    String(aviso));
  const texto2 = await page.textContent('#results');
  check('igual cotiza (con el porcentaje), no queda en cero',
    /Total/.test(texto2 || '') && !/USD 0\.00\s*$/.test(texto2 || ''), (texto2 || '').slice(0, 80));

  // ── 7-bis. Un tramo viejo se sigue VIENDO ──────────────────────────────────
  //
  // Es el control más importante de este test. En producción hay clientes con tramos
  // cargados de cuando los rangos eran libres —20 a 29,5 kg, 32,5 en adelante— que no
  // coinciden con ninguna banda. Si la grilla mostrara solo las bandas, esos precios
  // desaparecerían de la pantalla mientras el sistema los sigue cobrando. Un precio que
  // se cobra y no se ve es justamente lo que hay que evitar.
  console.log('\n7-bis. Un tramo viejo, de los que no son una banda, se sigue viendo\n');

  // Base propia: la de arriba ya se cerró. Se escribe la fila directo porque el servidor
  // ya NO acepta un rango que no sea una banda: es justamente el caso viejo que hay que
  // poder seguir viendo.
  await new Promise((res, rej) => {
    const d2 = new (require('sqlite3').Database)(DB);
    d2.run(
      `INSERT INTO tarifa_kg_overrides (cliente_id, servicio, tipo, zona, peso_min, peso_max, precio_kg)
       VALUES (?, 'UPS_EXP', 'export', NULL, 20, 29.5, 4.32)`,
      [cliente.id],
      (e) => d2.close(() => (e ? rej(e) : res()))
    );
  });

  await page.goto(BASE + '/pages/clientes-perfil.html?id=' + cliente.id, { waitUntil: 'networkidle' });
  await esperar(1200);
  await page.click('#btn-editar-tarifas');
  await esperar(1200);
  await page.click('#tarifas-tabs .tab[data-serv="UPS_EXP"]');
  await esperar(800);

  const filaVieja = await page.$('#sec-UPS_EXP tr.fila-vieja');
  check('el tramo viejo aparece en la grilla', !!filaVieja);
  const textoVieja = filaVieja ? await filaVieja.textContent() : '';
  check('y dice el rango que tiene de verdad (20-29.5)', /29\.5/.test(textoVieja), textoVieja.slice(0, 60));
  check('está marcado como fuera de los tramos', /fuera de los tramos/i.test(textoVieja),
    textoVieja.slice(0, 60));
  check('y muestra el precio que cobra', /4\.32/.test(textoVieja), textoVieja.slice(0, 80));
  check('no se puede editar desde la grilla',
    (await page.$$('#sec-UPS_EXP tr.fila-vieja td.tarifa-cell')).length === 0);
  // Los tramos ya no son nueve fijos: son los del cliente, y los dice el backend. El número
  // se le pregunta a él en vez de escribirlo acá, así el día que cambie el juego por
  // defecto este test no miente: compara la grilla contra la verdad, no contra un 9 viejo.
  const tramosDelBackend = await page.evaluate(async (id) => {
    const r = await fetch(`/api/clientes/${id}/tramos`, { credentials: 'same-origin' });
    const j = await r.json();
    return j.tramos.length;
  }, cliente.id);
  check('el backend dice cuántos tramos tiene este cliente', tramosDelBackend === TRAMOS_HEREDADOS,
    `son ${tramosDelBackend}, esperaba ${TRAMOS_HEREDADOS}`);
  check('y todos están en la grilla de UPS Express, además de la fila de afuera',
    (await page.$$('#sec-UPS_EXP tr:not(.fila-vieja) td.banda-label')).length === tramosDelBackend,
    `grilla=${(await page.$$('#sec-UPS_EXP tr:not(.fila-vieja) td.banda-label')).length} backend=${tramosDelBackend}`);

  console.log('\n7-ter. El precio por kilo cargado se ve y SE COBRA, este el cliente en el modo que este\n');

  // La regla del 13/08: "si tiene precio por kilo, paga precio por kilo, independientemente".
  await cambiarModo('porcentaje');
  const enPct = await page.evaluate(() => {
    const td = document.querySelector('td.tarifa-cell[data-serv="UPS_EXP"][data-tipo="export"][data-zona="3"][data-min="5"]');
    return td ? { val: td.querySelector('.cell-val').textContent.trim(), clases: td.className } : null;
  });
  check('la celda MUESTRA el precio por kilo cargado', enPct && enPct.val === 'USD 7.50', JSON.stringify(enPct));
  check('sin ninguna marca rara: es un precio que se cobra', enPct && !/kg-muerto/.test(enPct.clases), JSON.stringify(enPct));
  // Y el backend cobra ese precio aunque el cliente este en porcentaje.
  const cotizado = await page.evaluate(async (id) => {
    const r = await fetch('/api/clientes/' + id + '/tarifas/venta?servicio=UPS_EXP&tipo=export&zona=3&peso=6', { credentials: 'same-origin' })
      .catch(() => null);
    return null; // el endpoint directo no existe: el control real es la celda + test-tarifa-por-kg
  }, cliente.id);
  void cotizado;

  console.log('\n8. Sin errores de JavaScript\n');
  const rel = errores.filter((x) => !/favicon|net::ERR|Failed to load resource/i.test(x));
  check('ningún error en las dos pantallas', rel.length === 0, rel.slice(0, 2).join(' | '));

  await browser.close();
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
