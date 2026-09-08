// Proforma / commercial invoice de un envío (guías, etapa 1 — 08/09/2026).
//
// Reproduce el Excel de una hoja que la oficina arma a mano (muestra "Zappala 070926 UK",
// ver GUIAS-UPS.md 4-quater): COMMERCIAL INVOICE, Nº y fecha, Shipper (el cliente, con
// CUIT, dirección, CP, ciudad, provincia, país, teléfono, contacto), Consignee (el
// destinatario de la libreta), tabla Quantity / Description / Unit value / Total value,
// COUNTRY OF ORIGIN: ARGENTINA y bloque Manufacturer (el mismo remitente). Sin logo ni firma.
//
// armarProforma() devuelve los datos ya resueltos (los usa el JSON y, en la etapa 2, la
// guía UPS: InvoiceLineTotal y los Products del InternationalForms salen de acá).
// renderHtml() arma la hoja A4 lista para imprimir desde el navegador.
const { getDb } = require('../db');
const { normalizarDestino } = require('../utils/paises');
const remitentesModel = require('./../models/remitentes.model');

function redondear2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function fechaLarga(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  if (!y || !m || !d) return String(iso);
  return `${d}/${m}/${y}`;
}

// Un envío sin renglones cargados igual tiene proforma: un renglón con el contenido
// declarado (o el tipo de paquete) por el valor FOB. Así la hoja nunca sale vacía.
function renglonesDe(envio, items) {
  if (items.length) return items;
  const descripcion = envio.contenido
    || (String(envio.tipo_paquete ?? '').toLowerCase() === 'd' ? 'Documents' : 'Merchandise');
  return [{ orden: 1, cantidad: 1, descripcion, valor_unitario: redondear2(envio.fob) }];
}

// Filas crudas del cliente que necesita la hoja (mismo SELECT para envío y para guía).
const CLIENTE_SQL = `SELECT id, nombre, nombre_nova, cuit, direccion_recoleccion, codigo_postal, localidad,
                            provincia, telefono, contacto, email FROM clientes WHERE id = ?`;

/**
 * Arma la proforma a partir de piezas ya cargadas. `envio` puede ser un envío real o el
 * "envío a precargar" de una guía (mismos campos: fecha, numero_guia, courier, ddp,
 * cantidad_bultos, peso_real, fob, contenido, tipo_paquete, pais_destino, proforma_numero).
 */
// `remitente` (opcional): perfil de la libreta de remitentes; si no viene, la ficha del cliente.
function armar({ envio, cliente, remitente, destinatario, items, origen }) {
  const renglones = renglonesDe(envio, items).map((it) => ({
    cantidad: Number(it.cantidad) || 0,
    descripcion: it.descripcion,
    valor_unitario: redondear2(it.valor_unitario),
    total: redondear2((Number(it.cantidad) || 0) * (Number(it.valor_unitario) || 0)),
  }));
  const total = redondear2(renglones.reduce((s, r) => s + r.total, 0));

  const rem = remitente || remitentesModel.desdeCliente(cliente);
  const shipper = {
    nombre: rem.nombre,
    cuit: rem.cuit || '',
    direccion: rem.direccion || '',
    codigo_postal: rem.codigo_postal || '',
    ciudad: rem.ciudad || '',
    provincia: rem.provincia || '',
    pais: 'ARGENTINA',
    telefono: rem.telefono || '',
    contacto: rem.contacto || '',
    email: rem.email || '',
  };

  const paisDestino = destinatario?.pais || normalizarDestino(envio.pais_destino)?.destino || envio.pais_destino || '';
  const consignee = destinatario
    ? {
        nombre: destinatario.nombre,
        contacto: destinatario.contacto || '',
        direccion: [destinatario.direccion1, destinatario.direccion2, destinatario.direccion3].filter(Boolean).join(', '),
        codigo_postal: destinatario.codigo_postal || '',
        ciudad: destinatario.ciudad || '',
        estado: destinatario.estado || '',
        pais: paisDestino,
        telefono: destinatario.telefono || '',
        email: destinatario.email || '',
        tax_id: destinatario.tax_id || '',
      }
    : {
        nombre: '', contacto: '', direccion: '', codigo_postal: '', ciudad: '', estado: '',
        pais: paisDestino, telefono: '', email: '', tax_id: '',
      };

  return {
    ...origen,
    numero: envio.proforma_numero || '',
    fecha: envio.fecha,
    fecha_texto: fechaLarga(envio.fecha),
    numero_guia: envio.numero_guia || '',
    courier: envio.courier,
    servicio_ups: envio.servicio_ups || null,
    ddp: Boolean(envio.ddp),
    bultos: envio.cantidad_bultos || 1,
    peso_real: envio.peso_real,
    shipper,
    consignee,
    manufacturer: { nombre: shipper.nombre, cuit: shipper.cuit, direccion: shipper.direccion },
    pais_origen: 'ARGENTINA',
    renglones,
    total,
    moneda: 'USD',
    sin_destinatario: !destinatario,
    sin_renglones: items.length === 0,
  };
}

async function armarProforma(envioId) {
  const db = getDb();
  const envio = await db.prepare('SELECT * FROM envios WHERE id = ?').get(envioId);
  if (!envio) return null;
  const cliente = await db.prepare(CLIENTE_SQL).get(envio.cliente_id);
  const destinatario = envio.destinatario_id
    ? await db.prepare('SELECT * FROM destinatarios WHERE id = ?').get(envio.destinatario_id)
    : null;
  const items = await db
    .prepare('SELECT orden, cantidad, descripcion, valor_unitario FROM envio_items WHERE envio_id = ? ORDER BY orden, id')
    .all(envioId);
  const remitente = envio.remitente_id ? await db.prepare('SELECT * FROM remitentes WHERE id = ?').get(envio.remitente_id) : null;
  return armar({ envio, cliente, remitente, destinatario, items, origen: { envio_id: envio.id } });
}

// La misma hoja para una guía emitida desde el módulo Guías (precarga todavía sin envío).
async function armarProformaGuia(guiaId) {
  const db = getDb();
  const g = await db.prepare('SELECT * FROM guias WHERE id = ?').get(guiaId);
  if (!g) return null;
  const datos = JSON.parse(g.datos_json || '{}');
  const cliente = await db.prepare(CLIENTE_SQL).get(g.cliente_id);
  const destinatario = g.destinatario_id
    ? await db.prepare('SELECT * FROM destinatarios WHERE id = ?').get(g.destinatario_id)
    : null;
  const items = Array.isArray(datos.items) ? datos.items : [];
  const bultos = Array.isArray(datos.bultos) ? datos.bultos : [];
  const envio = {
    fecha: g.fecha,
    numero_guia: g.numero_guia,
    courier: g.courier,
    servicio_ups: g.servicio,
    ddp: g.ddp,
    cantidad_bultos: bultos.length || 1,
    peso_real: bultos.reduce((s, b) => s + (Number(b.peso_real) || 0), 0),
    fob: g.fob,
    contenido: g.contenido,
    tipo_paquete: 'm',
    pais_destino: datos.pais_destino,
    proforma_numero: g.proforma_numero,
  };
  const remitente = g.remitente_id ? await db.prepare('SELECT * FROM remitentes WHERE id = ?').get(g.remitente_id) : null;
  return armar({ envio, cliente, remitente, destinatario, items, origen: { guia_id: g.id, envio_id: g.envio_id || null } });
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function usd(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function linea(label, valor) {
  return `<div class="l"><span class="k">${esc(label)}</span><span class="v">${esc(valor)}</span></div>`;
}

function renderHtml(p) {
  const s = p.shipper;
  const c = p.consignee;
  const filas = p.renglones.map((r) => `
      <tr>
        <td class="n">${esc(r.cantidad)}</td>
        <td>${esc(r.descripcion)}</td>
        <td class="n">${usd(r.valor_unitario)}</td>
        <td class="n">${usd(r.total)}</td>
      </tr>`).join('');
  // La hoja de la oficina tiene 4 renglones fijos: se completan con vacíos para que la
  // tabla mida siempre lo mismo.
  const vacias = Math.max(0, 4 - p.renglones.length);
  const relleno = Array.from({ length: vacias }, () => '<tr class="vacia"><td>&nbsp;</td><td></td><td></td><td></td></tr>').join('');
  const avisos = [];
  if (p.sin_destinatario) avisos.push('Este envío no tiene destinatario cargado: el bloque Consignee sale vacío.');
  if (p.sin_renglones) avisos.push('Sin renglones cargados: se muestra un único renglón con el contenido y el valor FOB del envío.');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Commercial Invoice ${esc(p.numero || p.numero_guia || p.envio_id)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; background: #fff; }
  .hoja { width: 182mm; margin: 0 auto; padding: 8mm 0; font-size: 11pt; }
  h1 { text-align: center; font-size: 18pt; letter-spacing: 2px; margin: 0 0 6mm; }
  .cab { display: flex; justify-content: flex-end; gap: 12mm; margin-bottom: 6mm; font-size: 10.5pt; }
  .cab b { display: inline-block; min-width: 14mm; }
  .bloques { display: flex; gap: 8mm; margin-bottom: 6mm; }
  .bloque { flex: 1; border: 1px solid #333; padding: 3mm 4mm; min-height: 44mm; }
  .bloque h2 { font-size: 11pt; margin: 0 0 2mm; text-transform: uppercase; border-bottom: 1px solid #333; padding-bottom: 1mm; }
  .l { display: flex; gap: 3mm; font-size: 10pt; line-height: 1.45; }
  .k { color: #444; min-width: 26mm; }
  .v { flex: 1; word-break: break-word; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 4mm; }
  th, td { border: 1px solid #333; padding: 2mm 3mm; font-size: 10pt; vertical-align: top; }
  th { background: #eee; font-weight: bold; }
  th small { display: block; font-weight: normal; color: #555; font-size: 8.5pt; }
  td.n, th.n { text-align: right; white-space: nowrap; }
  tr.vacia td { height: 8mm; }
  tfoot td { font-weight: bold; }
  .origen { font-weight: bold; margin: 3mm 0 4mm; }
  .fab { border: 1px solid #333; padding: 3mm 4mm; }
  .fab h2 { font-size: 11pt; margin: 0 0 2mm; text-transform: uppercase; }
  .pie { margin-top: 6mm; font-size: 8.5pt; color: #666; display: flex; justify-content: space-between; }
  .avisos { background: #fff4e5; border: 1px solid #f0b060; padding: 3mm 4mm; margin-bottom: 5mm; font-size: 9.5pt; color: #7a4b00; }
  .barra { position: sticky; top: 0; background: #1f2a44; color: #fff; padding: 8px 14px; font-size: 13px; display: flex; gap: 12px; align-items: center; }
  .barra button { background: #f26a4b; color: #fff; border: 0; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; }
  @media print { .barra, .avisos { display: none; } .hoja { padding: 0; } }
</style>
</head>
<body>
<div class="barra">
  <button onclick="window.print()">Imprimir</button>
  <span>Proforma ${p.envio_id ? `del envío #${esc(p.envio_id)}` : `de la guía #${esc(p.guia_id)}`}${p.numero_guia ? ` · guía ${esc(p.numero_guia)}` : ''}</span>
</div>
<div class="hoja">
  ${avisos.length ? `<div class="avisos">${avisos.map(esc).join('<br>')}</div>` : ''}
  <h1>COMMERCIAL INVOICE</h1>
  <div class="cab">
    <div><b>Nº</b> ${esc(p.numero || '')}</div>
    <div><b>Date</b> ${esc(p.fecha_texto)}</div>
  </div>
  <div class="bloques">
    <div class="bloque">
      <h2>Shipper</h2>
      ${linea('Name', s.nombre)}
      ${linea('CUIT / CUIL', s.cuit)}
      ${linea('Address', s.direccion)}
      ${linea('ZIP', s.codigo_postal)}
      ${linea('City', [s.ciudad, s.provincia].filter(Boolean).join(', '))}
      ${linea('Country', s.pais)}
      ${linea('Phone', s.telefono)}
      ${linea('Contact', s.contacto)}
    </div>
    <div class="bloque">
      <h2>Consignee</h2>
      ${linea('Name', c.nombre)}
      ${c.contacto ? linea('Attn', c.contacto) : ''}
      ${linea('Address', c.direccion)}
      ${linea('ZIP', c.codigo_postal)}
      ${linea('City', [c.ciudad, c.estado].filter(Boolean).join(', '))}
      ${linea('Country', c.pais)}
      ${linea('Phone', c.telefono)}
      ${linea('E-mail', c.email)}
      ${c.tax_id ? linea('Tax ID', c.tax_id) : ''}
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th class="n">Quantity<small>Cantidad</small></th>
        <th>Description of goods<small>Descripción de la mercadería</small></th>
        <th class="n">Unit value (USD)<small>Valor unitario</small></th>
        <th class="n">Total value (USD)<small>Valor total</small></th>
      </tr>
    </thead>
    <tbody>${filas}${relleno}</tbody>
    <tfoot>
      <tr><td colspan="3" class="n">TOTAL USD</td><td class="n">${usd(p.total)}</td></tr>
    </tfoot>
  </table>
  <div class="origen">COUNTRY OF ORIGIN: ${esc(p.pais_origen)}</div>
  <div class="fab">
    <h2>Manufacturer</h2>
    ${linea('Name', p.manufacturer.nombre)}
    ${linea('CUIT', p.manufacturer.cuit)}
    ${linea('Address', p.manufacturer.direccion)}
  </div>
  <div class="pie">
    <span>${p.bultos} package(s)${p.peso_real ? ` · ${esc(p.peso_real)} kg` : ''}${p.ddp ? ' · DDP' : ''}</span>
    <span>${esc(p.courier)}${p.numero_guia ? ` ${esc(p.numero_guia)}` : ''}</span>
  </div>
</div>
</body>
</html>`;
}

module.exports = { armarProforma, armarProformaGuia, renderHtml };
