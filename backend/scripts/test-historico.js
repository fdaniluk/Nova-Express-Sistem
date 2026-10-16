#!/usr/bin/env node
// Históricos (16/10/2026): la planilla SALIDAS entra a envios_historicos con
// scripts/importar-historico.js y el Dashboard la suma; el resto del sistema no la ve.
//   · bultos "1 de 2 / 2 de 2" = un envío de 2 bultos (kg sumados, facturable de la planilla)
//   · cargos posteriores (sección de arriba) → cargos_post del envío de esa guía
//   · NO VOLÓ afuera · guía que ya está en `envios` afuera · cliente sin match afuera
//   · alias de historico-alias.json · el nombre con "priority" cae en el cliente
//   · analitica: KPIs, serie, top clientes, países; plata en la calle no los cuenta
//   · correr dos veces no duplica
const fs = require('fs'); const path = require('path');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');
const { prepararDb } = require('./_base-test');
const DB = '/tmp/test_historico.db';
const XLS = '/tmp/test_historico.xlsx';
let ok = 0, fail = 0;
function check(n, c, d) { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? '  → ' + d : ''}`); } }

(async () => {
  prepararDb(DB, { desdeProduccion: false });
  process.env.DB_PATH = DB;
  const { initDb, getDb } = require('../src/db');
  await initDb(); const db = getDb();
  await db.prepare("INSERT INTO clientes (id, nombre, tipo_cobro) VALUES (501, 'CUEROS SANTA CRUZ', 'CC'), (502, 'GIANNASTACIO', 'S'), (503, 'Fagliano', 'D')").run();
  await db.prepare("INSERT INTO envios (cliente_id, fecha, courier, tipo_envio, numero_guia, pais_destino, cantidad_bultos, peso_real, peso_volumetrico, peso_facturable, total_cobrado, flete, no_volo) VALUES (503, '2025-03-05', 'UPS', 'exportacion', '1Z0000000000000001', 'usa', 1, 10, 1.6, 10, 500, 300, 0), (503, '2025-03-08', 'UPS', 'exportacion', '1Z0000000000000005', 'usa', 1, 5, 1, 5, 0, 0, 0)").run();

  // Planilla con el layout nuevo (col E = tipo de cobro). Arriba los cargos posteriores.
  const F = (s) => new Date(`${s}T12:00:00`);
  const hoja = [
    [null, null, null, null, null, null, null, null],
    [null, null, F('2025-03-02'), '1Z0000000000000002', 'CC', 'cueros', 'ddp 20,50', '1 de 1'],
    [null, null, F('2025-03-02'), '1Z0000000000000002', 'CC', 'cueros', 'residential 6', null],
    [null, null, F('2025-03-02'), '1Z9999999999999999', 'CC', 'cueros', 'surge fee 5', null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'FLETE ', 'DESCUENTO', 'SEGURO', 'FUEL ', 'DERECHOS', 'ADICIONALES', 'OTROS'],
    [1, 'UPS', F('2025-03-02'), '1Z0000000000000002', 'CC', 'cueros', 'alemania', '1 de 2', 'm', 23, 61, 61, 59, 43.9, 89, 48, 'si', 1650, 'ya liquidado', 1121.35, null, 296.93, null, 20.3, null, null, 24, null, 341.23, 780.12, 228.6],
    [1, 'UPS', F('2025-03-02'), '1Z0000000000000002', 'CC', 'cueros', 'alemania', '2 de 2', 'm', 24, 62, 61, 59, 44.6, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 0, 0, '#DIV/0!'],
    [2, 'DHL', F('2025-03-03'), '5534904185', 'S', 'giannastascio', 'usa', '1 de 1', 'm', 4, 40, 35, 31, 8.68, 9, 9.5, 'si', 170, 'ya liquidado', 256.13, null, 86.48, null, 17.5, 28.32, null, 9.31, null, 141.61, 114.52, 80.87],
    [3, 'UPS', F('2025-03-04'), '1Z0000000000000003', 'S', 'cueros priority', 'usa', '1 de 1', 'm', 2, 20, 20, 20, 1.6, 2, 2, 'si', 100, 'ya liquidado', 90, null, 50, null, null, 5, null, null, null, 55, 35, 63.6],
    [4, 'UPS', F('2025-03-05'), '1Z0000000000000001', 'D', 'fagliano', 'usa', '1 de 1', 'm', 10, 20, 20, 20, 1.6, 10, 10, 'si', 100, 'ya liquidado', 500, null, 300],
    [5, 'UPS', F('2025-03-06'), '1Z0000000000000004', 'D', 'desconocido total', 'usa', '1 de 1', 'm', 1, 10, 10, 10, 0.2, 1, 1, 'si', 50, 'ya liquidado', 80, null, 40],
    [6, 'DHL', F('2025-03-07'), '5534904186', 'S', 'giannastascio', 'usa NO VOLO', '1 de 1', 'm', 4, 40, 35, 31, 8.68, 9, 9.5, 'si', 170, 'NO VOLO', 256.13, null, 86.48],
    // En el sistema SIN precio: la planilla lo reemplaza en la analítica.
    [7, 'UPS', F('2025-03-08'), '1Z0000000000000005', 'D', 'fagliano', 'usa', '1 de 1', 'm', 5, 20, 20, 20, 1.6, 5, 5, 'si', 100, 'ya liquidado', 200, null, 120],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hoja, { cellDates: true }), 'MARZO 2025');
  XLSX.writeFile(wb, XLS);
  const ALIAS = path.join(__dirname, 'historico-alias.json');
  const aliasOrig = fs.readFileSync(ALIAS, 'utf8');
  fs.writeFileSync(ALIAS, JSON.stringify({ cueros: 501, giannastascio: 502 }));
  const correr = (extra = []) => execFileSync('node', [path.join(__dirname, 'importar-historico.js'), `--archivo=${XLS}`, ...extra], { env: { ...process.env, DB_PATH: DB }, encoding: 'utf8' });
  let salida;
  try {
    console.log('\n1. Vista previa\n');
    salida = correr();
    check('sin --grabar no graba', (await db.prepare('SELECT COUNT(*) AS n FROM envios_historicos').get()).n === 0);
    check('la vista previa dice cuántos van', /A grabar: 4 envíos de 3 clientes/.test(salida), salida.slice(0, 400));
    check('avisa el que reemplaza a uno del sistema sin precio', /SIN precio \(misma guía\): 1/.test(salida));
    check('lista el cliente sin match', /desconocido total/.test(salida));
    check('lista la guía que ya está en el sistema', /1 ya en el sistema/.test(salida));
    check('lista el NO VOLÓ', /1 NO VOLÓ/.test(salida));

    console.log('\n2. Grabar\n');
    salida = correr(['--grabar']);
    const h = await db.prepare('SELECT * FROM envios_historicos ORDER BY fecha').all();
    check('graba 4 envíos', h.length === 4, String(h.length));
    const e1 = h.find((x) => x.numero_guia === '1Z0000000000000002');
    check('los 2 bultos son un envío con kg sumados y facturable de la planilla', e1 && e1.cantidad_bultos === 2 && e1.peso_real === 47 && e1.peso_facturable === 89, JSON.stringify(e1));
    check('venta, desglose y país', e1 && e1.total_cobrado === 1121.35 && e1.flete === 296.93 && e1.seguro === 20.3 && e1.adicionales === 24 && e1.pais_destino === 'alemania' && e1.tipo_cobro === 'CC');
    check('cargos posteriores de la guía sumados (20,50 + 6)', e1 && e1.cargos_post === 26.5, String(e1 && e1.cargos_post));
    check('"cueros priority" cae en Cueros', h.find((x) => x.numero_guia === '1Z0000000000000003').cliente_id === 501);
    check('"giannastascio" cae en Giannastacio por el alias', h.find((x) => x.numero_guia === '5534904185').cliente_id === 502);
    check('guarda el nombre original de la planilla y la hoja', e1.cliente_excel === 'cueros' && e1.hoja === 'MARZO 2025');
    correr(['--grabar']);
    check('correr de nuevo no duplica', (await db.prepare('SELECT COUNT(*) AS n FROM envios_historicos').get()).n === 4);

    console.log('\n3. Analítica\n');
    const a = require('../src/services/analitica.service');
    const r = await a.analitica({ periodo: 'rango', desde: '2025-03-01', hasta: '2025-03-31' });
    check('KPI envíos = 4 históricos + 1 del sistema (el sin precio lo reemplaza la planilla)', r.kpis.envios === 5, String(r.kpis.envios));
    const ventaEsp = Math.round((1121.35 + 26.5 + 256.13 + 90 + 500 + 200) * 100) / 100;
    check('venta suma la de la planilla (con cargos post.) + la del sistema', r.kpis.venta === ventaEsp, `${r.kpis.venta} vs ${ventaEsp}`);
    const compraEsp = Math.round((296.93 + 20.3 + 24 + 26.5 + 86.48 + 17.5 + 28.32 + 9.31 + 50 + 5 + 300 + 120) * 100) / 100;
    check('compra = desglose estimado de la planilla', r.kpis.compra === compraEsp, `${r.kpis.compra} vs ${compraEsp}`);
    check('kg facturables', r.kpis.kg_fact === 89 + 9 + 2 + 10 + 5, String(r.kpis.kg_fact));
    check('sin venta: 0 (el del sistema sin precio ya no cuenta)', r.kpis.sin_venta.n === 0, JSON.stringify(r.kpis.sin_venta));
    check('top clientes: Cueros primero', r.top_clientes[0].nombre === 'CUEROS SANTA CRUZ' && r.top_clientes[0].envios === 2, JSON.stringify(r.top_clientes.map((c) => c.nombre)));
    check('países', r.paises.find((p) => p.pais === 'Alemania') && r.paises.find((p) => p.pais === 'Usa').envios === 4, JSON.stringify(r.paises));
    check('plata en la calle: los 2 del sistema (el reemplazado sigue ahí, es plata de verdad)', r.plata.sin_liquidar.n === 2, JSON.stringify(r.plata.sin_liquidar));
    check('sin liquidar del período: solo el del sistema con precio', r.kpis.sin_liquidar.n === 1);
    check('clientes nuevos cuenta a los históricos', r.ritmo.clientes_nuevos === 3, String(r.ritmo.clientes_nuevos));
    const d = await a.detalle({ periodo: 'rango', desde: '2025-03-01', hasta: '2025-03-31', kpi: 'venta' });
    const fh = d.filas.find((f) => f.guia === '1Z0000000000000002');
    check('detalle: la fila histórica viene marcada y con id negativo', fh && fh.historico === true && fh.id < 0 && fh.cargos_post === 26.5, JSON.stringify(fh));
    check('detalle: la fila del sistema no', d.filas.find((f) => f.guia === '1Z0000000000000001').historico === false);
    const rU = await a.analitica({ periodo: 'rango', desde: '2025-03-01', hasta: '2025-03-31', courier: 'DHL' });
    check('filtro por courier también aplica a los históricos', rU.kpis.envios === 1 && rU.kpis.venta === 256.13, JSON.stringify(rU.kpis));
    check('Salidas no los ve (envios sigue con 2)', (await db.prepare('SELECT COUNT(*) AS n FROM envios').get()).n === 2);

    console.log('\n4. --resto: los sin ficha van a un cliente comodín\n');
    salida = correr(['--grabar', '--resto']);
    const resto = await db.prepare("SELECT id FROM clientes WHERE nombre = 'Clientes históricos (sin ficha)'").get();
    check('crea el cliente comodín', !!resto);
    const hr = await db.prepare('SELECT * FROM envios_historicos WHERE numero_guia = ?').get('1Z0000000000000004');
    check('"desconocido total" ahora entra, al comodín', hr && resto && hr.cliente_id === resto.id, JSON.stringify(hr));
    check('total 5 históricos', (await db.prepare('SELECT COUNT(*) AS n FROM envios_historicos').get()).n === 5);
    correr(['--grabar', '--resto']);
    check('otra corrida no crea otro comodín', (await db.prepare("SELECT COUNT(*) AS n FROM clientes WHERE nombre = 'Clientes históricos (sin ficha)'").get()).n === 1);
    const r4 = await a.analitica({ periodo: 'rango', desde: '2025-03-01', hasta: '2025-03-31' });
    check('la analítica lo suma (6 envíos)', r4.kpis.envios === 6 && r4.top_clientes.some((c) => c.nombre === 'Clientes históricos (sin ficha)'), String(r4.kpis.envios));
  } finally {
    fs.writeFileSync(ALIAS, aliasOrig);
  }
  console.log(`\n${ok} pasaron · ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('✗', e); process.exit(1); });
