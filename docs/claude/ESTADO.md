# Sistema Nova — Estado del trabajo

> **Leer esto SIEMPRE al inicio de cada sesión.** Cada tarea de Cowork arranca sin memoria de la anterior; este documento es la única memoria que persiste.
>
> ⚠️ **REGLA NÚMERO UNO AL HABLAR CON FELIPE:** **RESÚMENES CORTOS. SIEMPRE.** Pocas líneas; él pide detalle si quiere. Los textos largos no los lee y lo enojan. El detalle va a estos documentos, no al chat.
>
> ⚠️ **REGLA NÚMERO DOS (aprendida a los gritos el 13/08):** **cuando Felipe describe un comportamiento, está definiendo LA REGLA DEL NEGOCIO, no comentando la pantalla.** Si lo que pide contradice cómo funciona el sistema, el que está mal es el sistema — confirmar con UNA pregunta y cambiar el sistema, no adaptar la pantalla.
>
> ⚠️ **REGLA NÚMERO TRES (13/08):** **SIEMPRE pasarle los comandos**, aunque el paso parezca obvio y aunque ya se lo hayas dado antes. Con la ruta y diciendo dónde se pegan (PowerShell / VPS). Nunca "falta desplegar" a secas.
>
> ⚠️ **REGLA NÚMERO CUATRO (20/08):** **no se corrige lo que cargaron los empleados.** Los informes se corren y se MIRAN; corregir datos cargados requiere pedido explícito. Lo que sí se arregla sin preguntar es el **código** que los genera mal.
>
> ⚠️ **REGLA NÚMERO CINCO (25/08):** **cuando dice "así me lo pidió la oficina", eso es la especificación y no se discute.** Se implementa tal cual **y se le pone un test que lo cuide**.
>
> ⚠️ **REGLA NÚMERO SEIS (25/08): cuando manda una captura (o una factura, o un PAPEL DE LA OFICINA) de algo, REPRODUCIRLO/COTEJARLO contra fuentes antes de tocar nada.** Pagó el 28/08 (parser y 4 liquidaciones) y de nuevo el 31/08: la hoja de extracargos de la oficina destapó una regla que al motor le faltaba (manejo por promedio) Y tenía dos datos viejos que había que refutar con fuentes.
>
> ⚠️ **REGLA NÚMERO SIETE (26/08): un guardado de DOS PASOS se va a olvidar siempre.** Si una acción del usuario define algo que después se consulta, el mismo click tiene que persistirla — y si falla, el control visual VUELVE al estado anterior.
>
> ⚠️ **REGLA NÚMERO OCHO (26/08, pedida por Felipe): HONESTIDAD SIEMPRE.** Los problemas del proyecto se dicen de frente, con su tamaño real. Diagnóstico: `DIAGNOSTICO-26-08.md`.
>
> ⚠️ **REGLA NÚMERO NUEVE (31/08, del semáforo automático): lo automático que puede fallar tiene que fallar A LA VISTA.** Todo job que escribe datos guarda TAMBIÉN cuándo corrió y qué le pasó, y la pantalla lo muestra.
>
> ⚠️ **REGLA NÚMERO DIEZ (01/09, de la doble vista del profit): UNA CELDA NO CAMBIA DE FÓRMULA SOLA.** Si un número puede calcularse de dos maneras (estimado / real), se muestran LAS DOS, cada una en su columna. Que una celda cambie de significado sin avisar se lee como "el sistema me pisó el número", aunque no se haya persistido nada.
>
> ⚠️ **REGLA NÚMERO ONCE (01/09, de los cuatro tropiezos de la tarifa +50): SE PRIORIZA TRABAJAR BIEN, NO RÁPIDO.** Textual de Felipe: *"que no vuelva a pasar, acá priorizamos trabajar bien, no rápido"*. **Un dato nuevo se recorre ENTERO antes de decir que está listo:** dónde se crea (migración de `db/index.js`), dónde se declara (`schema/schema.sql`), TODAS las rutas que lo escriben (hoy son dos: el `PUT /api/envios/:id` y el `POST /salidas/:id/recalcular` + su PATCH), todas las que lo leen y todas las pantallas que lo muestran. **Un archivo nuevo se prueba desde AFUERA del contenedor antes de subirlo:** sin rutas absolutas y corriéndolo desde otro directorio. **No se dice "está todo bien" sin haber corrido la revisión que respalda esa frase**; si no se revisó, se dice qué se revisó y qué no. — **El caso concreto (la tanda `test-cruce-tarifa-50.js` subida con rutas `/root/nova/...`) quedó CORREGIDO a rutas relativas dentro de `57e7132`, y se barrieron las 61 tandas del repo: ninguna otra tiene rutas del contenedor.** **Y antes de escribir una "receta" en este documento, VERIFICAR LA CAUSA: una receta que funciona por casualidad tapa el problema real durante semanas (el falso cortafuegos, 01/09 → 02/09).**
>
> ⚠️ **ESTE DOCUMENTO NO ES LA REALIDAD, ES UNA FOTO VIEJA.** El repo: `git status`/`git log` primero. Producción: verificar o preguntar antes de afirmar.
>
> ⚠️ **LOS TESTS NUNCA EN EL SERVIDOR** — siempre "en PowerShell", y **dentro de `backend/`** (pasarle el `cd` también).
>
> Documentos, en orden: 1. **`claude/PENDIENTES.md`** · 2. este archivo · 3. **`MANUAL-CONTROL-FACTURAS.md`** (01/09, el primero de los manuales + cómo se generan) · 4. **`AUDITORIA-NUMEROS-28-08.md`** y **`AUDITORIA-FACTURAS-JULIO.md`** · 5. **`RESPALDO-SALIDAS-EXCEL.md`** · 6. **`DIAGNOSTICO-26-08.md`** · 7. **`COTIZACIONES-EN-LA-CARGA-DEL-ENVIO.md`** · 8. **`ENVIOS-SIN-PICKUP-Y-RESUMEN.md`**, **`NO-VOLO.md`**, **`CABECERA-DE-LA-COTIZACION.md`** · 9. **`claude/TRAMOS-POR-CLIENTE.md`** · 10. **`TARIFA-DHL-MAS-50.md`** (01/09, la cuenta de arriba de 50 kg — **deja superado a `TARIFARIO-DHL-UNIFICADO.md`**, que comparaba fletes pelados sin el GoGreen) + **`TARIFARIO-FORMATO-NOVA.md`** + **`TARIFARIO-EN-EL-SISTEMA.md`** + `PROPUESTA-TARIFARIO-CLIENTE.md` · 11. **`IDEAS-COTIZACIONES-Y-BOT.md`** · 12. `BACKLOG.md` · 13. `CANALES.md` · 14. `MOTOR-UNICO.md` · 15. `PANEL-DE-SALUD.md` · 16. `TARIFA-POR-KILO.md` + `PANTALLA-TARIFA-POR-KILO.md` + `MATRIZ-DE-TARIFAS.md` · 17. lo del 04/08 · 18. lo del 06-07/08 (`COPIA-DE-SEGURIDAD` — **L2 CERRADO 28/08**, `RECUPERACION`, `CIERRE-DE-MES`) · 19. `CAMBIOS-27-07` / `AUDITORIA` / `AUDITORIA-PRODUCCION` / `CONTROL-DE-FACTURAS` / `RECARGOS-UPS-DHL-VERIFICACION`.

---

## 🔴 LO PRIMERO: LA CARPETA SE MUDÓ (14/08/2026)

**El repo vive en `C:\dev\Nova-Express-Sistem`.** Pedir **`C:\dev`** con
`device_request_folder_access` (montada como `$HOME/mnt/dev`).

⚠️ **Los locks de git SIGUEN apareciendo** (el puente no puede hacer `unlink`): el baile
`mv .git/*.lock "_to_delete/locks/lock.$RANDOM"` va ANTES del add, **ENTRE el add y el
commit**, y DESPUÉS — y verificar con `git log --oneline -1` que el commit entró.

⚠️ **Al extraer el tarball, `tar` SIN `--overwrite` falla con "File exists"**: siempre
`tar --overwrite -xzf`.

---

## 0. LIMITADORES ACTIVOS — leer y mencionar en una línea cada uno, con fecha

| # | Limitador | Visto | Nota | Quién |
|---|---|---|---|---|
| L1 | Borradores de liquidación #12 y #30 — se pueden BORRAR desde el historial. Falta que Felipe los borre. | 13/08 | Panel 1 | Felipe |
| L3 | Parser de facturas: mitigado — una guía ilegible entra NULL con advertencia, nunca 0 | 30/07 | Panel 3 | — |
| L4 | Clientes sin margen configurado — **51 con envíos desde julio** | 07/08 | Panel 6-7 | Oficina |
| L5 | 7 decisiones de pricing sin responder | 27/07 | | Felipe |
| L6 | 4 filas huérfanas en `envio_bultos` (53-56) | 07/08 | Panel 12 | Pendiente |
| L7 | Sin registro de quién hizo qué (9 usuarios) | 27/07 | | Pendiente |
| L11 | El panel de salud no avisa solo (falta job diario) — punto 3 de la consolidación, EL PRÓXIMO | 03/08 | | Pendiente |
| **L17** | **PIO ALVAREZ: 81 precios por kilo en USD 0 QUE HOY SE COBRAN.** | 13/08 | La matriz lo marca | Oficina, urgente |

### ✅ Levantados (resumen)
27/07-20/08: infraestructura, parser, segundo motor, tests Windows, cotizacion.service,
fuel, migración de tramos, matriz, regla de cobro, L14, L9, deudas 19 y 20. **28/08: L2
(respaldo OneDrive, cron 3 AM, panel VERDE) · simulacro de restauración PASÓ · L10 +
deudas 30, 36, 37, 38, 39 · auditoría numérica integral.** **31/08-01/09: deuda 29
(topes) + deuda 40 (Excel respaldo) + manejo por promedio + EL SEMÁFORO AUTOMÁTICO +
filtro por semáforo y Limpiar filtros + LA DOBLE VISTA DEL PROFIT + el primer manual +
LA TARIFA DHL "MAS 50 KGS" DE EXPORTACIÓN.**

---

## 0-bis. Rumbo (27/07) y los acuerdos

De Excel al sistema como centro. Quiere: app cómoda en el teléfono, **mejor estética**,
bot de WhatsApp, GECOM después. Confiabilidad y datos primero.
**Compromisos:** nada sin reproducir · no afirmar producción desde notas viejas ·
resúmenes cortos · las cosas se arrancan y se terminan · pasarle siempre los comandos ·
no tocar lo que cargaron los empleados · honestidad siempre.
**ACORDADO EL 26/08:** semana de consolidación — ✅ L2 → ✅ simulacro → **cron del panel de
salud (EL PRÓXIMO)** → Excel de datos para la oficina (L4/L17) → sobre de accesos.
**Operativa: 2-3 pedidos por sesión, un despliegue por día; verificar COMPLETO una vez
por día y para agregados del mismo día solo las tandas de lo tocado.**
**ACORDADO EL 01/09: cada módulo que se da por cerrado sale con su MANUAL VISUAL.** El
primero es el de facturas; el próximo, Salidas.

---

## ⚠️ 0-ter. LA REGLA DE COBRO (13/08) + LA REGLA DEL 12/08

**COBRO — "lo que se carga es lo que se cobra":** el precio por kilo cargado gana SIEMPRE
en su cuadrante; el porcentaje cubre el resto. `resolverTarifaVenta()` único decisor.

**DESPLIEGUE — el código no puede cambiar precios solo:** un default con datos apoyados se
migra con informe. `test-datos-viejos.js` sostiene la regla. (Por eso el manejo por
promedio y el residencial 6,00 esperaron el OK de Felipe.)

**PLATA — frenos vigentes:** país sin acento cotiza igual · confirmar rechaza liquidados
(409), ítems en 0 y el "borrador pegado" · el PATCH de Salidas congela la plata de un
liquidado · `deriveProfit` única fórmula de utilidad · el seguro negociado se congela en
`envios.seguro_venta` · NO VOLÓ no se liquida (409) · una guía ilegible entra NULL con
advertencia · "sobreescribir" REEMPLAZA la carga anterior · el importador asegura desde
FOB **≥ 100**.

**HACIA AFUERA:** el tarifario y las cotizaciones **nunca** muestran costo, porcentaje ni
precio por kilo rotulado. Servicio abreviado (`UPS W.E`/`UPS W.S`/`DHL`). WhatsApp
+54 9 11 6500-2047 (test).

---

## 1. Cómo trabajar (operativa probada)

### Circuito de entrega
Claude escribe el paquete en `C:\dev\Nova-Express-Sistem` (`device_commit_files` con
file_uuid de `SendUserFile`) y lo extrae (`device_bash`, `tar --overwrite -xzf`, md5 de los
dos lados) → **Felipe** corre las tandas **EN POWERSHELL, DENTRO DE `backend/`** → Claude
commitea (baile de locks) → **Felipe** `git push` → **Felipe** PARA EL SERVIDOR
`cd /root/Nova-Express-Sistem && bash scripts/desplegar.sh`.
- Git: identidad `-c user.name=fdaniluk -c user.email=fdaniluk01@gmail.com` · sin red ·
  `timeout_ms` máx 45000 y es un NÚMERO · verificar con `git log --oneline -1`.
- ⚠️ **Al armar el paquete, incluir SIEMPRE `shared/cotizador/cotizador_courier_v8.html`
  si se tocó el cache busting**: vive fuera de `frontend/` y es fácil de olvidar. El
  01/09 quedó con la versión vieja y `test-motor-unico` lo agarró en el verificar.
- ⚠️ **UNA COLUMNA NUEVA SE AGREGA EN DOS LADOS: la migración de `backend/src/db/index.js`
  Y `database/schema/schema.sql`.** Si falta el segundo, el `desplegar.sh` termina EN ROJO
  (`check-schema` con desvío "existe en la base y falta en schema.sql") aunque el sistema
  esté andando bien: la app y la migración están correctas, el que quedó viejo es el
  schema de referencia. Pasó el 01/09 con **`envios.tarifa_50`** (deploy de `3d431cd`);
  se arregló con `8c5ea3a`, verificado contra una base migrada de cero.
- ⚠️ **UN ARCHIVO NUEVO SE PRUEBA DESDE AFUERA DEL CONTENEDOR ANTES DE SUBIRLO.** Los
  scripts que nacen como auditoría en `/root/nova` se suben con rutas absolutas y revientan
  en la máquina de Felipe con `MODULE_NOT_FOUND` (pasó el 01/09 con
  `test-cruce-tarifa-50.js`): rutas relativas y correrlo desde otro directorio antes de
  entregarlo. **Ese archivo quedó CORREGIDO a rutas relativas dentro de `57e7132`, y se
  barrieron las 61 tandas del repo: ninguna otra tiene rutas del contenedor.**
- `device_stage_files` funciona con ruta nativa Windows (`C:\dev\...`).
- **Para traer la BASE DE PRODUCCIÓN:** PARA EL SERVIDOR `bash scripts/copia-externa.sh`
  → Felipe la baja de onedrive.live.com → `device_stage_files`.
- En PowerShell los comandos encadenan con `;` (no `&&`).

### 🔥 EL FALSO CORTAFUEGOS (01/09 → desmentido 02/09)
**Lo que se creía (01/09):** que si un test de pantalla moría con `fetch failed /
ECONNREFUSED` era Windows bloqueando al `node` lanzado en segundo plano, y que se
destrababa levantando el servidor a mano una vez y aceptando el permiso. **Era falso.**
**La causa real:** las tandas esperaban al servidor de prueba **solo 12 segundos** (un
bucle de 40 × 300 ms contra `/api/health`), y en Windows el PRIMER arranque de node del
día tarda más (el antivirus escanea `node_modules` la primera vez). Levantarlo a mano
"calentaba" eso, y por eso la receta parecía funcionar. La prueba del 02/09: una tanda
nueva reventó con ECONNREFUSED en un puerto cuyo permiso ya estaba aceptado; se le subió
la espera a 60 s y pasó sin levantar nada a mano.
**El arreglo y el diagnóstico YA ESTABAN EN EL REPO desde el 10/08:** `scripts/_base-test.js`
tiene `esperarServidor(srv, BASE, () => logErr, () => logOut)`, que espera hasta 60 s la
línea "Nova Express API en" que imprime el propio proceso hijo (no un `/api/health` que
puede contestar otro node vivo) y, si no arranca, explica por qué con las últimas líneas
del log. Ocho tandas ya lo usaban con un comentario que decía exactamente esto; las otras
22 (incluidas TODAS las escritas entre el 31/08 y el 02/09) seguían copiando el bucle
viejo de otros tests. **El 02/09 se migraron las 22 a `esperarServidor`: ninguna tanda del
repo conserva el bucle de 12 s.**
**Hoy, si una tanda muere con ECONNREFUSED, es por una de dos:** (a) NO usa
`esperarServidor` (buscarlo en el archivo) o (b) el servidor de prueba de verdad no
arrancó — y entonces el helper dice por qué. No hay receta manual: no se levanta nada a
mano.

### Editar y probar (en el contenedor, nunca sobre la carpeta)
Tar del repo (excluir node_modules/.git/backups/_to_delete/tgz; NO excluir `database/`) →
stage → `/root/nova` → `npm install` en `backend/`. Devolver tarball de lista explícita +
md5 de los dos lados.
- ⚠️ **Toda tanda que levanta servidor usa `esperarServidor` de `_base-test.js`** (captura
  `logOut`/`logErr` del spawn y espera la línea "Nova Express API en" hasta 60 s). **No
  copiar el bucle de `/api/health`** de tandas viejas. Antes de escribir una tanda nueva,
  mirar qué helpers hay en `_base-test.js` y copiar el patrón MÁS NUEVO del repo, no el
  primero que aparezca.
- ⚠️ **CRLF: chequear TODOS los archivos tocados** (`file -b`; `main.css` es CRLF).
- Base de test: `prepararDb(DB)`; **en base nueva cargar el fuel primero**. Altas mínimas:
  `clientes` exige `tipo_cobro` ('D'/'S'/'Q'/'CC') y `envios` exige `tipo_envio`/`peso_real`.
- Un test de servicio puro puede usar la base de la app: `process.env.DB_PATH = DB` ANTES
  de `require('../src/db')`, después `initDb()` (patrón de `test-tracking-auto.js`).
- Chromium: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
- **MIRAR los Excel generados:** `soffice --headless --convert-to pdf` + `pdftoppm`.
- **El check-schema del contenedor MIENTE**: la `database/nova.db` del repo es una copia
  vieja sin migrar. El check de verdad corre en la máquina de Felipe / producción.
- Puertos de tests: 3964-69, 3971-73, 3986-87, 3989-94, 3996-98, 3963, 3960-61, 3970,
  3959/3958, 3955/3954, 3949, **3948** (desglose surge), 3946, **3945** (cruce), 3944,
  3943, **3942**. Manual: 3975-3985 (nunca 3999).
  **3981 lo usa el script de capturas de los manuales.**
- ⚠️ `pkill -f "src/server.js"` SE MATA A SÍ MISMO: usar `pkill -9 -f "[s]rc/server.js"`.
- **`document.body.textContent` INCLUYE el código de los scripts inline** — leer el
  contenedor concreto (`#results`, `#salidas-body`).
- **Al afirmar sobre importes en un test, afirmar la RELACIÓN, no el número**: el backend
  congela el desglose con el motor y no toma el flete/fuel del POST, así que
  "estimado = venta − compra" se sostiene y "profit = 100" no (01/09).
- **WebFetch/WebSearch sirven para verificar tarifarios** (web de DHL, guías UPS 2026).

### El VPS
`ssh nova` lo corre Felipe. **Decir siempre "PARA EL SERVIDOR"**. Health:
`https://sistema.novaexpress.com.ar/api/health`. **Crontab desde el 28/08:** `0 3 * * *`
corre `scripts/copia-externa.sh`. El `.env` tiene `UPS_CLIENT_ID`/`UPS_CLIENT_SECRET` — de
eso vive el semáforo automático (la máquina de Felipe TAMBIÉN las tiene: el 01/09 el
`[tracking-auto]` corrió en su arranque manual).

### Felipe
Resúmenes cortos · comandos SIEMPRE, de a uno, con la ruta y dónde pegarlos · nunca romper
lo que anda · commitear sí, pushear no · no sabe git ni Windows a fondo · pega scrollback
viejo y recuerda trabajos que no existen (confirmar contra `git log`) · cambia producción
sin avisar · "no me gusta" esconde una razón buena · corta el trabajo para pedir cosas de
oficina o consultas de comercio exterior: se contesta y se vuelve · "qué tarifa/qué profit
tiene esto": motor en el contenedor, buscar el % exacto probando valores · cuando pide
algo dos veces está subrayando · una captura de algo roto pide el arreglo · habla por
dictado (leer por el sentido; el 31/08 "V6a/V7b" era la numeración de un listado IMPRESO
suyo — pedir foto) · honestidad total · pide funciones en caliente si ahorran trabajo
repetitivo · **en pasos guiados: UN comando por mensaje, en bloque de código** · a veces
dice "subamos" sin pegar el resultado de los tests · mensajes a clientes: sin tildes (ñ
sí), directo · los papeles impresos de la oficina son material de primera: cotejarlos
SIEMPRE · **"hoy está pero no se usa porque no se hace solo" = AUTOMATIZAR lo que ya
existe** · **cuando corrige un documento, esa corrección es la REGLA DE NEGOCIO** (01/09:
el circuito del envío y la cadencia mensual de las facturas).

---

## 2. El proyecto

App de gestión de **Nova Express** (courier DHL/UPS, Buenos Aires). VPS
`sistema.novaexpress.com.ar`, repo privado `fdaniluk/Nova-Express-Sistem`. **Node +
Express + SQLite, frontend vanilla.** 9 usuarios. `backend/src` · `backend/scripts`
(**59 tandas en el verificar — 62 archivos `test-*.js`**) · `frontend/pages+js/modules`
· `shared/cotizador` · `database`.
Colores Nova `#403754`/`#EE6C52`.

### Negocio (lo que no cambia)
- **EL CIRCUITO DE UN ENVÍO (corregido por Felipe el 01/09):** llega a la oficina → se
  pesa, se mide y se carga **con el precio de venta que calcula el sistema con la tarifa
  del cliente** (matriz de profit o precio por kilo) → se liquida (antes o después de la
  factura, según el cliente) → a principio de mes llega la factura de UPS y se cruza →
  revisión humana ✓/✗. **La intención es que ese precio de venta SE MANTENGA**; la
  factura sirve para controlarlo, no para rehacerlo. Por eso se están completando las
  matrices de todos los clientes.
- Volumétrico `(l×a×h)/5000` · facturable `max(real, vol)` por pieza · **redondeo de
  MEDIO KILO PARA ARRIBA POR BULTO, y después se suman**.
- **Recargos por bulto (re-verificados 31/08):** DHL 125 sobrepeso (>70 kg real o vol) /
  23 exceso (lado >100 o 2º >80) / 23 no convencional (25-70 kg reales) — **en cadena** ·
  UPS manejo 27,65 (real >25 · lado >122 · 2º >76 · **o promedio del envío >32 kg: lo
  pagan TODOS los paquetes**) — no acumula con Mayor Tamaño · Mayor Tamaño 120,10
  (contorno >300, mínimo 40 kg facturables).
- **LA TARIFA DHL "MAS 50 KGS" (01/09):** arriba de 50 kg en exportación **se despacha por
  OTRA cuenta de DHL**. El motor elige la más barata comparando **COSTO COMPLETO (flete +
  fuel + GoGreen), no flete pelado**: **esa cuenta no cobra GoGreen** (0,98/kg facturable,
  dato de Felipe), y por eso hoy gana en las seis zonas de 51 a 300 kg. Es exactamente
  lineal, `kg × [4,38 · 4,98 · 6,00 · 6,60 · 7,50 · 8,40]`. Se avisa en la **tira interna**
  del cotizador (**NUNCA adentro de la tarjeta**: la oficina le manda una foto de la
  tarjeta al cliente), en el panel de precio de Cargar envío y con el chip `+50` en
  Salidas. Se congela en `envios.tarifa_50`. Detalle: `TARIFA-DHL-MAS-50.md`.
- **Topes de aceptación (AVISAN NO FRENAN):** UPS lado >274 / contorno >400 / >70 kg
  reales · DHL pieza >120×80×80. `TOPES_PIEZA` + `calcTopesPieza` → `avisosTope`.
- **EL SEMÁFORO AUTOMÁTICO de Salidas (`db31c11`):** rojo sin escanear · amarillo en
  tránsito · verde entregada. `tracking-auto.service.js` cada 4 h (y al minuto de
  arrancar): UPS de los últimos 45 días, con guía, ni NO VOLÓ ni entregados (**verde es
  terminal**). Escribe `envios.tracking_*` y pisa `envio_bultos.estado_caja` (**gana UPS
  siempre**). Tooltip con qué dijo UPS y cuándo. Sin credenciales el job se apaga solo.
  `POST /api/tracking/refrescar` = pasada a pedido.
- **LA DOBLE VISTA DEL PROFIT (01/09, `df4107d`):** Compra Total / Profit / % muestran
  SIEMPRE la estimación nuestra y no cambian solas; **Profit Real** (venta − Costo UPS)
  es una columna aparte del bloque UPS, visible apenas se cruza la factura y sin esperar
  el tilde. `profitDoble()` en utils/profit.js. `deriveProfit` no se tocó: el Dashboard
  sigue con su precedencia (real aprobado > liquidación > estimado). Detalle y manual:
  `MANUAL-CONTROL-FACTURAS.md`.
- Seguro venta: UPS 0/15/1,5% (desde FOB 100 EXACTO) · **DHL max(17,50; 1,5%)** ·
  por cliente. **Residencial UPS 6,00**. Flete `(Total−Seguro)/(1+fuel)`.
- **Surge desde el 24/05/26:** resto 0,50/kg · ISMEA 2,95 · Israel/EAU 3,30 · impo India
  1,45 · impo China/HK/Macao 0,70. IPF 2,50 solo USA.
- **`cotizacion.service.js`** único armador · **`resolverTarifaVenta()`** único decisor ·
  **`deriveProfit`** única utilidad · adicionales = residual. **El desglose de la venta
  (`descomponerVenta`, 02/09, `cc65125`): el fuel del surge va en Adicional de la venta
  (el surge viaja CON su fuel, leído de `extras_json`), y el flete de la liquidación es
  kg × precio EXACTO.** Los dos callers (liquidación y bloque Venta de Salidas) reparten
  igual; los ítems confirmados no se recalculan.
- **Impuestos de impo:** `calcImpuestos(fob, flete, arancel, courier)`, calibrado contra 4
  liquidaciones reales. ⚠️ **POSPUESTO por Felipe (31/08)**: los "aspectos que no te
  conté" siguen sin validar.
- **Tramos:** por cliente. `TRAMOS_POR_DEFECTO` = 9. `precio_kg = 0` SE COBRA.
- **NO VOLÓ:** fuera de estadísticas, no liquidable, conserva número y valores.
- **Facturas UPS:** parser acepta líneas de 2+ importes · percepciones IIBB SON COSTO y
  se reparten solo si la suma cuadra · sobreescribir REEMPLAZA · carga múltiple con
  pregunta única · **solo UPS: DHL no tiene parser**.
- **Salidas:** filtros ▼ por columna + "1º bulto" + **"✕ Limpiar filtros"**. El ▼ de
  Bulto tiene TRES criterios: **Bulto n°** (por renglón), **Cant. bultos** (por envío) y
  **Semáforo** (por renglón, con los textos del tooltip).
- **Respaldo semanal/mensual:** un renglón POR BULTO, `# Salida` = numeración del mes.
- **Zonas DHL ≠ UPS**. Cuenta `1Z3R6A` = impo; cuenta `F33G` = tarifa de lista (¡ojo!).
- Migraciones: `db/index.js` idempotente + `schema/schema.sql` + `check-schema`. **Una
  columna nueva va en LOS DOS** (ver §1, lección del 01/09 con `envios.tarifa_50`).
- **Papeles de la oficina en `C:\dev`:** `extracargos-ups-dhl-31-08.docx` (recargos, B/N,
  1 pág.) y `manual-control-facturas.docx` (manual visual, 4 págs.).

---

## 3. Dónde estamos (02-09-2026)

- **Último commit `3db83cf`** (las 22 tandas que esperaban 12 s al servidor pasan a
  `esperarServidor`, 60 s), antes **`cc65125`** (liquidación: el flete es kg × precio; el
  fuel del surge va con el surge en Adicional). **Según Felipe, los dos subidos y
  desplegados — confirmar con `git status -sb`** (no pegó la salida).
  - **`cc65125`:** caso de la oficina — liquidaron a cueros (cliente por kilo) y el flete
    de la liquidación daba 3 a 11 USD más que kg × precio, siempre = surge × fuel/(1+fuel).
    El total estaba bien; el reparto no: `descomponerVenta` restaba el surge pelado y el
    fuel del surge caía en el flete. Ahora lee `extras_json`, manda el surge con su fuel a
    Adicional y el flete queda clavado. Dos callers (liquidación y bloque Venta de
    Salidas) reparten igual; los ítems confirmados no se recalculan; envíos sin
    `extras_json` siguen igual. Tanda nueva `test-desglose-venta-surge` (26), registrada
    en `test`. Cache `?v=20260901d`.
  - **`3db83cf`:** las 22 tandas que esperaban 12 s al servidor pasan a `esperarServidor`
    (60 s). Ninguna tanda del repo conserva el bucle viejo. Corridas las 47 tandas que
    levantan servidor: verdes.
- **LA TARIFA DHL +50 KG ESTÁ PUSHEADA Y DESPLEGADA EN PRODUCCIÓN, AUDITORÍA INCLUIDA.**
  El 01/09 cerró con **`57e7132`** (la auditoría de cruce: cerrar el Recalcular de Salidas
  y la nota del tarifario, 24 archivos), **pusheado y desplegado**; producción responde OK.
  Antes, los otros dos de la misma tarifa: **`8c5ea3a`** (schema.sql: sumar
  `envios.tarifa_50`, que estaba solo en la migración) y **`3d431cd`** (la tarifa DHL
  +50 kg de exportación: se elige la más barata y se avisa la cuenta, 28 archivos).
  **Los tres pusheados y desplegados.** Tests corridos por **Felipe en su máquina: 32 del
  motor + 39 de pantalla + 30 del cruce, todo verde.** Antes, el mismo día: `b466885`
  (los tres frenos de plata), `df4107d` (la doble vista del profit), `96eb85d` (v8 al
  cache vigente) y `1753c36` (filtro por semáforo + Limpiar filtros).
  ⚠️ Confirmar con `git status -sb`.
- ⚠️ **El tropiezo del deploy:** `3d431cd` dejó el `check-schema` del VPS en rojo con un
  desvío — *`envios.tarifa_50` existe en la base y falta en `schema.sql`*. La app y la
  migración estaban bien (pm2 online); el que quedó viejo era el schema de referencia. Lo
  cerró `8c5ea3a`, verificado contra una base migrada de cero (`check-schema` en verde).
  **Lección en §1: una columna nueva se agrega en DOS lados.**
- 🔎 **`57e7132`: LA AUDITORÍA DE CRUCE, MÓDULO POR MÓDULO, pedida por Felipe.**
  Destapó tres cosas: **(1)** `envios.tarifa_50` se persistía en el `PUT /api/envios/:id`
  pero NO en el `POST /salidas/:id/recalcular` + su PATCH — subir un envío de 40 a 70 kg
  desde el modal de Salidas dejaba el costo de la cuenta nueva y el chip de la vieja, y la
  guía salía por la cuenta equivocada; **(2)** una nota falsa en el tarifario del cliente,
  que prometía el GoGreen en TODAS las exportaciones cuando arriba de 50 kg ya no se
  cobra; **(3)** el CUARTO tropiezo del mismo tipo: la tanda nueva
  `test-cruce-tarifa-50.js` había nacido como script de auditoría en el contenedor y se
  subió con rutas absolutas `/root/nova/...` → `MODULE_NOT_FOUND` en la máquina de Felipe.
  **Los tres arreglos están COMMITEADOS en `57e7132`, pusheado y desplegado**; el archivo
  quedó con rutas relativas y **se barrieron las 61 tandas del repo: ninguna otra tiene
  rutas del contenedor.** Tandas: **32 + 39 + 30**, con la tanda nueva
  **`test-cruce-tarifa-50`** (el mismo envío por los seis caminos del sistema).
  Detalle completo en `claude/TARIFA-DHL-MAS-50.md`, sección **"La auditoría del cruce"**.
  **Lección: REGLA NÚMERO ONCE.**
- Cache **`?v=20260901d`** (las 17 páginas, incluido el v8 de `shared/`). **59 tandas en
  el verificar (62 archivos `test-*.js`)**: el 02/09 se sumó `test-desglose-venta-surge`
  (26, registrada en `test`); el 01/09, `test-tarifa-50` (controles de motor),
  `test-pantalla-tarifa-50` (punta a punta, puerto 3943) y `test-cruce-tarifa-50`
  (el cruce por los seis caminos), registradas en `test` y `test-pantallas`, así que
  `npm run verificar` las corre. **El conteo venía arrastrado mal en la documentación** y
  estas tres quedaron FUERA del verificar: `test-orden-pendientes`,
  `test-regla-documentos`, `test-tarifa-por-kg`. En el contenedor corrieron completos y en
  verde `npm test` y `npm run test-pantallas` (EXIT=0).
- **LO PRÓXIMO: cron del panel de salud (L11)**, después los Excel para la oficina
  (L4/L17), y el **manual visual de Salidas** (ahí van el semáforo, los filtros por
  columna y los botones de arriba, que se sacaron del de facturas).
- **Espera decisión de Felipe: declarar 51 kg en los envíos de 41 a 50 kg.** A 50 kg
  todavía se paga GoGreen y a 51 no, así que **un envío de 51 kg sale más barato que uno
  de 50**. Conviene desde ~41-47 kg según la zona; ahorro en un envío de 50 kg: z1 39,99 ·
  z2 51,46 · z3 22,15 · z4 89,68 · z5 107,58 · z6 103,94. **NO está implementado**:
  declarar más peso del real es decisión comercial. Detalle: `TARIFA-DHL-MAS-50.md`.
- **Falta que Felipe pase qué dice el punto "V6a"** de su listado impreso.
- 28 tablas + `envios.tracking_*` + `envios.tarifa_50` (ya en la migración **y** en
  `schema.sql`). Stash pendiente: `WIP: DDP en liquidaciones`.
- ⏳ La oficina: Ctrl+Shift+R · la lista ÚNICA de prueba · el Excel de facturas (25 sin
  envío + 9 typos) · facturas que faltan · envío #194 / cuenta F33G · imprimir los dos
  papeles nuevos · que el semáforo se mueve solo.

### El precio acordado — estado de la obra

**ENTREGA 1 HECHA** (`cd84736`). **ENTREGA 2 PENDIENTE (post-consolidación):** envío
ATADO a la cotización + diferencia registrada (columnas de `envios` ya existen, NULL).

## 4. Convenciones

Commits sin acentos, describiendo el efecto. Un JS por pantalla. Sin frameworks. **Cache
busting global única en TODAS las páginas** (`test-motor-unico` lo controla, e incluye el
v8 de `shared/`) — hoy **`?v=20260901d`**; NO cubre los scripts inline → **Ctrl+F5** tras
desplegar. La imagen de la cotización se dibuja en canvas.

## 5. Mantenimiento

Al cerrar cada sesión: actualizar este archivo y `PENDIENTES.md` con `project_write`.
Si se corta: el disco manda; producción se pregunta.
