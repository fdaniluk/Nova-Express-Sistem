#!/usr/bin/env node
/**
 * test-dashboard-analitica.js — los números del dashboard nuevo (10/09/2026,
 * DASHBOARD-REDISENO.md) contra una base armada a mano.
 *
 *   · KPIs del período y del período de comparación (previo / mismo del año pasado);
 *   · NO VOLÓ afuera de todo; filtros de courier y tipo;
 *   · series por mes, mix de couriers, top de clientes con participación y variación;
 *   · destinos con "Estados Unidos" / "estados unidos" unificados;
 *   · estimado vs real solo con guías cruzadas, con cobertura del mes;
 *   · margen por mes y la línea objetivo (Configuración);
 *   · plata en la calle; ritmo; el Excel baja con sus hojas.
 *
 *   cd backend && node scripts/test-dashboard-analitica.js
 */
const { spawn } = require('child_process');
const path = require('path');
const sqlite3 = require('sqlite3');
const ExcelJS = require('exceljs');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3966;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_dashboard_analitica.db';
const TOKEN = 'token-test-dash-analitica';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };

let ok = 0; let fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else { fail += 1; console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`); }
}
const cerca = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) < tol;
function sql(query, params = []) {
  return new Promise((res, rej) => {
    const d = new sqlite3.Database(DB);
    d.all(query, params, (e, r) => { d.close(() => (e ? rej(e) : res(r || []))); });
  });
}
function ym(d, n) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`; }

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = ''; let logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  let muerto = false;
  const matar = () => { if (!muerto) { muerto = true; try { srv.kill(); } catch { /* ya */ } } };
  process.on('exit', matar);
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  const uid = await abrirSesion(DB, TOKEN);
  await sql('UPDATE usuarios SET ver_dashboard = 1 WHERE id = ?', [uid]);
  await sql('INSERT INTO configuracion_nova (id, fuel_pct) VALUES (1, 36) ON CONFLICT(id) DO UPDATE SET fuel_pct = 36');

  const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
  const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: H, body: JSON.stringify(b) });
  const put = (u, b) => fetch(BASE + u, { method: 'PUT', headers: H, body: JSON.stringify(b) });
  const get = (u) => fetch(BASE + u, { headers: H });

  const cA = await j(await post('/api/clientes', { nombre: 'ALFA SA', tarifa_pct: 80 }));
  const cB = await j(await post('/api/clientes', { nombre: 'BETA SRL', tarifa_pct: 80 }));

  // Fechas: este mes (M0) y el anterior (M-1) son el "período"; M-2 y M-3 el previo.
  const hoy = new Date();
  const M0 = ym(hoy, 0), M1 = ym(hoy, -1), M2 = ym(hoy, -2), M3 = ym(hoy, -3);
  // Se insertan directo con el desglose de compra fijo, para que los números sean míos.
  let n = 0;
  const envio = async (o) => {
    n += 1;
    const guia = `99500000${String(n).padStart(2, '0')}`;
    await sql(`INSERT INTO envios (cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, peso_real, peso_facturable, cantidad_bultos,
        total_cobrado, flete, descuento, seguro, fuel, derechos, adicionales, otros, liquidado, no_volo, estado_revision, costo_facturado, peso_facturado, fecha_liquidacion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?)`,
    [o.cliente, o.fecha, o.courier || 'UPS', o.tipo || 'exportacion', guia, o.pais, o.kg, o.kg, o.bultos || 1,
      o.venta, o.flete, o.fuel || 0, o.liquidado ? 1 : 0, o.no_volo ? 1 : 0, o.revision || null, o.costo_real ?? null, o.peso_real_ups ?? null, o.fecha_liq || null]);
  };
  // Período (M0 + M1): 6 envíos válidos + 1 NO VOLÓ
  await envio({ cliente: cA.id, fecha: `${M0}-05`, pais: 'Estados Unidos', kg: 10, venta: 300, flete: 100, fuel: 36 });                          // compra 136 profit 164
  await envio({ cliente: cA.id, fecha: `${M0}-08`, pais: 'estados unidos', kg: 20, venta: 500, flete: 200, fuel: 72, revision: 'revisado_ok', costo_real: 250, peso_real_ups: 21 }); // compra real 250, profit real 250 (est 228)
  await envio({ cliente: cB.id, fecha: `${M1}-10`, pais: 'Chile', kg: 5, venta: 150, flete: 50, fuel: 18, courier: 'DHL', liquidado: 1, fecha_liq: `${M1}-20` });   // compra 68 profit 82
  await envio({ cliente: cB.id, fecha: `${M1}-12`, pais: 'ESTADOS UNIDOS', kg: 15, venta: 400, flete: 150, fuel: 54, revision: 'a_revisar', costo_real: 230, peso_real_ups: 16 }); // est compra 204 profit 196; a_revisar → oficial estimado
  await envio({ cliente: cA.id, fecha: `${M1}-15`, pais: 'Brasil', kg: 8, venta: 0, flete: 80, fuel: 0, tipo: 'importacion' });                  // sin venta: profit 0 (fallback null→0)
  await envio({ cliente: cB.id, fecha: `${M0}-02`, pais: 'Chile', kg: 12, venta: 350, flete: 120, fuel: 43.2, courier: 'DHL', bultos: 2 });     // compra 163.2 profit 186.8
  await envio({ cliente: cA.id, fecha: `${M0}-03`, pais: 'Estados Unidos', kg: 99, venta: 9999, flete: 100, no_volo: 1 });                       // NO VOLÓ: afuera
  // Período previo (M2 + M3): 2 envíos
  await envio({ cliente: cA.id, fecha: `${M2}-05`, pais: 'Estados Unidos', kg: 10, venta: 200, flete: 100, fuel: 36 });
  await envio({ cliente: cB.id, fecha: `${M3}-05`, pais: 'Chile', kg: 10, venta: 200, flete: 100, fuel: 36, courier: 'DHL' });

  const desde = `${M1}-01`;
  const hastaD = new Date(Date.UTC(Number(M0.slice(0, 4)), Number(M0.slice(5, 7)), 0));
  const hasta = hastaD.toISOString().slice(0, 10);   // último día de M0
  const qBase = `periodo=rango&desde=${desde}&hasta=${hasta}`;

  console.log('\n1. KPIs del período y comparación\n');
  let r = await get(`/api/dashboard/analitica?${qBase}`);
  let d = await j(r);
  check('GET /dashboard/analitica → 200', r.status === 200, JSON.stringify(d).slice(0, 200));
  check('el período va del 1 del mes anterior al último día de este mes', d.periodo.desde === desde && d.periodo.hasta === hasta, JSON.stringify(d.periodo));
  check('6 envíos (el NO VOLÓ no cuenta)', d.kpis.envios === 6, d.kpis.envios);
  check('bultos 7 (uno de 2)', d.kpis.bultos === 7, d.kpis.bultos);
  check('kg facturables 70 (sin los 99 del NO VOLÓ)', cerca(d.kpis.kg_fact, 70), d.kpis.kg_fact);
  check('venta 1700', cerca(d.kpis.venta, 1700), d.kpis.venta);
  // compra oficial: 136 + 250(real aprobada) + 68 + 204 + 163.2 = 821.2. El envío SIN precio
  // (Brasil, compra 80) queda afuera de Venta/Compra/Profit y se informa aparte (29/09/2026):
  // antes sumaba a la compra y no a la venta, y el dashboard mostraba compra > venta con
  // profit positivo.
  check('compra 821.20 (el aprobado usa el costo real 250, el a_revisar sigue estimado, el sin precio queda afuera)', cerca(d.kpis.compra, 821.2), d.kpis.compra);
  check('el envío sin precio se informa aparte: 1 envío, USD 80 de compra', d.kpis.sin_venta && d.kpis.sin_venta.n === 1 && cerca(d.kpis.sin_venta.compra, 80), JSON.stringify(d.kpis.sin_venta));
  // profit oficial: 164 + 250 + 82 + 196 + 186.8 = 878.8
  check('profit 878.80 (sin venta → afuera, no negativo)', cerca(d.kpis.profit, 878.8), d.kpis.profit);
  check('margen 107.0% (profit/compra, sobre los envíos con precio)', cerca(d.kpis.margen_pct, 107.0, 0.06), d.kpis.margen_pct);
  check('sin liquidar: 5 envíos (uno está liquidado)', d.kpis.sin_liquidar.n === 5, JSON.stringify(d.kpis.sin_liquidar));
  check('comparación "previo": mismo largo justo antes, con 2 envíos y venta 400', d.comparacion.modo === 'previo' && d.kpis_ant.envios === 2 && cerca(d.kpis_ant.venta, 400), JSON.stringify({ c: d.comparacion, ant: d.kpis_ant }));
  check('variación de venta = +325% (1700 vs 400)', cerca(d.variaciones.venta, 325, 0.06), d.variaciones.venta);
  check('variación de envíos = +200%', cerca(d.variaciones.envios, 200, 0.06), d.variaciones.envios);
  r = await get(`/api/dashboard/analitica?${qBase}&comparar=anio`);
  const dA = await j(r);
  check('comparar=anio → mismas fechas del año pasado (sin envíos → variaciones null)', dA.comparacion.modo === 'anio' && dA.comparacion.desde === `${Number(M1.slice(0, 4)) - 1}${desde.slice(4)}` && dA.kpis_ant.envios === 0 && dA.variaciones.venta === null, JSON.stringify(dA.comparacion));

  console.log('\n2. Filtros\n');
  const dU = await j(await get(`/api/dashboard/analitica?${qBase}&courier=UPS`));
  check('courier=UPS → 4 envíos, venta 1200', dU.kpis.envios === 4 && cerca(dU.kpis.venta, 1200), `${dU.kpis.envios} / ${dU.kpis.venta}`);
  const dI = await j(await get(`/api/dashboard/analitica?${qBase}&tipo=importacion`));
  check('tipo=importacion → 1 envío (el de Brasil)', dI.kpis.envios === 1 && dI.paises[0].pais === 'Brasil', JSON.stringify(dI.paises));
  const dM = await j(await get('/api/dashboard/analitica?periodo=mes'));
  // "Este mes" a la misma altura (29/09/2026): los KPIs llegan hasta HOY y se comparan con
  // el 1..hoy del mes anterior, no con el mes anterior entero. Los envíos de prueba de M0
  // son los días 02, 05 y 08: cuentan los que ya pasaron.
  const diaHoy = new Date().getDate();
  const esperadosM0 = [2, 5, 8].filter((d) => d <= diaHoy).length;
  check(`periodo=mes → solo este mes hasta hoy: ${esperadosM0} envío(s)`, dM.kpis.envios === esperadosM0 && dM.periodo.meses.length === 1, `${dM.kpis.envios} ${JSON.stringify(dM.periodo.meses)}`);
  check('   y compara a la misma altura del mes anterior (1..hoy)', dM.comparacion.misma_altura === true && dM.comparacion.desde === `${M1}-01` && Number(dM.comparacion.hasta.slice(8, 10)) <= diaHoy, JSON.stringify(dM.comparacion));
  check('   con una proyección del mes por ritmo de día hábil', dM.proyeccion && dM.proyeccion.metodo === 'ritmo_habil' && dM.proyeccion.habiles_mes >= 20 && dM.proyeccion.mes_anterior && ['baja', 'media', 'alta', 'cerrado'].includes(dM.proyeccion.confianza), JSON.stringify(dM.proyeccion));
  {
    // Unitario, con fechas fijas: 15 de septiembre 2026 (martes; 11 hábiles pasados de 22).
    const A = require('../src/services/analitica.service');
    const c = A.compararMismaAltura('2026-09-01', '2026-10-01', 'previo', '2026-09-15');
    check('   15/09 → compara con 01/08..15/08', c.desde === '2026-08-01' && c.hasta === '2026-08-16' && c.hasta_periodo === '2026-09-16', JSON.stringify(c));
    const c31 = A.compararMismaAltura('2026-03-01', '2026-04-01', 'previo', '2026-03-30');
    check('   30/03 → febrero no tiene 30: compara con febrero entero', c31.hasta === '2026-03-01', JSON.stringify(c31));
    check('   un mes cerrado no se recorta', A.compararMismaAltura('2026-08-01', '2026-09-01', 'previo', '2026-09-15') === null);
    check('   días hábiles de septiembre 2026 = 22, hasta el 15 = 11', A.diasHabiles('2026-09-01', '2026-10-01') === 22 && A.diasHabiles('2026-09-01', '2026-09-16') === 11);
    const fake = (fecha, kg, venta) => ({ fecha, peso_facturable: kg, total: venta, cantidad_bultos: 1, flete: 10, fuel: 0 });
    const pr = A.proyectarMes([fake('2026-09-02', 100, 500), fake('2026-09-10', 120, 600)], '2026-09-01', '2026-10-01', '2026-09-15', [fake('2026-08-05', 300, 1000)]);
    check('   proyección: 220 kg en 11 hábiles → 440 kg en 22; confianza alta; +46,7 % vs 300 del mes anterior', pr.kg_fact === 440 && pr.envios === 4 && pr.confianza === 'alta' && pr.vs_mes_anterior.kg_fact === 46.7 && pr.avance_pct === 50, JSON.stringify(pr));
    // Feriados y puentes (utils/habiles.js): julio 2026 pierde el 9 y el 10, agosto el 17.
    check('   feriados: julio 2026 = 21 hábiles (9 y 10), agosto = 20 (17)', A.diasHabiles('2026-07-01', '2026-08-01') === 21 && A.diasHabiles('2026-08-01', '2026-09-01') === 20);
    // Misma altura también en "Este año" y "12 meses" (el mes en curso del período anterior
    // se corta el mismo día).
    const cA = A.compararMismaAltura('2026-01-01', '2026-10-01', 'anio', '2026-09-15');
    check('   Este año vs año pasado al 15/09 → 01/01/2025..15/09/2025', cA.desde === '2025-01-01' && cA.hasta === '2025-09-16', JSON.stringify(cA));
    const c12 = A.compararMismaAltura('2025-10-01', '2026-10-01', 'previo', '2026-09-15');
    check('   12 meses al 15/09 → 01/10/2024..15/09/2025', c12.desde === '2024-10-01' && c12.hasta === '2025-09-16', JSON.stringify(c12));
    // Precisión histórica: se hace la misma cuenta, a la misma altura, sobre los meses
    // cerrados. Mes A: todo parejo (la proyección acierta); mes B: la mitad del mes con 1
    // envío por día y la otra mitad con 3 (a mitad de mes la proyección erra −50 %).
    const mesDe = (ym, porDia) => {
      const out = [];
      for (let d = 1; d <= 31; d++) {
        const f = `${ym}-${String(d).padStart(2, '0')}`;
        if (new Date(f + 'T12:00:00').getMonth() + 1 !== Number(ym.slice(5))) break;
        for (let i = 0; i < porDia(d); i++) out.push(fake(f, 10, 0));
      }
      return out;
    };
    const hA = { mes: '2026-06', envios: mesDe('2026-06', () => 2) };
    const hB = { mes: '2026-05', envios: mesDe('2026-05', (d) => (d <= 15 ? 1 : 3)) };
    const hChico = { mes: '2026-04', envios: [fake('2026-04-10', 5, 0)] };
    const prec = A.precisionHistorica([hChico, hB, hA], 11, 22);
    check('   precisión: ignora meses de menos de 30 envíos y mide el error de cada mes cerrado', prec && prec.meses.join() === '2026-05,2026-06' && Math.abs(prec.envios.max) <= 5 && prec.envios.min < -30 && prec.envios.min > -50, JSON.stringify(prec));
    const pr2 = A.proyectarMes([fake('2026-09-02', 100, 500), fake('2026-09-10', 120, 600)], '2026-09-01', '2026-10-01', '2026-09-15', [fake('2026-08-05', 300, 1000)], [hB, hA]);
    check('   con esa historia la confianza baja y el rango incluye la proyección (440 kg)', pr2.confianza === 'baja' && pr2.rango.kg_fact && pr2.rango.kg_fact.min <= 440 && pr2.rango.kg_fact.max > 600, JSON.stringify({ c: pr2.confianza, r: pr2.rango, p: pr2.precision && pr2.precision.kg_fact }));
  }
  const d12 = await j(await get('/api/dashboard/analitica'));
  check('sin parámetros → últimos 12 meses (12 meses en la serie, los 8 envíos)', d12.periodo.meses.length === 12 && d12.kpis.envios === 8, `${d12.periodo.meses.length} / ${d12.kpis.envios}`);

  console.log('\n3. Series, mix, clientes, destinos\n');
  check('serie de meses = [M-1, M0]', JSON.stringify(d.series.meses) === JSON.stringify([M1, M0]), JSON.stringify(d.series.meses));
  check('kg por mes: 28 y 42', cerca(d.series.kg[0], 28) && cerca(d.series.kg[1], 42), JSON.stringify(d.series.kg));
  check('la serie de comparación tiene 2 meses (M-3, M-2) alineados por posición', d.series.meses_ant.length === 2 && cerca(d.series.kg_ant[0], 10) && cerca(d.series.kg_ant[1], 10), JSON.stringify(d.series.kg_ant));
  check('mix: UPS 4 envíos / DHL 2', d.mix_total.UPS.envios === 4 && d.mix_total.DHL.envios === 2);
  check('mix por mes DHL envíos = [1, 1]', JSON.stringify(d.mix.DHL.envios) === JSON.stringify([1, 1]), JSON.stringify(d.mix.DHL.envios));
  const top = d.top_clientes;
  check('top clientes ordenado por venta: BETA (900) antes que ALFA (800)', top[0].nombre === 'BETA SRL' && cerca(top[0].venta, 900) && top[1].nombre === 'ALFA SA' && cerca(top[1].venta, 800), JSON.stringify(top.map((c) => [c.nombre, c.venta])));
  check('participación en la venta: BETA 52.9%, ALFA 47.1%', cerca(top[0].part_venta_pct, 52.9, 0.06) && cerca(top[1].part_venta_pct, 47.1, 0.06), `${top[0].part_venta_pct} / ${top[1].part_venta_pct}`);
  check('variación de venta de ALFA contra el previo: +300% (800 vs 200)', cerca(top[1].var_venta, 300, 0.06), top[1].var_venta);
  check('cada cliente trae envíos, kg, profit y margen', top[0].envios === 3 && cerca(top[0].kg_fact, 32) && cerca(top[0].profit, 464.8) && top[0].margen_pct != null, JSON.stringify(top[0]));
  check('clientes activos = 2', d.clientes_activos === 2);
  const eeuu = d.paises.find((p) => /estados unidos/i.test(p.pais));
  check('destinos: "Estados Unidos" / "estados unidos" / "ESTADOS UNIDOS" son UNO con 3 envíos', eeuu && eeuu.envios === 3 && d.paises.filter((p) => /estados/i.test(p.pais)).length === 1, JSON.stringify(d.paises));
  check('y se muestra prolijo ("Estados Unidos")', eeuu && eeuu.pais === 'Estados Unidos', eeuu && eeuu.pais);
  check('destinos ordenados por envíos: Estados Unidos, Chile, Brasil', d.paises.map((p) => p.pais).join(',') === 'Estados Unidos,Chile,Brasil', d.paises.map((p) => p.pais).join(','));

  console.log('\n4. Estimado vs real\n');
  check('solo los meses con guías cruzadas (los dos tienen una)', d.real.length === 2 && d.real.every((x) => x.cruzadas === 1), JSON.stringify(d.real));
  const rM0 = d.real.find((x) => x.mes === M0);
  check(`${M0}: 3 guías, 1 cruzada → cobertura 33.3%`, rM0 && rM0.guias === 3 && cerca(rM0.cobertura_pct, 33.3, 0.06), JSON.stringify(rM0));
  check('  compra estimada 272 vs facturada 250; profit estimado 228 vs real 250', rM0 && cerca(rM0.compra_est, 272) && cerca(rM0.compra_real, 250) && cerca(rM0.profit_est, 228) && cerca(rM0.profit_real, 250), JSON.stringify(rM0));
  check('  kg nuestros 20 vs facturados 21', rM0 && cerca(rM0.kg_fact, 20) && cerca(rM0.kg_real, 21));
  const rM1 = d.real.find((x) => x.mes === M1);
  check(`${M1}: la guía a_revisar también cuenta como cruzada (real 400−230=170 vs est 196), 0 aprobadas`, rM1 && cerca(rM1.profit_real, 170) && cerca(rM1.profit_est, 196) && rM1.aprobadas === 0, JSON.stringify(rM1));

  console.log('\n5. Margen y objetivo\n');
  check('margen por mes con los dos meses', d.margen.meses.length === 2 && d.margen.meses.every((m) => m.pct != null), JSON.stringify(d.margen.meses));
  check('sin objetivo cargado → objetivo_pct null (sin línea)', d.margen.objetivo_pct === null);
  r = await put('/api/configuracion/margen-objetivo', { margen_objetivo_pct: 55 });
  check('PUT /configuracion/margen-objetivo 55 → ok', r.status === 200 && (await j(r)).margen_objetivo_pct === 55);
  d = await j(await get(`/api/dashboard/analitica?${qBase}`));
  check('ahora la analítica trae objetivo 55', d.margen.objetivo_pct === 55);
  r = await put('/api/configuracion/margen-objetivo', { margen_objetivo_pct: '' });
  check('vacío lo saca', r.status === 200 && (await j(r)).margen_objetivo_pct === null);
  r = await put('/api/configuracion/margen-objetivo', { margen_objetivo_pct: 900 });
  check('900 → 400', r.status === 400);

  console.log('\n6. Plata en la calle y ritmo\n');
  check('sin liquidar (global): 7 envíos (los 8 menos el liquidado; el NO VOLÓ no cuenta)', d.plata.sin_liquidar.n === 7, JSON.stringify(d.plata.sin_liquidar));
  check('desvíos sin revisar: 1 (a_revisar), USD 26 de más (230 − 204)', d.plata.desvios_sin_revisar.n === 1 && cerca(d.plata.desvios_sin_revisar.usd, 26), JSON.stringify(d.plata.desvios_sin_revisar));
  check('en disputa: 0', d.plata.disputa.n === 0);
  check('ritmo: kg por envío 11.7 (70/6), venta por envío 283.33', cerca(d.ritmo.kg_envio, 11.7, 0.06) && cerca(d.ritmo.venta_envio, 283.33), JSON.stringify(d.ritmo));
  check('  días carga → liquidación = 10 (el único liquidado)', d.ritmo.dias_liquidacion === 10, d.ritmo.dias_liquidacion);
  check('  clientes nuevos del período: al menos los 2 creados hoy', d.ritmo.clientes_nuevos >= 2, d.ritmo.clientes_nuevos);

  console.log('\n7. Excel\n');
  r = await get(`/api/dashboard/analitica.xlsx?${qBase}`);
  check('GET analitica.xlsx → 200 xlsx', r.status === 200 && /spreadsheetml/.test(r.headers.get('content-type')), r.headers.get('content-type'));
  const buf = Buffer.from(await r.arrayBuffer());
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const hojas = wb.worksheets.map((w) => w.name);
  check('hojas: Resumen, Por mes, Clientes, Destinos, Estimado vs real', hojas.join('|') === 'Resumen|Por mes|Clientes|Destinos|Estimado vs real', hojas.join('|'));
  const wsC = wb.getWorksheet('Clientes');
  check('la hoja Clientes tiene a BETA primero con venta 900', wsC.getRow(2).getCell(2).value === 'BETA SRL' && cerca(wsC.getRow(2).getCell(5).value, 900), JSON.stringify(wsC.getRow(2).values));

  console.log('\n8. Permiso\n');
  await sql('UPDATE usuarios SET ver_dashboard = 0 WHERE id = ?', [uid]);
  r = await get(`/api/dashboard/analitica?${qBase}`);
  check('sin ver_dashboard → 403', r.status === 403, String(r.status));

  matar();
  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('✗ error inesperado:', e); process.exit(1); });
