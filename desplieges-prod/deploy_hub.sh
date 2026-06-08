#!/bin/bash
# Deploy AgoraHub to Hostinger VPS agora-storage (post-migración GCP→Hostinger, 2026-05)
# Contexto: hub vive en AgoraHub/ (peer dir). VPS agora-storage: root@76.13.118.239.
# Systemd unit edu-hub.service, usuario no-root edu-hub, ProtectSystem.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGORA_HUB_DIR="$(cd "${SCRIPT_DIR}/../../AgoraHub" && pwd)"
REMOTE_HOST="${HUB_HOST:-root@76.13.118.239}"
REMOTE_TMP="/tmp/edu-hub-new-index.js"
REMOTE_DEST="/opt/edu-hub/dist/index.js"
HEALTH_URL="https://hub.elenxos.com/health"

echo "==> AgoraHub dir: ${AGORA_HUB_DIR}"

# 1. Build local
echo "==> Instalando dependencias y construyendo..."
cd "${AGORA_HUB_DIR}"
npm install
npm run build

LOCAL_ARTIFACT="${AGORA_HUB_DIR}/dist/index.js"
if [[ ! -f "${LOCAL_ARTIFACT}" ]]; then
  echo "ERROR: ${LOCAL_ARTIFACT} no existe tras el build." >&2
  exit 1
fi
echo "==> Build OK: ${LOCAL_ARTIFACT}"

# 2. Subir artefacto a /tmp del VPS (sin necesitar root en destino)
echo "==> Subiendo dist/index.js a ${REMOTE_HOST}:${REMOTE_TMP}..."
scp "${LOCAL_ARTIFACT}" "${REMOTE_HOST}:${REMOTE_TMP}"
echo "==> scp OK"

# 3. Mover al destino final con permisos correctos y reiniciar el servicio
echo "==> Instalando en VPS y reiniciando edu-hub.service..."
ssh "${REMOTE_HOST}" "
    set -euo pipefail
    cp '${REMOTE_TMP}' '${REMOTE_DEST}'
    chown edu-hub:edu-hub '${REMOTE_DEST}'
    chmod 644 '${REMOTE_DEST}'
    rm -f '${REMOTE_TMP}'
    systemctl restart edu-hub
    systemctl is-active edu-hub
  "
echo "==> Restart OK"

# 4. Health check final — esperar hasta 20s para que el proceso levante
echo "==> Health check: ${HEALTH_URL}"
for i in 1 2 3 4; do
  sleep 5
  RESPONSE=$(curl -sf "${HEALTH_URL}" 2>/dev/null) && {
    echo "${RESPONSE}" | python3 -m json.tool
    break
  }
  echo "   intento ${i}/4 — esperando..."
  if [[ $i -eq 4 ]]; then
    echo "ERROR: health check falló tras 20s en ${HEALTH_URL}" >&2
    exit 1
  fi
done

echo "==> Deploy completo."
