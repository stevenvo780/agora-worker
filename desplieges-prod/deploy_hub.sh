#!/bin/bash
# Deploy AgoraHub to GCP VM agora-hub (post-split, 2026-05)
# Contexto: hub vive en AgoraHub/ (peer dir). VM agora-hub en us-central1-a.
# Systemd unit edu-hub.service, usuario no-root edu-hub, ProtectSystem.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGORA_HUB_DIR="$(cd "${SCRIPT_DIR}/../../AgoraHub" && pwd)"
GCP_VM="agora-hub"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
GCP_PROJECT="${GCP_PROJECT:-udea-filosofia}"
REMOTE_TMP="/tmp/edu-hub-new-index.js"
REMOTE_DEST="/opt/edu-hub/dist/index.js"
HEALTH_URL="https://hub.humanizar-dev.cloud/health"

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

# 2. Subir artefacto a /tmp de la VM (sin necesitar root en destino)
echo "==> Subiendo dist/index.js a ${GCP_VM}:${REMOTE_TMP}..."
gcloud compute scp "${LOCAL_ARTIFACT}" "${GCP_VM}:${REMOTE_TMP}" \
  --zone="${GCP_ZONE}" --project="${GCP_PROJECT}"
echo "==> scp OK"

# 3. Mover al destino final con permisos correctos y reiniciar el servicio
echo "==> Instalando en VM y reiniciando edu-hub.service..."
gcloud compute ssh "${GCP_VM}" \
  --zone="${GCP_ZONE}" --project="${GCP_PROJECT}" \
  --command="
    set -euo pipefail
    sudo cp '${REMOTE_TMP}' '${REMOTE_DEST}'
    sudo chown edu-hub:edu-hub '${REMOTE_DEST}'
    sudo chmod 644 '${REMOTE_DEST}'
    rm -f '${REMOTE_TMP}'
    sudo systemctl restart edu-hub
    sudo systemctl is-active edu-hub
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
