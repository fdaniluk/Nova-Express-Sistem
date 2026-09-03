# Copia de seguridad y recuperación

**Decidido el 06/08/2026.** Cierra el limitador L2 (backups en el mismo disco que la base).
**EN MARCHA desde el 28/08/2026** — ver "Puesta en marcha", abajo.

---

## Puesta en marcha real (28/08/2026) — FUNCIONANDO

- **Cuenta:** se creó una cuenta Microsoft **de la empresa** para esto:
  `respaldonovaexpress@gmail.com` ("Nova Express Respaldo"), plan gratis de 5 GB. Un año de
  copias ocupa ~8 MB, sobra. **La contraseña va en el sobre de accesos, NUNCA acá.**
  ⚠️ Esta cuenta NO sincroniza a la computadora de Felipe (el razonamiento viejo de "queda
  también en su PC" era para la cuenta personal y ya no aplica). La segunda copia afuera
  del VPS sigue pendiente de que alguien instale OneDrive con esta cuenta en alguna máquina.
- **Remote de rclone en el VPS:** se llama exactamente `onedrive`, apunta a la carpeta
  `Nova Backups`. Primera copia subida y verificada el 28/08 (12:27, 177 KB).
- **Cron instalado el 28/08:** `0 3 * * * cd /root/Nova-Express-Sistem && bash
  scripts/copia-externa.sh >> /root/copia-externa.log 2>&1` (todos los días a las 3 AM,
  registro en `/root/copia-externa.log`).
- **Panel de Salud:** "Backups de la base" quedó VERDE ("Copia fuera del VPS OK").

### ⚠️ La trampa que costó dos intentos: el token de la cuenta equivocada

`rclone authorize "onedrive"` abre el navegador y **autoriza solo, en segundos, con la
cuenta Microsoft que esté abierta** — dos veces agarró la cuenta personal de Felipe (llena:
5,5 GB), y el síntoma fue `quotaLimitReached` en cada escritura con `rclone about`
mostrando `Used: 5.500 GiB` aunque la web de la cuenta nueva decía 0. Si algún día hay que
reautorizar, el procedimiento correcto es:

1. En la PC: `rclone authorize --auth-no-open-browser "onedrive"` (NO abre nada solo).
2. Copiar el link `http://127.0.0.1:53682/...` que imprime y pegarlo en una **ventana de
   incógnito** → iniciar sesión a mano con `respaldonovaexpress@gmail.com`.
3. Copiar el token (`{"access_token":...}` completo). Ojo: en PowerShell el clic derecho
   PEGA si ya hay algo copiado, y una captura de pantalla PISA el portapapeles.
4. En el VPS: `rclone config reconnect onedrive:` → replace token? `y` → navegador `n` →
   pegar el token en `config_token>` → `tenant>` vacío → tipo `1` → drive `1` → `y`.
5. **Veredicto:** `rclone about onedrive:` tiene que dar `Used` chico. Si da 5,5 GB, entró
   la cuenta personal otra vez.

---

## El problema que resuelve

Antes de esto, el sistema hacía 30 copias de la base **todas en el mismo disco que la
base**. Si se perdía el VPS —el proveedor lo da de baja por falta de pago, se rompe el
disco, alguien borra la carpeta— se iban la base y las 30 copias juntas. No había ni una
copia afuera.

El segundo problema, que no lo arregla ningún software: Felipe era el único con acceso a
todo.

---

## Sobre Supabase

Felipe preguntó si convenía usar Supabase, que se lo recomendaron unos amigos.

**Se descartó, y no por prejuicio.** Supabase es una base de datos alojada (PostgreSQL en
la nube), no un sistema de copias de seguridad. Resolvería que la base deje de estar en un
solo disco, pero:

- El sistema igual necesita correr en algún lado: el VPS sigue haciendo falta.
- No resuelve nada del problema de acceso.
- Cuesta desde unos USD 25 por mes.
- **El costo caro no es ese: todo el sistema está escrito para SQLite.** Cada consulta,
  las migraciones, el esquema y los 19 tests. Pasarlo a Postgres es reescribir la capa de
  datos entera, con riesgo de romper lo que hoy funciona.

Supabase resuelve problemas de escala: muchas oficinas escribiendo a la vez, una app
móvil, miles de operaciones por minuto. La base de Nova pesa 442 KB y la usa una oficina.
SQLite ahí no tiene ningún problema técnico ni lo va a tener pronto.

**Se revisa de nuevo si aparece alguna de estas: más de una oficina cargando al mismo
tiempo, una app para el celular, o la base pasa de unos cuantos GB.** Hasta entonces, no.

---

## Lo que se armó en su lugar

### 1. Copia diaria a OneDrive (`scripts/copia-externa.sh`)

Corre por cron todos los días a las 3 de la mañana en el VPS. Hace, en orden:

1. Una copia fresca de la base (`VACUUM INTO`, con el WAL ya integrado).
2. **La abre y la revisa antes de subirla.** Si está rota NO la sube: una copia rota
   arriba pisa el lugar de una buena.
3. La comprime (240 KB → 21 KB) y la sube a OneDrive, carpeta `Nova Backups`, ordenada
   por año.
4. Comprueba que lo que llegó pese lo mismo que lo que salió.
5. Borra las copias remotas de más de 90 días, **pero se queda para siempre con la del
   día 1 de cada mes.** Eso cubre el caso del error que se descubre tres meses después.
6. Deja escrita una marca con cómo le fue.

Un año de copias diarias ocupa unos 8 MB en OneDrive.

### 2. El verificador (`backend/scripts/verificar-backup.js`)

Un backup roto se ve **exactamente igual** que uno bueno en un `ls`: el archivo está, pesa
algo, tiene fecha de hoy. La diferencia aparece el día que hay que restaurarlo.

El verificador lo abre y mira cinco cosas: que exista y no esté vacío, que sea realmente
una base SQLite, que pase el `integrity_check`, que tenga las tablas clave con filas
adentro, y —lo más útil— que no le falten filas contra la base de producción.

Ese último chequeo es el que agarra el caso feo: el backup que se hizo bien pero quedó a
mitad de camino. Una base íntegra pero vacía pasa el `integrity_check` con honores y no
sirve para nada.

Se usa solo dentro del script diario, y a mano cuando hay que restaurar:

```
cd backend && node scripts/verificar-backup.js ../database/nova.db
```

### 3. El panel de Salud avisa cuando la copia se corta

Antes el chequeo "Backups de la base" estaba en **ámbar permanente** con el texto "sin
copia afuera". Un aviso que está siempre encendido es un aviso que nadie mira.

Ahora lee la marca que deja el script:

| Estado | Qué significa |
|---|---|
| **Verde** | La copia externa corrió y está al día. Dice cuántas copias hay en OneDrive. |
| **Ámbar** | El sistema hace copias pero ninguna sale del VPS (falta configurar rclone). |
| **Rojo** | La copia falló, o dejó de correr hace más de 36 horas. Muestra el motivo. |

Los chequeos locales que ya existían siguen igual: si el backup del VPS es viejo o encogió
de golpe, sigue dando rojo aunque la copia externa esté perfecta.

### 4. El instructivo (`RECUPERACION.md`)

Paso a paso para volver a levantar todo, **escrito para alguien que no es Felipe**. Está
en el repositorio y en este proyecto. Cubre cuatro casos:

- Se perdió la computadora de Felipe → **no pasa nada**, el sistema sigue andando.
- Se cayó el VPS entero → el caso grave, unas dos horas de trabajo.
- La base se corrompió pero el VPS está → restaurar de las copias locales.
- Alguien borró datos por error → **no restaurar la base entera.**

### 5. El sobre de accesos

Planilla aparte, fuera del repositorio y fuera de este proyecto, porque lleva
contraseñas. VPS, GitHub, dominio, OneDrive (**ahora incluye la cuenta nueva
respaldonovaexpress@gmail.com**), credenciales de UPS y usuarios del sistema.

**Dato importante:** `UPS_CLIENT_ID` y `UPS_CLIENT_SECRET` viven solo en el archivo `.env`
del VPS. No están en GitHub ni en ningún backup. Si se pierde el VPS y no están anotadas,
hay que volver a pedirlas en el portal de desarrolladores de UPS.

**Segundo acceso:** Felipe eligió que sea alguien de la oficina. Falta definir quién.

---

## Qué se probó

`backend/scripts/test-copia-externa.js` — 30 chequeos, dentro de `npm test`.

Prueba el verificador plantando backups rotos a propósito: vacío, truncado a la mitad, un
archivo que no es una base, íntegro pero sin datos, y al que le faltan filas contra
producción. Y prueba que el panel de salud se ponga en rojo cuando la copia falla o dejó
de correr, sin dar falsa alarma por un atraso normal de un día.

**Simulacro de restauración hecho el 06/08:** se tomó el `.db.gz` tal como queda en
OneDrive, se descomprimió, se verificó, se levantó el sistema contra esa base y respondió
`{"ok":true}` con los datos completos. El circuito entero funciona de punta a punta.
**Pendiente repetirlo con una copia REAL bajada de OneDrive** (punto 2 de la consolidación)
— el del 06/08 fue con el archivo local, antes de que existiera la subida.

---

## Lo que sigue abierto

- Definir **quién** de la oficina es el segundo acceso, y completar el sobre (sumar la
  cuenta respaldonovaexpress@gmail.com).
- ✅ ~~Confirmar si la cuenta de OneDrive es la personal de Felipe o una de la empresa~~ —
  **resuelto el 28/08: es una cuenta de la empresa, creada para esto.**
- Repetir el simulacro de restauración bajando la copia desde OneDrive (punto 2 de la
  consolidación).
- Si se quiere la segunda copia "que baja sola a una PC", instalar OneDrive con la cuenta
  de respaldo en alguna máquina de la oficina.
