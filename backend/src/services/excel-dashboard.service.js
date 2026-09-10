// El Excel del dashboard (10/09/2026): una hoja por bloque de lo que se ve en pantalla,
// con los mismos filtros. Es un respaldo para mirar afuera del sistema, no un cierre.
const ExcelJS = require('exceljs');

const NUM = '#,##0.00';
const KG = '#,##0.0';

function hoja(wb, nombre, columnas, filas) {
  const ws = wb.addWorksheet(nombre);
  ws.columns = columnas.map((c) => ({ header: c.h, key: c.k, width: c.w || 14, style: c.f ? { numFmt: c.f } : undefined }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF1F8' } };
  filas.forEach((f) => ws.addRow(f));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return ws;
}

async function armar(d) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Nova Express';
  const k = d.kpis, a = d.kpis_ant;
  hoja(wb, 'Resumen', [
    { h: 'Indicador', k: 'i', w: 28 }, { h: 'Período', k: 'p', f: NUM }, { h: 'Comparación', k: 'c', f: NUM }, { h: 'Variación %', k: 'v', f: '0.0' },
  ], [
    { i: `Período ${d.periodo.desde} → ${d.periodo.hasta}`, p: '', c: `${d.comparacion.desde} → ${d.comparacion.hasta}`, v: '' },
    { i: 'Envíos', p: k.envios, c: a.envios, v: d.variaciones.envios },
    { i: 'Bultos', p: k.bultos, c: a.bultos, v: '' },
    { i: 'Kg facturables', p: k.kg_fact, c: a.kg_fact, v: d.variaciones.kg_fact },
    { i: 'Venta USD', p: k.venta, c: a.venta, v: d.variaciones.venta },
    { i: 'Compra USD', p: k.compra, c: a.compra, v: d.variaciones.compra },
    { i: 'Profit USD', p: k.profit, c: a.profit, v: d.variaciones.profit },
    { i: 'Margen %', p: k.margen_pct, c: a.margen_pct, v: d.variaciones.margen_pts },
    { i: 'Sin liquidar (envíos)', p: k.sin_liquidar.n, c: '', v: '' },
    { i: 'Sin liquidar USD', p: k.sin_liquidar.usd, c: '', v: '' },
  ]);
  hoja(wb, 'Por mes', [
    { h: 'Mes', k: 'm', w: 10 }, { h: 'Envíos', k: 'e' }, { h: 'Kg facturables', k: 'k', f: KG }, { h: 'Venta USD', k: 'v', f: NUM },
    { h: 'Compra USD', k: 'c', f: NUM }, { h: 'Profit USD', k: 'p', f: NUM }, { h: 'Margen %', k: 'mg', f: '0.0' },
    { h: 'UPS venta', k: 'uv', f: NUM }, { h: 'DHL venta', k: 'dv', f: NUM },
  ], d.series.meses.map((m, i) => ({
    m, e: d.series.envios[i], k: d.series.kg[i], v: d.series.venta[i], c: d.series.compra[i], p: d.series.profit[i],
    mg: (d.margen.meses[i] || {}).pct, uv: d.mix.UPS.venta[i], dv: d.mix.DHL.venta[i],
  })));
  hoja(wb, 'Clientes', [
    { h: '#', k: 'n', w: 5 }, { h: 'Cliente', k: 'c', w: 30 }, { h: 'Envíos', k: 'e' }, { h: 'Kg', k: 'k', f: KG }, { h: 'Venta USD', k: 'v', f: NUM },
    { h: 'Compra USD', k: 'co', f: NUM }, { h: 'Profit USD', k: 'p', f: NUM }, { h: 'Margen %', k: 'mg', f: '0.0' }, { h: 'Part. venta %', k: 'pv', f: '0.0' }, { h: 'Var. venta %', k: 'vv', f: '0.0' },
  ], d.top_clientes.map((c, i) => ({ n: i + 1, c: c.nombre, e: c.envios, k: c.kg_fact, v: c.venta, co: c.compra, p: c.profit, mg: c.margen_pct, pv: c.part_venta_pct, vv: c.var_venta })));
  hoja(wb, 'Destinos', [
    { h: 'País', k: 'p', w: 26 }, { h: 'Envíos', k: 'e' }, { h: 'Kg', k: 'k', f: KG }, { h: 'Venta USD', k: 'v', f: NUM },
  ], d.paises.map((p) => ({ p: p.pais, e: p.envios, k: p.kg, v: p.venta })));
  hoja(wb, 'Estimado vs real', [
    { h: 'Mes', k: 'm', w: 10 }, { h: 'Guías', k: 'g' }, { h: 'Con factura', k: 'c' }, { h: 'Cobertura %', k: 'cb', f: '0.0' },
    { h: 'Compra estimada', k: 'ce', f: NUM }, { h: 'Costo facturado', k: 'cr', f: NUM }, { h: 'Profit estimado', k: 'pe', f: NUM }, { h: 'Profit real', k: 'pr', f: NUM },
    { h: 'Kg facturables', k: 'kf', f: KG }, { h: 'Kg facturados', k: 'kr', f: KG },
  ], d.real.map((r) => ({ m: r.mes, g: r.guias, c: r.cruzadas, cb: r.cobertura_pct, ce: r.compra_est, cr: r.compra_real, pe: r.profit_est, pr: r.profit_real, kf: r.kg_fact, kr: r.kg_real })));
  return wb.xlsx.writeBuffer();
}

module.exports = { armar };
