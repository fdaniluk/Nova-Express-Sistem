# Cambios del 27/07 — qué toqué y qué falta

**Todo está en tu repo, sin commitear.** `git status` te muestra los 31 archivos modificados.
**No toqué el VPS ni la base de producción.** Lo que hay que hacer allá está al final, listo para copiar y pegar.

Para ver todo junto:

```
git --no-pager diff --stat
```

642 líneas agregadas, 150 borradas. Si algo no te cierra, `git checkout <archivo>` lo revierte.

---

## Lo que arreglé (11 cosas)

### 1. Transacciones concurrentes — el hallazgo número uno
`backend/src/db/index.js`

`transaction()` ahora encola: cada transacción espera a que termine la anterior antes de emitir su `BEGIN`. Antes, con una sola conexión compartida y 8 usuarios, dos operaciones simultáneas se intercalaban y una podía borrar el trabajo de la otra.

**Probado con las dos versiones lado a lado**, simulando una liquidación larga y alguien guardando un envío en el medio:

```
VERSIÓN VIEJA:   A ok · B ERROR "cannot start a transaction within a transaction"
                 → se perdió el envío de B (3 de 4 filas)

VERSIÓN NUEVA:   A ok · B ok
                 → se guardó todo (4 de 4 filas)
```

Efecto secundario esperado y correcto: una importación de Excel larga hace esperar a los demás unos segundos. Es preferible a perder escrituras. El arreglo de fondo (una conexión por request) queda para más adelante; esto cierra el agujero sin reescribir la capa de acceso.

### 2. "Recalcular" ya no borra el DDP
`backend/src/routes/salidas.routes.js`

Faltaba una línea: `ddp` no se pasaba al recálculo, así que llegaba `undefined` y el cargo desaparecía. Ahora se lee del modal o del envío, igual que `remota`.

### 3. Puerta trasera eliminada
`backend/src/models/envio.model.js`

Saqué el flag `forzar`, que permitía editar cliente y fecha de un envío ya liquidado mandando `{"forzar": true}` por `PUT /api/envios/:id`. No lo usaba ningún archivo del frontend.

### 4. Cache busting unificado — tu bug de "código viejo"
`frontend/index.html` + las 13 páginas

**74 referencias** a JS y CSS, todas ahora en `?v=20260727`. Antes convivían 11 versiones distintas, `main.css` pedía v5 en el dashboard y v4 en las 13 páginas, y `auth-guard.js` —el que valida la sesión— no tenía versión en ninguna página.

De acá en adelante la regla es una sola: **cuando toques cualquier JS o CSS, cambiá esa fecha en las 14 páginas de una** (un buscar y reemplazar de `?v=20260727`). Un solo número, no once contadores.

### 5. Las fechas ya no se adelantan un día
`frontend/js/main.js` (nuevo `NovaUtils.hoyLocal()` y `mesLocal()`) + `envios.js`, `liquidaciones.js`, `salidas.js`

`toISOString()` devuelve UTC y vos estás en UTC−3, así que **de 21:00 a medianoche el sistema creía que era mañana**. Cinco lugares corregidos: la fecha por defecto de cargar envío (dos veces), el período de liquidaciones, la solapa de mes de Salidas y el semáforo de antigüedad.

`cobranzas.js`, `pickups.js` y `operaciones.js` ya lo hacían bien y no los toqué.

### 6. El semáforo de desvíos ahora avisa si se apaga
`frontend/js/modules/salidas.js`

Si falla la carga de tolerancias, antes quedaba un `console.warn` y **ningún desvío contra la factura del courier se pintaba en rojo nunca** — la pantalla se veía igual que "todo dentro de tolerancia". Ahora sale un cartel rojo diciendo que el control está desactivado.

### 7. Las guías de factura vuelven a usar el índice
`backend/src/routes/facturas.routes.js`

Las dos consultas usaban `UPPER(numero_guia) = UPPER(?)`, y ese `UPPER()` sobre la columna anulaba el índice único: cada guía hacía un scan completo de `envios`. Ahora se normaliza del lado de JS y se busca por igualdad. Con una factura de 200 guías eso pasa de 200 scans completos a 200 búsquedas indexadas — y esos scans eran lo que bloqueaba la conexión única para todos los demás.

### 8. Cinco índices que faltaban
`backend/src/db/index.js` (`migrateIndices`) + `database/schema/schema.sql`

`pickups(fecha)` · `liquidacion_items(envio_id)` · `envios(estado_revision)` · `envio_bultos(numero_guia)` · `cuadrantes(pickup_id)`

Todos `IF NOT EXISTS`: se crean solos al arrancar y correrlo de nuevo no hace nada. No cambian ningún resultado, solo el plan de ejecución. `pickups(fecha)` es el más importante: es la pantalla que tu gente abre todo el día y hacía un scan completo en cada carga.

### 9. Higiene: sesiones y logs
`backend/src/models/auth.model.js`, `backend/src/server.js`, `backend/src/routes/pickups.js`

- La purga de sesiones vencidas ahora se llama (al arrancar y cada 24 h). Además tenía un bug propio: comparaba un ISO con `T` y `Z` contra el formato de `datetime('now')`, y por eso nunca borraba nada. **Probado contra una copia de tu base: 43 sesiones → 18.**
- Saqué el `console.log` de pickups que volcaba las direcciones de tus clientes al log del servidor.


### 10. Las fechas del backend tampoco se adelantan
`backend/src/utils/fecha.js` (nuevo) + `liquidacion.model.js`, `facturas.routes.js`, `dashboard.js`, `excel.service.js`

Agregado después de verificar el VPS. El servidor está en **-03**, pero eso no salva nada: `toISOString()` devuelve UTC **siempre**, sin importar la zona horaria de la máquina. Seis lugares del backend usaban eso para calcular "hoy".

Probado simulando las 22:30 del 31 de mayo, hora Argentina:

```
toISOString (mal): 2026-06-01     <- mes equivocado
hoyLocal    (ok) : 2026-05-31
```

O sea: una liquidación confirmada el 31 a la noche quedaba fechada el 1 y caía en el mes de facturación siguiente. Corregidos: `fecha_liquidacion` (dos lugares), `fecha_facturado`, el período "hoy" y "semana" del dashboard, y dos fechas por defecto de la importación de Excel.

**Una cosa se dejó a propósito:** `parseFecha()` en `excel.service.js` sigue usando `toISOString()` para las celdas de fecha que parsea XLSX. No es el mismo caso — esa fecha puede venir armada en UTC o en local según cómo la construya la librería, y con el servidor en -03 el resultado actual es correcto. Cambiarlo requiere probarlo contra planillas reales. Está comentado en el código.


### 11. Parser de facturas UPS — los 6 bugs
`backend/src/services/factura-ups.service.js`, `routes/facturas.routes.js`, `db/index.js`, `schema.sql`
Nuevo: `backend/scripts/test-parser-factura.js`

Se hizo ahora porque las tablas de facturas están **vacías**: es el momento más barato, y después de la primera carga real deja de serlo.

**a) Ya no carga USD 0,00 en silencio.** Si el parser no puede leer el importe de una guía, esa guía queda con costo `null` y se avisa — antes se degradaba a 0, y como la comparación de margen solo corre `if (costo > 0)`, la guía quedaba "pendiente" sin ninguna alerta. Simulé que UPS deja de imprimir una columna: antes daba "10 guías, USD 0,00, todo OK"; ahora las 10 salen sin costo y con su advertencia.

**b) Las guías re-facturadas ya no desaparecen.** Antes se descartaba toda repetición asumiendo que era paginado del PDF. Ahora se comparan los importes: si son idénticos es paginado y se deduplica callado; **si difieren se avisa con los dos montos** y no se suma nada solo. Sumar plata sin que nadie mire es justo lo que hay que evitar.

**c) Reconciliación contra el total del PDF.** El parser ahora **lee** el total declarado del PDF (ancla: el importe en letras, que en las facturas argentinas es obligatorio) y lo compara contra la suma de las guías. Sobre tu factura de ejemplo:

```
suma de guías 3.068,33 · total del PDF 3.159,55 · diferencia 91,22
```

Esos 91,22 son la percepción de Ingresos Brutos del pie. **No decidí si forma parte del costo** — eso es tuyo. Lo que hace el sistema ahora es decírtelo en vez de guardar el subtotal como si fuera el total, que dejaba el margen inflado ~3% en toda guía UPS.

**d) `parseAR` reescrito.** Antes `"120.10"` daba 12.010 (100× de más). Ahora maneja los dos formatos: el último separador es decimal si lo siguen 1-2 dígitos, y de miles si lo siguen 3. Y una entrada ilegible devuelve `null`, no 0.

**e) La misma factura ya no se puede cargar dos veces.** Chequeo por número de factura → **409** con la fecha de la carga anterior. Más un índice único `(factura_id, numero_guia)` para que el detalle no se duplique.

**f) Los errores por guía se cuentan.** Antes la guía que fallaba no entraba en ningún contador: veías "120 guías, 118 guardadas" y las dos perdidas eran invisibles. Ahora hay contadores `sin_costo` y `errores` con sus listas, y un chequeo de que los contadores sumen el total.

---

## Cómo lo verifiqué

1. **`node --check` en los 16 archivos JS** modificados. Sin errores de sintaxis.
2. **Arranqué el servidor completo contra una copia de tu base de producción.** Levanta limpio:

```
[liquidacion.model] Migración de columnas OK
[backup] OK → nova_backup_20260727_190244.db (320.0 KB)
[sesiones] purgadas 25 sesiones vencidas
Nova Express API en http://localhost:3998
```

3. **Verifiqué que los 5 índices se crearon** en la base de prueba.
4. **`npm run check-schema` da 0 desvíos** después de los cambios.
5. **Test de concurrencia** comparando la versión vieja contra la nueva (arriba).
5-bis. **35 tests del parser de facturas** (`npm run test-parser`): los dos formatos de número, la factura real, y tres escenarios simulados de cambio de formato de UPS. Pasan los 35.
5-ter. **Prueba end-to-end de la carga de facturas**: levanté el servidor contra una copia de tu base y subí la factura real por el endpoint. `/chequear` devuelve la reconciliación con la diferencia de 91,22; `/cargar` deja los contadores sumando el total; y la **segunda carga de la misma factura devuelve 409** en vez de duplicar el ledger. Esa prueba encontró un error mío (una consulta a una columna que no existe) que la revisión a ojo no había visto.
6. **Revisé el diff archivo por archivo** contra el original, y respeté los finales de línea de cada uno (el repo tiene algunos CRLF y otros LF): el diff son 642 líneas reales, no un cambio de formato masivo.

---

## Lo que NO toqué a propósito

**Cosas donde no sé cuál es la regla correcta de tu negocio.** Cambiarlas mueve precios y no me corresponde decidirlo:

- **Sobrepeso DHL** — el cotizador cobra $125 y el backend $23 para el mismo bulto pesado por volumen. Arreglarlo hace que uno de los dos cambie de precio. ¿Cuál está bien?
- **Contorno mayor a 400 cm** — hoy no cobra los $120. Arreglarlo sube el precio de esos bultos.
- **Seguro DHL** — el código aplica un mínimo de 17,50 para cualquier FOB; la regla escrita dice 0 / 15 / 1,5%.
- **Documentos DHL** — el cotizador usa tarifa de documento y el backend no. Son 33% de diferencia.
- **Manejo adicional + contorno UPS** — hoy se cobran los dos juntos en el mismo bulto.

**Cosas que tocan plata ya guardada:**

- **Editar un envío no recalcula el costo.** Es un bug real, pero el arreglo cambia los números de envíos que ya están cargados. Quiero que estés para decidir cómo.
- **El frontend pisa el profit real con el estimado** en envíos ya conciliados. Mismo motivo.

**El índice único que impediría un envío en dos liquidaciones.** No lo agregué **a propósito**: tu base tiene hoy dos casos (envíos 31 y 147). Crear ese índice ahora **haría fallar el arranque del servidor**. Primero hay que borrar los borradores, después se agrega.

---

## Lo que te toca a vos, en el VPS

Entrás con `ssh nova` y `cd ~/Nova-Express-Sistem`.

**1. La cookie sin `Secure` — lo más urgente:**

```
echo "NODE_ENV=production" >> .env
```

**2. Limpiar el `.env`** — corriste el `echo` dos veces, así que `NODE_ENV=production` quedó duplicado. Es inofensivo (dotenv toma el último), pero conviene mirarlo:

```
cat .env
```

Y verificar que la variable tomó:

```
node -e "console.log('NODE_ENV =', require('./backend/src/config').nodeEnv)"
```

**3. Los dos borradores de liquidación**, antes de que alguien los confirme y refacture USD 2.225 y USD 138. **Miralos primero:**

```
sqlite3 database/nova.db "SELECT id, cliente_id, fecha, estado, total FROM liquidaciones WHERE id IN (12,30);"
```

Si confirmás que son los borradores fantasma, ahí sí se borran. **No corras esto sin mirar lo de arriba.**

**4. Cuando quieras subir los cambios**, desde tu PC:

```
git add -A
```
```
git commit -m "fix serializa transacciones y arregla cache busting fechas locales e indices"
```
```
git push
```

Y en el VPS:

```
git pull && pm2 restart nova
```

---

## Dejé esto en tu carpeta

- `C:\Users\felid\OneDrive\Documents\GitHub\nova_backup_20260727_124029.db` — la copia de producción que usé. Podés borrarla.
- `C:\Users\felid\OneDrive\Documents\GitHub\_to_delete\` — dos archivos temporales míos. Borrá esa carpeta entera cuando quieras (yo no puedo borrar archivos en tu máquina).
