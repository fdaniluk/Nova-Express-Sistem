/* Número de salida QUE VE LA OFICINA (#Sal): correlativo 1..N POR MES, ordenado por fecha
   ASC y desempatado por id ASC. Los envíos "sin numerar" (num_sal_cero) reciben 0 y NO
   consumen número: el resto del mes se numera corrido como si no existieran.

   UNA sola implementación (15/10/2026) para el backend (salidas.routes.js, que numera sobre
   el mes completo así el respaldo de una semana muestra los números reales) y la pantalla
   (salidas.js, que renumera al vuelo al editar sin volver a pedir la lista). Antes eran dos
   copias de la misma regla y test-cierre-excel las comparaba. */
(function (raiz) {
  // envios: [{ id, fecha, num_sal_cero }]. Devuelve un Map id → número (0 para los sin numerar).
  function numerarPorMes(envios) {
    const porMes = new Map();
    for (const e of envios) {
      const mes = String(e.fecha || '').slice(0, 7);
      if (!porMes.has(mes)) porMes.set(mes, []);
      porMes.get(mes).push(e);
    }
    const out = new Map();
    for (const lista of porMes.values()) {
      lista.sort((a, b) => {
        if (a.fecha < b.fecha) return -1;
        if (a.fecha > b.fecha) return 1;
        return (a.id || 0) - (b.id || 0);
      });
      let n = 0;
      for (const e of lista) out.set(e.id, e.num_sal_cero ? 0 : ++n);
    }
    return out;
  }
  const api = { numerarPorMes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.NovaNumeracion = api;
}(typeof window !== 'undefined' ? window : this));
