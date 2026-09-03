# Equivalencia de porcentajes: UPS Expedited → UPS Saver (03-08-2026)

Pedido de Felipe: un cliente tiene su matriz de profit cargada en **UPS Expedited exportación**.
Quiere cargar la pestaña de **UPS Saver exportación** con los porcentajes que hagan que el
cliente pague **exactamente los mismos dólares**.

*(Un intento anterior dio mal porque la matriz de Expedited que se había pasado estaba mal cargada.
Esta versión parte de la matriz correcta, confirmada por Felipe el 03/08.)*

## La fórmula

El motor arma el flete de venta como `flete_tabla × (1 + profit/100)`
(`cotizador-core.js`, variable `conGan`). **Todo lo demás es idéntico entre los dos servicios**
—surge, fuel, seguro, manejo, DDP, zona de entrega dependen del país, el peso y el FOB, no del
servicio—, así que igualar el flete de venta iguala el total:

```
% Saver = (flete Expedited ÷ flete Saver) × (1 + % Expedited) − 1
```

Tablas fuente en `shared/cotizador/cotizador-core.js`:
`UPS_E_LIQD` (Expedited export) · `UPS_SE_LIQD` (Saver export) ·
`UPS_I_LIQD` / `UPS_SI_LIQD` (los de importación).

**Si UPS actualiza esas tablas, estos porcentajes hay que recalcularlos.** Es una dependencia
que no queda registrada en ningún lado del sistema: la matriz guarda el número, no de dónde salió.

## Matriz de entrada (Expedited export, la del cliente)

| | Z1 | Z2 | Z3 | Z4 | Z5 | Z6 |
|---|---|---|---|---|---|---|
| 0-5 | 90 | 100 | 100 | 100 | 100 | 100 |
| 5-10 | 90 | 90 | 90 | 90 | 90 | 90 |
| 10-15 | 90 | 90 | 90 | 80 | 80 | 80 |
| 15-20 | 90 | 90 | 90 | 80 | 80 | 80 |
| 20-25 | 90 | 70 | 90 | 70 | 90 | 90 |
| 25-30 | 90 | 70 | 90 | 70 | 90 | 90 |
| 30-40 | 90 | 85 | 90 | 90 | 85 | 85 |
| 40-50 | 90 | 93 | 90 | 95 | 105 | 105 |
| 50+ | 90 | 70 | 90 | 80 | 90 | 90 |

## Resultado — cargar en UPS Saver exportación

| | Z1 | Z2 | Z3 | Z4 | Z5 | Z6 |
|---|---|---|---|---|---|---|
| 0-5 | 31,0 | 88,1 | 38,0 | 88,1 | 37,9 | 37,9 |
| 5-10 | 31,0 | 78,6 | 31,0 | 78,6 | 31,0 | 31,0 |
| 10-15 | 31,0 | 78,6 | 31,0 | 69,2 | 24,1 | 24,1 |
| 15-20 | 31,0 | 78,6 | 31,0 | 69,2 | 24,1 | 24,1 |
| 20-25 | 31,0 | 59,8 | 31,0 | 59,8 | 31,0 | 31,0 |
| 25-30 | 31,0 | 59,8 | 31,0 | 59,8 | 31,0 | 31,0 |
| 30-40 | 31,3 | 73,6 | 31,2 | 79,1 | 27,8 | 27,9 |
| 40-50 | 31,5 | 80,8 | 31,5 | 84,3 | 41,8 | 42,1 |
| 50+ | 31,5 | 59,3 | 31,5 | 70,1 | 31,4 | 31,7 |

**Precisión:** la relación entre las dos tablas se mueve muy poco dentro de cada banda
(spread ≤ 0,3 pp salvo en 30-40 kg, donde llega a 0,94 pp). Se tomó el valor del medio.
Error residual verificado sobre 60 casos: **promedio USD 0,11 · máximo USD 1,10** (35 kg zona 6),
siempre sobre el flete de venta.

## 🔴 España e Italia — limitación estructural, no un error de cálculo

En **exportación**, UPS Saver a España y a Italia **no usa la tabla de zonas**: tiene tarifa
propia (`UPS_SAVER_ES_IT` + `getUPSSaverEsIt`). Expedited sí las trata como zona 4.

Como la matriz de profit se carga **por zona**, un solo número de zona 4 no puede servir para
los dos casos. Con el 88,1 / 78,6 / 69,2… de arriba, a España y a Italia se les cobra de más.

Porcentajes que harían coincidir cada uno (solo referencia, no se pueden cargar):

| Banda | España | Italia | Zona 4 general |
|---|---|---|---|
| 0-5 | 37,9 | 59,1 | 88,1 |
| 5-10 | 31,0 | 51,1 | 78,6 |
| 10-15 | 24,1 | 43,2 | 69,2 |
| 15-20 | 24,1 | 43,2 | 69,2 |
| 20-25 | 17,2 | 35,2 | 59,8 |
| 25-30 | 17,2 | 35,2 | 59,8 |
| 30-40 | 23,1 | 42,0 | 79,1 |
| 40-50 | 21,5 | 40,2 | 84,3 |
| 50+ | 16,5 | 34,4 | 70,1 |

**Decisión de Felipe (03/08): se carga el porcentaje general de zona 4 y queda anotado que a
España e Italia el precio no va a coincidir.**

*Idea para el backlog:* la matriz de profit no tiene forma de expresar "este país sale de otra
tabla". Si esto vuelve a aparecer, la salida limpia es permitir un override por país, o al menos
un cartel en el cotizador cuando el destino es España o Italia con Saver.

## Entregable

`UPS_Saver_Expo_porcentajes.xlsx` — la tabla a cargar, la de entrada, el cuadro de España/Italia,
la explicación del cálculo, y una hoja **Verificación** con 60 envíos (10 pesos × 6 zonas) que
compara el flete de venta de los dos servicios y muestra la diferencia en USD.

## Si hace falta la de importación

Está calculada y da otros números (la relación entre `UPS_I_LIQD` y `UPS_SI_LIQD` es distinta).
Se rehace con el mismo script; no se entregó porque el cliente usa exportación.
