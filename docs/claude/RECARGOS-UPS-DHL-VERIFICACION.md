# Recargos UPS y DHL — verificación contra los tarifarios oficiales

**Estado: las 11 diferencias están CORREGIDAS** en `shared/cotizador/cotizador-core.js`
(28/07). Abajo queda el detalle de cada una, para poder discutirlas con administración o con
el ejecutivo del courier si alguna vez hace falta justificar un número.

Comparación línea por línea contra:

- **UPS Guía de Tarifas y Servicios Argentina 2026** (vigente 21-dic-2025), secciones Valor
  Agregado / Cargos Adicionales / Servicios de Aduana
- **UPS Cargo Extraordinario por Incremento de Volumen (Surge Fee)**, vigente 24-may-2026
- **UPS International Processing Fee (IPF)**, vigente 8-sep-2025
- **DHL — Servicios opcionales y recargos** (mydhl.express.dhl, consultado 6-1-26)

---

## Impacto real medido sobre la base de producción

`node scripts/impacto-recargos.js` recotiza los 158 envíos cargados con el motor viejo y con
el nuevo:

```
sin cambio de precio: 143
CAMBIAN de precio:     15

suben:   3 envíos ·  +92.00 USD
bajan:  12 envíos ·  -43.60 USD
neto:                +48.40 USD
```

| Destino | Envíos | Diferencia |
|---|---:|---:|
| DHL · Reino Unido · expo | 1 | +46.00 |
| DHL · Nigeria · expo | 1 | +23.00 |
| DHL · Kenia · expo | 1 | +23.00 |
| UPS · Canadá · expo | 12 | −43.60 |

Que 143 de 158 no se muevan es la señal de que el cambio es quirúrgico y no una reescritura
del motor. Los tres que suben son las piezas de 25–70 kg de DHL; los doce que bajan son el
IPF que Canadá no debía pagar.

---

## A. Lo que el sistema NO cobraba y el proveedor sí

### A1. DHL — "Pieza no convencional" (non-conveyable): USD 23.00 por bulto

DHL cobra 23 USD por **cada pieza de entre 25 kg y 70 kg** (además de otros criterios:
embalaje que no sea cartón corrugado, forma cilíndrica, con ruedas o asas, film estirable).
No aplica a piezas que ya pagan sobrepeso o exceso de tamaño.

En la base hay **5 piezas DHL** en ese rango → USD 115 que DHL facturó y el sistema nunca
cotizó.

*Corregido:* nueva rama en `calcDHLExtras`, encadenada con `else if` después de sobrepeso y
exceso de tamaño, para respetar la exclusión. Aparece como línea propia en el desglose.
**Criterio de borde:** el tarifario dice "entre 25 kg y 70 kg" sin aclarar si incluye los
extremos; se tomó inclusivo (`>=25 && <=70`). Una pieza de exactamente 70 kg paga los 23, no
los 125 de sobrepeso (que exige *más* de 70).

### A2. UPS — Paquete de Mayor Tamaño: faltaba el mínimo de 40 kg facturables

*"Paquetes de Mayor Tamaño están sujetos a una tarifa mínima a facturar de 40 kilogramos."*
El sistema aplicaba los 120 USD del recargo pero seguía cotizando por el peso facturable real.
Un bulto voluminoso y liviano se cotizaba por 6 kg y UPS lo facturaba por 40.

*Corregido:* `calcUPSDimExtras` ahora devuelve `minPesoExtra`, los kilos que faltan para
llegar a 40 en cada bulto de mayor tamaño, y el cálculo de extras se movió **antes** de la
búsqueda de tarifa para que ese peso llegue al flete. Si el bulto ya factura más de 40 kg no
se suma nada. El cotizador avisa en pantalla cuando el mínimo se aplicó, para que la oficina
no se sorprenda de que el precio no coincida con el peso que ve.

### A3. UPS — Surge de importación desde China, Hong Kong y Macao: 0.70 USD/kg

La tabla de importación tiene fila propia para esos tres orígenes. El sistema caía al "resto
del mundo" y cobraba 0.50. Hoy no hay importaciones de esos orígenes cargadas, pero el hueco
estaba.

### A4. UPS — Faltaban tres países en ISMEA: Bangladesh, Nepal y Sri Lanka

Van a 2.95/kg y se cobraban a 0.50. Diferencia 2.45 USD/kg.

### A5. UPS — Paquete de Mayor Tamaño: 120.00 → 120.10

---

## B. Lo que el sistema cobraba de más

### B1. IPF de 2.50 USD a Canadá — no correspondía

El código cobraba 2.50 en exportaciones a **Estados Unidos o Canadá**. El comunicado del IPF
es explícito: es un cargo de la aduana **de Estados Unidos**. Canadá no figura en ninguna
parte.

Son 12 envíos en la base. Y el IPF se suma al flete **antes** de aplicar la ganancia, así que
con 120% de utilidad esos 2.50 le llegaban al cliente como 5.50.

### B2. UPS — 23 países cobrados como ISMEA que no lo son

El comunicado define ISMEA taxativamente en una nota al pie: son 14 países — Afganistán,
Arabia Saudita, Bahréin, Bangladesh, Egipto, Irak, Jordania, Kuwait, Líbano, Nepal, Omán,
Pakistán, Qatar, Sri Lanka.

El set del código tenía 36. Sobraban 23: **Irán, Yemen, Libia, Sudán, Argelia, Túnez,
Marruecos, Etiopía, Eritrea, Somalia, Kenia, Tanzania, Uganda, Ruanda, Burundi, Tayikistán,
Uzbekistán, Kazajistán, Kirguistán, Turkmenistán, Azerbaiyán, Armenia, Georgia.**

A todos se les cobraba 2.95/kg cuando corresponde 0.50: **2.45 USD/kg de más.** En un envío
de 20 kg a Marruecos, 49 USD.

Probablemente el set venía de una versión anterior del comunicado, con un ISMEA más amplio.

### B3. UPS — Surge de importación desde Israel: UPS lo eliminó

*"El Cargo Extraordinario por Incremento de Volumen aplicable a las importaciones desde Israel
será eliminado a partir del 24 de mayo de 2026."* El código aplicaba 3.30 en los dos sentidos,
porque el `if` de Israel iba primero y no miraba el tipo de envío. En exportación Israel sí va
a 3.30 — eso estaba bien y no se tocó.

### B4. UPS — Manejo adicional y Paquete de Mayor Tamaño cobrados juntos

*"El cargo por Manejo Adicional no se cobrará cuando el cargo por Paquete de Mayor Tamaño haya
sido aplicado."* El sistema sumaba los dos: 27.65 USD de más por bulto. Ya estaba anotado como
duda en la auditoría anterior; el tarifario lo confirmó.

### B5. UPS — Entrega residencial: 6.00 → 5.65

6.00 es la columna **nacional**; la internacional es 5.65.

### B6. UPS — Manejo adicional por lado largo: 120 cm → 122 cm

El tarifario dice *"cuyo lado más largo exceda 122 cm"*. Los bultos de entre 120 y 122 cm
pagaban un manejo que no correspondía.

*Nota:* el aviso por bulto del cotizador (el textito gris debajo de cada fila) tenía la regla
duplicada con los valores viejos. Se alineó con el motor: mismo umbral de 122, no muestra
"manejo adicional" cuando el bulto ya paga mayor tamaño, y avisa de la pieza no convencional
de DHL.

---

## C. Verificado y correcto — no se tocó

| Concepto | Sistema | Oficial |
|---|---|---|
| DHL área remota | `max(40, pf × 0.80)` | 40.00 USD o 0.80 USD/kg |
| DHL pieza con sobrepeso (>70 kg) | 125.00 por pieza | 125.00 USD por pieza |
| DHL pieza excedida de tamaño (>100 / >80 cm) | 23.00 por pieza | 23.00 USD por pieza |
| DHL: exceso de tamaño no acumula con sobrepeso | `else if` | "No aplica a piezas sujetas a cargo por sobrepeso" |
| UPS manejo adicional | 27.65 por bulto | US$27.65 |
| UPS área remota/extendida | `max(42.15, pf × 0.92)` | US$42.15 o US$0.92/kg, el mayor |
| DDP (facturación de derechos) | 24.05 | US$24.05 por envío |
| Surge sujeto a combustible | sí (entra antes del fuel) | "está sujeto al recargo por combustible" |
| Surge sobre peso facturable | sí | "se aplicará en función del peso facturable" |
| Surge export ISMEA / Israel-EAU / resto | 2.95 / 3.30 / 0.50 | idem |
| Surge import India | 1.45 | 1.45 |
| IPF en exportación a EE.UU. | 2.50 | US$2.50 |

---

## D. Decisiones que siguen abiertas — no son mías

**1. El surge no lleva ganancia y el IPF sí.** El surge se suma después de aplicar la utilidad
(pasa a costo puro) y el IPF antes (se multiplica por el margen). No hay razón técnica: es una
inconsistencia. Hay que decidir si los dos pasan a costo o los dos llevan margen. **No se
tocó** porque cambia el precio de todos los envíos de UPS, no solo de los casos raros.

**2. El seguro UPS no sigue el tarifario de UPS.** El sistema usa la regla de Nova
(0 hasta 100 / 15 fijo hasta 1.000 / 1,5% arriba). UPS cobra 1,20 por cada 100 de valor
declarado o fracción, con mínimo de 3,50. Para un valor declarado de 500: Nova cobra 15, UPS
cobra 6. Si el 15 es precio de venta, está bien; si se supone que refleja el costo, está
inflado. Mismo caso que el seguro DHL.

**3. Área remota vs área extendida en UPS.** Son dos cargos distintos y el sistema tiene un
solo casillero. Extendida = 42.15 o 0.92/kg. Remota = **5.86 por envío a EE.UU., Alaska y
Hawaii**, y 42.15 / 0.92 solo para paletizado. Hoy cualquier envío marcado "remota" paga la
tarifa de extendida.

---

## E. Cargos del tarifario que el sistema no contempla (aparecen recién en la factura)

No son errores de cotización — son cargos que UPS aplica después y que van a aparecer como
descuadre al conciliar la factura:

- **Corrección de dirección**: 22.20 por paquete, máximo 153.75
- **Cargo por corrección de envío / auditoría de peso**: cuando el peso auditado difiere más
  de 25% del declarado → el mayor entre 1.65 y 12% de la corrección
- **Falta de número de cuenta / cuenta inválida**: 14.00
- **Entrega en sábado**: 18.45 (EE.UU., Canadá, Alemania, Reino Unido, Francia, Corea)
- **Límites máximos excedidos**: 1.010,00 (peso real >70 kg, largo >274 cm o combinado >400 cm)
- **Uso de factura comercial impresa**: 25.00
- **Firma requerida**: 5.41 · **firma de adulto**: 6.62
- **Liberación por courier**: CIF <500 → 20% del CIF (máx 68,72); CIF >500 → 9,5% (máx 126,00)
- **Honorarios de importación/exportación formal**: 401,35 si el CIF < 50.000; 0,55% del CIF
  si es mayor
- **Manejo de documentación**: 108,90

Vale la pena tenerlos a mano para el módulo de facturas: cuando una guía viene más cara que lo
cotizado, casi siempre es uno de estos.

---

## Pruebas

`npm run test-recargos` — 57 pruebas que fijan cada valor contra el tarifario: las tres tablas
de surge (export/import, país por país, incluidos los 23 que antes se cobraban de más y los 3
que faltaban), el IPF con y sin Canadá, los umbrales dimensionales de UPS, el mínimo de 40 kg
llegando efectivamente a la tarifa, y las cuatro exclusiones de DHL. Incluye una sección de
regresión que verifica que lo que ya estaba bien no se movió.

`node scripts/impacto-recargos.js` — recotiza la base entera con los dos motores y lista los
envíos que cambian. Solo lee; no escribe nada.
