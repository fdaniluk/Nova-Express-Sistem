# Protección de Documentos de DHL — USD 7,50 (04-08-2026)

Pedido de Felipe por audio:

> *"También hay unos seguros para los documentos de DHL, que son siete dólares y piquito, que
> eso tampoco sale por defecto en las liquidaciones."*

## De dónde sale el número

Tarifario **DHL Express Argentina**, hoja *Servicios y cargos públicos* (página 13 del PDF
`TARIFARIO DHL EXPO MAS 50 KGS`):

| Nombre | Descripción | Mecanismo | Cargo neto | Aplica a |
|---|---|---|---|---|
| **PROTECCIÓN DE DOCUMENTOS** | *"Si va a enviar documentos valiosos, como pasaportes, solicitudes para visas o certificados legales, el servicio de Protección de Documentos de DHL le ofrece mayor tranquilidad y una compensación en caso de pérdida o daño."* | precio por envío | **7,50 USD** | Todos los productos |

Es **opcional** — el cliente lo pide. Por eso es una tilde y no algo automático.
**Decisión de Felipe (04/08): con una tilde, a pedido.**

En la misma hoja está la *Protección del Valor del Envío* internacional: **17,50 USD o 1,00%
del valor, el mayor**. Ese es otro cargo (el seguro de siempre) y no se tocó — ver la nota al
pie de `claude/SEGURO-POR-CLIENTE.md` sobre el 1,00% vs el 1,5% que cobra Nova.

## Cómo quedó

Una tilde en **las tres pantallas**: el cotizador, Cargar envío y el modal de Salidas.

- **Solo DHL.** En UPS no existe: la tilde se esconde y se destilda sola al cambiar de courier,
  para que no quede un tilde huérfano que el motor va a ignorar igual.
- **Pasa a costo, sin margen ni fuel**, igual que el DDP, el surge y el IPF. Es el criterio que
  fijó Felipe el 29/07: *"todo recargo del courier pasa al costo; la ganancia se calcula solo
  sobre el flete de tabla"*.
  Probado: con 100% de ganancia y 35,25% de fuel, el cliente paga **7,50**, no 20,29.
- Se guarda en el envío (`envios.proteccion_doc`), va al desglose congelado como
  *"Protección de documentos (DHL)"*, tipo canónico `proteccion_doc`, y de ahí **llega a la
  liquidación**, que es de donde Felipe dijo que faltaba.

El precio vive en **una sola constante** del motor, `DHL_PROTECCION_DOC` en
`shared/cotizador/cotizador-core.js`. Si DHL lo actualiza, se cambia ahí y queda cambiado en
las tres pantallas y en la liquidación.

## Lo que se tocó (27 archivos)

`shared/cotizador/cotizador-core.js` (constante + parámetro `proteccionDoc` + extra en la rama
DHL) · `backend/src/services/calculos.service.js` (pasa el parámetro y clasifica el label) ·
`backend/src/db/index.js` + `database/schema/schema.sql` (columna `proteccion_doc`) ·
`backend/src/models/envio.model.js` (guarda, aplica y recalcula) ·
`backend/src/routes/salidas.routes.js` (recálculo + campo editable + lo devuelve la grilla) ·
`backend/src/controllers/liquidaciones.controller.js` (endpoint `/cotizar`) ·
`frontend/pages/cotizador.html` · `frontend/pages/envios.html` +
`frontend/js/modules/envios.js` · `frontend/js/modules/salidas.js` ·
`backend/scripts/test-proteccion-doc.js` (nuevo) · las 15 páginas + `cotizador_courier_v8.html`.

**Cache busting: `?v=20260804b` → `?v=20260804c`.** Tercera entrega del día que toca JS.
**Sin commitear.**

## Pruebas

- **`npm run test-proteccion-doc`** — 22 controles: que sin la tilde no cambie nada, que sume
  7,50 exactos sin fuel ni margen, que en UPS no cobre, que se guarde en el envío y **sobreviva
  a una edición y al "Recalcular" de Salidas** (el bug clásico de esa pantalla: el primer
  recálculo borra el cargo en silencio, como ya había pasado con el DDP y con el área remota),
  que se pueda destildar, y que llegue a la liquidación sin inflar la utilidad. Agregado a
  `npm test`.
- **`npm test` completo: 381 controles, 0 fallas.** Antes de esta tanda del día eran 331.
- **Pantallas en navegador: 13 controles, 0 fallas** — la tilde en las tres, que se esconda con
  UPS y vuelva con DHL, que al tildar y recalcular los adicionales suban 7,50, que aparezca en
  el desglose y que quede guardado.
- `npm run check-schema`: **0 desvíos**.
- `md5sum` de los 27 archivos coincide entre el contenedor y la máquina de Felipe.
- CRLF restaurado en `cotizador-core.js`, `db/index.js`, `envio.model.js` y
  `liquidaciones.controller.js`.

## Cerrado con esto

Las tres cosas que Felipe pidió por audio el 04/08 quedaron hechas:

1. ~~Tarifa por kilo por zona~~ — ya funcionaba; el problema era que no había forma de saber
   que se hace clic en la celda (ver la respuesta del 04/08).
2. ~~Seguro por cliente (1% vs 1,5%)~~ — `claude/SEGURO-POR-CLIENTE.md`.
3. ~~Seguro de documentos DHL~~ — este documento.

Y de yapa, el circuito de los envíos sin pesar y el cálculo de venta desde Salidas —
`claude/ENVIO-SIN-PESAR-Y-VENTA-EN-SALIDAS.md`.

## Sigue pendiente

- **La pantalla de la tarifa por kilo**: no hay ningún cartel que diga que se hace clic en la
  celda para poner un precio distinto por zona, y desde la pantalla no se puede armar el caso
  mixto (una zona con precio fijo y otra con porcentaje) aunque el motor ya lo soporta.
  Felipe todavía no pidió arrancarlo.
- Los limitadores L1, L2, L3, L4, L5, L7, L9, L10, L11 y L12 siguen abiertos — ver
  `claude/ESTADO.md`.
