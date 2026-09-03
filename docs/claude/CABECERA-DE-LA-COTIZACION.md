# La cabecera de la imagen de la cotización

**25/08/2026 · commit `007eef9`.** Dos cosas encimadas en el mismo lugar, las dos vistas por
Felipe en una captura que mandó ese día.

---

## Qué estaba mal

La imagen de la cotización (el PNG que la oficina pega en WhatsApp) se dibuja de cero en un
canvas. Un canvas **no tiene layout**: nadie avisa cuando dos textos caen en el mismo lugar.

1. **El cartel "Tarifa +50Kg"** se dibujaba abajo a la derecha de la cabecera, 7 px por
   debajo de la línea de medidas. Esa línea es larga por naturaleza y desde el 24/08 lleva
   además el FOB declarado, así que llegaba hasta el borde: el cartel le quedaba encima.
2. **La línea de medidas se salía de la hoja.** Con un solo bulto lleva también las tres
   medidas (`60×50×40 cm`), y con el FOB llegaba a ~723 px sobre un ancho de 680: el valor
   declarado quedaba **cortado a la mitad**.

Lo segundo era lo grave. El FOB se agregó el 24/08 justamente para que el cliente no pueda
decir después *"yo nunca declaré ese valor"* cuando llegan los impuestos de destino. Un FOB
cortado no sirve para eso.

---

## Cómo se arregló

**El cartel pasó al renglón del courier**, pegado a "Nova Express – DHL". Es donde ya vivía
en la tarjeta de la pantalla (ahí es un `<span>` adentro de `.result-courier`), así que
ahora el papel y la pantalla dicen lo mismo en el mismo lugar. Solo aparece en impo DHL de
más de 50 kg, y DHL es el nombre corto: sobra lugar. Igual no se confía — se dibuja **solo
si entra antes del total**, medido en el momento.

**La línea de medidas se achica sola** lo justo para entrar de margen a margen: se mide
entera, se calcula cuánto hay que encogerla y recién ahí se dibuja. Casi siempre el factor
da 1 y no se toca nada; el piso de 8,5 px es para que nunca quede ilegible.

De paso: `.result-total` de la tarjeta de pantalla lleva `white-space:nowrap`. Con el panel
de compra al costado la tarjeta se angosta y el precio se partía en dos renglones
(`USD` arriba, el número abajo).

---

## El control que quedó

`test-pantalla-cotizacion-cliente`, sección 8 (la tanda pasó de 48 a 55 controles).

No mira el PNG —haría falta OCR— sino **cada trazo**: espía `fillText`, anota qué se
escribió, dónde y con qué fuente, y después mide. Tres reglas:

- el cartel tiene que estar en el renglón del courier, no sobre la línea de medidas;
- la línea de medidas tiene que entrar entera entre los márgenes;
- **ningún texto puede encimarse con otro** ni salirse de la hoja. La altura se compara con
  una banda de 10 px y no exacta: el cartel roto no compartía baseline con la línea de
  medidas —estaba 7 px abajo— y la tapaba igual.

Se probó al revés: con el código viejo puesto de nuevo a propósito, los cuatro controles se
ponen rojos. Con el arreglo, verde.

El caso de prueba es el de la captura: un solo bulto (que es cuando la línea lleva las
medidas), impo DHL de más de 50 kg y FOB declarado.

---

## Lo que se tocó

`frontend/pages/cotizador.html` (el dibujante del canvas y el CSS de la tarjeta) ·
`backend/scripts/test-pantalla-cotizacion-cliente.js`. Cache busting **`?v=20260825b`** en
las 17 páginas.

⚠️ **El dibujo vive adentro de `cotizador.html`**, que es la página misma: el cache busting
de los scripts no la cubre. Después de desplegar hay que hacer **Ctrl+F5** o se sigue viendo
el diseño roto con el servidor ya arreglado.

**`npm run verificar`: 44 tandas · 1216 controles · 0 fallas**, en el contenedor y en la
máquina de Felipe.
