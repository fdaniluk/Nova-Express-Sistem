/**
 * cotizaciones-recientes.js — el panel de "qué se le cotizó a este cliente".
 *
 * POR QUÉ EXISTE (idea de Felipe, 25/08/2026)
 * Las cotizaciones guardadas vivían abajo del cotizador y ahí no le servían a nadie:
 * *"pocas veces uno va a volver al perfil del cliente para ver una cotización"*. El momento
 * en que hacen falta es otro — cuando administración está cargando el envío y tiene que
 * saber por cuánto se le cotizó a esa persona. Con el destino, el peso y las medidas a la
 * vista, la oficina reconoce el envío de un vistazo (*"se ve que es este"*) y se lleva el
 * precio sin ir a buscarlo a ningún lado.
 *
 * LA REGLA DEL PANEL: EL PRECIO ES UN SUGERIDO.
 * Al elegir una opción, el número se escribe en el campo de venta y ahí termina el trabajo
 * del panel: se puede pisar, borrar o recalcular sin que nada se queje. No engancha el
 * envío a la cotización ni la marca como usada. Es una ayuda para el ojo, no una decisión
 * del sistema.
 *
 * Vive suelto (y no adentro de envios.js o salidas.js) porque lo usan las DOS pantallas y
 * tienen que mostrar exactamente lo mismo: si un día se agrega un dato para reconocer el
 * envío, se agrega una sola vez. Mismo criterio que validar-guia.js.
 */
(function () {
  'use strict';

  const DIAS_POR_DEFECTO = 30;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function usd(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return `USD ${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function fecha(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? `${m[3]}/${m[2]}` : '—';
  }

  // El servicio, corto. Es la misma abreviatura que ve el cliente en la cotización, así
  // que la oficina lee lo mismo de los dos lados.
  function servicioCorto(s) {
    const t = String(s || '');
    if (/saver/i.test(t)) return 'UPS W.S';
    if (/expedited/i.test(t)) return 'UPS W.E';
    if (/UPS/i.test(t)) return 'UPS';
    if (/DHL/i.test(t)) return 'DHL';
    return t || '—';
  }

  /* La línea que hace que la oficina reconozca el envío: es lo que Felipe describió como
     *"acá veo que fueron a esta zona y tiene esta medida, entonces debe ser este envío"*.
     Con un bulto se muestran sus medidas; con varios, cuántos son (listar diez cajas no
     ayuda a reconocer nada y rompe el renglón). */
  function lineaBultos(q) {
    const b = Array.isArray(q.bultos) ? q.bultos : [];
    const partes = [];
    if (q.peso_facturable > 0) partes.push(`${Number(q.peso_facturable).toFixed(1)} kg fact.`);
    if (b.length === 1 && b[0] && b[0].l) {
      partes.push(`${b[0].l}×${b[0].a}×${b[0].al} cm`);
    } else if (b.length > 1) {
      partes.push(`${b.length} bultos`);
    } else if (q.cantidad_bultos > 1) {
      partes.push(`${q.cantidad_bultos} bultos`);
    }
    if (q.valor_declarado > 0) partes.push(`FOB ${usd(q.valor_declarado)}`);
    return partes.join(' · ');
  }

  function chapaEstado(estado) {
    const e = String(estado || '');
    return `<span class="ctzr-estado ctzr-${esc(e)}">${esc(e)}</span>`;
  }

  function filaHtml(q) {
    const destino = [q.pais, q.zona ? `zona ${q.zona}` : null,
      q.tipo_envio === 'importacion' ? 'impo' : 'expo'].filter(Boolean).join(' · ');
    const opciones = (q.opciones_resumen || []).map((o) => `
      <button type="button" class="ctzr-precio" data-total="${Number(o.total) || 0}"
              title="Escribir ${usd(o.total)} como precio sugerido — después se puede cambiar">
        <span class="ctzr-serv">${esc(servicioCorto(o.servicio))}</span>
        <span class="ctzr-monto">${usd(o.total)}</span>
      </button>`).join('');

    return `
      <div class="ctzr-fila">
        <div class="ctzr-datos">
          <div class="ctzr-titulo">
            <b>CTZ-${esc(q.numero)}</b>
            <span class="ctzr-fecha">${fecha(q.creado_en)}</span>
            ${chapaEstado(q.estado)}
          </div>
          <div class="ctzr-destino">${esc(destino)}</div>
          <div class="ctzr-medidas">${esc(lineaBultos(q))}</div>
        </div>
        <div class="ctzr-precios">${opciones || '<span class="ctzr-vacio">sin opciones</span>'}</div>
      </div>`;
  }

  /**
   * Pinta el panel adentro de `cont`.
   *
   * @param {HTMLElement} cont      dónde va
   * @param {Object} opts
   *   clienteId  cliente a consultar (sin cliente el panel se limpia y no pide nada)
   *   dias       días corridos hacia atrás (30 por defecto)
   *   onUsar     fn(total) — se llama al apretar un precio
   */
  async function montar(cont, { clienteId, dias, onUsar } = {}) {
    if (!cont) return;
    const id = parseInt(clienteId, 10);
    if (!Number.isFinite(id)) {
      cont.innerHTML = '<div class="ctzr-vacio">Elegí un cliente para ver sus cotizaciones.</div>';
      return;
    }
    const n = dias || DIAS_POR_DEFECTO;
    cont.innerHTML = '<div class="ctzr-vacio">Buscando…</div>';

    let filas = [];
    try {
      filas = await NovaAPI.cotizaciones.recientesDe(id, n);
    } catch (e) {
      // Que el panel falle no puede trabar la carga del envío: avisa y se queda quieto.
      cont.innerHTML = `<div class="ctzr-vacio">No se pudieron traer las cotizaciones: ${esc(e.message || e)}</div>`;
      return;
    }

    if (!filas.length) {
      cont.innerHTML = `<div class="ctzr-vacio">Este cliente no tiene cotizaciones guardadas `
        + `en los últimos ${n} días. Se guardan desde el cotizador, tildando `
        + `"guardar en el historial del cliente".</div>`;
      return;
    }

    cont.innerHTML = `<div class="ctzr-lista">${filas.map(filaHtml).join('')}</div>`;

    cont.querySelectorAll('.ctzr-precio').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        const total = Number(btn.dataset.total) || 0;
        cont.querySelectorAll('.ctzr-precio').forEach((b) => b.classList.remove('elegido'));
        btn.classList.add('elegido');
        if (typeof onUsar === 'function') onUsar(total);
      });
    });
  }

  function limpiar(cont) {
    if (cont) cont.innerHTML = '';
  }

  window.CotizacionesRecientes = { montar, limpiar, DIAS_POR_DEFECTO };
}());
