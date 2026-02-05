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
