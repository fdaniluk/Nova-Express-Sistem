# Panel de salud

*Armado el 03/08/2026. Es la idea que estaba propuesta y aceptada desde el 27/07: una pantalla que corre sola y avisa qué está raro, para que los limitadores no dependan de que alguien haga una auditoría a mano.*

---

## 1. Qué es

Una pantalla nueva, **Salud**, al pie del menú. Corre **13 chequeos** contra la base y el disco y los muestra agrupados en tres bloques: **Plata**, **Datos que faltan** e **Higiene del sistema**.

Arriba del Dashboard hay además una **franja roja** que aparece sola cuando hay algo grave, y linkea al panel. Esa franja es lo que hace que el panel sirva: **si no hay que acordarse de entrar, no hace falta acordarse.** Con todo en orden, la franja no aparece.

**El panel solo lee.** No modifica un solo dato. Cada alerta lleva un botón a la pantalla donde se arregla.

## 2. Los 13 chequeos

### Plata

| # | Chequeo | Qué detecta |
|---|---|---|
| 1 | Envíos en más de una liquidación | El caso de los borradores #12 y #30. Dice cuánta plata se refacturaría si se confirman |
| 2 | Guías facturadas sin envío cargado | Plata pagada al courier que no se le cobró a nadie |
| 3 | Facturas del courier que no cuadran | La suma de las guías no da el total declarado — la percepción de IIBB |
| 13 | **Facturas cargadas dos veces** | *Encontrado el 03/08 probando el panel. Ver sección 4* |
| 4 | Desvíos contra la factura sin revisar | El courier facturó de más y nadie lo miró |
| 5 | Envíos con un fuel distinto al de Configuración | El 39 % hardcodeado disparando cuando la config decía 33 % |

### Datos que faltan

| # | Chequeo | Qué detecta |
|---|---|---|
| 6 | Clientes activos sin margen configurado | El limitador L4 |
| 7 | Clientes por kilo sin tarifa cargada | El más silencioso: cotizan con el porcentaje y nadie se entera |
| 8 | Clientes cargados dos veces | GERSCOVICH / Gerscovich |
| 9 | Envíos de meses cerrados sin precio de venta | Envíos despachados que no se le cobraron a nadie |

### Higiene

| # | Chequeo | Qué detecta |
|---|---|---|
| 10 | Backups | Que haya uno del día, que la serie no se corte, y que el último no haya encogido de golpe |
| 11 | Liquidaciones en borrador olvidadas | Más de **7 días** en borrador (umbral elegido por Felipe) |
| 12 | Filas huérfanas | El limitador L6 y cualquier repetición futura |

## 3. Las tres reglas del panel

Están escritas en el encabezado de `backend/src/services/salud.service.js` y hay que respetarlas al agregar un chequeo:

1. **Nunca escribe.** El panel avisa; la corrección la hace una persona. Un panel que "arregla solo" es un panel en el que nadie mira lo que arregló. Hay un test que lo verifica.
2. **Un chequeo que falla no puede tapar a los demás.** Cada uno corre en su propio try/catch y, si explota, se reporta en violeta con el error a la vista. Es exactamente el problema que tenían los backups: el error se tragaba en silencio. **Un chequeo roto tiene que gritar, no desaparecer.** Y "no se pudo mirar" enciende la franja igual que un rojo, porque no es lo mismo que "está bien".
3. **Cada alerta dice dónde se arregla.** Un aviso sin acción posible es ruido, y el ruido entrena a ignorar el panel entero.

## 4. Lo que apareció de paso: facturas cargadas dos veces

Probando el panel contra la base local apareció un bug que no estaba en ninguna lista.

**La factura UPS `0020-00074402` está cargada dos veces**, como dos cabeceras distintas con sus 10 guías cada una: 20 filas de detalle para 10 guías reales.

**La causa:** al subir una factura ya cargada, la app avisa y pide marcar *"sobreescribir"*. Pero `sobreescribir` **solo saltea el aviso** — no borra la carga anterior, inserta una segunda al lado. El nombre promete un reemplazo y lo que hace es un duplicado.

**El efecto:** todo lo que sume sobre `factura_guias` cuenta esa plata dos veces. Concretamente, **la pantalla de guías facturadas sin envío mostraba 8 guías por USD 3.077 cuando en realidad son 4 por USD 1.538.**

**Qué se hizo ahora:** el chequeo 13 detecta el estado y cuantifica lo contado de más, y el chequeo 2 pasó a agrupar por número de guía (no por fila) para que la plata informada sea la real.

**Qué falta:** arreglar el flujo de carga, para que "sobreescribir" reemplace de verdad. Es una decisión de Felipe porque implica borrar una carga previa. **Está pendiente.**

## 5. Permisos

Se agregó `usuarios.ver_salud`, con la misma regla que `editar_config`: **el admin siempre puede; los demás necesitan el flag**, que se otorga desde Usuarios con un checkbox (columna "Salud").

Es un permiso **aparte de `ver_dashboard`** a propósito: el Dashboard muestra la plata que se hizo, el panel de salud muestra lo que está roto, y no tienen por qué verlos las mismas personas. Todos los usuarios arrancan en 0.

## 6. También se guardan ahora los totales de la factura

El parser de facturas UPS ya calculaba el total declarado, el subtotal y la percepción repartida, pero **esos tres números no se guardaban**: se mostraban en el resumen de la carga y se perdían. Una vez cargada la factura no había forma de verificar que la suma de las guías diera el total.

Se agregaron `total_declarado`, `subtotal_factura` y `percepciones` a `facturas_cargadas`, y la carga los guarda. Es lo que permite el chequeo 3.

*Las facturas cargadas antes de este cambio no tienen el dato y el panel las informa como "no verificables" en vez de darlas por buenas.*

## 7. Qué se verificó antes de entregarlo

| Verificación | Resultado |
|---|---|
| Cada uno de los 13 chequeos, con el problema plantado a propósito y el conteo exacto | ✅ |
| Sobre una base limpia, ningún chequeo inventa problemas | ✅ |
| Un chequeo roto se reporta como roto y **no tumba a los demás** | ✅ (se rompe uno a propósito en el test) |
| El panel no escribe: correr dos veces no cambia ni una fila | ✅ |
| No hay ningún método de escritura expuesto (POST/PATCH/PUT/DELETE) | ✅ |
| Permisos: 401 sin sesión, 403 sin el flag, 200 para admin | ✅ |
| La franja del Dashboard aparece sola, y con todo en orden se oculta | ✅ navegador de verdad |
| Un desvío **a favor nuestro** no se marca (misma regla que Salidas) | ✅ |
| El mes en curso sin precio **no** se marca (es el flujo normal) | ✅ |
| `npm run check-schema` después de migrar | ✅ 19/19 tablas, sin desvíos |
| Toda la batería del sistema | ✅ **286 controles, 0 fallas** |

Tests nuevos: `npm run test-salud` (42 controles) y `npm run test-pantalla-salud` (18 controles, navegador de verdad). El primero quedó dentro de `npm test`.

## 8. Un test que estaba en rojo desde el 30/07

`npm test` **ya venía fallando en `main`** antes de esta sesión, y no se había notado: `test-motor-unico` exige que todas las pantallas pidan la misma versión del motor, y `shared/cotizador/cotizador_courier_v8.html` había quedado en `?v=20260730a` mientras el resto pasaba a `20260730b`.

Se corrigió llevándolo a la versión global nueva (`?v=20260803`). **Pero el archivo sigue siendo el prototipo viejo** (hallazgo A5 de `PENDIENTES.md`): es un residuo de 24 KB que convive con el motor real y le está costando una falla al test suite. Conviene moverlo a un `_legacy/`.

## 9. Detalle de operación

- Un test del repo (`test-guias-sin-envio.js`) usa el **puerto 3999**, que es un puerto de desarrollo plausible. Si hay un servidor local corriendo ahí, el test le habla a ese servidor en vez de al suyo y falla con un error que no tiene nada que ver (`no such table: usuarios`). Costó un rato de diagnóstico.
- Dos tests fallan en `main` desde antes y **no** son de esta sesión: `test-orden-pendientes` (3/2) y `test-aviso-guia` (8/4). Verificado contra una copia limpia del repo. Quedan pendientes de revisar.

## 10. Lo que quedó afuera

- **El panel no corre solo todavía**: se calcula cuando alguien abre la pantalla o el Dashboard. No hay un job diario ni una notificación. El paso siguiente natural es que le avise a Felipe una vez por día por Telegram o WhatsApp — pero eso es "notificaciones hacia afuera", que en la secuencia acordada va después.
- **El chequeo de backups no puede resolver el limitador L2.** Detecta que el backup dejó de correr o encogió, pero que los backups vivan en el mismo disco que la base es una decisión de infraestructura. El panel lo dice en cada corrida, y va a seguir diciéndolo hasta que haya copia afuera.
- **Arreglar el flujo de "sobreescribir"** de la carga de facturas (sección 4).
