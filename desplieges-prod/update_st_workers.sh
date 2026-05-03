#!/bin/bash
# ============================================================
# Actualiza @stevenvo780/st-lang en TODOS los workers en caliente
# Sin rebuild de imagen ni restart de containers
# ============================================================
set -euo pipefail

if [[ "${ALLOW_INPLACE_ST_UPDATE:-0}" != "1" ]]; then
  cat >&2 <<'EOF'
❌ Refusing in-place ST update by default.
   Usa ./desplieges-prod/deploy_docker.sh para el rollout persistente.
   Si esto es un hotfix de emergencia, relanza con ALLOW_INPLACE_ST_UPDATE=1.
EOF
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_HOST="${WORKER_HOST:-stev@100.98.8.227}"
REMOTE_SUDO_PASS="${WORKER_SUDO_PASS:-}"
VERSION="${1:-latest}"
PACKAGE_SPEC="@stevenvo780/st-lang@${VERSION}"

source "${SCRIPT_DIR}/lib/remote_common.sh"
prompt_remote_sudo_if_needed "workers en ${REMOTE_HOST}"

echo "🔄 Actualizando ${PACKAGE_SPEC} en workers de ${REMOTE_HOST}..."

# Obtener lista de containers
mapfile -t CONTAINERS < <(remote_sudo "docker ps --filter name=edu-worker --format '{{.Names}}'")
TOTAL=${#CONTAINERS[@]}
echo "📦 Workers encontrados: $TOTAL"

if [[ "$TOTAL" -eq 0 ]]; then
  echo "⚠️ No se encontraron contenedores edu-worker activos."
  exit 1
fi

OK=0
FAIL=0
for c in "${CONTAINERS[@]}"; do
  printf "  %-50s " "$c"
  OUTPUT="$(remote_sudo "docker exec -u root ${c@Q} npm install -g ${PACKAGE_SPEC@Q} 2>&1" || true)"
  RESULT="$(printf '%s\n' "$OUTPUT" | grep -oE 'changed [0-9]+ package(s)?|up to date|added [0-9]+ package(s)?' | tail -n 1 || true)"
  if [[ -z "$RESULT" ]]; then
    echo "❌ ERROR"
    FAIL=$((FAIL + 1))
  else
    echo "✅ $RESULT"
    OK=$((OK + 1))
  fi
done

echo ""
echo "✅ OK: $OK  ❌ Fail: $FAIL  Total: $TOTAL"

# Verificar versión en un worker de muestra
SAMPLE="${CONTAINERS[0]}"
VER="$(remote_sudo "docker exec ${SAMPLE@Q} st --version" 2>/dev/null || echo "?")"
echo "🔍 Versión verificada ($SAMPLE): $VER"
