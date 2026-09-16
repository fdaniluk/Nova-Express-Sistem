# Ideas nuevas — cotizador para clientes, estética y bot

## A. Cotizador autogestionado para el cliente — DECISIONES TOMADAS (29/07)

Felipe: *"una señora me pide diez cotizaciones a cinco destinos diferentes... necesitaría
algo que yo le paso con una tarifa ya precargada y que ella se vaya armando la cotización
sola, sin que yo tenga que hacérselos todos."*

**Está definido, NO empezado.**

| Decisión | Qué se eligió |
|---|---|
| Formato | **Un link**, no un archivo. En un archivo las tarifas y el profit viajan adentro: cualquiera lo abre con el bloc de notas y ve el margen. Con link, el cálculo pasa en el servidor. |
| Qué ve el cliente | **El mismo desglose que Felipe manda hoy** (hoy ya es la imagen del punto C) |
| Courier | Lo fija Felipe **al armar cada link**: solo DHL, solo UPS, o los dos |
| Vencimiento | Sí, por defecto 30 días. Sin esto, la clienta abre el link en diciembre, cotiza con la tarifa de julio y reclama ese precio |
| Seguridad | Primera puerta sin contraseña del sistema: código único por link, solo cotiza (no lee la base), límite de consultas, y se puede dar de baja |
| Logo | En el link va **siempre**, predeterminado |

> Ojo al armarlo: la validez de la cotización por pantalla quedó en **15 días** (punto B), y
> la del link estaba pensada en **30**. Son dos cosas distintas y puede estar bien, pero
> conviene que Felipe lo confirme cuando se encare el link.

---

## B. Estética de la cotización — ✅ HECHO Y EN PRODUCCIÓN (20/08/2026)

Commits `4643110` → `fa5e5a9` → `5a16142`.

### 🔴 La fuga del margen — CERRADA

Era lo más urgente de todo el documento. Con un cliente elegido, la tarjeta mostraba adentro
`Profit cliente: 120%` y, en los clientes por kilo, el flete rotulado como
`6.0 kg × USD 5.00`. Como la oficina manda las cotizaciones **sacándole una imagen a esa
tarjeta**, eso era el margen negociado yéndose al cliente. Pudo haber pasado.

Ahora los dos datos viven en una **tira interna** arriba de los resultados, marcada "Solo
para la oficina", fuera de las tarjetas. `test-pantalla-tarifa-kg` los verifica en la tira
**y** verifica que NO estén en la tarjeta.

### Lo que quedó definido y construido

- **Logo:** Exportalo **salió del cotizador** — deja de existir como marca y todo pasa a
  Nova Express. Ya no hay selector de empresa: una sola tilde "logo de Nova", prendida.
- **Ubicación del logo:** se decidió con los logos reales a la vista (era lo que faltaba
  desde el 29/07). Felipe eligió **marca de agua tenue detrás + franja al pie con logo y
  contacto**. Descartó el logo en el encabezado.
- **Nombre del cliente:** opcional, se completa solo con el cliente elegido. Va **arriba en
  la franja de color, solo el nombre y en negrita** (sin "Cotización para").
- **Fecha y validez:** opcional, apagada por defecto, **15 días**. Va **al pie, al lado del
  logo, en el mismo gris que el contacto**. Si apagan el logo pero dejan la validez, la
  franja aparece igual: si no, la validez se perdía en silencio.
- **Jerarquía (pedido del padre de Felipe):** el renglón dice
  **"Nova Express – UPS Worldwide Expedited"**, con Nova apenas más firme y el courier en
  gris y tipografía normal — *lo que tiene que llamar la atención es la empresa, no el
  servicio*. El **peso facturable va resaltado** en la línea de medidas, por ser el dato que
  decide el precio. El logo del pie es grande (36 px).
- **Desde el 24/08 (`6fae32c`, `0f8a0d2`):** el contacto de la franja del pie es el
  **WhatsApp +54 9 11 6500-2047** (nunca un mail — hay test que lo cuida), y la línea de
  datos lleva el **FOB declarado** cuando es mayor a 0 (`… · FOB USD 500.00`), en la
  tarjeta y en la imagen, del mismo objeto.

### Cómo está hecho el dibujo, para el que lo toque después

La imagen **se dibuja de cero en un canvas**, NO es una captura del HTML. Es a propósito: es
lo que garantiza que no se cuele nada de la pantalla de trabajo, empezando por el profit.
La cabecera se mide **por distancia entre baselines**, no por cajas apiladas, y cada
constante tiene su nombre — se hizo así después de que quedaran renglones encimados.

---

## C. Botón "copiar cotización como imagen" — ✅ HECHO Y EN PRODUCCIÓN (20/08/2026)

**Un botón por tarjeta** (decisión de Felipe: copiar esa sola, como hacían recortando).
Deja el PNG en el portapapeles y se pega con Ctrl+V en WhatsApp. Sin portapapeles disponible
cae a descargar el archivo.

Verificado que se puede: la oficina entra por `sistema.novaexpress.com.ar` (HTTPS), y el
copiado de imágenes al portapapeles solo funciona en HTTPS o localhost. Si entraran por la
IP de la red local no se podría.

**Test:** `test-pantalla-cotizacion-cliente` (48 controles). Cubre que la imagen no lleve el
profit, que las opciones cambien el dibujo, y que la imagen **no recotice**: usa el mismo
objeto que pintó la tarjeta, así el papel no puede decir un número distinto de la pantalla.

---

## D. Cotizaciones en pesos — DECIDIDO, NO EMPEZADO

- Por defecto **siempre dólares**.
- Selector para pasar a pesos.
- **El tipo de cambio se carga en Configuración** (elección de Felipe), no se pregunta cada
  vez ni se busca de internet.
- **Los envíos se siguen guardando en dólares en la base, siempre.** Los pesos son solo para
  mostrar y para mandar. Si se guardaran pesos, el día que se mueve el dólar la base queda
  con dos monedas mezcladas y no cierra nada.

Es el más chico de los que quedan. Ahora se suma que la **imagen** también tendría que poder
salir en pesos.

---

## E. Registro de cotizaciones y **el precio acordado** — 🟡 ENTREGA 1 EN PRODUCCIÓN (24/08)

*Reescrito el 30/07 con el caso real que trajo Felipe; actualizado el 24/08 con la obra.*

### El caso que pasó

1. Asaplast pide cotizar una caja: **4 kg reales, 14 kg de volumen** según lo que informó
   el cliente. Se cotiza por 14 kg facturables.
2. El cliente **acepta y paga esa cotización**.
3. Llega la caja a la oficina, se arma y se mide de verdad: **da 10 kg de volumen**, no 14.
   O sea, se cobraron **4 kg de más**.
4. Avisarle o no al cliente es **decisión de Felipe**, caso por caso. Acá decidió dejarlo.
5. Administración carga el envío en Salidas — **bien cargado**, con las medidas reales — y
   usa el **cotizador automático**, que recalcula el precio con esos 10 kg.
6. Resultado: en el sistema quedó guardado el precio de **10 kg**, cuando el cliente pagó
   el de **14 kg**. Y la liquidación estaba por salir con ese otro número.

En palabras de Felipe: *"no es que pierdo plata, porque en este caso no se pierde plata,
pero hay plata que se pierde en el sistema."*

Y pasa **para los dos lados**: si se cotiza por 14 y la caja da 15, el sistema va a
registrar una venta mayor a la que se va a cobrar, porque Felipe eligió no reclamar ese
kilo.

### Dónde está la raíz

**El envío tiene un solo número donde tendría que haber dos.**

| | Qué es | De dónde sale |
|---|---|---|
| **Precio acordado** | Lo que el cliente aceptó y va a pagar | La cotización que se le mandó |
| **Precio recalculado** | Lo que ese bulto costaría hoy, con las medidas reales | El cotizador automático de Salidas |

El envío **tiene** que quedar cargado con las medidas reales — es lo que factura el
courier — pero no puede arrastrar el precio.

### ✅ Las 5 preguntas, RESPONDIDAS por Felipe el 24/08

1. **¿A qué clientes aplica?** → Solo si hubo cotización previa. Sin cotización, nada cambia.
2. **¿Quién marca la aceptada?** → Cualquiera de la oficina, pero queda quién y cuándo.
3. **¿Envío sin cotización previa?** → Sigue igual que hoy (es la mayoría).
4. **¿Umbral?** → No se fijó un umbral automático: el sistema **muestra las dos y la
   oficina elige**. Nunca decide solo.
5. **¿Se puede editar una aceptada?** → Sí, y queda el historial con quién y cuánto decía.

### ✅ ENTREGA 1 — HECHA Y EN PRODUCCIÓN (`cd84736`, 24/08)

Tablas **`cotizaciones`** + **`cotizacion_historial`**. El cotizador guarda con número
propio (**CTZ-n**) y vencimiento a 15 días — los mismos de la imagen, para que el papel y
el sistema no se contradigan. Lista con filtro por estado y botón **Aceptar** por opción.
Se puede cotizar a alguien que todavía no es cliente (queda el nombre).

**La regla que sostiene el módulo: el precio acordado NO SE TIPEA.** Al aceptar solo viaja
qué servicio eligió el cliente; el total lo saca el servidor de la opción guardada. Hay un
test que manda 9999 y verifica que se ignore. Más reglas: una EMITIDA se vence sola al
pasar la fecha, una ACEPTADA no (el cliente ya pagó ese precio — vencerla sería borrar el
acuerdo); una cotización atada a un envío no se puede borrar (es el respaldo de su precio);
la lista NO devuelve el desglose entero (adentro va nuestro costo y el profit — importa
para el día del link del punto A).

Se congela todo lo anotado: fuel usado y origen, profit aplicado, precio por kilo y modo
del cliente, zona, bultos con medidas. `entrada` y `opciones` son JSON.

**Tests:** `test-cotizaciones` (30) + `test-pantalla-cotizaciones` (19).

### 🔴 LO QUE FALTA

**La vuelta de tuerca (pedida por Felipe el 24/08, va ANTES de la entrega 2):** la lista
quedó abajo del cotizador y "no lo termina de convencer" — su casa es el **perfil del
cliente**: listado con datos básicos y un **desplegable que abra la misma tabla de la
cotización que se le envió**, para reenviarla si la vuelven a pedir. Es pantalla, no
modelo: los datos ya se guardan enteros.

**ENTREGA 2 — el enganche en Salidas:** al cargar un envío de un cliente con cotización
ACEPTADA sin usar, mostrar:

```
Precio acordado (CTZ-248, 14.0 kg facturables)             USD 201.04
Recalculado con las medidas reales (10.0 kg)               USD 152.30
Diferencia a favor de Nova                               + USD  48.74
```

…con botón para **dejarlo** o **ajustar al recalculado**. Queda quién decidió. Las
columnas de `envios` ya existen (`cotizacion_id`, `precio_acordado`, `precio_recalculado`,
`decision_precio`, `decision_usuario`, `decision_en`), todas NULL hasta esta entrega.
Beneficio extra: la diferencia acumulada por cliente es el *"tenés diez kilos a favor"*
que hoy Felipe lleva de memoria.

---

## F. Chatbot de cobranzas por WhatsApp (idea previa, sigue abierta)

Modelo del aguatero: QR → WhatsApp → "cuánto debés y cómo pagar".

**El bloqueante no es el bot: es que el sistema hoy no sabe cuánto debe nadie.** `cobranzas`
es un registro suelto sin vínculo con liquidaciones. Primero hace falta **cuenta corriente
por cliente**; después el bot.

Seguridad: el QR lleva un token por cliente; **nunca** que el bot pida un dato adivinable.

---

## G. Chatbot de la OFICINA sobre la base del sistema — 🟡 ENTREGA 1 CONSTRUIDA (14/09/2026)

Idea de Felipe: un asistente que trabaje con la base del sistema para la oficina — *"que
arme una cotización, que cargue un pick up, que consulte por alguna guía, cómo viene la
venta del día"*. Distinto del punto F (ese es para clientes y cobranzas; este es interno).

**Plan acordado con Felipe el 12/09:**

1. **Un solo motor**, adentro del sistema: entiende el pedido (cotizar, pickup, guía,
   venta del día) y llama a las mismas rutas de la API que usan las pantallas. Sin
   duplicar lógica: si el cotizador cambia, el bot cambia solo.
2. **Primero se prueba desde el sistema** con un panel de chat, con la sesión del usuario
   logueado (permisos incluidos).
3. **Después Telegram** como segundo canal del mismo motor — Felipe lo prefiere porque en
   el sistema *"no tiene tan fácil acceso desde el celular"*. Bot por BotFather; cada
   persona vincula su Telegram a su usuario del sistema con un código de una sola vez;
   nadie sin vincular recibe respuesta.
4. **Consultas primero** (guía, venta del día, cotizar: no tocan la base). Las **escrituras
   (cargar pickup) piden confirmación explícita** antes de guardar, y queda quién lo pidió.
5. WhatsApp queda para después: necesita la API oficial de Meta (número de empresa, costo
   por conversación). Telegram es gratis y se arma en el día.

Estimación: motor + panel en el sistema 2–3 días de trabajo; Telegram +1 día.

### ✅ ENTREGA 1 — construida el 14/09 (pendiente de clave, tests de Felipe, push y deploy)

**Decisiones de Felipe (14/09):** el motor entiende lenguaje natural **con IA (Claude, por la
API de Anthropic)** — no comandos fijos; entran las cuatro consultas (guía, venta, cotizar,
pendientes) **y también la carga de pickup**, con confirmación.

**Lo construido:**
- **`backend/src/services/bot.service.js`** — el motor. Recibe el mensaje, lo manda al
  modelo con las HERRAMIENTAS, y cada herramienta llama a **las mismas rutas de la API que
  usan las pantallas, con la cookie de la persona** (`/api/envios?q=`,
  `/api/dashboard/analitica`, `/api/liquidaciones/cotizar`, `/api/pickups`,
  `/api/salud/resumen`, `/api/liquidaciones/pendientes`, `/api/clientes`). Sin lógica
  duplicada y con los permisos de siempre (un empleado sin `ver_dashboard` no saca la venta
  ni por el chat — hay test).
- **Herramientas:** `buscar_envios` · `venta_periodo` · `buscar_clientes` · `cotizar` ·
  `pendientes` · `proponer_pickup` · `confirmar_pickup` · `cancelar_pendiente`.
- **Escrituras en DOS pasos:** `proponer_pickup` valida y deja la ACCIÓN PENDIENTE en la
  conversación (no graba); `confirmar_pickup` graba solo si hay pendiente y la persona
  dijo que sí; "no" la descarta. En las notas del pickup queda *"Cargado por el asistente a
  pedido de <usuario>"* (la tabla `pickups` no tiene columna de usuario).
- **Cotizar no filtra el margen:** la ruta interna devuelve `precioBase`, `profitMonto`,
  `utilidad`, `precio_kg`…; lo que ve el modelo pasa por **lista blanca** (precio final,
  zona, surge, manejo, extras). El asistente no puede repetir el margen ni queriendo — hay
  test que lee el `tool_result` guardado.
- **Sin clave, sin asistente:** `ANTHROPIC_API_KEY` en el `.env` de la RAÍZ del repo (el
  mismo de las UPS_*). Sin clave, `/api/bot/estado` dice `sin_clave` y el panel avisa.
  `BOT_MODELO` opcional (por defecto `claude-sonnet-4-5`). Llama a la API con `fetch`
  nativo: **sin dependencia nueva** en `package.json`.
- **`BOT_MOCK=1`:** un motor de mentira, determinista, que reconoce el pedido por patrones y
  usa LAS MISMAS herramientas. Es para las tandas: prueban el circuito entero sin clave,
  sin red y sin gastar. NO prueba cuán bien entiende el modelo de verdad.
- **Persistencia:** tablas `bot_conversaciones` (usuario, canal, `accion_pendiente`) y
  `bot_mensajes` (bloques en el formato de la API: texto / tool_use / tool_result).
  Migración `migrateBot` + `schema.sql` (los dos lados; check-schema verde con base de
  cero). Cada uno ve SUS conversaciones; el admin ve todas.
- **Rutas:** `GET /api/bot/estado` · `POST /api/bot/mensaje {texto, conversacion_id?}` ·
  `GET /api/bot/conversaciones` · `GET /api/bot/conversaciones/:id`. Detrás de
  `requireAuth`, como todo.
- **Panel:** `pages/asistente.html` + `js/modules/asistente.js` + `css/modules/asistente.css`
  — lista de conversaciones a la izquierda, chat a la derecha, cartel ámbar mientras hay
  una carga pendiente de confirmar, sugerencias para arrancar, Enter envía. Ítem
  **"Asistente"** en el menú de las 17 pantallas (después de Cotizador). En el teléfono la
  lista se esconde y el chat ocupa todo.
- **Tandas:** `test-bot` (**44**, puerto 3930, en `test`) y `test-pantalla-asistente`
  (**26**, puerto 3929, en `test-pantallas`); atajo `npm run test-bot`.

### ✅ ENTREGA 2 — el asistente por TELÉFONO, en modo prueba (15/09)

Felipe: *"si no está en WhatsApp no va a terminar siendo tan útil como debería... la
verdadera gracia sería que esté al tiro de cualquiera y se pueda usar desde cualquier
teléfono"*. Acordado: se arma el canal completo **en modo prueba**, y cuando funcione bien
se enciende WhatsApp.

- **`backend/src/services/bot-canales.service.js`** — la puerta de los canales:
  - **VÍNCULOS.** Un teléfono contesta solo si está atado a un usuario del sistema. El
    código lo saca la persona desde el panel (Asistente → Teléfonos), dura **15 minutos**,
    es de un solo uso y se manda por el canal. Sin vínculo activo, lo único que devuelve el
    bot es *"no te tengo vinculado"*: ni un dato, ni un "no encontré esa guía".
  - **PERMISOS.** Por teléfono no hay sesión, así que se abre una **sesión efímera** (5
    min) del usuario del vínculo, se usa y **se borra siempre** (`finally`). Resultado: el
    que escribe por WhatsApp puede exactamente lo mismo que en las pantallas — hay test con
    una empleada sin `ver_dashboard` que no saca la venta ni por el chat.
  - **HILO.** Se sigue la última conversación de ese canal si es reciente (**6 h**); si no,
    una nueva. Es lo que hace que el "sí" que confirma un pickup caiga donde tiene que caer.
  - Tope de **60 mensajes por hora** por vínculo y teléfonos guardados normalizados (solo
    dígitos), mostrados tapados en la lista (`…2047`).
- **El canal `prueba`**: no entrega a ningún lado, pero entra por la **misma función**
  (`recibirMensaje`) que van a usar Telegram y WhatsApp. El panel tiene un **simulador**
  ("Escribiendo desde: el sistema / 📱 simulador de teléfono") que escribe por ahí. Lo que
  se prueba hoy es el camino de verdad; lo único que falta encender es el último paso.
  ⚠ El simulador **fuerza** el canal de prueba y el teléfono del usuario logueado: si
  aceptara el que le manden, cualquiera con sesión podría hacerse pasar por el teléfono de
  otro y contestar con SUS permisos.
- **Webhooks** (`routes/bot-webhook.js`), único grupo del asistente sin sesión: Telegram
  con secreto (en la URL o en su cabecera), WhatsApp con la verificación de Meta. **Si el
  canal no tiene su token en el `.env`, la ruta ni escucha (404).** Siempre contestan 200 y
  atienden aparte: si devolvieran error, Telegram y Meta reintentan el mismo mensaje y el
  asistente contestaría (y gastaría) cinco veces.
- **`audiencia` en las herramientas y en el vínculo** (`interno` | `cliente`): hoy todas son
  internas. Es la puerta para lo que quiere Felipe después — que un CLIENTE escriba por
  WhatsApp para ver su estado de cuenta y pagar: ese día sus herramientas se marcan
  `cliente` y el modelo ni ve las de la oficina.
- **Tabla `bot_vinculos`** (migración + schema.sql; check-schema verde con base de cero).
- **Tanda `test-bot-canales`** (**36**, puerto 3927, en `test`); `test-pantalla-asistente`
  26 → **37**. Cache **`?v=20260915a`**.

⏸️ **WHATSAPP EN PAUSA (15/09, decisión de Felipe):** *"esperemos una semanita que la gente
lo vaya probando a ver si le sirve, si no le sirve, si se tiene que agregar algo o no"*. No
arrancar el trámite de Meta hasta nuevo aviso.

**Para encender WhatsApp (cuando Felipe quiera):** cuenta de Meta Business verificada +
número dedicado + `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_VERIFY_TOKEN` en el
`.env` y el webhook apuntado a `https://sistema.novaexpress.com.ar/api/bot/webhook/whatsapp`.
**Costo:** las respuestas dentro de la ventana de servicio de 24 h (la persona escribe
primero) **no se cobran**; solo se cobran las plantillas, que este bot no usa. El trámite de
verificación de Meta es lo lento (días a semanas). Telegram es lo mismo pero gratis y en el
día: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRETO`.

**Lo que falta para usarlo en serio:** (1) Felipe saca una clave en console.anthropic.com y
la pone en el `.env` del servidor (`ANTHROPIC_API_KEY=sk-ant-…`) + `pm2 restart nova
--update-env`; (2) probarlo a mano con pedidos reales de la oficina y ajustar el system
prompt / las descripciones de las herramientas con lo que no entienda; (3) Telegram
(etapa 2): mismo motor, `canal='telegram'` ya previsto en la conversación; (4) más
escrituras solo cuando Felipe las pida, siempre en dos pasos.

---

## Orden acordado

1. ~~Terminar bugs y pendientes~~ ✅ (auditoría cerrada el 18-20/08)
2. ~~Estética de la cotización + botón de copiar imagen + la fuga del profit~~ ✅ **20/08**
3. ~~El registro de cotizaciones (E, entrega 1)~~ ✅ **24/08**
4. **Cotizaciones en el perfil del cliente** (la vuelta de tuerca de E)
5. **El precio acordado en Salidas** (E, entrega 2)
6. El link para clientes (A)
7. Los pesos (D)
8. **El chatbot de la oficina (G) — ENTREGA 1 construida el 14/09** (Felipe lo priorizó por delante de la estética de Liquidaciones)

---

## H. El sistema de gestión contable — PLANTEADO (15/09/2026)

Felipe: *"ya está llegando el momento de ponernos a crear el sistema de gestión contable,
quizá la semana que viene te puedo pasar el GECOM y lo analizás para entender de qué se
trata"*. **Pendiente: que Felipe pase el GECOM** (capturas, exportaciones, el plan de
cuentas que usan) para entender qué reemplaza y qué no.

**Lo que ya se sabe que va a hacer falta**, porque el sistema hoy no lo tiene:
- **Cuenta corriente por cliente**: `cobranzas` es un registro suelto, sin vínculo con las
  liquidaciones. Sin eso no hay estado de cuenta, y sin estado de cuenta no hay ni bot de
  cobranzas (punto F) ni "pagá acá".
- Asientos / libro diario, y la conciliación contra lo que factura ARCA.

### Los pagos automáticos desde el banco — lo averiguado el 15/09

Pregunta de Felipe: *"vincular las APIs de los bancos para que los pagos se registren
automáticamente, ¿es posible?"*. **Sí, pero no hay un solo camino y ninguno es "prendé la
API del banco":** en Argentina el open banking **no es obligatorio**, así que cada banco da
(o no da) acceso por convenio. Las opciones reales, de menos a más trabajo:

1. **Importar el extracto** (CSV/TXT/Excel bajado del homebanking) y conciliarlo contra la
   cuenta corriente. No depende de nadie, funciona con cualquier banco y es el 80% del
   beneficio. **Es por donde conviene empezar.**
2. **Cobro online con un agregador** (Mercado Pago es el más accesible: API pública y
   webhook por cada pago). Ahí el pago entra **identificado**, se registra solo y es lo que
   hace posible el "link para pagar" que quiere Felipe. Cobra comisión.
3. **API del banco** (algunos bancos tienen; otros solo Interbanking/Datanet, que es un
   servicio pago para empresas). Da el movimiento en el momento, pero hay que pedirlo,
   firmar convenio y que el banco lo habilite para esa cuenta.
4. **Una cuenta/CVU o alias por cliente**, para que cada transferencia venga con el nombre
   puesto y la conciliación no dependa de adivinar quién pagó.

**LOS BANCOS, RESPONDIDO (15/09):** Nova trabaja con **Banco Galicia** y **Mercado Pago**.
Los dos tienen API, pero se consiguen de manera muy distinta:

- **Mercado Pago** — API pública, la clave se saca sola desde el panel de desarrollador, y
  manda un **webhook por cada pago**. Se puede hacer en el día, sin pedirle permiso a nadie.
  Es por donde conviene empezar.
- **Banco Galicia — "Open Galicia"** — tiene justo las dos que hacen falta: **consulta de
  saldos** y **movimientos de la cuenta** (créditos y débitos automatizados), más una de
  **cobranzas integradas** (alta de clientes para "Pago a Cuenta" y seguimiento por QR,
  echeq, transferencia y efectivo) y un evaluador crediticio. Se pide desde **Office Banking
  con un usuario DEVELOPER** (o que lo cree el administrador), y **producción exige SSL
  mutuo** (certificado, no una clave suelta). La de cobranzas **requiere convenio firmado
  con el oficial de cuenta**. O sea: es trámite con el banco, no "sacar una clave".
  Catálogo: https://www.galicia.ar/content/dam/galicia/banco-galicia/empresas/open-galicia/catalogoopengalicia.pdf

**Orden sugerido:** Mercado Pago primero (se hace solo) + pedirle a la vez al oficial de
cuenta de Galicia el acceso a Open Galicia, que es lo que tarda. La importación de extracto
(opción 1) sigue siendo la red de seguridad mientras tanto.

### Cómo entender el GECOM — acordado el 15/09

Felipe: *"tendríamos que verlo un día que estemos en la oficina... está en una sola
computadora, que no es la mía"*. Y la advertencia que manda sobre todo lo demás:
*"tiene que estar muy, muy bien hecha, por el tema de que es justamente donde pasa la plata
y lo que más controles tiene que tener"*.

Tres caminos, y el plan es el **mix** (2 + 3 ya; 1 si se puede):

1. **Linkear ESA computadora** a una sesión (app de escritorio de Claude instalada ahí y la
   carpeta del GECOM conectada). Es lo más completo: se ven los archivos de datos y se
   deduce el modelo entero. Depende de poder instalar algo en esa PC.
2. **Capturas + exportaciones.** Fotos o capturas de cada pantalla que Leandro usa en un día
   normal (el menú, y cada pantalla donde carga algo), más **una exportación real** de los
   listados que imprime (Excel/CSV/TXT). Con eso se saca el circuito y el modelo de datos
   sin tocar la máquina.
3. **Cuestionario a Leandro**, que es el que se encarga de las cobranzas: cómo trabaja HOY y
   cómo le gustaría trabajar. Es indispensable igual: el GECOM cuenta qué hace el sistema
   viejo, no qué necesita la oficina — y este módulo se hace una sola vez.

⚠️ **El requisito previo no cambia:** sin **cuenta corriente por cliente** no hay estado de
cuenta, y sin estado de cuenta no hay conciliación, ni bot de cobranzas, ni "pagá acá".
Sea lo que sea que haga el GECOM, eso va primero.

---

## I. Bot multiplataforma con pase a un humano — PLANTEADO (15/09/2026)

Felipe cuenta que un amigo con una fábrica **paga USD 100 por mes** por un bot que le lee
los mensajes de **Instagram y WhatsApp** y le contesta **Mercado Libre**, y que **deriva la
conversación a un comercial** cuando vale la pena: *"una especie de filtro antes de que
llegue al comercial"*. Pregunta si lo podemos hacer nosotros.

**Sí, y el motor ya está hecho.** Es el mismo `bot.service` del punto G: cambia la cara, no
el cerebro. Lo que falta:

- **Los canales.** Instagram usa la **API de mensajes de Instagram** de Meta: cuenta
  profesional + página de Facebook + **la misma verificación de Meta Business que
  WhatsApp**, así que conviene hacer los dos trámites juntos. Mercado Libre tiene su propia
  API de preguntas y mensajes (Felipe no la necesita: no vende ahí).
- **La audiencia `cliente`.** Ya está previsto el campo, pero hoy TODAS las herramientas son
  internas. Un cliente no puede tener cerca la venta del día, el profit ni los pendientes:
  hay que definir qué herramientas ve y con qué lista blanca, con el mismo criterio del
  cotizador (nunca costo ni margen).
- **El pase a un humano.** Una marca en la conversación que **silencia al bot** para ese
  contacto y avisa a la oficina con el historial; y la vuelta atrás cuando se resuelve. Sin
  eso el bot se queda hablando encima de un vendedor.

**Costo real:** Meta no cobra las respuestas dentro de la ventana de 24 h (la persona
escribe primero); se paga la API de Claude por mensaje (centavos) y el VPS que ya existe.
Los USD 100 del amigo son casi todo margen de quien se lo vende.

**Cuándo:** después del punto H. Felipe lo dejó anotado *"para un futuro"*, no para ahora.
