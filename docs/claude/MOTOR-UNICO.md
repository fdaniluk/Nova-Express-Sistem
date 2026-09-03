# Un solo motor, un solo número

**Regla número uno del sistema, dicha por Felipe:** todos los cotizadores —el manual, el de
Cargar envío, el de las liquidaciones, el de Salidas— tienen que dar el mismo precio para el
mismo envío. No puede haber datos diferentes.

**Revisión del 07/08/2026.** La oficina (Vicky y Gaby) encontró que un envío recalculado
quedaba con un precio que no coincidía con el cotizador.

---

## Lo que se encontró

El motor nunca estuvo mal. Con los mismos datos de entrada da el mismo número siempre, y eso
ya lo verificaba `test-motor-unico.js`.

**El problema estaba un paso antes: cada pantalla armaba los datos de entrada por su cuenta.**
Se desviaron cuatro veces, de a una, y ningún test se enteró:

| Desvío | Consecuencia |
|---|---|
| Cargar envío no mandaba `contenido` | un documento DHL salía hasta 60% más caro |
| Cargar envío no mandaba `ddp` | el envío se cargaba sin el cargo |
| **"Calcular venta" mandaba fuel 0** | precio sugerido SIN combustible |
| **La precarga del profit no mandaba el país** | mostraba 75% y cobraba 70% |

Los dos últimos son los que encontró la oficina.

### El fuel en 0

Cada envío congela el fuel del día en que se cargó, pero **los envíos viejos lo tienen
vacío**. El resto del sistema, en ese caso, se cae al fuel configurado del courier.
"Calcular venta" no hacía ese paso: mandaba 0 y cotizaba sin combustible.

Reproducido en un envío de 30 kg:

| | |
|---|---|
| Calcular venta (fuel 0%) | USD 255,88 |
| Correcto (fuel 39,5%) | USD 345,04 |
| **De menos** | **USD 89,16** |

El número sugerido se veía perfectamente razonable. Ese es el peligro.

### El profit 70 vs 75

La precarga del profit en Cargar envío preguntaba **sin el país**. Sin país no hay zona, y
sin zona el resolvedor no puede encontrar la celda de la matriz: devolvía el porcentaje
general del cliente.

| Camino | Profit |
|---|---|
| Precarga (sin país) | 75% · "cliente" |
| El mismo resolvedor, con país | 70% · "celda" |
| Lo que se cobraba | 70% · "celda" |

La pantalla mostraba un número y el sistema cobraba otro.

---

## La solución

### 1. Un normalizador único (`backend/src/services/cotizacion.service.js`)

**El único lugar donde se arman los datos de entrada del motor.** Las pantallas mandan lo
que saben; todo lo demás lo resuelve el servidor.

**Cadena del fuel**, de mayor a menor precedencia *(actualizada el 10/08/2026 con el Fuel
Nova)*:

1. **La fuente elegida a propósito** — Nova, DHL, UPS o a mano. Si la persona eligió, manda
   eso; lo único que hace el sistema es avisar cuando el cliente tenía otro negociado.
2. Fuel propio del **cliente**, si tiene uno negociado y no se eligió nada
3. Fuel congelado del **envío** (un envío de mayo se recotiza con el fuel de mayo)
4. Fuel de **configuración** del courier
5. Cero, solo si no hay nada configurado

Distingue "no vino" de "vino en cero": un 0 explícito es una decisión y se respeta; un vacío
ya no puede terminar en 0 por descuido.

**Zona:** la manda el país; la zona suelta es solo respaldo. Ahora la usan igual todos los
caminos, **incluido el resolvedor de profit** — que es la corrección del 70 vs 75.

**Además, el endpoint acepta `envio_id`:** el servidor saca del envío todo lo que la pantalla
no mande. Lo que sí venga en el body pisa al envío (el modal puede estar editando el peso o
el país antes de guardar).

Cada respuesta dice de dónde salió cada número: `fuel_origen`, `profit_origen`,
`zona_aplicada`.

### 2. El aviso de precio desfasado

**Recalcular actualiza el costo, no el precio de venta.** Siempre fue así, y era lo que
producía el síntoma que reportó la oficina: cambiás el peso de 5 a 50 kg, recalculás,
guardás, y el precio sigue siendo el de 5 kg. **USD 372 de menos, en silencio.**

Ahora, apenas Recalcular cambia el costo, el modal compara el precio cargado contra el que
correspondería al peso actual. Si difieren en más de un dólar:

- Aparece un **cartel ámbar** con los dos números, la diferencia en dólares, y qué hacer.
- Al **guardar**, pide confirmación mostrando la diferencia.

No bloquea: hay precios negociados aparte que son legítimos. Pero no se guarda callado.

### 3. El fuel deja de tipearse a mano *(10/08/2026)*

El Cotizador tenía un campo de fuel vacío que se llenaba de memoria. Es lo que dejó **4
envíos congelados en 39% cuando Configuración decía 33%**: nadie se acuerda de cambiar un
campo que arranca vacío, y el error no se ve porque el número igual parece razonable.

Ahora el porcentaje sale de Configuración y quien cotiza elige de dónde:

| Opción | Qué hace |
|---|---|
| **Fuel Nova** *(predeterminado)* | el nuestro, el mismo para la tarjeta de DHL y las de UPS |
| **Fuel proveedor** | a cada una la suya: DHL con el de DHL, UPS con el de UPS |
| **A mano** | el número que se escriba, para las dos |

Escribir directamente en el campo pasa la fuente a "A mano" sola: escribir un número es
decir "quiero este", y bloquear el campo habría matado la forma en que la oficina lo venía
usando.

**Con el fuel sin cargar no cotiza.** Antes, si no había fuel, salía un precio sin
combustible — por debajo del costo y perfectamente creíble. Ahora corta y dice dónde
cargarlo. Con "A mano" sí acepta cualquier número, incluido el 0, porque ahí la decisión es
explícita.

---

## El test que hacía falta

`backend/scripts/test-un-solo-numero.js` — **36 chequeos.**

`test-motor-unico.js` no alcanzaba porque llama al motor con datos escritos a mano. Este
**parte de un envío real** y compara lo que devuelve cada camino, llamando como llama cada
pantalla. Si alguno se desvía un centavo, falla.

Cubre los cuatro caminos (Cargar envío · Calcular venta · cotizador manual · la precarga que
*muestra* el profit) sobre los escenarios que rompieron de verdad: documento DHL, envío con
DDP, envío pesado con celda propia de matriz, entrega extendida, importación. Más la cadena
completa del fuel y la precedencia de la zona.

Un quinto camino que arme los datos por su cuenta va a hacer fallar este test.

Los tres fuels tienen los suyos: `test-fuel-nova.js` (23, por API) y
`test-pantalla-fuel-cotizador.js` (28, en un navegador de verdad). Este último no controla
solo la etiqueta: controla que **el monto de fuel esté calculado con el porcentaje que la
etiqueta dice**. Una etiqueta que miente es peor que no tener etiqueta.

---

## Estado

`npm test`: **524 chequeos** (19 tandas) · `npm run test-pantallas`: **221** (11 tandas).
Todo en verde. `check-schema` sin desvíos.

## Lo que queda abierto

- **Revisar los envíos ya cargados** cuya venta no se condice con su costo, para saber si
  esto ya pasó antes de que lo encontraran y cuánta plata hay en juego. Se puede hacer como
  chequeo permanente del panel de Salud o como revisión puntual. **Sin decidir.**
- L4 sigue: los clientes 1 y 26 están en modo precio por kilo sin tarifa cargada, y el 26
  cae a 0% de ganancia.
