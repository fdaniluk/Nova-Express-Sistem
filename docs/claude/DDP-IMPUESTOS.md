# DDP: las facturas de impuestos y su liquidación aparte (03/09/2026)

**Estado: ENTREGA 1 hecha (facturas de impuestos + cruce + Salidas). ENTREGA 2 pendiente
(la liquidación de impuestos al cliente).**

## El pedido de Felipe (03/09)

*"Los envíos DDP son envíos [donde] los impuestos, en vez de al destinatario, se facturan al
remitente (nuestro cliente). Por lo tanto son gastos que llegan en una factura del estilo de
las de los envíos pero de impuestos: nos los cobran a nosotros y nosotros después al cliente."*

Dos cosas: (1) que el módulo de Facturas cargue las facturas de impuestos y las cruce con su
envío; (2) que un envío DDP pueda generar **dos liquidaciones**: la normal (flete, fuel,
etc.) y, **1 o 2 meses después**, la de los impuestos que generó.

Decisiones de Felipe: las facturas son de **UPS, PDF del mismo estilo que las de flete** ·
al cliente se le cobra **exactamente lo que facturó el courier** (pasamanos; Nova ya cobró
su fee de DDP de 24,05 en la liquidación del envío) · la liquidación de impuestos es un
**documento aparte con su Excel propio** · **primero facturas + cruce, después la
liquidación**.

## Cómo es la factura de impuestos (seis reales del 24/08/2026)

Facturas `0001-00926785` a `-94` (punto de venta **0001**; las de flete son **0020**).
Un solo concepto y **una guía por factura**:

```
GASTOS DE IMPORTACION EN DESTINO
   GUIA 1Z327W096797194442                                   146,95
```

Sin peso, sin país, sin desglose de impuestos (derechos/IVA/tasas: no vienen), **no
gravada** (IVA 0) y **sin percepciones** IIBB. El total es el importe. Tipo de cambio
impreso. Los seis importes: 461,75 · 67,13 · 73,14 · 184,49 · 18,00 · 146,95.

Los PDFs reales están en `facturas-ejemplo/impuestos/` (carpeta **fuera del repo**, llevan
CUIT y domicilio). La tanda los usa si están; si no, arma un PDF mínimo con las mismas
líneas.

## Entrega 1 — cómo quedó (`test-facturas-impuestos`, 44 controles)

**Lector** (`factura-ups.service.js`): reconoce la factura por el concepto y devuelve la
**misma forma** que una de flete (una guía con `costo_total` y un único cargo *"Gastos de
importación en destino"*), con `tipo: 'impuestos'` o `'flete'`. Así `/chequear`, `/cargar`
y la reconciliación contra el total del pie son el mismo circuito. Lee varias guías por
factura si un día vinieran. Se separó `extraerFacturaUPSDesdeTexto(texto)` del `pdfParse`
para poder probar el lector con líneas armadas a mano.

**Datos**: `facturas_cargadas.tipo` ('flete' | 'impuestos', default 'flete') ·
`envios.impuestos_facturados` (USD) · `envios.impuestos_factura_id` ·
`envios.impuestos_fecha` (**la fecha de la factura**, no la de carga). Migración en
`db/index.js` **y** `schema.sql` (regla once).

**Cruce** (`/cargar`): por guía contra el envío. Escribe SOLO las columnas de impuestos —
**no toca `costo_facturado` ni `estado_revision`**: los impuestos son plata aparte del
flete. Duplicados y sobreescribir con la misma regla que flete (`/chequear` compara contra
`impuestos_facturados`). Si el envío **no está marcado DDP**, se guarda igual (UPS lo
cobró, es un hecho) pero se cuenta (`no_ddp`), se lista, y se avisa (`envio_no_ddp`): o se
cargó sin la tilde, o UPS cobró algo que no correspondía.

**Pantallas**:

| Dónde | Qué |
|---|---|
| Facturas · resumen | banner "Factura de IMPUESTOS DDP" + contador "Sin tilde DDP" |
| Facturas · lote y Sin envío | chip "impuestos DDP" al lado del número de factura |
| Salidas · grilla | chip al lado del courier: **DDP** gris (esperando la factura) · **DDP $146,95** azul (facturado, pendiente de liquidar) · **¡Imp. sin DDP!** rojo (factura de impuestos en un envío sin la tilde) |
| Salidas · modal | al lado de la tilde DDP: "Impuestos de destino facturados por UPS: USD X (factura del …)" |

**Un hallazgo de paso**: el pdf.js viejo de `pdf-parse` revienta con *"bad XRef entry"*
cuando le llega un `Buffer` del pool compartido de Node (PDFs de menos de 4 KB). Con las
facturas de UPS (30-40 KB) nunca pasó. Se arregló copiando a `Uint8Array` antes de
parsear; hay un control que lo prueba con un PDF chico.

## Entrega 2 — diseño (pendiente)

- `liquidaciones.tipo` ('envios' | 'impuestos') + `envios.impuestos_liquidado` /
  `impuestos_liquidacion_id`. Un envío tiene hasta dos liquidaciones, una de cada tipo.
- Pantalla Liquidaciones: pestaña o selector "Impuestos DDP pendientes": envíos DDP con
  `impuestos_facturados` y sin `impuestos_liquidado`, por cliente y período. Una fila por
  envío con guía, fecha del envío, fecha de la factura de UPS e importe. Total = suma.
  Pasamanos: sin margen.
- Excel propio ("Liquidación de impuestos DDP"), numerada aparte.
- Salidas: el chip pasa a **verde** cuando los impuestos están liquidados.
- Los frenos de siempre: confirmada no se toca; un envío liquidado de impuestos no se
  re-liquida; la liquidación del flete no se ve afectada.

## Pendiente de decidir

- Si una factura de impuestos llega para un envío **sin DDP** (el caso rojo), ¿se le
  liquida al cliente igual? Hoy queda marcado y no se hace nada automático.
- DHL: Felipe dijo que las de DDP son de UPS. Si aparece una de DHL, es otro lector.
