#!/usr/bin/env bash
#
# desplegar.sh — subir al VPS lo que está en GitHub, en UN comando.
#
# POR QUÉ EXISTE
# Cada despliegue eran cinco o seis comandos pegados a mano, de a uno, leyendo la salida
# de cada uno para decidir si seguir. Siempre los mismos, siempre en el mismo orden. Un
# paso salteado —el backup, por ejemplo— no se nota hasta el día que hace falta.
#
# QUÉ HACE, en orden, y se DETIENE al primer problema:
#   1. Comprueba que no haya cambios sin guardar en el servidor. Si los hay, para: un
#      `git pull` encima los borraría o se trabaría, y en los dos casos es peor el
#      remedio. Nunca pisa nada.
#   2. Copia la base ANTES de tocar nada, y la abre para verificar que la copia sirve.
#      Una copia rota es peor que no tener copia, porque da tranquilidad falsa.
#   3. Se anota en qué commit estaba, para poder volver.
#   4. Trae los cambios de GitHub.
#   5. Instala dependencias SOLO si cambió package.json.
#   6. Reinicia la aplicación.
#   7. Comprueba que la base quedó con la forma que espera el código (check-schema).
#   8. Pregunta al sitio si está vivo, con reintentos.
#
# Si algo falla después de reiniciar, imprime el comando exacto para volver al estado
# anterior. NO vuelve solo: revertir es una decisión de una persona, no de un script.
#
# CÓMO SE USA, en el VPS:
#   cd /root/Nova-Express-Sistem && bash scripts/desplegar.sh
#
# Sale con 0 si quedó desplegado y sano, 1 si no.

set -uo pipefail

# Se pueden pisar por variable de entorno para probar el script sin tocar producción:
#   NOVA_RAIZ=/tmp/prueba NOVA_APP=nada bash scripts/desplegar.sh
APP="${NOVA_APP:-nova}"
RAIZ="${NOVA_RAIZ:-/root/Nova-Express-Sistem}"
BASE="$RAIZ/database/nova.db"
DIR_COPIAS="$RAIZ/database/backups"
PUERTO="${PORT:-3000}"

rojo()  { printf '\033[31m%s\033[0m\n' "$1"; }
verde() { printf '\033[32m%s\033[0m\n' "$1"; }
paso()  { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

morir() {
  echo
  rojo "✗ $1"
  echo
  exit 1
}

cd "$RAIZ" 2>/dev/null || morir "No existe $RAIZ. ¿Es este el servidor correcto?"

# ── 1. Nada sin guardar ────────────────────────────────────────────────────────
paso "Revisando que no haya cambios sin guardar en el servidor"
# Solo cuentan los archivos SEGUIDOS por git y modificados: son los que un pull pisaría.
# Los archivos sueltos que no están en el repo (un .tgz olvidado, un script de una vez)
# no molestan a nadie y no son motivo para frenar un despliegue. Frenar por ellos haría
# que el script "no ande" justo el día que hay apuro, que es cuando se lo saltea a mano.
SUCIO="$(git status --porcelain --untracked-files=no)"
if [ -n "$SUCIO" ]; then
  echo "$SUCIO"
  morir "Hay archivos modificados EN EL SERVIDOR. Alguien editó acá a mano.
   No sigo: un pull encima de esto los pisa.
   Miralos con: cd $RAIZ && git diff"
fi
verde "  limpio"

# ── 2. Copia de la base, verificada ────────────────────────────────────────────
paso "Copiando la base antes de tocar nada"
mkdir -p "$DIR_COPIAS"
COPIA="$DIR_COPIAS/antes_de_desplegar_$(date +%Y%m%d_%H%M%S).db"
# La copia la hace un script de node con el sqlite3 de la aplicación: el `sqlite3` de
# línea de comandos puede no estar instalado en el servidor, y un backup que no corre
# porque falta un programa es un backup que no existe. El script además ABRE la copia
# para verificarla y devuelve cuántos envíos tiene.
FILAS="$(cd "$RAIZ/backend" && node scripts/copia-previa.js "$BASE" "$COPIA")" || \
  morir "No se pudo copiar la base. NO se desplegó nada."
if [ -z "$FILAS" ]; then
  morir "La copia se creó pero no se puede leer. NO se desplegó nada.
   Archivo sospechoso: $COPIA"
fi
verde "  $COPIA ($FILAS envíos, leída y verificada)"

# ── 3. Dónde estábamos ─────────────────────────────────────────────────────────
ANTES="$(git rev-parse --short HEAD)"
paso "Commit actual: $ANTES"

# ── 4. Traer los cambios ───────────────────────────────────────────────────────
paso "Trayendo los cambios de GitHub"
git pull --ff-only || morir "El pull falló. No se tocó la aplicación, sigue corriendo la versión vieja."
DESPUES="$(git rev-parse --short HEAD)"
if [ "$ANTES" = "$DESPUES" ]; then
  echo "  No había nada nuevo (sigue en $ANTES)."
else
  verde "  $ANTES → $DESPUES"
  git log --oneline "$ANTES..$DESPUES" | sed 's/^/    /'
fi

# ── 5. Dependencias, solo si hace falta ────────────────────────────────────────
if [ "$ANTES" != "$DESPUES" ] && git diff --name-only "$ANTES" "$DESPUES" | grep -q '^backend/package.json$'; then
  paso "Cambió package.json: instalando dependencias"
  (cd "$RAIZ/backend" && npm install --omit=dev) || morir "npm install falló. La aplicación sigue con la versión vieja."
else
  paso "Dependencias sin cambios: no se instala nada"
fi

# ── 6. Reiniciar ───────────────────────────────────────────────────────────────
paso "Reiniciando la aplicación"
pm2 restart "$APP" --update-env || morir "pm2 no pudo reiniciar. Mirá: pm2 logs $APP --lines 50"
sleep 4

# ── 7. La base tiene la forma que espera el código ─────────────────────────────
paso "Comprobando la base contra schema.sql"
if ! (cd "$RAIZ/backend" && npm run --silent check-schema); then
  rojo "  check-schema encontró desvíos."
  echo
  echo "   Para volver al estado anterior:"
  echo "     cd $RAIZ && git reset --hard $ANTES && pm2 restart $APP"
  echo "   La copia de la base de antes está en:"
  echo "     $COPIA"
  exit 1
fi

# ── 8. ¿Está vivo? ─────────────────────────────────────────────────────────────
paso "Preguntando si el sitio está vivo"
VIVO=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 5 "http://localhost:$PUERTO/api/health" >/dev/null 2>&1; then
    VIVO="si"
    verde "  contesta OK (intento $i)"
    break
  fi
  sleep 2
done

if [ -z "$VIVO" ]; then
  rojo "  No contesta después de 20 segundos."
  echo
  echo "   Mirá qué dice:      pm2 logs $APP --lines 50"
  echo "   Para volver atrás:  cd $RAIZ && git reset --hard $ANTES && pm2 restart $APP"
  echo "   Copia de la base:   $COPIA"
  exit 1
fi

echo
verde "════════════════════════════════════════════════════════════"
verde "DESPLEGADO Y SANO · $ANTES → $DESPUES"
verde "════════════════════════════════════════════════════════════"
echo "Copia de la base de antes: $COPIA"
echo "Si más tarde algo anda mal, volver atrás es:"
echo "  cd $RAIZ && git reset --hard $ANTES && pm2 restart $APP"
