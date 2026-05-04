# AgoraWorker

Runtime de workers por workspace y daemon host-sync.

## Partes

- `worker/`: contenedor Node que abre PTY, se registra en AgoraHub y ejecuta comandos del agente bajo whitelist.
- `worker-host-sync/`: daemon del host que sincroniza `/workspace` contra AgoraBack/MinIO/Firestore.
- `desplieges-prod/`: scripts operativos de despliegue en `stev-server`.

## Setup local

```bash
npm --prefix worker install
npm --prefix worker test
npm --prefix worker run check
```

Variables principales del worker:

- `WORKER_TOKEN`: workspace id (`workspace-...` o `personal:<uid>`).
- `WORKER_SOCKET_SECRET`: secreto HMAC compartido con Hub.
- `WORKER_SECRET`: fallback legacy si todavía no se separaron secretos.
- `NEXUS_URL`: URL de AgoraHub.

Variables principales del daemon:

- `AGORA_HUB_URL`: URL de AgoraBack para `/api/sync/worker-*`.
- `WORKER_SYNC_SECRET`: secreto HMAC para sync HTTP con AgoraBack.
- `WORKER_SECRET`: fallback legacy si todavía no se separaron secretos.
- `BASE_DIR`: base local de workspaces.
- `POLL_MS`: intervalo de sync.

## Recuperación

El daemon revive contenedores `edu-worker-*` en estado `exited`. Si Hub reinicia, los workers reconectan por socket.io y regeneran token firmado fresco en cada intento. Los comandos agente no se persisten: un restart durante ejecución devuelve timeout/error al backend y debe reintentarse.
