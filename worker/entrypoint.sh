#!/bin/bash
set -e

# Check for Firebase credentials
# Priority: GOOGLE_APPLICATION_CREDENTIALS env var (mounted file)
CREDS_FILE="${GOOGLE_APPLICATION_CREDENTIALS:-/app/serviceAccountKey.json}"

if [ -f "$CREDS_FILE" ]; then
    echo "🔑 Using Firebase credentials from: $CREDS_FILE"
    export GOOGLE_APPLICATION_CREDENTIALS="$CREDS_FILE"
    
    # Start Sync Service in background
    echo "Starting Sync Service..."
    node /app/sync_agent.js > /var/log/sync_agent.log 2>&1 &
else
    echo "⚠️  No Firebase credentials found. Skipping Sync Service."
    echo "   Expected at: $CREDS_FILE"
fi

# Start Node Worker
echo "🚀 Starting Edu Worker..."
exec node /app/index.js
