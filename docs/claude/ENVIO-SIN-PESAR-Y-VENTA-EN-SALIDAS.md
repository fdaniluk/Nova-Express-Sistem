# Envío sin pesar y cálculo de venta desde Salidas (04-08-2026)

Pedido de Felipe por audio, el circuito de **Kasdorf y los clientes parecidos**:

> *"Sus envíos no pasan por nuestra oficina. Les enviamos la guía, ellos la imprimen, la pegan
> y se termina… hoy lunes se cargan los envíos, el jueves tengo los pesos y medidas, entonces
> cargo desde salidas los pesos y medidas, y que en base a eso, con su profit ya cargado, me
> calcule lo que tengo que cobrarle. Hoy me calcularía la compra nuestra, pero yo quiero que
> haga algo más y me dé la venta también."*

## Lo que se midió antes de tocar nada

Probado contra una copia de la base:

| | Antes |
|---|---|
| Alta sin pesos ni medidas | ❌ `peso_real` era obligatorio (400) |
| Costo del envío sin pesar | ⚠️ **inventaba USD 21,90** — el flete mínimo de tabla (renglón de 0,5 kg) |
| Cargar los pesos después | ✅ ya recalculaba el costo bien (21,90 → 73,67) |
| Calcular la venta con el profit | ❌ no existía en Salidas: el total se escribía a mano |

El cálculo de venta existía **solo** en la pantalla de Cargar envío.

## Lo que quedó

### 1. Envío sin pesar

`peso_real` dejó de ser obligatorio en el alta. Sin peso, el sistema **no inventa costo**:
flete, seguro, fuel, adicionales y el desglose de extras quedan **vacíos** hasta que se pese.
Antes esa plata inventada se sumaba en Salidas, el dashboard y la utilidad durante los días
que el envío estaba sin pesar.

**El marcador es `peso_facturable = 0`.** No se agregó columna: `peso_real` es `NOT NULL` en
la base y cambiarlo obligaría a reconstruir la tabla `envios` entera — mucho riesgo para lo
que aporta. Un envío real no puede pesar cero, así que 0 es un marcador seguro.

En la grilla de Salidas esos envíos muestran un chip **"sin pesar"** en la columna de peso
facturable, con la fila en ámbar suave, para que no se lean como "peso cero".

Si a un envío ya pesado le sacan los pesos, el costo **se vacía** en vez de quedarse con el
número viejo.

### 2. Botón "Calcular venta" en el modal de Salidas

Al lado de *Recalcular* (que ya traía el costo). Decisiones de Felipe:

- **Con botón, no automático.** El sistema nunca pisa plata solo.
- **Si el envío ya tiene venta cargada**, muestra las dos cifras y la diferencia, el botón
  pasa a decir *"Reemplazar por el sugerido"* y hay un *"Dejar como está"*. Es la lección del
  caso Asaplast (ver `claude/IDEAS-COTIZACIONES-Y-BOT.md`).

El panel muestra servicio y zona, el costo con el fuel aplicado (y avisa si es el fuel propio
del cliente), cómo se armó el margen (*Profit 75% · celda de la matriz*, o el precio por kilo
si el cliente está en ese modo) y el precio sugerido.

Si el peso facturable todavía no está calculado, **corre el recálculo solo** antes de cotizar.

**Motor único, respetado:** usa `POST /liquidaciones/cotizar` con `profitManual:false`, el
mismo endpoint y el mismo `resolverTarifaVenta` que Cargar envío. Respeta la matriz de profit,
la tarifa por kilo y el fuel propio sin duplicar una sola regla.

### 2 bis. Recalcular ≠ Calcular venta — y el caso inverso, verificado

Pregunta de Felipe el 04/08: hay **envíos ya cargados con peso y medidas pero sin venta**,
porque cuando se cargaron todavía no existía la matriz de tarifas del cliente. ¿"Recalcular"
les pone el precio?

**No, son dos botones distintos, y está probado:**

| Botón | Toca | No toca |
|---|---|---|
| **Recalcular** | costo (flete, seguro, fuel, adicionales) y los pesos | **nunca el total cobrado** |
| **Calcular venta** | el precio de venta con el profit del cliente | el costo queda como está |

Para esos envíos viejos se aprieta **Calcular venta directamente**: como el peso facturable ya
está, cotiza sin necesidad de recalcular antes. Verificado con un envío de 8 kg cargado con el
cliente en 0%, cargándole después el 85% en la banda 5-10 kg: el botón tomó el 85% nuevo,
costo 58,74 → venta 115,17. Como la venta estaba en cero, no aparece el aviso de reemplazo.

**Ojo con esto:** usa el profit que el cliente tiene cargado **hoy**, no el que tenía el día
del envío. Para completar los que quedaron sin precio es justo lo que se busca, pero es un
efecto a tener presente. El costo, en cambio, sigue congelado con el fuel del día del envío.

**Felipe decidió el 04/08 hacerlos a mano**, uno por uno. Se le ofreció un filtro
"sin venta cargada" en Salidas (y opcionalmente un cálculo masivo con revisión previa) y dijo
que no hace falta. Si más adelante aparecen muchos, la herramienta está pensada y sin empezar.

### 3. Bug encontrado de paso — el recálculo perdía el peso

`POST /salidas/:id/recalcular` tomaba el peso **solo del body**. Un recálculo que cambiaba
únicamente el DDP o el país llegaba sin peso y devolvía cualquier cosa. Lo tapaba el mismo
mínimo de tabla que se sacó arriba, así que al sacarlo apareció (lo cazó `test-ddp-salidas`).

Ahora peso, medidas y bultos salen **del modal si vinieron, del envío si no** — el mismo
criterio que el archivo ya usaba para `remota`, `ddp`, `entrega` y `tipo_paquete`. Se
distingue `undefined` ("no lo mandaron") de `null` ("lo borraron a propósito").

Además, un envío sin pesar ya no devuelve 422 con un mensaje de país equivocado: devuelve el
desglose vacío con `sin_pesar: true`.

## Archivos tocados (23)

`backend/src/controllers/envios.controller.js` · `backend/src/models/envio.model.js` ·
`backend/src/routes/salidas.routes.js` · `backend/scripts/test-envio-sin-pesar.js` (nuevo) ·
`backend/package.json` · `frontend/js/modules/salidas.js` ·
`frontend/css/modules/salidas.css` · las 15 páginas + `cotizador_courier_v8.html`.

**Cache busting: `?v=20260804` → `?v=20260804b`.** Hubo dos entregas el mismo día y esta
cambia JS y CSS; sin el sufijo, un navegador que ya cargó la primera se quedaría con el
`salidas.js` viejo. **Sin commitear.**

## Pruebas

- **`npm run test-envio-sin-pesar`** — 28 controles: el alta sin peso, que no se invente
  costo, el recálculo al cargar los pesos, que la venta salga del profit del cliente, que
  respete tarifa por kilo y fuel propio, que sacar los pesos vacíe el costo, y que el alta
  normal con peso no haya cambiado. Agregado a `npm test`.
- **`npm test` completo: 359 controles, 0 fallas.** Antes de esta tanda eran 331.
- **Pantalla en navegador: 19 controles, 0 fallas** — el chip "sin pesar" en la grilla, el
  botón, el panel, aplicar el precio, el aviso al pisar una venta existente, "Dejar como está"
  y la persistencia en la base.
- **Caso inverso en navegador: 11 controles, 0 fallas** — que Recalcular no toque el total,
  que Calcular venta ande sin recalcular antes, y que tome el profit cargado después.
  *(Estos dos últimos no quedaron como script del repo; conviene sumarlos a los tests de
  pantalla si se vuelve a tocar Salidas.)*
- `md5sum` de los 23 archivos coincide entre el contenedor y la máquina de Felipe.
- CRLF de `envio.model.js` restaurado antes de entregar.

### Los dos tests en rojo de antes (L12) — verificado

`test-orden-pendientes` (3/2) y `test-aviso-guia` (8/4) fallan **igual antes y después** de
estos cambios: se corrieron sobre la copia prístina y dan exactamente los mismos errores.
Las fallas son *"hay grupos para revisar → 0"* y *"hay renglones de guías en pantalla → 0"*:
**dependen de que la base tenga datos**, y la base de prueba del contenedor está vacía.
En la máquina de Felipe, con la base real, podrían pasar. **Falta correrlos allá para saberlo.**

## Pendiente relacionado

El seguro de documentos DHL (USD 7,50, con tilde a pedido) sigue sin empezar — ver
`claude/SEGURO-POR-CLIENTE.md`.

Y quedó a la vista que `salidas.html` carga `xlsx` desde `cdn.jsdelivr.net`. En la red local
sin internet del depósito, la exportación a Excel de Salidas no funcionaría. No se tocó; vale
anotarlo.
