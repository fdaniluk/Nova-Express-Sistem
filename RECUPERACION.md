# Cómo volver a levantar el sistema Nova Express

**Este documento está escrito para alguien que NO es Felipe.** Si estás leyendo esto es
porque algo se rompió y hay que poner el sistema de vuelta en pie. No hace falta saber
programar: hay que saber copiar y pegar comandos y tener el sobre de accesos.

Última revisión: 06/08/2026.

---

## Lo primero: ¿qué se perdió?

| Si pasó esto… | Gravedad | Andá a |
|---|---|---|
| Se rompió o se perdió la computadora de Felipe | **Baja.** El sistema sigue andando solo. | [Caso A](#caso-a) |
| El sistema no abre / el servidor no está más | **Alta.** Es el caso grave. | [Caso B](#caso-b) |
| El sistema abre pero tira errores raros de base de datos | Media | [Caso C](#caso-c) |
| Alguien borró datos por error y hay que recuperarlos | Media | [Caso D](#caso-d) |

---

## Dónde vive cada cosa

Son **dos** cosas separadas y se recuperan por separado. Esto es lo más importante de
entender de todo el documento:

**1. EL SISTEMA (el programa).**
Vive en GitHub: `https://github.com/fdaniluk/Nova-Express-Sistem`
Es un repositorio privado. Se baja entero con un comando. No se pierde salvo que se
borre la cuenta de GitHub.

**2. LA INFORMACIÓN (clientes, envíos, liquidaciones, tarifas).**
Es un solo archivo: `nova.db`. Está en tres lugares a la vez:

- En el servidor, en `/root/Nova-Express-Sistem/database/nova.db` — el original, el que
  se usa todos los días.
- En el servidor, en `/root/Nova-Express-Sistem/database/backups/` — las últimas 30
  copias diarias. **Sirven si se corrompió la base, NO si se perdió el servidor**,
  porque están en el mismo disco.
- En **OneDrive, carpeta `Nova Backups`** — una copia por día, comprimida (`.db.gz`),
  ordenada por año. Además se guarda para siempre la copia del día 1 de cada mes.
  **Esta es la única que sobrevive a que se pierda el servidor entero.**

La computadora de Felipe **no guarda nada que no esté en los otros dos lados.**

---

<a name="caso-a"></a>
## Caso A — Se perdió la computadora de Felipe

**No hay urgencia. El sistema sigue funcionando y la oficina puede seguir trabajando
normalmente.** La computadora de Felipe no corre el sistema: solo se usa para hacerle
cambios.

Lo único que se pierde son los accesos guardados en esa máquina. Para volver a trabajar
sobre el sistema desde una computadora nueva:

1. Instalar **Node.js** (versión 20 o superior) desde `https://nodejs.org`.
2. Instalar **Git** desde `https://git-scm.com`.
3. Abrir PowerShell y bajar el sistema:

```
git clone https://github.com/fdaniluk/Nova-Express-Sistem.git
```

4. Entrar a la carpeta e instalar las dependencias:

```
cd Nova-Express-Sistem\backend
npm install
```

5. Crear el archivo `.env` en la raíz del proyecto con las credenciales de UPS (están en
   el sobre de accesos):

```
UPS_CLIENT_ID=...
UPS_CLIENT_SECRET=...
```

6. Para tener datos con qué probar, bajar la última copia de OneDrive (`Nova Backups`),
   descomprimirla y dejarla como `database\nova.db`.

**Ojo:** esa base es una copia para probar, no la de producción. Los cambios que se hagan
ahí no le llegan a la oficina.

---

<a name="caso-b"></a>
## Caso B — Se cayó el servidor entero

Este es el caso grave. Objetivo: que la oficina vuelva a trabajar. Se puede hacer en
un par de horas.

### B.1 — Primero, confirmar que el servidor no está

Puede ser algo mucho más simple: que el programa se haya caído pero el servidor esté
bien. Entrar por SSH al servidor (datos en el sobre) y probar:

```
pm2 list
```

- Si contesta y aparece `nova` en estado `stopped` o `errored` → no hace falta recuperar
  nada. Correr `pm2 restart nova` y listo.
- Si contesta y `nova` está `online` pero el sistema no abre → es un problema de red o
  de dominio, no del servidor. Revisar el dominio con el proveedor.
- Si no se puede entrar por SSH → seguir con B.2.

### B.2 — Conseguir un servidor nuevo

Cualquier VPS con Linux (Ubuntu o Debian) sirve. El sistema es chico: con 1 GB de RAM
alcanza y sobra. Anotar la IP nueva.

### B.3 — Preparar el servidor

Conectado por SSH al servidor nuevo, uno por uno:

```
apt update && apt install -y git curl
```

```
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs
```

```
npm install -g pm2
```

### B.4 — Bajar el sistema

```
cd /root && git clone https://github.com/fdaniluk/Nova-Express-Sistem.git
```

Va a pedir usuario y contraseña de GitHub (el repositorio es privado). Están en el sobre.

```
cd /root/Nova-Express-Sistem/backend && npm install
```

### B.5 — Poner las credenciales de UPS

```
nano /root/Nova-Express-Sistem/.env
```

Escribir adentro las dos líneas (los valores están en el sobre), guardar con `Ctrl+O` y
salir con `Ctrl+X`:

```
UPS_CLIENT_ID=...
UPS_CLIENT_SECRET=...
```

### B.6 — Traer la información desde OneDrive

Este es el paso que recupera los datos. Bajar de OneDrive, de la carpeta `Nova Backups`,
**el archivo `.db.gz` más nuevo**. Subirlo al servidor y después:

```
cd /root/Nova-Express-Sistem/database && gunzip -c nova_backup_AAAAMMDD_HHMMSS.db.gz > nova.db
```

(reemplazando el nombre por el del archivo que se bajó)

Antes de seguir, **confirmar que la copia sirve**:

```
cd /root/Nova-Express-Sistem/backend && node scripts/verificar-backup.js ../database/nova.db
```

Tiene que decir **"El backup sirve para restaurar"** y mostrar cuántos clientes y envíos
tiene. Si dice que no sirve, usar el archivo del día anterior y volver a probar.

### B.7 — Arrancar

```
cd /root/Nova-Express-Sistem/backend && pm2 start src/server.js --name nova
```

```
pm2 save && pm2 startup
```

Comprobar que está vivo:

```
curl -s http://localhost:3000/api/health
```

### B.8 — Que se pueda entrar desde la oficina

Apuntar el dominio a la IP nueva desde el panel del proveedor del dominio (está en el
sobre). Hasta que el dominio apunte al servidor nuevo, la oficina puede entrar
directamente por la IP.

### B.9 — Volver a dejar la copia externa andando

**No saltear este paso.** Si no, el sistema queda otra vez sin copia afuera y nadie se
entera. Ver la sección [Volver a configurar la copia a OneDrive](#copia).

---

<a name="caso-c"></a>
## Caso C — La base se corrompió pero el servidor está bien

Síntomas: el sistema abre pero tira errores al guardar, o el panel de Salud marca la base
en rojo.

**1. Parar el sistema** (para que nadie escriba mientras tanto):

```
pm2 stop nova
```

**2. Guardar la base rota** — no borrarla nunca, puede tener datos recuperables:

```
cd /root/Nova-Express-Sistem/database && mv nova.db nova.db.rota
```

**3. Buscar la copia buena más nueva:**

```
ls -lt /root/Nova-Express-Sistem/database/backups/ | head -5
```

**4. Revisarla ANTES de usarla:**

```
cd /root/Nova-Express-Sistem/backend && node scripts/verificar-backup.js ../database/backups/nova_backup_AAAAMMDD_HHMMSS.db
```

Si dice que no sirve, probar con la anterior de la lista.

**5. Ponerla en su lugar:**

```
cp /root/Nova-Express-Sistem/database/backups/nova_backup_AAAAMMDD_HHMMSS.db /root/Nova-Express-Sistem/database/nova.db
```

**6. Arrancar:**

```
pm2 start nova
```

**Qué se pierde:** lo que se haya cargado entre la hora de esa copia y el momento de la
rotura. Hay que avisarle a la oficina qué día y hora tiene la copia que se restauró, para
que vuelvan a cargar lo de ese rato.

---

<a name="caso-d"></a>
## Caso D — Alguien borró datos por error

**No restaurar la base entera.** Si se pisa la base actual con la de ayer, se pierde todo
lo que se cargó hoy, que suele ser más de lo que se borró por error.

Lo correcto es abrir la copia **al lado** de la base viva, sacar de ahí lo que falta y
cargarlo a mano. Para eso hay que saber qué día se borró. Pedirle a Felipe (o a quien
maneje el sistema) que lo haga; si no está, dejar la base como está y esperar. Un día sin
esos datos se arregla; una restauración mal hecha, no.

---

<a name="copia"></a>
## Volver a configurar la copia a OneDrive

En un servidor nuevo hay que rehacerla. Uno por uno:

```
curl https://rclone.org/install.sh | bash
```

```
rclone config
```

Ahí adentro: `n` (nuevo) → nombre **`onedrive`** → tipo **onedrive** → dejar en blanco
client_id y client_secret → cuando pregunte si usar configuración automática, responder
**`n`** → copiar el comando que muestra, correrlo en una computadora con navegador,
iniciar sesión con la cuenta de OneDrive de Nova y pegar de vuelta lo que devuelva.

Probar que ve la carpeta:

```
rclone ls "onedrive:Nova Backups" | tail -5
```

Probar la copia completa sin tocar nada:

```
bash /root/Nova-Express-Sistem/scripts/copia-externa.sh --prueba
```

Y dejarla programada todos los días a las 3 de la mañana:

```
(crontab -l 2>/dev/null; echo "0 3 * * * bash /root/Nova-Express-Sistem/scripts/copia-externa.sh >> /root/Nova-Express-Sistem/database/backups/cron.log 2>&1") | crontab -
```

---

## Cómo saber que quedó todo bien

Entrar al sistema como administrador y abrir la pantalla **Salud**. El chequeo
"Backups de la base" tiene que estar en **verde** y decir cuántas copias hay en OneDrive
y de cuándo es la última.

- **Ámbar** = el sistema hace copias pero ninguna sale del servidor. Falta configurar
  rclone.
- **Rojo** = la copia a OneDrive falló o dejó de correr. El motivo aparece en el mismo
  cartel.

---

## Lo que NO hay que hacer nunca

- **Borrar la base rota.** Guardarla siempre como `nova.db.rota`. Muchas veces se puede
  sacar información de ahí.
- **Restaurar una copia sin revisarla antes.** Un backup roto pesa, tiene fecha de hoy y
  se ve perfecto en un listado. Por eso existe `verificar-backup.js`.
- **Restaurar la base entera para recuperar un dato suelto** (ver Caso D).
- **Dejar el sistema andando sin la copia a OneDrive configurada.** Es volver al punto de
  partida.
- **Copiar la carpeta `database` mientras el sistema está andando** para hacer un backup
  a mano. Hay que usar `npm run backup`, que la deja consistente.

---

## Lo que este documento NO tiene

Las contraseñas y los accesos **no están acá a propósito**, porque este archivo está en
GitHub y en el proyecto de Claude. Van en el sobre de accesos, aparte. El sobre tiene que
tener, como mínimo:

- Proveedor del servidor: cuál es, con qué cuenta se entra, y cómo se entra por SSH.
- Cuenta de GitHub (usuario y token de acceso).
- Proveedor del dominio y con qué cuenta se entra.
- Cuenta de OneDrive donde están las copias.
- Los valores de `UPS_CLIENT_ID` y `UPS_CLIENT_SECRET`. **Estos dos no están en ningún
  backup ni en GitHub**: si se pierden hay que volver a pedirlos en el portal de
  desarrolladores de UPS.
- Usuario administrador del sistema.

Ese sobre tiene que estar en manos de al menos una persona más además de Felipe.
