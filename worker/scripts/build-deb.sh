#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(python3 - <<PY
import json
from pathlib import Path
pkg = json.loads(Path("$ROOT_DIR/package.json").read_text())
print(pkg.get("version", "0.0.0"))
PY
)"

BUILD_DIR="$ROOT_DIR/build/deb"
DIST_DIR="$ROOT_DIR/dist"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/DEBIAN" \
  "$BUILD_DIR/usr/bin" \
  "$BUILD_DIR/lib/systemd/system" \
  "$BUILD_DIR/etc/edu-worker" \
  "$BUILD_DIR/etc/edu-worker/workers.d" \
  "$BUILD_DIR/usr/share/doc/edu-worker" \
  "$BUILD_DIR/var/lib/edu-worker/workspaces"

install -m 755 "$ROOT_DIR/packaging/edu-worker" "$BUILD_DIR/usr/bin/edu-worker"
install -m 755 "$ROOT_DIR/packaging/edu-worker-manager" "$BUILD_DIR/usr/bin/edu-worker-manager"
install -m 644 "$ROOT_DIR/packaging/edu-worker.service" "$BUILD_DIR/lib/systemd/system/edu-worker.service"
install -m 600 "$ROOT_DIR/packaging/worker.env" "$BUILD_DIR/etc/edu-worker/worker.env"
install -m 600 "$ROOT_DIR/packaging/serviceAccountKey.json" "$BUILD_DIR/etc/edu-worker/serviceAccountKey.json"
install -m 644 "$ROOT_DIR/packaging/worker.env" "$BUILD_DIR/usr/share/doc/edu-worker/worker.env.example"

cat > "$BUILD_DIR/DEBIAN/control" << EOF
Package: edu-worker
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Depends: docker.io | docker-ce, bash
Maintainer: Educacion Cooperativa
Description: Worker local para Educacion Cooperativa
 Este servicio ejecuta workers en Docker para espacios de trabajo.
 Soporta multiples workspaces con edu-worker-manager.
 Cada workspace tiene su propio contenedor aislado.
EOF

cat > "$BUILD_DIR/DEBIAN/conffiles" << EOF
/etc/edu-worker/worker.env
/etc/edu-worker/serviceAccountKey.json
EOF

cat > "$BUILD_DIR/DEBIAN/postinst" << 'EOF'
#!/bin/bash
set -e

# Get actual user (not root during sudo install)
ACTUAL_USER="${SUDO_USER:-$USER}"
ACTUAL_HOME=$(getent passwd "$ACTUAL_USER" | cut -d: -f6)

# Create directories
mkdir -p /etc/edu-worker/workers.d
mkdir -p "$ACTUAL_HOME/edu-worker/workspaces"
chown -R "$ACTUAL_USER:$ACTUAL_USER" "$ACTUAL_HOME/edu-worker"

# Set BASE_MOUNT_PATH in worker.env
if grep -q "^BASE_MOUNT_PATH=$" /etc/edu-worker/worker.env 2>/dev/null; then
  sed -i "s|^BASE_MOUNT_PATH=$|BASE_MOUNT_PATH=$ACTUAL_HOME/edu-worker|g" /etc/edu-worker/worker.env
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
fi

# Connect Docker Snap interface if using snap
if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then
  snap connect docker:removable-media 2>/dev/null || true
fi

echo ""
echo "=============================================="
echo "  EDU-WORKER INSTALLED SUCCESSFULLY"
echo "=============================================="
echo ""
echo "Workspace files will be stored in: $ACTUAL_HOME/edu-worker/workspaces/"
echo ""
echo "To configure a workspace worker, use:"
echo ""
echo "  # For personal workspace:"
echo "  sudo edu-worker-manager add <userId> --type personal"
echo ""
echo "  # For shared workspace:"
echo "  sudo edu-worker-manager add <workspaceId> --name 'Workspace Name'"
echo ""
echo "  # Start all workers:"
echo "  sudo edu-worker-manager start all"
echo ""
echo "  # Check status:"
echo "  sudo edu-worker-manager status"
echo ""
EOF
chmod 755 "$BUILD_DIR/DEBIAN/postinst"

mkdir -p "$DIST_DIR"
dpkg-deb --root-owner-group --build "$BUILD_DIR" "$DIST_DIR/edu-worker_${VERSION}_amd64.deb"
echo "Paquete creado: $DIST_DIR/edu-worker_${VERSION}_amd64.deb"
