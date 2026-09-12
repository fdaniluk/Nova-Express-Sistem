// Herramienta de laboratorio (no es tanda): arma docs/manuales/manual-salidas.docx con las capturas de _capturas-salidas.js.
//   node scripts/_capturas-salidas.js /tmp/man-sal && node scripts/_manual-salidas-docx.js /tmp/man-sal ../docs/manuales/manual-salidas.docx
// Necesita el paquete `docx` (npm i -g docx o en el contenedor de Claude).
// Manual de Salidas (Word) — versión 12/09/2026, con el rediseño de septiembre.
const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, ShadingType, PageBreak, Footer, PageNumber } = require('docx');

const IMG = process.argv[2];
const OUT = process.argv[3];
const AZUL = '2A3661'; const CORAL = 'EA6749'; const GRIS = '6B7280'; const HIELO = 'EAF1F8';
const ANCHO_UTIL = 690; // px útiles de una hoja Letter con márgenes de 900 twips

function pngSize(file) { const b = fs.readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }
function img(name, anchoPx = ANCHO_UTIL) {
  const file = path.join(IMG, name); const { w, h } = pngSize(file);
  const ww = Math.min(anchoPx, ANCHO_UTIL); const hh = Math.round(h * ww / w);
  return new ImageRun({ type: 'png', data: fs.readFileSync(file), transformation: { width: ww, height: hh } });
}
const foto = (name, ancho) => new Paragraph({ children: [img(name, ancho)], spacing: { before: 80, after: 120 }, alignment: AlignmentType.CENTER });
const H1 = (t, salto = false) => new Paragraph({ pageBreakBefore: salto, spacing: { before: 240, after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: CORAL, space: 4 } }, children: [new TextRun({ text: t, bold: true, size: 30, color: AZUL, font: 'Calibri' })] });
const P = (t, opts = {}) => new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: t, size: 21, font: 'Calibri', ...opts })] });
const NOTA = (t) => new Paragraph({ spacing: { after: 100 }, shading: { type: ShadingType.CLEAR, fill: 'FFF7ED', color: 'auto' }, border: { left: { style: BorderStyle.SINGLE, size: 24, color: CORAL, space: 8 } }, children: [new TextRun({ text: t, size: 20, font: 'Calibri', color: '7C2D12' })] });
// Un renglón "globito → explicación": el número en un círculo coral (texto blanco sobre sombreado).
const ITEM = (n, titulo, texto) => new Paragraph({
  spacing: { after: 70 }, indent: { left: 360, hanging: 360 },
  children: [
    new TextRun({ text: ` ${n} `, bold: true, size: 20, font: 'Calibri', color: 'FFFFFF', shading: { type: ShadingType.CLEAR, fill: CORAL, color: 'auto' } }),
    new TextRun({ text: `  ${titulo}`, bold: true, size: 21, font: 'Calibri', color: AZUL }),
    new TextRun({ text: ` — ${texto}`, size: 21, font: 'Calibri' }),
  ],
});
const PASO = (n, texto) => new Paragraph({ spacing: { after: 70 }, indent: { left: 360, hanging: 360 }, children: [new TextRun({ text: `${n}.  `, bold: true, size: 21, font: 'Calibri', color: AZUL }), new TextRun({ text: texto, size: 21, font: 'Calibri' })] });

// Foto chica a la izquierda + texto a la derecha (para los paneles angostos).
function ladoALado(name, anchoImg, parrafos) {
  const total = 9900; const c1 = Math.round(anchoImg * 15) + 200; const c2 = total - c1;
  const sinBorde = { top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } };
  return new Table({
    width: { size: total, type: WidthType.DXA }, columnWidths: [c1, c2],
    rows: [new TableRow({ children: [
      new TableCell({ width: { size: c1, type: WidthType.DXA }, borders: sinBorde, children: [new Paragraph({ children: [img(name, anchoImg)] })] }),
      new TableCell({ width: { size: c2, type: WidthType.DXA }, borders: sinBorde, margins: { left: 200 }, children: parrafos }),
    ] })],
  });
}

const doc = new Document({
  styles: { default: { document: { run: { font: 'Calibri', size: 21 } } } },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 900, bottom: 900, left: 900, right: 900 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Nova Express · Manual de Salidas · 12/09/2026 · pág. ', size: 16, color: GRIS }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: GRIS })] })] }) },
    children: [
      new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: 'MANUAL — LA PANTALLA DE SALIDAS', bold: true, size: 40, color: AZUL })] }),
      new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: 'Sistema Nova Express · versión 12/09/2026 (reemplaza a la del 01/09) · las fotos son del sistema real', size: 20, color: GRIS })] }),

      H1('QUÉ ES ESTA PANTALLA'),
      P('Salidas es la lista de todos los envíos, mes por mes. Es la pantalla donde se busca, se corrige, se controla contra la factura del courier y se ve en qué anda cada paquete. Todo lo demás del sistema toma sus números de acá.'),
      P('Desde septiembre la pantalla está reorganizada: los botones agrupados en VER y ACCIONES, una banda de colores arriba de las columnas que dice qué es cada grupo (Identificación, Bulto, Medidas, Venta, Costos, Resultado, Factura UPS, Estado), los ceros en gris para que no tapen los números que importan, y los bultos de un envío que se pliegan y despliegan con una flechita. Los datos, los filtros y la forma de trabajar son los mismos.'),

      H1('LA BARRA DE ARRIBA'),
      foto('01-cabecera.png'),
      ITEM('1', 'Solo alertas', 'deja a la vista únicamente las filas con algún problema (profit negativo, guía mal tipeada, factura que no cierra).'),
      ITEM('2', '1º bulto', 'un renglón por envío: pliega todos los bultos de todos los envíos. Es solo de vista, no filtra nada. Para plegar UNO solo se usa la flechita de ese envío (ver más abajo).'),
      ITEM('3', 'Columnas fijas', 'elegir qué columnas quedan clavadas a la izquierda cuando se desplaza la tabla (como inmovilizar paneles en Excel). Se puede fijar cualquiera; el botón "Ninguna" las suelta a todas.'),
      ITEM('4', 'Columnas UPS', 'muestra o esconde el bloque de la factura de UPS (Costo UPS, % Real, Profit Real, Peso UPS, Dif Peso, Revisión). Cuando no se está conciliando, escondido deja más lugar.'),
      ITEM('5', '? Colores', 'abre la leyenda que explica cada color de la tabla. Ante la duda de "por qué está rojo esto", empezar por acá.'),
      ITEM('6', 'Copiar guías', 'copia al portapapeles los números de guía de las filas tildadas (el número entre paréntesis dice cuántas). Para pegarlas en la web del courier o en un mail.'),
      ITEM('7', 'Limpiar filtros', 'saca TODO de un golpe —filtros de columna, búsqueda, Solo alertas y el plegado— y deja la tabla por número de salida, del más alto al más bajo. Cuando algo "no aparece" y no se sabe por qué, este botón es la respuesta.'),
      ITEM('8', 'El buscador', 'busca por guía, cliente, destino u observaciones, dentro del mes abierto. Ctrl+F desde cualquier lado de la pantalla lleva el cursor acá.'),
      ITEM('9', 'El contador', 'cuántos envíos se están viendo sobre el total. Si no coincide con el total, hay un filtro puesto.'),
      ITEM('10', 'El cierre', 'el mes elegido y los botones ↓ Mes y ↓ Semana bajan el Excel de respaldo de ese período (un renglón por bulto, con el número de salida). Al lado dice cuándo fue el último cierre.'),
      ITEM('11', 'Las solapas de mes', 'cada una con su cantidad. El mes NO es un filtro: es el período que se está mirando, y Limpiar filtros no lo toca.'),

      H1('LA TABLA: LOS GRUPOS, LOS BULTOS Y LOS CHIPS', true),
      foto('02-tabla-identificacion.png'),
      ITEM('1', 'Identificación', 'número de salida, courier, fecha, guía, forma de cobro, cliente y destino. El ▼ de cada columna filtra como en Excel: se tildan los valores que se quieren ver y se aplica; los filtros puestos aparecen como chips arriba de la tabla y se sacan de a uno con la ×.'),
      ITEM('2', 'Bulto', 'el punto de color es el estado de la caja (rojo / amarillo / verde, ver el semáforo más abajo) y al lado "1/3" es qué bulto es de cuántos.'),
      ITEM('3', 'Medidas y pesos', 'largo, ancho y alto, peso de balanza, volumétrico y el facturable (el que decide el precio, por eso va en negrita).'),
      ITEM('4', 'La flechita ▾ / ▸', 'en un envío de varios bultos pliega o despliega SUS bultos. Los renglones de los bultos son más bajos y grises, con el símbolo └. El botón "1º bulto" de arriba hace lo mismo pero con todos los envíos a la vez.'),
      ITEM('5', 'El chip +50', 'un envío de DHL de más de 50 kg: la guía sale por la OTRA cuenta de DHL (la de "más de 50 kilos"), que es más barata y no cobra GoGreen. El sistema lo decide solo al cargar el envío; el chip avisa.'),
      ITEM('6', 'El chip DDP', 'el envío se cargó con impuestos de destino a cargo de Nova. Gris "DDP" = todavía no llegó la factura de impuestos de UPS; azul "DDP $46.30" = llegó y dice cuánto, pendiente de liquidar al cliente; rojo "¡Imp. sin DDP!" = UPS facturó impuestos a un envío que NO tenía la tilde: hay que mirarlo.'),
      ITEM('7', 'El semáforo', 'se pinta SOLO para los envíos de UPS: el sistema consulta a UPS cada 4 horas. ROJO = la etiqueta existe pero UPS todavía no la escaneó · AMARILLO = en tránsito · VERDE = entregada. Pasando el mouse dice qué informó UPS y a qué hora. En DHL el punto se marca a mano desde el modal.'),
      ITEM('8', 'Los renglones de bulto', 'llevan las medidas y el peso de ESE bulto; los datos del envío (cliente, plata) van solo en el primero. Cada bulto tiene su propia casilla para Copiar guías.'),
      NOTA('Un envío que salió hace días y sigue en ROJO está avisando algo: o la guía se tipeó mal, o el paquete nunca se despachó. Vale la pena mirarlo.'),

      H1('LA PLATA DE CADA ENVÍO', true),
      P('Las columnas de la derecha muestran las dos cosas, una al lado de la otra: en Venta, Costos y Resultado lo que calculamos nosotros; en Factura UPS lo que UPS facturó de verdad. Los importes van sin el signo $ (la banda ya dice USD) y los ceros en gris, para que resalten los números que importan.'),
      foto('03a-venta-costos.png'),
      ITEM('1', 'Venta Total', 'lo que se le cobra al cliente. La flechita ▸ al lado abre el desglose. Es el número que después va a la liquidación.'),
      ITEM('2', 'Compra Total', 'nuestra estimación del costo (flete + fuel + seguro + adicionales…), congelada al cargar el envío. Está en celeste porque es contra ESE número que se compara la factura del courier.'),
      ITEM('3', 'Profit y %', 'venta menos esa estimación. Verde gana, ámbar empata, rojo pierde. Este número NO cambia nunca solo.'),
      ITEM('9', 'Venta en cero', 'un envío cargado sin precio de venta: plata que todavía no se le facturó a nadie. La liquidación no lo deja confirmar en cero.'),
      P('Y más a la derecha, el bloque de la factura (se muestra o esconde con el botón Columnas UPS):', { color: GRIS }),
      foto('03b-factura-ups.png'),
      ITEM('4', 'Costo UPS', 'lo que UPS facturó por esa guía. Aparece cuando se carga la factura del mes. Se pinta de rojo si se desvió de la estimación más de la tolerancia (el tooltip dice cuánto).'),
      ITEM('5', '% Real', 'el porcentaje de ganancia de verdad de esa guía: (venta − Costo UPS) / Costo UPS. Reemplazó a la vieja columna "Dif Costo".'),
      ITEM('6', 'Profit Real', 'venta menos el Costo UPS, en plata. Aparece apenas se cruza la factura, sin esperar el tilde de revisión.'),
      ITEM('7', 'Peso UPS y Dif Peso', 'los kilos que facturó UPS contra los cargados. En rojo cuando UPS pesó de más.'),
      ITEM('8', 'Revisión', 'los botones ✓ y ✗. Mientras están a la vista, esa guía está pendiente de que alguien la mire. El ✓ nunca se pone solo.'),
      ITEM('10', 'Una guía ya revisada', 'con el ✓ puesto, la fila muestra solo el tilde verde en Revisión. El Dif Peso en rojo (+22.2%) es un re-pesaje de UPS.'),
      P('Todo el bloque Factura UPS se llena cuando se carga la factura del courier, a principio de mes. Eso tiene su propio manual: "Control de Facturas UPS".', { color: GRIS }),

      H1('LOS TRES PANELES CHICOS'),
      ladoALado('04-filtro-semaforo.png', 240, [
        P('EL ▼ DE LA COLUMNA BULTO', { bold: true, color: AZUL }),
        P('La celda de Bulto dice "2/3", y sobre eso se pueden hacer preguntas distintas. Por eso ese ▼ tiene tres criterios:'),
        ITEM('1', 'Bulto n° / Cant. bultos / Semáforo', 'se elige de qué se quiere filtrar.'),
        ITEM('2', 'Los valores', 'se tildan los que se quieren ver (con "Semáforo": No escaneada, En tránsito, Entregada). "En tránsito" deja a la vista todo lo que está viajando.'),
        ITEM('3', 'Aplicar', 'se combina con los filtros de las demás columnas: queda el renglón que cumple todo lo que se pidió.'),
      ]),
      new Paragraph({ spacing: { after: 160 }, children: [] }),
      ladoALado('05-columnas-fijas.png', 150, [
        P('COLUMNAS FIJAS (📌)', { bold: true, color: AZUL }),
        P('Se tildan las columnas que tienen que quedar clavadas a la izquierda cuando se desplaza la tabla hacia la derecha para ver la plata. Lo típico: #Sal y Cliente, o Guía. Se puede fijar cualquiera de las columnas; "Ninguna" las suelta a todas. La elección queda guardada en esa computadora.'),
        P('Consejo: con Guía y Cliente fijas, la conciliación de la factura se hace sin perder de vista de qué envío se trata.'),
      ]),
      new Paragraph({ spacing: { after: 160 }, children: [] }),
      ladoALado('06-colores.png', 300, [
        P('? COLORES: LA LEYENDA', { bold: true, color: AZUL }),
        P('Cada color de la tabla tiene un significado y la leyenda los explica todos: los bordes de fila (rojo profit negativo, ámbar profit cero o venta sin costo, gris violáceo y tachado NO VOLÓ, amarillo fila marcada a mano), las celdas (guía en ámbar mal tipeada, Costo o Peso UPS en rojo facturado de más, Compra en celeste, "sin pesar"), los puntos del bulto y los chips de estado.'),
        P('Esc o un clic afuera la cierra.'),
      ]),

      H1('EDITAR UN ENVÍO: EL MODAL', true),
      P('Clic en cualquier celda de la fila (o Enter sobre la celda activa) abre el modal con el campo de esa celda resaltado. Está en dos columnas: a la izquierda los tres pasos (1 Identificación · 2 Bultos, medidas y estado de la caja · 3 Costos), a la derecha el resultado y los botones, siempre a la vista.'),
      foto('07-modal.png', 560),
      ITEM('4', 'Servicio UPS', 'aparece solo con courier UPS: Saver o Expedited. Si se cambia un envío de DHL a UPS hay que elegirlo, y el sistema borra la marca +50 en el mismo guardado.'),
      ITEM('5', '+ Agregar bulto', 'para el envío que se cargó con 1 caja y resultaron 2: se agrega el bulto con su peso y sus tres medidas. Un envío ya liquidado no deja agregar.'),
      ITEM('6', 'Venta total', 'lo que paga el cliente. Al pararse acá aparecen debajo las cotizaciones guardadas de ese cliente, para tomar el precio acordado.'),
      ITEM('7', 'Compra total', 'la suma de los costos del paso 3, en vivo: cambia al tocar cualquier costo.'),
      ITEM('8', 'Profit', 'venta menos compra, en plata y en %. Se recalcula solo.'),
      ITEM('9', 'Recalcular costo', 'vuelve a calcular flete, fuel y adicionales con las medidas actuales y la tarifa vigente. Si el recálculo cambia de cuenta de DHL (pasa o deja de pasar los 50 kg), avisa con un cartel.'),
      ITEM('10', 'Calcular venta', 'propone el precio de venta con la tarifa del cliente (matriz de profit o precio por kilo) y lo muestra para aplicar o descartar.'),
      ITEM('11', 'Guardar cambios', 'también con Ctrl+Enter. Si algún número quedó mal escrito, el sistema avisa cuál es y no guarda nada.'),
      ITEM('12', 'Eliminar envío', 'borra el envío. Un envío ya liquidado NO se puede borrar, y tiene la plata, el cliente y la fecha congelados (cambiarlos descuadraría una liquidación confirmada); el resto sí se corrige.'),
      ITEM('13', 'NO VOLÓ', 'marca el envío que no salió: no se le factura al cliente, no cuenta en el dashboard ni en el cierre. Si algún día sale, se desmarca.'),
      NOTA('Los decimales van con PUNTO: 1250.50, nunca 1250,50. Con coma el campo queda inválido y el sistema no deja guardar (antes se guardaba vacío y nadie se enteraba).'),

      H1('ATAJOS DE TECLADO (PARA LOS QUE VIENEN DE EXCEL)'),
      PASO('1', 'Flechas ↑ ↓ ← → mueven la celda activa por la tabla.'),
      PASO('2', 'Enter abre el modal del envío, con el campo de esa columna resaltado.'),
      PASO('3', 'Ctrl+C sobre una celda copia su valor limpio (sin flechitas, sin "kg") y la parpadea en verde. Si hay texto marcado con el mouse, copia eso.'),
      PASO('4', 'Ctrl+F lleva el cursor al buscador desde cualquier lado de la pantalla.'),
      PASO('5', 'Esc suelta la celda activa; en el modal, lo cierra sin guardar. Ctrl+Enter guarda.'),

      H1('LO QUE HAY QUE MIRAR SEGUIDO'),
      PASO('1', 'Los envíos en ROJO de hace varios días: guía mal tipeada o paquete sin despachar.'),
      PASO('2', 'El botón "Solo alertas": junta todo lo que el sistema marcó como raro.'),
      PASO('3', 'Los envíos con Venta en cero: plata que todavía no se le facturó a nadie.'),
      PASO('4', 'A principio de mes, con la factura de UPS cargada: los Costo UPS y Dif Peso en rojo, y los chips "¡Imp. sin DDP!".'),
      PASO('5', 'Los chips DDP azules: impuestos que UPS ya facturó y todavía no se le liquidaron al cliente.'),
      new Paragraph({ spacing: { before: 240 }, children: [new TextRun({ text: 'Ante cualquier diferencia entre este manual y el sistema, manda el sistema. Si algo quedó viejo, avisar para regenerarlo.', size: 19, color: GRIS, italics: true })] }),
    ],
  }],
});

Packer.toBuffer(doc).then((b) => { fs.writeFileSync(OUT, b); console.log('✓', OUT, b.length); });
