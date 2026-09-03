# Sistema Nova — Listado completo de pendientes

**20/08/2026.** Producción en `2875e61` · 36 tandas · 975 controles en verde.

Salió de barrer los 33 documentos del proyecto, no solo `PENDIENTES.md`. Cada punto dice
**de quién depende** y **cuánto es**. Al final está lo que ya se cerró, para que no vuelva a
aparecer en la lista.

---

## 🔴 A. RIESGO DE PLATA — lo que puede costar dinero hoy

| # | Qué | Quién | Tamaño |
|---|---|---|---|
| **A1** | **Borrar un envío liquidado borra la liquidación confirmada.** El botón Borrar de Salidas no mira `liquidado`: resta el importe del total, borra el ítem y, si era el único, **borra la liquidación entera**. Sin confirmación, sin rol de admin, sin papelera. Lo puede hacer cualquiera de los 8 usuarios. Tapamos esto mismo en el PATCH el 13/08; esta es la otra puerta. **Verificado en el código hoy.** | programar | 1 h |
| **A2** | **Los 81 precios en USD 0 de PIO ALVAREZ le cobran flete gratis** en zonas 1 y 3-6 y en el general de UPS. La pantalla los marca en rojo. Battlo (23) tiene 1 fila igual. | oficina | — |
| **A3** | **Borradores de liquidación #12 y #30**: los envíos 31 y 147 están en un borrador *y* en una confirmada. Confirmar el #12 refacturaría **USD 2.225**. Ya no se pueden confirmar (409) y desde el 18/08 se pueden borrar con el botón Borrar del historial. Falta borrarlos. Después conviene el índice único que lo impide para siempre (no antes: haría fallar el arranque). | Felipe, 5 min | 20 min |
| **A4** | **El frontend de Salidas pisa el profit real con el estimado** en envíos ya conciliados, y lo persiste. La columna "Dif Costo %" se puede pintar de rojo sola. | programar | 2 h |
| **A5** | **Campos de plata sin validar**: tipear `1250,50` con coma guarda NULL y el profit salta solo; una zona inválida guarda el envío con todos los costos en NULL. | programar | 2 h |
| **A6** | **USD 12.367 en 30 envíos sin liquidar**, el más viejo de abril (18 de junio son USD 9.244). Puede ser deliberado, pero nunca se confirmó. | Felipe, mirar | — |
| **A7** | **Fuga del profit en la captura de la cotización**: con un cliente elegido, la tarjeta muestra "Profit cliente: 120%" o "Tarifa: USD 5,00 por kilo", y la oficina manda cotizaciones sacándole captura a esa tarjeta. Puede haber pasado ya. | programar | 2 h |

## 🟠 B. DECISIONES TUYAS — no llevan código, destraban cosas

**Pricing**

- **B1** · El **salto de DHL importación a los 50 kg**: 50,0 kg son USD 422,30 y 50,5 kg son USD 324,42. Medio kilo más barato en USD 98. ¿Es la estructura real de DHL o está invertido? *(nunca contestada)*
- **B2** · **Fuel "con un valor mínimo"** — lo mencionaste al pasar y no se entendió qué es: ¿un mínimo en USD, un piso de ganancia, otra cosa?
- **B3** · **Los 4 envíos con fuel al 39%** (41-44, USD 19,56 de costo inflado) ya están liquidados: ¿se corrigen o se dejan?
- **B4** · **PIO ALVAREZ**: ¿se le vende al costo a propósito? Zona 1 · 25 kg cobra USD 162,77 con costo USD 162,77, margen cero.
- **B5** · **Cueros Santa Cruz**: ¿cobra por porcentaje abajo de 20 kg a propósito? No tiene nada cargado ahí.
- **B6** · **La Justina (26) y Arenasa (55)** están en modo por kilo **sin ninguna tarifa cargada**: se les carga, o se los pasa a porcentaje.
- **B7** · **Cueros Santa Cruz y GERSCOVICH**: cómo pasar sus tarifas viejas a las bandas fijas. 20-29,5 se parte en 20-25 y 25-30 y hay que decidir el precio de cada una; un envío de 29,8 kg cambia de precio.
- **B8** · **El seguro propio del cliente cobra el mínimo abajo de USD 100**, donde UPS hoy no cobra nada. Si no es lo buscado, se deja el mínimo vacío.
- **B9** · **UPS Saver a España e Italia** tiene tarifa propia fuera de la tabla de zonas y la matriz no puede expresarlo. Hoy se carga el porcentaje general de zona 4 y no coincide. ¿Se permite un override por país, o alcanza un cartel en el cotizador?

**Tarifario y couriers**

- **B10** · **¿El tarifario corta en 300 kg?** Arriba de eso DHL no tiene tabla y el motor extrapola. Sugerido: cortar y poner "consultar".
- **B11** · **Confirmar con DHL si Nova puede elegir con qué tarifario despachar cada guía.** Define si el tarifario unificado se puede cargar al sistema o solo sirve para decidir cuál usar.
- **B12** · **Alfombras a Australia**: confirmar con los ejecutivos de cuenta los topes de pieza reales saliendo de Argentina.
- **B13** · **El celeste de Exportalo**: se usa `#1B7FC4` porque el del logo no deja leer el texto blanco. Si querés el exacto, hay que oscurecer el texto.
- **B14** · **El Excel del tarifario es editable a mano**, así que el número que se manda puede dejar de coincidir con el sistema. Propuesta: imprimir fecha y número de versión adentro.

**Facturas y cierre**

- **B15** · **"Sobreescribir" una factura duplica** en vez de reemplazar (la UPS `0020-00074402` está cargada dos veces). ¿Borra la carga previa o la marca como anulada? Implica borrar datos.
- **B16** · **Conciliación estimado vs. facturado cargo por cargo**: falta que confirmes si la pregunta era esa comparación.
- **B17** · **Quién de administración recibe el permiso `cerrar_mes`.** Hasta que alguien lo tenga, solo los admin ven el botón.
- **B18** · **Dónde se guardan los archivos de cierre.** Sugerido: `Cierres Nova\2026\`, no "Descargas" que se limpia sola.
- **B19** · **¿Los cierres se siguen mandando por WhatsApp o alcanza con el archivo guardado?**
- **B20** · **¿La importación de Excel tiene que frenar los documentos por UPS?** Hoy entra; se dejó a propósito.

**Respaldo y accesos**

- **B21** · **Quién de la oficina es el segundo acceso** (ya elegiste que sea alguien de la oficina, falta el nombre) y completar el sobre.
- **B22** · **¿La cuenta de OneDrive de las copias es tuya personal o de la empresa?** Si es personal conviene pasarla.

**Rumbo**

- **B23** · **¿Adelantamos el "precio acordado" (C1)?** Hoy va cuarto en la fila y es el único que hace que la plata registrada difiera de la cobrada.
- **B24** · **¿`modo_tarifa` se elimina del todo o queda solo como aviso?** La columna sigue en la base.

## 🟡 C. PROYECTOS GRANDES

- **C1** · **Registro de cotizaciones y precio acordado.** *El más importante que está abierto.* El envío tiene un campo de precio donde hacen falta dos (acordado vs. recalculado) y el cotizador de Salidas pisa lo que el cliente pagó — el caso Asaplast: se cobró por 14 kg, quedó el de 10, y la liquidación estaba por salir con ese número. Hoy **el cotizador no guarda ni una sola cotización**. Pediste anotarlo para charlarlo, no para empezarlo. `[GRANDE, DELICADO]`
- **C2** · **Facturas de DHL.** El parser es 100% UPS. En junio fueron 16 UPS / 7 DHL: un tercio de los envíos no se concilia contra nada. La pantalla ya está lista y nunca recibe datos. `[GRANDE]`
- **C3** · **Cuenta corriente por cliente.** Hoy no existe: `cobranzas` es un registro suelto sin vínculo con liquidaciones. Es el prerequisito del bot de cobranzas. `[MEDIO]`
- **C4** · **Chatbot de cobranzas por WhatsApp** (modelo del aguatero: QR → WhatsApp → "cuánto debés y cómo pagar"). El bloqueante no es el bot, es C3. `[GRANDE]`
- **C5** · **Bloqueo de edición concurrente en Salidas.** `[GRANDE]` 5-7 h
- **C6** · **Link de cotización autogestionada para el cliente.** Todo definido (link y no archivo, vencimiento 30 días, código único, courier que fijás vos, logo siempre). No empezado. `[MEDIO/GRANDE]`
- **C7** · **Tracking automático.** Hoy es 100% manual y no persiste nada; hay una función cuyo propósito es copiar guías al portapapeles para que un humano las pegue en la web de UPS. El OAuth ya existe: falta un job y una columna. Riesgo: que falle en silencio y muestre estados viejos como frescos. `[MEDIO]`
- **C8** · **Notificaciones push a Juanqui al teléfono.** No existe nada, ni siquiera refresco automático de pantalla. Telegram sería `[CHICO/MEDIO]`, WhatsApp Business oficial `[GRANDE]`. Recomendado: empezar por Telegram.
- **C9** · **La estética general** (dashboard y resto de pantallas). La matriz y la hoja del tarifario son la referencia.
- **C10** · **Integración GECOM.** Lo ves como otro escalón, no ahora. `[GRANDE]`

## 🟢 D. MEDIANO Y CHICO — mejoras de todos los días

- **D1** · **Respaldo fuera del VPS**: cuenta Microsoft + rclone + cron. *El limitador más viejo que queda (L2).* Te necesita 1 h. `[CHICO]`
- **D2** · **Simulacro de restauración en el VPS.** 30 min
- **D3** · **Relación pickup↔envío.** `envios.pickup_id` **no existe**: el vínculo se resuelve con un UPDATE a ciegas por cliente+fecha que marca de más si un cliente tiene dos envíos el mismo día, y obliga a re-tipear ~20 campos ya cargados en el pickup (2-4 min por envío, 1-2 h por mes). Falta el botón "cargar envío" en la tarjeta del pickup. `[CHICO/MEDIO]`
- **D4** · **Duplicar un pickup recurrente.** Hoy los mismos clientes con los mismos horarios se cargan de a uno todas las semanas: 30-60 min por mes. `[CHICO]`
- **D5** · **Carga múltiple de PDF de UPS** (~13 juntas a fin de mes, hoy de a una, 20-30 min de atención sostenida). El punto fino: "sobreescribir" tiene que quedar por factura, no global. *Pediste dejarlo para más adelante.*
- **D6** · **Bandeja de revisión: mostrar también las "pendiente".** Hoy filtra solo `a_revisar` y `reclamar`, así que la mayoría queda pendiente para siempre y no hay forma de cerrar un mes. `[CHICO/MEDIO]`
- **D7** · **Botón "generar borradores de todos los pendientes"** (hoy es cliente por cliente). `[CHICO]`
- **D8** · **Nadie avisa cuándo liquidar**: un cliente con 12 envíos sin liquidar hace 40 días no genera ninguna alerta.
- **D9** · **Que el panel de salud avise solo**, sin que nadie abra el sistema. Falta un job diario que te mande el resumen (Telegram sería lo más barato de probar). *(L11)*
- **D10** · **Visibilidad del mes en curso**: como el precio se carga al liquidar, el dashboard no muestra utilidad del mes corriente. Falta un precio estimado guardado al cargar el envío.
- **D11** · **Cotizaciones en pesos** con el tipo de cambio cargado en Configuración. `[CHICO]` — el más chico de los cuatro de cotizaciones.
- **D12** · **Botón "copiar cotización como imagen"** (la imagen se dibuja aparte, no es captura del HTML). `[MEDIO]`
- **D13** · **Mostrar el FOB / valor declarado en el desglose del cotizador.** `[CHICO]`
- **D14** · **Topes de medida** (deuda 29, del caso alfombras): falta frenar el lado largo >274 cm de UPS y el límite de pieza de DHL (120×80×80 / 70 kg). Hoy una alfombra de 2,80 m pasa el cotizador y UPS no la toma. 1 h
- **D15** · **Operaciones sin pickup** (impo sin retiro). 3 h
- **D16** · **Clasificación de tamaño de caja** (chico/mediano/grande) para Juanqui. `[CHICO]`
- **D17** · **Traducir los estados de tracking de UPS al español.** `[CHICO]`
- **D18** · **Unificar los clientes duplicados y poner el candado**: GERSCOVICH/Gerscovich (36/37) y OPEN POLO/Open Polo (68/69). El panel los detecta. `[CHICO]`
- **D19** · **Registro de quién hizo qué.** 8 usuarios activos, ninguna auditoría. *(L7)*
- **D20** · **Login sin límite de intentos ni bloqueo**, contraseña mínima de 6 sin requisitos, usuarios que son nombres de pila, endpoint expuesto a internet.
- **D21** · **Leer la casilla de mail y detectar los PDF de factura** para adelantar la carga. Idea anotada, sin evaluar.
- **D22** · **Evaluar la API "Estimated Landed Cost" de UPS** (es paga).
- **D23** · **Mandar la liquidación automáticamente.** Por mail no es viable (87 de 91 clientes sin email); por WhatsApp implica la API de Business. Si se hace: botón explícito con vista previa, nunca automático al confirmar.
- **D24** · **Probar el tarifario en producción con un cliente real** y probar la **importación** con datos reales de impo.

## ⚙️ E. DEUDA TÉCNICA — no se ve, pero muerde

- **E1** · **`salidas.js` tiene 2828 líneas en un bloque** con estado compartido. Hay una propuesta de corte en 8 archivos sin cambiar comportamiento.
- **E2** · **Código muerto que contradice al motor** en `calculos.service.js:44-58` y `liquidacion.model.js:38-60`. No los llama nadie y son una trampa para el que los lea creyendo que son la fuente de verdad. Conviene borrarlos.
- **E3** · **Seis implementaciones distintas de formateo de moneda** (una cobranza de $150.000,50 se ve `$ 150.001` en Pickups y `$ 150.000,50` en Cobranzas) y **seis de escapado de HTML, con 7 módulos sin ninguna** → XSS almacenado posible vía nombre de cliente.
- **E4** · **Las bandas de peso están duplicadas a mano** entre frontend y backend. Una sola fuente. 1 h
- **E5** · **El informe del migrador de tramos reporta cambios fantasma** sobre datos ya migrados, porque modela un cliente sin tramos. Falta que use `obtenerTramos()`. 1 h
- **E6** · **`POST /api/envios` con `tipo_envio` inválido devuelve 500 con el error crudo de SQLite** en vez de un 400 entendible.
- **E7** · **Mover `cotizador_courier_v8.html` a `_legacy/`.** Prototipo viejo de 24 KB que convive con el motor real y ya le costó al sistema de tests una falla que estuvo cuatro días sin verse. *(verificado: sigue ahí)* `[CHICO]`
- **E8** · **`test-guias-sin-envio` usa el puerto 3999**: si hay un server local ahí, el test le habla a ese y falla con `no such table: usuarios`. *(verificado: sigue así)* `[CHICO]`
- **E9** · **Dos tests de pantalla quedaron fuera del repo**: el del caso mixto por kilo (quedó como `/tmp/mix3.js`, 14 controles) y los de "Calcular venta" en Salidas.
- **E10** · **Borrar `backend/.env` del VPS** — copia muerta de las credenciales de UPS.
- **E11** · **`UPS_CLIENT_ID` y `UPS_CLIENT_SECRET` viven solo en el `.env` del VPS**, no están en GitHub ni en ningún backup. Si se pierde el VPS hay que volver a pedirlas en el portal.
- **E12** · **Sacar la base SQLite del sync de OneDrive** (el `-wal` tenía 1,15 MB sin checkpointear). *El repo ya salió; la base es aparte.*
- **E13** · **Las emisiones del tarifario no se borran nunca** (a propósito: son el archivo). Si algún día pesan, decidir una poda.
- **E14** · **`cuadrantes.pickup_id` no tiene foreign key en producción**: la migración la agrega con `ALTER TABLE ADD COLUMN` y SQLite no lo permite. Quien lea `schema.sql` cree que está.
- **E15** · **Los 10 cargos del tarifario que el sistema no contempla** (corrección de dirección, auditoría de peso, entrega en sábado, liberación por courier, honorarios de import/export formal…). Van a aparecer como descuadre al conciliar.
- **E16** · **Si UPS actualiza sus tablas**, los porcentajes de equivalencia Expedited→Saver hay que recalcularlos. La matriz guarda el número, no de dónde salió.
- **E17** · **Limpiar tarballs viejos y `_to_delete`** (OneDrive\GitHub y C:\dev). 10 min

## 📌 F. DATOS PUNTUALES EN PRODUCCIÓN

> Todo esto cae bajo tu regla del 20/08: **no se toca lo que cargaron los empleados sin que lo pidas.** Va listado para que decidas, no para corregir solo.

- **F1** · **Envío 94** (DHL, 03/07): peso facturable 67,75 kg cuando el real es 73,75. **6 kg que no se cobraron.** Único caso en 158 envíos, parece edición manual.
- **F2** · **Envío #137** (Cueros Santa Cruz, 15/07): único UPS sin variante guardada; el costo se congeló asumiendo Expedited. ¿Era Saver?
- **F3** · **228 envíos con peso y sin precio de venta** (USD 64.553 de costo estimado). Dijiste que es carga pendiente, no un olvido. Protegidos: no se pueden liquidar en cero.
- **F4** · **Huecos de tramos que se cobran por porcentaje sin avisar**: Cueros Santa Cruz entre 29,5 y 30 kg, PIO ALVAREZ entre 32 y 32,5. Ninguna pantalla lo advierte. *(la migración del 13/08 pudo cerrarlos — hay que mirar)*
- **F5** · **4 filas huérfanas en `envio_bultos`** (53-56), del script de vaciado del 30/06. *(L6)*
- **F6** · **47 de 190 pickups sin courier asignado** y 2 pickups de prueba con dirección "calle 123" quedados en producción.
- **F7** · **64 de 91 clientes sin margen configurado** y solo 4 con matriz de profit: el profit automático del cotizador sirve para 4 clientes. *(L4)*

---

## ✅ Cerrado — para que no vuelva a aparecer en la lista

- Los **5 defectos de plata** de la auditoría (`cb1aaa3`) y las **6 sospechas** (`dfe9b06`).
- **Deuda 20**: `revisar-envios.js` + la dirección de los envíos (`ccb3936`).
- **Las columnas del tarifario por courier** y la Guayana Francesa (`2875e61`).
- **L9**: el repo salió de OneDrive (14/08).
- **Los logos de Nova y Exportalo SÍ están en el repo** (`frontend/assets/logos/`) — la nota que decía que faltaban era falsa. *(verificado hoy)*
- **El IPF y el surge**: quedó fijado "todo recargo del courier pasa a costo" (30/07).
- **El seguro de UPS y DHL**: "son valores que pusimos nosotros — se deja" (29/07).
- **Área remota vs. extendida en UPS** (29/07). **El escalón de los 32 kg**: no era un bug.
- **La percepción de IIBB es costo del envío** (30/07, consultado con el jefe).
- **`test-orden-pendientes` y `test-aviso-guia`**: era falta de datos en el contenedor, en Windows dan verde.
- **El CDN de `xlsx` en salidas.html**: se fue al sacar el botón Exportar Excel (06/08).
- **Supabase**: descartado. Se revisa solo si hay más de una oficina cargando a la vez, una app de celular, o la base pasa los pocos GB.
