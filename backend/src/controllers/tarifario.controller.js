const ExcelJS = require('exceljs');
const tarifarioService = require('../services/tarifario.service');
const { hoyLocal } = require('../utils/fecha');

/** Los interruptores del panel, leídos del query string y con los defaults acordados. */
function opcionesDe(req) {
  const q = req.query || {};
  const servicios = String(q.servicios || 'DHL').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    clienteId: req.params.id,
    servicios,
    tipo: q.tipo === 'import' ? 'import' : 'export',
    desde: q.desde !== undefined ? Number(q.desde) : 0.5,
    hasta: q.hasta !== undefined ? Number(q.hasta) : 50,
    paso: q.paso === undefined || q.paso === '' || q.paso === 'auto' ? 'auto' : Number(q.paso),
    combinar: q.combinar === '1' || q.combinar === 'true',
    base: ['alto', 'medio', 'bajo'].includes(q.base) ? q.base : 'alto',
    documentos: q.documentos !== '0',
  };
}

// GET /api/clientes/:id/tarifario
async function obtener(req, res, next) {
  try {
    const data = await tarifarioService.generarTarifario(opcionesDe(req));
    res.json(data);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
}

// GET /api/clientes/:id/tarifario.xlsx
//
// El Excel es para que la oficina pueda retocar algo a mano antes de mandarlo. Por eso
// mismo lleva la fecha y la versión IMPRESAS adentro: un archivo editable que anda dando
// vueltas por los mails deja de coincidir con el sistema y no hay forma de saber cuándo se
// generó ni quién le tocó un número.
async function excel(req, res, next) {
  try {
    const opts = opcionesDe(req);
    const data = await tarifarioService.generarTarifario(opts);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Nova Express';

    const VIOLETA = 'FF403754';
    const CORAL = 'FFEE6C52';

    for (const tabla of data.tablas) {
      const nombreHoja = `${tabla.titulo.replace(' (USD)', '')}${tabla.servicio ? ` ${tabla.servicio}` : ''}`
        .slice(0, 31);
      const ws = wb.addWorksheet(nombreHoja);

      ws.addRow([`Tarifario ${data.tipo === 'import' ? 'de importación' : 'de exportación'} — ${data.cliente.nombre}`]);
      ws.getRow(1).font = { bold: true, size: 14, color: { argb: VIOLETA } };
      ws.addRow([tabla.servicio
        ? tarifarioService.SERVICIOS[tabla.servicio].label
        : 'Tarifa aérea internacional']);
      ws.addRow([`Emitido ${hoyLocal()} · precios en USD · no incluyen recargo por combustible, seguro ni impuestos de destino`]);
      ws.addRow([]);

      const cab = ['Peso hasta (kg)', ...data.destinos.map((d) => d.nombre)];
      const filaCab = ws.addRow(cab);
      filaCab.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VIOLETA } };
        cell.alignment = { horizontal: 'center', wrapText: true };
      });

      for (const f of tabla.filas) {
        const fila = ws.addRow([f.peso, ...f.precios]);
        fila.getCell(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        fila.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CORAL } };
        fila.getCell(1).alignment = { horizontal: 'center' };
        for (let i = 2; i <= cab.length; i += 1) fila.getCell(i).numFmt = '#,##0.00';
      }

      ws.columns.forEach((col, i) => { col.width = i === 0 ? 16 : 15; });
      ws.addRow([]);
      ws.addRow(['Destinos:']).font = { bold: true };
      for (const d of data.destinos) ws.addRow([d.nombre, d.ejemplos]);
    }

    const nombre = `Tarifario_${String(data.cliente.nombre).replace(/[^A-Za-z0-9]+/g, '_')}_${hoyLocal()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
}

module.exports = { obtener, excel };
