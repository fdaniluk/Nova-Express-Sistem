# Auditoría de PRODUCCIÓN — 27 de julio de 2026

Complemento de `claude/AUDITORIA.md`, que se hizo sobre el repo y la base local. Este documento es sobre **el sistema real**: el VPS andando y la base con la que trabaja tu gente.

**Fuentes:** salida de `printenv` / `git` / `pm2` en el VPS, los logs de producción, y el backup `nova_backup_20260727_124029.db` (300 KB, 27/07 12:40).

**Tamaño real vs. lo que auditamos antes:**

| | Base local | **Producción** |
|---|---|---|
| Clientes | 10 | **91** |
| Envíos | 36 | **158** |
| Pickups | 31 | **190** |
| Liquidaciones | 9 | **21** |
| Usuarios | 3 | **9 (8 activos)** |

---

## Primero: una corrección mía

En el informe anterior escribí que `envios.pickup_id` existía y que el ítem del backlog *"relación pickup↔envío sin clave foránea — ✅"* estaba cerrado. **Es falso.** Esa columna **no existe en producción, ni en la base local, ni en `schema.sql`.** Lo que existe es `cuadrantes.pickup_id` y `cobranzas.pickup_id`, que son otra cosa.

De dónde salió el error: la primera verificación del backlog leyó `pickup_id` en la línea 240 de `schema.sql` y asumió que era de `envios`; en realidad esa línea está adentro de la tabla `cuadrantes`. El informe de auditoría repitió el error sin volver a chequearlo.

**Ese ítem del backlog vuelve a ABIERTO.** Y explica por qué el vínculo pickup→envío sigue resolviéndose con un `UPDATE` a ciegas por coincidencia de cliente y fecha, que marca de más si un cliente tiene dos envíos el mismo día.

---

## Segundo: subí mal la severidad del problema principal

En el informe anterior dije que el bug de transacciones concurrentes (#1) era poco probable *"porque son 3 usuarios y 36 envíos"*.

**Son 9 usuarios, 8 activos:** felipe (admin), marcelo, leandro, andrea, gabriela, ricardo, juanqui, victoria. Y 158 envíos, con 134 solo en julio.

Con 8 personas escribiendo sobre **una sola conexión SQLite compartida**, la probabilidad de que dos transacciones se pisen no es teórica: es cuestión de que dos de ellas guarden algo en el mismo par de segundos. Julio tuvo 134 envíos cargados, más 190 pickups, más las ediciones de Salidas.

**Sigue siendo el hallazgo número uno, y es más urgente de lo que dije.**

---

# Lo que encontré en producción

## 🔴 1. Hay daño real de integridad: 4 filas huérfanas

`PRAGMA foreign_key_check` sobre la base de producción devuelve **4 violaciones**:

| Tabla | Fila | Apunta a | Estado |
|---|---|---|---|
| `envio_bultos` | 53 | envío 53 | **no existe** |
| `envio_bultos` | 54 | envío 53 | **no existe** |
| `envio_bultos` | 55 | envío 56 | **no existe** |
| `envio_bultos` | 56 | envío 56 | **no existe** |

Son dos envíos multi-bulto (uno de 21,5 + 1,5 kg; otro de 34,8 + 24,4 kg) cuyos bultos quedaron colgando después de que se borrara el envío padre.

**De dónde salió:** los IDs de envío arrancan en 24, o sea que los envíos 1 a 23 fueron borrados en algún momento. Hay dos backups manuales que lo delatan: `nova_PRE_VACIADO_SALIDAS_20260630_115728.db` y `nova_pre_borrado_julio.db`. El commit `e6ebf2a` del 30/06 se llama *"script vaciado salidas con backup previo"* y el siguiente, `adb760e`, *"remove script destructivo vaciar salidas ya ejecutado"*.

**La causa técnica** es la que ya estaba en el informe: `PRAGMA foreign_keys = ON` se aplica **por conexión**. Un script de mantenimiento que abre la base por afuera arranca con las FK apagadas y borra sin que la cascada limpie los hijos.

Es poco daño (4 filas, envíos viejos), pero es la prueba de que el mecanismo funciona: **cada vez que se corra un script suelto contra la base, puede pasar de nuevo y a mayor escala.**

---

## 🟠 2. Dos envíos están en dos liquidaciones cada uno

| Envío | Guía | Cliente | Monto | Liquidación A | Liquidación B |
|---|---|---|---|---|---|
| 31 | 1Z327W096795816176 | 56 | **USD 2.225,00** | #12 borrador | #13 confirmada |
| 147 | 1Z327W096792406963 | 79 | **USD 138,00** | #30 borrador | #32 confirmada |

Es el bug de doble liquidación del informe anterior, **materializado en producción**. En los dos casos alguien armó una liquidación, quedó en borrador, armó otra y confirmó esa.

**La buena noticia:** verifiqué que tanto el dashboard como Salidas filtran por `estado = 'confirmada'`, así que **hoy no se está contando la plata dos veces** y al cliente no se le facturó dos veces.

**La mala:** son dos borradores cargados. Si alguien entra a Liquidaciones, ve el borrador #12 y le da "confirmar", **se le vuelve a facturar USD 2.225 al cliente 56**. Nada en el sistema lo impide ni lo advierte.

**Acción concreta:** borrar los borradores #12 y #30, y agregar el índice único que impide que un envío entre dos veces.

---

## 🟠 3. El fuel hardcodeado en 39% ya se aplicó en producción

En el informe anterior esto era un riesgo teórico. Ahora tiene evidencia.

El histórico de configuración muestra que el fuel **nunca estuvo en 39%**:

| Fecha | Cambio |
|---|---|
| 18/06 | 39,5 → 36 |
| 29/06 | 36 → 33 |
| 15/07 | 33 → 32 |
| **27/07 (hoy)** | 32 → **DHL 29,75 · UPS 35,25** |

Y sin embargo hay **4 envíos congelados con `fuel_pct = 39,0`**, todos cargados el 30/06 entre las 15:58 y las 16:05, cuando la configuración decía **33**:

| Envío | Fecha | Flete | Fuel cobrado (39%) | Fuel correcto (33%) | Diferencia |
|---|---|---|---|---|---|
| 41 | 08/06 | 33,67 | 13,52 | 11,11 | 2,41 |
| 42 | 08/06 | 94,16 | 42,77 | 31,07 | **11,70** |
| 43 | 12/06 | 21,90 | 8,64 | 7,23 | 1,41 |
| 44 | 12/06 | 42,89 | 18,19 | 14,15 | 4,04 |
| | | | | **Total** | **USD 19,56** |

39 es exactamente el valor hardcodeado en `frontend/js/modules/envios.js:4` (`{ DHL: 39, UPS: 39 }`). **No puede venir de otro lado.** Cuatro envíos seguidos con el mismo síntoma = la llamada a configuración falló y el `console.warn` se lo comió.

La plata es poca (USD 19,56 de costo inflado, o sea utilidad sub-reportada). **Lo importante es que demuestra que el bug dispara.** Y con el fuel cambiando cinco veces en dos meses, y hoy en 29,75/35,25, el default de 39 está a **9 puntos** de la realidad. La próxima vez que falle, el error va a ser el triple.

---

## 🟡 4. Un envío cobra 6 kg de menos

Envío **94** (guía 3292020222, DHL, 03/07, 2 bultos):

| | kg |
|---|---|
| Peso real | 73,75 |
| Peso volumétrico | 60,78 |
| **Peso facturable cargado** | **67,75** |

Por la regla, el facturable tiene que ser `max(real, volumétrico)` = **73,75**. Está en 67,75: **6 kg que no se cobraron**. Es el único caso en los 158 envíos, así que parece una edición manual y no un error sistemático — pero muestra que el campo se puede pisar a mano sin ninguna validación que lo cruce contra el peso real.

---

## 🟡 5. Datos de clientes: la mitad del sistema de márgenes no está configurada

| | |
|---|---|
| Clientes totales | 91 |
| **Sin margen configurado** (`tarifa_pct` en 0 o NULL) | **64 (70%)** |
| Con matriz de profit cargada | **4** |
| **Sin email** | **87 (96%)** |

Dos consecuencias concretas:

- **El profit automático del cotizador** — lo último que se entregó, el 21/07 — sirve para 4 clientes de 91. Para los otros 87 cae al fallback manual. La funcionalidad está, los datos no.
- **La automatización de mandar la liquidación por mail** (propuesta #9 del informe anterior) **no es viable hoy**: no hay a dónde mandarla en 87 de 91 casos.

**Además hay dos pares de clientes duplicados:**

| ID | Nombre |
|---|---|
| 36 | GERSCOVICH |
| 37 | Gerscovich |
| 68 | OPEN POLO |
| 69 | Open Polo |

IDs consecutivos, así que se crearon uno detrás del otro. El importador de Excel **sí** compara sin distinguir mayúsculas (`excel.service.js:122`), así que no fue por ahí: se crearon a mano desde la pantalla de Clientes, que no tiene ningún chequeo de duplicados. Los envíos y pickups de esos clientes quedan repartidos entre las dos fichas.

---

## 🟡 6. El dashboard está ciego al 88% de julio

| Mes | Envíos | Con precio de venta | Liquidados |
|---|---|---|---|
| Mayo | 2 | 2 | 2 |
| Junio | 22 | 22 | 22 |
| **Julio** | **134** | **16** | **6** |

118 envíos de julio están cargados con su costo calculado (flete, fuel, seguro) pero **con `total_cobrado = 0` y `profit` en NULL**.

**Esto parece ser tu flujo normal, no un bug**: mayo y junio están al 100% con precio y liquidados, así que el precio se carga al momento de liquidar. Lo anoto igual porque tiene un efecto que quizás no estés viendo: **mientras julio no se liquide, el dashboard no muestra ni un peso de utilidad del mes en curso.** Si mirás el dashboard hoy, estás viendo junio, no julio.

Si querés visibilidad del mes en curso, la pieza que falta es un precio estimado (el cotizador ya sabe calcularlo) que se guarde al cargar el envío y se reemplace por el real al liquidar.

---

## 🟡 7. Higiene: sesiones, logs y backups

**Sesiones:** 43 en la tabla, **25 vencidas**. La función `borrarSesionesExpiradas()` existe y no la llama nadie. Confirmado en producción, no solo en la copia local.

**Logs:** el `console.log` de pickups está volcando el cuerpo completo de cada request al log del servidor, con direcciones reales de clientes en texto plano: *"Honduras 4648, Palermo"*, *"Reconquista 365 7mo B"*, *"Guido Spano 920 Glew"*. Son datos personales de tus clientes acumulándose en `/root/.pm2/logs/nova-out.log` sin rotación ni control. **Es una línea de código.**

**Backups:** solo hay **9 archivos, del 21 al 27 de julio**. Seis días de historia, todos en `/root/Nova-Express-Sistem/database/backups/` — el mismo disco del VPS, sin ninguna copia afuera. Si el VPS se pierde hoy, se pierde todo.

Los dos backups manuales (`nova_PRE_VACIADO_SALIDAS`, `nova_pre_borrado_julio`) están a salvo de la rotación porque no arrancan con `nova_backup_`. Es una suerte, no un diseño.

**Datos sueltos:** hay 2 pickups con dirección `calle 123` (cliente 1, 17/06) que son claramente pruebas quedadas en producción. Y 47 de 190 pickups no tienen courier asignado.

---

## ✅ Lo que verifiqué en producción y está bien

Vale la pena decirlo, porque son las cosas que más preocupaban:

- **Las 21 liquidaciones cuadran al centavo** con la suma de sus ítems. Cero descuadres.
- **Ninguna guía duplicada** entre los 158 envíos, ni siquiera comparando sin distinguir mayúsculas. Ningún envío sin guía. Ninguna guía con espacios o minúsculas sueltas.
- **Ningún valor negativo** en flete, fuel, seguro, adicionales, derechos, otros, total cobrado, peso ni FOB.
- **Ningún envío marcado como liquidado sin su ítem correspondiente**, ni al revés.
- **Ningún envío cuya venta haya cambiado después de liquidarse** — el riesgo de desnormalización del informe anterior existe en el código, pero todavía no se materializó.
- **Ningún costo en NULL** — el bug de la zona inválida no disparó en producción (hay un solo envío con zona NULL, el 39, y calculó igual).
- **La autenticación funciona**: `/api/clientes` y `/api/dashboard` devuelven 401 sin sesión.
- **El código de producción es idéntico al repo** (`git status` limpio, HEAD en `91ef2c0`). No hay nada hecho a mano en el servidor.
- **Los backups automáticos corren y funcionan** (`VACUUM INTO`, con el WAL integrado). Se ven en el log corriendo todos los días a las 12:40.

---

# Qué hacer, en orden

**Ya (minutos):**

1. `echo "NODE_ENV=production" >> .env` + `pm2 restart nova` — la cookie sin `Secure` está confirmada.
2. Borrar los borradores de liquidación **#12 y #30** antes de que alguien los confirme.
3. Sacar el `console.log` de `backend/src/routes/pickups.js:56`.

**Esta semana:**

4. **Serializar `transaction()`.** Con 8 usuarios activos es el riesgo real del sistema.
5. Cache busting: `main.css` (v4/v5) y `auth-guard.js` sin versionar.
6. Limpiar las 4 filas huérfanas de `envio_bultos` y agregar el índice único que impide un envío en dos liquidaciones.
7. Fechas UTC.

**Cuando haya aire:**

8. Backups fuera del VPS.
9. Unificar los clientes duplicados (36/37 y 68/69) y poner un chequeo al crear.
10. Corregir el peso facturable del envío 94.
11. Cargar márgenes: 64 clientes sin `tarifa_pct` y 87 sin email.

---

## Preguntas

1. ¿Es correcto que julio esté sin precios de venta hasta que se liquide, o eso se te está atrasando?
2. Los 4 envíos con fuel 39% (41, 42, 43, 44) ya están liquidados. ¿Los corregimos o los dejamos como están?
3. Los clientes duplicados: ¿unifico las fichas o los dejo separados por alguna razón?
