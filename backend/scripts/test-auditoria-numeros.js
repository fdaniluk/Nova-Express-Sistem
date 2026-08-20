#!/usr/bin/env node
/**
 * test-auditoria-numeros.js — las tres sospechas de AUDITORIA-NUMEROS.md que faltaban
 * comprobar y arreglar (15/08/2026), más la coherencia direccion↔tipo_envio (18/08). Cada sección reproduce el error tal como estaba
 * escrito ANTES del arreglo: si alguien lo deshace, esto se pone rojo.
 *
 *  1. IMPORTADOR DE PLANILLA (excel.service.js):
 *     - una impo UPS buscaba la zona en la tabla de EXPORTACIÓN (Bélgica: expo 4, impo 5;
 *       la zona guardada después actúa de override en cada recálculo → costo de otra fila);
 *     - servicio_ups quedaba en NULL (el "Saver" de la celda del courier se perdía y todo
 *       recaía en el fallback silencioso a Expedited);
 *     - tipo_envio salía de una celda que en la planilla real dice MERCADERIA/DOCUMENTO,
 *       así que TODA importación quedaba como 'exportacion' aunque la dirección detectada
 *       fuera impo.
 *  2. PERFIL DEL CLIENTE (clientes.controller.js): la utilidad usaba total_cobrado ×
 *     tarifa_pct, una fórmula que no coincide con Salidas ni con el Dashboard. Ahora los
 *     tres usan deriveProfit con la misma precedencia (costo real > liquidación > estimado).
 *  3. SEGURO PROPIO NO CONGELADO: el cliente con seguro negociado (seguro_pct_propio)
 *     veía la escala de LISTA en la línea "Seguro" de su liquidación. Ahora el monto
 *     negociado se congela en envios.seguro_venta al alta y al editar el valor declarado.
 *
 *   cd backend && npm run test-auditoria     (EN POWERSHELL, no en el servidor)
 */

const { spawn } = require('child_process');
const path = require('path');
const XLSX = require('xlsx');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
const {
  ZONAS_DHL, ZONAS_UPS, ZONAS_UPS_I, calcSeguroDHL,
} = require('../../shared/cotizador/cotizador-core');

const PORT = process.env.PORT_TEST || 3998;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_auditoria_numeros.db';
const TOKEN = 'token-test-auditoria';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
let matarServidor = () => {};
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else {
    fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`);
  }
}

// Arma una fila de la planilla de Salidas por POSICIÓN (mismo mapa que excel.service.js).
function fila({ courier, guia, cliente, pais, tipoEnvioCelda, fob = 0, total = 100 }) {
  const r = new Array(32).fill('');
  r[0] = 1;                 // numero_salida
  r[1] = courier;           // courier
  r[2] = '2026-08-15';      // fecha
  r[3] = guia;              // numero_guia
  r[4] = 'CC';              // tipo_cobro
  r[5] = cliente;           // cliente
  r[6] = pais;              // pais_destino
  r[8] = tipoEnvioCelda;    // celda "tipo": en la planilla real dice MERCADERIA/DOCUMENTO
  r[9] = 5;                 // peso_real
  r[10] = 30; r[11] = 20; r[12] = 20; // dims
  r[17] = fob;              // fob
  r[28] = total;            // total_cobrado
  return r;
}

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
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));
  const uno = async (sql, p) => (await q(sql, p))[0];

  // ── 1. El importador de planilla ─────────────────────────────────────────────────────
  console.log('\n1. Importador: zona de impo, servicio UPS y tipo_envio coherente\n');

  const aoa = [
    ['#SAL', 'COURIER', 'FECHA', 'GUIA', 'TC', 'CLIENTE', 'DESTINO', 'BULTO', 'TIPO', 'PESO'],
    fila({ courier: 'UPS', guia: 'AUD-IMPO-1', cliente: 'AUD IMPORT CLI', pais: 'BELGICA - ARGENTINA', tipoEnvioCelda: 'MERCADERIA' }),
    fila({ courier: 'UPS SAVER', guia: 'AUD-SAV-1', cliente: 'AUD IMPORT CLI', pais: 'BRASIL', tipoEnvioCelda: 'MERCADERIA' }),
    fila({ courier: 'DHL', guia: 'AUD-DHL-1', cliente: 'AUD IMPORT CLI', pais: 'BELGICA', tipoEnvioCelda: 'DOCUMENTO' }),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'SALIDAS');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const fd = new FormData();
  fd.append('archivo', new Blob([buf]), 'salidas.xlsx');
  const rImp = await fetch(`${BASE}/api/envios/importar`, {
    method: 'POST', headers: { Cookie: `nova_session=${TOKEN}` }, body: fd,
  });
  const impBody = await rImp.json().catch(() => null);
  check('la planilla de 3 filas se importa entera',
    rImp.status === 200 && impBody && impBody.importados === 3,
    JSON.stringify(impBody).slice(0, 200));

  const impo = await uno('SELECT * FROM envios WHERE numero_guia = ?', ['AUD-IMPO-1']);
  check('la impo quedó con direccion=impo', impo && impo.direccion === 'impo', impo && impo.direccion);
  check('y tipo_envio=importacion (antes: exportacion, la celda decía MERCADERIA)',
    impo && impo.tipo_envio === 'importacion', impo && impo.tipo_envio);
  check(`la zona de la impo UPS sale de la tabla de IMPORTACIÓN (Bélgica: ${ZONAS_UPS_I['Bélgica']}, no ${ZONAS_UPS['Bélgica']})`,
    impo && Number(impo.zona) === ZONAS_UPS_I['Bélgica'], impo && String(impo.zona));
  check('y su servicio_ups quedó explícito en UPS_EXP (no NULL)',
    impo && impo.servicio_ups === 'UPS_EXP', impo && String(impo.servicio_ups));
  check('el tipo de paquete sigue saliendo de esa misma celda (m)',
    impo && impo.tipo_paquete === 'm', impo && String(impo.tipo_paquete));

  const sav = await uno('SELECT * FROM envios WHERE numero_guia = ?', ['AUD-SAV-1']);
  check('la celda "UPS SAVER" guarda servicio_ups=UPS_SAV',
    sav && sav.servicio_ups === 'UPS_SAV', sav && String(sav.servicio_ups));
  check(`la expo UPS sigue usando la tabla de exportación (Brasil: ${ZONAS_UPS['Brasil']})`,
    sav && Number(sav.zona) === ZONAS_UPS['Brasil'], sav && String(sav.zona));
  check('y quedó como exportación', sav && sav.tipo_envio === 'exportacion');

  const dhl = await uno('SELECT * FROM envios WHERE numero_guia = ?', ['AUD-DHL-1']);
  check(`el DHL usa su única tabla (Bélgica: ${ZONAS_DHL['Bélgica']})`,
    dhl && Number(dhl.zona) === ZONAS_DHL['Bélgica'], dhl && String(dhl.zona));
  check('y su servicio_ups es NULL (no es UPS)', dhl && dhl.servicio_ups === null);

  // ── 2. La utilidad del perfil del cliente ───────────────────────────────────────────
  console.log('\n2. Perfil del cliente: la utilidad es la MISMA que en Salidas y Dashboard\n');

  // Cliente porcentual 70%: con la fórmula vieja (total × tarifa_pct) el envío de abajo
  // daría 210. La real (venta − costo del desglose congelado) da 160.
  await run("INSERT INTO clientes (id, nombre, tipo_cobro, tarifa_pct, activo) VALUES (960, 'AUD PERFIL', 'CC', 70, 1)");

  // e1 estimado: total 300, costo 100+10+30 = 140 → utilidad 160.
  await run(`INSERT INTO envios (cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino,
             peso_real, total_cobrado, flete, seguro, fuel)
             VALUES (960, '2026-07-10', 'DHL', 'exportacion', 'AUD-PERF-1', 'BRASIL', 5, 300, 100, 10, 30)`);
  const e1 = (await uno('SELECT id FROM envios WHERE numero_guia = ?', ['AUD-PERF-1'])).id;

  // e2 liquidado sin costo propio: manda la foto de la liquidación confirmada (99).
  await run(`INSERT INTO envios (cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino,
             peso_real, total_cobrado, liquidado)
             VALUES (960, '2026-08-05', 'DHL', 'exportacion', 'AUD-PERF-2', 'BRASIL', 5, 200, 1)`);
  const e2 = (await uno('SELECT id FROM envios WHERE numero_guia = ?', ['AUD-PERF-2'])).id;
  await run(`INSERT INTO liquidaciones (id, cliente_id, periodo_desde, periodo_hasta, total, estado)
             VALUES (900, 960, '2026-08-01', '2026-08-31', 200, 'confirmada')`);
  await run(`INSERT INTO liquidacion_items (liquidacion_id, envio_id, total_usd, utilidad_usd, fuel_pct_usado)
             VALUES (900, ?, 200, 99, 0)`, [e2]);

  // e3 con factura aprobada: el costo REAL pisa la foto de la liquidación (igual que el
  // Dashboard): venta 250 − costo facturado 150 = 100, aunque el item diga 999.
  await run(`INSERT INTO envios (cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino,
             peso_real, total_cobrado, liquidado, estado_revision, costo_facturado)
             VALUES (960, '2026-08-06', 'UPS', 'exportacion', 'AUD-PERF-3', 'BRASIL', 5, 250, 1, 'revisado_ok', 150)`);
  const e3 = (await uno('SELECT id FROM envios WHERE numero_guia = ?', ['AUD-PERF-3'])).id;
  await run(`INSERT INTO liquidacion_items (liquidacion_id, envio_id, total_usd, utilidad_usd, fuel_pct_usado)
             VALUES (900, ?, 250, 999, 0)`, [e3]);

  const rPerfil = await fetch(`${BASE}/api/clientes/960/perfil`, { headers: H });
  const perfil = await rPerfil.json().catch(() => null);
  check('el perfil responde', rPerfil.status === 200 && perfil && perfil.stats,
    JSON.stringify(perfil).slice(0, 120));

  const guiaDe = (id) => perfil.guias.find((g) => g.id === id) || {};
  check('envío estimado: utilidad = venta − costo (160, no 300×70% = 210)',
    guiaDe(e1).utilidad_usd === 160, String(guiaDe(e1).utilidad_usd));
  check('envío liquidado sin costo: manda la foto de la liquidación (99)',
    guiaDe(e2).utilidad_usd === 99, String(guiaDe(e2).utilidad_usd));
  check('envío con factura aprobada: el costo real pisa la foto (100, no 999)',
    guiaDe(e3).utilidad_usd === 100, String(guiaDe(e3).utilidad_usd));
  check('la utilidad total del perfil suma esas tres (359)',
    perfil.stats.utilidad_total_usd === 359, String(perfil.stats.utilidad_total_usd));
  check('la última liquidación es 2026-08', perfil.stats.ultima_liquidacion === '2026-08',
    String(perfil.stats.ultima_liquidacion));
  const mes08 = perfil.utilidad_mensual.find((m) => m.mes === '2026-08') || {};
  const mes07 = perfil.utilidad_mensual.find((m) => m.mes === '2026-07') || {};
  check('agosto agrupa 99 + 100 = 199 en 2 envíos',
    mes08.utilidad_usd === 199 && mes08.cantidad_envios === 2, JSON.stringify(mes08));
  check('julio agrupa 160 en 1 envío',
    mes07.utilidad_usd === 160 && mes07.cantidad_envios === 1, JSON.stringify(mes07));

  // ── 3. El seguro negociado se congela en el envío ───────────────────────────────────
  console.log('\n3. Cliente con seguro propio: el monto negociado queda congelado\n');

  // 1% con mínimo 10 (el caso Gianastasio/Cueros del comentario del motor).
  await run(`INSERT INTO clientes (id, nombre, tipo_cobro, tarifa_pct, activo, seguro_pct_propio, seguro_min_propio)
             VALUES (970, 'AUD SEGURO PROPIO', 'CC', 70, 1, 1, 10)`);

  const alta = await fetch(`${BASE}/api/envios`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: 970, fecha: '2026-08-15', tipo_envio: 'exportacion',
      pais_destino: 'BRASIL', courier: 'DHL', tipo_paquete: 'm',
      numero_guia: 'AUD-SEG-1', peso_real: 5, largo: 30, ancho: 20, alto: 20,
      fob: 2000, total_cobrado: 300,
    }),
  });
  const altaBody = await alta.json().catch(() => null);
  check('el alta del cliente con seguro propio entra', alta.status === 201,
    JSON.stringify(altaBody).slice(0, 120));
  const idSeg = altaBody.id;

  const seg = await uno('SELECT seguro, seguro_venta FROM envios WHERE id = ?', [idSeg]);
  check('seguro_venta congeló el monto NEGOCIADO (1% × 2000 = 20)',
    Number(seg.seguro_venta) === 20, String(seg.seguro_venta));
  const lista = calcSeguroDHL(2000).monto;
  check(`la columna seguro sigue siendo el COSTO de lista (${lista}), son dos números distintos`,
    Math.abs(Number(seg.seguro) - lista) < 0.005 && Number(seg.seguro) !== Number(seg.seguro_venta),
    `seguro=${seg.seguro}`);

  const rSal = await fetch(`${BASE}/api/salidas`, { headers: H });
  const salidas = await rSal.json().catch(() => []);
  const filaSeg = (Array.isArray(salidas) ? salidas : []).find((r) => r.id === idSeg) || {};
  check('la línea "Seguro" del desglose de venta en Salidas muestra 20, no la lista',
    filaSeg.venta_desglose && filaSeg.venta_desglose.seguro === 20,
    JSON.stringify(filaSeg.venta_desglose || null));

  const rPrev = await fetch(`${BASE}/api/liquidaciones/preview`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ cliente_id: 970, envio_ids: [idSeg] }),
  });
  const prev = await rPrev.json().catch(() => null);
  check('la liquidación al cliente también muestra el seguro negociado (20)',
    rPrev.status === 200 && prev && prev.items && prev.items[0].seguro === 20,
    JSON.stringify(prev && prev.items && prev.items[0]).slice(0, 140));
  check('y el desglose sigue cerrando exacto en el total (300)',
    prev && prev.items && Math.abs(
      prev.items[0].flete + prev.items[0].fuel + prev.items[0].seguro + prev.items[0].adicional
      - prev.items[0].total_usd
    ) < 0.005 && prev.items[0].total_usd === 300);

  // Editar el valor declarado desde Salidas rehace la foto (1% × 5000 = 50).
  const rPatch = await fetch(`${BASE}/api/salidas/${idSeg}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ fob: 5000 }),
  });
  check('el PATCH de fob entra', rPatch.status === 200);
  check('y seguro_venta se rehizo con el fob nuevo (50)',
    Number((await uno('SELECT seguro_venta FROM envios WHERE id = ?', [idSeg])).seguro_venta) === 50);

  // Fob chico: manda el MÍNIMO negociado (1% × 500 = 5 → piso 10).
  await fetch(`${BASE}/api/salidas/${idSeg}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ fob: 500 }),
  });
  check('con fob 500 aplica el mínimo negociado (10, no 1% = 5)',
    Number((await uno('SELECT seguro_venta FROM envios WHERE id = ?', [idSeg])).seguro_venta) === 10);

  // Cliente SIN seguro propio: seguro_venta queda NULL y todo sigue como siempre.
  const alta2 = await fetch(`${BASE}/api/envios`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: 960, fecha: '2026-08-15', tipo_envio: 'exportacion',
      pais_destino: 'BRASIL', courier: 'DHL', tipo_paquete: 'm',
      numero_guia: 'AUD-SEG-2', peso_real: 5, largo: 30, ancho: 20, alto: 20,
      fob: 2000, total_cobrado: 300,
    }),
  });
  const alta2Body = await alta2.json().catch(() => null);
  const segNulo = await uno('SELECT seguro_venta FROM envios WHERE id = ?', [alta2Body.id]);
  check('cliente sin seguro propio: seguro_venta queda NULL (escala de lista, como siempre)',
    segNulo.seguro_venta === null, String(segNulo.seguro_venta));

  // ── 4. direccion sigue al tipo de envío ─────────────────────────────────────────────
  console.log('\n4. La direccion sigue al tipo de envío en el alta manual\n');

  const altaImpo = await fetch(`${BASE}/api/envios`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: 960, fecha: '2026-08-18', tipo_envio: 'importacion',
      pais_destino: 'BRASIL', courier: 'UPS', servicio_ups: 'UPS_EXP', tipo_paquete: 'm',
      numero_guia: 'AUD-DIR-1', peso_real: 5, largo: 30, ancho: 20, alto: 20,
      total_cobrado: 100,
    }),
  });
  const altaImpoBody = await altaImpo.json().catch(() => null);
  check('el alta manual de una impo entra', altaImpo.status === 201,
    JSON.stringify(altaImpoBody).slice(0, 120));
  check('y queda con direccion=impo (antes: expo, el default)',
    (await uno('SELECT direccion FROM envios WHERE id = ?', [altaImpoBody.id])).direccion === 'impo');

  const putExpo = await fetch(`${BASE}/api/envios/${altaImpoBody.id}`, {
    method: 'PUT', headers: H, body: JSON.stringify({ tipo_envio: 'exportacion' }),
  });
  check('editar el tipo a exportación arrastra la direccion a expo', putExpo.status === 200
    && (await uno('SELECT direccion FROM envios WHERE id = ?', [altaImpoBody.id])).direccion === 'expo');

  // El script de corrección puntual: una fila incoherente se arregla, y es idempotente.
  await run("UPDATE envios SET direccion = 'expo' WHERE numero_guia = 'AUD-IMPO-1'");
  const { execFile } = require('child_process');
  const correr = () => new Promise((res) => {
    execFile('node', [path.join(__dirname, 'arreglar-direccion.js')],
      { env: { ...process.env, DB_PATH: DB } }, (err, stdout) => res({ err, stdout }));
  });
  const fix1 = await correr();
  check('arreglar-direccion corrige la fila incoherente', !fix1.err
    && (await uno("SELECT direccion FROM envios WHERE numero_guia = 'AUD-IMPO-1'")).direccion === 'impo',
    (fix1.stdout || '').slice(-120));
  const fix2 = await correr();
  check('y corrido de nuevo no encuentra nada (idempotente)',
    !fix2.err && /Nada que corregir/.test(fix2.stdout || ''), (fix2.stdout || '').slice(-120));

  await new Promise((res) => db.close(() => res()));
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
