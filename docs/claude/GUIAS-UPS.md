# Guías y proformas automáticas — UPS primero, DHL después

**Creado 04/09/2026.** Pedido de Felipe: *"empecemos a desarrollar la optimización del armado
de guías y proformas: no solo automatizaría el armado de guías, sino que también lo
vincularía con la carga de envíos, cosa de facilitar la carga a Salidas"*. Primero UPS,
DHL en el futuro. Cuentas UPS: una de **expo**, una de **impo**, una de **vinos** (casi no
se usa: **afuera por ahora**).

Estado: **✅ ETAPAS 1 Y 2 CONSTRUIDAS (08/09, tarde) — falta probarlas contra UPS de
verdad desde la máquina de Felipe y desplegar.** Ver la sección 7 (qué se hizo, cómo se
prueba, qué falta). Antes: **✅ ETAPA 0 CERRADA (07/09, 17:30).** La app emite guías: `ups-shipping-prueba.js`
creó una guía de prueba Bella Vista → Miami en el entorno de test (200 OK, etiqueta GIF
1400×800 "SAMPLE", guía `1ZXXXXXXXXXXXXXXXX` que es el comodín del entorno de test). Lo que
enseñó: `Shipment.Description` **máximo 50 caracteres** (error 120503); la respuesta trae
`ShipmentCharges` desglosado — base 452,40 + código **375 (fuel) 167,18** + **573 (IPF)
2,50** + **434 (surge)** 2,50 = 624,58 USD, **a tarifa de lista** (el entorno de test no
aplica la negociada) — y `BillingWeight`. Con `RequestOption: 'nonvalidate'` no pidió
InternationalForms para AR → US con `InvoiceLineTotal` cargado. El `.env` de la máquina de
Felipe tenía valores de ejemplo (no las credenciales): se cargaron el 07/09 desde el portal.
Nada del módulo implementado todavía: sigue la **Etapa 1** (datos).

**07/09, tarde — Shipping habilitado.** Felipe entró a developer.ups.com (la cuenta
corporativa de Daniluk rebota a CampusShip: se entra por el link "UPS Developer Portal"
del pie de CampusShip) → My Apps → **"Nova Express Tracking"** (creada 06/02/2026,
`administracion@novaexpress.com.ar`, cuenta de facturación 327W09) → Edit App → sumó
**Shipping** y **Rating**. Los dos quedaron **aprobados en Test y Prod al instante**. Ahora
la app tiene Rating · Tracking · OAuth · Shipping. **Las mismas credenciales del `.env`
sirven.** Siguiente paso: correr `backend/scripts/ups-shipping-prueba.js` en la máquina de
Felipe (el contenedor no llega a wwwcie.ups.com): crea una guía de prueba Bella Vista →
Miami en el entorno de test y deja pedido/respuesta/etiqueta en `backend/ups-prueba/`.

**Cuentas UPS (Felipe, 07/09): EXPO `327W09` · IMPO `3R6A45`.** Van al `.env` como
`UPS_CUENTA_EXPO` / `UPS_CUENTA_IMPO` cuando arranque el módulo. (Coinciden con los
prefijos de guía `1Z327W09…` y `1Z3R6A45…` que ya se ven en las facturas.)

---

## 1. Cómo lo hace hoy la oficina (relato de una empleada de administración, 04/09)

En la página de UPS, "Crear envío", ocho pasos:

| Paso | Qué cargan | Observaciones de la oficina |
|---|---|---|
| 1. Destinatario | UPS ofrece perfiles precargados; si es nuevo: nombre, contacto, país, dirección líneas 1-2-3, CP, localidad/estado, teléfono, mail | **Cuando UPS no da campo para el CUIT/tax id, lo meten en una línea de dirección** |
| 2. Remitente | Lo mismo que el destinatario, "con gastos del remitente" | Los mismos datos sirven para la dirección de devolución |
| 3. Qué se envía | Cantidad de bultos, tipo de empaque (**siempre "otro tipo"**), peso, medidas (**opcionales, casi nunca las ponen**), valor declarado (**solo si supera USD 100**) | Con más de 1 bulto la página pregunta si son todos iguales: **siempre dicen que sí aunque no lo sean**, porque "distintos" pide el valor declarado por caja, que solo 1 o 2 clientes dan (Cueros Santa Cruz) |
| 4. Servicio | Saver o Expedited | |
| 5. ? | No hacen nada | |
| 6. Facturación | Si es **DDP**: "factura a destinatario o algo así"; si **no** es DDP: la cuenta de Daniluk | ⚠️ **Confirmar con la oficina qué opción exacta eligen en cada caso** — el relato suena invertido (en DDP los impuestos los paga el remitente) y en UPS este paso tiene DOS preguntas: a quién se facturan los **gastos de envío** y a quién los **aranceles e impuestos** |
| 7. Recolección | No hacen nada (la recolección está arreglada directo con UPS por la oficina) | |
| 8. Proforma | No hacen nada: **Nova hace sus propias proformas** | Excepción: **PIO Álvarez**, que sí sale por la página de UPS (motivo desconocido) |

Felipe: *"no significa que sea la forma correcta o la más óptima"*.

## 2. Lo que eso destapa

1. **La guía se tipea a mano en el sistema después de crearla en UPS.** De ahí salieron las
   9 guías mal tipeadas de julio (`AUDITORIA-FACTURAS-JULIO.md`). Si la guía la genera el
   sistema, ese error desaparece.
2. **El envío del sistema no tiene destinatario ni contenido.** Hoy `envios` guarda
   cliente, país, peso, medidas, FOB, servicio, DDP y bultos. Para una guía hacen falta
   además: destinatario completo (nombre, contacto, dirección, CP, ciudad, estado,
   teléfono, mail, tax id), remitente completo (el cliente tiene `cuit`, `contacto`,
   `email` y `direccion_recoleccion`, pero no teléfono ni la dirección partida en
   calle/CP/ciudad) y una **descripción de la mercadería**.
3. **La trampa de "todos los bultos iguales"** existe porque la página exige valor por
   caja. El sistema YA tiene peso y medidas por bulto (`envio_bultos`) y el FOB total;
   por API se puede mandar cada bulto con su peso real y repartir el valor declarado
   proporcional al peso, sin preguntarle nada a nadie. Mejor dato para UPS, mismo
   trabajo para la oficina.
4. **Las medidas casi nunca se cargan en UPS** → UPS factura el peso que mide él. En el
   sistema las medidas sí están (Salidas las exige), así que la guía saldría con el
   volumétrico correcto desde el vamos y la factura tendría menos sorpresas.
5. **Nova hace sus propias proformas.** Falta ver UNA (plantilla, qué campos lleva, quién
   la firma) para generarla desde el sistema con los mismos datos de la guía.

## 3. El camino: la API de Shipping de UPS, no un robot sobre la página

El sistema **ya habla con la API de UPS** (`backend/src/services/ups.service.js`: OAuth
con `UPS_CLIENT_ID / UPS_CLIENT_SECRET` del `.env`, hoy solo para tracking del semáforo).
UPS tiene la **Shipping API** que hace lo mismo que los ocho pasos: recibe remitente,
destinatario, bultos, servicio, cuenta, facturación y datos aduaneros, y devuelve **número
de guía + etiqueta (PDF/GIF/ZPL) + documentos**. Ventajas frente a un robot que aprieta
botones en ups.com: no se rompe cuando UPS cambia la página, corre en el servidor, deja
todo registrado y es gratis.

Lo que hay que confirmar antes de escribir una línea del módulo (**Etapa 0**):
- Que la app de UPS de Nova tenga habilitado el producto **Shipping** (en
  developer.ups.com → la app → productos). Si no, se habilita ahí mismo.
- ✅ Los **números de cuenta** de expo y de impo — arriba (07/09).
- Una guía de prueba en el **entorno de test de UPS** (`wwwcie.ups.com`): no genera
  cargos ni guías reales. Con eso se ve qué campos exige para Argentina → exterior.

## 3-bis. EL DISEÑO (08/09, después de pensar los escenarios de la oficina)

Pedido de Felipe: *"antes de armar algo, analizá cuál sería la mejor forma, pensando
distintos escenarios y optimizando el trabajo de administración"*.

### Los escenarios que manda la oficina
| # | Escenario | Qué le duele hoy | Qué lo arregla |
|---|---|---|---|
| A | **Cliente habitual, mismo destinatario** (Cueros, La Martina…): el grueso del volumen | Tipear el destinatario en UPS cada vez, tipear la guía después en el sistema, armar la proforma en Excel | Libreta: se elige y listo. **"Repetir último envío"** a ese destinatario (mismo contenido, solo cambian pesos). Guía y proforma salen del mismo dato. |
| B | Destinatario nuevo | Cargarlo dos veces (UPS y proforma) | Se carga UNA vez en la libreta, con el tax id en su campo. |
| C | **Multibulto con pesos distintos** | La página obliga a decir "todos iguales" (pide valor por caja) | La API manda cada bulto con su peso y medidas; el valor declarado se reparte proporcional al peso, sin preguntar nada. |
| D | **Pesos declarados distintos de los reales** (práctica de la oficina) | Se pierde la trazabilidad | La guía guarda lo DECLARADO (`guias_ups`); el envío guarda lo REAL. Se confirman los reales al pasar a Salidas. |
| E | Cliente que hace su propia proforma (PIO Álvarez, por UPS) | — | La proforma del sistema es opcional: "no generar" o adjuntar la del cliente. |
| F | **DHL y envíos cargados a mano** | Hoy la proforma también es a mano | **La proforma NO depende de la API**: sale para cualquier envío con destinatario y contenido, DHL incluido. Es el primer beneficio, y llega antes que la guía. |
| G | Importación (cuenta 3R6A45) | — | Misma libreta con el remitente en el exterior; Etapa 4. |
| H | UPS rechaza la guía (dirección, tax id, descripción > 50) | Hoy el error lo ve quien está en CampusShip | El sistema muestra el mensaje de UPS tal cual, se corrige y se reintenta. Un envío que al final no salió: **anular la guía** (void) desde el mismo lugar. |
| I | El envío arranca en una cotización aceptada | Se recarga todo | "Cargar envío" ya toma la cotización; el destinatario se suma ahí. |
| J | Impresión | Dos hojas en A4, unificar a mano | Botones **Etiqueta térmica (ZPL)**, **Guía A4 (una hoja)** y **Proforma (3 copias)**. |

### ⚠️ LA REGLA (Felipe con administración, 08/09) — reemplaza a la propuesta de abajo
Textual: *"que la generación de las guías y la carga a Salidas sean dos pasos diferentes...
un módulo de generación de guías que te entregue guía y proforma ya hecha y que eso quede
semi guardado en la parte de carga de envíos para que después, al fin del día,
administración entre a esa parte y revise qué hay para cargar, modifique lo que tenga que
modificar, agregue algo si hace falta y confirme la carga envío por envío a Salidas."*
- **Módulo "Guías"** (pantalla propia): cliente → destinatario (libreta) → contenido y
  renglones → bultos → servicio → Emitir. Devuelve guía + etiqueta + proforma y deja el
  envío en **precarga**. NO va a Salidas.
- **"Precargas"** en Cargar envío: la lista de lo semi-guardado. Se abre cada una con el
  formulario completo, se corrige, se agrega, y **Confirmar** la pasa a Salidas una por una.
  Si la guía estaba mal, desde ahí se anula (void) o se reemite.
- Proforma y etiqueta quedan pegadas al envío, imprimibles desde Precargas y Salidas.
(La sección siguiente era mi propuesta previa de hacerlo dentro de Cargar envío; queda como
análisis, pero manda la regla de arriba.)

### La propuesta previa (superada): la guía nace en "Cargar envío"
"Cargar envío" ya pide cliente, courier, servicio, país, bultos (peso y medidas), FOB, DDP y
calcula la venta. Una pantalla "Guías" aparte obligaría a cargar lo mismo dos veces o a
mantener dos formularios iguales. Entonces:
- **"Cargar envío" suma un bloque "Destinatario y contenido"**: destinatario de la libreta
  (o nuevo), descripción de la mercadería y los renglones de la proforma (cantidad,
  descripción, valor unitario; el FOB se calcula de ahí si se cargan). El **país sale del
  destinatario**. Para DHL o carga manual el bloque es opcional (pero si se completa, sale la
  proforma).
- **Dos botones al pie**: **"Guardar"** (como hoy) y, con courier UPS, **"Emitir guía UPS y
  precargar"**: llama a la API, guarda guía + etiqueta + lo declarado en `guias_ups`, escribe
  `numero_guia` solo, y deja el envío en estado **PRECARGA** (`envios.precarga = 1`).
- **Precargas**: una lista propia (misma lógica que Pendientes de Liquidaciones: que no se
  pase nada de largo) con botón **"Confirmar"**, que abre el envío para corregir pesos y
  medidas reales, venta, seguro, y lo manda a Salidas. Hasta entonces no aparece en
  Salidas, liquidaciones, cierre ni control de facturas.
- **"Repetir último envío"** desde el perfil del cliente / la libreta: clona destinatario,
  contenido, servicio y DDP; pide solo bultos.
- **Panel "Documentos" del envío** (en Precargas y en el modal de Salidas): etiqueta térmica,
  guía A4, proforma. La proforma con numeración propia del sistema (**a confirmar con
  Felipe: hoy el Nº lo pone la oficina, ¿de dónde sale?**).

### Orden de construcción (cada paso sirve solo)
1. **Datos + proforma** (sirve para TODOS los envíos, DHL incluido): libreta, remitente
   completo, contenido/renglones, PDF de proforma con los mismos campos que la de la oficina.
2. **Guía UPS desde Cargar envío + precarga + lista Precargas + etiqueta térmica/A4.**
3. Void, repetir último envío, paperless para PIO Álvarez.
4. Impo por la misma vía; DHL cuando haya API.

## 4. Las etapas (propuesta)

### Etapa 0 — La prueba de la API (medio día)
Guía de test Buenos Aires → Miami con la cuenta de expo, un bulto, Saver. Si sale, el
resto es cuestión de datos. Si la app no tiene Shipping o UPS pide algo raro de la
cuenta, lo sabemos ahí y no después.

### Etapa 1 — Los datos que faltan en el envío (1-2 días)
- **Libreta de destinatarios por cliente** (`destinatarios`): lo mismo que los perfiles
  de UPS pero en el sistema. Nombre, contacto, país, dirección 1-3, CP, ciudad, estado,
  teléfono, mail, **tax id en su propio campo** (la API sí tiene lugar para eso; se
  acabó meterlo en la dirección). Se elige de la lista o se carga nuevo al cargar el
  envío; queda guardado para la próxima.
- **Remitente completo por cliente**: teléfono, mail, dirección partida (calle, CP,
  ciudad, provincia). Hoy `clientes` tiene `cuit`, `contacto`, `email` y una dirección
  en texto libre.
- **Contenido** del envío (descripción de la mercadería) y, si lo dan, valor por bulto.
- Todo esto también sirve para la proforma.

### Etapa 2 — El botón "Generar guía UPS" en el envío (3-4 días con pruebas)
- Toma del envío: cuenta según **expo/impo**, servicio (**Saver / Expedited**), bultos
  con el peso y las medidas que se DECLARAN (la oficina decide; ver 4-bis), empaque "otro tipo", valor declarado si FOB > 100, DDP →
  facturación de impuestos según lo que confirme la oficina, remitente y destinatario
  de la libreta, contenido.
- Devuelve **la guía y la etiqueta**: la guía se escribe sola en `numero_guia` (nada de
  tipear), la etiqueta queda guardada en el envío e imprimible; el envío queda como
  **PRECARGA** hasta que alguien lo confirma (ver 4-bis) — no viaja directo a Salidas.
- Guarda **qué mandó y qué contestó UPS** (`guias_ups`), para cuando haya que discutir
  una factura.
- Anular una guía (void) desde el mismo lugar, para el envío que al final no salió.
- Nada de recolección (paso 7): no se toca.

### Etapa 3 — La proforma del sistema (1-2 días, cuando veamos una)
PDF propio con los datos del envío y la libreta, igual a la que hacen hoy. PIO Álvarez:
ver por qué va por UPS; la API tiene "paperless" para subir la factura comercial, se
evalúa después.

### Etapa 4 — Impo por la misma vía; DHL más adelante
La cuenta de impo usa la misma API con el remitente en el exterior. DHL tiene su propia
API (MyDHL API) y hoy no hay credenciales (pendiente viejo).

## 4-bis. El flujo: guía → PRECARGA → confirmar → Salidas (regla de Felipe, 04/09)

Textual: *"en vez de que viaje directamente el envío a Salidas, que se pueda ver la
precarga y recién ahí confirmarla... por lo general en la guía se ponen pesos más chicos de
los que verdaderamente son... que no sea directo, pero que ya esté precargada toda la info
posible que se pueda absorber del armado de la guía"*.

- **Crear la guía NO carga el envío en Salidas.** Deja un envío en estado **borrador /
  precarga** con lo absorbido de la guía: cliente, destinatario, país, servicio, DDP,
  bultos con peso y medidas **declarados**, FOB, número de guía y etiqueta.
- Alguien entra al envío, ve todo, **corrige pesos y medidas reales**, suma lo que falte
  (venta, seguro, etc.) y con **"Confirmar"** pasa a Salidas. Hasta entonces no aparece
  en Salidas, ni en liquidaciones, ni en el cierre, ni en el control de facturas.
- **Lo declarado a UPS queda congelado aparte** (tabla `guias_ups`: request y response,
  pesos y medidas declarados). Los datos reales viven en `envios` / `envio_bultos` como
  siempre. Cuando llega la factura se ven las tres cosas: declarado, real, medido por
  UPS. El control de facturas sigue comparando contra el peso REAL de Salidas — no cambia.
- **Lista "Guías sin confirmar"** a la vista (misma lógica que Pendientes de
  Liquidaciones del 04/09: que no se pase nada de largo).
- La guía declarada con menos peso es **práctica de la oficina, no del sistema**: se
  registra, no se corrige (regla cuatro). El sistema solo tiene que mostrar las dos
  cifras y no mezclarlas.

## 4-ter. Lo que confirmó la oficina el 07/09 (ESPECIFICACIÓN, regla cinco)

- **Paso 6 (facturación):** con **DDP**, los aranceles e impuestos se facturan a la cuenta
  **327W09 – DANILUK MARCELO ALEJANDRO** (o sea, los paga Nova y después se le liquidan al
  cliente: ver `DDP-IMPUESTOS.md`); **sin DDP**, "facturar al destinatario". El flete siempre
  a 327W09. En la API: `ShipmentCharge` tipo `01` (flete) = `BillShipper 327W09` siempre;
  tipo `02` (aranceles e impuestos) = `BillShipper 327W09` si DDP, `BillReceiver` si no.
- **Impresión:** usan las dos. **Térmica** para la etiqueta del bulto (en CampusShip, paso
  "Confirmación de envío" → "Imprimir documentos de envío" → tildan Etiqueta → acepta la
  térmica). **A4** para la guía y la proforma. Hoy, en A4, la guía sale en DOS hojas (la
  etiqueta + una hoja de leyendas de UPS) y la oficina las unifica a mano desde la
  configuración de impresión; por eso imprimen la térmica primero y la guía después.
  **Con la API esto se simplifica solo:** la respuesta trae la etiqueta como imagen (GIF/PNG,
  lo que vimos en la Etapa 0) o como **ZPL** para la térmica; el sistema puede armar un PDF A4
  de UNA hoja con la etiqueta (sin la hoja de leyendas) y ofrecer los dos botones: "Etiqueta
  térmica" y "Guía A4".

## 4-quater. La proforma de la oficina (muestra `Zappala 070926 UK.xlsx`, 07/09)

Un Excel de una hoja, título **COMMERCIAL INVOICE**, con: Nº y fecha (arriba a la derecha);
**Shipper** (nombre, CUIT/CUIL, dirección, CP, ciudad, país, teléfono, **contacto**) a la
izquierda y **Consignee** (nombre, dirección, CP, ciudad, país, teléfono, mail) a la derecha;
tabla de ítems **Quantity / Description of goods / Unit value / Total value** (rótulos en
inglés y castellano, total = cantidad × unitario, hasta 4 renglones + TOTAL USD);
**COUNTRY OF ORIGIN: ARGENTINA** y bloque **Manufacturer** (nombre, CUIT, dirección). Sin logo
ni firma. → Es exactamente la libreta de destinatarios + remitente completo + contenido de la
Etapa 1: con esos datos el sistema la genera igual (Etapa 3). El Nº de proforma lo pone la
oficina; ver de dónde sale (¿correlativo propio?).

## 5. Lo que necesito de Felipe para arrancar la Etapa 0

1. ✅ **Números de cuenta UPS** de expo y de impo — `327W09` / `3R6A45` (07/09).
2. ✅ **Shipping (y Rating) habilitados en la app el 07/09**, aprobados en Test y Prod.
3. ✅ Proforma recibida el 07/09 (ver 4-quater).
4. ✅ Paso 6 confirmado (07/09): ver 4-ter.
5. ✅ Impresión: térmica para la etiqueta, A4 para guía y proforma (07/09): ver 4-ter.

## 6. Códigos de servicio UPS (para no buscarlos después)

Internacional desde Argentina: **65 = Worldwide Saver**, **08 = Worldwide Expedited**,
07 = Worldwide Express, 54 = Express Plus. Empaque: **02 = Customer Supplied Package**
("otro tipo"). Etiqueta: `GIF` (pantalla/A4), `ZPL`/`EPL` (térmica), `PDF` vía
`LabelImageFormat`. Estos códigos se verifican contra la respuesta del entorno de test
en la Etapa 0 antes de darlos por buenos.

## 7. LO CONSTRUIDO (08/09) — etapas 1 y 2, siguiendo LA REGLA de 3-bis

### Qué hay
- **Datos (etapa 1).** Tablas `destinatarios` (libreta por cliente, tax id en su campo,
  borrado en blando `activo=0`) y `envio_items` (renglones de la proforma). `clientes` suma
  `telefono` y `provincia` (formulario de Clientes y perfil). `envios` suma
  `destinatario_id`, `contenido`, `proforma_numero`, `guia_id`. `POST/PUT /api/envios`
  aceptan `destinatario_id`, `contenido`, `proforma_numero`, `items[]`; `GET /envios/:id`
  devuelve `destinatario` e `items`. API de la libreta: `GET/POST /api/clientes/:id/destinatarios`,
  `PUT/DELETE /api/clientes/:id/destinatarios/:destId` (`?todos=1` trae los sacados).
- **Proforma.** `services/proforma.service.js`: `armarProforma(envioId)` /
  `armarProformaGuia(guiaId)` → JSON; `renderHtml()` → hoja A4 con el formato de la oficina
  (COMMERCIAL INVOICE, Nº, fecha, Shipper = el cliente con CUIT/dirección/CP/ciudad/
  provincia/teléfono/contacto, Consignee = destinatario, tabla Quantity/Description/Unit
  value/Total value con 4 renglones fijos, TOTAL USD, COUNTRY OF ORIGIN: ARGENTINA,
  Manufacturer = el remitente). Sin destinatario o sin renglones la hoja sale igual (un
  renglón con el contenido y el FOB) y avisa arriba (el aviso no se imprime). Rutas:
  `GET /api/envios/:id/proforma(.html)` y `GET /api/guias/:id/proforma(.html)`. Se abre en
  otra pestaña (la sesión va por cookie) con botón Imprimir; cabe en UNA hoja A4.
- **Módulo Guías (etapa 2).** Pantalla `pages/guias.html` (ítem "Guías" en el menú de
  todas las pantallas): cliente → remitente (avisa qué le falta al cliente, con link al
  perfil) → destinatario de la libreta (o "+ Nuevo" en un modal, país de la lista del
  cotizador) → contenido (≤ 50 letras, va a la guía) + Nº de proforma + renglones (el
  total es el FOB / valor declarado) → bultos (peso obligatorio, medidas opcionales) →
  servicio Saver/Expedited, DDP → **"Pedir guía a UPS"**. Resultado: número, botones
  **Etiqueta térmica** (página 4×6), **Etiqueta A4** (una hoja, tamaño real, centrada — no
  las dos hojas de la página de UPS) y **Proforma**. Pestaña "Guías del día" con estado
  (Para confirmar / Confirmada → envío #N / Anulada), documentos, Confirmar y Anular.
- **Backend del módulo.** Tabla `guias` (una fila por guía pedida: `datos_json` con
  bultos/items/país/observaciones, `request_json`, `response_json`, `etiqueta_gif` = JSON
  con un GIF base64 por bulto, `cargo_ups`, `estado` emitida/confirmada/anulada,
  `entorno` test/prod, `envio_id`). `services/ups-shipping.service.js` arma el pedido y
  llama a `POST /api/shipments/v2403/ship`; `models/guias.model.js` valida, emite,
  edita (solo mientras es precarga: proforma, contenido, renglones, FOB, nota), anula
  (`DELETE /api/shipments/v1/void/cancel/:guia`). Rutas: `GET /api/guias/configuracion`,
  `GET /api/guias?fecha=&estado=&cliente_id=`, `GET /api/guias/pendientes` (cada una con
  `envio` = el cuerpo listo para `POST /envios`), `POST /api/guias`, `GET/PUT /api/guias/:id`,
  `POST /api/guias/:id/anular`, `GET /api/guias/:id/etiqueta.gif?bulto=N`,
  `GET /api/guias/:id/etiqueta.html?formato=a4|termica`.
- **La precarga vive en `guias`, NO en `envios`.** Un envío existe recién cuando
  administración lo confirma; así ninguna consulta de Salidas / liquidaciones / cierre /
  facturas / dashboard / tracking tuvo que aprender a excluir precargas (eran 40 consultas
  sobre `envios`: un olvido = plata inventada). La columna `precarga` que se había pensado
  no existe.
- **Confirmar = Cargar envío de siempre.** En `pages/envios.html` aparece el panel
  **"Guías para confirmar"** (amarillo, arriba del formulario) con cada precarga
  (fecha, guía, cliente → destinatario, bultos, kg, FOB, DDP, links a etiqueta y
  proforma) y el botón **Cargar**, que llena el formulario (cliente, fecha, UPS + servicio,
  guía, país, bultos con pesos y medidas, FOB, DDP, observaciones) con el título
  "Confirmar guía 1Z… → Salidas". Administración cotiza, pone el precio, corrige lo que
  haga falta y **Guardar**: `POST /envios` con `guia_id` crea el envío (mismo motor de
  costos), copia destinatario/contenido/renglones/Nº de proforma, y la guía pasa a
  `confirmada` con `envio_id`. Una guía no se confirma dos veces (400), ni una anulada.
  `envios.html?guia=ID` abre directo esa precarga (link "Confirmar" del listado).
- **Lo que se le manda a UPS** (`armarPedido`): Shipper = **Nova** con la cuenta de expo
  (`UPS_CUENTA_EXPO`, default 327W09) y los datos del `.env` (`UPS_SHIPPER_NOMBRE`,
  `UPS_SHIPPER_ATENCION`, `UPS_SHIPPER_TELEFONO`, `UPS_SHIPPER_DIRECCION`,
  `UPS_SHIPPER_CIUDAD`, `UPS_SHIPPER_PROVINCIA` (código UPS, default B), `UPS_SHIPPER_CP`);
  ShipFrom = **el cliente** (dirección de recolección, CP, localidad, teléfono); ShipTo =
  el destinatario con `CountryCode` ISO-2 (`utils/paisesIso.js` traduce los nombres del
  cotizador; si no conoce el país pide el código de 2 letras), estado y CP obligatorios
  para EE.UU./Canadá, teléfono obligatorio (solo dígitos), `TaxIdentificationNumber`;
  `Description` = contenido recortado a 50; `Service` 65 Saver / 08 Expedited; `Packaging`
  02; un `Package` por bulto con `PackageWeight` KGS (mín. 0,1) y `Dimensions` CM solo si
  tiene las tres medidas; `InvoiceLineTotal` USD = FOB (mín. 1); `PaymentInformation`:
  cargo **01 BillShipper cuenta Nova** siempre, cargo **02 (duties) BillShipper cuenta
  Nova solo con DDP** — sin DDP no se manda el 02 y UPS le cobra al destinatario (regla
  4-ter "facturar al destinatario"); etiqueta `GIF`.
- **Entorno.** `UPS_SHIPPING_ENTORNO=test` (default) → `wwwcie.ups.com`, guías de PRUEBA
  (la pantalla lo dice en un chip amarillo y en cada documento: "no válida para
  despachar"). `UPS_SHIPPING_ENTORNO=prod` → `onlinetools.ups.com`, guías reales. El
  token OAuth se pide al host del entorno (uno de prod no sirve en test). El semáforo de
  tracking sigue con `UPS_API_BASE` (prod) como siempre. `UPS_SHIPPING_MOCK=1` (solo
  tests) no llama a UPS.

- **Perfiles de remitente por cliente (Felipe, 08/09: "hay clientes que cambian el nombre
  o algo de quien envía; todo tiene que poder cargarse un perfil totalmente nuevo").**
  Tabla `remitentes` (nombre, CUIT, dirección, CP, ciudad, provincia, teléfono, contacto,
  mail; borrado en blando). El perfil **principal es la ficha del cliente** y no se
  duplica: `GET /api/clientes/:id/remitentes` devuelve primero la ficha (`id: null,
  principal: true`) y después los perfiles; `POST/PUT/DELETE .../remitentes/:remId`.
  `remitentes.model.resolver(cliente, remitente_id)` da la forma única que usan la guía
  (ShipFrom), la proforma (Shipper y Manufacturer) y las validaciones. `guias.remitente_id`
  y `envios.remitente_id` (NULL = la ficha) viajan con la precarga al alta del envío. En
  la pantalla Guías: bloque "Remitente" con selector (la ficha marcada "(ficha del
  cliente)"), "+ Nuevo remitente" y "Editar" (solo para perfiles; la ficha se edita en el
  cliente). En el listado y en Cargar envío la guía muestra "rem. X" cuando no es la ficha.

### Tandas
`test-guias-datos.js` (44 checks, puerto 3935: cliente con teléfono/provincia, libreta,
envío con destinatario/contenido/items, proforma JSON y HTML, borrado en blando) y
`test-guias-emision.js` (82 checks, puerto 3933, con `UPS_SHIPPING_MOCK=1`: validaciones
sin llamar a UPS, emisión y lo que se manda — servicio, ShipTo, cargos con y sin DDP,
paquetes —, etiqueta GIF/HTML, proforma de la guía, la precarga NO es envío, editar,
confirmar por `POST /envios` con `guia_id`, doble confirmación, anular; perfiles de
remitente: alta/edición/borrado, guía y proforma con el perfil, precarga y envío con
`remitente_id`; pantalla: Guías emite con los modales de destinatario y remitente y
Cargar envío confirma la precarga). Las dos en
`npm test` (69 tandas).

### Lo que falta (en orden)
1. **Probar contra UPS de test desde la máquina de Felipe**: completar en `backend/.env`
   `UPS_SHIPPER_*` (dirección real de Nova, teléfono, CP, ciudad) y dejar
   `UPS_SHIPPING_ENTORNO=test`; emitir una guía desde la pantalla y mirar la etiqueta real
   (1400×800 apaisada: la hoja la rota sola) y los avisos de UPS. Si UPS pide algo más
   para algún país (InternationalForms, etc.) se ve ahí.
2. Cuando la oficina la use en serio: `UPS_SHIPPING_ENTORNO=prod` en el servidor y
   reiniciar. Sacar antes las guías de prueba (quedan marcadas `entorno='test'`).
3. Preguntar: ¿el **Nº de proforma** lo pone la oficina (correlativo propio, ej.
   79122210) o lo numera el sistema? Hoy es un campo libre. ¿En la guía UPS el Shipper
   tiene que ser Nova (cuenta) o el cliente? Hoy Shipper = Nova, ShipFrom = cliente.
4. ✅ Perfiles de remitente por cliente (hecho el 08/09, ver arriba).
5. Etapa 3: paperless (subir la proforma a UPS), repetir último envío, impo por la
   misma vía (cuenta 3R6A45), DHL cuando haya API.
