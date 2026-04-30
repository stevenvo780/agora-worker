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
cp agora-host-sync.mjs ~/bin/

# Como root:
sudo cp agora-host-sync.service /etc/systemd/system/
sudo mkdir -p /etc/systemd/system/agora-host-sync.service.d
sudo tee /etc/systemd/system/agora-host-sync.service.d/secret.conf > /dev/null <<EOF
[Service]
Environment=WORKER_SECRET=<el WORKER_SECRET compartido del host>
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
- `AGORA_HUB_URL` — default `https://agora.elenxos.com`
- `BASE_DIR` — default `/home/stev/edu-worker/workspaces`
- `POLL_MS` — default `5000`
- `VERBOSE=1` — logs detallados por archivo
