# `agora` — CLI para workspaces de Agora

Trabaja tus workspaces de Agora desde **cualquier Linux/Mac/Windows con Node 18+**, usando tu IDE
preferido (VS Code, vim, JetBrains, etc.). Todo cambio que hagas localmente se sincroniza con el
NAS via Git interno (Forgejo); el editor web de Agora ve esos cambios al próximo refresh.

## Instalar

```bash
# desde npm (cuando se publique)
npm i -g @agora/cli

# o desde el repo
cd services/agora-cli
npm link
```

## Uso

```bash
agora login                       # configura URL del API + ID token Firebase
agora workspaces                  # lista tus workspaces
agora clone <wsId> [dir]          # clona el repo del workspace en `dir`
agora pull [dir]                  # actualiza desde el NAS
agora push [dir] -m "mensaje"     # sube cambios al NAS
agora watch [dir]                 # sync automático cada 30s
```

## Cómo funciona

- Cada workspace de Agora tiene su propio repositorio Git en Forgejo (`agora/<workspaceId>` para
  shared, `agora/personal-<uid>` para personal).
- `agora clone` hace `git clone` con tu token personal de Forgejo (provisionado al primer uso).
- `agora push` agrega + commitea + push.
- `agora watch` corre `git pull --rebase` + autocommit + push periódicamente.
- El editor web de Agora también empuja cambios al mismo repo cuando guardas en él.
- El servidor de workers (terminales en la nube) hace `git pull --rebase` cada 60s.

Resultado: editas en VS Code → push → editor web ve el cambio.
Editas en el editor web → autocommit → tu local hace pull → IDE refleja el cambio.

## Sin perder nada

Si ya tienes una carpeta con archivos antes de `clone`, usa `agora init <dir>` y haz un `agora pull`
después; git resolverá merges y, en conflicto, los archivos quedarán marcados para que decidas.

## Config

- `~/.agora/config.json` (chmod 600): apiUrl, token, uid, email.
- `git config agora.workspaceId` por repo: el id del workspace al que apunta.
