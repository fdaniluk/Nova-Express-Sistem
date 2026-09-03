# Manual — Control de Facturas y la doble vista del profit

**Escrito el 31/08/2026, corregido por Felipe el 01/09.** A pedido suyo: *"empezar a dejar
manuales de las cosas que vamos dejando terminadas, para que la oficina y yo sepamos en
todo momento cómo funcionan y no andemos inventando"*. Este es el primero.

**El entregable para la oficina es VISUAL**: `C:\dev\manual-control-facturas.docx`, 3
páginas, con capturas REALES del sistema y globitos numerados apuntando a cada cosa
(estilo manual de auto — pedido explícito de Felipe: *"la fotito del tablero y flecha
uno, te explico esto"*). Cómo se generan las capturas: §7.

---

## 1. Qué hace el módulo

Cruza **lo que nosotros cotizamos y cobramos** con **lo que UPS realmente facturó**, guía
por guía, y le avisa a la oficina cuando los números no cierran. Es la red de seguridad de
la plata: sin esto, un re-pesaje de UPS o un recargo inesperado no se descubre nunca.

## 2. EL CIRCUITO REAL DE UN ENVÍO (corregido por Felipe el 01/09)

⚠️ **La primera versión de este manual tenía el circuito mal** (decía que el precio se
cargaba al cotizar, en un paso aparte). Felipe corrigió: **el precio de venta se carga en
la MISMA carga del envío, y sale del cotizador automático del cliente.**

1. **Llega el envío a la oficina**: se pesa, se mide y se carga en el sistema.
2. **En esa misma carga se pone el PRECIO DE VENTA**, calculado por el sistema con la
   tarifa cargada de ese cliente (matriz de profit o precio por kilo). Por eso se están
   completando al detalle las matrices de los clientes: de ahí sale este número.
3. Queda congelado también el **costo estimado** (flete, seguro, fuel, adicionales).
4. **Se liquida al cliente.** Según el cliente, esto pasa ANTES o DESPUÉS de que llegue la
   factura de UPS. La liquidación congela venta y utilidad del momento; nunca recotiza.
5. **A principio de mes llega la factura de UPS** y se carga. El sistema cruza cada guía y
   guarda `costo_facturado`, `peso_facturado`, `courier_facturado`, `fecha_facturado`, y
   deja la guía en `pendiente` (o `a_revisar` si el margen contra el costo real quedó bajo
   el umbral). **El cruce NO toca ningún número nuestro.**
6. **Revisión humana**: ✓ aprobar / ✗ reclamar. El tilde nunca se pone solo.

**La intención del negocio:** que el precio de venta cargado en el paso 2 **se mantenga**,
y que solo se revise si la factura de UPS trae una diferencia grande.

## 3. Cadencia: es MENSUAL, no semanal (corregido 01/09)

- Las facturas de UPS llegan **entre el 1 y el 5 de cada mes**.
- Hoy toda la conciliación termina **alrededor del 10**. Reducir ese tiempo es para lo que
  se hizo este módulo (carga múltiple + cruce automático son los dos pasos que antes se
  hacían de a uno).

## 4. La doble vista del profit (cambio del 31/08)

**El problema que reportó la oficina:** la columna Profit "se sobrescribía". Lo que pasaba
de verdad: mostraba UN solo número que cambiaba de fórmula al aprobar la revisión — hasta
el ✓ el estimado, después del ✓ el real — sin aviso. No se persistía nada (se deriva al
vuelo), pero visualmente "el número que yo había calculado desaparecía".

**Cómo es ahora:**

| Columna | Qué muestra | Cuándo |
|---|---|---|
| **Compra Total** | La estimación NUESTRA (desglose congelado) | Siempre, nunca cambia sola |
| **Profit / %** | Venta − Compra Total (estimado) | Siempre, nunca cambia sola |
| **Costo UPS** | Lo que UPS facturó | Desde que se cruza la factura |
| **Dif Costo** | Costo UPS vs Compra Total (estimada), con semáforo de tolerancia | Ídem |
| **Profit Real** ← NUEVA | **Venta − Costo UPS** (% real en el tooltip) | Desde que se cruza la factura, SIN esperar el tilde; el tooltip avisa si aún no está aprobada |
| **Peso UPS / Dif Peso** | Kilos facturados vs cargados | Ídem |
| **Revisión** | pendiente / ✓ / ✗ / sin factura | — |

La venta que usa Profit Real es la congelada de la liquidación si existe (`venta_liq`), si
no `total_cobrado` — igual que el Dashboard.

## 5. ¿Cuál profit "viaja"? (la pregunta de Felipe)

- **A la liquidación**: el congelado al momento de liquidar.
- **Al Dashboard**: **real si la revisión está aprobada (✓)** → si no, el congelado de la
  liquidación → si no, el estimado. Es `deriveProfit()` (utils/profit.js), única fuente.
- **En Salidas**, desde el 31/08: se ven LOS DOS, no elige.

Aprobar la revisión (✓) es lo que le dice al Dashboard "la verdad de este envío es el
costo real". Por eso el tilde es humano.

## 6. Detalles técnicos

- `utils/profit.js` → `profitDoble(row)`: `compra_estimada`, `profit_estimado`,
  `porcentaje_estimado` (deriveProfit con la rama real enmascarada) + `profit_real_monto`,
  `porcentaje_real`. `deriveProfit` NO se tocó.
- `salidas.routes.js` → listarSalidas esparce `profitDoble(row)` junto a `deriveProfit`.
- `salidas.js` → `profitCell`/`pctCell` muestran el estimado; `profitRealCellHtml` la
  columna nueva; `difEval` del costo compara contra `compra_estimada` (antes, con revisión
  aprobada, `compra_total` pasaba a ser el costo real y la Dif quedaba en 0% sola); tras
  editar un envío el modal refresca también los campos `*_estimado`.
- La tabla pasó de 37 a **38 columnas**: `GRID_MAX_COL=37`, `UPS_COL_END=35` (bloque UPS =
  6 columnas), `emptyColspan` 38, `detailContentColspan` 19.
- El Excel del cierre NO cambió.
- Tests: `test-pantalla-venta-salidas` sección 9 (42 → **49 controles**).
- Pendiente relacionado sin tocar: **A4** del listado completo ("el frontend pisa el profit
  real con el estimado en envíos conciliados y lo persiste") — revisar si sigue vigente.

## 7. Cómo se generan las capturas del manual (para repetirlo en otros módulos)

El script vive en el contenedor en `/root/manual/_shots.js` (NO va al repo: es
herramienta de laboratorio). Qué hace:

1. `prepararDb` + `spawn` del server en el puerto 3981 con base propia, `abrirSesion`.
2. Carga por API un cliente y 3 envíos de ejemplo; por SQL les pone `costo_facturado`,
   `peso_facturado`, `estado_revision` y `tracking_estado` para que las pantallas muestren
   los tres casos (sin factura / cruzada pendiente / aprobada).
3. Playwright con `deviceScaleFactor: 2` (las capturas tienen que verse nítidas impresas).
4. **Globitos numerados**: `badge()` los ancla al `getBoundingClientRect()` de un elemento
   real, y `badgeCol()` los pone en una franja ARRIBA de la cabecera de la tabla, centrados
   sobre cada columna (esconder `#month-tabs` libera esa franja). Anclarlos a elementos
   reales es lo que evita que apunten a cualquier lado cuando cambia el layout.
   Sobre celdas de importes, los globitos entran por la IZQUIERDA (los números van
   alineados a la derecha, así no tapan nada).
5. Recortes con `clip` en coordenadas CSS, sin la barra lateral.

El documento se arma con `docx` (`/root/manual/build2.js`): `ImageRun` a 690 px de ancho
(el útil de una hoja Letter con márgenes de 900 twips), altura proporcional calculada de
las dimensiones reales del PNG. ⚠️ **Los `PageBreak` sueltos dejan hojas en blanco**: usar
`pageBreakBefore: true` en el título de sección.

Lo que se probó y NO conviene: texto de referencia sin foto (no lo lee nadie), globitos
sobre la cabecera (tapan el nombre de la columna), capturas de la tabla entera para
mostrar un detalle chico (los puntitos quedan ilegibles en papel — recortar).

## 8. Alcance de este manual

Solo el módulo de facturas. **El semáforo de tracking, los filtros por columna y el botón
Limpiar filtros se sacaron de acá** (decisión de Felipe, 01/09): van al **manual de
Salidas**, que es el próximo a armar.
