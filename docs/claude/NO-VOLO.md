# El botón NO VOLÓ

**Pedido de Felipe el 25/08/2026.** Entregado y commiteado el mismo día en **`2344b61`**.
⚠️ Falta el `git push` de Felipe y el despliegue en el VPS.

---

## De dónde salió

Felipe, textual:

> *"Hay casos en los que envíos que son creadas las guías y subidos a salidas no salen, ni
> van a salir hasta nuevo aviso, quizá nunca salgan, pero de igual manera quedan cargados
> en salidas por motivos que desconozco, por lo tanto originalmente en el Excel se le
> agregaba un color a su renglón y una leyenda que dice NO VOLÓ y también se le saca el
> valor de la venta y de los kg para no modificar la estadística de la oficina a fin de mes
> con un envío que nunca salió."*

Y el pedido explícito de la oficina, que es la parte contraintuitiva:

> *"si yo toco el botón no voló, el envío tiene que mantenerse como el envío 27, no sé por
> qué, pero así me lo pidió la oficina."*

La costumbre ya existía en la planilla. Lo que faltaba era que el sistema hiciera lo mismo
solo, y que la marca fuera reversible.

---

## Las dos decisiones que importan

### 1. Los valores NO se borran

En el Excel la oficina borraba la venta y los kilos a mano. Acá no hace falta: el envío se
marca y **deja de contar**, pero sus números quedan guardados.

| | Se borran (como el Excel) | **Se conservan y no cuentan** ← lo elegido |
|---|---|---|
| La estadística del mes | queda limpia | queda limpia |
| Si el envío finalmente sale | hay que volver a cargar todo a mano | un click y vuelve como estaba |
| Queda rastro de lo que se había cargado | no | sí |

Por eso el mismo botón deshace: al reabrir el envío dice **"Sí voló — deshacer"**.

### 2. El número de salida no se toca

El correlativo de Salidas se calcula al vuelo sobre **todos** los envíos por id, así que
con solo dejar la fila en su lugar el número se mantiene solo — el que no voló y los que
vienen atrás. En la grilla, además, el número es lo **único** que no se ve tachado: los
importes sí, porque ya no valen; el número sigue vigente porque es la referencia con la que
la oficina habla del envío.

Hay dos tests que cuidan esto, uno de API y otro en un navegador de verdad: si algún día
alguien hace que la marca saque la fila de la lista, se cae la tanda.

---

## Qué hace

**Dónde está:** botón rojo **NO VOLÓ** en el pie del detalle del envío, en Salidas (fue el
pedido: que se llegue desde adentro del detalle, no desde la fila). Pide confirmación y
explica qué implica antes de hacer nada.

**Qué pasa al marcarlo:**

- El renglón entero (todos sus bultos) se pinta gris violáceo, con un borde bordó y los
  importes tachados. **No rojo:** el rojo del semáforo significa "hay un problema de plata
  que mirar", y esto no es un problema — es un envío que quedó afuera a propósito.
- La columna Estado muestra la chapa **NO VOLÓ** (con quién lo marcó y cuándo, al pasar el
  mouse). Como el filtro de la columna Estado se arma con esos textos, se puede filtrar
  "solo los que no volaron" sin agregar nada.
- Deja de contar en: **dashboard** (utilidad, kilos, bultos, cantidad de envíos, ticket
  promedio, mix de couriers, país más activo, top de clientes y pendientes de liquidar),
  **perfil del cliente** (utilidad total y el gráfico por mes; la guía se sigue mostrando,
  apagada), y el **TOTAL del Excel de cierre de mes**.
- **No se puede liquidar:** no aparece en la lista de pendientes, y si alguien forzara el
  id contra el preview, se rechaza. Facturarle a un cliente un envío que no salió es el
  error caro que esto viene a evitar.
- El panel de salud deja de reclamarlo por "envío de mes cerrado sin precio de venta": no
  tenerlo es a propósito, no un olvido.

**Lo que NO pasa:** no se borra un solo número, no cambia el número de salida, y la fila
no desaparece de Salidas.

**Un envío ya liquidado no se puede marcar** (409, con el motivo): ya se le facturó al
cliente. Primero hay que sacarlo de la liquidación.

---

## El Excel del cierre de mes

La fila sale **con sus valores a la vista**, pintada, en bordó y bastardilla, con la
leyenda `NO VOLO` en la columna Estado — y **fuera de la fila de TOTAL**. El encabezado
dice cuántos hay: *"12 envío(s) — 1 marcado(s) NO VOLO, en rojo, que NO suman en el total"*.

Se eligió dejar los números a la vista (y no en blanco como hacía la planilla) porque el
cierre es la última capa de respaldo: si algún día no queda nada más, ese archivo tiene que
tener lo que estaba cargado. Lo que importa para la estadística es que **el total no los
sume**, y eso se cumple. Si la oficina prefiere verlos en blanco, es un cambio de diez
minutos (deuda 34 de `PENDIENTES.md`).

---

## Lo que se tocó

**Base:** `envios.no_volo` (0/1), `no_volo_usuario`, `no_volo_en`. Migración idempotente en
`db/index.js` + `schema.sql` (`check-schema` en verde). Ningún envío existente cambia.

**Backend:** `PATCH /api/salidas/:id/no-volo` con `{ no_volo: 0|1 }` ·
`routes/dashboard.js` (las 7 consultas) · `controllers/clientes.controller.js` ·
`models/envio.model.js` (pendientes por cliente) · `models/liquidacion.model.js` (preview)
· `services/cierre.service.js` · `services/salud.service.js` (chequeo 9).

**Frontend:** `js/api.js` · `js/modules/salidas.js` (botón, aviso, fila pintada, chapa de
estado, y que las alertas de plata no salten en un envío que no salió) ·
`js/modules/clientes-perfil.js` · `css/modules/salidas.css` · `css/main.css`.

**Cache busting: `?v=20260824c` → `?v=20260825`** en las 17 páginas. La oficina necesita
**Ctrl+F5** después del despliegue.

---

## Pruebas

- **`npm run test-no-volo`** — 38 controles de API + 16 en navegador. Cubren, en orden de
  riesgo: que el número de salida no se mueva ni corra a los de atrás, que el dashboard
  baje exactamente los kilos y la cantidad del envío marcado, que no se pueda liquidar por
  ninguna de las dos puertas, que un liquidado no se pueda marcar, que desmarcar devuelva
  los números **idénticos** a los de antes, y que el Excel lo muestre sin sumarlo.
- **`npm run verificar` completo: 44 tandas · 1209 controles · 0 fallas.** En el contenedor
  (5,8 min) **y en la máquina de Felipe (7,2 min)**. Antes eran 42 tandas y 1155 controles.
- `md5sum` de los 34 archivos coincide entre el contenedor y la máquina de Felipe.
- CRLF de `frontend/css/main.css` restaurado antes de entregar.

---

## Lo que quedó afuera (por si alguna vez molesta)

- **Un motivo escrito.** Felipe dijo *"por motivos que desconozco"*, así que no se inventó
  un campo. Si algún día se quiere saber por qué no voló, hoy va en Observaciones.
- **Un filtro propio "no voló"** en la barra: no hace falta, el filtro de la columna Estado
  ya lo trae.
- **Aviso al cargar una liquidación** de que ese cliente tiene envíos marcados. Hoy
  simplemente no aparecen.
