# Las tarifas por kilo que hay cargadas en producción

**11/08/2026.** Escrito al ir a confirmar, antes de unificar los tramos de peso, que no
hubiera nada cargado. **Había 54 filas y 6 clientes.** Lo que apareció al mirarlas es más
importante que el cambio que se iba a hacer.

---

## 1. Lo que se encontró, en orden de plata

### 🔴 PIO ALVAREZ (cliente 2) está vendiendo AL COSTO

Tiene **20 filas con `precio_kg = 0`**, en UPS Expedited y en DHL, exportación, zonas
1, 3, 4, 5 y 6. Más una fila de nivel tabla —sin zona y sin tramo— **también en 0**, que
es la que agarra cualquier peso que no caiga en los otros tramos.

**Reproducido** con esos mismos datos, con el motor de verdad:

| Caso | Lo que cobra | El costo | Con un 60% de margen |
|---|---|---|---|
| zona 1 · 25 kg | USD 162,77 | USD 162,77 | USD 249,17 |
| zona 1 · 32,2 kg | USD 218,77 | USD 218,77 | USD 319,27 |
| zona 1 · 5 kg | USD 66,57 | USD 66,57 | USD 103,06 |

**Sin un peso de ganancia.** No sale gratis —el precio cubre el costo— pero el margen es
cero. El 60% de la comparación es ilustrativo; el que corresponda es el que tenga cargado
el cliente.

**Por qué pasa, exactamente:** el cliente está en modo precio por kilo. El resolvedor
encuentra la fila de su zona, que dice 0, y devuelve *"precio por kilo = 0, profit = 0%"*.
El motor ve un precio por kilo que no sirve (`0 > 0` es falso) y se cae al porcentaje…
que también viene en 0. Resultado: precio de venta = costo.

**La zona 2 se salva** de casualidad: no tiene fila propia, así que cae en la general de
USD 7,02 el kilo y sí cobra margen.

Casi seguro es un error de carga: alguien guardó la grilla con celdas vacías y quedaron en
cero. **Falta que Felipe confirme** si a este cliente se le cobra al costo a propósito —y
si no, cuánto hace que está así.

### 🟠 Huecos de verdad, del tipo que Felipe intuyó

| Cliente | Tramos cargados | Hueco |
|---|---|---|
| Cueros Santa Cruz (6) | 20 a 29,5 · 30 en adelante | **29,5 a 30 kg** |
| PIO ALVAREZ (2) | 20 a 32 · 32,5 en adelante | **32 a 32,5 kg** |

Un envío que cae en el hueco no tiene precio por kilo: se cobra con el porcentaje, que es
otro número. No lo avisa ninguna pantalla.

Cueros Santa Cruz además **no tiene nada abajo de 20 kg**: todo lo liviano va por
porcentaje. Puede ser a propósito — hay que confirmarlo.

### 🟡 Dos clientes en modo por kilo sin una sola tarifa

**La Justina (26)** y **Arenasa (55)** están marcados como "cobra por precio por kilo" y no
tienen ninguna fila. Todo lo de ellos se cobra por porcentaje. Es el punto 14 de
`PENDIENTES.md`.

---

## 2. Los datos, como están hoy

| Cliente | Servicio | Tramos | Observación |
|---|---|---|---|
| 1 · Cliente Demo | DHL expo | 10-20 kg → USD 20 | cliente de prueba |
| 2 · PIO ALVAREZ | UPS_EXP y DHL expo | 20-32 · 32,5+ | general 7,02 y 4,86 · **zonas en 0** |
| 6 · Cueros Santa Cruz | UPS_EXP y UPS_SAVER expo | 20-29,5 · 30+ | tarifa real, bien cargada, zona por zona |
| 26 · La Justina | — | — | en modo por kilo, sin tarifa |
| 36 · GERSCOVICH | UPS_EXP expo | 25+ → USD 8 | |
| 55 · Arenasa | — | — | en modo por kilo, sin tarifa |

**Ningún tramo cargado coincide con las bandas fijas** (0-5, 5-10, 10-15, 15-20, 20-25,
25-30, 30-40, 40-50, 50+).

---

## 3. Qué se hizo y qué NO

**Se hizo:** de acá en adelante un tramo nuevo tiene que ser una de las nueve bandas. Los
huecos y las superposiciones dejan de poder existir.

**NO se hizo, a propósito: no se le tocó el precio a nadie.** Las filas viejas siguen
resolviendo exactamente como resolvían. Reescribirle la tarifa a un cliente sin que nadie
la mire sería peor que el problema que se está arreglando.

**Y se corrigió algo que casi se rompe:** la primera versión del cambio mostraba en la
grilla solo las nueve bandas. Con eso, la tarifa de Cueros Santa Cruz —20 a 29,5— habría
**desaparecido de la pantalla mientras el sistema le seguía cobrando esos precios**. Ahora
los tramos viejos se muestran igual, marcados en ámbar como *"tramo viejo"*, en solo
lectura, con un cartel que explica que hay que borrarlos y rehacerlos sobre los tramos
fijos. Hay un control automático que lo verifica (`test-pantalla-tarifa-kg`, sección 7-bis).

---

## 4. Lo que falta decidir — es de Felipe

1. **Los ceros de PIO ALVAREZ.** ¿Se le cobra al costo a propósito? Si no, qué precio va en
   cada zona. Y cuántos envíos salieron así.
2. **Pasar las tarifas de Cueros Santa Cruz y GERSCOVICH a las bandas.** No es automático:
   20-29,5 se convierte en 20-25 y 25-30, y hay que decidir qué precio lleva cada una. Un
   envío de 29,8 kg hoy se cobra por porcentaje y pasaría a cobrarse por kilo.
3. **¿Cueros Santa Cruz cobra por porcentaje abajo de 20 kg a propósito?**
4. **La Justina y Arenasa:** o se les carga la tarifa, o se los pasa a porcentaje.
