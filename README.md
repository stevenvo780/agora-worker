# AgoraWorker

Runtime de workers por workspace y daemon host-sync. En producción
corren 40 containers `edu-worker-<wsId>` en `vps-humanizar-2`
(`100.64.0.11`, pública `167.114.118.213`).
Todos apuntan al hub vía `NEXUS_URL=https://hub.elenxos.com`.

> **Operación / restart / docker daemon crashes**: ver [`../RUNBOOK_OPS.md §3, §12`](../RUNBOOK_OPS.md).
> **Detalle arquitectura/secrets**: `../CLAUDE.md` (raíz workspace).

## Partes

- `worker/`: contenedor Node que abre PTY, se registra en AgoraHub y ejecuta comandos del agente bajo whitelist (~40 binarios seguros, incluye `base64` agregado en 2026-05). El handler `runWorkerCommand` aplica una policy tri-tier: destructivos siempre piden confirm, safe-reads ejecutan directo, resto requiere confirm.
- `worker-host-sync/`: contenedor `agora-host-sync` que sincroniza `/workspace` contra AgoraBack/MinIO/Firestore cada 5s y revive containers caídos. Ignora `.scratch/`, `.agent-tmp/`, `tmp-*`, `*.tmp` (Bug I-2 Opción B).
- `desplieges-prod/`: scripts operativos de despliegue (`deploy_hub.sh`, `deploy_docker.sh`, `update_st_workers.sh`).

## Comportamiento conocido

- El handler `agent-command` ya **no** prepende `cd` a los comandos
  del agente IA (`worker.ts:489-585`). El cwd queda automáticamente
  en `/workspace`. Si el agente quiere cambiar de directorio, debe
  usar la ruta absoluta en el comando.
- `runWorkerCommand` tri-tier policy:
  - **destructivos** (`rm`, `mv`, `truncate`, etc.) → siempre piden confirm
  - **safe-reads** (`ls`, `cat`, `head`, `tail`, `pwd`, etc.) → ejecutan directo
  - **resto** → requiere confirm explícito del user via UI

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

## Despliegue

### Imagen del worker

```bash
cd worker
docker build -t stevenvo780/edu-worker:latest .
docker push stevenvo780/edu-worker:latest

# Producción ya no usa edu-worker-manager ni ils-server.
# Ver docs/RUNTIME-PROD-2026-08-25.md antes de hacer el rollout.
```

### Contenedor agora-host-sync

```bash
docker build -t agora-host-sync:local worker-host-sync/
# El rollout productivo conserva los mounts/env/restart policy existentes.
# Ver docs/RUNTIME-PROD-2026-08-25.md.
```

Cada worker se reconecta al hub en <5s tras recreación.

## Instalación en Fedora / RHEL / CentOS

Fedora usa Podman por defecto (CLI compatible con Docker). El script de instalación detecta tu distro automáticamente y elige `docker` o `podman`.

### Opción A — Script automático (recomendado)

```bash
curl -sLO https://raw.githubusercontent.com/stevenvo780/agora-worker/master/scripts/install-worker.sh
chmod +x install-worker.sh
WORKER_SECRET=<tu-secret> ./install-worker.sh <wsId>
```

Detecta `docker`/`podman` ya instalados. Si no hay ninguno: instala Podman en Fedora/RHEL/CentOS/Rocky/Alma y Docker en Ubuntu/Debian/Arch.

### Opción B — Podman manual

```bash
sudo dnf install -y podman
podman pull stevenvo780/edu-worker:latest
podman run -d --name edu-worker-<wsId> --restart=unless-stopped --network=host \
  -e NEXUS_URL=https://hub.elenxos.com \
  -e WORKER_TOKEN=<wsId> \
  -e WORKER_SECRET=<secret> \
  stevenvo780/edu-worker:latest
```

### Opción C — Docker CE en Fedora

Si preferís Docker oficial:

```bash
sudo dnf -y install dnf-plugins-core
sudo dnf-3 config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
# logout / login y después:
docker pull stevenvo780/edu-worker:latest
```

### Permisos rootless (Podman)

Si querés correr sin sudo en Fedora:

```bash
sudo loginctl enable-linger $USER
podman system migrate
```

Esto permite que tu user mantenga containers vivos al cerrar sesión.

### Troubleshooting

- **"Permission denied: /var/run/docker.sock"**: necesitás `sudo` o agregarte al grupo `docker` (reinicia sesión).
- **Podman + `--network=host`**: en rootless Fedora puede fallar. Usar `-p 3010:3010` en su lugar o configurar `slirp4netns`.
- **SELinux bloquea**: Fedora trae SELinux enforcing. Añadir `--security-opt label=disable` al run command.
