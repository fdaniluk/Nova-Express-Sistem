# Auditoría numérica integral — 28/08/2026 (tarde-noche)

Pedida por Felipe: *"todo lo que sume o reste o modifique un número, revisado de vuelta…
esto se está convirtiendo en la verdad absoluta"*. Dos rondas: (1) datos reales sobre la
copia de producción **posterior a la recarga de facturas**
(`nova_backup_20260828_164648.db`, 347 envíos, 41 liquidaciones, 14 facturas), y
(2) **peine fino del código, fórmula por fórmula**, de todo lo que toca plata.

---

## VEREDICTO CORTO

**El motor calcula bien. Las tablas son EXACTAS contra las facturas reales. No apareció
ningún error de cálculo vivo en producción.** Hallazgos: 2 defectos chicos de código
(deudas 38 y 39, uno latente y uno de USD 0,35 por envío residencial), una alerta de
plata puntual (envío 194 / cuenta F33G), y trabajo de oficina sobre pesos.

---

## 1 · El motor contra la realidad de UPS (111 guías de julio)

| Qué se comparó | Resultado |
|---|---|
| **Tablas de flete** (UPS_E_LIQD y demás) | **EXACTAS AL CENTAVO.** La prueba reina: 6 guías que UPS facturó sin fuel dieron neto == tabla con ratio 1,000 clavado, en pesos de 1 a 42 kg, zonas 2-4, incluida la fórmula de >31,5 kg (mínimo vs kg×tarifa). Las tablas del sistema SON la tarifa negociada. |
| **Fuel del sistema (37%)** | Correcto: ratio neto/tabla mediana **1,368** (p25 1,348 · p75 1,414). El fuel real de julio rondó 35-37% según la semana. |
| **Surge fee** (0,50/kg, ISMEA 2,95, etc.) | UPS lo factura bajo DOS nombres: "SURGE FEE - COM" (61 guías) y "CARGO POR INCREMENTO DE VOLUMEN" (43). Entre los dos está en **104 de 111 guías** y el monto coincide EXACTO con `getSurge()` en todas. Cobrarlo siempre es correcto. |
| **Recargos fijos** | Additional Handling 27,65 ✓ · IPF 2,50 ✓ · Declared Value existe como costo del courier (no modelado — el seguro de venta lo cubre de sobra). |
| Guías con ratio raro (>1,5) | ~6, anomalías de facturación del courier por guía (España 60 kg ratio 2,0 con peso re-facturado, Malasia 24 kg 1,93). Para la pestaña Revisar. |

### ⚠️ ALERTA DE PLATA — la cuenta `1ZF33G` factura a TARIFA DE LISTA
La única guía de esa cuenta (factura 75310) costó **USD 408 el flete de 10,5 kg a Canadá**
— la tarifa 327W para eso es USD 69: **casi 6 veces más**. Y el envío que la usó (**#194,
Enrique Schwartz, 24/07**) tiene **costo real USD 429,36 y precio de venta SIN CARGAR**:
facturado con la tarifa de siempre se pierden ~USD 300. **Averiguar qué es la cuenta F33G.**

## 2 · Pesos: lo que UPS pesó vs lo que se cargó

**60 de 111 guías difieren más del 10%** (la tolerancia configurada). En 46 UPS facturó
MENOS kilos (a favor); en **14 facturó MÁS** (margen que se escapa): Malasia 20,2→24 ·
UK 24,2→32 · UK 12,3→16,5 · EE.UU. 85,4→96,5 · EE.UU. 24,2→33,5, etc. Parte es la regla
de redondeo vieja (envíos de julio), las grandes son re-pesajes/re-cubicajes reales.
**La pestaña Revisar ya los tiene marcados (87 en `a_revisar`).**

## 3 · Consistencia interna de la plata (producción entera)

| Chequeo | Resultado |
|---|---|
| `total_cobrado` = costo estimado + profit (104 envíos con venta) | ✓ en todos los que tienen desglose. 34 tienen `profit` NULL en la columna (importados/tipeados a mano) — **no es error**: las pantallas derivan la utilidad al vuelo con `deriveProfit`. |
| `porcentaje` guardado vs profit/costo | **0 desvíos.** |
| `fuel` congelado vs (flete+surge)×fuel_pct | **347 de 347 adentro de la banda.** |
| Venta < costo estimado · venta < costo real | **0 · 0.** |
| Liquidaciones: total = Σ items (41) · items suman (65) · huérfanos | ✓ · ✓ · 0. `utilidad_usd` == profit congelado ✓. |
| Cotizaciones guardadas (5): opciones suman · acordado == opción | ✓ · ✓. El "precio sugerido" escribe redondeado a 2 decimales ✓. |
| Peso facturable recalculado desde bultos (117 envíos) | Regla nueva bien en TODOS los posteriores al 20/08 (1 caso límite del mediodía del 20/08, pre-deploy). Los 67 anteriores: regla vieja, congelados a propósito. |
| Facturas: Σ líneas + percepciones = total declarado (14) | ✓. |

## 4 · Peine fino del CÓDIGO, fórmula por fórmula (ronda 2)

Revisado línea por línea: `cotizador-core.js` completo (tablas, interpolaciones,
`getUPS`/`getDHL`/`getDHLBig`/ES-IT, surge, seguros courier y propio, extras DHL
(sobrepeso 125 / exceso 23 / no convencional 23 en cadena else-if como el tarifario),
extras UPS (manejo 27,65 sin acumular con Mayor Tamaño, mínimo 40 kg, contorno >400
warn), zona de entrega, ambos servicios de punta a punta) · `calculos.service.js`
(pesos, redondeo por bulto, `cotizarEnvio`, `desglosarCosto`) · `utils/profit.js`
(`deriveProfit`/`costoEstimado`) · `profit.service.js` (tramos sin huecos ni solapes,
precedencia celda→banda→zona→tabla→cliente en % y en $/kg, "el kg cargado gana SIEMPRE")
· liquidaciones (modelo y controller) · `cierre.service` (SUMABLES, NO VOLÓ afuera) ·
dashboard (`utilidadEnvio`, desvío estimado-vs-real) · `excel.service` (importador y
export) · cobranzas · y las copias del frontend (bandas por defecto **hoy idénticas**
al backend, redondeo por bulto replicado igual, cotizador y Salidas cotizan por el
endpoint único).

**Lo que quedó verificado de diseño:** `adicionales` se guarda como RESIDUAL
(total−flete−seguro−fuel), así la suma cierra por construcción · la ganancia aplica solo
sobre el flete de tabla y el IPF/surge/DDP van a costo sin margen ni fuel (criterio
29/07) · fuel = (flete con margen + surge) × pct · el seguro propio del cliente
reemplaza la escala entera y el pct null con mínimo suelto se descarta (defensa
explícita contra `isFinite(null)`).

### Los hallazgos de la ronda 2

1. **Deuda 39 — Entrega residencial UPS: el motor cobra 5,65 y UPS facturó 6,00 en las
   50 apariciones de julio.** El comentario del código dice que 5,65 es "la tarifa
   internacional" y 6,00 "la nacional" — la factura real dice lo contrario. Son USD 0,35
   × cada envío residencial que se cobran de menos. Cambio de 1 número, pero ES PRECIO:
   esperar el OK de Felipe.
2. **Deuda 38 — Importador: `asegurado = fob > 100`** y la regla del motor es `>= 100`
   (USD 100 exacto paga seguro). Sin daño en producción (los 4 envíos con FOB=100
   cobraron sus 15). 1 carácter.
3. **Deuda 30, ahora con dirección exacta:** el aviso "manejo adicional desde 120 cm"
   vive en `shared/cotizador/cotizador_courier_v8.html` líneas 178 (texto) y 259
   (warn `>120`); el motor y `cotizador.html` ya dicen 122. Solo texto/aviso, no plata.
4. Observaciones de centavos (para decidir alguna vez, no urgentes): la zona de
   entrega UPS por kg (0,92/kg) y el GoGreen DHL (0,98/kg) usan el peso crudo en vez
   del facturado (redondeado / mínimo 40 kg) — diferencias de centavos con mínimos que
   casi siempre mandan · el comentario de `desglosarCosto` dice "feeUSA va al flete"
   pero el código lo deja en adicionales (solo el comentario está viejo) · los
   impuestos de importación del cotizador (tasa 3%, IVA 21%, gasto doc 6,12%) son
   informativos ("estimados") — confirmar el 6,12% con el despachante alguna vez.

## 5 · Datos de tarifas (sin cambios de código)

- PIO ALVAREZ: **81 precios por kilo en USD 0** — L17, en manos de la oficina.
- **51 clientes con envíos desde julio y sin margen configurado** (tarifa_pct ≤ 0) — L4.
- Overrides de $/kg y de %: **sin negativos, sin solapamientos**.
- 4 bultos huérfanos (L6) · 4 bultos con peso y sin medidas (vol=0 → cobra por peso real).

## 6 · Lo que esta auditoría NO pudo validar

- **El costo DHL contra la realidad**: no hay facturas DHL cargadas (no existe parser).
  Tablas DHL verificadas contra el tarifario en papel (18/08), no contra factura real.
- Los fuels históricos congelados (29,8→39,5%) se asumen los vigentes de cada fecha.

## Método (para repetirla)

Copia real vía OneDrive (circuito en ESTADO §1) → scripts efímeros `_aud1..4.js`:
(1) ratio neto/tabla por guía con `getUPS`/`getSurge` del core, (2) composición de
venta + profit + banda de fuel, (3) liquidaciones/items/cierres/cotizaciones, (4) pesos
desde bultos + márgenes negativos + sanidad de overrides. Más la lectura línea por línea
del punto 4. La anterior de este estilo: `AUDITORIA-NUMEROS.md` (07-18/08).
