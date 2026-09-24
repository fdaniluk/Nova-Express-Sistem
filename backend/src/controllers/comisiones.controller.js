// Comisiones (24/09/2026). Todo el módulo es solo admin (ver routes/index.js).
const m = require('../models/comisiones.model');
const ExcelJS = require('exceljs');

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
};

const vendedores = manejar(async (req, res) => res.json({ vendedores: await m.listarVendedores() }));
const crearVendedor = manejar(async (req, res) => res.status(201).json(await m.crearVendedor(req.body || {})));
const editarVendedor = manejar(async (req, res) => res.json(await m.editarVendedor(req.params.id, req.body || {})));

const clientes = manejar(async (req, res) => res.json({ clientes: await m.clientesConVendedor() }));
const historial = manejar(async (req, res) => res.json({ historial: await m.historialCliente(req.params.id) }));
const asignar = manejar(async (req, res) => {
  const b = req.body || {};
  if (!b.vendedor_id) return res.status(400).json({ error: 'vendedor_id es obligatorio' });
  res.json(await m.asignar(req.params.id, { vendedor_id: Number(b.vendedor_id), desde: b.desde || null, comision_pct: b.comision_pct, usuario: req.usuario ? req.usuario.usuario : null }));
});
const deshacer = manejar(async (req, res) => res.json(await m.deshacerVigente(req.params.id)));

const meses = manejar(async (req, res) => res.json({ meses: await m.mesesDisponibles() }));
const resumen = manejar(async (req, res) => res.json(await m.resumen(String(req.query.mes || ''), req.query.tc || null)));
const detalle = manejar(async (req, res) => res.json({ envios: await m.detalle(String(req.query.mes || ''), req.query.vendedor ?? null) }));

// Excel: una hoja "Resumen" (vendedor → cliente) y una hoja por vendedor con sus envíos.
const excel = manejar(async (req, res) => {
  const mes = String(req.query.mes || '');
  const r = await m.resumen(mes, req.query.tc || null);
  const envios = await m.detalle(mes, null);
  const wb = new ExcelJS.Workbook(); wb.creator = 'Nova Express';
  const NUM = '#,##0.00';
  const cab = (ws) => { ws.getRow(1).font = { bold: true }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF1F8' } }; ws.views = [{ state: 'frozen', ySplit: 1 }]; };
  const ws = wb.addWorksheet('Resumen');
  ws.columns = [{ header: 'Vendedor', key: 'v', width: 18 }, { header: 'Cliente', key: 'c', width: 32 }, { header: 'Envíos', key: 'n', width: 8 },
    { header: 'Venta USD', key: 'venta', width: 14, style: { numFmt: NUM } }, { header: 'Utilidad USD', key: 'u', width: 14, style: { numFmt: NUM } },
    { header: '% comisión', key: 'p', width: 11 }, { header: 'Comisión sin sueldo USD', key: 'com', width: 16, style: { numFmt: NUM } },
    { header: 'Sueldo (piso) USD', key: 'piso', width: 16, style: { numFmt: NUM } }, { header: 'Utilidad sobre el sueldo USD', key: 'exc', width: 18, style: { numFmt: NUM } },
    { header: 'A pagar USD', key: 'pagar', width: 14, style: { numFmt: NUM } }];
  cab(ws);
  ws.addRow({ v: `Mes ${mes}`, c: r.tc ? `TC ${r.tc} (${r.tc_fuente})` : 'Sin tipo de cambio cargado', n: '', venta: '', u: '', p: '', com: '', piso: '', pagar: '' }).font = { italic: true };
  const grupos = [...r.vendedores, ...(r.sin_asignar.envios ? [r.sin_asignar] : [])];
  for (const g of grupos) {
    const fila = ws.addRow({ v: g.vendedor, c: `TOTAL ${g.vendedor}`, n: g.envios, venta: g.venta, u: g.utilidad, p: g.es_casa ? 'casa' : g.pct, com: g.comision, piso: g.piso_usd ?? '', exc: g.excedente ?? '', pagar: g.a_pagar ?? (g.piso_estado === 'falta TC' ? 'falta TC' : '') });
    fila.font = { bold: true };
    for (const c of g.clientes) ws.addRow({ v: '', c: c.cliente, n: c.envios, venta: c.venta, u: c.utilidad, p: c.pct, com: c.comision });
  }
  const t = ws.addRow({ v: 'TOTAL', c: '', n: r.total.envios, venta: r.total.venta, u: r.total.utilidad, p: '', com: r.total.comision, piso: '', pagar: r.total.a_pagar }); t.font = { bold: true };
  for (const g of grupos) {
    const w = wb.addWorksheet(g.vendedor.slice(0, 28));
    w.columns = [{ header: 'Fecha', key: 'f', width: 11 }, { header: 'Guía', key: 'g', width: 22 }, { header: 'Cliente', key: 'c', width: 30 }, { header: 'Courier', key: 'k', width: 8 },
      { header: 'Destino', key: 'd', width: 16 }, { header: 'Venta USD', key: 'venta', width: 12, style: { numFmt: NUM } }, { header: 'Utilidad USD', key: 'u', width: 12, style: { numFmt: NUM } },
      { header: 'Fuente', key: 'fu', width: 11 }, { header: '%', key: 'p', width: 6 }, { header: 'Comisión USD', key: 'com', width: 12, style: { numFmt: NUM } }];
    cab(w);
    for (const e of envios.filter((x) => (x.vendedor_id ?? null) === (g.vendedor_id ?? null))) {
      w.addRow({ f: e.fecha, g: e.numero_guia, c: e.cliente, k: e.courier, d: e.pais_destino, venta: e.venta, u: e.utilidad, fu: e.fuente, p: e.pct, com: e.comision });
    }
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="comisiones-${mes}.xlsx"`);
  await wb.xlsx.write(res); res.end();
});

module.exports = { vendedores, crearVendedor, editarVendedor, clientes, historial, asignar, deshacer, meses, resumen, detalle, excel };
