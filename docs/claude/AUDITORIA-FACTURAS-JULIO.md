# Auditoría de las facturas de julio (28/08/2026)

Felipe cargó las facturas UPS de julio en producción y pidió revisar todo antes del cierre.
Se auditó sobre la copia real bajada de OneDrive (`nova_backup_20260828_151227.db`) —
que de paso fue el **simulacro de restauración con la copia real: PASÓ** (el verificador la
aprobó y el sistema levantó contra esa base con `{"ok":true}`).

**El Excel para la oficina quedó en `C:\dev\control-facturas-julio.xlsx`** (5 hojas).

> **CIERRE DEL MISMO DÍA:** los hallazgos 2 y 3 se arreglaron, desplegaron y verificaron
> el 28/08 a la tarde (commits `75b2ecf` y `73841b5`). Las 14 facturas se recargaron con
> la función nueva de carga múltiple: **"Sin envío" quedó en 34** (los 25 + los 9 typos),
> exactamente la cuenta prevista, y la 75310 también leyó. Queda lo de la oficina
> (hallazgos 1 y 4) y lo que falta cargar (hallazgo 5).

---

## Lo que se cargó

26 cargas para **14 facturas distintas**, todas UPS con fecha 31/07/2026:
`0020-00075119` a `00075133` (faltan **75124 y 75130** en la secuencia — ¿existen?) y
`0020-00075310` (cuenta distinta: guía `1ZF33G…`). Cuatro se habían cargado el 12/08; el
resto el 28/08.

### ✅ Lo que funciona bien

- El cruce guía→envío anda: **97 envíos de julio quedaron con costo** (más 5 de fines de
  junio que venían en las mismas facturas). Tras la recarga del 28/08 son **106** (los 9
  ilegibles tomaron costo).
- La actualización del envío es idempotente: **las cargas repetidas NO duplicaron costos**
  en los envíos (mismo valor pisado sobre sí mismo).
- `estado_revision` se comporta como se diseñó: los `a_revisar` son todos envíos sin
  precio de venta cargado — esperable, no es error. **Entre los envíos que SÍ tienen
  venta cargada no hay ninguno con margen negativo.**
- Los totales por factura cuadran: la suma de las líneas + percepciones da el total
  declarado.

---

## Los 5 hallazgos (en orden de plata)

### 1 · 25 guías facturadas que NO existen como envío — USD 4.971 al costo — ⏳ OFICINA
UPS las cobró y el sistema no tiene ningún envío con esos números (ni parecidos). O son
envíos que **nunca se cargaron** (plata pagada y no facturada al cliente) o son de antes
de que el sistema arrancara (los envíos empiezan el 26/06). Las gordas: 86,5 kg a
Australia USD 860 · 62 kg a UK USD 584 · 63,5 kg a Alemania USD 531. **Lista completa en
la hoja 1 del Excel — la oficina debe confirmar una por una.**

### 2 · ✅ Duplicados en el registro de facturas (L10) — ARREGLADO el 28/08 (`75b2ecf`+`73841b5`)
Había 26 filas para 14 facturas: "sobreescribir" agregaba una carga nueva sin borrar la
anterior, y los botones de la confirmación quedaban vivos mientras la carga viajaba
(doble click = doble carga). **Arreglo:** sobreescribir ahora BORRA la carga anterior de
esa factura (cabecera + detalle, en la misma transacción) antes de insertar la nueva, y
los tres botones se bloquean con un candado (`cargaEnCurso`) durante la carga. La
recarga de las 14 facturas dejó `facturas_cargadas` en 14 filas sin ninguna limpieza SQL.
Tests: sección 5 de `test-guias-sin-envio` + `test-pantalla-carga-multiple`.

### 3 · ✅ 9 guías con el importe ilegible — ARREGLADO el 28/08 (`75b2ecf`)
**Causa raíz (confirmada con los PDFs reales de 75133 y 75129):** la línea de componentes
que sigue al tracking casi siempre trae CUATRO importes (dos pares tarifa/descuento),
pero cuando la guía tiene una sola tarifa trae DOS ("642,90  -572,18") — y la máquina de
estados exigía cuatro, así que nunca llegaba al neto. De rebote, la factura entera se
quedaba sin percepciones repartidas (el reparto exige que la suma cuadre): por eso las 8
facturas con guía ilegible eran exactamente las 8 sin percepciones. **Arreglo:** la línea
de componentes acepta cualquier renglón compuesto solo de importes (2 o más). Con la
recarga, los 9 envíos tomaron su costo y las percepciones se repartieron; la 75310
también leyó su única guía. Tests: `test-parser-factura` (caso real de 2 importes + caso
defensivo de línea ausente).

### 4 · 9 guías mal tipeadas (hoja 2 del Excel) — ⏳ OFICINA
La factura trae la guía verdadera; en el sistema está cargada con 1-2 caracteres de
diferencia. Cuatro ya estaban en la lista conocida del 29/07; cinco son nuevas. Tres con
diferencia de 1 carácter (seguras), el resto "revisar" — ojo que la pantalla NO sugiere
"¿quisiste decir?" a propósito (decisión de Felipe del 29/07: dos guías legítimas pueden
parecerse), esta lista salió de cruzar a mano. La oficina corrige el número de guía del
envío y después se recarga esa factura (ahora es un botón: carga múltiple + sobreescribir).

### 5 · Lo que falta cargar para cerrar julio — ⏳
- **DHL: ninguna factura cargada.** Los 20 envíos DHL de julio están sin costo (hoja 4).
  **No hay parser de DHL** (solo UPS). Si se quieren adentro, es desarrollo nuevo.
- **UPS:** ~33 envíos de julio siguen sin costo legítimamente: despachos del 29-31/07
  (caen en la factura de la semana siguiente) + los de las facturas 75124/75130 si
  existen + guías de otras cuentas (`1Z3R6A…`).

---

## La función nueva que salió de esto: carga de varias facturas de una (`73841b5`)

Pedida por Felipe para la recarga y quedó para siempre: el selector acepta varios PDFs,
se procesan DE A UNO (el chequeo de duplicados del backend no es a prueba de cargas
simultáneas), una tabla muestra cómo terminó cada uno (factura, guías, cruzadas, sin
envío, resultado), y si algunas ya estaban cargadas pregunta UNA sola vez al final si se
sobreescriben todas. `api.js` ahora adjunta `err.status` al error (el lote distingue el
409 "ya estaba" de un error real). Cache busting nuevo: **`?v=20260828a`** en las 17
páginas. Test: `test-pantalla-carga-multiple` (11 chequeos, en el navegador, usando la
factura de ejemplo dos veces en la misma selección).

---

## Números de referencia (después de la recarga del 28/08)

- Julio: 172 envíos (151 UPS expo · 1 UPS impo · 20 DHL) · 106 con costo · 0 NO VOLÓ.
- `facturas_cargadas`: **14 filas** ✓ · "Sin envío": **34 guías** ✓ (25 sin envío real +
  9 typos; baja a 25 cuando la oficina corrija los typos y se recarguen esas facturas).
- `npm run verificar` pasa a tener **48 tandas** (se sumó `test-pantalla-carga-multiple`).
