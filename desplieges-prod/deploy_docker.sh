#!/bin/bash
# Deploy Worker Docker image (without .deb update)
# Use this when only the Docker image changed, not the management scripts
# Includes: ST interpreter (@stevenvo780/st-lang) + ST_GUIDE.md auto-setup
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_HOST="${WORKER_HOST:-stev@100.98.8.227}"
REMOTE_SUDO_PASS="${WORKER_SUDO_PASS:-}"
IMAGE="${WORKER_IMAGE:-stevenvo780/edu-worker:latest}"
ST_LANG_VERSION="${1:-}"

source "${SCRIPT_DIR}/lib/remote_common.sh"
prompt_remote_sudo_if_needed "workers en ${REMOTE_HOST}"

echo "🚀 Deploying Docker image to $REMOTE_HOST..."

BUILD_ARGS=()
if [[ -n "$ST_LANG_VERSION" ]]; then
	echo "📌 Building worker image with @stevenvo780/st-lang@${ST_LANG_VERSION}..."
	BUILD_ARGS+=(--build-arg "ST_LANG_VERSION=${ST_LANG_VERSION}")
else
	echo "📌 Building worker image with ST_LANG_VERSION from services/worker/Dockerfile..."
fi

# Build and push image
echo "📦 Building Docker image (with ST interpreter)..."
docker build "${BUILD_ARGS[@]}" -t "$IMAGE" services/worker/

echo "📤 Pushing to Docker Hub..."
docker push "$IMAGE"

# Update all workers
echo "🔄 Pulling new image and recreating all workers..."
remote_sudo "edu-worker-manager update all"

echo "✅ Verifying rollout..."
WORKER_COUNT="$(remote_sudo "docker ps --filter name=edu-worker --format '{{.Names}}' | wc -l")"
echo "📦 Workers activos: ${WORKER_COUNT}"

SAMPLE="$(remote_sudo "docker ps --filter name=edu-worker --format '{{.Names}}' | head -n 1")"
if [[ -n "$SAMPLE" ]]; then
	VERSION_REMOTE="$(remote_sudo "docker exec ${SAMPLE@Q} st --version" | tail -n 1)"
	echo "🔍 ST verificado en ${SAMPLE}: ${VERSION_REMOTE}"
fi

echo "🎉 Docker image deployed! ST interpreter available in ${WORKER_COUNT} active worker(s)."
