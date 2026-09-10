/* ═══════════════════════════════════════════════════════════════════════════════════
   EL CUADRO DE LA COTIZACIÓN COMO IMAGEN — compartido (10/09/2026)

   Hasta el 10/09 este dibujo vivía adentro de cotizador.html (copiarImagen). Se sacó a un
   archivo propio para que el MISMO cuadro se pueda volver a generar desde una cotización
   GUARDADA (perfil del cliente → "Ver cuadro" → reenviar), pedido de Felipe:
   *"poder acceder a ese cuadrado de cotización para reenviarlo en el caso de que no lo
   haya enviado antes"*.

   ⚠ LA IMAGEN NO ES UNA CAPTURA DEL HTML. Se dibuja de cero en un canvas, a propósito:
   así se controla exactamente qué entra y NADA de la pantalla de trabajo se puede colar
   —empezando por el profit del cliente—. Si algún día se cambia a capturar el DOM, vuelve
   la fuga. Las medidas y el orden de los trazos son los de siempre: el test
   test-pantalla-cotizacion-cliente.js espía cada fillText y controla que nada se encime
   ni se vaya del margen.

   USO:
     const canvas = await CotizacionImagen.dibujar({
       nombre,                 // nombre del cliente para la cabecera ('' = sin renglón)
       servicio,               // 'DHL' | 'UPS Worldwide Expedited' | 'UPS Worldwide Saver'
       zona, pf, total,        // zona, kg facturables, total al cliente
       flete, surge, subtotal, fuel_pct, fuel_monto, extras,   // el desglose (= opciones[i])
       bultos: [{pr,l,a,al,pv,pf}],   // como entrada.bultos
       tipo: 'export'|'import',
       valor,                  // FOB declarado (0 = no se escribe)
       conLogo, conValidez,    // franja del pie
       fechaEmision, validaHasta,     // 'dd/mm/aaaa' (si conValidez)
     });
   Devuelve el canvas (a escala 2). CotizacionImagen.aBlob(canvas) → PNG.
   ═══════════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const IMG_ESC = 2;                    // se dibuja al doble y se exporta grande: se ve nítido
  let _logoNova = null;                 // se carga una vez

  function cargarLogo() {
    if (_logoNova) return Promise.resolve(_logoNova);
    return new Promise((res) => {
      const im = new Image();
      im.onload = () => { _logoNova = im; res(im); };
      im.onerror = () => res(null);       // sin logo la imagen sale igual, sin marca
      im.src = '../assets/logos/nova.png';
    });
  }

  function fmt(n) { return 'USD ' + Number(n || 0).toFixed(2); }

  function nombreCorto(svc) {
    if (/Expedited/i.test(svc)) return 'UPS W.E';
    if (/Saver/i.test(svc)) return 'UPS W.S';
    if (/DHL/i.test(svc)) return 'DHL';
    return svc;
  }

  function fechaDDMMAAAA(d) {
    return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
  }
  function fechaHoy() { return fechaDDMMAAAA(new Date()); }
  function fechaMas(dias) { const d = new Date(); d.setDate(d.getDate() + Number(dias || 0)); return fechaDDMMAAAA(d); }
  // 'aaaa-mm-dd…' → 'dd/mm/aaaa'
  function fechaDeIso(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : fechaHoy();
  }

  /* Las filas del desglose salen del MISMO objeto que pintó la tarjeta / que se guardó.
     No recalcula nada: si el número de la pantalla y el de la imagen difirieran, el papel
     mentiría. Sin el "(x kg × USD y)": es el precio por kilo del cliente y no va en lo que
     ve él. */
  function filasDe(op) {
    const f = [];
    f.push(['Flete internacional', fmt(op.flete), 'normal']);
    if (op.surge > 0) f.push(['Surge fee UPS', fmt(op.surge), 'normal']);
    f.push([op.surge > 0 ? 'Subtotal (con surge)' : 'Subtotal', fmt(op.subtotal), 'subtotal']);
    f.push([`Fuel (${op.fuel_pct}%)`, '+ ' + fmt(op.fuel_monto), 'normal']);
    (op.extras || []).forEach(([n, v]) => f.push([n, fmt(v), 'normal']));
    f.push(['Total', fmt(op.total), 'total']);
    return f;
  }

  // Las fuentes del cuadro (DM Sans / DM Mono). En el cotizador ya están cargadas por el
  // CSS; en otras pantallas (perfil del cliente) hay que esperarlas antes de dibujar, si no
  // el primer cuadro sale con la fuente de respaldo.
  async function esperarFuentes() {
    if (!document.fonts || !document.fonts.load) return;
    try {
      await Promise.all([
        document.fonts.load('600 15px "DM Sans"'), document.fonts.load('400 13px "DM Sans"'),
        document.fonts.load('700 14px "DM Sans"'), document.fonts.load('italic 400 10.5px "DM Sans"'),
        document.fonts.load('600 23px "DM Mono"'), document.fonts.load('500 13px "DM Mono"'),
        document.fonts.load('400 9.5px "DM Mono"'),
      ]);
    } catch (_) { /* sin la fuente se dibuja igual */ }
  }

  async function dibujar(d) {
    const nombre = String(d.nombre || '').trim();
    const conLogo = d.conLogo !== false;
    const conVal = d.conValidez !== false;
    const logo = conLogo ? await cargarLogo() : null;
    const esDhl = /DHL/i.test(d.servicio || '');
    const bultos = Array.isArray(d.bultos) ? d.bultos : [];
    const tipo = d.tipo === 'import' || d.tipo === 'importacion' ? 'import' : 'export';
    const valor = Number(d.valor) || 0;
    const pf = Number(d.pf) || bultos.reduce((s, b) => s + (Number(b.pf) || 0), 0);
    const total = Number(d.total) || 0;
    const fechaEmision = d.fechaEmision || fechaHoy();
    const validaHasta = d.validaHasta || fechaMas(d.dias || 15);

    /* ── MEDIDAS ──────────────────────────────────────────────────────────────────────
       Todo el alto se calcula ANTES de dibujar, sumando los mismos números que después
       se usan para pintar. Si se toca una medida, se toca en la constante y listo. */
    const W = 680, P = 28;
    /* La cabecera se arma por BASELINES, no por cajas: cada constante es la distancia de un
       renglón al siguiente. */
    const CAB_TOP = 24;        // del borde de arriba a la baseline de la fecha
    const H_RENGLON1 = 26;     // de la fecha a donde arranca el renglón del courier
    const OFF_COURIER = 23;    // hasta la baseline del courier y del total
    const H_META = 23;         // de la baseline del courier a la de la línea de medidas
    const CAB_BOT = 24;        // de la línea de medidas al borde de la franja
    const CUERPO_TOP = 22, H_FILA = 28, SEP_SUB = 10, SEP_TOT = 14;
    /* La franja del pie aparece si hay logo O si hay validez: la fecha vive ahí abajo,
       en el mismo gris que el contacto (pedido de Felipe, 20/08). */
    const H_DISC = 15, DISC_GAP = 18, CUERPO_BOT = 14, H_PIE = (conLogo || conVal) ? 68 : 0;

    const filas = filasDe(d);
    /* La línea de medidas se arma en TRAMOS: el peso facturable es el dato que decide el
       precio, así que va en negrita y más oscuro (pedido del padre de Felipe, 20/08). */
    const metaTramos = (() => {
      const prT = bultos.reduce((s, x) => s + (Number(x.pr) || 0), 0);
      const pvT = bultos.reduce((s, x) => s + (Number(x.pv) || 0), 0);
      const dir = tipo === 'export' ? 'Exportación' : 'Importación';
      if (bultos.length === 1) {
        const u = bultos[0];
        return [
          [`Zona ${d.zona} · ${u.pr} kg real · ${u.l}×${u.a}×${u.al} cm · ${Number(u.pv).toFixed(1)} kg vol · `, false],
          [`${Number(u.pf).toFixed(1)} kg facturable`, true],
          /* El FOB va también en la imagen (pedido de la oficina, 24/08). */
          [` · 1 bulto · ${dir}${valor > 0 ? ` · FOB ${fmt(valor)}` : ''}`, false],
        ];
      }
      return [
        [`Zona ${d.zona} · ${prT.toFixed(1)} kg real · ${pvT.toFixed(1)} kg vol · `, false],
        [`${pf.toFixed(1)} kg facturable`, true],
        [` · ${bultos.length} bultos · ${dir}${valor > 0 ? ` · FOB ${fmt(valor)}` : ''}`, false],
      ];
    })();

    /* El primer renglón de la cabecera es solo el nombre del cliente. La fecha va al pie. */
    const hayRenglon1 = Boolean(nombre);
    const hCab = CAB_TOP + (hayRenglon1 ? H_RENGLON1 : 0) + OFF_COURIER + H_META + CAB_BOT;
    let hCuerpo = CUERPO_TOP;
    filas.forEach(([, , t]) => { hCuerpo += H_FILA + (t === 'subtotal' ? SEP_SUB : 0) + (t === 'total' ? SEP_TOT : 0); });
    hCuerpo += DISC_GAP + H_DISC + CUERPO_BOT;
    const H = hCab + hCuerpo + H_PIE;

    const c = document.createElement('canvas');
    c.width = W * IMG_ESC; c.height = H * IMG_ESC;
    const x = c.getContext('2d');
    x.scale(IMG_ESC, IMG_ESC);
    x.textBaseline = 'alphabetic';

    x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);

    /* ── CABECERA ─────────────────────────────────────────────────────────────────── */
    x.fillStyle = esDhl ? '#fdf8ec' : '#eef3fb'; x.fillRect(0, 0, W, hCab);
    x.fillStyle = esDhl ? '#e8c96a' : '#b8cef0'; x.fillRect(0, hCab - 1, W, 1);

    let yc = CAB_TOP;
    if (hayRenglon1) {
      yc += 15;
      x.fillStyle = '#1a1916'; x.font = '600 14px "DM Sans", sans-serif';
      x.fillText(nombre, P, yc);
      yc += H_RENGLON1 - 15;
    }
    yc += OFF_COURIER;
    /* "Nova Express – UPS Worldwide Expedited": la empresa firme, el servicio normal. */
    x.font = '600 15px "DM Sans", sans-serif'; x.fillStyle = '#1a1916';
    x.fillText('Nova Express', P, yc);
    const anchoNova = x.measureText('Nova Express').width;
    x.font = '400 15px "DM Sans", sans-serif'; x.fillStyle = '#5c5a54';
    x.fillText(' – ' + nombreCorto(d.servicio), P + anchoNova, yc);
    /* Cartel "Tarifa +50Kg", solo impo DHL de más de 50 kg, pegado al nombre del courier y
       SOLO si entra antes del total (25/08). */
    if (tipo === 'import' && esDhl && pf > 50) {
      const anchoCourier = x.measureText(' – ' + nombreCorto(d.servicio)).width;
      const etq = 'Tarifa +50Kg';
      x.font = '600 9.5px "DM Sans", sans-serif';
      const w = x.measureText(etq).width + 14, xb = P + anchoNova + anchoCourier + 10;
      x.font = '600 23px "DM Mono", monospace';
      const topeIzq = W - P - x.measureText(fmt(total)).width - 14;
      if (xb + w <= topeIzq) {
        x.font = '600 9.5px "DM Sans", sans-serif';
        x.fillStyle = '#fdf8ec'; x.fillRect(xb, yc - 13, w, 16);
        x.strokeStyle = '#e8c96a'; x.lineWidth = 1; x.strokeRect(xb + 0.5, yc - 12.5, w - 1, 15);
        x.fillStyle = '#8a6500'; x.fillText(etq, xb + 7, yc - 2);
      }
    }
    x.textAlign = 'right';
    x.fillStyle = '#1a1916'; x.font = '600 23px "DM Mono", monospace';
    x.fillText(fmt(total), W - P, yc + 2);
    x.textAlign = 'left';
    yc += H_META;
    /* La línea de medidas SE ACHICA lo justo para entrar de margen a margen (25/08). */
    const TAM_META = 10.5;
    const anchoMeta = metaTramos.reduce((suma, [txt, fuerte]) => {
      x.font = (fuerte ? '500 ' : '400 ') + TAM_META + 'px "DM Mono", monospace';
      return suma + x.measureText(txt).width;
    }, 0);
    const tamMeta = anchoMeta > W - 2 * P
      ? Math.max(8.5, TAM_META * ((W - 2 * P) / anchoMeta))
      : TAM_META;
    let xm = P;
    metaTramos.forEach(([txt, fuerte]) => {
      x.font = (fuerte ? '500 ' : '400 ') + tamMeta + 'px "DM Mono", monospace';
      x.fillStyle = fuerte ? (esDhl ? '#7a5f1f' : '#3d5a8a') : (esDhl ? '#a8853a' : '#7d92b5');
      x.fillText(txt, xm, yc);
      xm += x.measureText(txt).width;
    });

    /* ── MARCA DE AGUA ────────────────────────────────────────────────────────────── */
    if (logo) {
      const cuerpoAlto = H - hCab - H_PIE;
      x.save(); x.beginPath(); x.rect(0, hCab, W, cuerpoAlto); x.clip();
      const w = W * 0.58, h = w * (logo.height / logo.width);
      x.globalAlpha = 0.05; x.drawImage(logo, (W - w) / 2, hCab + (cuerpoAlto - h) / 2, w, h);
      x.restore();
    }

    /* ── DESGLOSE ─────────────────────────────────────────────────────────────────── */
    let y = hCab + CUERPO_TOP;
    filas.forEach(([izq, der, tipoF]) => {
      if (tipoF === 'subtotal') { y += SEP_SUB / 2; x.fillStyle = '#e2e0d8'; x.fillRect(P, y, W - P * 2, 1); y += SEP_SUB / 2; }
      if (tipoF === 'total') { y += SEP_TOT / 2; x.fillStyle = '#1a1916'; x.fillRect(P, y, W - P * 2, 1.5); y += SEP_TOT / 2; }
      const esTot = (tipoF === 'total');
      const base = y + H_FILA / 2 + 5;
      x.fillStyle = esTot ? '#1a1916' : '#5c5a54';
      x.font = (esTot ? '700 14px' : (tipoF === 'subtotal' ? '500 13px' : '400 13px')) + ' "DM Sans", sans-serif';
      x.fillText(izq, P, base);
      x.fillStyle = '#1a1916';
      x.font = (esTot ? '700 15px' : '500 13px') + ' "DM Mono", monospace';
      x.textAlign = 'right'; x.fillText(der, W - P, base); x.textAlign = 'left';
      y += H_FILA;
    });

    y += DISC_GAP;
    x.fillStyle = '#9c9a94'; x.font = 'italic 400 10.5px "DM Sans", sans-serif';
    x.fillText('El costo dado no contempla impuestos de nacionalización en destino.', P, y);

    /* ── FRANJA DEL PIE ───────────────────────────────────────────────────────────── */
    if (H_PIE) {
      const yp = H - H_PIE;
      x.fillStyle = '#faf9f6'; x.fillRect(0, yp, W, H_PIE);
      x.fillStyle = '#e2e0d8'; x.fillRect(0, yp, W, 1);
      let xTexto = P;
      if (logo) {
        const h = 36, w = h * (logo.width / logo.height);
        x.drawImage(logo, P, yp + (H_PIE - h) / 2, w, h);
        xTexto = P + w + 20;
      }
      if (conVal) {
        x.fillStyle = '#9c9a94'; x.font = '400 9.5px "DM Mono", monospace';
        x.fillText(fechaEmision, xTexto, yp + 29);
        x.fillText('válida hasta el ' + validaHasta, xTexto, yp + 43);
      }
      if (logo) {
        x.fillStyle = '#9c9a94'; x.font = '400 9.5px "DM Mono", monospace'; x.textAlign = 'right';
        x.fillText('Nova Express · Courier internacional', W - P, yp + 29);
        x.fillText('Buenos Aires · WhatsApp +54 9 11 6500-2047', W - P, yp + 43);
        x.textAlign = 'left';
      }
    }

    /* Filete de 1 px alrededor: en un chat con fondo de color la pieza queda recortada. */
    x.strokeStyle = '#dcdad3'; x.lineWidth = 1; x.strokeRect(0.5, 0.5, W - 1, H - 1);
    return c;
  }

  function aBlob(canvas) {
    return new Promise((r) => canvas.toBlob(r, 'image/png'));
  }

  /* Copia el PNG al portapapeles; si no se puede (HTTP, navegador viejo), lo descarga.
     Devuelve 'copiada' | 'descargada'. */
  async function copiarODescargar(canvas, nombreArchivo) {
    const blob = await aBlob(canvas);
    try {
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error('sin portapapeles');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return 'copiada';
    } catch (_) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = nombreArchivo || 'cotizacion.png';
      a.click(); URL.revokeObjectURL(a.href);
      return 'descargada';
    }
  }

  /* Arma los datos del cuadro a partir de una cotización GUARDADA (GET /api/cotizaciones/:id)
     y una de sus opciones. Es lo que usa el perfil del cliente para reenviar. */
  function datosDeGuardada(q, op) {
    let entrada = {};
    try { entrada = typeof q.entrada === 'string' ? JSON.parse(q.entrada || '{}') : (q.entrada || {}); } catch (_) { entrada = {}; }
    return {
      nombre: q.cliente_nombre_actual || q.cliente_nombre || '',
      servicio: op.servicio, zona: op.zona ?? q.zona, pf: op.pf ?? q.peso_facturable, total: op.total,
      flete: op.flete, surge: op.surge, subtotal: op.subtotal, fuel_pct: op.fuel_pct, fuel_monto: op.fuel_monto,
      extras: op.extras || [],
      bultos: Array.isArray(entrada.bultos) ? entrada.bultos : [],
      tipo: q.tipo_envio === 'importacion' ? 'import' : 'export',
      valor: Number(q.valor_declarado) || 0,
      conLogo: true, conValidez: Boolean(q.vence_en),
      fechaEmision: fechaDeIso(q.creado_en), validaHasta: q.vence_en ? fechaDeIso(q.vence_en) : undefined,
    };
  }

  window.CotizacionImagen = { dibujar, aBlob, copiarODescargar, datosDeGuardada, filasDe, fmt, nombreCorto, esperarFuentes, cargarLogo };
}());
