#!/usr/bin/env bash
set -euo pipefail

# install-worker.sh — instala edu-worker en cualquier distro Linux soportada.
# Detecta el engine de contenedores (docker o podman) y, si falta, lo instala
# según la familia de distro. Después hace pull de la imagen y levanta el
# container con la config estándar.
#
# Uso:
#   WORKER_SECRET=<secret> ./install-worker.sh <workspaceId>
#
# Variables opcionales:
#   NEXUS_URL     URL de AgoraHub (default: https://hub.humanizar-dev.cloud)
#   WORKER_TOKEN  Token del worker (default: <workspaceId>)

# Detect distro
if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO="${ID,,}"
  DISTRO_FAMILY="${ID_LIKE,,}"
else
  echo "ERROR: no se detectó la distro (falta /etc/os-release)" >&2
  exit 1
fi

# Detect container engine
CONTAINER_CMD=""
if command -v docker >/dev/null 2>&1; then
  CONTAINER_CMD="docker"
elif command -v podman >/dev/null 2>&1; then
  CONTAINER_CMD="podman"
fi

# Install engine if none
if [ -z "$CONTAINER_CMD" ]; then
  case "$DISTRO" in
    fedora|rhel|centos|rocky|almalinux)
      echo "==> Instalando Podman (engine preferido en Fedora)..."
      sudo dnf install -y podman
      CONTAINER_CMD="podman"
      ;;
    ubuntu|debian|pop|linuxmint)
      echo "==> Instalando Docker CE..."
      sudo apt-get update
      sudo apt-get install -y docker.io
      sudo usermod -aG docker "$USER"
      echo "Reiniciá la shell para que el grupo docker tome efecto, o usá: sudo docker ..."
      CONTAINER_CMD="docker"
      ;;
    arch|manjaro)
      echo "==> Instalando Docker desde pacman..."
      sudo pacman -S --noconfirm docker
      sudo systemctl enable --now docker
      sudo usermod -aG docker "$USER"
      CONTAINER_CMD="docker"
      ;;
    *)
      # Fallback por familia (ID_LIKE)
      case "$DISTRO_FAMILY" in
        *fedora*|*rhel*|*centos*)
          echo "==> Distro $DISTRO derivada de fedora/rhel — instalando Podman..."
          sudo dnf install -y podman
          CONTAINER_CMD="podman"
          ;;
        *debian*|*ubuntu*)
          echo "==> Distro $DISTRO derivada de debian — instalando Docker..."
          sudo apt-get update
          sudo apt-get install -y docker.io
          sudo usermod -aG docker "$USER"
          CONTAINER_CMD="docker"
          ;;
        *)
          echo "ERROR: distro '$DISTRO' (family '$DISTRO_FAMILY') no soportada automáticamente." >&2
          echo "Instalá docker o podman manualmente y volvé a correr." >&2
          exit 1
          ;;
      esac
      ;;
  esac
fi

echo "==> Engine detectado/instalado: $CONTAINER_CMD"

# Required args
WSID="${1:-}"
NEXUS_URL="${NEXUS_URL:-https://hub.humanizar-dev.cloud}"
WORKER_TOKEN="${WORKER_TOKEN:-$WSID}"
WORKER_SECRET="${WORKER_SECRET:-}"

if [ -z "$WSID" ] || [ -z "$WORKER_SECRET" ]; then
  echo "Uso: WORKER_SECRET=<secret> ./install-worker.sh <workspaceId>" >&2
  echo "  NEXUS_URL opcional (default: https://hub.humanizar-dev.cloud)" >&2
  exit 1
fi

# Pull image
echo "==> Descargando imagen stevenvo780/edu-worker:latest..."
$CONTAINER_CMD pull stevenvo780/edu-worker:latest

# Run
CONTAINER_NAME="edu-worker-${WSID}"
echo "==> Lanzando container $CONTAINER_NAME..."
$CONTAINER_CMD run -d \
  --name "$CONTAINER_NAME" \
  --restart=unless-stopped \
  --network=host \
  -e "NEXUS_URL=$NEXUS_URL" \
  -e "WORKER_TOKEN=$WORKER_TOKEN" \
  -e "WORKER_SECRET=$WORKER_SECRET" \
  stevenvo780/edu-worker:latest

echo "==> Worker corriendo. Logs: $CONTAINER_CMD logs -f $CONTAINER_NAME"
