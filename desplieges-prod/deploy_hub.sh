#!/bin/bash
# Deploy Hub to production
# Requires: SSH key auth configured for the current hub host
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_HOST="${HUB_HOST:-stev@100.98.8.227}"
REMOTE_SUDO_PASS="${HUB_SUDO_PASS:-${WORKER_SUDO_PASS:-}}"
HUB_SYSTEMD_SCOPE="${HUB_SYSTEMD_SCOPE:-user}"
HUB_VERSION="${HUB_VERSION:-$(python3 - <<'PY'
import json
from pathlib import Path
pkg = json.loads(Path('services/hub/package.json').read_text())
print(pkg.get('version', '0.0.0'))
PY
)}"
LOCAL_DEB="${HUB_DEB_PATH:-services/hub/dist/edu-hub_${HUB_VERSION}_amd64.deb}"
REMOTE_DEB="/tmp/$(basename "$LOCAL_DEB")"

source "${SCRIPT_DIR}/lib/remote_common.sh"
prompt_remote_sudo_if_needed "hub en ${REMOTE_HOST}"

echo "🚀 Deploying Hub to $REMOTE_HOST..."

# Build if needed
if [ ! -f "$LOCAL_DEB" ]; then
    echo "📦 Building .deb package..."
    ./services/hub/scripts/build-deb.sh
fi

# Upload
echo "📤 Uploading package..."
remote_scp "$LOCAL_DEB" "$REMOTE_HOST:$REMOTE_DEB"

# Install and restart
echo "🔧 Installing..."
remote_sudo "dpkg -i --force-confold ${REMOTE_DEB@Q}"

if [[ "$HUB_SYSTEMD_SCOPE" == "user" ]]; then
    remote_ssh "systemctl --user daemon-reload && systemctl --user restart edu-hub"
else
    remote_sudo "systemctl daemon-reload && systemctl restart edu-hub"
fi

# Verify
echo "✅ Verifying..."
if [[ "$HUB_SYSTEMD_SCOPE" == "user" ]]; then
    remote_ssh "systemctl --user is-active edu-hub"
else
    remote_sudo "systemctl is-active edu-hub"
fi

echo "🎉 Hub deployed successfully!"
