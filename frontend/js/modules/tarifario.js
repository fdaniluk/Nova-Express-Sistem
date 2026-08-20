/**
 * tarifario.js — dibuja la hoja del tarifario que se le manda al cliente.
 *
 * Se usa en DOS lugares con el mismo código: la vista previa del perfil (dentro de un
 * iframe) y la impresión a PDF. Es a propósito: si la vista previa se dibujara con otro
 * código que la hoja impresa, tarde o temprano una de las dos mentiría.
 *
 * Todo lo que decide qué se muestra viene por query string, y los PRECIOS vienen del
 * servidor ya resueltos (GET /api/clientes/:id/tarifario). Acá no se calcula un solo
 * número: si esta pantalla hiciera cuentas, sería un segundo motor.
 *
 * Parámetros:
 *   cliente     id del cliente (obligatorio)
 *   marca       'nova' | 'exportalo'          servicios  DHL,UPS_EXP,UPS_SAVER
 *   tipo        'export' | 'import'           desde/hasta/paso
 *   combinar    1 = una sola tabla sin nombrar el servicio
 *   base        'alto' | 'medio' | 'bajo'     (con combinar=1)
 *   logo        1/0    nombrar 1/0   nombre_cliente 1/0
 *   fuel        1 = agrega la leyenda de que el precio no incluye combustible
 *   vence       días de validez (0 = sin fecha de vencimiento)
 *   notas 1/0   destinos 1/0
 */
(function () {
  const P = new URLSearchParams(window.location.search);
  const bool = (k, def) => (P.get(k) === null ? def : P.get(k) === '1');

  const MARCAS = {
    nova: {
      logo: '/assets/logos/nova.png', nombre: 'Nova Express',
      osc: '#403754', ac: '#EE6C52', suave: '#fde9e4', impar: '#faf9fb',
      borde: '#e3e0ea', txt: '#2b2540',
      pie: 'Nova Express · Courier internacional · Buenos Aires, Argentina',
      mail: 'ventas@novaexpress.com.ar',
    },
    exportalo: {
      logo: '/assets/logos/exportalo.svg', nombre: 'Exportalo',
      // El celeste del logo (#4fb7fb) sobre blanco no deja leer el texto de los
      // encabezados, así que la versión oscura de la marca es la que va en las tablas.
      osc: '#1B7FC4', ac: '#F53258', suave: '#fde3e8', impar: '#f6fbff',
      borde: '#dbe9f3', txt: '#123a56',
      pie: 'Exportalo · Courier internacional · Buenos Aires, Argentina',
      mail: 'ventas@exportalo.com.ar',
    },
  };

  const FILAS_POR_COL = 47;   // lo que entra en una hoja A4 apaisada con este tamaño de letra
  const COLS_POR_HOJA = 3;

  const cont = document.getElementById('tarifario');

  function fmt(n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fecha(d) {
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  }

  /** Las notas del cuadro de la derecha. Se arman según lo que tenga el tarifario. */
  function armarNotas(data, opts) {
    const hayDHL = data.servicios.includes('DHL');
    const hayUPS = data.servicios.some((s) => s.startsWith('UPS'));
    // 🔴 Si el tarifario NO nombra el servicio, las notas TAMPOCO pueden nombrarlo. Poner
    // "GoGreen (DHL)" abajo de un título genérico es nombrar el servicio igual.
    const anonimo = data.combinar;
    const n = [];
    n.push('Todas las tarifas están expresadas en <b>dólares estadounidenses</b>.');
    if (opts.fuel) {
      n.push('Las tarifas <b>no incluyen el recargo por combustible</b>, variable mensualmente.');
    }
    n.push('<b>Seguro de carga (opcional):</b> 1,5 % sobre el valor declarado, con un mínimo de USD 17,50.');
    if (anonimo && (hayDHL || hayUPS)) {
      n.push('Las tarifas <b>no incluyen los recargos del courier</b> (procesamiento, sostenibilidad y cargos por pieza), que se informan al cotizar cada envío.');
    } else {
      if (hayDHL) n.push('<b>GoGreen:</b> USD 0,98 por kilo facturable, aplicado a todas las exportaciones.');
      if (hayUPS) n.push('<b>Cargos de procesamiento:</b> se informan al cotizar cada envío.');
    }
    n.push('Para <b>destinos remotos</b> se adiciona un cargo por envío o por kilo, el que sea mayor.');
    n.push('La tarifa se aplica sobre el <b>peso mayor entre el de balanza y el volumétrico</b>, siendo el volumétrico largo × ancho × alto (en cm) dividido 5000.');
    n.push('Las tarifas corresponden exclusivamente al <b>servicio puerta a puerta</b>, no incluyendo eventuales gastos aduaneros de destino.');
    n.push(`Envíos de más de ${fmt(data.rango.hasta).replace(',00', '')} kg: consultar.`);
    n.push('La presente tarifa puede sufrir modificaciones en función del volumen de envíos registrados en la cuenta.');
    return n;
  }

  function tablaHTML(data, m, titulo, filas, primera) {
    const cab = `<tr><th class="kg">Peso hasta<br>(kg)</th>${
      data.destinos.map((d) => `<th>${d.nombre.replace(' y ', '<br>y ')}</th>`).join('')}</tr>`;
    const cuerpo = filas.map((f) => {
      const paso = data.rango.paso;
      const cada = (paso !== 'auto' && Number(paso) >= 5) ? 25 : 5;
      const hito = Math.abs(f.peso % cada) < 1e-9;
      const kg = Number(f.peso).toFixed(1).replace('.', ',');
      return `<tr class="${hito ? 'hito' : ''}"><th>${kg}</th>${
        f.precios.map((p) => `<td>${fmt(p)}</td>`).join('')}</tr>`;
    }).join('');
    const cap = primera ? titulo : `${titulo.replace(' (USD)', '')} (USD) — continuación`;
    return `<table><caption>${cap}</caption><thead>${cab}</thead><tbody>${cuerpo}</tbody></table>`;
  }

  function render(data, opts) {
    const m = MARCAS[opts.marca] || MARCAS.nova;
    const r = document.documentElement.style;
    r.setProperty('--osc', m.osc); r.setProperty('--ac', m.ac);
    r.setProperty('--suave', m.suave); r.setProperty('--impar', m.impar);
    r.setProperty('--borde', m.borde); r.setProperty('--txt', m.txt);

    // Las filas se van sirviendo en columnas hasta llenarlas, como en el tarifario que la
    // oficina ya usa: una tabla puede terminar en una columna y seguir en la de al lado, y
    // la de documentos —que son cuatro renglones— comparte columna con el principio de la
    // de paquetes en vez de quedarse con una hoja entera para ella sola.
    //
    // Cada tabla gasta ALTO_CABECERA renglones en su título y su encabezado cada vez que
    // arranca en una columna nueva, y eso se descuenta del alto disponible.
    const ALTO_CABECERA = 3;

    function repartir(capacidad) {
      const cols = [];
      let buffer = '';
      let libre = capacidad;
      for (const t of data.tablas) {
        let i = 0;
        let primera = true;
        while (i < t.filas.length) {
          // Menos de cinco renglones libres no alcanzan ni para el encabezado: hoja nueva.
          if (libre < ALTO_CABECERA + 2) {
            cols.push(buffer); buffer = ''; libre = capacidad;
          }
          const toma = Math.min(libre - ALTO_CABECERA, t.filas.length - i);
          buffer += tablaHTML(data, m, t.titulo, t.filas.slice(i, i + toma), primera);
          libre -= toma + ALTO_CABECERA;
          i += toma;
          primera = false;
        }
      }
      if (buffer) cols.push(buffer);
      return cols;
    }

    // Primera pasada a capacidad llena para saber cuántas columnas hacen falta; segunda
    // repartiendo parejo, para que la última no quede con tres renglones sueltos.
    const cuantas = repartir(FILAS_POR_COL).length;
    const unidades = data.tablas.reduce((s, t) => s + t.filas.length + ALTO_CABECERA, 0);
    const pareja = Math.min(FILAS_POR_COL, Math.max(10, Math.ceil(unidades / cuantas) + ALTO_CABECERA));
    const columnas = repartir(pareja).map((html) => `<div class="col">${html}</div>`);
    if (opts.notas || opts.destinos) {
      const notas = opts.notas
        ? `<h3>Notas</h3><ul>${armarNotas(data, opts).map((x) => `<li>${x}</li>`).join('')}</ul>`
        : '';
      // Los cuatro países que en la hoja híbrida quedan cotizados por encima de su zona
      // real (el backend los manda en `excepciones`; en una hoja de un solo courier viene
      // vacío). Se nombran para que el vendedor sepa que ahí conviene pedir precio.
      const exc = (data.excepciones || []).length
        ? `<div style="margin-top:5px"><b>Consultar precio:</b> ${
          data.excepciones.map((e) => e.pais.replace(' (EE.UU.)', '')).join(' · ')}.</div>`
        : '';
      const destinos = opts.destinos
        ? `<div class="zonas"><h3>Destinos</h3>${
          data.destinos.map((d) => `<div><b>${d.nombre}:</b> ${d.ejemplos}</div>`).join('')
        }${exc}<div style="margin-top:5px;opacity:.65">Detalle completo de países a pedido.</div></div>`
        : '';
      // Con más de 6 destinos (la hoja de los dos couriers) el cuadro se aprieta para que
      // no se vaya a una segunda hoja casi vacía.
      const apretada = (data.destinos || []).length > 6 ? ' apretada' : '';
      columnas.push(`<div class="notas${apretada}">${notas}${destinos}</div>`);
    }

    const hojas = [];
    for (let i = 0; i < columnas.length; i += COLS_POR_HOJA) {
      hojas.push(columnas.slice(i, i + COLS_POR_HOJA));
    }

    // Una emisión guardada se reabre con SU fecha, no con la de hoy: la hoja tiene que
    // decir lo mismo que dijo el día que se mandó.
    const hoy = opts.fechaEmision ? new Date(opts.fechaEmision) : new Date();
    const vence = opts.vence > 0 ? new Date(hoy.getTime() + opts.vence * 86400000) : null;
    // Nombrar el servicio o no es una decisión comercial de Felipe: a veces manda un
    // tarifario "a secas" y después despacha por el courier que le conviene.
    const titulo = (!data.combinar && opts.nombrar && data.etiquetas.length === 1)
      ? data.etiquetas[0]
      : (data.tipo === 'import' ? 'Importaciones' : 'Exportaciones');

    cont.className = '';
    cont.innerHTML = hojas.map((h, i) => `
      <div class="hoja">
        <div class="tapa">
          ${opts.logo
    ? `<img src="${m.logo}" alt="${m.nombre}">`
    : `<div class="marca-texto">${m.nombre}</div>`}
          <div class="tit">${titulo}</div>
          <div class="cli">
            ${opts.nombreCliente ? `Preparado para<br><b>${data.cliente.nombre}</b><br>` : ''}
            Emitido ${fecha(hoy)}${vence ? ` · válido hasta ${fecha(vence)}` : ''}${
  hojas.length > 1 ? ` · hoja ${i + 1} de ${hojas.length}` : ''}
          </div>
        </div>
        <div class="cols">${h.join('')}</div>
        <div class="pie"><span>${m.pie}</span><span>${m.mail}</span></div>
      </div>`).join('');
    document.title = `Tarifario ${data.cliente.nombre} ${fecha(hoy)}`;
  }

  /** Las opciones de presentación, leídas de un accesor (la URL o una emisión guardada). */
  function armarOpts(get) {
    const b = (k, def) => (get(k) === null || get(k) === undefined ? def : String(get(k)) === '1');
    return {
      marca: get('marca') || 'nova',
      logo: b('logo', true),
      nombrar: b('nombrar', true),
      nombreCliente: b('nombre_cliente', true),
      fuel: b('fuel', false),
      notas: b('notas', true),
      destinos: b('destinos', true),
      vence: (get('vence') === null || get('vence') === undefined) ? 30 : Number(get('vence')),
    };
  }

  async function init() {
    try {
      // Una emisión guardada: la hoja se dibuja DESDE lo archivado, con su fecha. Es lo
      // que hace que "lo registrado" y "lo que salió" sean la misma cosa: la impresión
      // normal también pasa por acá (el panel emite primero y después imprime esto).
      const emitidoId = P.get('emitido');
      if (emitidoId) {
        const e = await NovaAPI.tarifario.emitido(emitidoId);
        const opts = armarOpts((k) => (e.opciones ? e.opciones[k] : undefined));
        opts.fechaEmision = (e.creado_en || '').replace(' ', 'T');
        render(e.datos, opts);
        if (P.get('imprimir') === '1') setTimeout(() => window.print(), 300);
        return;
      }

      const clienteId = P.get('cliente');
      if (!clienteId) { cont.className = 'error'; cont.textContent = 'Falta el cliente.'; return; }
      const opts = armarOpts((k) => P.get(k));
      const q = new URLSearchParams({
        servicios: P.get('servicios') || 'DHL',
        tipo: P.get('tipo') || 'export',
        desde: P.get('desde') || '0.5',
        hasta: P.get('hasta') || '50',
        paso: P.get('paso') || 'auto',
        combinar: P.get('combinar') === '1' ? '1' : '0',
        base: P.get('base') || 'alto',
        documentos: P.get('documentos') === '0' ? '0' : '1',
      });
      const data = await NovaAPI.clientes.tarifario(clienteId, q.toString());
      render(data, opts);
      if (P.get('imprimir') === '1') setTimeout(() => window.print(), 300);
    } catch (e) {
      cont.className = 'error';
      cont.textContent = `No se pudo armar el tarifario: ${e.message}`;
    }
  }

  init();
}());
