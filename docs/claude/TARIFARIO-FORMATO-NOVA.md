# El formato del tarifario (13/08/2026)

Felipe rechazó las dos primeras muestras y mandó **`TARIFARIO EXPO ECONOMY JOSEFINA.pdf`**
(de Exportalo, *"exactamente igual, solo que el de Nova tiene el logo y los colores de la
marca"*) más los logos de **Nova** y **Exportalo**. Este documento fija el formato.
**Muestras aprobadas como punto de partida: `Tarifario_nova.pdf` y `Tarifario_exportalo.pdf`.**

---

## Las dos marcas (colores medidos pixel por pixel sobre los logos)

| Marca | Oscuro (encabezados, columna de kilos) | Acento (bandas, filas de kilos, títulos) |
|---|---|---|
| **Nova Express** | `#403754` violeta | `#EE6C52` coral |
| **Exportalo** | `#1B7FC4` azul *(del celeste `#4EB8FB` del logo, oscurecido para que el texto blanco se lea)* | `#F52E57` rojo |

**Rojo y azul NO son los colores de Nova.** (Las dos primeras muestras los usaban; por eso las
rechazó.) Logos recortados con fondo transparente en el contenedor:
`/root/muestra/logo_nova.png` y `/root/muestra/logo_exportalo.png`. **Los originales hay que
guardarlos en el repo** — hoy solo están en el contenedor y en el chat.

El selector de marca cambia logo + los dos colores + el pie con el mail. Nada más.

## La estructura, copiada del tarifario real

- **Hoja apaisada.** Logo arriba a la izquierda, **"Exportaciones"** en itálica al centro, el
  cliente y las fechas a la derecha (y "hoja N de M" cuando hay más de una).
- **La tabla partida en columnas** que siguen una a la otra — hasta **47 filas por columna,
  3 columnas por hoja**, repartidas parejo para que la última hoja no quede casi vacía — y el
  **cuadro de NOTAS** con borde después de la última columna. (Esto es lo que Felipe llamaba
  *"las anotaciones de la derecha"*.)
- **Bandas de sección en el color de acento:** `Documentos (USD)` y `Paquetes (USD)`.
- La primera columna se titula **"Peso hasta (kg)"** — así lo dice el tarifario que ya usan.
- Debajo de las notas, un bloque **DESTINOS** que dice qué países son cada columna.

## 🔴 Las columnas NO son "Zona 1…6": son destinos con nombre

El tarifario real usa *Mercosur · Resto Sudamérica · Caribe y Norteamérica · Europa Occidental ·
Resto del Mundo*. El cliente no sabe qué es la zona 4. Las seis zonas de DHL quedan así:

| Zona | Nombre en el tarifario | Países |
|---|---|---|
| 1 | Mercosur | Brasil, Chile, Uruguay, Paraguay, Bolivia |
| 2 | Resto Sudamérica y Caribe | Colombia, Ecuador, Perú, Centroamérica, Caribe (44 países) |
| 3 | Norteamérica | EE.UU., Canadá, México |
| 4 | Europa | 49 países |
| 5 | Asia | China, Japón, India, Sudeste asiático (19) |
| 6 | Resto del mundo | África, Oceanía, Medio Oriente (98) |

## Las filas — **desde, hasta y cada cuánto, los tres elegibles** (Felipe, 13/08)

Los tres presets, corregidos por él:

| Preset | Rango | Paso | Hojas |
|---|---|---|---|
| Chico | **0 a 50 kg** | 0,5 (auto: como la tabla de DHL) | 1 |
| Mediano | **50 a 200 kg** | 1 kg | 2 |
| Grande | **+200 kg** (hasta 300) | 5 kg | 1 |
| A medida | desde / hasta / paso a mano | | |

**La regla que hace seguro cualquier paso:** la columna dice **"Peso hasta (kg)"** y la celda
lleva el precio **de ese peso exacto**. Como la tabla del courier nunca baja al subir el peso,
cualquier envío por debajo de esa fila **cuesta menos que lo que dice el papel**. El tarifario
nunca puede quedar corto. Es la misma semántica del tarifario de Exportalo que ya mandan.

🔴 **Lo que rechazó** fue la versión de **10 kg con el precio del techo de la franja**:
*"si uno ve que a zona 1, 80 kilos vale 478 dólares, uno va a interpretar que ese es el precio
más bajo y no el más caro, aunque esté la aclaración; la aclaración es medio confusa"*. Con
pasos de 1 y de 5 el salto es chico y no se presta a esa lectura. **No volver a poner franjas
gruesas con leyenda explicativa.**

Otros detalles:

- Arriba de 30 kg la tabla de DHL es de a 1 kg: poner medios kilos ahí repite el mismo precio
  dos veces y queda mal. Por eso el preset "auto" cambia de 0,5 a 1 en los 30 kg.
- Fila resaltada en el color de acento cada 5 kg (cada 25 en el preset grande).
- Arriba de 300 kg DHL no tiene tabla: el motor extrapola. **Conviene cortar en 300 y poner
  "consultar"**.

## Las notas (el cuadro de la derecha)

Se arman solas según qué servicios entraron (ver `PROPUESTA-TARIFARIO-CLIENTE.md`). El texto
sigue el del tarifario real: dólares · sin recargo por combustible · seguro opcional · destinos
remotos · peso mayor entre balanza y volumétrico (÷5000) · puerta a puerta sin gastos aduaneros
de destino · límite de peso · la tarifa puede cambiar según el volumen de la cuenta.
Para Nova se agrega **GoGreen USD 0,98 por kilo** cuando hay DHL.

## Cómo se genera (muestras)

`/root/muestra/gen5.js <marca> <desde> <hasta> <paso|auto> <salida>` en el contenedor — motor
real (`cotizarServicio`, `fuelPct:0`, `fob:0`), celda = `conGan`, HTML + Chromium headless → PDF.
Pagina y balancea las columnas solo. **Nada de esto está en el repo todavía.**
