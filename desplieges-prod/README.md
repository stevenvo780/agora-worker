# Infraestructura de Producción

## Fuente de verdad

La referencia operativa principal para workers es:

- `../docs/RUNTIME-PROD-2026-08-25.md`

Los scripts basados en `edu-worker-manager`/systemd son históricos y quedan
bloqueados por defecto: apuntaban al `ils-server` retirado. No usarlos para el
runtime actual basado íntegramente en Docker.

---

## Host actual

| Campo | Valor |
|---|---|
| Alias SSH | `vps-tn` (malla) / `vps` (pública) |
| IP | `100.64.0.11` / `167.114.118.213` |
| Usuario | `root` |
| Rol | Workers (41 `edu-worker-*`) + `agora-host-sync` Docker |

Acceso:

```bash
ssh vps-tn
```

---

## Despliegue rápido

### 1. Frontend (Vercel)

```bash
vercel --prod
```

### 2. Hub (.deb)

```bash
./desplieges-prod/deploy_hub.sh
```

### 3. Worker — nueva imagen Docker / rollout de ST

```bash
./desplieges-prod/deploy_docker.sh
```

Con versión explícita de ST:

```bash
./desplieges-prod/deploy_docker.sh 4.15.1
```

> Este script pertenece al runtime retirado de `ils-server` y aborta por
> defecto. No ejecutarlo contra `vps-humanizar-2`: allí los workers y host-sync
> se gestionan como contenedores con configuración preservada.

### 4. Worker — `.deb` del manager + update all

```bash
./desplieges-prod/deploy_worker.sh
```

### 5. Hotfix de emergencia de ST dentro de contenedores vivos

```bash
ALLOW_INPLACE_ST_UPDATE=1 ./desplieges-prod/update_st_workers.sh 4.15.1
```

> Solo para contingencia. No sustituye el rebuild de imagen.
> El script ya no guarda contraseñas en texto plano: usa `WORKER_SUDO_PASS` si ya la cargaste desde Vault, o la pide de forma interactiva.

---

## Variables críticas

### Worker

- Archivo: `/etc/edu-worker/worker.env`
- Variables mínimas:
  - `NEXUS_URL=https://hub.elenxos.com`
  - `WORKER_SOCKET_SECRET` (debe coincidir con Hub)
  - `WORKER_SYNC_SECRET` (debe coincidir con AgoraBack/host-sync)
  - `FIREBASE_CONFIG` con `projectId`, `storageBucket`, `databaseURL`

### Hub

- Archivos / referencias operativas (en agora-storage `root@76.13.118.239`):
  - `/opt/edu-hub/.env`
  - `/opt/edu-hub/serviceAccountKey.json`

Regla obligatoria:

```bash
grep -E 'WORKER_SOCKET_SECRET|WORKER_SECRET_PREVIOUS|WORKER_SECRET' /opt/edu-hub/.env
grep -E 'NEXUS_URL|WORKER_SOCKET_SECRET|WORKER_SYNC_SECRET|WORKER_SECRET_PREVIOUS|WORKER_SECRET' /etc/edu-worker/worker.env
```

---

## Verificaciones mínimas

```bash
ssh vps-tn
docker ps --filter name=edu-worker
docker inspect agora-host-sync --format '{{.State.Status}}/{{.State.Health.Status}}'
docker exec $(docker ps --filter name=edu-worker --format '{{.Names}}' | head -n 1) st --version
# Hub (en agora-storage):
ssh root@76.13.118.239 'systemctl status edu-hub'
curl -s https://hub.elenxos.com/health
```

---

## Troubleshooting express

| Síntoma | Revisar |
|---|---|
| Timeout al hub | `NEXUS_URL` en `/etc/edu-worker/worker.env` |
| Auth failure | `WORKER_SOCKET_SECRET` para Hub o `WORKER_SYNC_SECRET` para Back/host-sync |
| Worker no reaparece | `docker inspect` + logs de `agora-host-sync`; no recrear sin preservar mounts/env |
| ST sigue viejo | reconstruir imagen y no solo hotfix interno |

---

## Notas de seguridad

- No guardar secretos en scripts, `.md`, `.env` versionados ni shell history.
- El repo ya no debe contener contraseñas hardcodeadas para `sudo`.
- Los scripts de despliegue preservan configuraciones remotas con `--force-confold`.
