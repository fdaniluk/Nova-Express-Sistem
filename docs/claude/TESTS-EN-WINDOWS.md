# `npm test` en Windows, y los tests que parecían rotos (04-08-2026)

Al correr la batería completa en la máquina de Felipe por primera vez, `npm test` se moría a
mitad de camino con:

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
```

**No fallaba ningún test.** Se moría Node entre un test y el siguiente, así que la mitad de la
batería nunca corría y no había forma de saber si el sistema estaba bien.

## Qué era

Tres causas encadenadas, todas la misma idea: **matar el proceso mientras algo todavía se está
cerrando**. En Linux la carrera casi siempre sale bien y por eso nunca se vio en el contenedor.

1. **`srv.kill()` dos veces sobre el mismo handle.** El cierre explícito mataba el server y
   después `process.exit()` disparaba el handler de `'exit'`, que lo mataba otra vez.
2. **`db.close()` de sqlite3 sin esperar.** No es sincrónico: encola el cierre en un hilo del
   pool y avisa por un handle async de libuv.
3. **`process.exit()` antes de que el server muriera.** `kill()` solo manda la señal.

## Cómo quedó

- Guard para que `kill()` tenga efecto una sola vez.
- `await new Promise((res) => db.close(() => res()))` en los 10 tests que abrían la base.
- `await esperarSrvMuerto()` — espera el `'exit'` del hijo, con tope de 2 s.
- **Y lo que lo cerró de verdad: se sacó `process.exit()` de los 19 tests que tocan base o
  levantan servidor.** Dejan `process.exitCode` y Node termina solo cuando no le queda nada a
  medio cerrar. Red de seguridad: `setTimeout(..., 3000).unref()` — no sostiene el proceso y
  solo actúa si algo quedara colgado.

Los 5 tests de cálculo puro conservan su `process.exit()`: no abren nada.

**Lección:** se taparon las causas de a una y hicieron falta tres entregas. Sacar el
`process.exit()` de raíz —la solución que no depende de ninguna carrera— tendría que haber sido
el primer movimiento, no el último.

## ✅ Ningún test estaba roto — eran datos, navegador y calendario

| Test | En el contenedor | En la máquina de Felipe | Qué pasaba |
|---|---|---|---|
| `test-orden-pendientes` | 3 · 2 fallaron | **5 · 0** | base vacía |
| `test-aviso-guia` | 8 · 4 fallaron | **12 · 0** | base vacía |
| `test-liq-sin-cotizador` | timeout | **11 · 0** *(tras arreglarlo)* | ver abajo |

### `test-liq-sin-cotizador` — dependía de qué mes es hoy

Fallaba con *"la lista de pendientes tiene clientes → 0"*. Se miró la base real antes de
suponer nada:

| Mes | Envíos sin liquidar | Plata |
|---|---|---|
| 2026-04 | 1 | USD 231,56 |
| 2026-05 | 7 | USD 2.620,00 |
| 2026-06 | 18 | USD 9.244,63 |
| 2026-07 | 4 | USD 270,85 |
| **2026-08** | **0** | — |

La pantalla de Liquidaciones arranca filtrando **el mes en curso** (`setDefaultDates`), así que
el 04/08 mostraba cero — correctamente. El test daba por sentado que siempre hay pendientes en
el mes corriente. Un test que pasa o falla según el día del mes no sirve: ahora abre el rango
antes de mirar. Era el mismo problema **dos veces**, porque la pestaña *Crear* tiene su propio
filtro de fechas y también arrancaba en agosto.

## 💰 Hallazgo de negocio, de paso

**USD 12.367 en 30 envíos sin liquidar**, el más viejo de **abril**. Solo los 18 de junio son
USD 9.244. Puede ser deliberado —clientes que se liquidan cuando llega la factura del courier—
pero **Felipe no lo tenía presente**. El chequeo 9 del panel de salud ("envío de mes cerrado
sin precio") debería estar marcándolo. **Sin confirmar con Felipe.**

## Falso positivo de un centavo

En la corrida apareció:

```
[desglosarCosto] reconciliación de extras no cuadra: Σ=1.47 != adicionales=1.46
```

La tolerancia es de un centavo y la diferencia era **exactamente** un centavo. El chequeo usaba
`Math.abs(a - b) > 0.01`, y en coma flotante `1.47 - 1.46` da `0.010000000000000009`. Ahora va
en centavos enteros: `Math.round(Math.abs(sumExtras - adicionales) * 100) > 1`.
**No cambia ningún precio**, pero ensuciaba los logs del VPS y tapaba los descuadres de verdad.

## Playwright

Los 6 tests de pantalla **nunca habían corrido en la máquina de Felipe**: faltaba `playwright`.
Se instaló el 04/08 (`npm i -D playwright` + `npx playwright install chromium`), así que quedó
como devDependency en `backend/package.json` y va commiteado.

## Estado final, verificado en Windows el 04/08

| | Controles |
|---|---|
| `npm test` | **381 · 0 fallas** |
| `test-pantalla-tarifa-kg` | 23 · 0 |
| `test-pantalla-salud` | 18 · 0 |
| `test-pantalla-sin-envio` | 9 · 0 |
| `test-cartel-peso` | 8 · 0 |
| `test-aviso-guia` | 12 · 0 |
| `test-liq-sin-cotizador` | 11 · 0 |
| `test-orden-pendientes` | 5 · 0 |
| `test-tarifa-kg` | 58 · 0 |

Antes de la tanda del día `npm test` eran 331. Los nuevos: `test-seguro-cliente` (45),
`test-envio-sin-pesar` (28) y `test-proteccion-doc` (22).

**Nada commiteado todavía.**
