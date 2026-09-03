# Auditoría Sistema Nova — 27 de julio de 2026

Lectura completa del repo: 22.700 líneas, 105 archivos, backend + frontend + motor de cálculo + base de datos real (36 envíos, 31 pickups, 9 liquidaciones, 10 clientes).

**Alcance:** el repo, que es lo que está deployado. No se accedió al VPS andando.
**Método:** cinco auditorías en paralelo (pricing, backend, frontend, base de datos, automatización). Todo lo marcado CONFIRMADO fue reproducido ejecutando el código real. Lo que no se pudo reproducir está marcado SOSPECHA.
**No se modificó ni un archivo del repo.**

---

## Lo primero: el sistema está mejor de lo que este informe sugiere

Un informe de auditoría es una lista de problemas, así que da una impresión falsa. Lo que se verificó y **está bien**:

- **No hay ni una fila huérfana en la base.** Se chequearon las 10 relaciones. `PRAGMA foreign_key_check` limpio. Las 9 liquidaciones cuadran al centavo con la suma de sus ítems.
- **No hay ningún endpoint sin autenticación.** Se recorrieron las 15 rutas una por una.
- **No hay SQL injection.** Se revisaron las 14 interpolaciones dentro de SQL: todas seguras.
- **No hay secretos hardcodeados** en el código.
- **Las contraseñas usan bcrypt** correctamente.
- **No hay cascadas de borrado peligrosas** en el esquema.
- **Los cortes del seguro UPS son correctos** (probados en los bordes 99,99 / 100 / 1000 / 1000,01).
- **La matriz de profit no tiene huecos ni solapamientos** entre bandas de peso, y la precedencia está implementada en el orden correcto.
- **Liquidaciones y Salidas dan el mismo número al centavo** — comparten el motor de verdad.

Los problemas de abajo son reales, pero son de un sistema que funciona, no de uno roto.

---

# PARTE 1 — Lo que hay que arreglar

## 🔴 CRÍTICO

### 1. Dos personas escribiendo al mismo tiempo pueden borrarse el trabajo entre sí

`backend/src/db/index.js:53-65` · **CONFIRMADO y reproducido por dos auditorías independientes**

Toda la aplicación corre sobre **una sola conexión a SQLite**. La función `transaction()` hace `BEGIN TRANSACTION` sobre esa conexión compartida, sin ninguna cola ni bloqueo. Como los handlers son asincrónicos, los statements de dos operaciones simultáneas se **intercalan dentro de la misma transacción**.

Reproducción real, con el mismo patrón exacto del código:

```
A (liquidación): OK
B (envío):       ERROR  "cannot start a transaction within a transaction"
FILAS PERSISTIDAS: solo la liquidación   ← el envío de B nunca se guardó
```

Y en otra corrida, con distinto timing, peor todavía: el `ROLLBACK` del que perdió abortó la transacción del que ganó y **se perdieron las dos operaciones**.

**Escenario del día a día:** se importa un Excel de salidas (la importación abre **una sola transacción para el archivo entero**, `excel.service.js:154` — puede durar minutos con 500 filas). Mientras tanto otro usuario guarda una edición en Salidas. Su `UPDATE` se ejecuta *dentro* de la transacción de la importación. Recibe `200 OK`. Si la importación falla y hace `ROLLBACK`, **su edición desaparece y nadie se entera**.

Afecta a las 9 operaciones que usan transacciones: crear y confirmar liquidaciones, alta y edición de envíos, PATCH y DELETE de salidas, configuración, carga de facturas e importación de Excel. O sea: todo lo que toca plata.

Hoy la base está consistente porque son 3 usuarios y 36 envíos. **El mecanismo está armado; es cuestión de concurrencia.**

**Arreglo:** serializar `transaction()` con una cola de promesas en `db/index.js`. Es el hallazgo con mejor relación impacto/esfuerzo de todo el informe.

---

## 🟠 ALTO — Plata que hoy se está contando mal

### 2. Editar un envío desde "Envíos" deja el costo viejo congelado

`backend/src/models/envio.model.js:242-274` · **CONFIRMADO**

El `UPDATE` actualiza peso, medidas y total cobrado, pero **no recalcula `flete`, `seguro`, `fuel`, `adicionales` ni `extras_json`** (a diferencia del alta, que sí llama a `calcularDesgloseAlCosto`). Tampoco persiste `ddp`, `remota`, `asegurado` ni `tipo_paquete`, aunque el formulario los manda.

**Caso concreto** — envío DHL a España cargado con 5 kg y después corregido a 25 kg:

| | Flete | Fuel | Adic. | Total |
|---|---|---|---|---|
| Costo que queda en la base | 79,81 | 31,52 | 4,90 | **116,23** |
| Costo real a 25 kg | 201,90 | 79,75 | 24,50 | **306,15** |

El dashboard y Salidas informan **USD 189,92 de utilidad que no existe**. Salidas tiene un aviso de desfase; la pantalla de Envíos no.

### 3. "Recalcular" en Salidas borra el cargo DDP en silencio

`backend/src/routes/salidas.routes.js:353-371` · **CONFIRMADO**

El objeto que se le pasa al recálculo incluye `remota` (lo arreglaron en su momento) pero **omite `ddp`**.

**Caso concreto** — UPS Expedited a EE.UU., 5 kg, FOB 500, DDP tildado: antes de recalcular el total de costo es 111,29; después de apretar "Recalcular" queda en 87,24. **USD 24,05 de costo desaparecen** y la utilidad del envío queda inflada en ese monto.

### 4. El cotizador y el sistema cobran distinto el sobrepeso de DHL

`shared/cotizador/cotizador-core.js:158` vs `backend/src/services/calculos.service.js:131-136` · **CONFIRMADO**

El motor dispara el recargo de sobrepeso si `peso real > 70` **o** `peso facturable > 70`. Pero la función que arma los bultos en el backend (`mkBultosProc`) devuelve solo `{dims, pr}` — **nunca incluye el peso facturable**. El cotizador sí lo manda.

Resultado: un bulto pesado por volumen dispara sobrepeso en una pantalla y no en la otra.

**Caso concreto** — DHL a España, 1 bulto de 60 kg reales, 120×80×60 cm (115 kg volumétricos):

| | Recargo | Total |
|---|---|---|
| Cotizador | 125 | **USD 1.376,11** |
| Costo congelado del envío | 23 | **USD 1.274,11** |

**USD 102 de diferencia** por bulto, en el mismo envío.

### 5. Los documentos DHL se cotizan con una tarifa y se costean con otra

`shared/cotizador/cotizador-core.js:220` vs `calculos.service.js:147-159` · **CONFIRMADO**

El motor soporta tarifa de documento (hasta 2 kg, solo DHL) y el cotizador la usa. Pero ni `cotizarEnvio` ni `desglosarCosto` **pasan el tipo de contenido nunca** → el backend siempre cotiza como paquete. El campo existe y se guarda (`envios.tipo_paquete = 'd'`).

**Caso concreto** — documento DHL de 1 kg a España: el cotizador da **USD 44,80**, el alta de envío da **USD 59,47**. **33% de diferencia.** Según por qué pantalla se cotice, o el envío entra mostrando pérdida, o se le cobra 33% de más al cliente.

### 6. El extracargo de contorno mayor a 400 cm no se cobra

`shared/cotizador/cotizador-core.js:176-177` · **CONFIRMADO**

```js
if(contorno>400){contornoWarn=true;}      // ← solo levanta una bandera
else if(contorno>300){contornoExtra+=120;}
```

El tramo más grande **no cobra los $120**. Un bulto de 150×70×70 (contorno 430) entra con USD 120 de costo menos que uno de 130×60×55 (contorno 360). Además la bandera de advertencia no se propaga a ningún lado en el alta del envío.

### 7. Salidas pisa el profit real con el estimado

`frontend/js/modules/salidas.js:2035-2048` y `:2288` · **CONFIRMADO**

El backend calcula el profit de dos formas: contra el **costo real facturado** si el envío ya fue aprobado contra la factura de UPS, o contra el **estimado** si todavía no. El frontend implementa **solo la rama estimada**, y el comentario dice "igual que el backend" — dejó de ser cierto cuando se agregó la rama de factura real.

**Efecto:** en un envío ya conciliado con UPS, tocar cualquier campo de costo en el modal reemplaza el profit real por el estimado. La columna "Dif Costo %" deja de dar 0,0% y **puede pintarse en rojo sola**, señalando un desvío contra el courier que no existe. Se normaliza recién al recargar la página. Peor: el valor estimado **se persiste** en la base.

---

## 🟠 ALTO — Riesgo de perder datos

### 8. Cualquier empleado puede borrar un envío liquidado y con él la liquidación entera

`backend/src/routes/salidas.routes.js:709-753` · **CONFIRMADO**

El endpoint no exige rol de administrador. Por diseño explícito: resta el aporte del envío al total de la liquidación, borra el ítem, borra el envío y — si la liquidación quedó vacía — **borra la liquidación completa**, esté en borrador o confirmada.

**Escenario:** alguien borra el envío equivocado en la grilla. Si era el único de una liquidación ya confirmada y enviada al cliente, **el documento de cobro desaparece de la base**. No hay auditoría, no hay papelera, no hay confirmación del servidor. El único respaldo es el backup diario: se puede perder hasta un día de trabajo.

### 9. Puerta trasera que saltea el bloqueo de envíos liquidados

`backend/src/models/envio.model.js:225` · **CONFIRMADO**

Salidas implementa un freno explícito: en un envío liquidado no se puede cambiar cliente ni fecha, porque descuadraría una liquidación confirmada. Ese freno se saltea mandando `forzar: true` en el body de `PUT /api/envios/:id`.

`forzar` **no lo usa ningún archivo del frontend** — se buscó en todo el repo. Es una puerta trasera sin dueño. Queda un ítem de liquidación confirmada del cliente A apuntando a un envío que ahora es del cliente B.

### 10. Los backups viven en el mismo disco que la base

`backend/src/services/backup.service.js:6` · **CONFIRMADO**

Los 30 backups están en `database/backups/`, o sea **el mismo directorio, el mismo disco y la misma carpeta de OneDrive que `nova.db`**. Un fallo de disco, un borrado accidental o un VPS que se pierde se lleva la base y las 30 copias juntas. No hay ninguna copia fuera de la máquina.

Tres problemas más del mismo módulo:

- **Los errores se tragan en silencio.** Un backup que dejó de funcionar hace dos meses se descubre el día que hay que restaurar.
- **Rotación por conteo, no por antigüedad.** Si el servidor se reinicia 30 veces en un día, el historial entero se reemplaza por 30 copias del mismo día. Un dato corrompido el lunes y detectado el jueves ya no tiene backup previo.
- **Si el disco se llena**, el fallback deja un archivo truncado que la rotación cuenta como backup válido y **empuja fuera al bueno más viejo**.

### 11. El WAL de SQLite adentro de OneDrive

**CONFIRMADO** (hallazgo previo, se mantiene)

| Archivo | Tamaño | Última modificación |
|---|---|---|
| `nova.db` | 188 KB | **6-jul** |
| `nova.db-wal` | **1,15 MB** | 23-jul |

Tres semanas de operación viviendo en el archivo temporal, seis veces más grande que la base, con OneDrive subiendo los dos por separado. Si los sube en momentos distintos, o si alguien restaura solo el `.db`, se pierden esas tres semanas.

---

## 🟠 ALTO — El parser de facturas UPS

**Contexto importante: las tablas de facturas están vacías. El módulo todavía no se estrenó. Es el momento más barato posible para arreglar esto.**

### 12. Si UPS cambia una columna, se cargan USD 0,00 en todos los envíos sin ningún aviso

`backend/src/services/factura-ups.service.js:65-78` · **CONFIRMADO y reproducido**

El parser exige que las 4 columnas de importe vengan en **una sola línea con exactamente 4 números**. Si el regex falla, la máquina de estados nunca avanza y se pierde el neto **y todos los cargos**. El neto queda en `null` y se degrada a `0` en silencio.

Simulando el cambio más plausible — que UPS deje de imprimir una de las dos columnas de descuento:

| | Guías detectadas | Suma total |
|---|---|---|
| PDF actual | 10 | **USD 3.068,33** |
| Con 3 columnas | 10 | **USD 0,00** |

El endpoint devuelve **200 OK con "10 guías, 10 guardadas"**. Y el remate: la comparación de margen solo corre `if (costo_facturado > 0)`. Como el costo es cero, **no se ejecuta**, y las 10 guías quedan como "pendiente" en vez de ir a la bandeja de problemas. Diez envíos con costo cero y ni una alerta.

Variante confirmada: una guía que no arranque con `1Z` **desaparece por completo** — no se cuenta, no se lista, no queda en ningún lado. Probado: USD 265,49 evaporados sin rastro.

### 13. Una guía re-facturada por UPS se descarta en silencio

`factura-ups.service.js:91-97` · **CONFIRMADO y reproducido**

El código deduplica por número de guía asumiendo que un repetido es siempre un artefacto de paginado del PDF. Pero UPS re-factura legítimamente: correcciones de peso, reintentos de entrega, cargos tardíos.

Se agregó una segunda línea de facturación de USD 159,99 para una guía existente. Resultado: **los 159,99 desaparecen.** Sin warning, sin contador, sin quedar registrados.

Y como el criterio es "gana la primera", si la primera aparición es una guía partida entre dos páginas, se conserva la parcial y se descarta la completa.

### 14. El parser no cuadra con la propia factura: USD 91,22 de diferencia en el PDF de ejemplo

`factura-ups.service.js:99-116` · **CONFIRMADO con la factura real del repo**

```
SUMA DEL PARSER = 3.068,33   |   TOTAL DECLARADO EN LA FACTURA = 3.159,55   |   diferencia = 91,22 (2,97%)
```

Lo que falta es la **Percepción de Ingresos Brutos** del pie de la factura, que UPS efectivamente cobra. El sistema guarda el subtotal de flete, no lo que UPS factura → **el margen sale inflado ~3% en toda guía UPS**, y envíos por debajo del umbral de ganancia mínima no se marcan para revisar.

Detalle notable: el script `backend/scripts/diagnostico_factura.js:150` **tiene** esa validación y sobre este mismo PDF imprimiría la advertencia. El servicio de producción no la heredó.

### 15. La función que lee los números rompe 100× si UPS cambia el formato

`factura-ups.service.js:5-19` · **CONFIRMADO**

| Entrada | Devuelve | Correcto |
|---|---|---|
| `"1,292,50"` | 1292,50 ✓ | 1292,50 |
| `"120.10"` | **12010** ✗ | 120,10 |
| `"1,292.50"` | **1.292** ✗ | 1292,50 |
| `"abc"` | **0** sin error | — |

No es hipotético: **este mismo PDF ya mezcla formatos** — el peso viene con punto decimal (`26.00Kg`) y la plata con coma. Si UPS unifica el formato, un recargo de `120.10` entra como **USD 12.010**, o un neto de `1,292.50` entra como **1,29** y el envío se aprueba solo.

### 16. La misma factura se puede cargar dos veces y duplicar el ledger

`facturas.routes.js:152-180` · **CONFIRMADO**

`facturas_cargadas` **no tiene UNIQUE en `numero_factura`**. El bucle que inserta el detalle lo hace **incondicionalmente**, incluso para guías contadas como duplicadas. El único freno protege la tabla de envíos, no el detalle, y es race-able.

Si alguien sube la factura, no ve el resultado y la vuelve a subir: 2 cabeceras y **20 filas de detalle para 10 guías**. Cualquier reporte futuro de "cuánto nos facturó UPS este mes" cuenta doble.

### 17. Los errores por guía se tragan y se reporta éxito

`facturas.routes.js:145-149` · **CONFIRMADO**

La guía que falla no se cuenta en ningún contador del resumen. El operador ve "120 guías, 118 guardadas" y no tiene forma de saber cuáles dos se perdieron. Peor: esas guías **sí** quedan insertadas en el detalle, así que el ledger dice que se procesaron pero el envío quedó sin costo real y sigue calculando utilidad con la estimación.

---

## 🟡 MEDIO

### 18. Cache busting: el CSS principal está desincronizado y el guardián de sesión no se puede actualizar

**CONFIRMADO** — este es el bug de "se ve distinto / código viejo".

- **`main.css`**: `index.html` pide `?v=5`, **las 13 páginas piden `?v=4`**. Son dos entradas de caché distintas. Un navegador que cacheó la v4 antes del último cambio sigue sirviendo el CSS viejo en todas las pantallas internas, mientras el dashboard se ve bien.
- **`auth-guard.js` no tiene versión en ninguna de las 14 páginas.** Es el archivo que decide si la sesión sigue viva. Cambió el 20 de julio; cualquier navegador que lo tenga cacheado de antes corre la versión previa hasta un Ctrl+F5.
- Sin versionar tampoco: `clientes.js`, `usuarios.js`, `login.js` y tres CSS de módulo. `usuarios.js` y `clientes.js` son las dos pantallas donde la queja de "código viejo" es reproducible.

**Recomendación:** una sola versión global aplicada a todos los scripts y estilos de todas las páginas, en vez de 11 contadores independientes. Con 14 archivos HTML, el olvido es estadísticamente inevitable.

### 19. "Hoy" se calcula en UTC: después de las 21:00 el sistema cree que es mañana

**CONFIRMADO** — Buenos Aires es UTC−3. La misma operación está resuelta de dos formas incompatibles en el repo.

Correctas (hora local): `pickups.js`, `operaciones.js`, `cobranzas.js`.
Incorrectas (UTC): `envios.js:11` y `:481`, `liquidaciones.js:24`, `salidas.js:766`, `liquidacion.model.js:241` y `:262`, `facturas.routes.js:75`, `dashboard.js:10`.

**De 21:00 a 24:00, todos los días:**

- un envío cargado se guarda **con la fecha del día siguiente** → cae en el mes equivocado si es fin de mes, y puede quedar fuera del período de la liquidación;
- el semáforo de antigüedad de Salidas cuenta un día de más y **se pone rojo un día antes** de lo que corresponde;
- una liquidación confirmada el 31/05 a las 22:00 queda fechada **01/06**.

Para un courier que opera de tarde, esto pasa a diario.

### 20. El fuel del cotizador no sale de la base

**CONFIRMADO** — contradice la regla "el fuel se lee siempre de la BD, nunca hardcodeado".

- `frontend/pages/cotizador.html:218` — el campo de fuel **no tiene valor por defecto ni ninguna llamada a la configuración**. El operador tipea el porcentaje de memoria en cada cotización.
- `frontend/js/modules/envios.js:4` — arranca en `{ DHL: 39, UPS: 39 }`. Si la llamada a configuración falla, solo hay un `console.warn` y el envío se congela con **39** cuando la base dice **39,5**.
- `frontend/js/modules/liquidaciones.js:207` — campo con `value="39"` fijo, nunca sincronizado.

Si algún día el fuel sube a 45% y el operador sigue tipeando 39,5, **cada cotización sub-cotiza ~4% del flete**, sin techo.

### 21. Los campos de plata no se validan: se pueden blanquear en silencio

`backend/src/routes/salidas.routes.js:429-434` y `:554-561` · **CONFIRMADO**

De los 30 campos editables, solo se validan 5. `flete`, `seguro`, `fuel`, `total_cobrado`, `profit` y el resto entran tal cual al UPDATE.

**Escenario real** (formato de números argentino): si alguien tipea `1250,50` en el campo Flete — costumbre local, y el propio código reconoce el problema en otro lado —, `Number("1250,50")` da `NaN`, se convierte en `null`, y el backend escribe **flete = NULL** sin chistar. El envío queda con el flete borrado y **el profit salta hacia arriba de golpe** en Salidas y en el Dashboard. Nadie ve un error.

### 22. El semáforo de desvíos se apaga solo y en silencio

`frontend/js/modules/salidas.js:129-143` · **CONFIRMADO**

Si falla la carga de tolerancias, el código hace un `console.warn` y deja el objeto vacío. Con el objeto vacío, la evaluación de desvíos **siempre da falso** → **ningún desvío contra la factura del courier se pinta en rojo nunca**, y la pantalla se ve idéntica a "todo dentro de tolerancia". Es un control de costos que se apaga sin avisar.

### 23. Una zona inválida guarda el envío con costos en NULL, sin error

`frontend/pages/envios.html:170` + `cotizador-core.js:100-111` · **CONFIRMADO**

El campo de zona es texto libre sin validación. Con `zona=7` la tabla de UPS se indexa fuera de rango, todo el desglose sale `NaN`, y como la función **devuelve un objeto en vez de null**, se inserta igual: SQLite guarda los `NaN` como `NULL`. El envío queda con costo 0 y **aporta cero a la utilidad neta del dashboard** aunque se haya cobrado. (DHL sí devuelve null correctamente; el agujero es solo de UPS.)

### 24. El seguro DHL no sigue la regla declarada

`shared/cotizador/cotizador-core.js:144-150` · **CONFIRMADO**

Aplica `max(17,50 · 1,5%)` para **cualquier** FOB mayor a cero: FOB 50 → 17,50 (la regla dice 0), FOB 500 → 17,50 (la regla dice 15). Además el flag `asegurado` se guarda pero **no se consulta en ningún cálculo**.

**Puede ser el mínimo tarifario real de DHL y no un bug** — pero entonces la regla escrita está mal. Necesita tu confirmación.

### 25. Login sin límite de intentos

`backend/src/routes/auth.routes.js:25-58` · **CONFIRMADO**

No hay rate limiting en ninguna capa. La única defensa es el costo de bcrypt (~100 ms), que permite decenas de intentos por segundo contra un endpoint expuesto a internet. Los usuarios son nombres de pila y la política de contraseña es "mínimo 6 caracteres" sin requisitos.

### 26. Cookie de sesión sin `Secure` si el VPS no define `NODE_ENV`

`backend/src/routes/auth.routes.js:16` · **SOSPECHA — verificalo hoy, es un comando**

La cookie usa `secure: nodeEnv === 'production'`, y la configuración cae a `'development'` por defecto. El `.env` del repo **no define `NODE_ENV`**. Si el proceso del VPS no lo inyecta por systemd/pm2, la cookie de sesión — que da 30 días de acceso completo — **viaja sin el flag `Secure`**.

**Corré esto en el VPS:** `printenv NODE_ENV`. Si no devuelve `production`, esto pasa a CRÍTICO.

### 27. Consultas sin índice en las tablas que más crecen

**CONFIRMADO con `EXPLAIN QUERY PLAN` sobre la base real**

| Consulta | Plan actual | Falta |
|---|---|---|
| Búsqueda de guía en facturas (`UPPER(numero_guia)`) | escaneo completo | el `UPPER()` **anula el índice único que ya existe** |
| Pickups por fecha (la pantalla más usada) | escaneo completo | `idx_pickups_fecha` |
| Ítems de liquidación por envío | escaneo completo | `idx_liquidacion_items_envio` |
| Bandeja de revisión por estado | escaneo + orden temporal | `idx_envios_estado_revision` |

Con 36 envíos es gratis. Con 200 guías por factura y 50.000 envíos son ~20 millones de filas escaneadas por carga, con la conexión única bloqueada todo ese tiempo — lo que dispara directamente el problema #1 para todos los demás.

**Bug asociado:** el índice único de guía es **sensible a mayúsculas** pero la búsqueda es **insensible**. `1z327w...` y `1Z327W...` pasan el único sin problema, y después la consulta devuelve **una cualquiera de las dos** de forma no determinística → el costo de la factura se imputa al envío equivocado.

### 28. `cuadrantes.pickup_id` no tiene foreign key en producción

**CONFIRMADO** — se construyó una base fresca desde `schema.sql` y se comparó contra la real. Una sola divergencia, y es una FK.

Causa: la migración la agrega con `ALTER TABLE ADD COLUMN`, y SQLite no permite agregar FK así (el propio comentario del código lo admite). Quien lea `schema.sql` cree que la FK está; en producción no está. Hoy hay 2 filas y 0 huérfanos: el bug está latente.

### 29. Otros de menor peso

- **Formateo de moneda: 6 implementaciones distintas.** `pickups.js` y `cobranzas.js` tienen la **misma función con el mismo nombre** y configuración distinta: una cobranza de $150.000,50 se ve `$ 150.001` en Pickups y `$ 150.000,50` en Cobranzas.
- **Escapado de HTML: 6 implementaciones, y 7 módulos sin ninguna.** XSS almacenado posible vía nombre de cliente. Sistema interno ⇒ severidad baja, pero se arregla gratis con una función compartida.
- **El cotizador muestra un peso facturable distinto del que cobra.** El cartel redondea a 0,5 kg hacia arriba, el cálculo no. Un bulto de 40×30×20 con 3 kg muestra "Facturable: 5,0 kg" y cotiza con 4,8. **El cálculo es el correcto; el cartel es el que miente** — pero induce al vendedor a cotizar mal a mano.
- **Datos de plata desnormalizados.** Si se corrige el total cobrado de un envío ya liquidado desde Salidas, `liquidacion_items` y `liquidaciones.total` **no se actualizan**. La liquidación que se le mandó al cliente y la que muestra el sistema quedan desincronizadas sin ninguna alerta.
- **Código muerto que contradice al motor.** `calculos.service.js:44-58` y `liquidacion.model.js:38-60` implementan exactamente las fórmulas del enunciado, no coinciden con el motor real, y **no las llama nadie**. Es una trampa para quien las lea creyendo que son la fuente de verdad. Conviene borrarlas.
- **Sesiones vencidas nunca se purgan.** La función existe y **no se llama desde ningún lado**. Hay 6 de 7 sesiones vencidas todavía en la tabla.
- **Doble liquidación posible** por validación fuera de la transacción: dos requests simultáneos (o un doble clic en "Confirmar") pueden meter el mismo envío en dos liquidaciones. Nada en el esquema lo impide.
- **`salidas.js` tiene 2828 líneas** en un solo bloque con estado compartido. Es el archivo más grande del repo por lejos. Hay una propuesta de corte en 8 archivos, sin cambiar comportamiento, con orden de ejecución sugerido.

---

# PARTE 2 — Qué automatizar

Ordenado por lo que más tiempo ahorra con menos trabajo.

### 1. Las guías que UPS facturó y no están en el sistema se ven una vez y se pierden — CHICO

El backend **ya detecta y ya guarda** las guías que no matchean ningún envío (`factura_guias.encontrada = 0`). El frontend las dibuja en una tabla efímera que desaparece al cargar la siguiente factura o al recargar la página.

**No existe ninguna pantalla que consulte esas guías.** El dato está guardado y nadie lo lee nunca más.

Cada guía no encontrada es **un envío que UPS cobró y que casi seguro no se le facturó al cliente**. Hoy se ve una sola vez, en pantalla, en el peor momento del mes.

**Qué falta:** una pestaña que las liste, con un botón para crear el envío faltante. Un GET y una tabla. **Riesgo: ninguno, es solo lectura.** Es el mejor ratio del informe.

### 2. Carga múltiple de facturas UPS — CHICO

Las 13 facturas de fin de mes se cargan de a una, con un ritual de 4 pasos cada una (~20-30 minutos con atención sostenida). Y el resumen **se pisa en cada carga**: para saber cuántas guías entraron en el mes hay que ir anotando 13 resúmenes parciales.

La lógica por factura ya está escrita y probada; solo se envuelve en un loop.

**Riesgo — el punto fino:** hoy "sobreescribir" es una **decisión global**. Con 13 archivos, un solo click se aplicaría a todos y podría pisar costos correctos. La decisión tiene que quedar **por factura**.

*(Es el ítem que tu backlog marca como "vence esta semana". Dijiste dejarlo para más adelante — queda anotado acá.)*

### 3. `envios.pickup_id` existe, está migrado, y no lo usa nadie — CHICO/MEDIO

La columna está en el esquema y el backlog la da por cerrada. **Es una columna muerta**: no la recibe el alta, no la selecciona Salidas, no está entre los campos editables.

Consecuencia: cuando el paquete llega al depósito, alguien **re-tipea los ~20 campos del formulario**, incluidos cliente, fecha y courier, que ya estaban cargados en el pickup. 2-4 minutos por envío, ~30 envíos/mes → **1-2 horas/mes**, más los errores de tipeo en el número de guía, que reaparecen a fin de mes como "guía no encontrada" (o sea, el punto 1).

Y el vínculo real hoy es un UPDATE a ciegas por coincidencia de cliente y fecha: **si un cliente tiene dos envíos el mismo día, marca los dos.**

**Qué falta:** botón "cargar envío" en la tarjeta del pickup que abra el alta precargada y persista `pickup_id`.

### 4. Estado del backup visible — CHICO

El backup **ya corre solo** (al arrancar + cada 24 h). No hace falta el cron del VPS que figura en tu backlog.

Lo que falta es que **si dejara de funcionar, alguien se entere**: registrar cada corrida y mostrar "último backup OK: …" en Configuración, en rojo si falló o venció. Más una copia fuera de la máquina (ver #10 de la parte 1).

Es el caso arquetípico de riesgo invisible: el sistema sigue funcionando perfecto mientras la red de seguridad no existe.

### 5. Duplicar pickups recurrentes — CHICO

No hay plantilla ni recurrencia: los mismos clientes con los mismos horarios se cargan de a uno todas las semanas. 29 pickups en junio → **30-60 minutos/mes**.

Un botón "duplicar" que copie todo y pida solo la fecha nueva es CHICO. La recurrencia real (reglas + job) es MEDIO.

### 6. La bandeja de revisión esconde la mitad del trabajo — CHICO/MEDIO

Toda guía entra como "pendiente" y solo pasa a "a revisar" si el margen queda bajo el umbral. Pero **la bandeja filtra solo "a revisar" y "reclamar"**. Si en un mes entran 100 guías y 15 caen en la bandeja, las otras 85 quedan pendientes **para siempre**. No hay forma de decir "junio quedó conciliado".

Y hay un segundo criterio **ya calculado que no se usa**: el semáforo de desvío de peso y costo vive **solo en el frontend**. Ese semáforo es mejor detector que el % de ganancia — detecta que UPS facturó 8 kg de más aunque el margen siga siendo bueno — y no alimenta el estado de revisión.

**Respetando tu decisión de diseño:** el comentario del código dice *"el tilde verde lo pone SOLO un humano; nunca el auto-marcado"*. La propuesta **no auto-aprueba nada** — hace visible la cola completa y permite aprobar en lote lo que el humano seleccionó.

### 7. Tracking de UPS automático — MEDIO

Hoy es 100% manual y no persiste nada. La evidencia más clara está en un comentario del propio código: hay una función cuyo propósito explícito es *"copiar las guías al portapapeles listas para pegar en el buscador de tracking de UPS"*. El sistema tiene una función para facilitar que un humano se vaya a la web de UPS.

**Toda la infraestructura ya está**: cliente OAuth con cache de token, parseo completo de movimientos, manejo de guías rechazadas. Falta un job que recorra los envíos no entregados y persista el estado, más una columna en Salidas.

**Riesgo:** que el job falle en silencio y la pantalla muestre estados viejos como frescos. Obligatorio mostrar la fecha del último chequeo y pintar en gris lo vencido.

*(Si se hace, es el momento de meter el diccionario español — la decisión #3 de tu backlog.)*

### 8. Notificaciones a Juanqui — MEDIO

No existe nada: cero referencias a push, WhatsApp, Telegram, SMS o mail. Peor, **no hay ni refresco automático de pantalla** (cero `setInterval` en todo el frontend). Si cargás un pickup a las 10:15, la pantalla de Juanqui no lo muestra hasta que aprieta F5.

**Telegram es CHICO/MEDIO** (un token, un chat por chofer, un fetch). **WhatsApp Business oficial es GRANDE** (verificación de negocio, plantillas pre-aprobadas, proveedor). Recomendación: empezar por Telegram y ver si lo usa antes de invertir en WhatsApp.

### 9. Liquidaciones: el cálculo ya está automatizado — CHICO/MEDIO

**El armado ya está resuelto** y no hay que tocarlo. Lo manual es:

- **disparar el ciclo cliente por cliente** (con 10 clientes, 10 ciclos) → un botón "generar borradores de todos los pendientes" es CHICO;
- **bajar el Excel y mandarlo a mano.** `clientes.email` existe en el esquema, se edita en la pantalla de clientes, y **no se usa en ninguna parte del código**. Un botón "enviar por mail" es MEDIO;
- **nadie avisa cuándo liquidar.** Un cliente con 12 envíos sin liquidar hace 40 días no genera ninguna alerta.

**Riesgo del envío por mail — el más delicado después de las facturas:** un Excel equivocado enviado a un cliente no se deshace y es un problema comercial, no técnico. Debe ser un botón explícito con vista previa del destinatario, **nunca** un efecto automático de confirmar la liquidación.

### 10. Facturas de DHL — MEDIO/GRANDE

El parser es 100% UPS (busca el prefijo `1Z`, el courier está hardcodeado en dos lugares). En junio fueron 16 UPS y 7 DHL: **aproximadamente un tercio de los envíos no se cruza contra ninguna factura.** No se detectan sobrecostos, ni repesajes, ni recargos inesperados.

Lo llamativo es que **el resto del sistema ya está preparado**: las tolerancias son por courier, el frontend las indexa por courier, las tablas son genéricas. La pantalla está lista y nunca recibe datos.

**No es adaptable, es escribir un parser nuevo** con facturas reales en mano. **Riesgo medio-alto:** un parser mal calibrado escribe costos incorrectos en silencio, y esos números alimentan el margen del Dashboard. Obligatorio probar con el endpoint de solo lectura contra 2-3 facturas históricas antes de habilitar la carga.

---

# PARTE 3 — Por dónde empezar

**Esta semana, y son baratos:**

1. `printenv NODE_ENV` en el VPS (#26). Un comando.
2. Cache busting: `main.css` y `auth-guard.js` (#18). ~15 minutos y explica la queja de "código viejo".
3. Serializar `transaction()` (#1). Es el único que puede hacer desaparecer trabajo ya guardado.
4. Fechas UTC (#19). Cuatro líneas, impacto diario después de las 21:00.
5. `loadTolerancias` silencioso (#22). Tres líneas, hoy tenés un control de costos apagado sin saberlo.

**Después, la plata mal contada:** #2 (editar envío no recalcula) y #4 (sobrepeso) primero, porque ya están mal hoy en producción. Después #3 (DDP) y #5 (documentos).

**Antes de cargar la primera factura UPS real:** #12 a #17 completos. Las tablas están vacías: es el momento más barato posible, y después de la primera carga ya no lo es.

**Cuando haya aire:** #8 y #9 (permisos de borrado y puerta trasera), #10 y #11 (backups fuera del disco y el WAL de OneDrive).

**Automatización, si hubiera que elegir tres este mes:** las guías no encontradas y la carga múltiple juntas (mismo módulo, misma sesión, ambos chicos), después el pickup → envío precargado, y el indicador de estado del backup.

---

## Preguntas que necesitan tu respuesta

1. **Seguro DHL** (#24): ¿el mínimo de 17,50 es el tarifario real de DHL, o la regla escrita (0 / 15 / 1,5%) es la correcta?
2. **Manejo adicional + contorno UPS**: hoy se cobran los dos en el mismo bulto (27,65 + 120). La regla comercial de UPS es que el recargo de bulto grande *reemplaza* al de manejo adicional. ¿Cómo es tu contrato?
3. **Salto de tarifa DHL importación a los 50 kg**: a 50,0 kg son USD 422,30 y a 50,5 kg son USD 324,42. Medio kilo más barato en USD 98. ¿Es la estructura tarifaria real de DHL o está invertido?
4. Las dos confirmaciones pendientes de la verificación del backlog: el pintado del envío sin factura, y si querías comparación cargo por cargo o alcanzaba con ver el desglose.
