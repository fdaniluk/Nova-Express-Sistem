#!/usr/bin/env node
/**
 * importar-liquidador.js — pasa un "liquidador" del sistema viejo (.xls por cliente) a una
 * PROPUESTA de matriz de profit del sistema nuevo, para que administración la revise.
 *
 * Pedido de Felipe (07/09/2026): ~40 clientes, trabajo de una vez. Detalle y decisiones:
 * docs/claude/IMPORTAR-LIQUIDADORES.md.
 *
 * QUÉ HACE (no toca la base):
 *   1. Lee la hoja `c+p` del .xls: el PRECIO FINAL que hoy se le cobra al cliente, por zona
 *      (1-6) y peso (pasos de 0,5 kg), separado en DOCUMENTOS y PAQUETES.
 *   2. Detecta el courier/servicio (UPS Expedited / UPS Saver / DHL) por los nombres de hoja y
 *      del archivo. Se puede forzar con --servicio=UPS_EXP|UPS_SAVER|DHL.
 *   3. Para cada zona y cada peso calcula el flete de tabla del sistema NUEVO (motor único,
 *      `desglosarCosto` con zonaOverride) y el % implícito: precio_viejo / flete_nuevo − 1.
 *      Se respeta el PRECIO FINAL, no el % viejo: los liquidadores con tabla de costo vieja
 *      (DHL 0290008) tienen % que no significan nada solos (FAGLIANO: −4 %).
 *   4. Propone UN % por zona y banda (las 9 bandas de la matriz: 0-5 · 5-10 · 10-15 · 15-20 ·
 *      20-25 · 25-30 · 30-40 · 40-50 · 50+): la mediana de los % implícitos de la banda,
 *      redondeada a 0,5. Y muestra cuánto se aleja cada peso del precio viejo con ese %.
 *   5. Escribe un Excel de revisión por cliente y un JSON con las filas listas para cargar en
 *      `profit_overrides` (la carga es OTRO paso, con OK de Felipe: regla del 12/08).
 *
 *   cd backend && node scripts/importar-liquidador.js "C:\dev\liquidadores\CASABLANCA.xls" [más .xls]
 *   cd backend && node scripts/importar-liquidador.js --carpeta="C:\dev\liquidadores"
 *
 * Salida: <carpeta del .xls>/revision/<nombre>.revision.xlsx y .propuesta.json
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { desglosarCosto, redondear2 } = require('../src/services/calculos.service');

const BANDAS = [[0, 5], [5, 10], [10, 15], [15, 20], [20, 25], [25, 30], [30, 40], [40, 50], [50, null]];
const UMBRAL_AVISO_PCT = 3;      // desvío del precio viejo con el % propuesto que se marca en rojo
const SERVICIO_LABEL = { UPS_EXP: 'UPS Expedited', UPS_SAVER: 'UPS Saver', DHL: 'DHL' };

// ── Lectura del .xls ─────────────────────────────────────────────────────────
function leerLiquidador(archivo, servicioForzado) {
  const wb = XLSX.readFile(archivo, { cellDates: false });
  const nombres = wb.SheetNames;
  const hojaCP = nombres.find((n) => n.trim().toLowerCase() === 'c+p');
  if (!hojaCP) throw new Error(`no tiene hoja "c+p" (hojas: ${nombres.join(', ')})`);
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[hojaCP], { header: 1, raw: true, defval: '' });

  // Secciones: DOCUMENTOS / MUESTRAS (o PAQUETES). Cada fila útil: [peso, z1..z6].
  const secciones = { documentos: [], paquetes: [] };
  let actual = null;
  for (const f of filas) {
    const a = f[0];
    if (typeof a === 'string' && a.trim()) {
      const t = a.trim().toUpperCase();
      if (t.startsWith('DOCUMENT')) actual = 'documentos';
      else if (t.startsWith('MUESTRA') || t.startsWith('PAQUETE') || t.includes('PARCEL')) actual = 'paquetes';
      continue;
    }
    if (typeof a === 'number' && a > 0 && actual) {
      const zonas = f.slice(1, 7).map((v) => (typeof v === 'number' ? v : null));
      if (zonas.every((v) => v === null)) continue;
      secciones[actual].push({ peso: a, zonas });
    }
  }
  if (!secciones.paquetes.length) throw new Error('la hoja "c+p" no tiene filas de paquetes');

  // La hoja `profit` del liquidador (el % VIEJO, sobre la tabla de costo vieja): solo para
  // mostrarlo al lado del propuesto. Misma forma que c+p.
  const profitViejo = {};   // `${peso}|${zona}` → % (0,4 → 40)
  const hojaProfit = nombres.find((n) => n.trim().toLowerCase() === 'profit');
  if (hojaProfit) {
    let sec = null;
    for (const f of XLSX.utils.sheet_to_json(wb.Sheets[hojaProfit], { header: 1, raw: true, defval: '' })) {
      const a = f[0];
      if (typeof a === 'string' && a.trim()) {
        const t = a.trim().toUpperCase();
        if (t.startsWith('DOCUMENT') || t.includes('DOCUMENTS')) sec = 'doc';
        else if (t.startsWith('MUESTRA') || t.startsWith('PAQUETE') || t.includes('PARCEL')) sec = 'pkg';
        continue;
      }
      if (typeof a === 'number' && a > 0 && sec === 'pkg') {
        f.slice(1, 7).forEach((v, i) => { if (typeof v === 'number') profitViejo[`${a}|${i + 1}`] = v * 100; });
      }
    }
  }

  // Courier/servicio: nombre de archivo y hojas de costo.
  const pista = `${path.basename(archivo)} ${nombres.join(' ')}`.toUpperCase();
  let servicio = servicioForzado;
  if (!servicio) {
    if (/SAVER/.test(pista)) servicio = 'UPS_SAVER';
    else if (/UPS/.test(pista)) servicio = 'UPS_EXP';
    else servicio = 'DHL';
  }
  const hojaCosto = nombres.find((n) => /costo/i.test(n)) || '—';
  return { servicio, hojaCosto, secciones, hojas: nombres, profitViejo };
}

// ── Motor nuevo ──────────────────────────────────────────────────────────────
function fleteNuevo(servicio, zona, peso, contenido) {
  const d = desglosarCosto({
    pais: 'ZONA', tipo: 'export', servicio, pesoFacturable: peso, fob: 0, fuelPct: 0,
    zonaOverride: zona, contenido, bultos: [{ peso_real: peso, largo: 1, ancho: 1, alto: 1 }],
  });
  return d && d.flete > 0 ? d.flete : null;
}

function bandaDe(peso) {
  return BANDAS.find(([lo, hi]) => peso > lo && (hi === null || peso <= hi)) || BANDAS[BANDAS.length - 1];
}
const bandaLabel = ([lo, hi]) => (hi === null ? `${lo}+` : `${lo}-${hi}`);

function mediana(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const redondearMedio = (n) => Math.round(n * 2) / 2;

// ── Análisis ─────────────────────────────────────────────────────────────────
function analizar(liq) {
  const { servicio, secciones } = liq;
  const detalle = [];   // una fila por peso × zona
  for (const { peso, zonas } of secciones.paquetes) {
    zonas.forEach((precioViejo, i) => {
      if (precioViejo === null || precioViejo <= 0) return;
      const zona = i + 1;
      const flete = fleteNuevo(servicio, zona, peso, 'paquete');
      const implicito = flete ? (precioViejo / flete - 1) * 100 : null;
      const pctViejo = liq.profitViejo[`${peso}|${zona}`];
      detalle.push({ zona, peso, banda: bandaLabel(bandaDe(peso)), precio_viejo: precioViejo, flete_nuevo: flete, pct_implicito: implicito, pct_viejo: pctViejo != null ? pctViejo : null });
    });
  }

  // Propuesta por zona × banda.
  const propuesta = {};   // `${zona}|${banda}` → { pct, n, desvio_max_pct, desvio_max_usd }
  for (const fila of detalle) {
    if (fila.pct_implicito === null) continue;
    const k = `${fila.zona}|${fila.banda}`;
    (propuesta[k] = propuesta[k] || { zona: fila.zona, banda: fila.banda, implicitos: [] }).implicitos.push(fila.pct_implicito);
  }
  for (const p of Object.values(propuesta)) {
    p.pct = redondearMedio(mediana(p.implicitos));
    p.n = p.implicitos.length;
    p.min = Math.min(...p.implicitos);
    p.max = Math.max(...p.implicitos);
  }
  for (const fila of detalle) {
    const p = propuesta[`${fila.zona}|${fila.banda}`];
    if (!p || fila.flete_nuevo === null) { fila.precio_nuevo = null; fila.dif_usd = null; fila.dif_pct = null; continue; }
    fila.pct_propuesto = p.pct;
    fila.precio_nuevo = redondear2(fila.flete_nuevo * (1 + p.pct / 100));
    fila.dif_usd = redondear2(fila.precio_nuevo - fila.precio_viejo);
    fila.dif_pct = redondear2((fila.precio_nuevo / fila.precio_viejo - 1) * 100);
    fila.aviso = Math.abs(fila.dif_pct) > UMBRAL_AVISO_PCT;
  }
  for (const p of Object.values(propuesta)) {
    const suyas = detalle.filter((f) => f.zona === p.zona && f.banda === p.banda && f.dif_pct !== null);
    p.desvio_max_pct = suyas.length ? Math.max(...suyas.map((f) => Math.abs(f.dif_pct))) : null;
    p.desvio_max_usd = suyas.length ? Math.max(...suyas.map((f) => Math.abs(f.dif_usd))) : null;
    p.avisos = suyas.filter((f) => f.aviso).length;
  }

  // Documentos: solo informativo. La matriz nueva no distingue documentos; DHL tiene tabla
  // de documento hasta 2 kg y ahí sí se puede mirar el % implícito.
  const documentos = [];
  for (const { peso, zonas } of secciones.documentos) {
    zonas.forEach((precioViejo, i) => {
      if (precioViejo === null || precioViejo <= 0) return;
      const zona = i + 1;
      const flete = servicio === 'DHL' && peso <= 2 ? fleteNuevo(servicio, zona, peso, 'documento') : null;
      documentos.push({ zona, peso, precio_viejo: precioViejo, flete_nuevo: flete, pct_implicito: flete ? (precioViejo / flete - 1) * 100 : null });
    });
  }

  return { detalle, propuesta: Object.values(propuesta), documentos };
}

// ── Excel de revisión ────────────────────────────────────────────────────────
const VIOLETA = 'FF2A3661', CORAL = 'FFEA6749', SUAVE = 'FFEAF1F8', ROJO = 'FFFDE2E2', VERDE = 'FFE7F6EC';
function cabecera(ws, fila, textos) {
  textos.forEach((t, i) => {
    const c = ws.getCell(fila, i + 1);
    c.value = t;
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VIOLETA } };
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  ws.getRow(fila).height = 28;
}

async function escribirRevision(nombreCliente, liq, analisis, salida) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Nova Express';

  // 1. Resumen: la matriz propuesta.
  const ws = wb.addWorksheet('Propuesta', { views: [{ showGridLines: false }] });
  ws.mergeCells('A1:H1');
  ws.getCell('A1').value = `${nombreCliente} — matriz de profit propuesta (${SERVICIO_LABEL[liq.servicio]}, exportación)`;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: VIOLETA } };
  ws.mergeCells('A2:H2');
  ws.getCell('A2').value = 'El % propuesto es el que mejor reproduce, sobre la tabla de costo ACTUAL, el precio que este cliente venía pagando (hoja c+p del liquidador). '
    + 'Revisar las celdas en rojo: ahí el precio viejo y el nuevo difieren más de ' + UMBRAL_AVISO_PCT + ' % en algún peso de la banda (ver hoja Detalle). Nada se carga sin el OK.';
  ws.getCell('A2').alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(2).height = 44;
  ws.getCell('A3').value = `Hoja de costo del liquidador: ${liq.hojaCosto}`;
  ws.getCell('A3').font = { italic: true, color: { argb: 'FF6B6478' } };

  cabecera(ws, 5, ['Banda (kg)', 'Zona 1', 'Zona 2', 'Zona 3', 'Zona 4', 'Zona 5', 'Zona 6', 'Nota']);
  let r = 6;
  for (const b of BANDAS) {
    const label = bandaLabel(b);
    ws.getCell(r, 1).value = label;
    ws.getCell(r, 1).font = { bold: true };
    let notas = [];
    for (let z = 1; z <= 6; z++) {
      const p = analisis.propuesta.find((x) => x.zona === z && x.banda === label);
      const c = ws.getCell(r, z + 1);
      if (!p) { c.value = '—'; c.alignment = { horizontal: 'center' }; continue; }
      const viejos = [...new Set(analisis.detalle.filter((f) => f.zona === z && f.banda === label && f.pct_viejo != null).map((f) => f.pct_viejo))];
      if (viejos.length) c.note = `El liquidador viejo decía ${viejos.map((v) => v.toFixed(1) + ' %').join(' / ')} (sobre SU tabla de costo)`;
      c.value = p.pct / 100;
      c.numFmt = '0.0%';
      c.alignment = { horizontal: 'center' };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: p.avisos ? ROJO : VERDE } };
      if (p.avisos) notas.push(`z${z}: ${p.avisos} peso(s) se alejan hasta ${p.desvio_max_pct.toFixed(1)} % (USD ${p.desvio_max_usd.toFixed(2)})`);
    }
    ws.getCell(r, 8).value = notas.join(' · ');
    ws.getCell(r, 8).alignment = { wrapText: true };
    r++;
  }
  ws.getColumn(1).width = 12;
  for (let z = 2; z <= 7; z++) ws.getColumn(z).width = 10;
  ws.getColumn(8).width = 70;

  r += 1;
  ws.getCell(r, 1).value = 'Cómo leerlo';
  ws.getCell(r, 1).font = { bold: true, color: { argb: CORAL } };
  const notasPie = [
    'Verde: con ese % todos los pesos de la banda quedan a menos de ' + UMBRAL_AVISO_PCT + ' % del precio viejo.',
    'Rojo: algún peso se aleja más; casi siempre es porque el liquidador viejo tenía un precio por kilo distinto arriba de 31,5 kg (UPS) o una tabla de costo vieja (DHL). Mirar la hoja Detalle y decidir.',
    'La matriz nueva no distingue documentos: los precios de documentos del liquidador están en la hoja Documentos solo para mirar.',
  ];
  for (const n of notasPie) { r++; ws.mergeCells(r, 1, r, 8); ws.getCell(r, 1).value = '· ' + n; ws.getCell(r, 1).alignment = { wrapText: true }; }

  // 2. Detalle.
  const wd = wb.addWorksheet('Detalle');
  cabecera(wd, 1, ['Zona', 'Peso (kg)', 'Banda', '% viejo (hoja profit)', 'Precio viejo (c+p)', 'Flete tabla nueva', '% implícito', '% propuesto', 'Precio con % propuesto', 'Dif USD', 'Dif %', 'Aviso']);
  let rd = 2;
  for (const f of analisis.detalle.sort((a, b) => a.zona - b.zona || a.peso - b.peso)) {
    const vals = [f.zona, f.peso, f.banda, f.pct_viejo != null ? f.pct_viejo / 100 : null, f.precio_viejo, f.flete_nuevo, f.pct_implicito != null ? f.pct_implicito / 100 : null,
      f.pct_propuesto != null ? f.pct_propuesto / 100 : null, f.precio_nuevo, f.dif_usd, f.dif_pct != null ? f.dif_pct / 100 : null, f.aviso ? '⚠' : ''];
    vals.forEach((v, i) => { wd.getCell(rd, i + 1).value = v; });
    [5, 6, 9, 10].forEach((c) => { wd.getCell(rd, c).numFmt = '#,##0.00'; });
    [4, 7, 8, 11].forEach((c) => { wd.getCell(rd, c).numFmt = '0.0%'; });
    if (f.aviso) for (let c = 1; c <= 12; c++) wd.getCell(rd, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROJO } };
    else if (rd % 2 === 0) for (let c = 1; c <= 12; c++) wd.getCell(rd, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUAVE } };
    rd++;
  }
  [8, 10, 10, 14, 16, 16, 12, 12, 20, 10, 10, 8].forEach((w, i) => { wd.getColumn(i + 1).width = w; });
  wd.views = [{ state: 'frozen', ySplit: 1 }];
  wd.autoFilter = { from: 'A1', to: `L${rd - 1}` };

  // 3. Documentos (informativo).
  if (analisis.documentos.length) {
    const wdoc = wb.addWorksheet('Documentos');
    cabecera(wdoc, 1, ['Zona', 'Peso (kg)', 'Precio viejo (c+p)', 'Flete tabla nueva (doc)', '% implícito']);
    let rr = 2;
    for (const f of analisis.documentos.sort((a, b) => a.zona - b.zona || a.peso - b.peso)) {
      [f.zona, f.peso, f.precio_viejo, f.flete_nuevo, f.pct_implicito != null ? f.pct_implicito / 100 : null].forEach((v, i) => { wdoc.getCell(rr, i + 1).value = v; });
      wdoc.getCell(rr, 3).numFmt = '#,##0.00'; wdoc.getCell(rr, 4).numFmt = '#,##0.00'; wdoc.getCell(rr, 5).numFmt = '0.0%';
      rr++;
    }
    [8, 10, 18, 22, 12].forEach((w, i) => { wdoc.getColumn(i + 1).width = w; });
  }

  await wb.xlsx.writeFile(salida);
}

// ── Main ─────────────────────────────────────────────────────────────────────
function nombreDesde(archivo) {
  return path.basename(archivo).replace(/\.xlsx?$/i, '').replace(/\s*liquidador.*$/i, '').replace(/[_]+/g, ' ').trim();
}

async function procesar(archivo, servicioForzado) {
  const nombre = nombreDesde(archivo);
  const liq = leerLiquidador(archivo, servicioForzado);
  const analisis = analizar(liq);
  const dir = path.join(path.dirname(archivo), 'revision');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, path.basename(archivo).replace(/\.xlsx?$/i, ''));
  await escribirRevision(nombre, liq, analisis, `${base}.revision.xlsx`);
  const filasCarga = analisis.propuesta.map((p) => {
    const [lo, hi] = BANDAS.find((b) => bandaLabel(b) === p.banda);
    return { cliente: nombre, servicio: liq.servicio, tipo: 'export', zona: p.zona, peso_min: lo, peso_max: hi, profit_pct: p.pct, avisos: p.avisos };
  });
  fs.writeFileSync(`${base}.propuesta.json`, JSON.stringify({ cliente: nombre, archivo: path.basename(archivo), servicio: liq.servicio, hoja_costo: liq.hojaCosto, filas: filasCarga }, null, 2));

  const conAviso = analisis.propuesta.filter((p) => p.avisos).length;
  const pcts = [...new Set(analisis.propuesta.map((p) => p.pct))].sort((a, b) => a - b);
  console.log(`✓ ${nombre} — ${SERVICIO_LABEL[liq.servicio]} (hoja de costo: ${liq.hojaCosto})`);
  console.log(`    ${analisis.detalle.length} precios leídos · ${analisis.propuesta.length} celdas propuestas · % distintos: ${pcts.map((p) => p + '%').join(', ')}`);
  console.log(`    ${conAviso ? conAviso + ' celda(s) en rojo para revisar' : 'todas las celdas en verde'} → ${path.basename(base)}.revision.xlsx`);
}

async function main() {
  const args = process.argv.slice(2);
  const carpeta = (args.find((a) => a.startsWith('--carpeta=')) || '').slice('--carpeta='.length);
  const servicio = (args.find((a) => a.startsWith('--servicio=')) || '').slice('--servicio='.length) || null;
  if (servicio && !SERVICIO_LABEL[servicio]) { console.error('--servicio debe ser UPS_EXP, UPS_SAVER o DHL'); process.exit(1); }
  let archivos = args.filter((a) => !a.startsWith('--'));
  if (carpeta) {
    archivos = archivos.concat(fs.readdirSync(carpeta).filter((f) => /\.xlsx?$/i.test(f) && !/revision/i.test(f)).map((f) => path.join(carpeta, f)));
  }
  if (!archivos.length) { console.error('Uso: node scripts/importar-liquidador.js <archivo.xls> [...] | --carpeta=<dir> [--servicio=UPS_EXP|UPS_SAVER|DHL]'); process.exit(1); }
  let ok = 0, mal = 0;
  for (const a of archivos) {
    try { await procesar(a, servicio); ok++; }
    catch (e) { mal++; console.log(`✗ ${path.basename(a)}: ${e.message}`); }
  }
  console.log(`\n${ok} procesado(s) · ${mal} con error. Los Excel de revisión están en la subcarpeta "revision" al lado de cada .xls.`);
}

main().catch((e) => { console.error('✗', e); process.exit(1); });
