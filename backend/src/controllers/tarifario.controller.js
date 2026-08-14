const ExcelJS = require('exceljs');
const tarifarioService = require('../services/tarifario.service');
const { hoyLocal } = require('../utils/fecha');
const { getDb } = require('../db');

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
    // Bajar el Excel ES mandarlo: queda registrado igual que el PDF. Si el registro
    // fallara, el Excel sale igual — el registro es un respaldo, no una traba.
    await registrarEmision(req, 'excel', req.query || {}, data).catch((err) => {
      console.error('[tarifario] no se pudo registrar la emisión del Excel:', err.message);
    });
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

// ── El registro de lo emitido ────────────────────────────────────────────────
//
// Guarda LA GRILLA COMPLETA, no solo las opciones. Las tarifas cambian: ante un "vos me
// pasaste este precio", lo que hace falta es reabrir exactamente la hoja que salió, no
// regenerarla con los precios de hoy. Por eso el flujo de imprimir es: emitir (se genera
// y se guarda) → la hoja se dibuja DESDE lo guardado → se imprime. Lo archivado y lo
// impreso son la misma cosa por construcción.

async function registrarEmision(req, formato, opciones, datos) {
  const r = await getDb().prepare(
    `INSERT INTO tarifario_emitidos (cliente_id, usuario_id, usuario, formato, opciones, datos)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    datos.cliente.id,
    (req.usuario && req.usuario.id) || null,
    (req.usuario && req.usuario.usuario) || null,
    formato,
    JSON.stringify(opciones),
    JSON.stringify(datos),
  );
  return r.lastInsertRowid;
}

// POST /api/clientes/:id/tarifario/emitir  — body: las mismas opciones del GET + presentacion
async function emitir(req, res, next) {
  try {
    const q = req.body || {};
    const opts = opcionesDe({ params: req.params, query: q });
    const datos = await tarifarioService.generarTarifario(opts);
    const id = await registrarEmision(req, 'pdf', q, datos);
    res.status(201).json({ id });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
}

// GET /api/clientes/:id/tarifario/emitidos — la lista, sin la grilla (pesa)
async function emitidos(req, res, next) {
  try {
    const filas = await getDb().prepare(
      `SELECT id, usuario, formato, opciones, creado_en
       FROM tarifario_emitidos WHERE cliente_id = ? ORDER BY id DESC LIMIT 50`
    ).all(req.params.id);
    res.json(filas.map((f) => ({ ...f, opciones: JSON.parse(f.opciones) })));
  } catch (e) { next(e); }
}

// GET /api/tarifario/emitidos/:id — una emisión completa, con la grilla tal como salió
async function emitido(req, res, next) {
  try {
    const f = await getDb().prepare('SELECT * FROM tarifario_emitidos WHERE id = ?').get(req.params.id);
    if (!f) return res.status(404).json({ error: 'No existe esa emisión' });
    res.json({
      id: f.id, cliente_id: f.cliente_id, usuario: f.usuario, formato: f.formato,
      creado_en: f.creado_en, opciones: JSON.parse(f.opciones), datos: JSON.parse(f.datos),
    });
  } catch (e) { next(e); }
}

// ── Los presets del panel ────────────────────────────────────────────────────
// Una combinación de opciones con nombre, para no tildar quince casillas cada vez.

async function presets(req, res, next) {
  try {
    const filas = await getDb().prepare('SELECT * FROM tarifario_presets ORDER BY nombre').all();
    res.json(filas.map((f) => ({ id: f.id, nombre: f.nombre, opciones: JSON.parse(f.opciones) })));
  } catch (e) { next(e); }
}

async function guardarPreset(req, res, next) {
  try {
    const nombre = String(req.body && req.body.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'El preset necesita un nombre.' });
    if (nombre.length > 60) return res.status(400).json({ error: 'El nombre es demasiado largo (máximo 60).' });
    const opciones = req.body.opciones;
    if (!opciones || typeof opciones !== 'object') {
      return res.status(400).json({ error: 'Faltan las opciones del preset.' });
    }
    // Mismo nombre = se pisa. Es lo que uno espera de "guardar" sobre un preset existente.
    await getDb().prepare(
      `INSERT INTO tarifario_presets (nombre, opciones) VALUES (?, ?)
       ON CONFLICT(nombre) DO UPDATE SET opciones = excluded.opciones`
    ).run(nombre, JSON.stringify(opciones));
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
}

async function borrarPreset(req, res, next) {
  try {
    await getDb().prepare('DELETE FROM tarifario_presets WHERE id = ?').run(req.params.presetId);
    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = {
  obtener, excel, emitir, emitidos, emitido, presets, guardarPreset, borrarPreset,
};
