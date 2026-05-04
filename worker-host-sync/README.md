# agora-host-sync

Daemon que corre en el host de los workers (`stev-server`). Por cada
contenedor `edu-worker-*` corriendo:

- Mantiene `/home/stev/edu-worker/workspaces/<wsId>/` espejado con la
  workspace en MinIO + Firestore (bidireccional).
- Revive automáticamente cualquier contenedor `edu-worker-*` que esté
  Exited (necesario porque Docker 28.2.2 crashea ocasionalmente con un
  bug de HTTP/2 y deja los workers en `hasBeenManuallyStopped=true`).

## Instalación en stev-server

```bash
# Como user `stev`:
mkdir -p ~/bin ~/logs
cp agora-host-sync.mjs auth.mjs ignore.mjs pool.mjs metrics.mjs ~/bin/

# Como root:
sudo cp agora-host-sync.service /etc/systemd/system/
sudo mkdir -p /etc/systemd/system/agora-host-sync.service.d
sudo tee /etc/systemd/system/agora-host-sync.service.d/secret.conf > /dev/null <<EOF
[Service]
Environment=WORKER_SECRET=<el WORKER_SECRET compartido del host>
Environment=WORKER_SYNC_SECRET=<el secreto dedicado de sync HTTP>
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now agora-host-sync
```

## Diagnóstico

- Logs: `~/logs/agora-host-sync.log`
- Estado: `systemctl status agora-host-sync`
- Reinicio manual: `sudo systemctl restart agora-host-sync`
- Crashes de docker daemon: `sudo journalctl -u docker.service | grep -iE "fatal|panic"`

## Configuración

Variables de entorno opcionales:
- `AGORA_HUB_URL` — default Cloud Run de AgoraBack
- `WORKER_SYNC_SECRET` — secreto dedicado para HMAC contra AgoraBack.
- `WORKER_SECRET` — fallback legacy durante rotación.
- `BASE_DIR` — default `/home/stev/edu-worker/workspaces`
- `POLL_MS` — default `5000`
- `VERBOSE=1` — logs detallados por archivo
- `CONCURRENCY` — workspaces en paralelo, default `4`
- `SYNC_CONCURRENCY` — operaciones (push/pull/delete) en paralelo
  dentro de un workspace, default `8`. Bajar a `1` recupera el modo
  legacy secuencial.
- `METRICS_PORT` — puerto del endpoint Prometheus, default `9090`
- `METRICS_BIND` — bind address, default `127.0.0.1` (loopback)
- `METRICS_DISABLED=1` — apaga el endpoint si hay colisión de puerto

## Métricas

Endpoint: `curl http://127.0.0.1:9090/metrics` (formato Prometheus).

Métricas expuestas:

- `agora_sync_files_processed_total{op,result}` — counter por operación
  (`pull|push|del_local|del_remote`) y resultado (`ok|fail`).
- `agora_sync_bytes_total{direction}` — bytes transferidos
  (`up|down`).
- `agora_sync_op_duration_ms` — histograma con buckets `10/50/100/250/
  500/1000/2500/5000` ms.
- `agora_sync_queue_depth{wsId}` — operaciones planificadas en el
  último ciclo por workspace.
- `agora_sync_last_cycle_unixtime{wsId}` — timestamp del último ciclo
  por workspace.
- `agora_sync_last_cycle_duration_ms{wsId}` — duración del último
  ciclo por workspace.
- `agora_sync_workers_active` — workers detectados por docker ps.
- `agora_sync_cycles_total{result}` — ciclos completados (`ok|partial`).

Logs JSON estructurados por ciclo (parseable con `journalctl -o cat | jq`):

```json
{ "evt": "sync-cycle", "wsId": "...", "downloaded": 0, "uploaded": 1,
  "queueDepth": 4, "concurrency": 8, "cycleDurationMs": 142,
  "p50Ms": 38, "p95Ms": 95 }
```
