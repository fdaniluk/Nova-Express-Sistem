#!/usr/bin/env bash
#
# copia-externa.sh — saca la base del VPS y la deja en OneDrive, una vez por día.
#
# POR QUÉ EXISTE
# El sistema ya se hace 30 copias solo. Las 30 viven en el mismo disco que la base. Si
# ese disco se pierde —el proveedor da de baja el servidor, se rompe el disco, alguien
# borra la carpeta— se van la base y las 30 copias juntas. Este script es el único que
# saca la información afuera del VPS.
#
# QUÉ HACE, en orden:
#   1. Hace una copia fresca de la base (VACUUM INTO, con el WAL ya integrado).
#   2. La ABRE Y LA REVISA antes de subirla. Si está rota, NO la sube: una copia rota
#      arriba pisa el lugar de una buena.
#   3. La comprime y la sube a OneDrive.
#   4. Comprueba que lo que llegó pese lo mismo que lo que salió.
#   5. Borra las copias remotas viejas, pero se queda para siempre con la del día 1 de
#      cada mes. Sirve para el caso en que un error se descubre tres meses después.
#   6. Deja escrito cómo le fue. El panel de salud lee ese archivo: si esto deja de
#      correr, el panel se pone en rojo y se sabe ese día, no el día de restaurar.
#
# CÓMO SE USA
#   bash scripts/copia-externa.sh              # normal, lo que corre el cron
#   bash scripts/copia-externa.sh --prueba     # hace todo pero no sube ni borra nada
#
# Sale con 0 si la copia quedó arriba, 1 si no.

set -uo pipefail

# ── Qué tocar si algo se muda ───────────────────────────────────────────────
RAIZ="${NOVA_RAIZ:-/root/Nova-Express-Sistem}"
REMOTO="${NOVA_REMOTO:-onedrive:Nova Backups}"
DIAS_REMOTOS="${NOVA_DIAS_REMOTOS:-90}"     # las diarias se guardan estos días
RCLONE="${RCLONE_BIN:-rclone}"

DB="$RAIZ/database/nova.db"
DIR_BACKUPS="$RAIZ/database/backups"
MARCA="$DIR_BACKUPS/.copia-externa.json"
LOG="$DIR_BACKUPS/copia-externa.log"
CANDADO="/tmp/nova-copia-externa.lock"

PRUEBA=0
[[ "${1:-}" == "--prueba" ]] && PRUEBA=1

mkdir -p "$DIR_BACKUPS"

decir() {
  local linea="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$linea"
  echo "$linea" >> "$LOG"
}

# La marca es el puente con el panel de salud. Se escribe SIEMPRE, salga bien o mal:
# una copia que falla y no deja rastro es peor que una que falla y avisa.
escribir_marca() {
  local ok="$1" archivo="$2" kb="$3" error="$4" remotas="$5"
  cat > "$MARCA" <<JSON
{
  "ok": $ok,
  "cuando": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "archivo": "$archivo",
  "tamano_kb": $kb,
  "destino": "$REMOTO",
  "copias_remotas": $remotas,
  "error": $( [[ -z "$error" ]] && echo null || printf '"%s"' "$(echo "$error" | tr '"' "'" | tr -d '\n')" )
}
JSON
}

fracaso() {
  decir "ERROR: $1"
  escribir_marca false "" 0 "$1" 0
  exit 1
}

# Dos copias corriendo a la vez sobre la misma base es pedirle problemas a SQLite y a
# rclone. Si ya hay una en curso, esta se va sin hacer nada.
exec 9>"$CANDADO"
if ! flock -n 9; then
  decir "Ya hay otra copia en curso — esta corrida se saltea."
  exit 0
fi

decir "──────── Copia externa $([[ $PRUEBA == 1 ]] && echo '(PRUEBA, no sube nada)')"

[[ -f "$DB" ]] || fracaso "no está la base en $DB"

# ── 1. Copia fresca ─────────────────────────────────────────────────────────
# Se usa el mismo backup que ya tiene el sistema: VACUUM INTO deja un archivo compactado
# con el WAL adentro. Es seguro correrlo con el servidor andando: para SQLite es lectura.
decir "Haciendo copia fresca de la base…"
if ! (cd "$RAIZ/backend" && node src/scripts/backup-cli.js >> "$LOG" 2>&1); then
  fracaso "falló el backup de la base (ver $LOG)"
fi

ULTIMO="$(ls -1t "$DIR_BACKUPS"/nova_backup_*.db 2>/dev/null | head -1)"
[[ -n "$ULTIMO" ]] || fracaso "no quedó ningún archivo de backup en $DIR_BACKUPS"
NOMBRE="$(basename "$ULTIMO")"
KB=$(( $(stat -c%s "$ULTIMO") / 1024 ))
decir "Copia: $NOMBRE (${KB} KB)"

# ── 2. Revisarla ANTES de subirla ───────────────────────────────────────────
decir "Revisando que la copia sirva…"
if ! (cd "$RAIZ/backend" && node scripts/verificar-backup.js "$ULTIMO" --contra "$DB" >> "$LOG" 2>&1); then
  fracaso "la copia no pasó la revisión — NO se sube (ver $LOG)"
fi
decir "La copia está sana."

# ── 3. Comprimir y subir ────────────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
gzip -c "$ULTIMO" > "$TMP/$NOMBRE.gz" || fracaso "no se pudo comprimir la copia"
KB_GZ=$(( $(stat -c%s "$TMP/$NOMBRE.gz") / 1024 ))
BYTES_GZ=$(stat -c%s "$TMP/$NOMBRE.gz")

# Se guarda por año, para que la carpeta de OneDrive no termine con 400 archivos sueltos.
ANIO="${NOMBRE:12:4}"
[[ "$ANIO" =~ ^[0-9]{4}$ ]] || ANIO="$(date '+%Y')"
DESTINO="$REMOTO/$ANIO"

if [[ $PRUEBA == 1 ]]; then
  decir "PRUEBA: acá subiría $NOMBRE.gz (${KB_GZ} KB) a $DESTINO"
  escribir_marca true "$NOMBRE.gz" "$KB_GZ" "" 0
  decir "Prueba terminada, no se tocó nada afuera."
  exit 0
fi

command -v "$RCLONE" >/dev/null 2>&1 || fracaso "rclone no está instalado en el VPS"

decir "Subiendo a $DESTINO …"
if ! "$RCLONE" copy "$TMP/$NOMBRE.gz" "$DESTINO/" --no-traverse >> "$LOG" 2>&1; then
  fracaso "rclone no pudo subir el archivo (ver $LOG)"
fi

# ── 4. Comprobar que lo que llegó es lo que salió ───────────────────────────
# Que rclone no dé error no garantiza que el archivo esté entero del otro lado.
TAM_REMOTO="$("$RCLONE" size "$DESTINO/$NOMBRE.gz" --json 2>/dev/null | grep -o '"bytes":[0-9]*' | head -1 | cut -d: -f2)"
if [[ -z "$TAM_REMOTO" || "$TAM_REMOTO" != "$BYTES_GZ" ]]; then
  fracaso "el archivo de OneDrive no coincide (subieron ${TAM_REMOTO:-0} bytes de $BYTES_GZ)"
fi
decir "Verificado arriba: $NOMBRE.gz (${KB_GZ} KB)"

# ── 5. Limpieza de las viejas, salvando la del día 1 ────────────────────────
CORTE="$(date -d "-$DIAS_REMOTOS days" '+%Y%m%d')"
BORRADAS=0
while read -r arch; do
  [[ -n "$arch" ]] || continue
  fecha="${arch:12:8}"                       # nova_backup_YYYYMMDD_HHMMSS.db.gz
  [[ "$fecha" =~ ^[0-9]{8}$ ]] || continue
  [[ "${fecha:6:2}" == "01" ]] && continue    # la del día 1 de cada mes se queda para siempre
  if [[ "$fecha" < "$CORTE" ]]; then
    if "$RCLONE" deletefile "$REMOTO/${fecha:0:4}/$arch" >> "$LOG" 2>&1; then
      BORRADAS=$((BORRADAS + 1))
    fi
  fi
done < <("$RCLONE" lsf "$REMOTO" --recursive --files-only 2>/dev/null | sed 's#.*/##')
[[ $BORRADAS -gt 0 ]] && decir "Limpieza: $BORRADAS copia(s) vieja(s) borrada(s) de OneDrive."

REMOTAS="$("$RCLONE" lsf "$REMOTO" --recursive --files-only 2>/dev/null | grep -c '\.gz$')"
REMOTAS="${REMOTAS:-0}"

# ── 6. Dejar dicho cómo salió ───────────────────────────────────────────────
escribir_marca true "$NOMBRE.gz" "$KB_GZ" "" "$REMOTAS"
decir "LISTO — la base está afuera del VPS. $REMOTAS copia(s) en OneDrive."

# El log no puede crecer para siempre.
if [[ -f "$LOG" ]] && [[ $(wc -l < "$LOG") -gt 3000 ]]; then
  tail -1500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

exit 0
