FROM node:22-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app
COPY *.mjs ./

ENV BASE_DIR=/data/workspaces \
    NEXUS_URL=https://agora-backend-578238159459.us-central1.run.app \
    POLL_MS=30000 \
    METRICS_BIND=0.0.0.0 \
    METRICS_PORT=9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:9090/health >/dev/null || exit 1

ENTRYPOINT ["node", "agora-host-sync.mjs"]
