# Tarifas DHL arriba de 10 kg — de fórmula a tabla oficial

29/07. Corregido y verificado contra el PDF oficial DHL 2026.

## El problema

Hasta 10 kg el sistema tenía la tabla del tarifario copiada. **Arriba de 10 kg no tenía
tabla: calculaba el precio con una fórmula incremental por tramos.** Esa fórmula no
reproducía el tarifario real.

El error grande estaba arriba de 70 kg en exportación. La fórmula buscaba el tramo donde caía
el peso y aplicaba la tarifa de ese tramo a **todo** el excedente sobre 30 kg, en vez de
acumular tramo por tramo:

```js
if(pf>30){const s=p1.find(x=>pf>x[0]&&pf<=x[1]);if(s)rate+=Math.ceil(pf-30)*s[2][c];}
```

Para un envío de 71 kg a zona 3, el tramo 70,1–300 cobra 5,56/kg y el tramo 30,1–70 cobra
5,31. La fórmula cobraba 41 kg a 5,56; el tarifario cobra 40 kg a 5,31 más 1 kg a 5,56.
Diferencia: **40 × (5,56 − 5,31) = 10,00 USD exactos**, en todos los envíos arriba de 70 kg.
Arriba de 300 kg la diferencia trepaba a 180,10.

Entre 10 y 70 kg la fórmula erraba por centavos (hasta 28 centavos), en las dos direcciones.

Comparado celda por celda contra el PDF: **1.822 de 1.860 celdas de exportación arriba de
10 kg no coincidían** (98%), y 293 de 360 en importación de 10 a 50 kg.

## La corrección

Se reemplazó la fórmula por la tabla del PDF, igual que ya se hacía hasta 10 kg y para
importación arriba de 50 kg:

- `DHL_E_PKG_BIG` — exportación, 310 filas de 10,5 a 300 kg
- `DHL_I_PKG_MED` — importación, 60 filas de 10,5 a 50 kg (de 50 en adelante ya mandaba
  `DHL_I_BIG`, que estaba bien)
- `DHL_E_PK_300` — valor por kilo para extrapolar arriba de 300 kg en exportación

El peso se redondea tomando la primera fila que lo alcance, que es como redondea DHL.

También se agregó un freno: si alguna vez se llama con una tabla de documentos y un peso
arriba de 2 kg, devuelve la última fila en vez de romper con un error de índice. Hoy no se
llega ahí, pero era una bomba de tiempo.

## Verificación

**Contra el PDF, celda por celda: 0 diferencias.** Las 2.220 celdas de exportación, las 480 de
importación y las 1.500 de la tabla especial de >50 kg coinciden al centavo.

`npm run test-tarifas-dhl` — 15 pruebas que quedan en el repo con los valores del tarifario
copiados a mano, para que esto no se pueda romper sin que salte. Cubre los bordes (10, 10,5,
20, 30, 50, 69, 70, 71, 300, 301 kg), el salto de 70 a 71 que era el bug, el redondeo, la
extrapolación arriba de 300 kg, que la tarifa nunca baje al subir el peso, y que importación
arriba de 50 kg siga usando la tabla especial.

## Impacto en la base de producción

Solo hay 4 envíos DHL arriba de 10 kg cargados, así que el efecto sobre lo ya facturado es
chico. Donde importa es en el cotizador, que se usa todos los días.

Medido con `node scripts/impacto-recargos.js` (que compara el motor del repo contra el
corregido, sumando también los recargos del 28/07):

```
sin cambio de precio: 142 de 158
suben:   3 envíos ·  +82.85 USD
bajan:  13 envíos ·  -43.66 USD
```

El envío a Kenia de 76,88 kg baja 8,76 USD de flete (era el caso del +10,00 menos el recargo
nuevo de pieza no convencional). El de Francia baja 7 centavos: ese es el error de redondeo
del tramo de 10 a 70 kg.
