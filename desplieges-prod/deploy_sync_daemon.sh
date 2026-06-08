#!/usr/bin/env bash
# Deploy idempotente de agora-host-sync a ils-server (host de workers).
#
# Uso:
#   SUDO_PASS=<pass> ./deploy_sync_daemon.sh [host]
#
# Variables:
#   HOST       — destino SSH (default: ils-server)
#   SUDO_PASS  — password sudo del host (requerido)
#
# El script:
#   1. Rsync del source (sin node_modules, .env*, *.bak*) a /opt/agora-host-sync/
#   2. npm install --omit=dev en el host
#   3. chown -R humanizar:humanizar /opt/agora-host-sync
#   4. systemctl restart agora-host-sync
#   5. Verifica que el servicio quede activo

set -euo pipefail

HOST="${1:-ils-server}"
SUDO_PASS="${SUDO_PASS:?env SUDO_PASS required}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "${SCRIPT_DIR}/../worker-host-sync" && pwd)"
REMOTE_TMP="/tmp/agora-host-sync-new"
REMOTE_DEST="/opt/agora-host-sync"

echo "==> [deploy_sync_daemon] src:  ${SRC_DIR}"
echo "==> [deploy_sync_daemon] dest: ${HOST}:${REMOTE_DEST}"

# 1. Rsync source al host (staging en /tmp para no interrumpir mientras copia)
echo "==> rsync source → ${HOST}:${REMOTE_TMP}/"
rsync -avz \
  --exclude="node_modules" \
  --exclude=".env*" \
  --exclude="*.bak*" \
  --exclude=".git" \
  "${SRC_DIR}/" "${HOST}:${REMOTE_TMP}/"

# 2. Mover a destino final, instalar deps y reiniciar
echo "==> instalando en ${HOST}:${REMOTE_DEST} y reiniciando servicio..."
ssh "${HOST}" "echo '${SUDO_PASS}' | sudo -S bash -s" << 'REMOTE'
set -euo pipefail

REMOTE_TMP="/tmp/agora-host-sync-new"
REMOTE_DEST="/opt/agora-host-sync"

mkdir -p "${REMOTE_DEST}"

# Rsync del staging al destino final (conservar .env si existe, no sobreescribir)
rsync -a \
  --exclude="node_modules" \
  --exclude=".env*" \
  --delete \
  "${REMOTE_TMP}/" "${REMOTE_DEST}/"

# Instalar dependencias de producción
cd "${REMOTE_DEST}"
if [[ -f package.json ]]; then
  node --version
  npm install --omit=dev --prefer-offline
fi

chown -R humanizar:humanizar "${REMOTE_DEST}"
chmod 755 "${REMOTE_DEST}"

# Copiar unit si cambia
if [[ -f "${REMOTE_DEST}/agora-host-sync.service" ]]; then
  cp "${REMOTE_DEST}/agora-host-sync.service" /etc/systemd/system/agora-host-sync.service
  systemctl daemon-reload
fi

# Asegurar logs dir
mkdir -p /home/humanizar/logs
chown humanizar:humanizar /home/humanizar/logs

systemctl restart agora-host-sync
sleep 2
STATUS=$(systemctl is-active agora-host-sync)
echo "==> systemctl is-active agora-host-sync: ${STATUS}"
if [[ "${STATUS}" != "active" ]]; then
  echo "ERROR: servicio no quedó activo" >&2
  journalctl -u agora-host-sync -n 20 --no-pager >&2
  exit 1
fi
REMOTE

echo "==> [deploy_sync_daemon] done — agora-host-sync activo en ${HOST}"
