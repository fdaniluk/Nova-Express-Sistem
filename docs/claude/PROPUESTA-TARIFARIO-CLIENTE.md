# Tarifario para el cliente — propuesta (13/08/2026)

**Estado: PROPUESTA + dos muestras en PDF entregadas. Sin código en el sistema.**
Punto 2 de `PENDIENTES.md`.

Verificado en el repo (`cb1aaa3`): en `clientes-perfil.js` no hay nada de tarifario, exportar,
imprimir ni PDF. Lo que se hizo el 11-13/08 fue la **matriz interna**. Felipe recordaba haber
arrancado esto en una sesión anterior; no quedó nada guardado. Arranca de cero, y la matriz es
la fuente de precios.

---

## Lo definido por Felipe (13/08)

- Es para **clientes nuevos**, y funciona como **carta de presentación**. La estética importa.
- **La grilla es como el tarifario de DHL: de medio kilo en medio kilo, las seis zonas, precios
  en dólares. NUNCA porcentajes.** *"¿Para qué querría ver un porcentaje un cliente si él no
  entiende los porcentajes? Está viendo un precio fijo por tarifa."*
- **El 100% de los tarifarios sale en números.** Cliente por porcentaje → el sistema toma la
  tarifa del courier, le suma el profit de ese cliente y lo pasa a números. Cliente por kilo →
  precio × kilos. La celda siempre es un número de venta.
- **No es un botón que escupe un tarifario.** Es un botón que abre opciones.
- **Desde / hasta / cada cuántos kilos, elegible.** *"Hay clientes grandes a los que les
  interesan más de cien."* Paso de 0,5 · 1 · 5 · 10 kg.
- **Por proveedor o por servicio**, y **que diga el servicio o que no lo diga**:
  *"DHL la más cara, UPS lento la más barata, UPS rápido la del medio. Le mando el tarifario de
  UPS rápido, él se apoya en esos precios, y después yo le hago el envío por UPS lento o por
  DHL."*
- **GoGreen y el surge van a las especificaciones**, y las especificaciones **cambian según qué
  servicios tenga el tarifario**: solo UPS → las de UPS; solo DHL → las de DHL; los dos → las
  dos.
- **El fuel NO viaja en el tarifario.** Varía todo el tiempo. Ni mencionarlo; a lo sumo leyenda.
- **Los precios son de venta, con el profit adentro.** Nunca costo ni margen.
- **Los ceros de PIO: no bloquear.** Aviso arriba del botón, no un freno.
- Criterio final que dio: *"lo que vos consideres más prolijo, más cómodo y con menos margen de
  errores para los empleados"*.

---

## Las muestras entregadas (13/08)

Generadas con el motor real (`cotizarServicio` con `fuelPct:0`, `fob:0`, sin bultos), tomando
`conGan` = flete de venta. Scripts en el contenedor: `/root/muestra/gen.js` y `gen2.js` (no
están en el repo).

1. **`Tarifario_muestra.pdf`** — DHL exportación, 330 filas (0,5 a 30 de a 0,5; 31 a 300 de a
   1), 6 zonas, 8 hojas. Cliente de porcentaje (70%) convertido a números.
2. **`Tarifario_muestra_2_cliente_grande.pdf`** — desde 50 hasta 300 kg de a 10, encabezado
   **"Hasta kg"**, y **hoja de especificaciones** con GoGreen, seguro, zona remota, sobrepeso e
   impuestos de destino. 2 hojas.

---

## La propuesta

### 1. Un botón en el perfil: **"Armar tarifario"** → panel con vista previa en vivo

Mitad izquierda las opciones, mitad derecha el tarifario como va a salir. Nada se descarga a
ciegas.

### 2. Primero el escenario, después el detalle (esto es lo que baja el error del empleado)

Arriba del panel, cuatro botones grandes que dejan todo configurado de una:

| Escenario | Qué hace |
|---|---|
| **Un servicio, con nombre** | El cliente pidió UPS Expedited: sale ese, nombrado, con sus especificaciones. |
| **Varios servicios, con nombre** | Comparativa: una hoja por servicio, cada una con lo suyo. |
| **Tarifario único sin nombrar** | Título genérico. Pide la **base de precios** (alto / medio / bajo). Especificaciones genéricas, sin marcas. |
| **Personalizado** | Todos los interruptores a mano. |

### 3. Los interruptores

| Grupo | Opción | Por defecto |
|---|---|---|
| **Precios** | Servicios: DHL · UPS Expedited · UPS Saver (uno, varios o todos) | los que el cliente tenga cargados |
| | Exportación / Importación / las dos | Exportación |
| | Zonas: todas, o solo las que el cliente usa | todas |
| | **Desde / hasta** kg | 0,5 a 300 |
| | **Paso:** 0,5 · 1 · 5 · 10 kg | 0,5 hasta 30, después 1 |
| **Identidad** | Logo: Nova Express · Exportarlo · sin logo | Nova Express |
| | Nombre del cliente arriba | sí |
| | Nombrar el servicio o título genérico | nombrarlo |
| **Letra chica** | Fuel: no mencionarlo · leyenda | no mencionarlo |
| | Vencimiento | 30 días |
| | Hoja de especificaciones (automática por servicio) | sí |
| | Hoja de zonificación | sí |
| **Salida** | PDF · Excel editable · imagen para WhatsApp | PDF |

### 4. El paso grueso: la regla que lo hace seguro

Si el paso no es el de la tabla del courier, la columna se titula **"Hasta kg"** y la celda
lleva el precio del **techo** de la franja. Un envío de 63 kg toma la fila de 70. Así el cliente
nunca puede pagar más de lo que dice el tarifario, y el empleado no tiene que interpolar nada.
Va también una línea explicándolo abajo de la tabla.

### 5. Las especificaciones se arman solas

Es una lista de ítems con condición, no un texto fijo:

| Ítem | Aparece cuando |
|---|---|
| GoGreen USD 0,98/kg | hay DHL **y** el servicio se nombra |
| Surge fee / IPF EE.UU. | hay UPS **y** el servicio se nombra |
| Zona remota / extendida | siempre (el monto cambia según courier) |
| Seguro | siempre (montos de DHL, de UPS, o los del cliente si tiene negociado) |
| Peso facturable y volumétrico | siempre |
| Impuestos de nacionalización | siempre |
| Recargo por combustible | según la tilde de fuel |

🔴 **En el tarifario sin nombrar, las notas no pueden nombrar marcas.** Si el título dice
"Tarifa aérea internacional" y abajo dice "GoGreen (DHL)", el servicio quedó nombrado igual.
En ese escenario los ítems se agrupan como *"recargos del courier"* con el importe del más caro.

### 6. La base de precios cuando el tarifario NO nombra el servicio

Selector de tres, como lo describió Felipe: **alto** (el más caro de los seleccionados, celda
por celda) · **medio** · **bajo**. Por defecto **alto**: es el único que no puede dejarlo
cobrando menos de lo que prometió.

### 7. Dos cosas que no pidió y conviene que estén

- **Presets guardados** (*"Cliente nuevo — genérico"*, *"UPS Expedited con logo Exportarlo"*).
- **Registro de lo enviado:** qué tarifario, a qué cliente, qué día, con qué precios y qué
  vencimiento. Gana la discusión *"vos me pasaste este precio"*. Se cruza con el registro de
  cotizaciones (`IDEAS-COTIZACIONES-Y-BOT.md`, punto E).

### 8. Cómo se calcula cada celda

**Con el motor, no con una fórmula nueva.** Cada celda es una cotización simulada
(`cotizacion.service.js` + `resolverTarifaVenta()`), con el precio por kilo del cliente donde lo
haya y el porcentaje donde no — la regla del 13/08. La celda es `conGan`: **sin fuel, sin seguro
y sin recargos**.

---

## 🔴 El problema del tarifario combinado: las zonas de DHL y UPS NO son las mismas

Medido el 13/08 con `resolverZona()` sobre 17 países: **6 caen en zonas distintas.**

| País | DHL | UPS |
|---|---|---|
| Estados Unidos | 3 | 2 |
| México | 3 | 2 |
| Canadá | 3 | 2 |
| Colombia | 2 | 3 |
| Australia | 6 | 5 |
| India | 5 | 6 |

O sea que una columna "Zona 3" que mezcle DHL y UPS **no significa nada**: son países distintos
en cada courier.

**Propuesta:** el tarifario combinado se calcula **por país y después se agrupa**. Se usa el
mapa de zonas de DHL como mapa de Nova (es el que la oficina conoce), y para cada zona se toma
el **peor caso entre los países que la componen** en cada servicio seleccionado. Nunca queda
corto y la hoja de zonificación sigue diciendo la verdad. Un tarifario de un solo servicio no
tiene este problema y usa el mapa de ese courier.

---

## Decisiones abiertas

1. ✅ GoGreen y surge → van a las especificaciones, no a la celda (Felipe, 13/08).
2. Los logos de Nova Express y Exportarlo **todavía no llegaron al repo** (pendiente desde el
   29/07). Las muestras usan el nombre en tipografía.
3. Si el Excel es editable a mano, el número que se manda puede dejar de coincidir con el
   sistema. Propuesta: fecha y número de versión impresos adentro del archivo.
4. Confirmar el mapa de zonas de Nova para el tarifario combinado (propuesta: el de DHL).
