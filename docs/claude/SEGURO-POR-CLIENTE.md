# Seguro negociado por cliente (04-08-2026)

Pedido de Felipe por audio: *"hay clientes que pagan el uno por ciento de seguro, no el uno y
medio, como por ejemplo Gianastasio, Cueros, algún otro, a ver si eso se puede poner a manopla."*

## Cómo quedó

En el perfil del cliente → **Editar tarifas**, debajo del fuel propio, hay dos campos nuevos:
**Seguro propio (%)** y **Mínimo (USD)**, con su botón de *Quitar seguro propio*.

- **Vacíos** (los 91 clientes de hoy) → **no cambia nada**: sigue la escala de cada courier.
- **Con porcentaje cargado** → ese cliente paga, **en DHL y en UPS por igual**:
  - valor declarado 0 → sin seguro
  - si no → `max(mínimo ; valor declarado × porcentaje)`
- **Mínimo vacío** = sin piso, porcentaje puro.
- **Borrar el porcentaje borra también el mínimo** y el cliente vuelve al courier. Un mínimo
  suelto no define ninguna regla, así que se ignora.

Felipe pidió el mínimo por cliente (*"creo que es 10, pero si no es difícil lo pondría para
definir en cada caso"*), no un valor fijo.

### Decisión importante: el seguro propio reemplaza la escala ENTERA

No se superpone con la de lista. Con `1% mínimo 10` cargado:

| Valor declarado | UPS antes | DHL antes | Los dos ahora |
|---|---|---|---|
| 50 | 0 | 17,50 | **10** |
| 200 | 15 | 17,50 | **10** |
| 500 | 15 | 17,50 | **10** |
| 2.000 | 30 | 30 | **20** |
| 5.000 | 75 | 75 | **50** |

Es a propósito: si el cliente negoció "1% con mínimo 10", eso es lo que paga. Dejar abajo el
escalón de USD 15 de UPS lo haría pagar 15 en un envío de USD 200 que debería costarle 10.
**Ojo con el primer renglón:** abajo de USD 100, UPS hoy no cobra seguro y con seguro propio
pasa a cobrar el mínimo. Si eso no es lo que se quiere, se deja el mínimo vacío.

## Lo que se tocó

| Archivo | Qué |
|---|---|
| `backend/src/db/index.js` | migración: `seguro_pct_propio`, `seguro_min_propio` en `clientes` |
| `database/schema/schema.sql` | mismas columnas, documentadas. `npm run check-schema` da 0 desvíos |
| `shared/cotizador/cotizador-core.js` | `seguroPropioMonto()` + `calcSeguroUPS/DHL(v, propio)` + param `seguroPropio` |
| `backend/src/services/profit.service.js` | `resolverSeguroPropio()`, al lado de `resolverFuelPropio` |
| `backend/src/services/calculos.service.js` | `cotizarEnvio` pasa `seguroPropio` al motor |
| `backend/src/controllers/profit.controller.js` | el endpoint que usa el cotizador devuelve `seguroPropio` |
| `backend/src/controllers/liquidaciones.controller.js` | resuelve el seguro del cliente al cotizar |
| `backend/src/models/cliente.model.js` | guarda y valida los dos campos; se pueden borrar |
| `frontend/pages/clientes-perfil.html` + `js/modules/clientes-perfil.js` | los campos y su cartel |
| `frontend/pages/cotizador.html` | pasa el seguro del cliente al motor y al cartelito |
| las 15 páginas + `cotizador_courier_v8.html` | cache busting `?v=20260803` → **`?v=20260804`** (82 refs) |

**Sin commitear.** Felipe revisa el diff.

## Un bug que encontró el test

`isFinite(null)` devuelve **true** en JavaScript (null se convierte en 0). Un cliente con el
porcentaje vacío y el mínimo cargado terminaba cobrando ese mínimo en vez de volver a la
escala del courier. Corregido con un chequeo explícito de `null`/`undefined`/`''`.

## Pruebas

- **`npm run test-seguro-cliente`** — 45 controles nuevos: que sin seguro propio no cambie
  nada (los valores de antes, courier por courier), que el propio reemplace la escala en los
  dos couriers, el mínimo, que no toque flete/fuel/surge, los datos mal cargados, y el
  resolvedor contra la base. Agregado a `npm test`.
- **`npm test` completo: 331 controles, 0 fallas.** Antes eran 286.
- **Pantalla en navegador de verdad: 10 controles, 0 fallas** — los campos guardan, sobreviven
  a recargar, el botón de quitar borra, el fuel propio de al lado no se rompió, sin errores de
  JS. *(No quedó como script del repo; si conviene, se puede sumar a los tests de pantalla.)*
- `md5sum` de los 27 archivos coincide entre el contenedor y la máquina de Felipe.
- Finales de línea: `liquidaciones.controller.js` y `cotizador-core.js` son CRLF en el repo y
  se restauraron a CRLF antes de devolver.

## Pendiente de esta misma tanda

1. **Seguro de documentos DHL — USD 7,50 por envío.** Es la *Protección de Documentos* del
   tarifario (página 13). El sistema no lo tiene. Felipe decidió: **con una tilde, a pedido**
   —aparece un checkbox al cargar el envío y en el cotizador—, porque DHL lo vende como
   opcional. **No empezado.**
2. **Hallazgo:** el tarifario de DHL dice **1,00% con mínimo USD 17,50** para la Protección
   del Valor del Envío internacional. El sistema cobra **1,5%**. O sea, el 0,5% de diferencia
   es margen de Nova, no costo — coherente con lo que Felipe dijo el 29/07 (*"son valores que
   pusimos nosotros"*). Los clientes que pagan 1% están pagando el costo puro.
