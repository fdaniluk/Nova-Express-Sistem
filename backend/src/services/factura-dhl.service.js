// Lector de facturas de DHL Express (Argentina) — 07/10/2026.
//
// Misma salida que el lector de UPS (factura-ups.service.js) para que /api/facturas/chequear
// y /cargar las traten igual: { numero_factura, fecha_factura, guias:[{ numero_guia, pais,
// peso, neto, flete_neto, fuel, total_recargos, costo_total, cargos:[{nombre,monto}] }],
// total_declarado, subtotal_factura, percepciones, iva, cuadra, advertencias, courier:'DHL' }.
//
// Cómo viene el PDF (PDFsharp, 2 páginas):
//   · Página 1: cabecera. "1700 - 00033061", FECHA, conceptos (Servicio transporte /
//     Adicional combustible / Otros Servicios / Periodic fee, en EXENTO y GRAVADO),
//     SUBTOTAL U$S, IVA 21 % (sobre lo gravado: seguro "VALUE PROTECTION"), Percep. IIBB,
//     TOTAL A PAGAR, tipo de cambio.
//   · Página 2+: "DETALLE": una tabla por guía con Flete, FUEL y recargos (GoGreen Plus,
//     12:00 PREMIUM, VALUE PROTECTION, Non-conveyable, Over Sized Piece…).
//
// El texto plano de pdf-parse pierde la relación entre el nombre del cargo y su importe
// (los importes se dibujan con otro interlineado), así que acá se leen las POSICIONES de
// cada texto (x, y) y se arma la tabla por columnas: nombre (x≈418), importe (x≈500) y
// marca de IVA (x≈530, N/S). Un cargo empieza en la línea de nombre que tiene su marca N/S
// a la misma altura; las líneas de nombre sin marca son la continuación del nombre anterior
// ("VALUE" + "PROTECTION"). Los importes van en el mismo orden de arriba hacia abajo.
//
// Qué NO se reparte en los envíos (igual que la percepción de IIBB en UPS): el IVA (es
// crédito fiscal, no costo) y la percepción. Quedan en la cabecera de la factura.

const pdfParse = require('pdf-parse');
const { parseImporte } = require('./factura-ups.service');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── Lectura del PDF con posiciones ─────────────────────────────────────────────────
async function leerPaginas(buffer) {
  const paginas = [];
  await pdfParse(Uint8Array.from(buffer), {
    pagerender: (page) => page.getTextContent().then((tc) => {
      const items = tc.items
        .map((i) => ({ s: String(i.str), x: Math.round(i.transform[4]), y: Math.round(i.transform[5]) }))
        .filter((i) => i.s.trim() !== '');
      paginas.push(items);
      return items.map((i) => i.s).join('\n');
    }),
  });
  return paginas;
}

function textoDe(items) { return items.map((i) => i.s).join('\n'); }

function esFacturaDHL(texto) {
  return /DHL\s+EXPRESS\s*\(ARGENTINA\)/i.test(texto) || /DHL EXPRESS \(ARGENTIN/i.test(texto);
}

// "1700 - 00033061" (cabecera) y "N° 1700A00033061" (detalle) son la misma factura. Se
// guarda como la escribe DHL en el detalle y en el nombre del archivo: 1700A00033061.
function leerNumeroFactura(texto) {
  const a = texto.match(/\b(\d{4})\s*-\s*(\d{8})\b/);
  if (a) return `${a[1]}A${a[2]}`;
  const b = texto.match(/N[°º]\s*(\d{4}A\d{8})/);
  return b ? b[1] : null;
}

// Cabecera por posiciones: el valor de cada renglón es el número que está a la misma
// altura (±4) y a la derecha de la etiqueta. En texto plano pdf-parse agrupa primero las
// etiquetas y después los valores, y no hay forma de saber cuál es de cuál.
function valorEnFila(items, etiquetaRe, { numero = true } = {}) {
  const et = items.find((i) => etiquetaRe.test(i.s.trim()));
  if (!et) return null;
  const fila = items
    .filter((i) => i !== et && Math.abs(i.y - et.y) <= 4 && i.x > et.x)
    .sort((a, b) => a.x - b.x);
  for (const i of fila) {
    const t = i.s.trim();
    if (!numero) { if (t === ':' || t === '') continue; return t; }
    if (/^-?[\d.]*\d,\d{2}$/.test(t)) return parseImporte(t);
  }
  return null;
}

function leerFecha(items) {
  const v = valorEnFila(items, /^FECHA:?$/, { numero: false });
  return v && /^\d{2}\/\d{2}\/\d{4}$/.test(v) ? v : null;
}

// Conceptos: "Servicio transporte  466,30 (EXENTO)  0,00 (GRAVADO)". Las columnas EXENTO y
// GRAVADO se ubican por la x de sus títulos (los números están alineados a la derecha).
function leerConceptos(items) {
  const xEx = items.find((i) => /^EXENTO$/.test(i.s.trim()))?.x;
  const xGr = items.find((i) => /^GRAVADO$/.test(i.s.trim()))?.x;
  const out = {};
  for (const [clave, re] of [
    ['transporte', /^Servicio transporte$/],
    ['combustible', /^Adicional combustible$/],
    ['otros', /^Otros Servicios$/],
    ['periodic', /^Periodic fee$/],
  ]) {
    const et = items.find((i) => re.test(i.s.trim()));
    if (!et) continue;
    const nums = items
      .filter((i) => Math.abs(i.y - et.y) <= 4 && i.x > et.x && /^-?[\d.]*\d,\d{2}$/.test(i.s.trim()))
      .map((i) => ({ x: i.x, v: parseImporte(i.s.trim()) }));
    const masCerca = (x) => (nums.length ? nums.reduce((m, n) => (Math.abs(n.x - x) < Math.abs(m.x - x) ? n : m)).v : null);
    out[clave] = {
      exento: xEx != null ? masCerca(xEx + 20) : (nums[0]?.v ?? null),
      gravado: xGr != null ? masCerca(xGr + 20) : (nums[1]?.v ?? null),
    };
  }
  return out;
}

// ── Detalle por guía ─────────────────────────────────────────────────────────────────
// Columnas (x) de la tabla de detalle, tomadas de la cabecera de la tabla de cada página.
function columnasDe(items) {
  const col = (re) => { const it = items.find((i) => re.test(i.s)); return it ? it.x : null; };
  return {
    guia: col(/^Gu[ií]a Nro/),
    detalle: col(/^Detalle/),
    importe: col(/^Importe/),
    grav: col(/^Grav/),
    referencia: col(/^Referencia/),
    destinatario: col(/^Destinatario/),
    origen: col(/^Origen \/ Destino/),
  };
}

// Recargos de DHL que ocupan más de una línea en la columna "Detalle Cargos". Se comparan
// sin mayúsculas, acentos ni guiones sueltos. Uno nuevo de varias líneas que no esté acá
// entra partido (y la guía queda sin costo con aviso 'cargos_desparejos'): agregarlo.
const MAX_LINEAS_NOMBRE = 4;
const normNombre = (t) => String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9()]+/g, ' ').trim();
const NOMBRES_DHL = new Set([
  'value protection',
  'shipment value protection',
  'non conveyable surcharge (ncp) weight',
  'non conveyable surcharge (ncp) size',
  'non conveyable surcharge (ncp)',
  'over sized piece (osp)',
  'overweight piece (owp)',
  'remote area delivery',
  'remote area pickup',
  'elevated risk',
  'restricted destination',
  'emergency situation',
  'duties taxes paid',
  'duty tax importer',
  'duty tax paid',
  'address correction',
  'change of billing',
  'saturday delivery',
  'saturday pickup',
  'residential address',
  'residential delivery',
  'dangerous goods',
  'dry ice ice un1845',
  'lithium batteries',
  'excepted quantities',
  'export declaration',
  'import export duties',
  'paper commercial invoice',
  'neutral delivery service',
  'direct signature',
  'adult signature',
  'go green plus',
  'gogreen plus',
  'gogreen climate neutral',
  'fuel surcharge',
  'demand surcharge',
  'peak season surcharge',
  'emergency situation surcharge',
  'oversize piece (osp)',
]);

function leerDetalle(paginas, advertencias) {
  const guias = [];
  for (const items of paginas) {
    const texto = textoDe(items);
    if (!/DETALLE/.test(texto) || !/Gu[ií]a Nro/.test(texto)) continue;
    const c = columnasDe(items);
    if (c.detalle == null || c.importe == null || c.grav == null) {
      advertencias.push({ tipo: 'detalle_sin_columnas', detalle: 'No se reconocieron las columnas de la tabla de detalle de DHL (¿cambió el formato?).' });
      continue;
    }
    const cerca = (x, ref, tol = 12) => ref != null && Math.abs(x - ref) <= tol;
    // Filas de guía: 10 dígitos en la primera columna.
    const filasGuia = items
      .filter((i) => cerca(i.x, c.guia, 15) && /^\d{10}$/.test(i.s.trim()))
      .sort((a, b) => b.y - a.y);
    // Pie de página (leyendas de códigos) — todo lo que está debajo no es detalle.
    const pie = items.filter((i) => /CODIGO PRODUCTOS/.test(i.s)).map((i) => i.y);
    const yPie = pie.length ? Math.max(...pie) : -Infinity;

    for (let k = 0; k < filasGuia.length; k++) {
      const fila = filasGuia[k];
      const yTop = fila.y + 3;
      const yBot = k + 1 < filasGuia.length ? filasGuia[k + 1].y + 3 : yPie + 1;
      const bloque = items.filter((i) => i.y < yTop && i.y >= yBot && i.y > yPie);
      const enFila = (i) => Math.abs(i.y - fila.y) <= 3;

      const fecha = bloque.find((i) => enFila(i) && /^\d{2}\/\d{2}\/\d{4}$/.test(i.s.trim()));
      const origenDestino = bloque.find((i) => enFila(i) && /\s\/\s/.test(i.s) && cerca(i.x, c.origen, 20));
      // Peso: "6.50" al lado de la letra de tipo (W/V/A/B/M). Producto: una letra antes.
      const pesoIt = bloque.find((i) => enFila(i) && /^\d+(\.\d+)?$/.test(i.s.trim()) && i.x > (c.guia ?? 0) + 60 && i.x < (c.origen ?? 999));
      const tipoPesoIt = pesoIt ? bloque.find((i) => enFila(i) && /^[A-Z]$/.test(i.s.trim()) && i.x > pesoIt.x && i.x < pesoIt.x + 40) : null;
      const prodIt = pesoIt ? bloque.find((i) => enFila(i) && /^[A-Z]$/.test(i.s.trim()) && i.x < pesoIt.x && i.x > pesoIt.x - 40) : null;

      // Cargos: nombres (col Detalle), marcas N/S (col Grav), importes (col Importe).
      const nombres = bloque.filter((i) => cerca(i.x, c.detalle, 20)).sort((a, b) => b.y - a.y);
      const marcas = bloque.filter((i) => cerca(i.x, c.grav, 8) && /^[NS]$/.test(i.s.trim())).sort((a, b) => b.y - a.y);
      const importes = bloque
        .filter((i) => i.x > c.detalle + 60 && i.x < c.grav - 5 && /^-?[\d.]*\d,\d{2}$/.test(i.s.trim()))
        .sort((a, b) => b.y - a.y);

      // Los nombres largos vienen partidos en varias líneas ("VALUE" + "PROTECTION",
      // "Non-conveyable" + "Surcharge (NCP)-" + "Weight"), y ni los importes ni las marcas
      // N/S quedan alineados con la primera línea del nombre (cada columna tiene su propio
      // interlineado). Lo único fijo es el ORDEN: el k-ésimo importe es del k-ésimo cargo.
      // Para saber dónde empieza cada cargo se arman los nombres con un diccionario de
      // recargos de DHL (el más largo que calce); lo que no está en el diccionario es un
      // cargo de una línea. Si la cuenta no cierra contra los importes, se avisa.
      const lineas = nombres.map((n) => n.s.trim().replace(/\s+/g, ' '));
      const cargos = [];
      for (let i = 0; i < lineas.length;) {
        let tomado = 1;
        let nombre = lineas[i];
        for (let j = Math.min(lineas.length, i + MAX_LINEAS_NOMBRE); j > i + 1; j--) {
          const cand = normNombre(lineas.slice(i, j).join(' '));
          if (NOMBRES_DHL.has(cand)) { tomado = j - i; nombre = lineas.slice(i, j).join(' '); break; }
        }
        cargos.push({ nombre, gravado: false, monto: null });
        i += tomado;
      }
      // Marca de IVA: hay tantas como cargos, en el mismo orden (k-ésima marca → k-ésimo cargo).
      if (marcas.length === cargos.length) marcas.forEach((m, i) => { cargos[i].gravado = m.s.trim() === 'S'; });
      for (const cg of cargos) cg.nombre = cg.nombre.replace(/\s+/g, ' ').replace(/\s*-\s*$/, '').trim();
      if (importes.length === cargos.length) {
        cargos.forEach((cg, i) => { cg.monto = parseImporte(importes[i].s.trim()); });
      } else {
        advertencias.push({
          tipo: 'cargos_desparejos',
          guia: fila.s.trim(),
          detalle: `La guía ${fila.s.trim()} tiene ${cargos.length} cargo(s) con nombre y ${importes.length} importe(s): no se pudo armar el detalle. La guía queda SIN costo.`,
        });
      }

      // Referencia del cliente (puede venir cortada en dos líneas: "X-11045-46-68-B" + "O").
      const ref = bloque.filter((i) => c.referencia != null && i.x >= c.referencia - 15).sort((a, b) => b.y - a.y).map((i) => i.s.trim()).join('');

      const ok = cargos.length > 0 && cargos.every((cg) => cg.monto != null);
      const flete = cargos.find((cg) => /^Flete$/i.test(cg.nombre));
      const fuel = cargos.find((cg) => /^FUEL$/i.test(cg.nombre));
      const recargos = cargos.filter((cg) => cg !== flete && cg !== fuel);
      const pais = origenDestino ? origenDestino.s.split('/').map((s) => s.trim()) : [];
      guias.push({
        numero_guia: fila.s.trim(),
        tracking: fila.s.trim(),
        fecha_guia: fecha ? fecha.s.trim() : null,
        origen: pais[0] || null,
        pais: pais[1] || pais[0] || null,
        producto: prodIt ? prodIt.s.trim() : null,
        peso: pesoIt ? Number(pesoIt.s) : null,
        tipo_peso: tipoPesoIt ? tipoPesoIt.s.trim() : null,
        referencia: ref || null,
        flete_neto: ok && flete ? r2(flete.monto) : null,
        fuel: ok && fuel ? r2(fuel.monto) : null,
        neto: ok ? r2((flete ? flete.monto : 0) + (fuel ? fuel.monto : 0)) : null,
        total_recargos: ok ? r2(recargos.reduce((s, cg) => s + cg.monto, 0)) : 0,
        percepcion: null,
        costo_total: ok ? r2(cargos.reduce((s, cg) => s + cg.monto, 0)) : null,
        gravado: ok ? r2(cargos.filter((cg) => cg.gravado).reduce((s, cg) => s + cg.monto, 0)) : null,
        cargos: recargos.map((cg) => ({ nombre: cg.nombre, monto: cg.monto })),
      });
    }
  }
  return guias;
}

// ── Entrada ──────────────────────────────────────────────────────────────────────────
async function extraerFacturaDHL(buffer) {
  const paginas = await leerPaginas(buffer);
  return extraerFacturaDHLDesdePaginas(paginas);
}

function extraerFacturaDHLDesdePaginas(paginas) {
  const advertencias = [];
  const textoTodo = paginas.map(textoDe).join('\n');
  const p1 = paginas[0] || [];
  const cabecera = textoDe(p1);

  const numero_factura = leerNumeroFactura(cabecera) || leerNumeroFactura(textoTodo);
  const fecha_factura = leerFecha(p1);
  const conceptos = leerConceptos(p1);
  const subtotal_factura = valorEnFila(p1, /^SUBTOTAL$/);
  const total_declarado = valorEnFila(p1, /^TOTAL A PAGA/);
  const iva21 = valorEnFila(p1, /^IVA\s+21,0%/);
  const iva105 = valorEnFila(p1, /^IVA\s+10,5%/);
  const iva = r2((iva21 || 0) + (iva105 || 0));
  const percepciones = valorEnFila(p1, /^Percep\. IIBB/);
  const tcM = cabecera.match(/TC:\s*([\d.]+)/);
  const tipo_cambio = tcM ? Number(tcM[1]) : null;
  const cantidadTxt = valorEnFila(p1, /^CANTIDAD DE GU[IÍ]AS/, { numero: false });
  const cantidad_declarada = cantidadTxt && /^\d+$/.test(cantidadTxt) ? Number(cantidadTxt) : null;
  const titular = valorEnFila(p1, /^EMPRESA$/, { numero: false });

  const guias = leerDetalle(paginas, advertencias);
  const conCosto = guias.filter((g) => g.costo_total != null);
  const suma_guias = r2(conCosto.reduce((s, g) => s + g.costo_total, 0));

  if (cantidad_declarada != null && cantidad_declarada !== guias.length) {
    advertencias.push({ tipo: 'cantidad_guias', detalle: `La factura dice ${cantidad_declarada} guía(s) y se leyeron ${guias.length}.` });
  }

  // Cuadre: las guías suman el SUBTOTAL (sin IVA ni percepción). El total a pagar es
  // subtotal + IVA + percepción; IVA y percepción quedan en la cabecera, no en los envíos.
  let diferencia = null;
  let cuadra = null;
  if (subtotal_factura != null) {
    diferencia = r2(subtotal_factura - suma_guias);
    cuadra = Math.abs(diferencia) < 0.05;
    if (!cuadra) {
      advertencias.push({
        tipo: 'total_no_cuadra',
        detalle: `La suma de las guías (USD ${suma_guias.toFixed(2)}) no coincide con el subtotal de la factura (USD ${subtotal_factura.toFixed(2)}). Diferencia: USD ${diferencia.toFixed(2)}. Revisá la factura.`,
      });
    }
    if (total_declarado != null) {
      const resto = r2(total_declarado - subtotal_factura - iva - (percepciones || 0));
      if (Math.abs(resto) >= 0.05) {
        advertencias.push({ tipo: 'pie_no_cuadra', detalle: `El pie de la factura no cierra: total ${total_declarado.toFixed(2)} ≠ subtotal ${subtotal_factura.toFixed(2)} + IVA ${iva.toFixed(2)} + percepción ${(percepciones || 0).toFixed(2)} (sobran USD ${resto.toFixed(2)}).` });
      }
    }
    const extras = [];
    if (iva > 0) extras.push(`USD ${iva.toFixed(2)} de IVA (crédito fiscal, no es costo del envío)`);
    if (percepciones > 0) extras.push(`USD ${percepciones.toFixed(2)} de percepción de Ingresos Brutos`);
    if (extras.length) {
      advertencias.push({ tipo: 'percepcion_aparte', detalle: `La factura incluye ${extras.join(' y ')}. No se reparte entre los envíos: queda registrado en la factura.` });
    }
  } else {
    advertencias.push({ tipo: 'sin_total_declarado', detalle: 'No se pudo leer el subtotal de la factura del PDF, así que no se pudo verificar que la suma de las guías cuadre.' });
  }
  // Cruce con los conceptos de la cabecera (flete = Servicio transporte, fuel = Adicional combustible).
  if (conceptos.transporte) {
    const flete = r2(conCosto.reduce((s, g) => s + (g.flete_neto || 0), 0));
    const esperado = r2((conceptos.transporte.exento || 0) + (conceptos.transporte.gravado || 0));
    if (Math.abs(flete - esperado) >= 0.05) advertencias.push({ tipo: 'flete_no_cuadra', detalle: `El flete de las guías suma USD ${flete.toFixed(2)} y "Servicio transporte" dice USD ${esperado.toFixed(2)}.` });
  }
  if (conceptos.combustible) {
    const fuel = r2(conCosto.reduce((s, g) => s + (g.fuel || 0), 0));
    const esperado = r2((conceptos.combustible.exento || 0) + (conceptos.combustible.gravado || 0));
    if (Math.abs(fuel - esperado) >= 0.05) advertencias.push({ tipo: 'fuel_no_cuadra', detalle: `El fuel de las guías suma USD ${fuel.toFixed(2)} y "Adicional combustible" dice USD ${esperado.toFixed(2)}.` });
  }
  if (guias.length === 0) {
    advertencias.push({ tipo: 'sin_guias', detalle: 'No se detectó ninguna guía en el PDF. Puede que DHL haya cambiado el formato o que el archivo no sea una factura.' });
  }

  return {
    courier: 'DHL',
    tipo: 'flete',
    numero_factura,
    fecha_factura,
    guias,
    total_declarado,
    subtotal_factura,
    suma_guias,
    diferencia,
    cuadra,
    percepciones: percepciones ?? null,
    iva,
    tipo_cambio,
    titular: titular && titular !== ':' ? titular : null,
    percepciones_repartidas: false,
    suma_guias_final: suma_guias,
    conceptos,
    advertencias,
  };
}

// Detecta el courier por el texto del PDF y usa el lector que corresponde.
async function extraerFacturaCourier(buffer, extraerUPS) {
  const paginas = await leerPaginas(buffer);
  if (esFacturaDHL(paginas.map(textoDe).join('\n'))) return extraerFacturaDHLDesdePaginas(paginas);
  const r = await extraerUPS(buffer);
  return { courier: 'UPS', ...r };
}

module.exports = { extraerFacturaDHL, extraerFacturaDHLDesdePaginas, extraerFacturaCourier, esFacturaDHL, leerPaginas };
