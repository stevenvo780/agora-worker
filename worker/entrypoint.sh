#!/bin/bash
set -e

# Create service account file from environment variable if valid JSON
# Check if FIREBASE_SERVICE_ACCOUNT starts with { (naive check)
if [[ "$FIREBASE_SERVICE_ACCOUNT" == \{* ]]; then
    echo "🔑 Generating serviceAccountKey.json from ENV..."
    echo "$FIREBASE_SERVICE_ACCOUNT" > /app/serviceAccountKey.json
fi

# Start Sync Service in background if credentials exist
if [ -n "$FIREBASE_SERVICE_ACCOUNT" ] || [ -f "/app/serviceAccountKey.json" ]; then
    echo "Starting Sync Service..."
    node /app/sync_agent.js > /var/log/sync_agent.log 2>&1 &
else
    echo "No serviceAccountKey.json found. Skipping Sync Service."
fi

# Start Node Worker
echo "🚀 Starting Edu Worker..."
exec node /app/index.js
