# Auditoría: dónde el sistema puede dar un número equivocado

**07/08/2026.** Pedida por Felipe después de que la oficina encontrara dos errores de cobro
en un día. La crítica era justa: los errores aparecieron porque los encontró la oficina, no
porque los buscáramos.

**Regla de esta auditoría: nada figura acá como hecho sin haberlo reproducido.** Los que
solo son sospecha están separados y marcados como tales.

> **18/08/2026 — AUDITORÍA CERRADA.** Los 5 confirmados se arreglaron el 13/08 (`cb1aaa3`)
> y las 6 sospechas se comprobaron y cerraron el 18/08 (`dfe9b06`). El detalle de cada
> cierre está al final. Test guardián: `test-auditoria-numeros` (29 controles) +
> `test-plata-en-riesgo` (29).

---

## Lo que ya sabíamos, y por qué no alcanzaba

Los cuatro errores encontrados hasta ahora **no estaban en la matemática**. El motor de
tarifas calcula bien. Estaban en el paso anterior: qué datos se le entregan.

| | Consecuencia |
|---|---|
| Se leía `fob`, la API lo devuelve como `valor_declarado` | sin SEGURO: USD 15 por envío |
| Se leía `tipo_envio`, la API no lo devuelve | importaciones con tarifa de exportación |
| `fuelPct: envio.fuel_pct ?? 0` | cotización SIN combustible: USD 89 en un envío de 30 kg |
| El profit se resolvía sin país | mostraba 75% y cobraba 70% |

Todos pasaron los 500 chequeos. Por eso esta auditoría buscó **esa misma forma** de error, no
fórmulas mal escritas.

---

# CONFIRMADOS — reproducidos, y ARREGLADOS el 13/08 (`cb1aaa3`)

1. **País sin acento → envío SIN COSTO.** `canonizarPais` ahora normaliza igual que
   `buscarZona`. Producción verificada: 0 envíos con peso y sin costo.
2. **Bulto con peso pero sin medidas se descartaba.** Ya no: el peso no se pierde.
3. **El mismo envío se podía facturar DOS VECES.** `confirmar()` re-chequea `liquidado`.
4. **Envío sin precio se liquidaba en CERO para siempre.** Confirmar con ítems en cero se
   rechaza (el borrador se permite).
5. **La plata de un envío liquidado era editable por el PATCH de Salidas.** Congelada igual
   que en el PUT (`CAMPOS_PLATA`, incluye `fob` y `peso_facturable` desde el 14/08).

---

# LAS 6 SOSPECHAS — comprobadas y cerradas el 18/08 (`dfe9b06`)

- **Utilidad duplicada por la doble liquidación.** Probada: **NO pasa**. Descartada (13/08).

- **Importador de Excel — CONFIRMADA y arreglada.** Las tres patas:
  - la zona de una impo UPS se buscaba en `ZONAS_UPS` (exportación); ahora usa
    `ZONAS_UPS_I`. Importaba porque esa zona guardada actúa de override en cada recálculo
    (Bélgica: expo 4, impo 5 → costo de otra fila de la matriz);
  - `tipo_envio` y `tipo_paquete` salían de la misma celda (que dice MERCADERIA/DOCUMENTO):
    toda impo quedaba como `exportacion`. Ahora, si la celda no dice IMP/EXP, manda la
    `direccion` que detectó `normalizarDestino`;
  - DHL sigue con su única tabla; nada cambia en expos.

- **`servicio_ups` ausente cae en UPS_EXP — CONFIRMADA y arreglada en el origen.** El
  importador ahora lo guarda explícito: `UPS_SAV` si la celda del courier menciona SAV,
  `UPS_EXP` si no. Los 12 envíos viejos con NULL quedan como están (el fallback del modelo
  los cubre); revisarlos es parte de la deuda 20.

- **El seguro negociado del cliente no se congelaba — CONFIRMADA y arreglada.** Columna
  nueva **`envios.seguro_venta`**: la foto del monto negociado (`seguro_pct_propio` /
  `seguro_min_propio`, misma regla del motor) tomada al alta y rehecha al editar
  fob/cliente/courier en un envío no liquidado. La línea "Seguro" de la liquidación y del
  desglose de venta de Salidas usa `seguro_venta ?? seguro`. NULL = cliente sin seguro
  propio → escala de lista, el comportamiento de siempre. La columna `seguro` sigue siendo
  el COSTO (escala del courier): son dos números distintos a propósito. Hoy nadie tiene
  seguro propio cargado: cero cambio de números en producción.

- **La utilidad del perfil del cliente — CONFIRMADA y arreglada.** Usaba
  `total_cobrado × tarifa_pct` en SQL: solo cierto para el cliente porcentual "de manual";
  pisaba a los por-kilo, a las tarifas negociadas y al costo real. Ahora el perfil usa
  **`deriveProfit`** — la misma función y la misma precedencia que Salidas y el Dashboard
  (costo real de factura aprobada > foto de la liquidación confirmada > estimado
  venta − costo del desglose congelado). Los tres coinciden al centavo por construcción.

- **El borrador de liquidación quedaba "pegado" — CONFIRMADA y arreglada.** Tres frenos:
  el frontend invalida el borrador ante cualquier cambio de selección/cliente/fechas
  (borra el borrador viejo en el servidor y apaga Confirmar/Exportar); `confirmar()`
  compara la selección de la pantalla contra los items del borrador y rechaza con 409 si
  difieren; y el historial tiene botón **Borrar** para borradores (los cargos vuelven a
  pendientes; una confirmada no se puede borrar). Esto habilita limpiar los borradores 12
  y 30 de la L1 desde la pantalla.

---

## Qué quedó vivo después de esta auditoría

- **Deuda 20**: revisar los envíos ya cargados por si algo se cobró mal — incluye los 12
  con `servicio_ups` NULL y cualquier impo UPS importada por planilla antes del 18/08
  (zona de expo guardada).
- El resto del sistema queda custodiado por los tests: `test-auditoria-numeros`,
  `test-plata-en-riesgo`, `test-fob-y-salida-cero` y las 33 tandas restantes (953 controles).
