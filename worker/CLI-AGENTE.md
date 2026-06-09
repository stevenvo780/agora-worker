# CLI-AGENTE.md — Guía de herramientas para el agente IA

Esta guía está disponible en `~/CLI-AGENTE.md` y en `/app/CLI-AGENTE.md`.
Describe los CLIs instalados en este worker y cómo usarlos correctamente.

Para documentación del sistema de sincronización de `/workspace`, ver también:
`/workspace/repos` no existe hasta que corras `agora clone`, y la sincronización
automática MinIO↔worker la hace el daemon `agora-host-sync` en el host.
Referencia completa: `AgoraWorker/docs/SYNC-Y-HERRAMIENTAS.md`.

---

## 1. `agora` — CLI del workspace Agora

Gestión de workspace vía Git/Forgejo. Complementa el sync automático MinIO
(que es el canal primario y no requiere ningún comando).

### Autenticación

El worker arranca con `~/.agora/config.json` pre-seeded con la URL del backend.
Para autenticarse completamente:

```bash
# Con PAT permanente (recomendado — generarlo en Agora Settings → Acceso CLI)
agora login --token agora_pat_<valor>

# Flujo interactivo con Firebase ID token (expira en 1 hora)
agora login
```

El PAT debe comenzar con el prefijo `agora_pat_`. La configuración se guarda
en `~/.agora/config.json` (modo 600).

### Comandos disponibles

| Comando | Descripción |
|---------|-------------|
| `agora login [--token agora_pat_...]` | Autentica. Con `--token` usa PAT permanente; sin `--token`, flujo interactivo con Firebase ID token (expira 1h). |
| `agora logout` | Borra `~/.agora/config.json`. |
| `agora status [dir]` | Muestra API URL, usuario autenticado y estado git del workspace. Si no hay login, muestra "(sin login)". |
| `agora workspaces` | Lista los workspaces accesibles del usuario. Formato: `<id>\t<tipo>\t<nombre>`. |
| `agora clone <wsId> [dir]` | Clona el repo Forgejo del workspace en `dir` (default: `./<wsId>`). Configura `agora.workspaceId` en `.git/config`. |
| `agora init <dir>` | Convierte un directorio existente en workspace Agora (añade remote Forgejo y configura `agora.workspaceId`). |
| `agora pull [dir]` | `git pull --rebase --autostash` en el directorio indicado (default: `.`). |
| `agora push [dir] [-m MSG]` | `git add -A` + `git commit -m MSG` + `git push`. Si no hay cambios staged, no hace nada. |
| `agora watch [dir]` | Loop continuo: pull + autocommit + push cada 30 segundos. Útil para sync Git activo. |

### Notas importantes

- `agora login --token` requiere input interactivo (pregunta la URL del API).
  Desde el agente, el config.json ya tiene `apiUrl`, pero el token debe
  proveerlo el usuario. **No es posible autenticar sin intervención humana.**
- El sync MinIO (daemon `agora-host-sync`) es automático y no requiere `agora`.
  Úsalo para sincronización Git con historial de commits.
- `agora clone` provisionará el repo Forgejo si no existe aún.
- Los repos clonados van a `/workspace/repos/<wsId>` (dentro del directorio
  que no se sincroniza con MinIO por `.syncignore`).

---

## 2. `st` — CLI de lógica formal ST

Evalúa, verifica y deriva fórmulas lógicas con múltiples sistemas de lógica.
Instalado globalmente desde `@stevenvo780/st-cli@latest`.

### Comandos disponibles

| Comando | Descripción |
|---------|-------------|
| `st check <archivo.st>` | Verifica sintaxis y evalúa todos los `check` del archivo. |
| `st derive <archivo.st>` | Ejecuta derivaciones (`derive ... from {...}`). |
| `st countermodel <formula>` | Busca contramodelo para la fórmula dada (si es inválida). |
| `st formalize <texto>` | Intenta formalizar texto en lenguaje natural a fórmula ST. |
| `st export <archivo.st> [--format json\|html\|pdf]` | Exporta resultados en el formato indicado. |
| `st repl` | Abre el REPL interactivo de ST. |
| `st --version` | Muestra la versión instalada. |
| `st --list-profiles` | Lista los perfiles de lógica disponibles. |

### Perfiles de lógica disponibles

- `classical.propositional` — Lógica proposicional clásica
- `classical.first_order` — Lógica de primer orden (FOL)
- `modal.k` — Lógica modal sistema K
- `paraconsistent.belnap` — Lógica paraconsistente Belnap 4-valuada
- `intuitionistic.propositional` — Lógica intuicionista
- `deontic.standard` — Lógica deóntica
- `epistemic.s5` — Lógica epistémica S5
- `temporal.ltl` — Lógica temporal lineal
- `probabilistic.basic` — Lógica probabilística
- `aristotelian.syllogistic` — Silogística aristotélica
- `dl-hybrid` — Description Logic subset (DDL)

### Ejemplo básico de archivo `.st`

```st
logic classical.propositional

axiom p1 : P -> Q
axiom p2 : P
derive Q from {p1, p2}

check valid (P | !P)
check satisfiable (P & Q)
```

### Operadores

| Operador | Significado |
|----------|-------------|
| `&` | Conjunción |
| `\|` | Disyunción |
| `!` | Negación |
| `->` | Implicación |
| `<->` | Bicondicional |
| `forall x` | Cuantificador universal |
| `exists x` | Cuantificador existencial |
| `[]` | Necesariamente (modal) |
| `<>` | Posiblemente (modal) |

### Uso desde Node.js (API programática)

```javascript
const { evaluate } = require('@stevenvo780/st-lang/api');
const result = evaluate('logic classical.propositional\ncheck valid (P | !P)');
console.log(result.results[0].status); // 'valid'
```

---

## 3. `codex` — Asistente IA OpenAI Codex

```bash
codex                         # modo interactivo
codex "describe este código"  # consulta directa
```

Requiere `OPENAI_API_KEY` en el entorno. Sin la key, falla al iniciar.
El agente puede verificar: `echo ${OPENAI_API_KEY:+configurado}`.

---

## 4. `claude` — Asistente IA Anthropic Claude Code

```bash
claude                        # modo interactivo
claude "explica este archivo" # consulta directa
```

Requiere `ANTHROPIC_API_KEY` en el entorno. Sin la key, falla al iniciar.

---

## 5. `gemini` — Asistente IA Google Gemini CLI

```bash
gemini                        # modo interactivo
gemini "resume este código"   # consulta directa
```

Requiere `GEMINI_API_KEY` o login de Google en el entorno.

---

## 6. Sincronización de `/workspace`

El directorio `/workspace` se sincroniza automáticamente con MinIO (cloud)
cada ~30 segundos mediante el daemon `agora-host-sync` que corre en el host.

### Reglas clave

- **Guardar siempre en `/workspace`** (o subdirectorios). Archivos fuera de
  `/workspace` (en `/home`, `/tmp`, etc.) no se sincronizan.
- **No usar prefijos `tmp-` ni extensión `.tmp`** para archivos que deben
  persistir (son ignorados por el daemon).
- **Evitar `.scratch/` y `.agent-tmp/`** para archivos persistentes; son
  HARD_SKIP en el daemon (nunca se suben).
- **`/workspace/repos/`** tampoco se sincroniza (por `.syncignore` default).
  Úsalo para repositorios git locales.

### Qué pasa después de escribir un archivo

```
Agente escribe /workspace/archivo.txt
  → daemon detecta en el próximo ciclo (≤30s)
  → sube a MinIO (presigned URL)
  → Firestore actualiza metadatos
  → aparece en la UI web de Agora en ≤30s
```

### Verificar estado de sync desde el agente

```bash
# Ver archivos en el workspace
ls -la /workspace

# Ver el .syncignore activo
cat /workspace/.syncignore

# Comprobar si el daemon está activo (desde tools del agente en AgoraBack)
# usa la tool: sync_status
```

---

## 7. Pitfalls comunes

1. **`agora status` muestra "(sin login)"**: el config tiene `apiUrl` pero falta
   el `token`. El usuario debe hacer `agora login --token agora_pat_...`.

2. **`st` no reconoce un archivo**: verificar que comienza con `logic <perfil>`.

3. **Archivo escrito no aparece en la web**: verificar que está en `/workspace`,
   que su nombre no cae en patrones ignorados (`tmp-`, `.tmp`, `.scratch/`), y
   esperar hasta 30 segundos.

4. **Borrado en la web no llega al worker**: el daemon propaga borrados solo en
   full-reconcile (cada ~2.5 minutos). Esperar o reiniciar el daemon.

5. **`codex`/`claude`/`gemini` fallan sin output**: revisar que la API key
   correspondiente está en el entorno antes de invocarlos.
