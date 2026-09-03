# Tarifa por kilo y fuel propio por cliente

*Armado el 30/07/2026. Pedido de Felipe: "hay algunos clientes que su tarifa no es por porcentaje, sino que tienen valores fijos por kilo, en rangos de kilos… el señor Luis tiene de uno a diez kilos, paga el kilo cinco dólares, entonces, si tiene un envío de seis kilos, multiplica cinco por seis, y esa es su tarifa de flete. Tanto por zona como por kilo. Hay algunos que tienen como una especie de fuel customizado también."*

---

## 1. Qué se puede hacer ahora

Cada cliente tiene un **modo de tarifa**, que se elige en su perfil (botón *Editar tarifas*):

| Modo | Cómo se arma el flete de venta |
|---|---|
| **Porcentaje de ganancia** (el de siempre, y el que tienen todos hoy) | flete del courier + % de ganancia, con la matriz de profit |
| **Precio fijo por kilo** (nuevo) | peso facturable × precio por kilo del rango y la zona |

Al lado del selector de modo hay un campo de **fuel propio**. Si se carga, ese cliente cotiza con ese fuel en vez del de Configuración. Si se deja vacío, usa el de Configuración, que es lo normal.

**El precio por kilo reemplaza SOLO el flete.** El fuel, el seguro, el surge, el DDP, la zona de entrega y todos los recargos del courier se calculan y se cobran exactamente igual que a cualquier otro cliente. No se toca nada de eso.

Ejemplo, el de Luis: rango de 1 a 10 kg a USD 5 el kilo, envío de 6 kg →
`6 × 5 = USD 30` de flete, y encima el fuel, el seguro y los recargos que correspondan.

---

## 2. Cómo se carga

En el perfil del cliente, *Editar tarifas*:

1. Poner el modo en **Precio fijo por kilo**.
2. Elegir la tabla (DHL Expo, DHL Impo, UPS Saver Expo, etc.). **Cada tabla tiene sus propios rangos**, igual que la matriz de profit.
3. Cargar el rango: *desde* — *hasta* — *USD por kilo*. Dejar el "hasta" vacío significa "de ahí en adelante".
4. El rango queda con ese precio **para las seis zonas**. Si una zona tiene otro precio, se hace clic en esa celda y se escribe el valor: queda pintada y con una crucecita para volver atrás.
5. La crucecita del renglón (a la derecha del "1-10 kg") borra el rango entero.

**Los rangos los define cada cliente.** No hay bandas fijas como en la matriz de profit: si un cliente trabaja de 1 a 10, otro de 0 a 3 y otro de 25 en adelante, los tres se pueden cargar tal cual. Los dos límites son **inclusivos**: el rango 1-10 incluye tanto el kilo 1 como el kilo 10.

Cambiar de modo **no borra nada**. Las dos tablas quedan guardadas y se puede ir y volver.

---

## 3. La decisión que más importa: qué pasa si falta un rango

Si un cliente está en modo por kilo y llega un envío cuyo peso **no cae en ningún rango cargado**, el sistema **no cotiza cero**. Vuelve al porcentaje de ganancia de ese cliente y **muestra un cartel** arriba de la cotización diciendo qué tabla y qué peso le faltan.

Es a propósito. Un agujero en la tabla es un error de carga que hay que ver, no un envío regalado. El cartel dice exactamente qué cargar:

> *El cliente está en modo precio por kilo pero no hay tarifa cargada para UPS_EXP export zona 1 con 60 kg. Se cotizó con el porcentaje de ganancia (50%).*

Lo mismo queda anotado en los logs del VPS.

---

## 4. La precedencia (cuál gana cuando hay varias)

Es la misma que la de la matriz de profit, para no tener dos lógicas distintas:

1. **Celda** — zona + rango de peso concretos
2. **Rango** — ese rango de peso, para cualquier zona
3. **Zona** — esa zona, para cualquier peso
4. **General de la tabla** — ese servicio + tipo
5. Si no hay nada → cae al porcentaje y avisa (punto 3)

Si por error se cargan dos rangos que se pisan, se usa el de "desde" más alto y queda anotado en los logs.

---

## 5. Un detalle de kilos que conviene saber

- **DHL** cobra el peso facturable tal cual: 6,2 kg × USD 5 = USD 31.
- **UPS** cobra los kilos que factura el courier (redondeo a 0,5 kg, y el mínimo de 40 kg del Paquete de Mayor Tamaño): 6,2 kg se facturan 6,5 → 6,5 × USD 5 = USD 32,50.

Es a propósito: el cliente paga por los mismos kilos por los que nos cobra el courier. Si fuera al revés, en cada envío con decimales se perdería la diferencia.

---

## 6. Si el precio por kilo queda por debajo del costo

La utilidad se calcula como **lo que se vende menos lo que cuesta**. Si un precio por kilo no llega a cubrir el flete del courier, la utilidad del envío da **negativa**, y así se ve. No se fuerza a cero. Es la única manera de que se note que ese cliente está dando pérdida.

---

## 7. Motor único: se respetó

Todo esto vive en un solo lugar:

- **`shared/cotizador/cotizador-core.js`** — el motor recibe un parámetro nuevo, `precioKgVenta`. Cuando viene, el flete de venta es `precio × kilos` en vez de `flete × (1 + ganancia)`. Nada más cambia.
- **`backend/src/services/profit.service.js`** — `resolverTarifaVenta()` es el **único** lugar donde se decide si un cliente cobra por porcentaje o por kilo. El cotizador, el alta de envío y la pantalla de liquidar le preguntan a él; ninguno decide por su cuenta.

Es la regla que pidió Felipe el 28/07: *"el día de mañana, cuando cambia la tarifa, estaría bueno que solamente se tenga que modificar de un lado"*.

---

## 8. Qué se verificó antes de entregarlo

| Verificación | Resultado |
|---|---|
| Los 91 clientes de producción quedan en modo porcentaje después de la migración | ✅ 10 clientes en la copia usada, todos en "porcentaje", ninguno con fuel propio |
| El resolvedor nuevo da lo mismo que el viejo, sobre datos reales | ✅ **5.460 combinaciones** (cliente × servicio × tipo × zona × peso), **0 diferencias** |
| Pasar el parámetro nuevo en vacío no mueve ningún total | ✅ |
| `schema.sql` refleja la base después de migrar | ✅ `npm run check-schema` sin desvíos |
| Toda la batería de tests del sistema | ✅ **385 controles, 0 fallas** |

Tests nuevos: `npm run test-tarifa-kg` (58 controles) y `npm run test-pantalla-tarifa-kg` (23 controles, navegador de verdad).

---

## 9. Limitador encontrado de paso (y arreglado)

**Los tests de pantalla pasaban por casualidad.** Diez de ellos usaban una base en `/tmp` que **no creaban**: se apoyaban, sin decirlo, en la que hubiera quedado de una corrida anterior. Consecuencias:

- En una máquina limpia fallaban todos con "Sesión inválida": la base nueva no tiene usuarios y la sesión se colgaba de un `usuario_id 1` que **en producción no existe** (los usuarios son Felipe, Marcelo y empleado_test).
- Cuando la base sí sobrevivía, los envíos que creaba el test quedaban guardados y la corrida siguiente fallaba con "Ya existe un envío con la guía".

O sea: los tests pasaban o fallaban según qué hubiera quedado en `/tmp`. Un test así no sirve para verificar nada.

**Arreglado.** Se agregó `backend/scripts/_base-test.js`: cada test rehace su base como copia fresca de la de producción y abre la sesión contra un usuario que exista. Además, si un test se corta por un error, ahora mata su servidor — antes quedaba vivo, se quedaba con el puerto, y la corrida siguiente le hablaba al servidor viejo y fallaba sin motivo aparente.

---

## 10. Lo que quedó afuera

- **"Un porcentaje fijo con un valor mínimo"** — Felipe lo mencionó al pasar sobre el fuel customizado y no está claro qué significa: ¿un fuel mínimo en USD? ¿un piso de ganancia? Queda pendiente de que lo aclare. Hoy el fuel propio es un porcentaje y nada más.
- El precio por kilo aplica al **flete**. Si alguna vez hiciera falta que reemplace también algún recargo, es otro trabajo y hay que definirlo.
