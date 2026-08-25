# Runtime productivo de AgoraWorker — 2026-08-25

## Fuente de verdad actual

- Host: `vps-humanizar-2`.
- Acceso: alias `vps-tn` por malla (`100.64.0.11`) o `vps` por la IP pública
  `167.114.118.213`; user `root`. La clave se resuelve desde el vault/SSH local,
  nunca desde este repositorio.
- `ils-server` (`100.64.0.5`, `148.230.88.162`) está apagado desde el
  16-ago-2026 y no es un destino productivo.
- Workers: 41 contenedores `edu-worker-*`, con `restart=unless-stopped`.
- Persistencia: `/datos/agora-workers/workspaces/<id>` y
  `/datos/agora-workers/home/<id>`.
- Host sync: contenedor `agora-host-sync`, no unidad systemd. Imagen observada:
  `agora-host-sync:20260819`, límite 8 GiB, métricas en loopback.

## Verificación segura

```bash
ssh vps-tn 'docker inspect agora-host-sync --format "{{.State.Status}}/{{.State.Health.Status}} reinicios={{.RestartCount}}"'
ssh vps-tn 'docker ps --filter name=edu-worker --format "{{.Names}}|{{.Status}}"'
ssh vps-tn 'docker ps --filter name=edu-worker --format "{{.Names}}" | wc -l'
ssh vps-tn 'df -h / && free -h'
```

El 25-ago-2026 se verificaron directamente 41/41 workers `Up`, host-sync
`healthy` con cero reinicios, disco al 75 % con 115 GiB libres y 28 GiB de RAM
disponible. El worker 41 corresponde a `Descartes`
(`lzYPWlMdecYzW4eus4BX`); AgoraBack registró ciclos `worker-list` HTTP 200
desde la IP pública del host.

## Operación

- No usar los scripts legacy que llaman `edu-worker-manager` o reinician una
  unidad `agora-host-sync.service`: pertenecen a `ils-server` y abortan por
  defecto.
- Antes de recrear un worker, preservar su env, mounts, labels, límites y
  política de restart mediante `docker inspect`; los secretos sólo se leen del
  runtime del host.
- Antes de reiniciar host-sync, capturar `docker logs --tail 200
  agora-host-sync` y sus métricas. Luego verificar que vuelve `healthy` y que la
  cola disminuye.
- No borrar `/datos/agora-workers`: es la persistencia recuperable.

## Hallazgo abierto

El workspace `TxFHNwYtgNTS7aTROXOz` mantenía `fail:1` y `queueDepth:274` sin
variar entre ciclos, mientras los otros 39 estaban sanos. Seguimiento:
<https://github.com/stevenvo780/agora-worker/issues/1>.

## Rollback de documentación/guardas

Revertir el commit que introduce este documento y los bloqueos de scripts
legacy. Eso no modifica ningún contenedor, secreto ni dato productivo.
