# Infraestructura de Producción

## Fuente de verdad

La referencia operativa principal para workers y hub ahora es:

- `docs/08-edu-workers-stev-server.md`

Este `README` queda como chuleta rápida de comandos.

---

## Host actual

| Campo | Valor |
|---|---|
| Alias SSH | `stev-server` |
| IP NetBird | `100.98.8.227` |
| Usuario | `stev` |
| Rol | Hub + workers |

Acceso:

```bash
ssh stev-server
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
./desplieges-prod/deploy_docker.sh 3.2.1
```

> El script construye la imagen con `ST_LANG_VERSION` explícita (si se la pasas), la publica y luego ejecuta `edu-worker-manager update all` en `stev-server`. Si `sudo` remoto requiere contraseña, la pedirá en la terminal o puede recibirse por variable de entorno sin dejarla hardcodeada en el repo.

### 4. Worker — `.deb` del manager + update all

```bash
./desplieges-prod/deploy_worker.sh
```

### 5. Hotfix de emergencia de ST dentro de contenedores vivos

```bash
ALLOW_INPLACE_ST_UPDATE=1 ./desplieges-prod/update_st_workers.sh 3.2.1
```

> Solo para contingencia. No sustituye el rebuild de imagen.
> El script ya no guarda contraseñas en texto plano: usa `WORKER_SUDO_PASS` si ya la cargaste desde Vault, o la pide de forma interactiva.

---

## Variables críticas

### Worker

- Archivo: `/etc/edu-worker/worker.env`
- Variables mínimas:
  - `NEXUS_URL=https://hub.humanizar-dev.cloud`
  - `WORKER_SECRET` (debe coincidir con el hub)
  - `FIREBASE_CONFIG` con `projectId`, `storageBucket`, `databaseURL`

### Hub

- Archivos / referencias operativas:
  - `/home/stev/edu-hub/.env`
  - `/home/stev/edu-hub/serviceAccountKey.json`

Regla obligatoria:

```bash
grep -E 'WORKER_SECRET' /home/stev/edu-hub/.env
grep -E 'NEXUS_URL|WORKER_SECRET' /etc/edu-worker/worker.env
```

---

## Verificaciones mínimas

```bash
ssh stev-server
systemctl --user status edu-hub
sudo edu-worker-manager status
sudo docker ps --filter name=edu-worker
sudo docker exec $(sudo docker ps --filter name=edu-worker --format '{{.Names}}' | head -n 1) st --version
```

---

## Troubleshooting express

| Síntoma | Revisar |
|---|---|
| Timeout al hub | `NEXUS_URL` en `/etc/edu-worker/worker.env` |
| Auth failure | `WORKER_SECRET` en hub y worker |
| Worker no reaparece | `sudo edu-worker-manager update all` + logs |
| ST sigue viejo | reconstruir imagen y no solo hotfix interno |

---

## Notas de seguridad

- No guardar secretos en scripts, `.md`, `.env` versionados ni shell history.
- El repo ya no debe contener contraseñas hardcodeadas para `sudo`.
- Los scripts de despliegue preservan configuraciones remotas con `--force-confold`.
