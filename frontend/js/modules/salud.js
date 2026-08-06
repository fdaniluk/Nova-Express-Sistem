// Panel de salud — pantalla.
//
// Pinta lo que devuelve GET /api/salud. Toda la inteligencia (qué se chequea, con qué
// umbral, qué es rojo y qué es ámbar) vive en el backend, en salud.service.js. Esta
// pantalla no decide nada: si acá se agregara una regla propia, el panel y el servicio
// podrían decir cosas distintas y ganaría el que se leyó último.
//
// Dos decisiones de presentación:
//   · Los chequeos en verde también se muestran, colapsados. Un panel que solo lista
//     problemas no distingue "está todo bien" de "el panel se rompió y no chequeó nada".
//   · Los que tienen algo arrancan ABIERTOS. Si hay que hacer un clic para ver qué pasa,
//     no se hace el clic.

(function () {
  const ORDEN_SEVERIDAD = { error: 0, rojo: 1, ambar: 2, ok: 3 };
  const ETIQUETA = { rojo: 'Rojo', ambar: 'Para mirar', ok: 'En orden', error: 'No se pudo chequear' };

  const $semaforo = document.getElementById('semaforo');
  const $grupos = document.getElementById('grupos');
  const $pie = document.getElementById('pie');
  const $alert = document.getElementById('alert-box');
  const $btn = document.getElementById('btn-refrescar');

  function esc(v) {
    if (v === null || v === undefined || v === '') return '—';
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Los nombres de columna vienen del backend en snake_case; se muestran legibles sin
  // mantener un diccionario en dos lugares.
  function etiquetaCol(k) {
    return k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }

  function celda(k, v) {
    if (v === null || v === undefined || v === '') return '—';
    const esPlata = /monto|costo|total|de_mas|diferencia|estimado|facturado/.test(k);
    if (esPlata && typeof v === 'number') return NovaUtils.formatMoney(v);
    return esc(v);
  }

  function tabla(detalle) {
    if (!detalle || !detalle.length) return '';
    const cols = Object.keys(detalle[0]);
    const head = cols.map((c) => `<th>${esc(etiquetaCol(c))}</th>`).join('');
    const body = detalle
      .map((f) => `<tr>${cols.map((c) => `<td>${celda(c, f[c])}</td>`).join('')}</tr>`)
      .join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function tarjeta(c) {
    const tieneAlgo = c.severidad !== 'ok';
    const abierto = tieneAlgo ? ' abierto' : '';

    const errorBox = c.error
      ? `<div class="chequeo-error"><strong>Este chequeo no pudo correr.</strong> ${esc(c.error)}<br>
         Mientras siga así, no sabemos si acá hay un problema o no.</div>`
      : '';

    // El aviso de truncado NUNCA se omite: un panel que dice "50 casos" cuando hay 300
    // se lee como "ya está todo cubierto", que es peor que no mostrar nada.
    const truncado = c.truncado
      ? `<p class="chequeo-resumen">Se muestran las primeras ${c.detalle.length}; hay ${c.truncado} más.</p>`
      : '';

    const acciones = c.link
      ? `<div class="chequeo-acciones"><a class="btn btn-secondary" href="${esc(c.link.href)}">${esc(c.link.texto)}</a></div>`
      : '';

    const monto = c.monto
      ? `<span class="chequeo-monto">${NovaUtils.formatMoney(c.monto)}</span>`
      : '';

    const cuerpo = tieneAlgo || c.detalle.length
      ? `<div class="chequeo-cuerpo">${errorBox}${tabla(c.detalle)}${truncado}${acciones}</div>`
      : '';

    return `
      <div class="chequeo ${c.severidad}${abierto}" data-id="${esc(c.id)}">
        <div class="chequeo-head">
          <span class="chequeo-punto"></span>
          <div class="chequeo-texto">
            <div class="chequeo-titulo">${esc(c.titulo)}</div>
            <div class="chequeo-resumen">${esc(c.resumen)}</div>
          </div>
          <div class="chequeo-derecha">
            ${monto}
            ${cuerpo ? '<span class="chequeo-flecha">▾</span>' : ''}
          </div>
        </div>
        ${cuerpo}
      </div>`;
  }

  function pintar(data) {
    const r = data.resumen;
    $semaforo.innerHTML = ['rojo', 'ambar', 'ok', 'error']
      .filter((s) => r[s])
      .map((s) => `
        <div class="salud-tile ${s}">
          <div class="tile-num">${r[s]}</div>
          <div class="tile-label">${ETIQUETA[s]}</div>
        </div>`)
      .join('');

    const porGrupo = {};
    for (const c of data.chequeos) (porGrupo[c.grupo] = porGrupo[c.grupo] || []).push(c);

    $grupos.innerHTML = Object.entries(data.grupos)
      .filter(([g]) => porGrupo[g])
      .map(([g, titulo]) => {
        const lista = porGrupo[g]
          .slice()
          .sort((a, b) => ORDEN_SEVERIDAD[a.severidad] - ORDEN_SEVERIDAD[b.severidad]);
        return `<div class="salud-grupo-titulo">${esc(titulo)}</div>${lista.map(tarjeta).join('')}`;
      })
      .join('');

    const d = new Date(data.generado_en);
    $pie.textContent =
      `Revisado el ${NovaUtils.formatDate(NovaUtils.hoyLocal(d))} a las `
      + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}. `
      + 'Este panel solo lee: no modifica ningún dato. '
      + `Una liquidación se considera olvidada a los ${data.dias_borrador} días en borrador.`;

    $grupos.querySelectorAll('.chequeo-head').forEach((h) => {
      h.addEventListener('click', () => {
        const card = h.parentElement;
        if (card.querySelector('.chequeo-cuerpo')) card.classList.toggle('abierto');
      });
    });
  }

  async function cargar() {
    $btn.disabled = true;
    $btn.textContent = 'Revisando...';
    try {
      pintar(await NovaAPI.salud.chequear());
    } catch (err) {
      // Falla ruidosa a proposito: si el panel no puede correr, lo peor que puede hacer
      // es quedarse en blanco y parecer "todo en orden".
      $semaforo.innerHTML = '';
      $grupos.innerHTML = '';
      NovaUtils.showAlert(
        $alert,
        'No se pudo revisar el estado del sistema: ' + err.message
        + '. Mientras tanto, este panel NO está diciendo que esté todo bien: no pudo mirar.'
      );
    } finally {
      $btn.disabled = false;
      $btn.textContent = 'Volver a revisar';
    }
  }

  $btn.addEventListener('click', cargar);
  cargar();
})();
