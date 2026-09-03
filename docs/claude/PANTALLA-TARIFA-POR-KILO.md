# Pantalla de tarifa por kilo: el clic por zona y el caso mixto (04-08-2026)

Los dos problemas que quedaron a la vista el 04/08 cuando Felipe reportó, por audio, que la
tarifa por kilo *"me lo toma para todas las zonas, no me permite discriminar por zona o poner
una zona con porcentaje y otra con número fijo"*.

**Ninguno de los dos era un bug del motor.** Lo primero ya funcionaba y nadie sabía que estaba;
lo segundo funcionaba por abajo pero la pantalla no dejaba armarlo.

## 1. El clic por zona era invisible

La función de poner un precio distinto por zona existía desde el principio: se hace **clic en
la celda**. La única pista era el `cursor: pointer` del CSS. No había un solo cartel.

Ahora, debajo del alta de rangos:

> *Hacé clic en cualquier celda para ponerle otro precio a esa zona. La ✕ de la celda quita ese
> precio; la ✕ del rango borra la fila entera. Las celdas en gris se cobran con el porcentaje
> de ganancia.*

## 2. El caso mixto no se podía armar desde la pantalla

El motor lo soporta desde siempre: si no hay precio por kilo que cubra ese peso y esa zona,
`resolverTarifaKg` devuelve null y `resolverTarifaVenta` cae al porcentaje de ganancia. Pero el
botón *Agregar rango* **creaba siempre la fila de "todas las zonas"**, así que nunca quedaba una
zona sin precio, y no había forma de borrar solo esa fila general.

Se agregó un selector al alta:

```
AGREGAR RANGO DE PESO  desde [0] hasta [20] kg · USD por kilo [8.00]  en [todas las zonas ▾]
                                                                         └ solo zona 1 … solo zona 6
```

Eligiendo una zona se guarda **solo esa**. Las demás de ese peso quedan por porcentaje. Al
guardar, un cartel lo dice explícitamente para que no sorprenda.

## 3. La grilla ahora dice la verdad

Antes una celda sin precio por kilo mostraba **"—"**, que se lee como un agujero de carga.
Ahora dice **"60% de ganancia"** (el porcentaje que efectivamente se le va a cobrar), en gris e
itálica, con el motivo en el `title`. Queda así:

| | ZONA 1 | ZONA 2 | ZONA 3 | ZONA 4 | ZONA 5 | ZONA 6 |
|---|---|---|---|---|---|---|
| **0-20 kg** | **USD 8,00** | *60% de ganancia* | **USD 11,50** | *60% de ganancia* | *60% de ganancia* | *60% de ganancia* |
| **20-50 kg** | USD 6,00 | USD 6,00 | USD 6,00 | USD 6,00 | USD 6,00 | USD 6,00 |

Para poder mostrar ese porcentaje sin ir al servidor celda por celda, la pantalla trae también
el general de la matriz de profit de la tabla activa. Si esa llamada falla, no se rompe nada:
cae al porcentaje general del cliente.

## 4. El aviso del cotizador dejó de sonar a error

Decía: *"El cliente está en modo precio por kilo **pero no hay tarifa cargada** para UPS_EXP
export zona 2 con 6 kg."* Sonaba a error de carga. Desde que el mixto es armable a propósito,
ahora dice:

> *La zona 2 no tiene precio por kilo cargado en UPS_EXP export para 6 kg: se cotizó con el
> porcentaje de ganancia (60%).*

**El aviso se sigue mostrando siempre.** El sistema no puede distinguir un olvido de carga de
una decisión, así que informa el hecho sin acusar a nadie — pero un olvido tampoco pasa
desapercibido. Es el criterio de `claude/TARIFA-POR-KILO.md`, sección 3, que sigue vigente.

## Lo que se tocó (19 archivos)

`frontend/js/modules/clientes-perfil.js` · `frontend/pages/clientes-perfil.html` ·
`backend/src/services/profit.service.js` (texto del aviso) ·
`backend/scripts/test-pantalla-tarifa-kg.js` (la aserción del texto viejo) ·
las 15 páginas + `cotizador_courier_v8.html` (cache busting).

**Cache busting: `?v=20260804c` → `?v=20260804d`.** Cuarta entrega del día. **Sin commitear.**

## Pruebas

- **Pantalla en navegador: 14 controles, 0 fallas** — que el cartel explique el clic y las ✕,
  que exista el selector de zona, que un rango de una sola zona deje 5 celdas en gris, que el
  backend cobre esa zona por kilo y las otras por porcentaje, que el clic en la celda siga
  funcionando, y que el alta normal para todas las zonas no haya cambiado.
  *(Quedó como `/tmp/mix3.js`, no como script del repo. Conviene sumarlo a
  `test-pantalla-tarifa-kg.js` si se vuelve a tocar esta pantalla.)*
- **`npm test` completo: 381 controles, 0 fallas.**
- `test-tarifa-kg` 58/58 · `test-pantalla-tarifa-kg` 23/23 · `test-pantalla-salud` 18/18 ·
  `test-pantalla-sin-envio` 9/9.
- `npm run check-schema`: 0 desvíos.
- Finales de línea: ningún archivo cambió de LF a CRLF ni al revés.

## ⚠️ Entrega a medias

El `.tgz` **se le mandó a Felipe por el chat**, pero **no se pudo dejar en su carpeta**: la app
de escritorio se desconectó justo al momento de copiarlo. **Falta que lo extraiga él** en
`C:\Users\felid\OneDrive\Documents\GitHub\Nova-Express-Sistem`, o que se vuelva a copiar cuando
la app esté abierta. Los md5 **no se verificaron contra su máquina** por el mismo motivo.

## Con esto se cerró todo lo del 04/08

1. Tarifa por kilo por zona — ya funcionaba; faltaba que se entendiera. **Este documento.**
2. Caso mixto por kilo + porcentaje — **este documento.**
3. Seguro por cliente (1% vs 1,5%) — `claude/SEGURO-POR-CLIENTE.md`.
4. Seguro de documentos DHL (USD 7,50) — `claude/PROTECCION-DOCUMENTOS-DHL.md`.
5. Envío sin pesar y venta desde Salidas — `claude/ENVIO-SIN-PESAR-Y-VENTA-EN-SALIDAS.md`.
6. Tarifario DHL unificado (Expo + más de 50 kg) — `claude/TARIFARIO-DHL-UNIFICADO.md`.
7. Porcentajes de UPS Saver equivalentes a Expedited — `claude/EQUIVALENCIA-EXPEDITED-SAVER.md`.

**Nada de esto está commiteado.** Son cuatro `.tgz` del mismo día, y hay que aplicarlos **en
orden** (`_fixes` → `_fixes2` → `_fixes3` → `_fixes4`) porque varios tocan los mismos archivos.
Los tres primeros ya están extraídos en la carpeta de Felipe y verificados por md5.
