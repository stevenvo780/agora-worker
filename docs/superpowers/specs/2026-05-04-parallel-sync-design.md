# Parallel sync + métricas en agora-host-sync

> Sub-proyecto B. Diseño de paralelización por workspace y publicación de
> métricas reales del daemon `agora-host-sync.mjs`.

## Estado actual (línea base)

- Multi-workspace ya en paralelo con `runConcurrent` (`Promise.all`),
  límite por env `CONCURRENCY` (default 4).
- Dentro de un workspace, `syncOne()` itera paths secuencialmente con
  `for...of`. Workspace con N archivos paga N latencias en serie.
- Métricas: `null` o ausentes en el heartbeat. Solo logs textuales tipo
  `wsId → ↓3 ↑1 fail:0`.
- Tracking dual `{ localHash, remoteHash }` por path. **No tocar** —
  la simplificación a hash único causó loop de re-pull histórico.
- `hashCache` por `{path, mtimeMs, size}` evita re-leer archivos grandes.
- Polling cada `POLL_MS` (default 5s). Sigue siendo polling: el cambio a
  event-driven está fuera de alcance de este sub-proyecto.

## Objetivos

1. Paralelizar uploads/downloads dentro de cada workspace con un pool
   configurable. Default 8 (`SYNC_CONCURRENCY=8`).
2. Backpressure: no saturar MinIO, no inundar el endpoint
   `/api/sync/worker-commit`. Pool acotado + manejo de errores parciales.
3. Métricas reales:
   - Logs JSON estructurados al final de cada ciclo de workspace.
   - Endpoint local Prometheus `:9090/metrics` (text format).
4. Mantener correctness: tracking dual-hash, gana-server, `.syncignore`,
   persistencia de hashes entre ciclos.

## Decisiones técnicas

### Pool de concurrencia

Implementación propia, sin `p-limit`. Razones:

- `worker-host-sync/` no tiene `package.json` ni `node_modules`. Es un
  solo `.mjs` deployado con `cp` (ver `README.md` del subdir). Añadir una
  dep arrastra todo el ecosistema npm al deploy.
- `runConcurrent` ya implementa el patrón pool con N workers
  consumiendo una cola compartida — replicable para tasks intra-workspace.

Patrón: convertir el `for...of` de `syncOne()` en una construcción de
**plan de operaciones** (push / pull / delete-local / delete-remote /
skip), seguida de un dispatcher con pool `SYNC_CONCURRENCY`.

```js
const ops = [];                        // [{kind, path, ...}]
for (const safe of allPaths) {
  // clasificar tipo de op (sin ejecutar I/O remota todavía)
  ops.push({ kind: 'pull'|'push'|'del-local'|'del-remote'|'skip', ... });
}
await runPool(ops, executeOp, SYNC_CONCURRENCY);
```

`executeOp` es la única función con I/O remota; el state se muta con
locking trivial (single-threaded JS, mutaciones a `state[safe]` y
contadores son atómicas en cuanto el `await` retorna).

### Backpressure

- Concurrency limit es la palanca primaria. Default 8 cubre el caso
  típico (10 archivos pequeños, latencia 200 ms): 8 paralelos vs 10
  serie ⇒ ~5x speedup sin saturar.
- Workspaces individuales que ya iban en paralelo siguen igual; el
  efecto es **multiplicativo** pero acotado: máx
  `CONCURRENCY × SYNC_CONCURRENCY` = 4 × 8 = 32 conexiones HTTP en vuelo.
  Mantener este product debajo de límites razonables del MinIO/Cloud Run.
- Variable `SYNC_CONCURRENCY` permite bajar a 1 (modo legacy) si se
  detecta saturación.

### Métricas

Sin libs externas. Implementación a mano de un `MetricsRegistry` con:

- **Counters**: `agora_sync_files_processed_total{op,result}` —
  `op ∈ {pull, push, del_local, del_remote, skip}`,
  `result ∈ {ok, fail}`.
- **Counters**: `agora_sync_bytes_total{direction}` —
  `direction ∈ {up, down}`.
- **Histogram light**: latencias por op en buckets fijos
  `[10, 50, 100, 250, 500, 1000, 2500, 5000, +Inf]` ms. Format Prom:
  `agora_sync_op_duration_ms_bucket{op,le}` + `_sum` + `_count`.
- **Gauges**: `agora_sync_queue_depth{wsId}`,
  `agora_sync_last_cycle_unixtime{wsId}`,
  `agora_sync_workers_active`.

Output Prometheus emitido como string desde un endpoint HTTP local
(`node:http`, sin Express). Bind a `127.0.0.1:9090` por default
(`METRICS_PORT`, `METRICS_BIND`). Loopback-only para que no haya
necesidad de auth — el puerto solo es accesible desde stev-server.

### Logs JSON

Al final de cada `syncOne()`, además del log textual existente, emitir
una línea JSON con:

```json
{ "evt": "sync-cycle", "ts": "ISO", "wsId": "...",
  "downloaded": 3, "uploaded": 1, "skipped": 12, "failed": 0,
  "bytesUp": 4096, "bytesDown": 32768,
  "p50Ms": 142, "p95Ms": 410,
  "queueDepth": 16, "concurrency": 8, "cycleDurationMs": 820 }
```

Parseable por `journalctl -o cat | jq` directo. p50/p95 por ciclo
(reset cada ciclo; las métricas Prometheus son acumuladas globales).

### Manejo de errores parciales

`runPool` ya envuelve cada task con try/catch (matchea
`runConcurrent` actual). Una operación fallida:

1. Incrementa `failed` y `agora_sync_files_processed_total{result=fail}`.
2. NO interrumpe las demás operaciones del pool.
3. NO actualiza `state[safe]` — el path quedará pendiente y se reintentará en el próximo ciclo.
4. Pasa por el `failCounter` / `shouldFailLog` existente.

## Archivos a modificar

- `worker-host-sync/agora-host-sync.mjs`: refactor de `syncOne()` a
  fase plan + fase ejecución con pool. Wire de métricas.
- `worker-host-sync/metrics.mjs` (nuevo): registry minimalista
  Prometheus-compatible.
- `worker-host-sync/pool.mjs` (nuevo): pool genérico
  `runPool(items, fn, limit)` reutilizable. Reemplaza la copia inline.
- `worker-host-sync/README.md`: documentar nuevas envs y endpoint.
- `worker/tests/host-sync-pool.test.mjs` (nuevo): tests para pool y
  registry.
- `worker-host-sync/agora-host-sync.service`: opcional, agregar
  `Environment=METRICS_PORT=9090` con comentario.

## Riesgos

- **Concurrencia x32 puede saturar MinIO** si el pool combinado va alto.
  Mitigación: defaults conservadores (8 × 4 = 32) y env tunables.
- **State mutation race**: como JS es single-threaded entre awaits, las
  mutaciones a `state[safe]` y contadores son seguras siempre que cada
  task toque un path distinto. Lo garantizamos: el plan se construye
  con el `Set` `allPaths`, así cada task tiene su `safe` único.
- **Caché de hashes en disco**: `hashCache` es in-memory, no toca
  disco. Tracking persistente (`.agora-host-sync.json`) sigue con el
  mismo formato dual. **No requiere migración**.
- **Endpoint :9090 colisión**: si stev-server ya usa el puerto, fallar
  con log claro. Default loopback minimiza riesgo cross-host.

## Plan de tests

- `pool.test.mjs`: límite de concurrencia respetado, errores parciales
  no tiran el pool, ordenamiento FIFO de tasks.
- `metrics.test.mjs`: counters, histogram buckets, output Prometheus
  válido (regex de format).
- Smoke local: spawn del daemon contra mock HTTP que pretende ser
  AgoraBack, validar que las métricas suben.

## Validación local sin desplegar

Mock con `node:http` actuando como AgoraBack:
- `/api/sync/worker-list` retorna lista fija de N items.
- `/api/sync/worker-upload-url` retorna signedUrl que apunta al mismo
  mock con `PUT` aceptado.
- `/api/sync/worker-commit` retorna `{ created: true, version: 1 }`.

Daemon arrancado con `BASE_DIR=/tmp/host-sync-smoke` y `AGORA_HUB_URL=http://127.0.0.1:8080`.
Curl a `http://127.0.0.1:9090/metrics` debe mostrar contadores != 0.
