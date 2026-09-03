# El tarifario adentro del sistema

**Estado: en producción.** `ed16e1e` + `74ddcbd` (la hoja y el panel) · `6f87512` (presets y
registro de emitidos) · **`2875e61` del 20/08 (las columnas por courier — leer la sección de
zonas, es lo que más cambió desde que se armó).**

Formato y decisiones: `TARIFARIO-FORMATO-NOVA.md` y `PROPUESTA-TARIFARIO-CLIENTE.md`.

---

## Qué es

- **`backend/src/services/tarifario.service.js`**. Arma la grilla. Cada celda pasa por
  `resolverTarifaVenta()` —el único decisor— y por `cotizarServicio()` —el motor—, con
  `fuelPct: 0`, `fob: 0` y sin bultos; la celda es `conGan`, el flete de venta pelado.
  Nunca devuelve costos ni márgenes.
- **`backend/src/controllers/tarifario.controller.js`**. `GET /api/clientes/:id/tarifario`
  (JSON) y `GET /api/clientes/:id/tarifario.xlsx` (Excel con ExcelJS, colores de la marca).
  ⚠️ La ruta del `.xlsx` va ANTES que la del JSON en `clientes.routes.js`, si no Express se
  come el `.xlsx` como si fuera un id. Emisión y presets: `/tarifario/emitir`, `/emitidos`,
  `/presets`.
- **`frontend/pages/tarifario.html` + `js/modules/tarifario.js`**. La hoja que ve el cliente.
  **La vista previa y el PDF son la MISMA página**: la previa es un iframe y "Imprimir"
  imprime ese iframe. El panel vive en `clientes-perfil`.

---

## ⚠️ LAS ZONAS — reescrito el 20/08/2026 (`2875e61`)

**Lo que estaba mal.** Las columnas eran SIEMPRE las zonas de DHL, también cuando el
tarifario era de UPS. Como UPS zonifica distinto, una columna de Nova podía caer en dos
zonas de UPS, y `elegirBase('alto')` imprimía **la más cara de las dos**. Efecto real, que
encontró la oficina comparando un tarifario a profit 0 contra el tarifario de UPS Saver:

- **Europa, Asia y Resto del mundo imprimían las tres el mismo número** (el de UPS zona 6).
- Europa quedaba **55-72% por encima** de lo que UPS cobra a Europa Occidental. Con eso no
  se gana ningún negocio.
- Las zonas 1, 2 y 3 estaban bien de casualidad: los países que agrupan coinciden.

**La regla nueva, decidida por Felipe:** las columnas dependen de para qué es la hoja.

| Hoja | Columnas | Exactitud |
|---|---|---|
| **Un solo courier** (DHL, o UPS, con el servicio nombrado) | Las zonas REALES de ese courier, con sus países | **Exacta, siempre** |
| **Combinada** (sin nombre de servicio, sirve para los dos) | Grilla **híbrida de 8 columnas** | 193 de 197 países exactos |

La híbrida parte en dos las dos columnas donde los couriers discrepan:

```
Mercosur | Resto Sudamérica | Norteamérica | Europa Occidental | Europa del Este | Asia | Asia del Sur | Resto del mundo
                                             UE·UK·Suiza        Polonia·Chequia   China·Japón  India·Vietnam
                                                                ·Hungría·Rumania  ·Corea       ·Bangladesh
```

Cada columna de la híbrida está definida por **el par (zona DHL, zona UPS)**, así que no hay
más "peor caso": el precio de la columna es el precio real de esos países en los dos
couriers. En la hoja de DHL las dos Europas muestran el mismo número, y eso es correcto:
DHL efectivamente cobra igual a Alemania que a Polonia.

**Los 4 países que ninguna columna cotiza exacto** (verificado país por país sobre los 197
cotizables por UPS): **Australia** (DHL 6 / UPS 5, +15%), **Islas Canarias** (DHL 6 / UPS 4,
+63%), **Puerto Rico** e **Islas Vírgenes (EE.UU.)** (DHL 2 / UPS 2, +36%). Los cuatro caen
en una columna más cara, así que **siempre cotizan de más, nunca de menos** — se pierde un
negocio, no plata. Van aclarados al pie de la hoja híbrida. En la hoja de un solo courier
salen exactos.

> **Ojo con una frase que circuló y es falsa:** "en la combinada las dos Europas dan el mismo
> número". Depende del servicio y del peso. Con **Saver** se separan (0,5 kg: 37,05 vs 45,41);
> con **Expedited** a veces coinciden porque DHL es el más caro de los tres y tapa a los dos.
> Los dos casos son correctos.

**La Guayana Francesa.** Estaba como `Guyana Francesa` en el mapa de DHL y como
`Guayana Francesa` en el de UPS: dos grafías, así que cotizarla por UPS fallaba con "ese país
no existe", el mismo síntoma de Bélgica. Las dos grafías resuelven ahora en los tres mapas.
**Canario nuevo en `test-tarifas-dhl`:** hay 26 países que DHL lleva y UPS no (Cuba, Irán,
Somalia, islas chicas — legítimo, UPS no les presta servicio). Si esa lista CRECE, el test se
pone rojo y nombra al país: es exactamente así como nacieron el error de Bélgica y este.

---

## Las otras decisiones técnicas que conviene recordar

1. **La memoria por intervalos.** Un tarifario de 50 a 200 kg con los tres servicios tardaba
   **4,3 segundos** porque preguntaba por cada celda. Ahora se juntan los bordes de los
   tramos del cliente **y** los de sus filas de precio por kilo (las viejas de rango libre
   cortan donde se les cargó: 20-32, 32,5+) y se pregunta una vez por intervalo: **367 ms**.
2. **Las notas se arman solas** y, cuando el tarifario no nombra el servicio, **tampoco
   nombran couriers**: dicen "recargos del courier" en vez de "GoGreen (DHL)".
3. **Los ceros no bloquean.** Pedido expreso de Felipe. Hay avisos en el panel, no frenos.
4. **Sin selector de base de precios** (`74ddcbd`). Felipe lo sacó: *"si quiero que cobre un
   precio en específico voy a seleccionar el servicio directamente"*. La regla quedó fija en
   el más caro (`base: 'alto'`). ⚠️ **Ese default es lo que amplificó el problema de zonas de
   arriba**: para DHL no se notaba, para UPS rompía tres columnas. Hoy casi no se usa, porque
   la híbrida ya no necesita elegir entre dos zonas. El parámetro sigue en la API.
5. **Presets y registro de emitidos** (`6f87512`): imprimir archiva la grilla con los precios
   del día, y "Enviados a este cliente" la reabre tal como salió.

## Tests

**`backend/scripts/test-tarifario.js` — 56 controles** (eran 41 antes del 20/08).
Cubre: cada celda contra el motor una por una · que no se escape un costo ni un margen · que
el precio por kilo gane · que la memoria no corra el corte de 32 kg · **las columnas de cada
courier, la híbrida, y que los 4 países de la nota coticen de MÁS y nunca de menos** · rango,
paso y rechazos · el Excel.
**`test-tarifas-dhl` — 25 controles**, incluye los dos canarios de cobertura de países.

En el contenedor no se pueden correr los tests que copian la base de producción
(`test-tarifa-por-kg`, `test-tramos-cliente`, `test-datos-viejos`, `test-seguro-cliente`,
`test-copia-externa`) ni los que necesitan la factura de ejemplo (`test-parser-factura`,
`test-guias-sin-envio`): fallan por falta de archivos, no por el cambio. Esos van en la
máquina de Felipe.

## Cache busting

Una sola versión global en TODAS las páginas. Ojo: `shared/cotizador/cotizador_courier_v8.html`
está FUERA de `frontend/`, y `test-motor-unico` lo controla.

## Lo que queda pendiente

1. **Probarlo en producción con un cliente real** — nunca se hizo. Ahora con más motivo:
   verificar que la hoja de solo-UPS dé clavada contra el tarifario de UPS Saver.
2. La marca Exportalo usa `#1B7FC4` en los encabezados (el celeste del logo no deja leer el
   texto blanco). Si Felipe quiere el celeste exacto, hay que oscurecer el texto.
3. Importación: el motor la soporta, pero no se probó con datos reales de impo.
4. Definir si el tarifario corta en 300 kg (arriba de eso DHL no tiene tabla y el motor
   extrapola).
5. Los topes de medida (deuda 29): el sistema no frena el lado largo de 274 cm de UPS ni el
   límite de pieza de DHL.
