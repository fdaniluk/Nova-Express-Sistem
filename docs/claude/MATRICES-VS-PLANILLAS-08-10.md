# Matrices vs planillas de la oficina — qué pasaba y qué se corrigió (08/10/2026)

Felipe mandó 13 capturas (05/10) comparando liquidaciones del sistema contra las planillas de siempre: Acuña, Lascano, Casablanca, Fagliano y Zappala, con las filas que no daban en amarillo. Se revisaron las 29 guías una por una contra producción y contra los liquidadores `.xls`.

## Resultado en una línea
**La matriz está bien.** De las 29 guías, el flete de venta del sistema coincide con el liquidador de la oficina al centavo en 27 (al mismo peso). Las 2 que no daban tenían causa concreta y quedaron corregidas:

| Guía | Cliente | Sistema | Planilla | Causa | Arreglo |
|---|---|---|---|---|---|
| 1Z327W096796499679 (EE.UU. 41 kg) | Casablanca | 166,59 | 187,08 | Precio guardado ANTES de la corrección de regiones del 01/10 (envío #354) | Recalcular la venta desde Salidas |
| 1Z327W096793806994 (Ghana 87,5 kg) | Acuña | 736,83 | 718,33 | **Más de 70 kg**: la matriz se cargaba hasta 70 y el tramo abierto heredaba ese %; el liquidador sigue con su propia tabla (`tarif 0808`) hasta 300 kg | La planilla se carga completa hasta 300 kg (ver abajo) y se recalcula el envío #582 |

Las demás filas amarillas de las capturas eran **capturas viejas**: en producción ya daban bien (Zappala EE.UU. 149,66 y Malasia 336,75; Fagliano Singapur 105,11 a 8 kg, Australia 139,54 a 12 kg, EE.UU. 49,35 a 4 kg; Casablanca DHL todas). Se verificó en producción el 08/10.

## Por qué los TOTALES igual no coinciden (aunque el flete sí)
Esto no es la matriz: son criterios distintos entre la planilla y el sistema. Hay que decidirlos, no "arreglarlos":

1. **Peso.** La oficina tipeó otro peso en varias filas: Casablanca 6,5 vs 5,8 kg (9743171491), 3,5 vs 4, 32 vs 29,5, 44 vs 41, 6,5 vs 7,5; Fagliano +0,5 kg en cinco guías (10,5/3,5/8,5/9/9 vs 10,5/3/8/8,5/8). El sistema toma el peso facturable de la guía. A igual peso, el flete da igual.
2. **Fuel.** La planilla usa un % tipeado (DHL 36 %, UPS 32 % o 37 %). El sistema usa el fuel elegido al cargar el envío (Nova/UPS/DHL de Configuración, con su historial: 36,8 % el 10/08, 35 % el 21/08). Para los DHL de Casablanca se aplicó el fuel Nova (36,8 %), no el de DHL (30,5 %).
3. **Seguro.** El sistema cobra seguro (15 UPS / 17,50 DHL) cuando el envío está marcado como asegurado; en la planilla esas filas dicen "N". Lascano: planilla 12,00 vs sistema 15,00 (¿seguro propio del cliente?).
4. **Derechos.** La planilla cobra ~0,215 % del FOB en todas las filas (0,15 · 1,49 · 1,08 · 1,29…). El sistema no tiene ese concepto. Si se quiere seguir cobrando, hay que decidir si entra como cargo.
5. **Surge.** La planilla pone un surge sin fuel y de otra tabla (3,00 · 1,75 · 4,50); el sistema aplica la tabla UPS vigente por fecha y lo muestra "con fuel" (7,18 · 2,05 · 5,47).
6. **Residential / Extended Area / Handling** (6,00 · 42,15 · 27,65): en la planilla van tipeados; en el sistema entran como cargos posteriores o con el tilde de residencial.
7. **Lascano**: las liquidaciones del sistema tienen el total tipeado por la oficina y el desglose derivado, así que el flete que muestra no es el de la matriz. Además la planilla de agosto trae Italia 121,80 y Sudáfrica 139,49 contra 119,50 y 136,85 del liquidador (×1,019: otro multiplicador K8 ese día).
8. Acuña 1Z327W096799333912: `venta_desglose.total` 227,45 ≠ `total` 221,45 (6 USD de residencial que se sacó a mano). Se arregla recalculando la venta.

## Lo que cambió en el sistema
- `backend/scripts/datos/planillas_precios_viejos.json`: cada planilla trae ahora los precios de `tarif 0808` de 70,5 a 300 kg (paso 0,5), con el mismo multiplicador. Verificado contra las 44 planillas (`.xls` de Z:\LIQUIDADORES): la fila de 70 kg coincide al centavo en todas.
- `backend/scripts/cargar-tarifarios-viejos.js`: carga hasta donde llega la planilla (300 kg) en paso 0,5 → 601 tramos y 3.606 celdas por servicio; el % se guarda con 4 decimales (con 2, un flete de USD 2.000 se desviaba hasta 12 centavos).
- `calculos.service.cotizarEnvio` devuelve `flete_costo` y `flete_venta` (lo que la oficina compara con la columna FLETE).
- Test nuevo `backend/scripts/test-matriz-planilla-vieja.js` (44 ✓): corre el cargador en una base limpia y comprueba las 27 filas de las planillas de Felipe más 5 pesos por encima de 70 kg.

## Para dejarlo cerrado en producción
1. Desplegar y correr `node scripts/cargar-tarifarios-viejos.js` en el VPS (recarga las 44 matrices; idempotente). OJO: reemplaza celdas tocadas a mano después del 01/10, si las hubiera.
2. En Salidas, "Calcular venta" en #354 (Casablanca EE.UU.), #582 (Acuña Ghana) y #567 (Acuña EE.UU.).
3. Decidir los puntos 2–6 de arriba (fuel, seguro, derechos, surge) para que las liquidaciones del sistema y las planillas digan lo mismo — o dejar de comparar contra las planillas.
