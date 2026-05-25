# agora-host-sync

Daemon que corre en el host de los workers (`humanizar2`, `100.98.5.11`, user `humanizar`).
Por cada contenedor `edu-worker-*` corriendo:

- Mantiene `/home/humanizar/edu-worker/workspaces/<wsId>/` espejado con la
  workspace en MinIO + AgoraBack (bidireccional).
- Revive automáticamente cualquier contenedor `edu-worker-*` que esté
  Exited (necesario porque Docker 28.2.2 crashea ocasionalmente con un
  bug de HTTP/2 y deja los workers en `hasBeenManuallyStopped=true`).
- Lee el `WORKER_TOKEN` real de cada container vía `docker inspect` para
  resolver el token correcto de workspaces personales (`personal:<uid>`),
  en lugar de usar el `wsId` crudo que causaba 500 "Owner not resolvable".

## Instalación en humanizar2

```bash
# Como root:
rsync -a --exclude=node_modules --exclude='.env*' worker-host-sync/ humanizar2:/opt/agora-host-sync/
ssh humanizar2 "cd /opt/agora-host-sync && npm install --omit=dev"
ssh humanizar2 "chown -R humanizar:humanizar /opt/agora-host-sync"

# Copiar la unit y recargar systemd:
sudo cp agora-host-sync.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agora-host-sync
```

### Variables de entorno (en /etc/agora-host-sync.env)

| Variable | Descripción | Default |
|---|---|---|
| `WORKER_SECRET` | HMAC compartido con el worker y el back | requerido |
| `WORKER_SYNC_SECRET` | Secreto dedicado para HMAC de sync HTTP | requerido |
| `NEXUS_URL` | URL de AgoraBack (Cloud Run) | `https://agora-backend-578238159459.us-central1.run.app` |
| `BASE_DIR` | Directorio raíz de workspaces locales | `/home/humanizar/edu-worker/workspaces` |
| `POLL_MS` | Intervalo de polling en ms | `5000` |
| `VERBOSE=1` | Logs detallados por archivo | — |
| `CONCURRENCY` | Workspaces en paralelo | `4` |
| `SYNC_CONCURRENCY` | Operaciones dentro de un workspace | `8` |
| `METRICS_PORT` | Puerto endpoint Prometheus | `9090` |
| `METRICS_BIND` | Bind address del endpoint | `127.0.0.1` |
| `METRICS_DISABLED=1` | Desactiva el endpoint si hay colisión | — |

> `WORKER_SECRET` debe ser **idéntico** y **sin newline** en AgoraBack, AgoraHub,
> cada worker container y este daemon. Usar `printf` (no `echo`) para setearlo.

## Deploy idempotente

```bash
cd desplieges-prod
SUDO_PASS=<pass> ./deploy_sync_daemon.sh
```

El script `desplieges-prod/deploy_sync_daemon.sh` hace rsync, `npm install --omit=dev`,
`chown`, y `systemctl restart`. Es idempotente: se puede correr múltiples veces.

## Diagnóstico

```bash
# Estado del daemon
systemctl status agora-host-sync

# Logs en tiempo real
tail -f /home/humanizar/logs/agora-host-sync.log

# Logs estructurados con jq
journalctl -u agora-host-sync -o cat | jq .

# Reinicio manual
sudo systemctl restart agora-host-sync

# Crashes del docker daemon
sudo journalctl -u docker.service | grep -iE "fatal|panic"

# Métricas Prometheus
curl http://127.0.0.1:9090/metrics
```

## Métricas expuestas

Endpoint: `curl http://127.0.0.1:9090/metrics` (formato Prometheus).

- `agora_sync_files_processed_total{op,result}` — counter por operación
  (`pull|push|del_local|del_remote`) y resultado (`ok|fail`).
- `agora_sync_bytes_total{direction}` — bytes transferidos (`up|down`).
- `agora_sync_op_duration_ms` — histograma con buckets 10/50/100/250/500/1000/2500/5000 ms.
- `agora_sync_queue_depth{wsId}` — operaciones planificadas en el último ciclo.
- `agora_sync_last_cycle_unixtime{wsId}` — timestamp del último ciclo.
- `agora_sync_last_cycle_duration_ms{wsId}` — duración del último ciclo.
- `agora_sync_workers_active` — workers detectados por `docker ps`.
- `agora_sync_cycles_total{result}` — ciclos completados (`ok|partial`).

Logs JSON estructurados por ciclo:

```json
{ "evt": "sync-cycle", "wsId": "...", "downloaded": 0, "uploaded": 1,
  "queueDepth": 4, "concurrency": 8, "cycleDurationMs": 142,
  "p50Ms": 38, "p95Ms": 95 }
```

## Módulos

| Archivo | Función |
|---|---|
| `agora-host-sync.mjs` | Orquestador principal: poll, sync, revive workers |
| `auth.mjs` | Construcción de HMAC headers para AgoraBack |
| `ignore.mjs` | Parser de `.syncignore` + patterns hard-coded |
| `metrics.mjs` | Servidor Prometheus en `METRICS_PORT` |
| `pool.mjs` | Pool de concurrencia configurable |

## Fix histórico (2026-05-25)

El daemon usaba el `wsId` crudo como token en las llamadas al back.
Los workspaces personales tienen el `WORKER_TOKEN` con prefijo `personal:<uid>`,
distinto al `wsId`. Al usar `wsId` crudo el back respondía 500 "Owner not resolvable".

Fix: `resolveWorkerToken(wsId)` lee `WORKER_TOKEN` del container vía
`docker inspect`, con caché en memoria y fallback conservador al `wsId` crudo
si `inspect` falla (evita romper shared workspaces ante un fallo puntual).
