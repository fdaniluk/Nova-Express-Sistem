# Los frenos que protegen la plata cargada (01/09/2026, `b466885`)

Felipe: *"ponete a hacer los pendientes que podés hacer vos sin mi ayuda"*. Salieron del
listado de riesgos (`LISTADO-PENDIENTES-COMPLETO.md`, secciones A y E) y **son defectos,
no decisiones**: ninguno necesitaba que él eligiera nada. Los tres primeros cambian
comportamiento, así que van con su tanda propia: `npm run test-frenos` (24 controles).

---

## A1 · Borrar un envío liquidado se llevaba la liquidación confirmada

**Lo que pasaba.** `DELETE /api/salidas/:id` no miraba `liquidado` ni el estado de la
liquidación. Restaba el `total_usd` del ítem al total de la liquidación, borraba el ítem
y, **si era el único, borraba la liquidación entera** — confirmada incluida. Sin
confirmación, sin rol de admin y sin papelera, al alcance de los 9 usuarios.

Era la **otra puerta** del mismo agujero que se tapó el 13/08 en el PATCH (donde un envío
liquidado no puede cambiar de cliente, de fecha ni de plata). El listado lo tenía como A1,
verificado en el código el 20/08 y todavía abierto.

**Cómo quedó.** Antes de la transacción, el DELETE busca si el envío tiene un ítem en una
liquidación con `estado = 'confirmada'` (o si `envios.liquidado` está en 1) y devuelve
**409** con el motivo y el número de liquidación. Los **borradores se siguen borrando**:
es lo que permite limpiar un borrador equivocado, y la liquidación vacía se sigue
limpiando sola.

## A5 · Un número mal tipeado borraba el dato

**Lo que pasaba.** Los campos de plata y de peso del modal son `<input type="number">`.
Si alguien escribe `1250,50` con coma, el navegador considera el valor inválido y
`input.value` devuelve **cadena vacía**; el front mandaba `null` y el envío se guardaba
con el flete (o la venta) **BORRADO**. Nadie se enteraba salvo por el profit, que saltaba
solo — que es exactamente cómo lo describía el listado.

**Cómo quedó, en dos capas:**
- **Front**: antes de guardar recorre los `input[type=number]` del modal y mira
  `validity.badInput` (que es literalmente "hay algo escrito y no es un número"). Si
  alguno está mal, **no guarda nada** y avisa con el nombre del campo y que los decimales
  van con punto.
- **Backend** (la que vale, porque ve todo lo que entra — front viejo, importador, API):
  el PATCH valida `peso_real, largo, ancho, alto, peso_facturable, peso_volumetrico,
  flete, descuento, seguro, fuel, fuel_pct, derechos, adicionales, otros, total_cobrado,
  numero_salida` como números ≥ 0, y `profit`/`porcentaje` como números **con signo**
  (un envío puede dar pérdida y eso hay que poder verlo y guardarlo). `null` sigue siendo
  válido: es "vaciar el campo" y hay pantallas que lo usan.

## E6 · 500 con el error crudo de SQLite

`POST /api/envios` exigía que `tipo_envio` viniera, pero no validaba su valor contra el
CHECK de la base; un `"exportación"` con tilde reventaba con un 500 y el error de SQLite
en la cara del usuario. Ahora `tipo_envio` y `courier` se validan en el controller y
devuelven **400** diciendo qué se esperaba y qué llegó.

## A4 · El modal persistía el profit real encima del estimado

Punta suelta que quedó tras la doble vista del 01/09. La columna Profit muestra el
**estimado**, pero el modal se llenaba con `envio.profit`, que lo resuelve `deriveProfit`
y en un envío ya conciliado **y aprobado** trae el **real**. Resultado: abrir un envío
conciliado y guardar cualquier cosa persistía el profit real en `envios.profit`,
contradiciendo lo que la columna dice. Ahora el modal usa `profit_estimado` /
`porcentaje_estimado`, así la columna, el modal y lo que se persiste dicen lo mismo.

## E8 · El puerto 3999

`test-guias-sin-envio` escuchaba en 3999, un puerto de desarrollo plausible: si había un
server local ahí, el test le hablaba a ESE y fallaba con `no such table: usuarios`, que no
tiene nada que ver. Movido a 3941.

---

## Lo que se revisó y NO era (honestidad)

- **E2 — "código muerto que contradice al motor"** en `calculos.service.js:44-58` y
  `liquidacion.model.js:38-60`: **la nota quedó vieja**. Hoy esas líneas tienen código
  VIVO (`calcularPesos` del motor y `calcularItem` de la liquidación). No hay nada que
  borrar ahí. Si alguna vez hubo duplicados, ya se fueron en las limpiezas anteriores.
- **Pendiente 31 — el logo de Exportalo en el tarifario impreso**: no se tocó a
  propósito. Sacarlo es una decisión de marca de Felipe, no un defecto.

## Lo que quedó afuera porque necesita a Felipe o al VPS

Cron del panel de salud (L11, es en el VPS) · los Excel para la oficina (L4/L17,
necesitan la base de producción) · el sobre de accesos · las decisiones de pricing.
