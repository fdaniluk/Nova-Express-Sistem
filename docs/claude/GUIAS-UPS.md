# Guías y proformas automáticas — UPS primero, DHL después

**Creado 04/09/2026.** Pedido de Felipe: *"empecemos a desarrollar la optimización del armado
de guías y proformas: no solo automatizaría el armado de guías, sino que también lo
vincularía con la carga de envíos, cosa de facilitar la carga a Salidas"*. Primero UPS,
DHL en el futuro. Cuentas UPS: una de **expo**, una de **impo**, una de **vinos** (casi no
se usa: **afuera por ahora**).

Estado: **Etapa 0 en curso (07/09).** Nada implementado todavía.

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

## 5. Lo que necesito de Felipe para arrancar la Etapa 0

1. ✅ **Números de cuenta UPS** de expo y de impo — `327W09` / `3R6A45` (07/09).
2. ✅ **Shipping (y Rating) habilitados en la app el 07/09**, aprobados en Test y Prod.
3. **Una proforma de las que hace la oficina** (el archivo que mandan), para la Etapa 3.
4. **Que la oficina confirme el paso 6**: con DDP y sin DDP, qué eligen en "gastos de
   envío a" y en "aranceles e impuestos a".
5. ¿Con qué se imprimen las etiquetas hoy: impresora común A4 o térmica de 10×15?

## 6. Códigos de servicio UPS (para no buscarlos después)

Internacional desde Argentina: **65 = Worldwide Saver**, **08 = Worldwide Expedited**,
07 = Worldwide Express, 54 = Express Plus. Empaque: **02 = Customer Supplied Package**
("otro tipo"). Etiqueta: `GIF` (pantalla/A4), `ZPL`/`EPL` (térmica), `PDF` vía
`LabelImageFormat`. Estos códigos se verifican contra la respuesta del entorno de test
en la Etapa 0 antes de darlos por buenos.
