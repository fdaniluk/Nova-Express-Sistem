# Matriz única de tarifas del cliente (punto 9 bis)

**Estado al 11/08/2026, 18:10 (Buenos Aires): DESPLEGADO Y SANO.**

- Commit **`4220421`** — *"Una sola tabla de tarifas por cliente: los tramos de peso son los mismos
  para porcentaje y para precio por kilo"*, 21 archivos.
- Tests en la máquina de Felipe: **30 tandas · 751 controles · 0 fallas** (6 controles más que el
  despliegue anterior).
- VPS: `7aa789e → 4220421`, base 22 tablas, `check-schema` sin desvíos, health OK.
- Copia previa: `database/backups/antes_de_desplegar_20260811_175710.db` (245 envíos, verificada).
- Volver atrás: `cd /root/Nova-Express-Sistem && git reset --hard 7aa789e && pm2 restart nova`

---

## Qué se cambió

### Frontend — `frontend/js/modules/clientes-perfil.js` + `frontend/pages/clientes-perfil.html`

Una sola grilla, se cobre por porcentaje o por kilo.

- **Las nueve bandas fijas siempre visibles**, llenas o vacías. Antes, en modo por kilo, la pantalla
  mostraba *solo los rangos cargados*: si alguien cargaba 1 a 3 kg, la fila de 3 a 5 no existía —ni en
  la pantalla ni en la cabeza de nadie— y un envío de 4 kg se cobraba por porcentaje sin avisar. Ahora
  un hueco es una celda gris que se ve.
- **Columna "Todas" al principio**, separada con un borde: el precio del tramo para las seis zonas en
  un clic. Reemplaza a la barra de "agregar rango", que quedó oculta (el elemento sigue en el HTML
  para no romper nada).
- **Los tramos viejos de rango libre se siguen mostrando**, en amarillo y con la etiqueta *"tramo
  viejo"*. No se pueden editar desde ahí: se borran y se recargan sobre las bandas.
- Cache busting a **`?v=20260811a`** — 82 referencias, incluido `cotizador_courier_v8.html`.

### Backend — `backend/src/services/profit.service.js`

`validarCoordenadasKg()` ahora **exige que el rango sea una banda fija**. Cierra tres agujeros:
**huecos**, **rangos superpuestos** y **el borde compartido** (1-3 y 3-5 se pisaban en los 3 kg
exactos). Con las bandas no se pueden expresar.

`resolverTarifaKg()` busca **por banda exacta**. El camino viejo por contención queda solo para las
filas de rango libre anteriores al cambio: se resuelven como siempre —no se le cambia el precio a
nadie por atrás— pero avisan por consola.

**Las nueve bandas:** `0-5 · 5-10 · 10-15 · 15-20 · 20-25 · 25-30 · 30-40 · 40-50 · 50+`
(límite inferior exclusivo, superior inclusivo; la primera incluye el 0).

---

## ⚠️ Lo que apareció al mirar los datos reales de producción (11/08, después de desplegar)

Felipe volcó `tarifa_kg_overrides` del VPS. **54 filas.** Dos cosas que no sabíamos:

### 1. Las 53 filas con rango son TODAS "tramo viejo"

Ningún rango cargado coincide con una banda:

| Cliente | Rango cargado | ¿Banda? |
|---|---|---|
| 1 · Cliente Demo | 10-20 | ✗ |
| 2 · PIO ALVAREZ | 20-32 · 32,5+ | ✗ |
| 6 · Cueros Santa Cruz | 20-29,5 · 30+ | ✗ |
| 36 · GERSCOVICH | 25+ | ✗ |

La única fila válida es la general de cliente 2 (`peso_min` y `peso_max` en null).

**Consecuencia:** la pantalla de tarifas quedó **de solo lectura para todos los clientes que
realmente usan precio por kilo**. Siguen cobrando exactamente igual —eso no cambió—, pero la oficina
no puede editar esos precios desde ahí: tiene que borrar la fila y recargarla sobre las bandas.

Y los rangos viejos son **quiebres comerciales reales** del tarifario (20-29,5 · 32,5+ · 25+), no
errores de carga. Rehacerlos sobre 20-25 / 25-30 / 30-40 **cambia el precio** de algunos envíos.
**Es una decisión de Felipe, no una migración automática.** Hay tres caminos posibles: migrar a mano
cliente por cliente decidiendo el precio de cada banda, agregar bandas que contemplen esos quiebres,
o dejar convivir los tramos viejos y darles edición.

Clientes **26 (La Justina)** y **55 (Arenasa)** están en modo por kilo **sin ninguna fila cargada**:
caen al porcentaje con advertencia.

### 2. Cliente 2 (PIO ALVAREZ) tiene 21 filas con `precio_kg = 0`

Zonas 1, 3, 4, 5 y 6 —en UPS Express y en DHL, en los dos tramos— están en **USD 0,00 el kilo**. La
zona 2 no tiene celda, así que cae a la fila general y cobra 7,02 / 4,86.

**Un 0 no es "sin precio".** En `resolverTarifaKg()` una fila que matchea devuelve su precio tal cual;
la caída al porcentaje ocurre **solo si ninguna fila matchea**. O sea: esas zonas venden el flete a
cero. Y como la fila general de UPS Express también está en 0, los envíos de menos de 20 kg de ese
cliente por UPS caen ahí y también dan 0.

**Falta reproducirlo contra envíos reales** antes de afirmar cuánta plata es. Comando de solo lectura
pendiente de correr en el VPS.

---

## Lo que quedó fuera del alcance, a propósito

Arriba de la tabla iban a ir los datos generales del cliente que hoy quedan sueltos (profit general,
fuel propio, seguro propio). **Están, pero sueltos como antes.**

## Nota de horarios

La máquina virtual del puente reporta las fechas **en UTC**. Un archivo con fecha `20:41` fue tocado
a las **17:41 de Buenos Aires**.
