# El Excel del respaldo de Salidas — arreglo del 31/08/2026

Dos reclamos de la oficina sobre la planilla que baja el botón de cierre (semanal o
mensual), más tres cosas que aparecieron al revisar. Commit **`5b2a2d7`**.

---

## Los dos reclamos

### 1 · "No marca el número de salida de cada envío"

**La causa:** la planilla leía la columna `numero_salida` de la tabla `envios` — que está
cargada en **1 de 347 envíos**. Nadie la usa: es un campo viejo, opcional, que quedó ahí.

El número que la oficina llama *"el envío 27"* no vive en la base: es un **correlativo por
mes calculado al vuelo**, ordenado por fecha y desempatado por id, donde los envíos "sin
numerar" (`num_sal_cero`) reciben 0 y no consumen número. Hasta ahora eso solo existía en
el navegador (`recomputeNumSalMes` en salidas.js), así que el servidor —que es quien arma
el Excel— no tenía forma de saberlo.

**El arreglo:** `listarSalidas()` ahora calcula y devuelve `num_sal_mes`, y el Excel usa
ese. Va como **número** (antes la columna era de texto: Excel ordenaba 10 antes que 9).

> ⚠️ **EL DETALLE QUE HAY QUE CUIDAR SIEMPRE.** El correlativo se calcula sobre el **mes
> completo**, NO sobre las filas del período pedido. Si alguien lo "simplifica" numerando
> las filas del Excel, el respaldo de una semana pasa a decir 1, 2, 3 en vez de 149, 150,
> 151 — y el número de salida es con lo que la oficina identifica un envío en voz alta.
> Hay un test que lo fija (`test-cierre-periodo`, sección 9).

### 2 · "Los envíos de más de un bulto tampoco lo muestra"

Salía **una sola fila por envío**, con las medidas del envío. De un envío de 15 cajas la
planilla mostraba una. Son **93 envíos multibulto** en producción, más de un cuarto.

**El arreglo:** un renglón por bulto, igual que la pantalla — "1/15, 2/15, …" con las
medidas y el peso de cada caja.

**Lo que hace que esto no rompa los totales:** cada columna tiene ahora un ÁMBITO.
- `'bulto'` → valor propio en cada renglón (medidas, peso, volumen, guía)
- `'envio'` → se escribe SOLO en el primer renglón; en los demás va en blanco

Es lo mismo que hace la pantalla con su helper `env()`. Sin eso, la fila de TOTALES
contaría el flete de un envío quince veces. Está fijado con números concretos en el test
(venta 400 con un multibulto de 3, peso 21 = 5+6+7+3).

---

## Lo que apareció al revisar (Felipe: "de paso revisá si hay o puede llegar a haber otro error")

3. **Faltaban tres columnas** que la pantalla sí tiene: **Largo / Ancho / Alto**,
   **Compra Total** y **Revisión**. Ahora son 37 columnas.
4. **La guía se repetía en cada bulto.** Se vio MIRANDO la planilla real (se generó el
   Excel de la semana 24-28/08 con datos de producción y se convirtió a PDF): un envío de
   15 cajas mostraba el mismo número 15 veces. Ahora la guía del bulto se escribe solo si
   es **propia** (26 de 324 bultos tienen la suya); si la hereda del envío, va una vez.
5. **El pie podía leerse como una pérdida.** En la semana real la Compra Total sumaba
   23.245 contra 5.972 de venta — porque muchos envíos todavía no tienen precio cargado y
   su costo suma igual. La planilla ahora lo aclara arriba: *"N envío(s) todavía sin
   precio de venta cargado: su costo suma en Compra Total, pero no aportan a Total ni a
   Profit"*. No cambia ningún número; evita la mala lectura.

Además el encabezado ahora distingue **envíos** de **renglones** ("31 envío(s) en 88
renglón(es), uno por bulto"), para que nadie cuente filas creyendo que cuenta envíos.

---

## Lo que se revisó y estaba bien

- **El Excel de liquidación** (`excel.service.js`): va una línea por guía a propósito —
  es la factura al cliente, no el respaldo interno. No lleva número de salida ni bultos.
- **NO VOLÓ cruzado con multibulto**: los tres renglones se pintan y **ninguno** suma, ni
  la plata del primero ni los kilos de los otros dos. Testeado (era el caso donde una
  expansión mal hecha metía kilos fantasma en el mes).
- El peso del envío ES la suma de sus bultos (verificado sobre los 93 multibulto de
  producción), así que sumar por renglón da el mismo total que antes.
- Los bordes del período, el permiso `cerrar_mes`, el asiento en `cierres` y el aviso del
  panel de salud: sin cambios, siguen verdes.

## Tests

`test-cierre-periodo` pasó de 51 a **81 controles**. Los checks viejos que buscaban "la
columna 24" ahora buscan **por nombre de encabezado**: un test atado a números de columna
se rompe cada vez que se agrega una, sin que nada esté mal.

La sección 9 incluye la comparación de las **dos implementaciones** del correlativo (la
del backend y la que recalcula la pantalla al vuelo) sobre los mismos datos: si alguien
toca una sola, se pone rojo. Mismo criterio que `test-motor-unico` con el redondeo.
