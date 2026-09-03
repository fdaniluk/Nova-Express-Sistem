# Tarifa DHL "MAS 50 KGS" cargada al sistema (01/09/2026)

**Estado: EN PRODUCCIÓN** (`3d431cd` + `8c5ea3a`), **auditada módulo por módulo** (ver §
"La auditoría del cruce" abajo, que destapó y cerró un agujero real).
Reemplaza el análisis de `claude/TARIFARIO-DHL-UNIFICADO.md` (03/08), que estaba
incompleto: le faltaba el GoGreen.

## Lo que destrabó el trabajo

El doc de agosto terminaba con una pregunta abierta: *"el unificado supone que Nova puede
elegir con qué tarifario despachar cada guía. Falta confirmarlo con DHL."*

Felipe la contestó él mismo al pedir el trabajo: **la MAS 50 KGS es una cuenta DHL
distinta.** No hay que elegir un tarifario por cuenta — hay dos cuentas y se despacha por
la que convenga. Eso es exactamente lo que hace falta para cargarla.

## El dato que da vuelta todo: el GoGreen

Sobre la marcha Felipe agregó que **esa cuenta no cobra GoGreen**. Son 0,98 USD por kilo
facturable: en 60 kg, 58,80 USD — más que toda la diferencia de flete entre las dos tarifas.

El análisis de agosto comparaba fletes pelados y por eso concluía que en zonas 1 y 3 la
+50 no ganaba nunca. Comparando el **costo completo** (flete + fuel + GoGreen), gana en las
seis zonas, en todo el rango de 51 a 300 kg:

| Zona | Antes (sin GoGreen) | Con GoGreen | Ahorro a 60 kg |
|---|---|---|---|
| 1 · Brasil, Chile, Uruguay | nunca | 51–300 kg | 47,14 (11,4%) |
| 2 · Colombia | 51–84 kg | 51–300 kg | 64,74 (13,4%) |
| 3 · EE.UU., México, Canadá | nunca | 51–300 kg | 30,73 (5,8%) |
| 4 · España, Alemania, Italia | 51–300 kg | 51–300 kg | 108,80 (16,5%) |
| 5 · China, Japón | 51–300 kg | 51–300 kg | 155,42 (15,7%) |
| 6 · Australia | 51–300 kg | 51–300 kg | 229,67 a 150 kg (11,6%) |

**Evidencia interna que respalda el dato:** el motor ya excluía el GoGreen en importación
arriba de 50 kg (`aplicaGoGreen = !(import && pf>50)`). La tarifa de impo ya cargada es de
la misma familia y ya funcionaba así.

## Verificación de la tabla

Del PDF `TARIFARIO DHL EXPO MAS 50 KGS.pdf` (cliente NOVA EXPRESS / DANILUK MARCELO):

- **Arriba de 50 kg la tarifa es exactamente lineal**: `precio = kilos × valor por kilo`,
  con rates por zona **4,38 · 4,98 · 6,00 · 6,60 · 7,50 · 8,40**. Las 250 filas (51 a 300 kg)
  × 6 zonas dan `kg × rate` al centavo, **sin una sola excepción**. Por eso en el motor va
  como fórmula y no como tabla de 1.500 números.
- **Debajo de 51 kg tiene tabla propia y es mucho más cara** (0,5 kg zona 1: 71,18 contra
  24,91 de la de siempre). Ahí no se mira nunca.
- **Control cruzado del parser:** el mismo PDF trae la tabla de importación, y sus 1.500
  celdas coinciden **al centavo** con `DHL_I_BIG`, que ya estaba cargada y verificada. O sea
  que la extracción es correcta y las dos tarifas son la misma familia.

## Las decisiones de Felipe (01/09)

1. **La leyenda va en las tres pantallas**: cotizador, panel de precio de Cargar envío y
   grilla de Salidas. Su razón: *"a la hora de hacer la guía, necesitamos saber que se está
   usando esa tarifa más cincuenta para ver qué cuenta usar"*, y la guía se emite desde el
   envío, no desde el cotizador.
2. **Siempre la +50 arriba de 50 kg.** En zonas 1 y 3 el flete de tabla de la +50 es más
   caro y gana solo por el GoGreen. Felipe eligió la regla única, igual que impo: es lo más
   simple de explicar y de auditar, y nunca perjudica a Nova.
3. **Solo exportación.** La de importación ya estaba cargada y no se tocó.

## Cómo quedó en el código

**`shared/cotizador/cotizador-core.js`**

```js
const DHL_E_50_PK=[4.38,4.98,6.00,6.60,7.50,8.40];
const MSG_TARIFA_50='Tarifa +50 kg — se despacha por la OTRA cuenta de DHL';
function getDHLE50(zona,pf){
  if(!(pf>50))return null;
  return parseFloat((Math.ceil(pf)*DHL_E_50_PK[zona-1]).toFixed(2));
}
```

En la rama DHL de `cotizarServicio`, exportación arriba de 50 kg y no documento:

```js
const flete50=getDHLE50(zona,pf);
if(flete50){
  const costoNormal=fleteBase*(1+fuel)+parseFloat((pf*0.98).toFixed(2));
  const costo50    =flete50*(1+fuel);
  if(costo50<costoNormal){fleteBase=flete50;tarifa50=true;}
}
...
const aplicaGoGreen=!tarifa50&&!(tipo==='import'&&pf>50);
```

**La comparación queda escrita aunque hoy gane siempre la +50.** Si mañana cambia
cualquiera de las dos tablas, la regla "siempre lo más barato" sigue siendo verdad sin que
haya que volver a hacer el análisis. El resultado devuelve `tarifa50` y `avisoTarifa50`.

**Se compara COSTO COMPLETO, no flete pelado.** Es el punto que hizo fallar el análisis de
agosto: una tarifa paga GoGreen y la otra no.

**Persistencia.** Columna `envios.tarifa_50` (INTEGER NOT NULL DEFAULT 0), congelada con el
resto del costo en `desglosarCosto` y recalculada **por los dos caminos que recalculan
costo**: `PUT /api/envios/:id` y el `POST /api/salidas/:id/recalcular` del modal.
**No se deduce del peso al mostrar**: lo cargado antes del 01/09 salió por la cuenta de
siempre, y deducirlo marcaría envíos viejos con una cuenta que en su momento no se usó.

**Dónde se ve.**

| Pantalla | Qué muestra |
|---|---|
| Cotizador | ítem ámbar en la **tira interna** ("Solo para la oficina") |
| Cargar envío | cartel `⚑` arriba del desglose de precio |
| Salidas · grilla | chip `+50` al lado del badge DHL, con tooltip |
| Salidas · modal | cartel arriba del bloque de Costos, al abrir y tras Recalcular |
| Salidas · Calcular venta | cartel arriba del panel de precio sugerido |

🔴 **En el cotizador NO va adentro de la tarjeta.** La oficina le manda la cotización al
cliente sacándole una foto a la tarjeta: con qué cuenta de DHL despacha Nova es información
interna, igual que el profit y el precio por kilo. Va en la tira interna, que nunca entra en
la imagen. Hay un control que lo verifica. **El link público tampoco lo filtra**: usa lista
blanca, y `tarifa50` no está en ella.

---

## La auditoría del cruce (01/09, pedida por Felipe)

Apenas se desplegó, Felipe pidió: *"revisá que en todos los lados donde esta tarifa vaya a
modificar algo haya quedado todo bien y esté dando todo el mismo número"*. El mapa completo
y el resultado:

### 🔴 Lo que apareció: el Recalcular del modal de Salidas perdía la marca

**Era un defecto de verdad, no una hipótesis.** El modal de Salidas recalcula el costo por
una ruta propia (`POST /salidas/:id/recalcular`) y lo guarda con el PATCH, que **no
recotiza**. La respuesta del recálculo traía flete, fuel y adicionales nuevos — calculados
con la tarifa +50 — pero **no traía `tarifa_50`**, y el PATCH no lo aceptaba.

El efecto: subir un envío de 40 a 70 kg desde el modal dejaba **el costo de la cuenta nueva
y el chip de la vieja**. La fila no mostraba el `+50` y la guía se emitía contra la cuenta
equivocada. Es la **regla siete** del proyecto: un guardado de dos pasos se olvida siempre.

Arreglado: `recalcular` devuelve `tarifa_50`, el PATCH lo acepta (normalizado a 0/1, y
descartado si viene basura), el front lo persiste **solo si viene de un Recalcular de esta
sesión** (mismo criterio que `extras_json`), y el modal pinta el cartel. `tarifa_50` entró
además a `CAMPOS_PLATA`: si el flete de un envío liquidado no se puede tocar, la tarifa que
lo produjo tampoco.

### 🔴 Lo otro que apareció: una nota falsa en el tarifario del cliente

`frontend/js/modules/tarifario.js` ponía en el cuadro de notas: *"GoGreen: USD 0,98 por
kilo facturable, **aplicado a todas las exportaciones**"*. Arriba de 50 kg eso ya no es
cierto, y es una nota que **lee el cliente**: le prometía un cargo que no se le va a
facturar. Ahora, cuando el tarifario pasa de los 50 kg, dice *"en envíos de hasta 50 kg"*.

### Lo que se verificó y quedó bien

| Módulo | Cómo llega al número | Resultado |
|---|---|---|
| Cotizador manual | `cotizarServicio` directo | ✓ |
| Cargar envío (panel de precio) | `cotizarEnvio` → mismo motor | ✓ mismo total |
| Costo congelado del envío | `desglosarCosto` → mismo motor | ✓ y marca `tarifa_50` |
| Salidas (compra / profit estimado) | columnas congeladas | ✓ |
| Liquidación | **no recotiza**: lee lo guardado | ✓ cierra en lo cobrado |
| Tarifario del cliente | `cotizarServicio` con fuel 0 | ✓ celda = flete de venta pelado |
| Link público | `cotizarServicio` + lista blanca | ✓ mismo total, sin filtrar la cuenta |
| Dashboard / cierre / Excel | `costoEstimado` sobre columnas guardadas | ✓ agnósticos |

**Nadie recalcula el GoGreen por su cuenta.** Se buscó `0.98` y `GoGreen` en todo el repo:
fuera del motor solo quedan comentarios, el renombre del link público y la nota del
tarifario (corregida). El segundo motor que hacía eso (`descomponerPrecioBase`) ya se había
eliminado en su momento.

**La elección no depende del fuel.** Se probó con fuel 0, 10, 20, 27,5, 30, 37, 39,5, 45 y
60% sobre las 1.500 celdas: **cero casos** donde la elección cambie. Importa porque el
tarifario cotiza con fuel 0 y el envío real con el fuel del día: si dependiera del fuel, el
tarifario impreso podría prometer una tarifa y el envío salir por la otra.

**La comparativa entre couriers no cambia.** UPS Expedited seguía y sigue ganando en los
250 casilleros de las seis zonas arriba de 50 kg. La +50 no altera qué courier recomienda
el cotizador.

### Lo que Felipe conviene que sepa

**El tarifario que se le manda al cliente cambió arriba de 50 kg** (la celda es el flete de
venta, y ahora sale de la otra tabla):

| Zona | 60 kg | 300 kg |
|---|---|---|
| 1 · Brasil, Chile, Uruguay | **+3,3%** | **+12,1%** |
| 2 · Colombia | −1,4% | +1,8% |
| 3 · EE.UU., México, Canadá | **+5,9%** | **+7,6%** |
| 4 · España, Alemania, Italia | −8,3% | −3,6% |
| 5 · China, Japón | −10,1% | −5,2% |
| 6 · Australia | −8,6% | −3,1% |

Sube en zonas 1 y 3 porque ahí el flete de la +50 es más caro y gana solo por el GoGreen —
que el tarifario nunca incluyó (la celda es flete pelado). **Un tarifario emitido antes del
01/09 con destinos de zona 1 o 3 y pesos grandes quedó desactualizado hacia arriba.**

**Lo que efectivamente paga el cliente** solo sube en zonas 1 y 3, y solo con márgenes altos
y pesos grandes (desde qué kilo empieza a pagar más que antes, fuel 39,5%):

| Margen | z1 | z2 | z3 | z4 | z5 | z6 |
|---|---|---|---|---|---|---|
| 40% | nunca | nunca | nunca | nunca | nunca | nunca |
| 60% | 214 kg | nunca | nunca | nunca | nunca | nunca |
| 75% | 161 kg | nunca | 104 kg | nunca | nunca | nunca |
| 100% | 120 kg | nunca | 63 kg | nunca | nunca | nunca |
| 150% | 89 kg | nunca | 52 kg | nunca | nunca | nunca |

## Las tandas

- **`npm run test-tarifa-50`** — 32 de motor + 39 de punta a punta + 30 de cruce.
- **`test-tarifa-50.js`** (motor): las celdas del PDF copiadas a mano, la linealidad de las
  1.500 celdas, el redondeo al kilo, el borde 50/51, y el control duro — **en los 1.500
  casilleros se eligió siempre el costo menor**. Más lo que no se tiene que mover:
  documentos, importación, UPS y todo lo de 50 kg para abajo.
- **`test-pantalla-tarifa-50.js`**: que el flag se congele en el alta, que se recalcule por
  los dos caminos (PUT de envíos **y** el Recalcular del modal, con su PATCH), que llegue a
  la API de Salidas, que el GoGreen desaparezca del costo congelado, y que la leyenda esté
  donde va y **no** en la tarjeta del cliente ni en la nota del tarifario.
- **`test-cruce-tarifa-50.js`**: el MISMO envío de más de 50 kg por los seis caminos del
  sistema, comprobando que todos cierran en el mismo número y que las identidades
  (venta − profit = costo · flete+seguro+fuel+adicionales = total) siguen valiendo con el
  GoGreen afuera.
- Registradas en `test` y `test-pantallas`, así que `npm run verificar` las corre.

## Lo que queda para que decida Felipe

**Declarar 51 kg en envíos de 41 a 50 kg.** Como a 50 kg todavía se paga GoGreen y a 51 no,
hay una inversión: **un envío de 51 kg sale más barato que uno de 50**. Se puede aprovechar
declarando 51 kg (se paga por más peso del real, que DHL acepta sin problema):

| Zona | Conviene desde | Ahorro en un envío de 50 kg |
|---|---|---|
| 1 | 43,5 kg | 39,99 |
| 2 | 43,5 kg | 51,46 |
| 3 | 47,5 kg | 22,15 |
| 4 | 41,5 kg | 89,68 |
| 5 | 40,5 kg | 107,58 |
| 6 | 41,5 kg | 103,94 |

**No está implementado.** Declarar más peso del real es una decisión comercial, no un
detalle técnico, y no se toca sin el OK de Felipe.
