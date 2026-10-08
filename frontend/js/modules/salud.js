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
  // Semáforo (08/10/2026): urgente (rojo) · para mirar (ámbar) · en orden · no se pudo.
  const TILES = [
    ['rojo', 'Urgente', 'plata en juego'],
    ['ambar', 'Para mirar', 'datos que faltan o se vencen'],
    ['ok', 'En orden', 'controles en verde'],
    ['error', 'No se pudo chequear', 'el control no corrió'],
  ];
  const ETIQUETA_CHIP = { rojo: 'urgente', ambar: 'para mirar', error: 'sin chequear' };

  const $semaforo = document.getElementById('semaforo');
  const $grupos = document.getElementById('grupos');
  const $pie = document.getElementById('pie');
  const $alert = document.getElementById('alert-box');
  const $btn = document.getElementById('btn-refrescar');
  const $revisado = document.getElementById('sal-revisado');
  const $filtro = document.getElementById('sal-filtro');
  // 'todos' | 'mirar' (solo los controles con algo). Se recuerda mientras dure la pestaña.
  let filtro = sessionStorage.getItem('salud_filtro') === 'mirar' ? 'mirar' : 'todos';

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
      ? `<div class="chequeo-acciones"><a class="btn btn-sm btn-outline" href="${esc(c.link.href)}">${esc(c.link.texto)}</a></div>`
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

  // Qué dice cada grupo debajo del título (el nombre lo manda el backend).
  const SUBTITULO = { plata: 'lo que puede costar dinero si no se mira', datos: 'clientes o envíos incompletos', higiene: 'copias, cierres y basura en la base' };

  function chipGrupo(lista) {
    const n = (s) => lista.filter((c) => c.severidad === s).length;
    if (n('error')) return `<span class="sal-chip error">${n('error')} sin chequear</span>`;
    if (n('rojo')) return `<span class="sal-chip rojo">${n('rojo')} ${ETIQUETA_CHIP.rojo}</span>`;
    if (n('ambar')) return `<span class="sal-chip ambar">${n('ambar')} para mirar</span>`;
    return '<span class="sal-chip">todo en orden</span>';
  }

  function aplicarFiltro() {
    $grupos.querySelectorAll('.chequeo').forEach((c) => {
      c.classList.toggle('oculto', filtro === 'mirar' && c.classList.contains('ok'));
    });
    $grupos.querySelectorAll('.salud-paso').forEach((p) => {
      const visibles = p.querySelectorAll('.chequeo:not(.oculto)').length;
      let vacio = p.querySelector('.sal-vacio');
      if (!visibles && !vacio) {
        vacio = document.createElement('div'); vacio.className = 'sal-vacio'; vacio.textContent = 'Nada para mirar en este grupo.';
        p.appendChild(vacio);
      }
      if (vacio) vacio.hidden = visibles > 0;
    });
    if ($filtro) $filtro.querySelectorAll('button[data-filtro]').forEach((b) => b.classList.toggle('on', b.dataset.filtro === filtro));
  }

  function pintar(data) {
    const r = data.resumen;
    const corte = data.fecha_corte
      ? `<div class="salud-tile"><div class="tile-label">Desde el corte</div><div class="tile-num chico">${esc(NovaUtils.formatDate(data.fecha_corte))}</div><div class="tile-sub">lo anterior no se destaca</div></div>`
      : '';
    $semaforo.innerHTML = TILES
      .filter(([s]) => r[s] || s === 'rojo' || s === 'ambar' || s === 'ok')
      .map(([s, label, sub]) => `
        <div class="salud-tile ${s}">
          <div class="tile-label">${label}</div>
          <div class="tile-num">${r[s] || 0}</div>
          <div class="tile-sub">${sub}</div>
        </div>`)
      .join('') + corte;

    const porGrupo = {};
    for (const c of data.chequeos) (porGrupo[c.grupo] = porGrupo[c.grupo] || []).push(c);

    let n = 0;
    $grupos.innerHTML = Object.entries(data.grupos)
      .filter(([g]) => porGrupo[g])
      .map(([g, titulo]) => {
        const lista = porGrupo[g]
          .slice()
          .sort((a, b) => ORDEN_SEVERIDAD[a.severidad] - ORDEN_SEVERIDAD[b.severidad]);
        n += 1;
        return `<section class="salud-paso" data-grupo="${esc(g)}">
          <div class="salud-paso-cab"><span class="salud-paso-num">${n}</span><h3>${esc(titulo)}</h3><span class="em">${esc(SUBTITULO[g] || '')}</span>${chipGrupo(lista)}</div>
          ${lista.map(tarjeta).join('')}
        </section>`;
      })
      .join('');
    aplicarFiltro();

    const d = new Date(data.generado_en);
    const hora = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if ($revisado) $revisado.textContent = `revisado ${NovaUtils.hoyLocal(d) === NovaUtils.hoyLocal(new Date()) ? 'hoy' : NovaUtils.formatDate(NovaUtils.hoyLocal(d))} ${hora}`;
    $pie.textContent =
      `Revisado el ${NovaUtils.formatDate(NovaUtils.hoyLocal(d))} a las ${hora}. `
      + 'Este panel solo lee: no modifica ningún dato. '
      + (data.fecha_corte ? `Se controla desde el ${NovaUtils.formatDate(data.fecha_corte)} (fecha de corte, en Configuración): lo anterior se cuenta pero no se destaca. ` : '')
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
  if ($filtro) {
    $filtro.querySelectorAll('button[data-filtro]').forEach((b) => b.addEventListener('click', () => {
      filtro = b.dataset.filtro;
      try { sessionStorage.setItem('salud_filtro', filtro); } catch (e) { /* sin storage, no pasa nada */ }
      aplicarFiltro();
    }));
  }
  cargar();
})();
