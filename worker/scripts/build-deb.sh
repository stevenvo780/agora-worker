#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(python3 - <<PY\nimport json\nfrom pathlib import Path\npkg = json.loads(Path(\"$ROOT_DIR/package.json\").read_text())\nprint(pkg.get(\"version\", \"0.0.0\"))\nPY\n)"

BUILD_DIR="$ROOT_DIR/build/deb"
DIST_DIR="$ROOT_DIR/dist"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/DEBIAN" \
  "$BUILD_DIR/usr/bin" \
  "$BUILD_DIR/lib/systemd/system" \
  "$BUILD_DIR/etc/edu-worker" \
  "$BUILD_DIR/usr/share/doc/edu-worker"

install -m 755 "$ROOT_DIR/packaging/edu-worker" "$BUILD_DIR/usr/bin/edu-worker"
install -m 644 "$ROOT_DIR/packaging/edu-worker.service" "$BUILD_DIR/lib/systemd/system/edu-worker.service"
install -m 644 "$ROOT_DIR/packaging/worker.env" "$BUILD_DIR/etc/edu-worker/worker.env"
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
 Este servicio ejecuta el worker en Docker y habilita la sincronizacion de archivos.
EOF

cat > "$BUILD_DIR/DEBIAN/conffiles" << EOF
/etc/edu-worker/worker.env
EOF

cat > "$BUILD_DIR/DEBIAN/postinst" << 'EOF'
#!/bin/bash
set -e

mkdir -p /var/lib/edu-worker/workspace

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
  systemctl enable edu-worker.service || true

  token="$(grep -E '^WORKER_TOKEN=' /etc/edu-worker/worker.env | cut -d= -f2- || true)"
  if [ -n "$token" ]; then
    systemctl restart edu-worker.service || true
  else
    echo "WORKER_TOKEN vacio. Edita /etc/edu-worker/worker.env y reinicia el servicio."
  fi
fi
EOF
chmod 755 "$BUILD_DIR/DEBIAN/postinst"

mkdir -p "$DIST_DIR"
dpkg-deb --build "$BUILD_DIR" "$DIST_DIR/edu-worker_${VERSION}_amd64.deb"
echo "Paquete creado: $DIST_DIR/edu-worker_${VERSION}_amd64.deb"
