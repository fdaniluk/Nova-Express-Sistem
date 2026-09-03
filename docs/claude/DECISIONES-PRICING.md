# Decisiones de pricing — cerradas y abiertas

Las diez decisiones que estaban trabadas en el backlog. **Cinco las resolvieron los
tarifarios oficiales, una era un bug, cuatro las contestó Felipe el 29/07.** Todas cerradas.

---

## 🚫 REGLA QUE NO SE TOCA — el redondeo del peso

**El redondeo del peso facturable se aplica al TOTAL del envío, nunca bulto por bulto.**

Felipe, 29/07: *"si yo tengo siete bultos que cada uno tiene su medida, no se van a redondear
esas medidas, se va a redondear la suma de esos siete bultos... si no estás cobrando mucha
plata de más. Ya nosotros habíamos corregido esto."*

Esto **ya estaba corregido por ellos** y es deliberado. Si en el futuro aparece que "el
sistema cobra de menos" comparado con el redondeo por bulto: **no es un bug, es la regla.**

Contexto de por qué puede volver a confundir: la guía de UPS 2026 dice, en la página 4,
*"Incremente las fracciones de kilogramo al siguiente medio kilogramo"* para el peso
dimensional de cada paquete, y *"totalice el Peso Facturable de todos los paquetes"*. Leído
literal, UPS redondearía por bulto. **Nova no cobra así, a propósito.**

### Lo que sí era un error: el cartel

Reportado por la oficina el 29/07 sobre una cotización de 22 bultos de 60×35×35:

```
antes:  323.4 kg facturable · 330.0 kg vol   ← el encabezado se contradecía
ahora:  323.4 kg facturable · 323.4 kg vol
```

Los 330 salían de `getPesoVol()`, que redondea cada bulto a 0,5 (14,7 → 15) y se usaba solo
para mostrar. **El precio siempre estuvo bien.** Se cambió el cartel del encabezado y el de
cada bulto para que muestren el volumen crudo, igual que el cálculo. Fijado en
`npm run test-cartel-peso`, que reproduce el caso en un navegador y verifica que el total
siga dando 4.373,99.

---

## Cerradas por los tarifarios oficiales (28/07)

| # | Era | Cómo quedó |
|---|---|---|
| 1 | Thresholds DHL: ¿120→116 o 100/80? | **100 / 80 estaba bien.** El backlog estaba equivocado. |
| 2 | Surge de Israel: ¿3.30 sigue vigente? | **En exportación sí; en importación UPS lo eliminó** el 24-may-2026. De paso apareció que el set ISMEA tenía 36 países cuando el comunicado lista 14. |
| 6 | Contorno UPS >400 cm: ¿se cobran los 120? | **No.** Arriba de 400 cm el envío no se acepta. El aviso que ya había es lo correcto. |
| 8 | Documentos DHL: ¿qué tabla? | **De documento**, hasta 2 kg. Era el problema de Kasdorf y Cremona. |
| 9 | Manejo adicional + contorno UPS juntos | **No van juntos.** Confirmado por Felipe el 29/07. |

## No era una decisión, era un bug (29/07)

**#5 — Sobrepeso DHL: el cotizador cobraba 125 y el backend 23.** El motor era el mismo pero
le llegaban datos distintos: el cotizador mandaba el peso facturable de cada bulto y el
backend solo el real. El tarifario dice *"peso real **o volumétrico**"*, así que los 125 eran
los correctos y **el backend cobraba 102 USD de menos por bulto**. Corregido en
`mkBultosProc`.

## El "escalón de los 32 kg" — no es un bug (29/07)

UPS tiene tabla hasta 31,5 kg y de ahí cobra por kilo **con un mínimo**, que es justo el
precio de los 31,5 kg. De 31,5 a 36,5 kg todo cuesta lo mismo. Coincide con el Excel al
centavo.

---

## Contestadas por Felipe el 29/07

**Seguro DHL (mínimo 17,50) — SE DEJA.** *"Son valores que pusimos nosotros."* Precio de
venta de Nova, no tarifa de DHL.

**Seguro UPS (0 / 15 fijo / 1,5%) — SE DEJA.** Mismo motivo. UPS cobraría 1,20 por cada 100
(6 USD en un valor de 500); Nova cobra 15.

**El surge — PASA A COSTO**, sin ganancia. Hasta nuevo aviso.

**El IPF de 2,50 — PASA A COSTO.** Antes se sumaba al flete antes del margen y con 120% le
llegaba al cliente como 7,33. Ahora va en una línea aparte, después del fuel. Sobre los 59
envíos a EE.UU. son ~4,83 menos por envío.

> Criterio que quedó parejo: **todo recargo del courier pasa al costo** (surge, DDP, IPF,
> zona de entrega). La ganancia se calcula solo sobre el flete de tabla.

**Área remota vs extendida — SE ACOMODÓ.**

| | UPS | DHL |
|---|---|---|
| Área extendida | 42,15 o 0,92/kg, el mayor | 40,00 o 0,80/kg |
| Área remota | **5,86 por envío a EE.UU.** · al resto, la de extendida | 40,00 o 0,80/kg |

El casillero que existía pasó a llamarse **Área extendida** con la misma tarifa, y se agregó
**Área remota** aparte. Los envíos viejos tienen `remota = 1` y `entrega = NULL`, y el motor
los lee como 'extendida': **ninguno cambia de precio**.

**#10 — Percepción de Ingresos Brutos: ES COSTO.** Felipe lo consultó con su jefe el 29/07.
Se reparte entre las guías de la factura, proporcional al costo de cada una, con reparto
exacto (sin centavos perdidos). **Solo reparte si la suma de las guías cuadra con el subtotal
del pie**: si no cuadra, la diferencia es una guía que no se leyó y repartirla ensuciaría el
costo de todos los envíos.

---

## Cargos del tarifario que el sistema no contempla

Aparecen recién en la factura y van a salir como descuadre al conciliar:

corrección de dirección 22,20 (máx 153,75) · auditoría de peso (el mayor entre 1,65 y 12% de
la corrección, cuando el peso difiere más de 25%) · falta de número de cuenta 14,00 · entrega
en sábado 18,45 · límites máximos excedidos 1.010,00 · factura comercial impresa 25,00 ·
firma requerida 5,41 / adulto 6,62 · liberación por courier (20% del CIF hasta 500, máx
68,72; 9,5% arriba, máx 126,00) · honorarios de import/export formal 401,35 o 0,55% del CIF ·
manejo de documentación 108,90.
