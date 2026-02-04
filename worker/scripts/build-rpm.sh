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
  echo "rpmbuild not installed. Install rpm-build." >&2
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
Summary:    Worker for Educacion Cooperativa (Docker)
License:    Proprietary
BuildArch:  x86_64
Requires:   docker

%description
Docker-based worker service with multi-workspace support via edu-worker-manager.

%install
mkdir -p %{buildroot}/usr/bin
mkdir -p %{buildroot}/etc/edu-worker/workers.d
mkdir -p %{buildroot}/usr/lib/systemd/system

install -m 755 $ROOT_DIR/packaging/edu-worker %{buildroot}/usr/bin/edu-worker
install -m 755 $ROOT_DIR/packaging/edu-worker-manager %{buildroot}/usr/bin/edu-worker-manager
install -m 600 $ROOT_DIR/packaging/worker.env %{buildroot}/etc/edu-worker/worker.env
install -m 644 $ROOT_DIR/packaging/edu-worker.service %{buildroot}/usr/lib/systemd/system/edu-worker.service

%files
/usr/bin/edu-worker
/usr/bin/edu-worker-manager
/usr/lib/systemd/system/edu-worker.service
%config(noreplace) /etc/edu-worker/worker.env
%dir /etc/edu-worker/workers.d

%post
mkdir -p /var/lib/edu-worker/workspaces
systemctl daemon-reload || true
echo "Use 'edu-worker-manager add <workspace-id>' to configure workers"
EOF

rpmbuild --define "_topdir $RPM_BUILD_DIR" -bb "$SPEC_FILE"
echo "RPM: $RPM_BUILD_DIR/RPMS/"
