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

## Orden acordado

1. ~~Terminar bugs y pendientes~~ ✅ (auditoría cerrada el 18-20/08)
2. ~~Estética de la cotización + botón de copiar imagen + la fuga del profit~~ ✅ **20/08**
3. ~~El registro de cotizaciones (E, entrega 1)~~ ✅ **24/08**
4. **Cotizaciones en el perfil del cliente** (la vuelta de tuerca de E)
5. **El precio acordado en Salidas** (E, entrega 2)
6. El link para clientes (A)
7. Los pesos (D)
