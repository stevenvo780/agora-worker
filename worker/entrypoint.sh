#!/bin/bash
set -e

# Sync Agent Authentication:
# - Worker connects to Hub with signed HMAC token (WORKER_SECRET)
# - Hub verifies and issues Firebase Custom Token
# - No serviceAccountKey.json needed in workers (secure architecture)

echo "🚀 Starting Edu Worker..."
echo "🔌 Worker Configuration:"
echo "   Hub URL: ${NEXUS_URL:-http://localhost:3010}"
echo "   Token: ${WORKER_TOKEN:-<not set>}"

# ── Create default .syncignore and repos/ if missing ──────────────
WORKSPACE_DIR="/workspace"
SYNCIGNORE_FILE="${WORKSPACE_DIR}/.syncignore"
REPOS_DIR="${WORKSPACE_DIR}/repos"

if [ ! -f "$SYNCIGNORE_FILE" ]; then
    echo "📋 Creating default .syncignore..."
    cat > "$SYNCIGNORE_FILE" << 'SYNCIGNORE'
# ── .syncignore ──────────────────────────────────────────────
# Archivos y carpetas listados aquí NO se sincronizan con la nube.
# Uno por línea. Líneas vacías y comentarios (#) se ignoran.
# Usa nombre/ para carpetas, *.ext para extensiones.
# ──────────────────────────────────────────────────────────────

# Carpeta de repositorios locales (nunca sincronizar)
repos

# Build artifacts & caches
__pycache__
*.pyc
*.o
*.so
dist
build
target
*.class
*.jar

# Paquetes pesados (ya están en IGNORE_LIST por defecto)
# node_modules
# .git
# .next
SYNCIGNORE
    echo "   ✅ .syncignore creado con valores por defecto"
fi

if [ ! -d "$REPOS_DIR" ]; then
    mkdir -p "$REPOS_DIR"
    echo "   ✅ Carpeta repos/ creada"
fi
# ── end .syncignore setup ─────────────────────────────────────────

# Determine workspace type from token
if [[ "$WORKER_TOKEN" == personal:* ]]; then
    echo "   Type: personal"
    echo "   Workspace ID: $WORKER_TOKEN"
else
    echo "   Type: shared"
    echo "   Workspace ID: $WORKER_TOKEN"
fi

# Start Sync Agent in background (auth via Hub Custom Token)
if [ -n "$WORKER_SECRET" ] && [ -n "$WORKER_TOKEN" ]; then
    echo "📡 Starting Sync Agent..."
    LOG_PATH="${SYNC_AGENT_LOG:-/var/log/sync_agent.log}"
    if ! (mkdir -p "$(dirname "$LOG_PATH")" && touch "$LOG_PATH" 2>/dev/null); then
        LOG_PATH="${SYNC_AGENT_LOG:-${HOME:-/home/estudiante}/sync_agent.log}"
        mkdir -p "$(dirname "$LOG_PATH")" 2>/dev/null || true
        touch "$LOG_PATH" 2>/dev/null || true
    fi
    node /app/sync_agent.js 2>&1 | tee "$LOG_PATH" &
else
    echo "⚠️  WORKER_SECRET or WORKER_TOKEN not set. Sync Agent disabled."
fi

# Start main Worker process
exec node /app/index.js
