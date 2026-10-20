/* Número de salida QUE VE LA OFICINA (#Sal): correlativo 1..N POR MES, ordenado por fecha
   ASC y desempatado por id ASC. Los envíos "sin numerar" (num_sal_cero) reciben 0 y NO
   consumen número: el resto del mes se numera corrido como si no existieran.

   POSICIÓN A MANO (20/10/2026, pedido de la oficina): en el modal de Salidas se escribe el
   número de salida que se quiere y el envío se acomoda ahí; los demás se corren. Eso se
   guarda en envios.orden_salida como una CLAVE de orden en el mismo espacio que la clave
   automática (fecha + id), a mitad de camino entre sus vecinos nuevos, igual que el orden a
   mano de los pickups. Cambiarle la fecha al envío lo devuelve al orden automático.

   UNA sola implementación (15/10/2026) para el backend (salidas.routes.js, que numera sobre
   el mes completo así el respaldo de una semana muestra los números reales) y la pantalla
   (salidas.js, que renumera al vuelo al editar sin volver a pedir la lista). Antes eran dos
   copias de la misma regla y test-cierre-excel las comparaba. */
(function (raiz) {
  // Clave automática de orden: días desde 1970 × 1e6 + id. Fecha ASC, id ASC, y deja lugar
  // entre dos envíos para meter uno a mano.
  function claveAuto(fecha, id) {
    const [y, m, d] = String(fecha || '').slice(0, 10).split('-').map(Number);
    const dias = Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d) ? Math.round(Date.UTC(y, m - 1, d) / 86400000) : 0;
    return dias * 1e6 + (Number(id) || 0);
  }
  // La clave con la que se ordena: la de a mano si la tiene, si no la automática.
  function claveDe(e) {
    const o = e.orden_salida;
    return o !== null && o !== undefined && o !== '' && Number.isFinite(Number(o)) ? Number(o) : claveAuto(e.fecha, e.id);
  }
  function ordenarMes(lista) {
    return lista.slice().sort((a, b) => (claveDe(a) - claveDe(b)) || ((a.id || 0) - (b.id || 0)));
  }
  // envios: [{ id, fecha, num_sal_cero, orden_salida }]. Devuelve un Map id → número (0 para
  // los sin numerar).
  function numerarPorMes(envios) {
    const porMes = new Map();
    for (const e of envios) {
      const mes = String(e.fecha || '').slice(0, 7);
      if (!porMes.has(mes)) porMes.set(mes, []);
      porMes.get(mes).push(e);
    }
    const out = new Map();
    for (const lista of porMes.values()) {
      let n = 0;
      for (const e of ordenarMes(lista)) out.set(e.id, e.num_sal_cero ? 0 : ++n);
    }
    return out;
  }
  // La clave que hay que guardarle a `envio` para que quede con el número `numero` (1..N)
  // dentro de `delMes` (los envíos de su mes, con o sin él). Los sin numerar no cuentan
  // para el número pero sí para el orden. numero mayor que la cantidad → al final.
  function claveParaNumero(envio, delMes, numero) {
    const otros = ordenarMes(delMes.filter((e) => e.id !== envio.id));
    const n = Math.max(1, Math.floor(Number(numero) || 1));
    // Posición entre los otros: el que hoy tiene el número n pasa a quedar después.
    let idx = otros.length;
    let cuenta = 0;
    for (let i = 0; i < otros.length; i++) {
      if (otros[i].num_sal_cero) continue;
      cuenta += 1;
      if (cuenta === n) { idx = i; break; }
    }
    const prev = idx > 0 ? claveDe(otros[idx - 1]) : null;
    const next = idx < otros.length ? claveDe(otros[idx]) : null;
    if (prev === null && next === null) return claveAuto(envio.fecha, envio.id);
    if (prev === null) return next - 1;
    if (next === null) return prev + 1;
    return (prev + next) / 2;
  }
  const api = { numerarPorMes, claveAuto, claveDe, ordenarMes, claveParaNumero };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.NovaNumeracion = api;
}(typeof window !== 'undefined' ? window : this));
