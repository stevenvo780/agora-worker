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

if ! command -v rpmbuild >/dev/null 2>&1; then
  echo "rpmbuild no esta instalado. Instala rpm-build para generar RPM." >&2
  exit 1
fi

RPM_BUILD_DIR="$ROOT_DIR/build/rpm"
rm -rf "$RPM_BUILD_DIR"
mkdir -p "$RPM_BUILD_DIR"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

SPEC_FILE="$RPM_BUILD_DIR/SPECS/edu-worker.spec"

cat > "$SPEC_FILE" << EOF
Name:       edu-worker
Version:    $VERSION
Release:    1%{?dist}
Summary:    Worker local para Educacion Cooperativa (Docker)
License:    Proprietary
BuildArch:  x86_64
Requires:   docker

%description
Este servicio ejecuta el worker en Docker y habilita la sincronizacion de archivos.

%prep
# No preparation needed

%build
# No build steps needed

%install
mkdir -p %{buildroot}/usr/bin
mkdir -p %{buildroot}/etc/edu-worker
mkdir -p %{buildroot}/usr/lib/systemd/system

install -m 755 $ROOT_DIR/packaging/edu-worker %{buildroot}/usr/bin/edu-worker
install -m 644 $ROOT_DIR/packaging/worker.env %{buildroot}/etc/edu-worker/worker.env
install -m 644 $ROOT_DIR/packaging/edu-worker.service %{buildroot}/usr/lib/systemd/system/edu-worker.service

%files
/usr/bin/edu-worker
/usr/lib/systemd/system/edu-worker.service
%config(noreplace) /etc/edu-worker/worker.env

%post
mkdir -p /var/lib/edu-worker/workspace
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
  systemctl enable edu-worker.service || true
  token="\$(grep -E '^WORKER_TOKEN=' /etc/edu-worker/worker.env | cut -d= -f2- || true)"
  if [ -n "\$token" ]; then
    systemctl restart edu-worker.service || true
  else
    echo "WORKER_TOKEN vacio. Edita /etc/edu-worker/worker.env y reinicia el servicio."
  fi
fi
EOF

rpmbuild --define "_topdir $RPM_BUILD_DIR" -bb "$SPEC_FILE"
echo "RPM generado en $RPM_BUILD_DIR/RPMS/"
