const pdfParse = require('pdf-parse');

// ─── Parseo de importes ──────────────────────────────────────────────────────
//
// Las facturas de UPS Argentina vienen con formato local: la coma es el separador
// decimal y el punto el de miles ("1.292,50"). Pero el MISMO PDF mezcla formatos —
// el peso viene con punto decimal ("26.00Kg") — así que asumir un solo formato es
// frágil: si UPS unifica el locale en un rollout, un recargo de "120.10" entraba
// como 12.010 (100× de más) y nadie se enteraba.
//
// Regla usada, que cubre los dos formatos sin ambigüedad práctica:
//   · el ÚLTIMO separador (coma o punto) es el decimal SI lo siguen 1 o 2 dígitos;
//   · si lo siguen 3 dígitos, es separador de miles y el número es entero.
//
// Verificado contra los dos formatos:
//   "1,292,50" → 1292.50    "1.292,50" → 1292.50    "1,292.50" → 1292.50
//   "215,34"   → 215.34     "120.10"   → 120.10     "-2,50"    → -2.50
//   "1.292"    → 1292       "13,180,40" → 13180.40
//
// Devuelve `null` —no 0— cuando no puede parsear. El 0 silencioso era parte del
// problema: una guía sin importe legible entraba como si UPS no hubiera cobrado nada.
function parseImporte(str) {
  if (str == null) return null;
  let s = String(str).trim();
  if (s === '') return null;

  const neg = s.startsWith('-');
  if (neg) s = s.slice(1).trim();

  // Solo dígitos y separadores; cualquier otra cosa no es un importe.
  if (!/^[\d.,]+$/.test(s)) return null;

  const ultimoSep = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));

  let entero;
  let decimales = '';

  if (ultimoSep === -1) {
    entero = s;
  } else {
    const cola = s.slice(ultimoSep + 1);
    if (/^\d{1,2}$/.test(cola)) {
      // 1-2 dígitos después del último separador → es la parte decimal
      entero = s.slice(0, ultimoSep);
      decimales = cola;
    } else if (/^\d{3}$/.test(cola)) {
      // 3 dígitos → separador de miles, el número es entero
      entero = s;
    } else {
      return null; // 4+ dígitos después de un separador: no es un importe válido
    }
  }

  entero = entero.replace(/[.,]/g, '');
  if (entero === '') entero = '0';
  if (!/^\d+$/.test(entero)) return null;

  const num = parseFloat(decimales ? `${entero}.${decimales}` : entero);
  if (!Number.isFinite(num)) return null;
  return neg ? -num : num;
}

const r2 = (n) => Math.round(n * 100) / 100;

// ─── Extracción ──────────────────────────────────────────────────────────────

// Total declarado de la factura. Ancla: en las facturas argentinas el importe va
// obligatoriamente también en letras, así que el número que precede a la línea de
// letras ("TRES MIL CIENTO CINCUENTA y NUEVE con ... CENTAVOS.-") es el total real.
// Es un ancla mucho más estable que una posición fija o un rótulo, porque el orden
// del texto que extrae pdf-parse del pie de página no es confiable.
function leerTotalDeclarado(lines) {
  for (let i = 1; i < lines.length; i++) {
    if (/CENTAVOS/i.test(lines[i]) && /[A-ZÁÉÍÓÚÑ]/i.test(lines[i])) {
      const v = parseImporte(lines[i - 1]);
      if (v != null && v > 0) return v;
    }
  }
  return null;
}

async function extraerFacturaUPS(buffer) {
  const data = await pdfParse(buffer);
  const lines = data.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  // Todo lo que el parser no pudo resolver se acumula acá y viaja al que llama.
  // Antes esto no existía: los problemas se degradaban a 0 o se descartaban en
  // silencio y el endpoint respondía "todo OK".
  const advertencias = [];

  let numero_factura = null;
  let fecha_factura = null;

  for (const line of lines) {
    if (!numero_factura) {
      const m = line.match(/N°\s+(\d{4}-\d{8})/);
      if (m) numero_factura = m[1];
    }
    if (!fecha_factura) {
      const m = line.match(/^(\d{2}\/\d{2}\/\d{4})$/);
      if (m) fecha_factura = m[1];
    }
    if (numero_factura && fecha_factura) break;
  }

  if (!numero_factura) {
    advertencias.push({
      tipo: 'sin_numero_factura',
      detalle: 'No se pudo leer el número de factura del PDF.',
    });
  }
  if (!fecha_factura) {
    advertencias.push({
      tipo: 'sin_fecha_factura',
      detalle: 'No se pudo leer la fecha de la factura del PDF.',
    });
  }

  // Máquina de estados: tracking → línea de 4 columnas → neto → cargos.
  const guias = [];
  let current = null;
  let state = 'idle';

  const cerrarActual = () => {
    if (current) guias.push(current);
    current = null;
  };

  for (const line of lines) {
    const trackingMatch = line.match(/^(1Z\w+)\s+([\d.,]+)Kg\s+\w+\s+[\d/]+\s+([A-Z]{2})\s/);
    if (trackingMatch) {
      cerrarActual();
      current = {
        tracking: trackingMatch[1],
        peso: parseImporte(trackingMatch[2]),
        pais: trackingMatch[3],
        neto: null,
        cargos: [],
      };
      state = 'columnas';
      continue;
    }

    if (!current) continue;

    if (state === 'columnas') {
      const col = line.match(/^(-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)$/);
      if (col) state = 'neto';
      continue;
    }

    if (state === 'neto') {
      const netoMatch = line.match(/^(-?[\d.,]+)$/);
      if (netoMatch) {
        current.neto = parseImporte(netoMatch[1]);
        state = 'cargos';
      }
      continue;
    }

    if (state === 'cargos') {
      const cargoMatch = line.match(/^(.+?)\s{2,}(-?[\d.,]+)$/);
      if (cargoMatch && /[A-Za-záéíóúñÁÉÍÓÚÑ]/.test(cargoMatch[1])) {
        const monto = parseImporte(cargoMatch[2]);
        if (monto == null) {
          advertencias.push({
            tipo: 'cargo_ilegible',
            guia: current.tracking,
            detalle: `No se pudo interpretar el importe del cargo "${cargoMatch[1].trim()}": "${cargoMatch[2]}".`,
          });
        } else {
          current.cargos.push({ nombre: cargoMatch[1].trim(), monto });
        }
      }
    }
  }

  cerrarActual();

  // ─── Guías repetidas ───────────────────────────────────────────────────────
  //
  // Antes se descartaba toda repetición asumiendo que era un artefacto de paginado
  // del PDF. Pero UPS re-factura guías de verdad (correcciones de peso, reintentos,
  // cargos tardíos), y esas repeticiones desaparecían sin dejar rastro.
  //
  // Discriminador: si las apariciones tienen EXACTAMENTE los mismos importes, es
  // paginado y se deduplica en silencio. Si difieren, es una re-facturación real y
  // se avisa, con los montos de cada una, para que lo decida una persona. NO se suman
  // solas: sumar plata sin que nadie mire es justo lo que hay que evitar.
  const porTracking = new Map();
  for (const g of guias) {
    if (!porTracking.has(g.tracking)) porTracking.set(g.tracking, []);
    porTracking.get(g.tracking).push(g);
  }

  const unicas = [];
  for (const [tracking, ocurrencias] of porTracking) {
    unicas.push(ocurrencias[0]);
    if (ocurrencias.length === 1) continue;

    const firma = (g) =>
      JSON.stringify([g.neto, g.cargos.map((c) => [c.nombre, c.monto]).sort()]);
    const todasIguales = ocurrencias.every((g) => firma(g) === firma(ocurrencias[0]));

    if (!todasIguales) {
      advertencias.push({
        tipo: 'guia_refacturada',
        guia: tracking,
        detalle:
          `La guía aparece ${ocurrencias.length} veces con importes DISTINTOS. `
          + 'Se tomó la primera; las otras NO se sumaron. Revisar si UPS la re-facturó.',
        montos: ocurrencias.map((g) =>
          r2((g.neto ?? 0) + g.cargos.reduce((s, c) => s + c.monto, 0))
        ),
      });
    }
  }

  // ─── Armado del resultado ──────────────────────────────────────────────────

  const resultado = unicas.map((g) => {
    const total_recargos = r2(g.cargos.reduce((s, c) => s + c.monto, 0));

    // neto null = la máquina de estados no encontró el importe. NO se degrada a 0:
    // se propaga como null y se avisa, para que el que carga decida qué hacer.
    let costo_total = null;
    if (g.neto == null) {
      advertencias.push({
        tipo: 'sin_neto',
        guia: g.tracking,
        detalle:
          'No se pudo leer el importe neto de la guía (probablemente cambió el formato '
          + 'del PDF). La guía NO tiene costo calculable.',
      });
    } else {
      costo_total = r2(g.neto + total_recargos);
    }

    return {
      numero_guia: g.tracking,
      pais: g.pais,
      peso: g.peso,
      neto: g.neto,
      total_recargos,
      costo_total,
      // Desglose de recargos por tipo (Additional Handling, Large Package, etc.).
      // Se persiste en factura_guias.cargos_json para el cruce "recargos facturados
      // vs cobrados". Cada item: { nombre, monto }.
      cargos: g.cargos,
    };
  });

  // ─── Reconciliación contra el total del PDF ────────────────────────────────
  //
  // Chequeo que en producción no existía (sí estaba, con el número hardcodeado, en
  // scripts/diagnostico_factura.js). Sobre la factura de ejemplo la suma de guías da
  // 3.068,33 y el total declarado 3.159,55: la diferencia son las percepciones de
  // Ingresos Brutos del pie, que UPS efectivamente cobra.
  //
  // Acá NO se decide si esa diferencia forma parte del costo del envío — es una
  // decisión de negocio de Felipe. Lo que se hace es DECIRLO, en vez de guardar el
  // subtotal como si fuera el total y dejar el margen inflado ~3% en toda guía UPS.
  const total_declarado = leerTotalDeclarado(lines);
  const conCosto = resultado.filter((g) => g.costo_total != null);
  const suma_guias = r2(conCosto.reduce((s, g) => s + g.costo_total, 0));

  let diferencia = null;
  let cuadra = null;
  if (total_declarado != null) {
    diferencia = r2(total_declarado - suma_guias);
    cuadra = Math.abs(diferencia) < 0.05;
    if (!cuadra) {
      advertencias.push({
        tipo: 'total_no_cuadra',
        detalle:
          `La suma de las guías (USD ${suma_guias.toFixed(2)}) no coincide con el total `
          + `declarado en la factura (USD ${total_declarado.toFixed(2)}). `
          + `Diferencia: USD ${diferencia.toFixed(2)}. `
          + 'Suele ser la percepción de Ingresos Brutos del pie de la factura.',
      });
    }
  } else {
    advertencias.push({
      tipo: 'sin_total_declarado',
      detalle:
        'No se pudo leer el total de la factura del PDF, así que no se pudo verificar '
        + 'que la suma de las guías cuadre.',
    });
  }

  if (resultado.length === 0) {
    advertencias.push({
      tipo: 'sin_guias',
      detalle:
        'No se detectó ninguna guía en el PDF. Puede que UPS haya cambiado el formato '
        + 'o que el archivo no sea una factura.',
    });
  }

  return {
    numero_factura,
    fecha_factura,
    guias: resultado,
    total_declarado,
    suma_guias,
    diferencia,
    cuadra,
    advertencias,
  };
}

module.exports = { extraerFacturaUPS, parseImporte };
