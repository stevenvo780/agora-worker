#!/bin/bash
set -e

# Sync Agent Authentication:
# - Worker connects to Hub with signed HMAC token (WORKER_SECRET)
# - Hub verifies and issues Firebase Custom Token
# - No serviceAccountKey.json needed in workers (secure architecture)

echo "🚀 Starting Edu Worker..."
echo "🔌 Worker Configuration:"
echo "   Hub URL: ${NEXUS_URL:-http://localhost:3010}"
echo "   Token: ${WORKER_TOKEN:-<not set>}"

# ── Restore skeleton home files when /home/estudiante is a persistent volume ──
# When the host mounts an empty directory over /home/estudiante, the Dockerfile's
# dotfiles (.bashrc, .profile, .bash_logout) are hidden. This restores them.
SKEL_DIR="/etc/skel-estudiante"
HOME_DIR="/home/estudiante"
if [ -d "$SKEL_DIR" ]; then
    for f in .bashrc .profile .bash_logout; do
        if [ ! -f "${HOME_DIR}/${f}" ] && [ -f "${SKEL_DIR}/${f}" ]; then
            cp "${SKEL_DIR}/${f}" "${HOME_DIR}/${f}"
            echo "   📋 Restored ${f} from skeleton"
        fi
    done
    # Also restore sudo_as_admin marker
    touch "${HOME_DIR}/.sudo_as_admin_successful" 2>/dev/null || true
fi

# ── Create default .syncignore and repos/ if missing ──────────────
WORKSPACE_DIR="/workspace"
SYNCIGNORE_FILE="${WORKSPACE_DIR}/.syncignore"
REPOS_DIR="${WORKSPACE_DIR}/repos"

if [ ! -f "$SYNCIGNORE_FILE" ]; then
    echo "📋 Creating default .syncignore..."
    cat > "$SYNCIGNORE_FILE" << 'SYNCIGNORE'
# ── .syncignore ──────────────────────────────────────────────
# Archivos y carpetas listados aquí NO se sincronizan con la nube.
# Uno por línea. Líneas vacías y comentarios (#) se ignoran.
# Usa nombre/ para carpetas, *.ext para extensiones.
# ──────────────────────────────────────────────────────────────

# Carpeta de repositorios locales (nunca sincronizar)
repos

# ST guide (auto-generated, available via UI too)
.st-guide.md

# Build artifacts & caches
__pycache__
*.pyc
*.o
*.so
dist
build
target
*.class
*.jar

# Carpetas de dependencias y build (pesadas, no sincronizar)
node_modules
.next
SYNCIGNORE
    echo "   ✅ .syncignore creado con valores por defecto"
fi

if [ ! -d "$REPOS_DIR" ]; then
    mkdir -p "$REPOS_DIR"
    echo "   ✅ Carpeta repos/ creada"
fi

# ── ST interpreter guide ──────────────────────────────────────────
ST_GUIDE="${WORKSPACE_DIR}/.st-guide.md"
if [ ! -f "$ST_GUIDE" ]; then
    echo "📖 Creating ST language guide..."
    cat > "$ST_GUIDE" << 'STGUIDE'
# ST — Guía del Lenguaje de Lógica Formal

> Intérprete: `st` (disponible globalmente en la terminal)

## Inicio rápido

```bash
# Ejecutar un archivo .st
st run archivo.st

# REPL interactivo
st

# Ver perfiles disponibles
st --list-profiles

# Verificar sintaxis
st check archivo.st
```

## Sintaxis básica

### 1. Declarar lógica
Todo script empieza con la lógica a usar:
```st
logic classical.propositional
```

### 2. Axiomas y teoremas
```st
axiom a1 : P -> Q
axiom a2 : P
theorem t1 : Q
```

### 3. Comandos de verificación
```st
check valid (P | !P)           // ¿Es tautología?
check satisfiable (P & Q)     // ¿Tiene modelo?
check equivalent (P->Q), (!P|Q)  // ¿Son equivalentes?
derive Q from {a1, a2}        // Derivar por Modus Ponens
truth_table (P & Q -> R)      // Tabla de verdad
countermodel (P -> Q)         // Contramodelo si inválido
```

### 4. Variables con `let`
```st
let f = (P -> Q) & (Q -> R)
check valid f -> (P -> R)
```

## Operadores

| Operador | Significado | Alias español |
|----------|-------------|---------------|
| `&` | Conjunción (Y) | `y` |
| `\|` | Disyunción (O) | `o` |
| `!` | Negación | `no` |
| `->` | Implicación | `entonces` |
| `<->` | Bicondicional | `sii` |
| `forall x` | Para todo x | |
| `exists x` | Existe x | |
| `[]` | Necesariamente (modal) | |
| `<>` | Posiblemente (modal) | |

## Perfiles de lógica disponibles

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

## Capa Textual (Text Layer)

Permite vincular documentos a fórmulas lógicas:
```st
logic classical.propositional
let p1 = passage([[documento.md#seccion]])
let f1 = formalize p1 as (P & Q)
claim c1 = f1
check valid c1
```

## API programática (Node.js)

```javascript
const { evaluate, createInterpreter } = require('@stevenvo780/st-lang/api');

// Evaluación directa
const result = evaluate('logic classical.propositional\ncheck valid (P | !P)');
console.log(result.results[0].status); // 'valid'

// Intérprete con estado
const st = createInterpreter();
st.exec('logic classical.propositional');
st.exec('axiom a1 : P -> Q');
const r = st.exec('check satisfiable a1');
console.log(r.ok); // true
```

## Ejemplos completos

### Modus Ponens
```st
logic classical.propositional
axiom p1 : P -> Q
axiom p2 : P
derive Q from {p1, p2}
```

### Silogismo hipotético
```st
logic classical.propositional
axiom h1 : P -> Q
axiom h2 : Q -> R
check valid (P -> R)
```

### Lógica de primer orden
```st
logic classical.first_order
axiom all_mortal : forall x (Human(x) -> Mortal(x))
axiom socrates : Human(socrates)
derive Mortal(socrates) from {all_mortal, socrates}
```

### Lógica modal
```st
logic modal.k
check valid [](P -> Q) -> ([]P -> []Q)  // Axioma K
```

---
*ST v$(st --version 2>/dev/null || echo "unknown") — Motor de lógica formal multi-sistema*
*Docs completas: https://github.com/stevenvo780/ST*
STGUIDE
    echo "   ✅ .st-guide.md creado"
fi
# ── Cleanup & fix permissions ─────────────────────────────────────
echo "🔧 Fixing workspace permissions and cleaning up..."

# Note: .git directories are preserved locally (not synced, not deleted).
# Users manage their own repos freely.

# Remove broken symlinks recursively
sudo find "${WORKSPACE_DIR}" -maxdepth 10 -type l ! -exec test -e {} \; -delete 2>/dev/null && \
    echo "   🗑️ Removed broken symlinks" || true

# Fix ownership: ensure everything is owned by estudiante
# This fixes EACCES errors when sync_agent runs as estudiante
sudo chown -R estudiante:estudiante "${WORKSPACE_DIR}" 2>/dev/null || true
echo "   ✅ Permissions fixed (estudiante:estudiante)"
# ── end setup ─────────────────────────────────────────────────────

# ── Auto-install user packages ────────────────────────────────────
# Users can create ~/.user-packages with one npm package per line.
# These are re-installed on every container start to survive image updates.
USER_PACKAGES_FILE="/home/estudiante/.user-packages"
if [ -f "$USER_PACKAGES_FILE" ]; then
    echo "📦 Installing user packages from .user-packages..."
    while IFS= read -r pkg || [[ -n "$pkg" ]]; do
        pkg=$(echo "$pkg" | xargs)  # trim whitespace
        [[ -z "$pkg" || "$pkg" == \#* ]] && continue
        if ! command -v "$(echo "$pkg" | sed 's/@.*//' | xargs basename)" &>/dev/null; then
            echo "   📥 Installing: $pkg"
            sudo npm install -g "$pkg" --loglevel=error 2>&1 | tail -1 || \
                echo "   ⚠️  Failed to install: $pkg"
        fi
    done < "$USER_PACKAGES_FILE"
    echo "   ✅ User packages processed"
fi
# ── end user packages ─────────────────────────────────────────────

# Determine workspace type from token
if [[ "$WORKER_TOKEN" == personal:* ]]; then
    echo "   Type: personal"
    echo "   Workspace ID: $WORKER_TOKEN"
else
    echo "   Type: shared"
    echo "   Workspace ID: $WORKER_TOKEN"
fi

# ── Git workspace bootstrap (no destructivo) ────────────────────
# Backend = Forgejo (1 repo por workspace) + MinIO. Cada workspace = 1 repo.
# Si el contenedor recibe AGORA_WORKSPACE_REPO + AGORA_GIT_USER + AGORA_GIT_TOKEN,
# fusiona /workspace local con el remoto sin perder archivos preexistentes.
if [ -n "${AGORA_WORKSPACE_REPO:-}" ] && [ -n "${AGORA_GIT_USER:-}" ] && [ -n "${AGORA_GIT_TOKEN:-}" ]; then
    echo "🌿 Configurando workspace git..."
    AUTHED_URL=$(echo "$AGORA_WORKSPACE_REPO" | sed -E "s#https?://#https://${AGORA_GIT_USER}:${AGORA_GIT_TOKEN}@#")
    git -C "${WORKSPACE_DIR}" config user.email "${AGORA_GIT_EMAIL:-${AGORA_GIT_USER}@noreply.agora.local}" || true
    git -C "${WORKSPACE_DIR}" config user.name  "${AGORA_GIT_USER}" || true

    if [ ! -d "${WORKSPACE_DIR}/.git" ]; then
        # No es repo todavía. Si hay archivos pre-existentes los preservamos:
        # init local + add + commit, luego pull --rebase contra remoto.
        echo "   inicializando repo local sobre /workspace existente..."
        git -C "${WORKSPACE_DIR}" init -q -b main
        git -C "${WORKSPACE_DIR}" remote add origin "$AUTHED_URL"
        # Si hay archivos los committeamos primero para no perderlos.
        if [ -n "$(ls -A "${WORKSPACE_DIR}" 2>/dev/null | grep -v '^\.git$' || true)" ]; then
            git -C "${WORKSPACE_DIR}" add -A 2>/dev/null || true
            git -C "${WORKSPACE_DIR}" commit -m "preexisting workspace at first boot" --allow-empty 2>/dev/null || true
        else
            git -C "${WORKSPACE_DIR}" commit --allow-empty -m "init" 2>/dev/null || true
        fi
        # Fusionar con remoto sin sobrescribir
        git -C "${WORKSPACE_DIR}" fetch origin --quiet 2>/dev/null || true
        git -C "${WORKSPACE_DIR}" pull --rebase --strategy=recursive --strategy-option=ours origin main --no-edit 2>/dev/null || true
        git -C "${WORKSPACE_DIR}" push -u origin main 2>/dev/null || true
    else
        git -C "${WORKSPACE_DIR}" remote set-url origin "$AUTHED_URL"
        git -C "${WORKSPACE_DIR}" pull --rebase --autostash --quiet 2>/dev/null || true
    fi

    # Auto-sync con NAS via agora-cli (pull + autocommit + push cada 30s).
    nohup agora watch "${WORKSPACE_DIR}" >/tmp/agora-watch.log 2>&1 &
    echo "✅ Git workspace listo (origin: ${AGORA_WORKSPACE_REPO}); agora-cli watch corriendo."
else
    echo "ℹ️  AGORA_WORKSPACE_REPO/USER/TOKEN no definidos; saltando bootstrap git (workspace local intacto)."
fi

# Start main Worker process
exec node /app/index.js
