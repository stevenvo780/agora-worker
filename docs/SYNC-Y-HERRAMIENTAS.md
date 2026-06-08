# SYNC Y HERRAMIENTAS — Workers y Agentes IA en Agora

Cómo el `/workspace` de cada worker se mantiene sincronizado con la nube, y cómo las tools del agente IA interactúan con ese filesystem.

---

## 1. Arquitectura general

```
Agente IA (AgoraBack)
   │  tools: run_worker_command, write_worker_file, read_worker_file, …
   ▼
AgoraHub (hub.elenxos.com, socket.io)
   │  eventos: agent-command, session-created, execute, …
   ▼
Worker Docker (edu-worker-<wsId> en ils-server)
   │  /workspace  ←→  montado como volumen en host
   ▼
/home/humanizar/edu-worker/workspaces/<wsId>/   (host ils-server)
   ▲
   │  daemon agora-host-sync (bidireccional)
   ▼
AgoraBack /api/sync/*  →  MinIO (s3.elenxos.com, bucket agora-blobs)
                        →  Firestore (documents/{wsId}/…)
```

**Source of truth**: el servidor (MinIO + Firestore). Si hay conflicto, el servidor gana.

---

## 2. Daemon agora-host-sync — ciclo de sincronización

El daemon corre en `ils-server` como servicio systemd con el usuario `humanizar`. Ve todos los containers `edu-worker-*` activos y sincroniza cada uno en paralelo.

### 2.1 Loop principal

```
cada POLL_MS ms (default 30 000 ms = 30 s):
  1. Revive containers edu-worker-* parados (docker start).
  2. Lista containers activos (docker ps --filter name=edu-worker-).
  3. Por cada wsId, lanza syncOne(wsId) con concurrencia CONCURRENCY (default 4).
  4. Espera POLL_MS y repite.
```

### 2.2 syncOne(wsId) — un ciclo por workspace

Dentro de cada ciclo el daemon:

1. **Resuelve el token real** del worker via `docker inspect edu-worker-<wsId>` para leer `WORKER_TOKEN`. Los workspaces personales llevan prefijo `personal:<uid>` que el crudo `wsId` no contiene.

2. **Decide si es full-reconcile o incremental**.  
   Cada `FULL_RECONCILE_EVERY` (default 5) ciclos usa `since=0` (scan completo). El resto usa `since=<último updatedAt visto>` para reducir lecturas Firestore.

3. **Pagina `/api/sync/worker-list`** hasta agotar el cursor. Si la paginación excede `MAX_PAGES=1000`, aborta el ciclo (el remoto estaría incompleto; continuar dispararía borrados falsos).

4. **Walk local** (`walkLocal`): lista todos los archivos en `/home/humanizar/edu-worker/workspaces/<wsId>/`, calculando sha256 de cada uno. Usa caché por `(path, mtimeMs, size)` para no releer archivos sin cambios.

5. **Lee `.agora-host-sync.json`** (state): registra `{ localHash, remoteHash }` por cada path conocido.

6. **Lee `.syncignore`** del workspace (si existe) y lo combina con los patrones built-in.

7. **buildPlan**: clasifica cada path en una operación (`pull`, `push`, `del-local`, `del-remote`, `noop`, `skip`, `ignore`, `forget`).

8. **Ejecuta el plan** con concurrencia `SYNC_CONCURRENCY` (default 8) usando `runPool`.

9. **Escribe `.agora-host-sync.json`** actualizado.

### 2.3 Decisiones del plan (prioridad en orden)

| Condición | Operación | Explicación |
|-----------|-----------|-------------|
| Path en HARD_SKIP | `skip` | Nunca se toca (`.git/`, `.agora-host-sync.json`, etc.) |
| Ignorado por reglas | `ignore` | Se purga del remoto si existe allí; se borra localmente |
| Remote nuevo o remoteChanged | `pull` | Servidor gana siempre |
| Remote borrado + local existe + full-reconcile | `del-local` | El borrado web llega al worker solo en full-scan |
| Local nuevo o localChanged | `push` | Sube al servidor |
| Local borrado + remote existe | `del-remote` | Propaga el borrado al servidor |
| Sin cambios | `noop` | Actualiza state con hashes actuales |
| Ni local ni remoto | `forget` | Limpia state |

**Nota crítica sobre `del-local`**: solo corre en full-reconcile (since=0) porque en ciclos incrementales el remoto es parcial y la ausencia de un path NO implica borrado. Sin full-reconcile periódico, un borrado hecho en la web nunca llegaría al worker.

### 2.4 Operaciones HTTP

| Operación | Endpoint | Método |
|-----------|----------|--------|
| Listar docs remotos | `/api/sync/worker-list?workspaceId=&since=&cursor=` | GET |
| Obtener URL de upload | `/api/sync/worker-upload-url` | POST |
| Confirmar upload | `/api/sync/worker-commit` | POST |
| Borrar remoto | `/api/sync/worker-delete` | POST |

Autenticación HMAC en cada request (ver sección 4).

### 2.5 Almacenamiento remoto

- **MinIO**: los blobs van a `workspaces/<wsId>/<repoPath>` en el bucket `agora-blobs` (s3.elenxos.com).
- **Firestore**: metadatos en `documents/{wsId}/...` — `repoPath`, `contentHash`, `size`, `mimeType`, `updatedAt`.

---

## 3. Qué se sincroniza y qué no

### 3.1 HARD_SKIP — nunca se toca (código en `ignore.mjs`)

Estos paths/prefijos son ignorados incondicionalmente por el daemon, en ambas direcciones. No aparecen en ningún plan.

| Pattern | Razón |
|---------|-------|
| `.git/` | Historial git del workspace — independiente del sync MinIO |
| `repos/` | Repos git externos vinculados (isomorphic-git) |
| `.agora-host-sync.json` | State interno del daemon — no debe propagarse |
| `.st-guide.md` | Guía generada localmente por el runtime ST |
| `.scratch/` | Directorio de trabajo efímero para el agente IA y el usuario (Bug I-2: antes se purgaba ~10s después de crearse) |
| `.agent-tmp/` | Misma convención: archivos temporales del agente |

### 3.2 Patrones built-in (siempre activos, sin `.syncignore`)

Temporales de editores y prefijos de scratch que nunca deben llegar a MinIO:

```
*.swp  *.swo  *.swn      # vim swap
*~                        # backups de editores
.~lock.*  .#*             # LibreOffice y Emacs locks
.DS_Store  Thumbs.db  desktop.ini
tmp-*                     # prefijo scratch del agente IA y usuario
*.tmp
```

### 3.3 `.syncignore` — reglas editables por el usuario

El archivo `.syncignore` en la raíz del workspace se sincroniza normalmente (nunca se ignora a sí mismo). Acepta sintaxis estilo `.gitignore`:

```
# Ejemplo .syncignore
node_modules/
dist/
*.log
build/
.env.local
```

El `.gitignore` también se sincroniza siempre. Las reglas del `.syncignore` se combinan con los patrones built-in (built-ins tienen prioridad en el matching).

### 3.4 Qué SÍ se sincroniza

- Cualquier archivo en `/workspace` que no caiga en las reglas anteriores.
- El propio `.syncignore` y `.gitignore`.
- Archivos binarios (PDFs, imágenes): viajan como `application/octet-stream`.
- Subdirectorios arbitrarios (el walk es recursivo).

### 3.5 Guía para crear archivos que sí se sincronicen

- Guardar en `/workspace` (o subdirectorios bajo `/workspace`).
- Evitar nombres con prefijo `tmp-` o extensión `.tmp` si se quiere que persistan.
- Evitar `.scratch/` y `.agent-tmp/` para archivos que deben subir al servidor.
- No usar `sudo`; los archivos deben ser accesibles por el usuario `estudiante` del container.

---

## 4. Autenticación HMAC

Cada request HTTP del daemon a AgoraBack lleva tres headers:

| Header | Contenido |
|--------|-----------|
| `X-Worker-Token` | `wsId` (o `personal:<uid>` para workspaces personales) |
| `X-Worker-Ts` | Timestamp Unix ms actual |
| `X-Worker-Sig` | HMAC-SHA256 de `"<wsId>:<ts>"` (o `"<wsId>:<ts>:<uid>"` si personal) con `WORKER_SYNC_SECRET` |
| `X-Worker-Uid` | UID del usuario (solo para workspaces personales) |

El timestamp debe estar dentro de ±5 minutos del tiempo del servidor (protección anti-replay). Si el reloj del host se desfasa, los workers empiezan a recibir 401 en silencio.

`WORKER_SECRET` debe ser idéntico (y sin newlines) en: AgoraBack, AgoraHub, cada container worker y el daemon. Usar `printf` (no `echo`) para setearlo.

---

## 5. Tools del agente IA y su relación con el filesystem

### 5.1 Tools de worker (requieren capability `workerRead` o `workerCommand`)

El agente se comunica con el worker vía AgoraHub usando eventos socket.io.

| Tool agente | Evento Hub | Cómo funciona | Capability |
|-------------|-----------|---------------|------------|
| `run_worker_command` | `agent-command` | Ejecuta comando en `/workspace` via `exec()` (no PTY). Resultado en `agent-command-result`. | `workerCommand` |
| `read_worker_file` | `agent-command` | Internamente usa `head -c <N> <path>` via `run_worker_command`. | `workerRead` |
| `write_worker_file` | `agent-command` | Codifica el contenido en base64 y ejecuta `echo <b64> \| base64 -d > <path>`. Crea directorios padre. | `workerCommand` |
| `list_worker_files` | `agent-command` | Ejecuta `find <path> -maxdepth N -ls` o similar. | `workerRead` |
| `tail_worker_logs` | `agent-command` | `tail -n <N> <path>` | `workerRead` |
| `kill_worker_process` | `agent-command` | `kill -<SIG> <pid>` | `workerCommand` |
| `get_worker_status` | directo via Hub | Consulta heartbeat del worker. | `workerRead` |
| `sync_status` | AgoraBack | Consulta docs Firestore + estado Git. No toca el worker directamente. | `workerRead` |

### 5.2 Whitelist de binarios (agent-command-policy.mjs)

El handler `agent-command` en el worker valida que el primer token de cada segmento del comando esté en la whitelist. Comandos bloqueados retornan `binary "x" no está en la whitelist del agente`.

**Binarios permitidos**:
```
# Lectura/exploración
ls  pwd  cat  echo  head  tail  wc  grep  find  sort  uniq
cut  awk  sed  tr  tee  diff  stat  file  date
whoami  id  hostname  uname  uptime  df  free  env

# Modificación de filesystem
mkdir  touch  cp  mv  rm  ln  base64

# Desarrollo
git  node  npm  pnpm  npx  yarn
python  python3  pip  pip3
curl  wget
tree  jq  tsc  eslint  prettier

# Otros
true  false
```

**Siempre prohibidos** (sin importar whitelist):
- `sudo`, `su`, `passwd`, `mkfs`, `fdisk`, `mount`, `umount`, `shutdown`, `reboot`, `poweroff`
- `chmod +s` (setuid)
- `rm /`, `rm ~`, `rm $HOME`, `rm /*` (borrado de raíz o home)

**Prohibiciones de shell**:
- Expansión de comandos: `$()`, `` ` ``, `<()`, `>()`
- Redirección fuera de `/workspace` o `/tmp/agora-tmp`: `> /etc/…` falla; `> /workspace/out.txt` pasa.
- Encadenamiento con `|`, `&&`, `;`, `||` está permitido, pero cada segmento se valida por separado.

**Límites**:
- Comando máximo: 4000 bytes
- Timeout: 1 000–25 000 ms (default 15 000 ms)
- Output máximo: hasta 20 000 bytes (default 12 000)

### 5.3 Sesiones PTY interactivas (terminal web)

Separadas del `agent-command`. El usuario abre una terminal en la web; el Hub enruta al worker via eventos `session-created`/`execute`/`resize`/`end-session`.

- El PTY arranca en `/workspace` con `TERM=xterm-256color`.
- El input soporta todos los controles C0 (Ctrl-C, Ctrl-D, flechas, `0x7f` = Backspace xterm).
- Rate limit: 1 MB/s de output por sesión (evita floods de output masivo).
- Idle timeout: 30 minutos sin input mata la sesión.
- Máximo 50 sesiones simultáneas por worker (elimina la más idle si se excede).
- Gracia ante reconexión: si el Hub se desconecta, los PTYs sobreviven 180 segundos (`WORKER_PTY_GRACE_MS`) para que socket.io reconecte.

### 5.4 Flujo write_worker_file → sync

Cuando el agente escribe un archivo via `write_worker_file`:

```
1. AgoraBack llama al Hub via socket.io (agent-command)
2. Worker ejecuta: echo <base64> | base64 -d > /workspace/<path>
3. El archivo queda en disco en el container (volumen montado en host)
4. En el próximo ciclo del daemon (≤30s), walkLocal detecta el archivo nuevo
   o el cambio de hash → plan: push
5. Daemon llama /api/sync/worker-upload-url → obtiene presigned URL de MinIO
6. Daemon hace PUT al presigned URL → blob en MinIO
7. Daemon llama /api/sync/worker-commit → Firestore actualiza metadatos
```

Resultado: el archivo escrito por el agente aparece en la web en ≤30 s + latencia de red.

### 5.5 Flujo update_document (editor web) → worker

Cuando el usuario guarda un documento en el editor web:

```
1. AgoraBack escribe en MinIO + actualiza Firestore (updatedAt = now)
2. En el próximo ciclo del daemon, worker-list devuelve el doc con updatedAt nuevo
3. daemon detecta remoteChanged → plan: pull
4. Daemon descarga desde presigned URL del blob
5. Escribe el archivo en /home/humanizar/edu-worker/workspaces/<wsId>/<path>
6. Actualiza state: { localHash: sha256(buf), remoteHash: contentHash }
```

Resultado: el archivo aparece en el terminal/worker en ≤30 s.

---

## 6. CLI `agora` dentro del worker

El CLI está disponible como `agora` en el container worker (vendored en `/app/agora-cli/`). Cubre sincronización vía **Git/Forgejo**, complementaria al sync MinIO.

Cada workspace tiene un repo Forgejo en `git.elenxos.com` (organización `agora`):
- Shared workspace: `agora/<wsId>`
- Personal: `agora/personal-<uid>`

### Comandos

| Comando | Qué hace |
|---------|----------|
| `agora login` | Guarda ID token Firebase + URL del API en `~/.agora/config.json` (chmod 600). |
| `agora logout` | Borra `~/.agora/config.json`. |
| `agora status [dir]` | Estado login + `git status` del workspace. |
| `agora workspaces` | Lista workspaces accesibles del usuario autenticado. |
| `agora clone <wsId> [dir]` | `git clone` del repo Forgejo. Configura `agora.workspaceId` y `agora.apiUrl` en `.git/config`. |
| `agora init <dir>` | Convierte dir existente en workspace (añade remote Forgejo, configura `agora.workspaceId`). |
| `agora pull [dir]` | `git pull --rebase --autostash` |
| `agora push [dir] [-m MSG]` | `git add -A` + `git commit -m MSG` + `git push` |
| `agora watch [dir]` | Loop de pull + autocommit + push cada 30 s. |

### Provisionamiento de repo

`agora clone` y `agora init` llaman a `/api/workspaces/<wsId>/git-info`. Si el repo no existe, llaman a `/api/workspaces/<wsId>/provision-git` (POST) para crearlo y devuelven el token inicial de Forgejo (se muestra solo una vez).

### Diferencia entre sync MinIO y sync Git

| | Sync MinIO (daemon) | Sync Git (CLI agora) |
|--|--------------------|-----------------------|
| Automático | Sí (cada POLL_MS) | No (manual o via `watch`) |
| Binarios | Sí | Depende de `.gitattributes` |
| Historial | No | Sí (commits) |
| Conflictos | Server wins | Git merge / rebase |
| Quién lo usa | Daemon del host | Usuario / agente vía tools `git_*` |

Las tools `git_commit_workspace`, `git_pull`, `git_push_branch`, etc. del agente IA usan este mismo repo Forgejo (vía worker terminal).

---

## 7. Pitfalls comunes y cómo resolverlos

### P1: Un borrado en la web no llega al worker

**Causa**: `del-local` solo corre en full-reconcile (ciclos múltiplos de `FULL_RECONCILE_EVERY=5`). Los primeros 4 ciclos tras el borrado son incrementales y no propagan el borrado.

**Esperar**: hasta 5 ciclos × 30 s = ≈2.5 minutos para que el borrado llegue.

**Forzar**: reiniciar el daemon reinicia los contadores de ciclo, disparando un full-reconcile inmediato:
```bash
ssh ils-server 'sudo systemctl restart agora-host-sync'
```

### P2: Un archivo escrito localmente no aparece en la web

**Verificar**:
1. ¿Está en `/workspace`? (no en `/home`, `/tmp` u otras rutas fuera del volumen)
2. ¿El nombre cae en algún patrón ignorado? (`tmp-`, `.tmp`, `.scratch/`, etc.)
3. ¿El daemon está corriendo?
```bash
ssh ils-server 'sudo systemctl status agora-host-sync'
ssh ils-server 'sudo tail -20 /home/humanizar/logs/agora-host-sync.log'
```

### P3: 401 en silencio — sync deja de funcionar

**Causa más frecuente**: `WORKER_SYNC_SECRET` no coincide entre daemon y AgoraBack, o tiene newline.

**Verificar**:
```bash
ssh ils-server 'sudo grep WORKER_SYNC_SECRET /etc/agora-host-sync.env | wc -c'
# el valor debe no tener '\n' al final
```

También puede ser desfase de reloj (`X-Worker-Ts` fuera de ±5 min del servidor):
```bash
ssh ils-server 'date'
date  # comparar con hora local
```

### P4: El daemon corre pero no encuentra el worker

**Síntoma**: logs dicen `workers activos: 0`.

**Verificar**:
```bash
ssh ils-server 'sudo docker ps --filter name=edu-worker --format "{{.Names}}\t{{.Status}}"'
```

Si el container está `Exited`, el daemon debería haberlo reactivado automáticamente en el mismo ciclo. Si no, revisar logs de docker:
```bash
ssh ils-server 'sudo docker inspect edu-worker-<wsId> --format "{{.State.ExitCode}} OOM:{{.State.OOMKilled}}"'
ssh ils-server 'sudo docker start edu-worker-<wsId>'
```

### P5: Workspace personal da 500 "Owner not resolvable"

**Causa**: el daemon estaba usando el `wsId` crudo como token. Los workspaces personales necesitan `personal:<uid>`.

**Verificar** que el daemon resuelve bien el token:
```bash
ssh ils-server 'sudo docker inspect edu-worker-<uid> --format "{{range .Config.Env}}{{println .}}{{end}}"' | grep WORKER_TOKEN
# debe mostrar: WORKER_TOKEN=personal:<uid>
```

Si no muestra el token correcto, el container fue creado sin `WORKER_TOKEN` — recrearlo con `edu-worker-manager add <wsId>`.

### P6: Archivo grande queda en push fail repetido

**Causa**: el circuit breaker silencia el error tras 3 fallos consecutivos (logs cada 30 ciclos). El blob podría estar corrupto en MinIO o exceder el límite del presigned URL.

**Diagnosticar**:
```bash
ssh ils-server 'sudo grep "push fail" /home/humanizar/logs/agora-host-sync.log | tail -20'
```

**Forzar resync de un archivo específico**: borrar su entrada del state y reiniciar el daemon.
```bash
# En el host:
cat /home/humanizar/edu-worker/workspaces/<wsId>/.agora-host-sync.json | jq 'del(."<repoPath>")' > /tmp/state.json
cp /tmp/state.json /home/humanizar/edu-worker/workspaces/<wsId>/.agora-host-sync.json
sudo systemctl restart agora-host-sync
```

---

## 8. Cómo verificar consistencia

### 8.1 Estado rápido desde el agente IA

```json
{ "name": "sync_status", "args": {} }
```

Devuelve: docs en Firestore, worker conectado, estado Git.

```json
{ "name": "get_document_sync_state", "args": { "documentId": "<id>" } }
```

Devuelve: `synced | storage-only | firestore-only | empty`.

### 8.2 Desde el terminal del worker

```bash
# Ver qué hay en /workspace
ls -la /workspace

# Comparar con el state del daemon (en host, no en container)
# → realmente hay que verlo en el host:
```

```bash
# En ils-server:
cat /home/humanizar/edu-worker/workspaces/<wsId>/.agora-host-sync.json | python3 -m json.tool | head -40
```

### 8.3 Logs del daemon en tiempo real

```bash
ssh ils-server 'sudo tail -f /home/humanizar/logs/agora-host-sync.log'
```

Línea típica de ciclo activo:
```
[2026-06-08T12:00:05.123Z] <wsId> → ↓2 ↑1 (3 nuevos) skip:14 fail:0 (142ms)
```

Línea de ciclo sin cambios (solo con `VERBOSE=1`):
```
[2026-06-08T12:00:35.456Z] <wsId> → al día (38ms)
```

### 8.4 Métricas Prometheus (en ils-server)

```bash
ssh ils-server 'curl -s http://127.0.0.1:9090/metrics | grep agora_sync'
```

Métricas clave:
- `agora_sync_last_cycle_unixtime{wsId="..."}` — timestamp del último ciclo (debe ser reciente)
- `agora_sync_files_processed_total{op="push",result="fail"}` — contador de fallos de push
- `agora_sync_workers_active` — workers detectados (debe > 0 si hay containers)

### 8.5 Consultar MinIO directamente

```bash
# Desde agora-storage (Hostinger VPS):
ssh root@76.13.118.239 'docker compose -f /opt/agora-stack/docker-compose.yml exec agora-minio mc ls --recursive adm/agora-blobs/workspaces/<wsId>/ | head -20'
```

### 8.6 Forzar resync completo

Reiniciar el daemon reinicia `lastSyncMs` y `reconcileCounter` en memoria, disparando un full-reconcile en el primer ciclo:

```bash
ssh ils-server 'sudo systemctl restart agora-host-sync'
# Monitorear:
ssh ils-server 'sudo tail -f /home/humanizar/logs/agora-host-sync.log'
```

---

## 9. Variables de entorno del daemon

Archivo: `/etc/agora-host-sync.env` en ils-server.

| Variable | Default | Descripción |
|----------|---------|-------------|
| `WORKER_SYNC_SECRET` | requerido | HMAC para requests HTTP al back |
| `WORKER_SECRET` | fallback de `WORKER_SYNC_SECRET` | Legacy |
| `NEXUS_URL` | `https://agora-backend-578238159459.us-central1.run.app` | URL de AgoraBack |
| `BASE_DIR` | `/home/humanizar/edu-worker/workspaces` | Raíz de workspaces en host |
| `POLL_MS` | `30000` | Intervalo de polling (ms) |
| `CONCURRENCY` | `4` | Workspaces en paralelo por ciclo |
| `SYNC_CONCURRENCY` | `8` | Operaciones paralelas dentro de un workspace |
| `FULL_RECONCILE_EVERY` | `5` | Ciclos entre full-reconcile |
| `VERBOSE` | — | `1` para logs por archivo |
| `METRICS_PORT` | `9090` | Puerto Prometheus (loopback) |
| `METRICS_BIND` | `127.0.0.1` | Bind del endpoint de métricas |
| `METRICS_DISABLED` | — | `1` para desactivar métricas |

---

## 10. Referencias

| Archivo | Contenido |
|---------|-----------|
| `worker-host-sync/agora-host-sync.mjs` | Daemon principal: loop, syncOne, buildPlan, executeOp |
| `worker-host-sync/ignore.mjs` | HARD_SKIP, built-in rules, parser de .syncignore |
| `worker-host-sync/auth.mjs` | Construcción de HMAC headers |
| `worker-host-sync/pool.mjs` | Pool de concurrencia configurable |
| `worker-host-sync/metrics.mjs` | Servidor Prometheus |
| `worker-host-sync/agora-host-sync.service` | Unit systemd |
| `worker/index.js` | Entry point del worker: PTY, agent-command, socket.io |
| `worker/agent-command-policy.mjs` | Whitelist de binarios y validaciones de seguridad |
| `worker/agora-cli/src/index.mjs` | CLI `agora` (git sync via Forgejo) |
| `desplieges-prod/deploy_sync_daemon.sh` | Deploy idempotente del daemon a ils-server |
| `docs/AGENT_TOOLS_API.md` (workspace raíz) | Catálogo completo de 145 tools del agente IA |
| `CLAUDE.md` (workspace raíz) | Reglas críticas de arquitectura (RTDB, WORKER_SECRET, etc.) |
