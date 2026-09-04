# Pendientes

**Actualizado 04/09/2026.** Última punta: **`7e1ced8`** (Liquidaciones: Pendientes muestra
TODO lo que hay sin liquidar; "Liquidar" abarca el envío más viejo del grupo) — **pusheado y
DESPLEGADO el 04/09, check-schema verde**. Antes, el 03/09: **`0a98ec0`** (DDP entrega 1: facturas
de impuestos de UPS cruzadas por guía con su envío — desplegado desde el 03/09, columnas nuevas en
verde en el check-schema del 04/09), **`094d776`** (agregar bultos desde el modal de
Salidas), `2d9b74e` + `e56ea5c` (los docs adentro del repo), `e01dc83` (CIF con flete
aforado 2,50/kg), `3db83cf` y `cc65125`. **Todos en `origin/main`** (visto en el `git log`
del 04/09).
Cache **`?v=20260901h`**.
**62 tandas en el verificar (65 archivos `test-*.js`)** — contadas contra `package.json`.

---

## 🔵 LO PRIMERO

1. ✅ `7e1ced8` desplegado el 04/09 (`DESPLEGADO Y SANO`, check-schema verde). Falta que
   Felipe entre a Liquidaciones con Ctrl+Shift+R y diga si en Pendientes apareció algo
   viejo fuera del radar.
2. **Que la oficina cargue las 6 facturas DDP reales** (`327W09_FA_000100926785..94`) por
   Facturas y mire el chip DDP en Salidas. Con eso arranca la **entrega 2 del DDP** (la
   liquidación de impuestos al cliente): diseño listo en `DDP-IMPUESTOS.md`.
3. **Manuales:** al de Salidas sumarle "+ Agregar bulto" y los chips DDP / `+50`; al de
   facturas, las facturas de impuestos.
4. Sigue la consolidación: **cron del panel de salud (L11)** — 10 min en el VPS — y
   **los Excel para la oficina (L4/L17)**.
5. **Impuestos de impo: POSPUESTO por Felipe** (31/08). Los "aspectos que no me contó"
   siguen sin revisar — no darlos por validados (el CIF aforado del 02/09 ya está).

## 🟢 LO DEL 03-04/09 — TRES COMMITS DE SISTEMA + LOS DOCS EN EL REPO

### `7e1ced8` — Liquidaciones: Pendientes muestra todo lo que hay sin liquidar (04/09)
- Pedido de Felipe: *"de entrada necesito que muestre todo lo que hay pendiente por perfil
  para que no se pase nada de largo"*. La pestaña Pendientes arrancaba filtrada por el mes
  en curso: un envío de dos meses atrás sin liquidar no se veía.
- Ahora entra con las fechas vacías ("vacío = todo"), agrupado por cliente; el filtro por
  mes sigue para quien lo quiera; botón **"Ver todo"** para volver.
- Segundo agujero: el botón **"Liquidar"** de un grupo saltaba a Crear con el mes en curso
  y los envíos viejos del grupo desaparecían de la tabla. Ahora el período va desde el
  envío más viejo del grupo hasta hoy. Crear e Historial siguen arrancando con el mes.
- Sin cambios de backend (`listarPendientesPorCliente` ya aceptaba fechas vacías). Tanda
  nueva `test-pantalla-liquidaciones-pendientes` (**12**, puerto 3952), en
  `test-pantallas`; Felipe la corrió: 12 de 12. Vecinas verdes: liquidación sin cotizador
  11, cierre de período 81, pantalla de cierre 30.

### `0a98ec0` — DDP entrega 1: facturas de impuestos de UPS (03/09)
- Las facturas de "GASTOS DE IMPORTACION EN DESTINO" (una guía por factura, 6 reales de
  ejemplo, todas leídas al centavo) se cargan por el mismo Facturas; el servicio reconoce
  el tipo solo; se cruzan por guía y quedan en `envios.impuestos_facturados`,
  `impuestos_factura_id`, `impuestos_fecha` **sin tocar costo ni revisión**.
- Salidas: chip DDP (gris "espera" con el tilde DDP y sin factura · azul "DDP $imp" ·
  rojo "¡Imp. sin DDP!" cuando llega factura a un envío sin tilde). Facturas: banner
  "Factura de IMPUESTOS DDP", contador "Sin tilde DDP".
- Tanda `test-facturas-impuestos` (**44**, puerto 3951) en `test`; usa los PDFs de
  `facturas-ejemplo/impuestos/` si están. **pdf-parse: pasar `Uint8Array.from(buffer)`**
  (los Buffers < 4 KB salen del pool de Node y daban "bad XRef entry").
- **Decisión pendiente de Felipe:** si una factura de impuestos llega a un envío SIN tilde
  DDP, ¿se liquida igual al cliente?
- Diseño de la **entrega 2** (liquidación de impuestos, 1-2 meses después, documento
  aparte con Excel propio): `DDP-IMPUESTOS.md`.

### `094d776` — Salidas: agregar bultos a un envío ya cargado (03/09)
- Caso de Felipe: se carga con 1 bulto y resultan 2, y desde Salidas no había cómo. Botón
  **"+ Agregar bulto"** en el modal; el PATCH acepta bultos nuevos (`id: null`), 400 sin
  peso ni las tres medidas, **409 si el envío ya está liquidado**; `cantidad_bultos` se
  recalcula con COUNT; ✕ solo en los nuevos antes de guardar.
- Tanda `test-agregar-bulto` (**36**, puerto 3950) en `test-pantallas`.

### `e56ea5c` + `2d9b74e` — la memoria del proyecto adentro del repo (03/09)
Pregunta de Felipe: *"si el día de mañana pasa algo con Claude, ¿dónde va a estar todo
esto?"*. Los 46 documentos del proyecto en `docs/claude/`, los manuales Word en
`docs/manuales/`, `docs/README.md` lo explica. **Regla:** cada doc que se actualiza con
`project_write` se vuelca también a `docs/claude/` y se commitea.

### `e01dc83` — CIF con flete aforado (03/09)
El CIF de los impuestos de impo se valora con **flete aforado 2,50 USD/kg facturable**, no
con el flete de venta (regla de Felipe; 3 de 4 liquidaciones dan 2,50 exacto, la cuarta
cierra con 59,2 kg). Seguro CIF queda en 1%. `test-impuestos-impo` 29,
`test-pantalla-impuestos-impo` 12.

### Consultas cerradas (03/09)
- **Profit de una cotización UPS Expedited z2 8,7 kg USD 157,48 = 75% exacto.**
- **DAP a España**, la segunda vuelta: garantizado — el cliente paga flete y todo lo del
  envío; nacionalización, despachante e impuestos en España los paga el destinatario.
- **Claude Code:** *"na, aun no, más adelante lo arrancamos. Por ahora sigamos así."*

## 🟢 LO DEL 02/09 — DOS COMMITS + LA AUDITORÍA

### `cc65125` — Liquidación: el flete es kg × precio; el fuel del surge va con el surge en Adicional
- Caso de la oficina: liquidaron a **cueros** (cliente por kilo) y el flete de la
  liquidación daba **3 a 11 USD más que kg × precio**, siempre = `surge × fuel/(1+fuel)`.
  **El total estaba bien; el reparto no**: `descomponerVenta` restaba el surge pelado y el
  fuel del surge caía en el flete.
- Ahora lee `extras_json`, manda el surge **con su fuel** a Adicional y el flete queda
  clavado en kg × precio. Los dos callers (la liquidación y el bloque Venta de Salidas)
  reparten igual; **los ítems confirmados no se recalculan**; los envíos sin `extras_json`
  siguen igual.
- Tanda nueva `test-desglose-venta-surge` (**26** controles), registrada en `test`.
- Cache **`?v=20260901d`**.

### `3db83cf` — las 22 tandas que esperaban 12 s pasan a `esperarServidor` (60 s)
- Ninguna tanda del repo conserva el bucle viejo de `/api/health`. Corridas las **47
  tandas que levantan servidor: verdes.** (El porqué: "el falso cortafuegos", `ESTADO.md`
  §1.)

### Consulta de comercio exterior (cerrada)
DAP a España — ver "Cosas de oficina resueltas fuera del sistema", al final.

## 🟢 LO DEL 01/09 — SIETE COMMITS + DOS MANUALES

### `1753c36` — filtro por semáforo + botón Limpiar filtros
- El ▼ de Bulto suma el criterio **Semáforo** (No escaneada / En tránsito / Entregada,
  mismos textos que el tooltip, rojo primero). Filtro de renglón, se combina con Bulto n°
  y Cant. bultos (`bultosVisibles` los resuelve todos juntos; `filtered` y `renderPage`
  usan la misma función).
- **"✕ Limpiar filtros"**: saca filtros, búsqueda, Solo alertas y 1º bulto de un golpe y
  deja la tabla por **número de salida de mayor a menor**. El mes no se toca.
- `test-pantalla-filtros-salidas`: 33 → **48**.

### `96eb85d` — v8 al cache vigente
El paquete del semáforo no incluyó `shared/cotizador/cotizador_courier_v8.html` y quedó
pidiendo el motor viejo. Lo agarró `test-motor-unico` en el verificar completo.
**Lección: ese archivo vive fuera de `frontend/`; incluirlo siempre que cambie el cache.**

### `df4107d` — LA DOBLE VISTA DEL PROFIT (pedido de la oficina)
La oficina reportó que el cruce con la factura "le sobrescribía el profit". Lo que pasaba:
la columna Profit mostraba UN número que **cambiaba de fórmula al aprobar la revisión**,
sin avisar.
- Ahora **Compra Total, Profit y %** muestran SIEMPRE la estimación nuestra; el bloque UPS
  suma **Profit Real** (venta − Costo UPS), visible apenas se cruza la factura y sin
  esperar el tilde.
- `profitDoble()` en `utils/profit.js`. **`deriveProfit` NO se tocó**: el Dashboard sigue
  con su precedencia (real aprobado > liquidación > estimado).
- `difEval` del costo compara contra la compra ESTIMADA (antes, aprobada la revisión, Dif
  Costo quedaba en 0% sola). La tabla pasó a **38 columnas**.
  `test-pantalla-venta-salidas`: 42 → **49**.

### `b466885` — LOS TRES FRENOS DE PLATA (hechos sin Felipe, a pedido suyo)
Detalle completo en **`claude/FRENOS-DE-PLATA.md`**. En corto:
- **A1** · **borrar un envío liquidado se llevaba la liquidación confirmada** (restaba el
  total, borraba el ítem y, si era el único, borraba la liquidación entera; sin
  confirmación ni rol de admin). Ahora **409**. Los borradores se siguen borrando.
- **A5** · **un número con coma borraba el dato**: `1250,50` en un `input type=number`
  devuelve vacío y viajaba `null`, así que el flete se guardaba BORRADO. Ahora el modal
  no deja guardar (dice qué campo) y el servidor rechaza lo que no sea número. Negativos
  frenados salvo profit y porcentaje (un envío puede dar pérdida).
- **E6** · `tipo_envio`/`courier` inválidos: 400 entendible en vez de 500 crudo de SQLite.
- **A4 CERRADO** · el modal se llenaba con el profit REAL mientras la columna muestra el
  estimado: abrir y guardar persistía el número equivocado. Ahora usa `profit_estimado`.
- **E8** · `test-guias-sin-envio` sale del puerto 3999.
- Tanda nueva `test-frenos-plata`: **24 controles** (55 tandas).

### `3d431cd` — LA TARIFA DHL "MAS 50 KGS" DE EXPORTACIÓN (28 archivos)
- Arriba de 50 kg en expo el envío **se despacha por OTRA cuenta de DHL**. El motor
  compara **COSTO COMPLETO (flete + fuel + GoGreen), no flete pelado**, **elige la más
  barata y avisa por qué cuenta sale**. Esa cuenta no cobra GoGreen y hoy gana en las seis
  zonas de 51 a 300 kg; es lineal, `kg × [4,38 · 4,98 · 6,00 · 6,60 · 7,50 · 8,40]`.
- El aviso va en la **tira interna** del cotizador (**nunca dentro de la tarjeta**), en el
  panel de precio de Cargar envío y con el chip **`+50`** en Salidas. Se congela en
  `envios.tarifa_50`.
- Tandas nuevas `test-tarifa-50` (**32** controles de motor) y `test-pantalla-tarifa-50`
  (**24** de punta a punta, puerto 3943), las dos registradas en `test`/`test-pantallas`.
  **Felipe las corrió en su máquina: todo verde.** Detalle:
  **`claude/TARIFA-DHL-MAS-50.md`**.

### `8c5ea3a` — schema.sql: sumar `envios.tarifa_50`, que estaba solo en la migración
El deploy de `3d431cd` dejó el **`check-schema` del VPS en rojo** con un desvío:
*`envios.tarifa_50` existe en la base y falta en `schema.sql`*. La columna se había
agregado a la migración de `backend/src/db/index.js` pero no se había llevado a
`database/schema/schema.sql`. **La app y la migración estaban bien** (pm2 quedó online);
el desvío era del **schema de referencia**. Verificado contra una base migrada de cero:
`check-schema` en verde.
**Lección (es reincidible): una columna nueva se agrega en DOS lados — la migración de
`db/index.js` Y `database/schema/schema.sql`. Si falta el segundo, el `desplegar.sh`
termina en rojo aunque el sistema esté andando bien.**

### `57e7132` — LA AUDITORÍA DE CRUCE DE LA TARIFA +50 (24 archivos)
Felipe pidió revisar la +50 **módulo por módulo**, siguiendo el dato por todo el sistema.
Dos hallazgos de verdad:
- **El Recalcular del modal de Salidas perdía la marca de la cuenta.**
  `envios.tarifa_50` se persistía en el `PUT /api/envios/:id` pero NO en el
  `POST /salidas/:id/recalcular` ni en su PATCH: subir un envío de 40 a 70 kg desde el
  modal dejaba **el costo de la cuenta nueva con el chip de la vieja**, y la guía salía
  por la cuenta equivocada. Ahora las dos rutas escriben la marca, y el modal avisa con
  un cartel cuando el recálculo cambia de cuenta.
- **Una nota falsa en el tarifario del cliente**: prometía el GoGreen en TODAS las
  exportaciones, cuando arriba de 50 kg esa cuenta **no lo cobra**. Corregida.
- **Tanda nueva `test-cruce-tarifa-50`** (**30** controles): el mismo envío por los seis
  caminos del sistema (cotizador, Cargar envío, PUT, Recalcular + PATCH, Salidas,
  tarifario), para que las seis puntas digan lo mismo.
- ⚠️ **El CUARTO tropiezo del mismo tipo, arreglado dentro de este commit:** esa tanda
  nueva había nacido como script de auditoría en el contenedor y se subió con **rutas
  absolutas `/root/nova/...`** → `MODULE_NOT_FOUND` en la máquina de Felipe. Se pasó a
  rutas relativas y **se barrieron las 61 tandas del repo: ninguna otra tiene rutas del
  contenedor.**
- Felipe cerró el día con la instrucción **"que no vuelva a pasar, acá priorizamos
  trabajar bien, no rápido"**, que quedó como **REGLA NÚMERO ONCE** en `ESTADO.md`.
- Tests de Felipe en su máquina: **32 (motor) + 39 (pantalla) + 30 (cruce), todo verde.**
  Detalle: **`claude/TARIFA-DHL-MAS-50.md`**, sección "La auditoría del cruce".

### Los manuales (acuerdo del 01/09: uno por módulo, visual)
- `C:\dev\manual-control-facturas.docx` — 4 páginas.
- `C:\dev\manual-salidas.docx` — 3 páginas (barra, botones, semáforo, los tres criterios
  de Bulto, el bloque de plata, editar un envío, qué mirar seguido).
Cómo se generan las capturas anotadas: **`MANUAL-CONTROL-FACTURAS.md` §7**.

### Correcciones de negocio de Felipe (01/09) — IMPORTANTES
1. **El circuito del envío**: el precio de venta se carga en la MISMA carga del envío y
   sale del cotizador automático del cliente. La intención es que ESE precio se mantenga;
   la factura sirve para controlarlo. Por eso se están completando las matrices de todos
   los clientes. La liquidación va antes o después de la factura según el cliente.
2. **Las facturas de UPS son MENSUALES** (llegan del 1 al 5). Hoy la conciliación termina
   cerca del 10; bajar ese tiempo es el objetivo del módulo.

## 🟢 LO DEL 31/08 — CUATRO COMMITS + LA HOJA DE EXTRACARGOS

`5b2a2d7` respaldo de Salidas (un renglón por bulto + nº de salida del mes;
`test-cierre-periodo` 51→81) · `18f6db6` filtro de multibulto · `d526e29` topes de medida
(avisan, no frenan) + manejo UPS por promedio >32 kg (`test-recargos` 72→78; tandas nuevas
`test-topes-medida` 35 y `test-pantalla-topes-medida` 15) · `db31c11` **el semáforo
automático** (UPS cada 4 h, verde terminal, gana UPS siempre, errores a la vista;
`test-tracking-auto` 31).

**La hoja de extracargos** (`C:\dev\extracargos-ups-dhl-31-08.docx`) reemplaza el papel
del 17/04, que tenía el surge viejo (0,30 en vez de 0,50/kg) y un cargo DHL de 71,50 por
pieza >120 cm que **no existe en la lista vigente**. De ese cotejo salió la regla del
manejo por promedio, que al motor le faltaba.

## 🟢 LO DEL 28/08 — TRES COMMITS (DESPLEGADOS)

`75b2ecf` parser de una sola tarifa + sobreescribir REEMPLAZA · `73841b5` carga múltiple
de facturas · `faa8028` impuestos de impo calibrados + filtros de Salidas + residencial
6,00 + asegurado ≥ 100 + aviso 122 cm.

### Lo que queda de facturas (no es código):

| Quién | Qué |
|---|---|
| **Oficina** | Excel `C:\dev\control-facturas-julio.xlsx` — Hoja 1: confirmar las **25 guías facturadas sin envío (USD 4.971)** · Hoja 2: corregir las **9 guías mal tipeadas** y recargar esas facturas |
| **Oficina** | **La liquidación de cueros (02/09):** si todavía es **borrador**, regenerarla para que el flete salga en **kg × precio** (el fuel del surge ya va en Adicional); si ya está **confirmada**, queda como está (los ítems confirmados no se recalculan) |
| **Felipe/oficina** | Cargar lo que falta: facturas 75124 y 75130 (¿existen?), la de agosto con los despachos del 29-31/07, otras cuentas (`1Z3R6A…` = IMPO) |
| Decisión | **DHL no tiene parser** — los 20 envíos DHL de julio no tienen cómo tomar costo. ¿Parser DHL o a mano? |

### Operativa del verificar
**Verificar completo: una vez por día, antes del primer deploy.** Agregados del mismo día:
solo las tandas de lo tocado. ⚠️ Pasarle el `cd C:\dev\Nova-Express-Sistem\backend`
(pasó DOS veces el 01/09 que corrió `npm run` en la raíz).
⚠️ **El ECONNREFUSED de los tests de pantalla NO era el cortafuegos: era la espera de
12 s** al servidor de prueba (en Windows el primer arranque de node del día tarda más).
El 02/09 se migraron TODAS las tandas a `esperarServidor` de `_base-test.js` (60 s). Si
vuelve a pasar, el helper dice el motivo — detalle en `ESTADO.md` §1.

## 🔴 ALERTAS DE PLATA DE LA AUDITORÍA DEL 28/08 (no es código)

- **Envío #194 (Enrique Schwartz, 24/07, guía `1ZF33G…`): costo real USD 429,36 y venta
  SIN CARGAR.** La cuenta `F33G` factura a TARIFA DE LISTA (~6× la negociada). **¿Qué es
  la cuenta F33G?**
- **14 guías donde UPS facturó MÁS kilos que los cargados** (>10%): marcadas en Revisar.
- El surge viene bajo dos nombres ("SURGE FEE" y "CARGO POR INCREMENTO DE VOLUMEN").

---

## ⏳ LISTA ÚNICA DE PRUEBA PARA LA OFICINA

NO VOLÓ · circuito de cotizaciones de un paso · Aceptar en el perfil · seguro automático
FOB ≥ 100 · "+ Envío sin pickup" · resumen de Pickups · carga múltiple de facturas ·
filtros de Salidas (Bulto n°, **Semáforo**), "1º bulto" y **"✕ Limpiar filtros"** ·
impuestos de impo en el cotizador · el Excel del respaldo con números de salida y bultos ·
los avisos de topes de medida · el semáforo que se pinta solo · **la columna Profit
Real** · **que un envío liquidado ya no se puede borrar** · **que un número con coma avisa
en vez de borrar el dato** · **el aviso de tarifa +50 kg (tira interna del cotizador,
cartel en Cargar envío, chip `+50` en Salidas)** · **el cartel del modal de Salidas cuando
el Recalcular cambia de cuenta de DHL** · **el cartel del panel de "Calcular venta"** ·
**"+ Agregar bulto" en el modal de Salidas** · **cargar una factura de impuestos DDP y ver
el chip en Salidas** · **Liquidaciones → Pendientes muestra todo, "Ver todo", y el
"Liquidar" de un grupo trae los envíos viejos** · lo del 19-24/08 sin probar.
⚠️ Siempre con **Ctrl+F5 / Ctrl+Shift+R** primero. Y los dos manuales impresos.

---

## 🎯 EL PLAN ACORDADO (26/08)

1. ✅ **L2 — EL RESPALDO — 28/08**.
2. ✅ **Simulacro de restauración — 28/08**.
3. **Cron del panel de salud** (L11) en el VPS. ← EL PRÓXIMO
4. **Datos para la oficina:** Excel de clientes sin margen (L4 — 51) y los 81 ceros de PIO
   (L17); Felipe borra los borradores L1.
5. **Sobre de accesos** (pendiente 11) + hoja de emergencia.

## 👉 DESPUÉS DE LA CONSOLIDACIÓN

- **La entrega 2 del precio acordado**: el envío ATADO a la cotización + la diferencia
  registrada. Columnas ya en NULL.
- **Documentar el link de cotización** (`88d634d`). ¿Validez 30 o 15?
- **Los manuales visuales** del resto de los módulos (hechos: Facturas y Salidas).

---

## ⚠️ LA REGLA QUE FIJÓ FELIPE EL 20/08

**No se corrige lo que cargaron los empleados.** Los informes se corren y se MIRAN. El
**código** que genera mal sí se arregla. No tocados por decisión: los **228 envíos sin
precio de venta** y el **envío #137**.

---

## 🔴 Lo urgente que quedó (no es código)

- **Los 81 precios en USD 0 de PIO ALVAREZ** — la oficina (L17). Battlo (23): 1 fila kg.
- **Las 25 guías facturadas sin envío (USD 4.971)** — hoja 1 del Excel de facturas.
- **El envío #194 y la cuenta F33G**.

## B. Después

- **La estética general** (dashboard y resto de pantallas).
- **Cotizaciones en pesos** (punto D de `IDEAS-COTIZACIONES-Y-BOT.md`). El más chico.

## C. Pedidos anteriores que siguen en cola

| # | Qué | Tiempo |
|---|---|---|
| 8 | Bloqueo de edición concurrente en Salidas (el más grande) | 5-7 h |
| 11 | Sobre de accesos al padre de Felipe — punto 5 de la consolidación | de Felipe |
| 27 | Limpiar tarballs viejos y `_to_delete` (OneDrive\GitHub y C:\dev) — diez más | 10 min |
| 31 | El tarifario impreso todavía ofrece el logo de Exportalo — **decisión de marca, no defecto** | de Felipe |
| **32** | Editar un envío viejo lo recalcula con el redondeo nuevo — **descartado por Felipe** | 1 h |
| 33 | ¿El mail del **tarifario** también pasa a WhatsApp? | 10 min |
| **34** | ¿Los envíos NO VOLÓ con la venta y los kilos **en blanco** en el Excel del cierre? | 10 min |
| 35 | Editar la marca "Guardar este precio" después de guardar (hoy: recotizar) | 30 min |
| ~~29, 36-40, 42, 44-48~~ | cerrados 28/08-01/09 (topes, parser, sobreescribir, importador, residencial, Excel respaldo, filtro multibulto, semáforo automático, filtro semáforo + limpiar, doble vista, **A1/A5/A4/E6/E8**) | — |
| **43** | **Punto "V6a" del listado impreso de Felipe** — los V7 (medidas) quedaron cerrados; falta que pase qué dice el V6a | de Felipe |
| **49** | **¿Declarar 51 kg en los envíos de 41 a 50 kg?** A 50 kg todavía se paga GoGreen y a 51 no, así que **un envío de 51 kg sale MÁS BARATO que uno de 50**. Conviene desde ~41-47 kg según la zona; ahorro en un envío de 50 kg: **z1 39,99 · z2 51,46 · z3 22,15 · z4 89,68 · z5 107,58 · z6 103,94**. NO está implementado: declarar más peso del real es decisión comercial (`TARIFA-DHL-MAS-50.md`) | de Felipe |
| **51** | **Tarifarios ya emitidos a clientes con destinos de zona 1 (Brasil/Chile/Uruguay) o zona 3 (EE.UU./México/Canadá) y pesos arriba de 50 kg quedaron desactualizados HACIA ARRIBA** desde la tarifa +50 (hasta **+12% a 300 kg en zona 1**): el cliente tiene impreso un precio más caro que el que hoy cotiza el sistema. Revisar `tarifario_emitidos` y decidir si se reemiten (02/09) | de Felipe |

## D. Decisiones de Felipe — no llevan código

13 · permiso de cierre de mes · 15 · borrar borradores 12 y 30 (L1) · 17 · las 7
decisiones de pricing (L5) · La Justina (26) y Arenasa (55) ¿van por kilo? · ¿el tarifario
corta en 300 kg? · ¿validez del link 30 o 15? · CTZ2268: ¿IVA de la firma exportadora? ·
**¿parser DHL o julio DHL a mano?** · **¿qué es la cuenta UPS `F33G`?** · **los "aspectos
que no te conté" de los impuestos de impo (POSPUESTO)** · ¿credenciales de la API de DHL
para sumar DHL al semáforo? · **¿el logo de Exportalo sale del tarifario impreso?** ·
**¿una factura de impuestos que llega a un envío SIN tilde DDP se liquida igual al
cliente?** (03/09)

### ✅ Decididas el 31/08 - 01/09
- **Seguro DHL: queda 1,5% del FOB con mínimo 17,50** (el papel decía 1%).
- **Manejo por promedio >32 kg: SE COBRA.**
- Topes de pieza: con los límites oficiales, **sin margen de cm descontado**.
- **Semáforo automático**: cada 4 h · solo UPS · gana UPS siempre.
- **Profit**: se muestran los DOS (estimado y real), ninguno pisa al otro.
- **Manuales**: uno por módulo, visual, con capturas reales.
- ✅ **LA TARIFA DHL "MAS 50 KGS" DE EXPO: CARGADA (01/09).** Eso cierra el viejo
  pendiente 18 ("confirmar con DHL el tarifario por guía"): **no es un tarifario a
  elegir, es OTRA CUENTA de DHL**, y **no cobra GoGreen** (dato de Felipe). Arriba de
  50 kg el motor compara **costo completo** y hoy la +50 gana en las seis zonas.
  **Commiteada, pusheada y DESPLEGADA** (`3d431cd` + `8c5ea3a` + `57e7132`), con los
  tests corridos por Felipe en verde. Detalle: **`claude/TARIFA-DHL-MAS-50.md`**.

## E. Deuda técnica

| # | Qué | Tiempo |
|---|---|---|
| 23 | Las bandas duplicadas a mano frontend/backend (hoy IDÉNTICAS) — una sola fuente | 1 h |
| 24 | El "antes" del informe de `migrar-tramos.js` con `obtenerTramos()` | 1 h |
| 25 | Decidir el destino final de `modo_tarifa` | 30 min |
| ~~E2~~ | ~~Código muerto que contradice al motor~~ — **la nota estaba VIEJA**: esas líneas hoy tienen código vivo (`calcularPesos` y `calcularItem`). Verificado 01/09. | — |
| 28 | Las emisiones del tarifario no se borran nunca (a propósito) | — |
| **41** | **El correlativo del mes está calculado en DOS lados** (backend y frontend); `test-cierre-periodo` compara las dos implementaciones; unificarlas alguna vez | 1 h |
| — | Observaciones de centavos (zona entrega y GoGreen con peso crudo) — `AUDITORIA-NUMEROS-28-08.md` §4 | — |
| **50** | **Tres tandas quedaron FUERA del `verificar`**: `test-orden-pendientes`, `test-regla-documentos` y `test-tarifa-por-kg` (existen como archivo pero no están en las cadenas `test`/`test-pantallas`). Decidir si entran al verificar o si se borran | 20 min |

**El conteo de tandas venía arrastrado mal en la documentación**: el número bueno,
verificado contra `backend/package.json` el 04/09, es **62 tandas en el verificar sobre 65
archivos `scripts/test-*.js`** (la última es `test-pantalla-liquidaciones-pendientes`).

---

## Cosas de oficina resueltas fuera del sistema

- **150 mantas a Uruguay (25/08).** 11 cajas de 13-14 kg; FOB USD 1.500. Falta pesar.
- **Tarifas de cotizaciones viejas:** UPS W.E z2 20 kg ≈79,66% (26/08) · Numana UPS W.E z4
  8 kg **75% exacto** (28/08) · **UPS W.E z2 14,5 kg (45×45×35, FOB 250) = 40% exacto**
  (01/09: flete de tabla 80,82 → venta 113,14 → total 182,44).
- **CTZ2268 → v5 final (24/08), CHICHO.** USD 5.924,89 · con IVA 6.374,64.
- **Alfombras a Australia (27/08):** 4 alfombras en 1 caja 60×45×40, FOB USD 400.
- **Consulta cambiaria (31/08, monotributista, courier USD 1.500 a España):** la
  transferencia entra al banco casi seguro sin Factura E (persona humana, <3.000
  exceptuado de ingreso, Com. A 8417 sin liquidación obligatoria), PERO la venta igual se
  factura ante ARCA; para emitir E de BIENES probablemente pida el perfil de exportador
  (RG 5472, online ~1 semana, monotributista puede — solo exportación).
- **Consulta Incoterms (31/08, indumentaria a España, CIP→DAP):** con DAP el riesgo del
  viaje pasa al vendedor hasta destino y el seguro deja de ser obligatorio (recomendación
  Nova: mantenerlo); impuestos y despacho en España siguen a cargo del comprador.
- **Consulta DAP (02/09, exportación a España, verificada contra la ICC):** DAP
  (Delivered at Place) = el exportador argentino paga flete y despacho de exportación y
  carga el riesgo hasta la puerta; el importador español paga descarga, despacho de
  importación, arancel e IVA; seguro no obligatorio para nadie. **En courier, DAP es el
  servicio puerta a puerta de siempre** (DDP es lo único distinto). La factura lleva
  "DAP [dirección], España – Incoterms 2020" con el flete incluido. Los importadores
  españoles lo piden porque el IVA de importación lo deducen ellos, y un exportador
  argentino no puede hacer DDP en la UE sin representante fiscal.
