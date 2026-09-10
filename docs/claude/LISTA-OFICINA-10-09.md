# Lista de la oficina — 10/09/2026

Lo que Felipe anotó en estos días de oficina, pasado por chat el 10/09. Se guarda textual
(abajo) y desglosado en tareas (arriba). Cada bloque se ataca por separado, con diseño
mostrado antes cuando toque pantalla (regla del rediseño de Salidas).

## A. Guardado de cotizaciones

| # | Tarea | Notas |
|---|---|---|
| A1 | **Volver a desplegar la cotización guardada entera** (no solo el preview del perfil) para poder **reenviarla** al cliente. | Hoy el perfil muestra un resumen. Hace falta abrir la cotización completa tal cual se generó (mismo formato que el cotizador muestra / manda). Ver cómo se guardó (`entrada` + opciones) y si alcanza para re-renderizar; si no, guardar también el HTML/el JSON completo al momento de guardar. |
| A2 | **No volver a preguntar qué servicio se confirmó.** Los botones "Guardar" están al lado de CADA servicio, así que la cotización guardada ya sabe cuál se eligió; el perfil sigue mostrando los distintos servicios y pidiendo confirmar → redundante. | Al guardar desde el botón de un servicio, dejar ese servicio como el elegido/aceptado y que el perfil lo muestre así de entrada. Revisar qué pasa con las cotizaciones viejas (guardadas antes de los botones por servicio). |
| A3 | **Al pinchar la cotización desde Cargar envío, que complete TODO lo que pueda**: no solo el precio sugerido — país, peso, medidas, cantidad de bultos, etc. | Hoy solo pega el precio. Mapear campos de `entrada` → formulario de Cargar envío (país, peso real, largo/ancho/alto, bultos, valor declarado, DDP/seguro si están, servicio UPS). |
| A4 | **Al revés: si en Cargar envío ya elegí el país antes de agarrar la cotización, que me sugiera solo las cotizaciones de ese cliente A ESE PAÍS.** | Filtro del panel de cotizaciones por país cuando el país ya está elegido (y sin filtro si todavía no). |

## B. Generador de guías (módulo Guías)

| # | Tarea | Notas |
|---|---|---|
| B1 | **El campo TAX ID limita los caracteres**: ayer no pudieron terminar de cargar lo que quisieron poner. | Revisar `maxlength` del input y el largo que manda la API de UPS (UPS acepta hasta 15 en `TaxIdentificationNumber`; si la oficina necesita más, ver qué escribieron: puede ser un CUIT con guiones, un EIN + texto, etc.). Preguntar qué quisieron poner. |
| B2 | **Etiqueta térmica ≠ guía aérea A4.** Hoy se imprime lo mismo en A4 y en la térmica. UPS tiene un formato para la térmica (la etiqueta GIF/ZPL 4×6) y otro para la guía en papel. | Pedirle a UPS `LabelImageFormat` ZPL/EPL para la térmica (o el GIF a 4×6 exacto sin escalar) y usar el formato de guía para A4. |
| B3 | **La guía A4 sale fea y en vertical.** La oficina la imprime **horizontal**: de un lado la guía, del otro las leyendas de UPS (términos). | Felipe va a mandar una guía impresa tal cual la hacen para copiar el formato. Armar la hoja A4 apaisada con la etiqueta + el bloque de leyendas de UPS. |
| B5 | **Numerar las proformas automáticamente** (correlativo, arranque configurable, p. ej. 1300). | Contador en configuración + asignación al emitir; editable por si hace falta. |
| B4 | **La proforma sale siempre con el título "Commercial Invoice"** y no siempre es eso; hay casos en que hay que editar el título. | Título editable al emitir (desplegable: Commercial Invoice / Proforma Invoice / otro a mano), guardado con la guía. |

## C. Dashboard (pedido del jefe + "que se te ocurra a vos")

| # | Tarea | Notas |
|---|---|---|
| C1 | **Kg enviados por mes.** | Gráfico de barras por mes (facturables y balanza), con el año anterior de fondo. |
| C2 | **Top de clientes desplegable "hasta donde quiera"**, por **kg**, por **facturación** y por **utilidad**. Felipe se imagina UNA tabla en la que se cambia la función. | Tabla única con selector de métrica (kg / venta / profit / envíos), "ver 5 · 10 · 20 · todos", período elegible, clic en el cliente → perfil. |
| C3 | **Una vez cerrado el mes con las facturas cargadas: kg que de verdad se facturaron, utilidad verdadera y compra verdadera**, comparando con lo estimado — "esta parte me la imagino con distintos gráficos". | Estimado vs real por mes: compra estimada vs costo facturado, profit estimado vs real, kg facturables vs peso UPS. Solo tiene sentido para los meses con revisión cerrada; marcar qué % del mes está cruzado. |
| C4 | **Que quede lindo y amistoso, con cosas dinámicas y distintas funciones; que se puedan analizar muchos aspectos.** Faltan cosas: que se me ocurran a mí. | Ideas para proponer: mix DHL/UPS por mes; destinos top (mapa o barras por país); profit % promedio por mes con banda objetivo; envíos pendientes de liquidar y plata en riesgo (ya existe en Salud, traer el resumen); tiempos (días entre carga y liquidación); comparación de un cliente contra el promedio; filtro global de período y de courier arriba; exportar cada gráfico a Excel. Primero diseño, después construir. |

## Estado

### A — HECHO (10/09, cache `?v=20260910a`, paquete `cotizaciones-guardadas.tgz`)

- **A1 · Ver cuadro.** El dibujo del cuadro salió de `cotizador.html` a **`frontend/js/cotizacion-imagen.js`** (`CotizacionImagen.dibujar`, mismos trazos: el test del canvas sigue verde). En el perfil, el ▸ de cada cotización abre el desglose y cada opción tiene **🖼 Ver cuadro**: modal con la imagen armada con los números GUARDADOS (no recalcula), nombre del cliente, fecha y validez de esa cotización, y **Copiar imagen / Descargar PNG**. Si está vencida, el subtítulo lo avisa. El perfil carga las fuentes DM Sans / DM Mono (Google Fonts) para que salga igual.
- **A2 · No re-preguntar el servicio.** `listar()` ahora devuelve `viaja` por opción. En el perfil, la columna Opciones marca con ✓ verde la guardada (gris la que no); con **una** guardada el botón es directo **"✓ Aceptada"** (acepta ese servicio y su total); con varias, "Aceptar UPS W.E" / "Aceptar DHL" solo entre las guardadas; cotizaciones viejas sin marca, como antes.
- **A3 · Pinchar completa todo.** `recientesDeCliente` devuelve además `datos` (ddp, entrega, residencial, proteccion_doc). El panel llama `onUsar(total, {cotizacion, opcion})` y `envios.js → aplicarCotizacion()` pega: tipo, courier + servicio UPS, país (tolerante a mayúsculas/acentos), cantidad de bultos con medidas y pesos (o el bulto único), FOB (+ asegurado ≥ 100), DDP, zona de entrega, prot. doc.; recalcula pesos y cotización. No toca cliente, fecha, guía ni observaciones. La nota dice de qué CTZ salió. Salidas sigue usando solo el precio.
- **A4 · Filtro por país.** `montar(..., {pais})`: con país elegido muestra solo las cotizaciones a ese país (aviso ámbar "Solo las cotizaciones a X (n de m)"); si no hay ninguna, muestra todas y avisa. El panel se rehace al cambiar el país.
- Tanda nueva **`test-pantalla-cotizacion-guardada`** (37, puerto 3962), en `test-pantallas`. Ajustadas `test-pantalla-cotizacion-cliente` (lee la franja del pie en el archivo nuevo) y `test-pantalla-cotizaciones` (acepta "✓ Aceptada").

### B1 · B4 · B5 — HECHO (10/09, cache `?v=20260910b`, paquete `guias-proforma.tgz`)

- **B1 · Tax ID.** El campo del destinatario acepta hasta **40** caracteres (antes 15) y se
  guarda tal cual ("CPF: 123.456.789-00" — así lo muestra la proforma). A UPS le va SOLO el
  número: `taxIdParaUps()` saca lo que está antes de los dos puntos, una palabra corta al
  principio ("RUT 12345678-9"), espacios, puntos, guiones y barras, y corta a 15 (el máximo
  de UPS). Un PAN de la India ("ABCDE1234F") queda entero.
- **B5 · Numeración.** `configuracion_nova.proforma_proximo` (migración + schema, arranca en
  **1300**). Al emitir una guía con el Nº vacío, el sistema le pone ese número y avanza el
  contador; **recién cuando UPS ya devolvió la guía** (una rechazada no gasta número). Si se
  tipea un número a mano se respeta; si es ≥ al próximo y está a menos de 1000, el contador
  salta para no repetirlo; un número lejano (formato viejo tipo 79122211) no arrastra el
  contador. Se ve y se ajusta en **Configuración → Numeración de proformas**
  (`GET/PUT /api/configuracion/proforma`). El formulario de Guías muestra "Automático: 1300".
- **B4 · Título.** Desplegable en Guías (Commercial Invoice · Proforma Invoice · Invoice ·
  Packing List · Otro…) guardado en `guias.datos_json.proforma_titulo` (mayúsculas, máx. 40);
  editable por `PUT /guias/:id` mientras es precarga; la hoja (`renderHtml`) lo usa como
  encabezado y título de la pestaña; la proforma del envío confirmado lo hereda de la guía.
- Tanda `test-guias-emision` → **102** (sección 6-bis). `check-schema` ✓ contra base nueva.

### B2 · B3 — HECHO (10/09, con el PDF y la foto que mandó Felipe)

- Lo que imprime la oficina es la **hoja de UPS CampusShip**: A4 vertical con las cinco
  instrucciones de UPS arriba, "Shipper's Signature" / "Date of Shipment", la línea
  **DOBLAR AQUÍ** al medio y la etiqueta **acostada (6×4)** en la mitad de abajo; se dobla y
  queda la guía de un lado y las leyendas del otro. La térmica es SOLO la etiqueta, 4×6
  vertical.
- `GET /guias/:id/etiqueta.html?formato=a4` ahora arma esa hoja (una por bulto);
  `?formato=termica` saca solo la etiqueta a 4×6. La orientación del GIF de UPS se detecta
  (`orientar()`, en el `<head>` porque las imágenes data: cargan antes que un script al
  final) y hay un botón **↻ Girar** (180°, se recuerda por formato en el navegador) por si
  la impresora la saca cabeza abajo — **hay que verificarlo con la primera guía real**: el
  GIF de UPS de test viene de 1×1 px, no se pudo comprobar la orientación de verdad.
- Tanda `test-guias-emision` → **106**.

## Orden propuesto

1. **A** (cotizaciones) — es lo que más usan a diario y lo pidió la oficina.
2. **B1, B4 y B5** (Tax ID, título de la proforma, numeración automática) — chicos y bloquean el uso real de Guías.
3. **B2 y B3** (térmica y guía A4 apaisada) — cuando llegue la guía impresa de administración.
4. **C** (dashboard) — diseño primero, mostrar, después construir por partes.

## Respuestas de Felipe (10/09)

- **A1:** lo que hay que volver a ver es **el recuadro de cotización que se le manda al
  cliente** (el cuadro del servicio elegido, tal cual se envía). El cotizador saca tres
  (DHL, UPS rápido, UPS lento); si guardo la de UPS lento, después quiero abrir ESE cuadro
  para reenviarlo si no lo mandé antes.
- **B1:** no sabe qué quisieron poner exactamente; entiende que era un país que pide un
  documento y ellos escribieron **"nombre del documento: números"** y no entró; terminaron
  poniendo solo los números. → ver qué largo permite hoy y qué acepta UPS.
- **B2:** no sabe las medidas de la térmica; **mirar qué ofrece UPS en su web** (la
  etiqueta térmica se la genera UPS desde la página). Confirma medidas después.
- **C:** el dashboard es para **el jefe y Felipe, quizás algún empleado**: acceso
  limitado por permiso, no para todos.
- **B5 (nuevo):** el **número de proforma** es inventado por ellos pero intentan que sea
  correlativo → que el sistema lo numere solo, arrancando por ejemplo en **1300** y
  contando.

## Texto original de Felipe (10/09)

> con respecto al guardado de las cotizaciones necesitaria que se puedan volver a despelegar
> las cotizaciones que uno guarda, no solo ver ese preview que uno puede acceder desde el
> perfil del cliente al que se guardo la cotizacion, sino poder volver a ver la cotizacion
> entera en el caso de que tenga que ser reenviada, otra cosa es que si te fijas cuando uno
> guarda una cotizacion y entra al perfil del cliente a verla, le sigue apareciendo los
> distintos servicios y confirmar que servicio se pidio, pero tene en cuenta que hoy en dia
> los botones de guardar cotizacion no estan en el general sino que estan al lado de cada
> servicio, por lo tanto volver a preguntar que servicio se confirmo seria un poco redundante,
> otra cosa que me gustaria es que si yo pincho la cotizacion desde la parte de la carga de
> envios que no me complete unicamente el precio sugerido, sino que tambien chupe otros datos
> que viven dentro de la cotizacion como por ejemplo el pais, el peso, medidas, cantidad de
> bultos, etc todo lo que se pueda y por el otro lado que sea al revez o sea que si yo pongo
> en la carga de envios antes de agarrar la cotizacion sugerida un pais que solo me sugiera
> las cotizaciones de ese cliente a ese pais.
>
> hay que corregir cosas del generador de guias; la primera es que en la parte donde se pone
> el TAX ID, por alguna razon los caracteres que te permite poner el campo son limitados, ayer
> no se que quisieron poner y no lo podian terminar porque no les permitia el sistema, eso con
> respecto a la carga de envios, las otras correcciones son con las guias y la proforma, lo
> primero es que el formato de las impresiones termicas no es el mismo que el de las guias
> aereas, hoy el sistema te imprime los mismo en la a4 que en la termica y no es asi, UPS
> ofrece un formato especial para las termicas y otro para las guias, asi que hay que
> corregir eso de las termicas, las guias tambien salen feas la verdad, ahora le voy a pedir a
> administracion que me mande una guia tal cual la imprimimos nosotros asi ves el formato, hoy
> vos las pones con la hoja vertical y nosotros lo que hacemos es la hoja horizontal de un
> lado la guia y del otro lado las leyendas que pone UPS y por ultimo lo que hay que ver como
> resolver es que la proforma sale con el titulo -comercial invoice- y no siempre son eso,
> sino que hay casos en los que hay que editar ese titulo.
>
> Dashboard (pedido del jefe): kg enviados por mes, top de clientes desplegable hasta donde
> quiera tanto por kg como por facturacion como por utilidad (me imagino una tabla unica en la
> que pueda ir como cambiando la funcion, pero lo que vos digas), una vez cerrado el mes con la
> carga de facturas poder ver cuantos kg de verdad se facturaron, utilidad verdadera y poder
> ver la compra verdadera (esta parte me la imagino con distintos graficos comparando con lo
> estimado). Esto salio de una primera conversacion con mi jefe; faltan cosas y necesitaria
> que se te ocurran a vos, pero que quede lindo y amistoso a la vista, que haya cosas
> dinamicas si la ves bien y distintas funciones.
