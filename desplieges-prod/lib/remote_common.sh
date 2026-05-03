#!/bin/bash
# Utilidades comunes de SSH/sudo remoto para despliegues de producción.

set -euo pipefail

: "${REMOTE_HOST:?REMOTE_HOST is required}"
REMOTE_SUDO_PASS="${REMOTE_SUDO_PASS:-}"

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)

prompt_remote_sudo_if_needed() {
  local label="${1:-$REMOTE_HOST}"
  if [[ -z "$REMOTE_SUDO_PASS" && -t 0 ]]; then
    read -rsp "🔐 Sudo password para ${label} (Enter si sudo es passwordless): " REMOTE_SUDO_PASS
    echo
  fi
}

remote_ssh() {
  ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "$@"
}

remote_scp() {
  scp "${SSH_OPTS[@]}" "$@"
}

remote_sudo() {
  local cmd="$1"
  local quoted_cmd
  quoted_cmd=$(printf '%q' "$cmd")

  if [[ -n "$REMOTE_SUDO_PASS" ]]; then
    remote_ssh "sudo -S -p '' bash -lc ${quoted_cmd}" <<<"$REMOTE_SUDO_PASS"
    return
  fi

  if ! remote_ssh "sudo -n bash -lc ${quoted_cmd}"; then
    cat >&2 <<EOF
❌ sudo remoto requiere contraseña en ${REMOTE_HOST}.
   Exporta REMOTE_SUDO_PASS (o la variable específica del script)
   o vuelve a lanzar el script desde una terminal interactiva para introducirla sin guardarla en el repo.
EOF
    return 1
  fi
}