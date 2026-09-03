# Regla: los documentos se despachan solo por DHL

Regla de negocio que me diste el 28/07: **hasta nuevo aviso, todo documento se cotiza y se
cobra por DHL.** Queda implementada en tres capas, no en una sola pantalla.

## Dónde quedó puesta

**1. Cotizador** (`frontend/pages/cotizador.html`)
Al elegir Contenido = Documento, el selector de courier pasa a "Solo DHL" y las opciones de
UPS quedan deshabilitadas, con un aviso al lado. Si volvés a Paquete, se re-habilitan y
**recupera la elección que tenías antes** (si estabas en UPS Saver, vuelve a UPS Saver).

**2. Cargar envío** (`frontend/js/modules/envios.js`, función `aplicarReglaDocumentos`)
Mismo comportamiento: Tipo de paquete = Documento fuerza el courier a DHL, bloquea UPS,
muestra el aviso y esconde el selector de variante UPS. Se dispara desde cuatro puntos —
al inicializar, al cambiar el tipo de paquete, al limpiar el formulario y al abrir un envío
para editar — así no queda un hueco por el que se cuele.

**3. Freno en el backend** (esto es lo importante)
La pantalla se puede saltear: una pestaña vieja con el JS anterior en cache, una llamada
directa a la API. Por eso la regla también se valida del lado del servidor, en los tres
caminos que escriben:

- `POST /api/envios` — alta
- `PUT /api/envios/:id` — edición desde Cargar envío
- `PATCH /api/salidas/:id` — edición desde Salidas

En las ediciones se evalúa el **resultado final** (lo que manda el body + lo que ya estaba en
la fila), porque una edición parcial puede tocar solo uno de los dos campos: mandar
`{courier: "UPS"}` sobre un envío que ya es documento tiene que fallar igual.

## Qué se probó

**Navegador de verdad** (`npm run test-regla-doc`, 15 pruebas) — Chromium abre las dos
pantallas y verifica el bloqueo, el forzado a DHL, el aviso, el re-habilitado al volver a
mercadería y que no haya ningún error de JavaScript. Un `node --check` solo mira sintaxis;
esto detectó, por ejemplo, que una función quedaba fuera de alcance.

**API** (`npm run test-api-doc`, 10 pruebas) — sin dependencias extra. Verifica que el
backend rechace con 400 cada camino, que siga aceptando documento + DHL y mercadería + UPS,
y que **no moleste a lo que ya funciona** (editar otros campos de un documento, o pasar un
paquete de UPS a DHL).

`npm run test-regla-doc` necesita Playwright, que **no** es dependencia del proyecto (baja
~150 MB de navegador). Si no está instalado, la prueba se saltea con un aviso en vez de
romper. La de API corre siempre.

## Datos de producción

Antes de poner el freno verifiqué que no hubiera histórico que se rompiera:

```
DHL · documento     4
DHL · mercadería   12
UPS · mercadería  142
UPS · documento     0   <- ninguno
```

No hay un solo envío existente que viole la regla, así que el freno no bloquea la edición de
nada que ya esté cargado.

## Lo que NO toqué

**La importación de Excel** no valida la regla. Si una planilla trae un documento por UPS,
entra. Lo dejé así a propósito: una importación masiva que se cae entera por una fila es peor
que el problema que resuelve. Si querés que también la frene, se agrega.

## Limitador encontrado de paso

`POST /api/envios` con un `tipo_envio` inválido devuelve **500 con el error crudo de SQLite**
(`SQLITE_CONSTRAINT: CHECK constraint failed`) en vez de un 400 con un mensaje entendible.
Lo encontré porque mi propio test mandó un valor mal. No afecta a los usuarios (la pantalla
manda siempre un valor válido), pero es el mismo patrón que ya se corrigió en Salidas y
convendría cerrarlo. Queda anotado, no lo toqué en esta tanda.
