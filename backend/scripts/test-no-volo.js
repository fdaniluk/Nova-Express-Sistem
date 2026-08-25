#!/usr/bin/env node
/**
 * test-no-volo.js — el botón "NO VOLÓ" de Salidas (pedido de Felipe, 25/08/2026).
 *
 * QUÉ ES
 * Hay envíos que se cargan, se les emite la guía y no salen — ni van a salir por ahora,
 * y quizá nunca. La oficina los venía marcando a mano en el Excel: renglón pintado,
 * leyenda "NO VOLÓ", y la venta y los kilos borrados, para que un envío que nunca salió
 * no le moviera la estadística de fin de mes.
 *
 * En el sistema no hace falta borrar nada: los valores se conservan y dejan de contar.
 * Eso es lo que prueba esta tanda, en orden de riesgo:
 *
 *  1. QUE EL ENVÍO CONSERVE SU NÚMERO DE SALIDA. Es el pedido textual de la oficina: si el
 *     envío es el 27, marcarlo no lo puede convertir en otro número ni correr a los que
 *     vienen atrás. Un correlativo que se mueve solo rompe la referencia con el papel.
 *  2. QUE NO CUENTE EN EL DASHBOARD — ni en utilidad, ni en kilos, ni en cantidad de
 *     envíos, ni en el ticket promedio. Es el motivo por el que existe la marca.
 *  3. QUE NO SE PUEDA LIQUIDAR: no aparece en pendientes, y si alguien fuerza el id
 *     contra el preview, se rechaza. Facturarle al cliente un envío que no salió es el
 *     error caro que esto viene a evitar.
 *  4. QUE UN ENVÍO YA LIQUIDADO NO SE PUEDA MARCAR (409). Ya se le facturó al cliente:
 *     primero hay que sacarlo de la liquidación.
 *  5. QUE LOS VALORES NO SE BORREN Y QUE DESMARCAR LO DEVUELVA EXACTO a como estaba.
 *     Es la diferencia con el Excel: allá se borraban a mano y no había vuelta atrás.
 *  6. Que el Excel del cierre de mes lo muestre con la leyenda y NO lo sume en el total.
 *  7. Los bordes: cuerpo inválido (400) y envío inexistente (404).
 *
 *   cd backend && npm run test-no-volo     (EN POWERSHELL, no en el servidor)
 */

const { spawn } = require('child_process');
const path = require('path');
const ExcelJS = require('exceljs');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3959;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_no_volo.db';
const TOKEN = 'token-test-no-volo';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
let matarServidor = () => {};
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else {
    fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`);
  }
}

const cerca = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

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
  const usuarioId = await abrirSesion(DB, TOKEN);

  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB);
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));

  // El dashboard y el cierre de mes van por permiso propio, no por rol.
  await run('UPDATE usuarios SET ver_dashboard = 1, cerrar_mes = 1 WHERE id = ?', [usuarioId]);
  await run("INSERT INTO clientes (id, nombre, tipo_cobro, tarifa_pct, activo) VALUES (960, 'NO VOLO TEST', 'CC', 70, 1)");

  const alta = async (guia, extra = {}) => {
    const r = await fetch(`${BASE}/api/envios`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        cliente_id: 960, fecha: '2026-08-10', tipo_envio: 'exportacion',
        pais_destino: 'BRASIL', courier: 'DHL', tipo_paquete: 'm',
        numero_guia: guia, peso_real: 10, largo: 30, ancho: 20, alto: 20,
        total_cobrado: 400, ...extra,
      }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const marcar = async (id, valor) => {
    const r = await fetch(`${BASE}/api/salidas/${id}/no-volo`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ no_volo: valor }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const leer = async (id) => (await q('SELECT * FROM envios WHERE id = ?', [id]))[0];
  const salidas = async () => (await fetch(`${BASE}/api/salidas`, { headers: H })).json();
  const metricas = async () =>
    (await fetch(`${BASE}/api/dashboard/metricas?mes=2026-08`, { headers: H })).json();
  const enSalidas = (lista, id) => lista.find((e) => e.id === id);

  const a = await alta('NOVOLO-A');
  const b = await alta('NOVOLO-B');
  const c = await alta('NOVOLO-C');
  check('los tres envíos de prueba entran',
    a.status === 201 && b.status === 201 && c.status === 201,
    JSON.stringify([a.status, b.status, c.status]));

  // ── 1. El número de salida no se mueve ──────────────────────────────────────────────
  console.log('\n1. El envío conserva su número de salida\n');

  const antesLista = await salidas();
  const numB = enSalidas(antesLista, b.body.id).numero_salida;
  const numC = enSalidas(antesLista, c.body.id).numero_salida;

  const m1 = await marcar(b.body.id, 1);
  check('marcar responde 200', m1.status === 200, JSON.stringify(m1.body).slice(0, 120));
  check('la respuesta dice que quedó marcado', m1.body && m1.body.no_volo === true);
  check('quedó guardado en la base', Number((await leer(b.body.id)).no_volo) === 1);
  check('quedó registrado quién lo marcó', Boolean((await leer(b.body.id)).no_volo_usuario));
  check('y cuándo', Boolean((await leer(b.body.id)).no_volo_en));

  const despuesLista = await salidas();
  check('el envío SIGUE apareciendo en Salidas', Boolean(enSalidas(despuesLista, b.body.id)));
  check('viene marcado como no_volo', enSalidas(despuesLista, b.body.id).no_volo === true);
  check('CONSERVA su número de salida',
    enSalidas(despuesLista, b.body.id).numero_salida === numB,
    `era ${numB}, ahora ${enSalidas(despuesLista, b.body.id).numero_salida}`);
  check('y no corre el número del que viene atrás',
    enSalidas(despuesLista, c.body.id).numero_salida === numC,
    `era ${numC}, ahora ${enSalidas(despuesLista, c.body.id).numero_salida}`);

  // ── 2. El dashboard deja de contarlo ────────────────────────────────────────────────
  console.log('\n2. No cuenta en las estadísticas del dashboard\n');

  const mB = await leer(b.body.id);
  const dash = await metricas();

  await marcar(b.body.id, 0);
  const dashTodos = await metricas();
  await marcar(b.body.id, 1);

  check('la cantidad de envíos baja en uno',
    dash.envios_totales === dashTodos.envios_totales - 1,
    `${dash.envios_totales} vs ${dashTodos.envios_totales}`);
  check('los kilos bajan exactamente el peso facturable del envío',
    cerca(dash.kilos_facturados, dashTodos.kilos_facturados - mB.peso_facturable),
    `${dash.kilos_facturados} vs ${dashTodos.kilos_facturados} − ${mB.peso_facturable}`);
  check('los bultos también bajan',
    dash.bultos_despachados === dashTodos.bultos_despachados - mB.cantidad_bultos);
  check('la utilidad del mes cambia (el envío ya no aporta)',
    !cerca(dash.utilidad_neta_usd, dashTodos.utilidad_neta_usd)
      || Number(mB.total_cobrado) === 0,
    `${dash.utilidad_neta_usd} vs ${dashTodos.utilidad_neta_usd}`);
  check('el cliente aparece con un envío menos en el top',
    (dash.top_clientes.find((t) => t.id === 960) || {}).envios
      === (dashTodos.top_clientes.find((t) => t.id === 960) || {}).envios - 1);
  check('tampoco cuenta como pendiente de liquidar',
    dash.envios_pendientes_liquidar === dashTodos.envios_pendientes_liquidar - 1);

  // ── 3. No se puede liquidar ─────────────────────────────────────────────────────────
  console.log('\n3. Un envío que no voló no se le factura al cliente\n');

  const pend = await (await fetch(`${BASE}/api/liquidaciones/pendientes?cliente_id=960`, { headers: H })).json();
  const idsPend = (pend[0] ? pend[0].envios : []).map((e) => e.id);
  check('no aparece en la lista de pendientes de liquidar', !idsPend.includes(b.body.id),
    JSON.stringify(idsPend));
  check('los otros dos sí aparecen',
    idsPend.includes(a.body.id) && idsPend.includes(c.body.id), JSON.stringify(idsPend));

  const prev = await fetch(`${BASE}/api/liquidaciones/preview`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ cliente_id: 960, envio_ids: [a.body.id, b.body.id] }),
  });
  check('forzar el id contra el preview se rechaza con 400', prev.status === 400, String(prev.status));

  // ── 4. Un envío ya liquidado no se puede marcar ─────────────────────────────────────
  console.log('\n4. Un envío ya liquidado no se puede marcar\n');

  await run('UPDATE envios SET liquidado = 1 WHERE id = ?', [a.body.id]);
  const mLiq = await marcar(a.body.id, 1);
  check('responde 409 y no lo marca', mLiq.status === 409, String(mLiq.status));
  check('el mensaje explica qué hacer',
    /liquidaci/i.test((mLiq.body && mLiq.body.error) || ''), (mLiq.body || {}).error);
  check('en la base sigue sin marcar', Number((await leer(a.body.id)).no_volo) === 0);

  // ── 5. Los valores se conservan y el mismo botón lo deshace ─────────────────────────
  console.log('\n5. No se borra nada: desmarcar lo devuelve exacto\n');

  const marcado = await leer(b.body.id);
  check('el peso facturable sigue guardado', Number(marcado.peso_facturable) === Number(mB.peso_facturable));
  check('el precio de venta sigue guardado', Number(marcado.total_cobrado) === Number(mB.total_cobrado));
  check('el flete tampoco se tocó', Number(marcado.flete || 0) === Number(mB.flete || 0));

  const m0 = await marcar(b.body.id, 0);
  check('desmarcar responde 200', m0.status === 200);
  check('la marca se fue', Number((await leer(b.body.id)).no_volo) === 0);
  check('y se limpia quién lo había marcado', (await leer(b.body.id)).no_volo_usuario === null);
  const vuelta = await metricas();
  check('el dashboard vuelve a contarlo, con el mismo número de antes',
    vuelta.envios_totales === dashTodos.envios_totales
      && cerca(vuelta.kilos_facturados, dashTodos.kilos_facturados),
    `${vuelta.envios_totales}/${vuelta.kilos_facturados} vs ${dashTodos.envios_totales}/${dashTodos.kilos_facturados}`);
  await marcar(b.body.id, 1);

  // ── 6. El Excel del cierre de mes ───────────────────────────────────────────────────
  console.log('\n6. El cierre de mes lo muestra, con leyenda, y no lo suma\n');

  const r = await fetch(`${BASE}/api/salidas/exportar?tipo=mes&mes=2026-08`, {
    headers: { Cookie: `nova_session=${TOKEN}` },
  });
  check('la descarga responde 200', r.status === 200, String(r.status));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const ws = wb.getWorksheet('Salidas');

  const colEstado = ws.getRow(6).values.slice(1).findIndex((v) => String(v) === 'Estado') + 1;
  const colPeso = ws.getRow(6).values.slice(1).findIndex((v) => String(v) === 'P. Fact (kg)') + 1;
  const colTotal = ws.getRow(6).values.slice(1).findIndex((v) => String(v) === 'Total (USD)') + 1;

  let filaNoVolo = null;
  let sumaPesoVisible = 0;
  for (let f = 7; f < ws.rowCount; f++) {
    if (String(ws.getRow(f).getCell(colEstado).value) === 'NO VOLO') filaNoVolo = f;
    sumaPesoVisible += Number(ws.getRow(f).getCell(colPeso).value) || 0;
  }
  check('el envío sale en la planilla con la leyenda NO VOLO', filaNoVolo !== null);
  check('con sus valores a la vista (no se borran)',
    filaNoVolo !== null && Number(ws.getRow(filaNoVolo).getCell(colTotal).value) > 0);
  check('el encabezado avisa cuántos no volaron',
    /NO VOLO/.test(String(ws.getCell(4, 1).value)), String(ws.getCell(4, 1).value));

  const filaTotal = ws.getRow(ws.rowCount);
  check('la fila de TOTAL está al pie', String(filaTotal.getCell(1).value) === 'TOTAL');
  check('y el TOTAL de kilos NO incluye al que no voló',
    cerca(filaTotal.getCell(colPeso).value, sumaPesoVisible - Number(mB.peso_facturable)),
    `total ${filaTotal.getCell(colPeso).value}, filas ${sumaPesoVisible}, envío ${mB.peso_facturable}`);

  // ── 7. Bordes ───────────────────────────────────────────────────────────────────────
  console.log('\n7. Cuerpo inválido y envío inexistente\n');

  const malo = await fetch(`${BASE}/api/salidas/${c.body.id}/no-volo`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ no_volo: 'si' }),
  });
  check('no_volo con un texto da 400', malo.status === 400, String(malo.status));
  check('un envío que no existe da 404', (await marcar(999999, 1)).status === 404);
  check('marcar dos veces no rompe nada',
    (await marcar(c.body.id, 1)).status === 200 && (await marcar(c.body.id, 1)).status === 200);

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
