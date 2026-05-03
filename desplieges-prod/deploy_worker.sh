#!/bin/bash
# Deploy Worker .deb to production
# Requires: SSH key auth configured for the current workers host
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_HOST="${WORKER_HOST:-stev@100.98.8.227}"
REMOTE_SUDO_PASS="${WORKER_SUDO_PASS:-}"
WORKER_VERSION="${WORKER_VERSION:-$(python3 - <<'PY'
import json
from pathlib import Path
pkg = json.loads(Path('services/worker/package.json').read_text())
print(pkg.get('version', '0.0.0'))
PY
)}"
LOCAL_DEB="${WORKER_DEB_PATH:-services/worker/dist/edu-worker_${WORKER_VERSION}_amd64.deb}"
REMOTE_DEB="/tmp/$(basename "$LOCAL_DEB")"

source "${SCRIPT_DIR}/lib/remote_common.sh"
prompt_remote_sudo_if_needed "workers en ${REMOTE_HOST}"

echo "🚀 Deploying Worker manager to $REMOTE_HOST..."

# Build if needed
if [ ! -f "$LOCAL_DEB" ]; then
    echo "📦 Building .deb package..."
    ./services/worker/scripts/build-deb.sh
fi

# Upload
echo "📤 Uploading package..."
remote_scp "$LOCAL_DEB" "$REMOTE_HOST:$REMOTE_DEB"

# Install
echo "🔧 Installing..."
remote_sudo "dpkg -i --force-confold ${REMOTE_DEB@Q}"

# Update all workers with new image
echo "🔄 Updating workers..."
remote_sudo "edu-worker-manager update all"

echo "✅ Verifying worker manager status..."
remote_sudo "edu-worker-manager status"

echo "🎉 Worker deployed successfully!"
