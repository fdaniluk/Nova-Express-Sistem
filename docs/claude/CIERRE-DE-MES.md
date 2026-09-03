# Cierre de mes y de semana

**Decidido el 06/08/2026.** Es la tercera y última capa de respaldo.

---

## De dónde salió

Felipe: *"estaría bueno que haya una barrera de seguridad extra, más que nada para datos.
Que a fin de mes se pueda hacer un backup que se guarde en alguna computadora... algún
administrativo tenga acceso a ese botón y todos los treinta y uno descargue en formato
Excel las salidas del mes. Hoy en día todos los viernes se manda a WhatsApp la hoja de
salidas de esa semana y se va guardando así."*

La costumbre ya existía. Lo que faltaba era que no dependiera de que alguien se acuerde y
que el archivo dijera qué período cubre.

---

## Por qué es una capa distinta

| Capa | Sirve si… | No sirve si… |
|---|---|---|
| Backups en el VPS (30 copias) | se corrompe la base | se pierde el VPS |
| Copia diaria a OneDrive | se pierde el VPS | se pierde la cuenta de OneDrive |
| **Cierre de mes en Excel** | **se pierde todo lo demás** | nadie lo baja |

El cierre es el más tonto y el más difícil de matar: una planilla que abre cualquiera, en
cualquier computadora, sin depender del sistema, del VPS ni de ninguna cuenta nuestra. Su
único punto débil es humano — por eso el panel de salud lo vigila.

---

## Qué se armó

### El bloque "Cierre" en Salidas

Selector de mes, botón **↓ Mes** y botón **↓ Semana**.

**El mes que propone:** los primeros 5 días del mes propone el mes anterior; después, el
actual. El 1 o el 2 nadie quiere archivar el mes que recién empieza.

**La semana:** lunes a domingo. Si todavía no terminó, el archivo se corta en hoy y el
nombre lo dice. Un archivo bajado un viernes no puede decir que llega hasta el domingo.

**El archivo:** una hoja, las mismas 32 columnas que ya sacaba el botón anterior — la
oficina ya conoce esa planilla. Encabezado con el período, quién lo bajó y cuántos envíos
tiene. Fila de TOTAL al pie y filtros activados. Un mes sin envíos **no es un error**: el
archivo sale igual y la pantalla avisa que salió en cero.

**El nombre:** `Nova-salidas-2026-07-julio.xlsx`. Dice el período sin abrirlo, y puestos en
una carpeta quedan en orden cronológico solos.

### Se sacó el botón "Exportar Excel"

Pedido de Felipe el mismo día: *"creo que el botón exportar Excel nunca lo usamos... al
pedo tener tan cargada la pantalla de salidas con dos botones que cumplen funciones
parecidas"*.

Se sacó, y por una razón de fondo más fuerte que el desorden: ese botón bajaba **lo que
hubiera quedado filtrado en pantalla**. Dos botones parecidos al lado del respaldo del mes
invitan al error caro — bajar una planilla filtrada creyendo que se archivó el mes entero.
Un archivo incompleto se ve igual que uno completo hasta el día que hace falta.

**Lo que se perdió:** poder bajar un Excel de lo que se está viendo (filtrado por cliente,
por columna, o solo las filas con alerta). Si alguna vez hace falta, se agrega de nuevo
**adentro de la barra de filtros y con ese nombre** — no al lado del cierre.

**Lo que se ganó de yapa:** ese botón armaba el Excel en el navegador con una librería que
se bajaba de un CDN en cada uso. Al sacarlo se fue también el `<script>` externo, así que
**la pantalla de Salidas ya no le pide nada a internet.**

### El permiso `cerrar_mes`

Aparte de `ver_salud` y `editar_config`. Se da desde Usuarios con una tilde por persona.
Quien lo tiene baja la planilla del período completo sin ser admin ni ver nada más. La
pantalla de Salidas la sigue viendo todo el mundo.

### El asiento

Cada cierre queda registrado en la tabla `cierres`: período, cuántas filas, quién y cuándo.
**No guarda el archivo** a propósito — guardarlo en el servidor sería otra copia en el
mismo lugar, que es justo lo que esto viene a evitar. Si el asiento falla, la descarga sale
igual.

### El chequeo en el panel de salud

Mira los **últimos tres meses cerrados**, no solo el anterior:

| Estado | Cuándo |
|---|---|
| Verde | los tres están archivados |
| Ámbar | falta uno (un descuido) — o nunca se hizo ninguno |
| **Rojo** | faltan dos o más: la rutina se murió |

Los primeros 5 días del mes no cuentan. En Salidas, al lado del botón, se ve de cuándo es
el último cierre; si pasaron más de 40 días se pinta en ámbar.

---

## Qué se probó

- `test-cierre-periodo.js` — **54 chequeos**. Bordes del período (el 1 y el 31 entran, el
  30/06 y el 01/08 no), febrero bisiesto, la semana en curso, el permiso, el asiento y los
  tres estados del panel de salud.
- `test-pantalla-cierre.js` — **30 chequeos** en un navegador de verdad. Que el archivo
  **baje al disco**, que abra, que tenga las filas correctas, **con el CDN bloqueado**. Y
  dos chequeos puestos al revés a propósito: que el botón viejo NO esté, y que Salidas no
  cargue ningún script externo. Si alguien los vuelve a poner, el test se cae.

Total del sistema: **465 chequeos en `npm test`** (17 tandas) y **180 en
`npm run test-pantallas`** (10 tandas).

---

## Lo que hay que definir

- **Quién** de administración recibe el permiso `cerrar_mes`. Hasta que alguien lo tenga,
  solo los admin ven el botón.
- Dónde se guardan los archivos. Sugerido: una carpeta fija (`Cierres Nova\2026\`) y no
  "Descargas", que se limpia sola.
- Si conviene seguir mandándolos por WhatsApp como hoy, o si el archivo guardado alcanza.
