#!/usr/bin/env node
/**
 * agora-host-sync — daemon en el host del worker que mantiene el directorio
 * `/home/stev/edu-worker/workspaces/<wsId>/` (montado como `/workspace` en el
 * contenedor) espejado con la workspace en MinIO + Firestore.
 *
 * Bidireccional. Pull cada 5s vía /api/sync/worker-list, push cuando detecta
 * diffs locales. Auth HMAC con WORKER_SYNC_SECRET (`WORKER_SECRET` queda como
 * fallback legacy). Conflicto a 3 vías → gana el server (source of truth).
 *
 * Métricas:
 *  - logs JSON por ciclo (stdout + journal)
 *  - endpoint Prometheus en :9090/metrics (loopback)
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, stat, readdir, rm, copyFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { compileIgnore, isHardSkipped, isWorkspacePathIgnored, BUILTIN_IGNORE_RULES } from './ignore.mjs';
import { buildAuthHeaders } from './auth.mjs';
import { runPool } from './pool.mjs';
import { MetricsRegistry, percentile } from './metrics.mjs';

const HUB_URL = process.env.AGORA_HUB_URL ?? process.env.NEXUS_URL ?? 'https://agora-backend-578238159459.us-central1.run.app';
const WORKER_SECRET = process.env.WORKER_SYNC_SECRET || process.env.WORKER_SECRET;
const BASE_DIR = process.env.BASE_DIR ?? '/home/stev/edu-worker/workspaces';
const POLL_MS = Number.parseInt(process.env.POLL_MS ?? '30000', 10);
const VERBOSE = process.env.VERBOSE === '1';
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY ?? '4', 10);
const SYNC_CONCURRENCY = Number.parseInt(process.env.SYNC_CONCURRENCY ?? '8', 10);
// Cada cuántos ciclos por workspace se fuerza un scan completo (since=0). Es lo
// que permite detectar borrados hechos en la web: del-local sólo corre en full
// scan (ver syncOne). Sin esto, un delete remoto nunca se propaga al worker.
const FULL_RECONCILE_EVERY = Number.parseInt(process.env.FULL_RECONCILE_EVERY ?? '5', 10);
const METRICS_PORT = Number.parseInt(process.env.METRICS_PORT ?? '9090', 10);
const METRICS_BIND = process.env.METRICS_BIND ?? '127.0.0.1';
const METRICS_DISABLED = process.env.METRICS_DISABLED === '1';

if (!WORKER_SECRET) {
    console.error('agora-host-sync: WORKER_SYNC_SECRET o WORKER_SECRET requerido');
    process.exit(1);
}

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const verbose = (...a) => { if (VERBOSE) log(...a); };

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// El nombre del container `edu-worker-<wsId>` puede contener un UID puro
// (workspace personal) o un wsId shared. El back distingue con el prefijo
// `personal:` en el token, por eso NO alcanza con usar el wsId crudo: hay
// que leer el `WORKER_TOKEN` real del env del container vía `docker inspect`.
// Cacheado por wsId; el token no cambia mientras el container exista.
const workerTokenCache = new Map();
const resolveWorkerToken = async (wsId) => {
    const cached = workerTokenCache.get(wsId);
    if (cached) return cached;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const out = await dockerCmd([
                'inspect', `edu-worker-${wsId}`,
                '--format', '{{range .Config.Env}}{{println .}}{{end}}'
            ]);
            const line = out.split('\n').find((l) => l.startsWith('WORKER_TOKEN='));
            if (line) {
                const token = line.slice('WORKER_TOKEN='.length).trim();
                if (token) {
                    workerTokenCache.set(wsId, token);
                    return token;
                }
            }
            lastError = new Error('WORKER_TOKEN ausente en el contenedor');
        } catch (e) {
            lastError = e;
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
    // Nunca degradar al id crudo: para un workspace personal eso firma una
    // identidad shared inexistente y puede intentar sincronizar con el destino
    // equivocado. Es más seguro omitir este ciclo y reintentar en el siguiente.
    throw new Error(`no se pudo resolver WORKER_TOKEN para ${wsId}: ${lastError?.message ?? 'error desconocido'}`);
};

const authHeaders = (token, userId = null) => buildAuthHeaders(WORKER_SECRET, token, userId);

// ── Métricas ────────────────────────────────────────────────────────────────

const registry = new MetricsRegistry();
const filesProcessed = registry.counter(
    'agora_sync_files_processed_total',
    'Archivos procesados por agora-host-sync (op,result)'
);
const bytesTransferred = registry.counter(
    'agora_sync_bytes_total',
    'Bytes transferidos (direction=up|down)'
);
const opDuration = registry.histogram(
    'agora_sync_op_duration_ms',
    'Latencia por operación de sync en ms',
    [10, 50, 100, 250, 500, 1000, 2500, 5000]
);
const queueDepth = registry.gauge(
    'agora_sync_queue_depth',
    'Operaciones planificadas en el último ciclo por workspace'
);
const lastCycleTs = registry.gauge(
    'agora_sync_last_cycle_unixtime',
    'Unix timestamp del último ciclo completo por workspace'
);
const lastCycleDuration = registry.gauge(
    'agora_sync_last_cycle_duration_ms',
    'Duración del último ciclo por workspace en ms'
);
const workersActive = registry.gauge(
    'agora_sync_workers_active',
    'Workers detectados por docker ps en el último ciclo'
);
const cyclesTotal = registry.counter(
    'agora_sync_cycles_total',
    'Ciclos completados (con éxito o fallo)'
);

const startMetricsServer = () => {
    if (METRICS_DISABLED) return;
    const server = createServer((req, res) => {
        if (req.url === '/metrics') {
            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
            res.end(registry.render());
            return;
        }
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.writeHead(404); res.end();
    });
    server.on('error', (e) => log('metrics server error:', e.message));
    server.listen(METRICS_PORT, METRICS_BIND, () => {
        log(`metrics endpoint http://${METRICS_BIND}:${METRICS_PORT}/metrics`);
    });
    return server;
};

// ── HTTP helpers ────────────────────────────────────────────────────────────

const fetchJson = async (url, init = {}) => {
    const r = await fetch(url, init);
    if (!r.ok) throw new Error(`HTTP ${r.status} — ${(await r.text()).slice(0, 200)}`);
    return r.json();
};

const fetchBuf = async (url) => {
    const r = await fetch(url);
    if (!r.ok) {
        const e = new Error(`download HTTP ${r.status}`);
        e.httpStatus = r.status;
        throw e;
    }
    return Buffer.from(await r.arrayBuffer());
};

const dockerCmd = (args) => new Promise((resolve, reject) => {
    const c = spawn('docker', args);
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.stderr.on('data', (d) => { err += d.toString(); });
    c.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error(`docker ${args[0]} exit ${code}: ${err.trim()}`)));
});

const listWorkers = async () => {
    const out = await dockerCmd(['ps', '--filter', 'name=edu-worker-', '--format', '{{.Names}}']);
    return out.split('\n').map(s => s.trim()).filter(Boolean).map(n => n.replace(/^edu-worker-/, ''));
};

const listExitedWorkers = async () => {
    const out = await dockerCmd(['ps', '-a', '--filter', 'name=edu-worker-', '--filter', 'status=exited', '--format', '{{.Names}}']);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
};

// Revive contenedores parados. Cubre: docker stop manual, daemon restart,
// OOM kill, reboots del host. Loggea quién, exitCode y OOMKilled flag.
const reviveExitedWorkers = async () => {
    const exited = await listExitedWorkers();
    if (exited.length === 0) return 0;
    let revived = 0;
    for (const name of exited) {
        try {
            const info = await dockerCmd(['inspect', name, '--format', '{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.FinishedAt}}']);
            await dockerCmd(['start', name]);
            log(`revive ${name} (${info.trim()})`);
            revived++;
        } catch (e) {
            log(`revive fail ${name}: ${e.message}`);
        }
    }
    return revived;
};

const readState = async (wsDir) => {
    try { return JSON.parse(await readFile(path.join(wsDir, '.agora-host-sync.json'), 'utf8')); }
    catch { return {}; }
};
const writeState = async (wsDir, state) =>
    writeFile(path.join(wsDir, '.agora-host-sync.json'), JSON.stringify(state, null, 2));

// Último timestamp de sincronización exitosa por workspace (para el parámetro
// `since=` en worker-list). Reduce lecturas Firestore al filtrar sólo docs
// modificados después del último ciclo completado.
const lastSyncMs = new Map();
const reconcileCounter = new Map();

// Circuit breaker: tras N fallos consecutivos del mismo path o workspace,
// dejar de intentar y solo loggear cada 30 ciclos. Evita inundar el log con
// 404s repetidos (blobs huérfanos) o 500s (workspaces que ya no existen en
// Firestore pero el contenedor sigue corriendo).
const FAIL_THRESHOLD = 3;
const SILENCE_EVERY = 30;
// Dead-letter: un pull con 404/410 (blob ausente en MinIO = doc huérfano) se
// marca `dead` en el state para NO re-pullearlo en loop cada ciclo. Se re-intenta
// tras DEAD_RETRY_MS por si el blob reaparece (reparado/re-subido). El GC del
// backend (reconcile-storage) limpia el doc huérfano de Firestore; mientras tanto
// el dead-letter evita el loop 404. Desactivable con DEADLETTER=0.
const DEAD_LETTER = process.env.DEADLETTER !== '0';
const DEAD_RETRY_MS = Number.parseInt(process.env.DEAD_RETRY_MS ?? '3600000', 10); // 1h
const failCounter = new Map();
const shouldFailLog = (key) => {
    const n = (failCounter.get(key) ?? 0) + 1;
    failCounter.set(key, n);
    return n <= FAIL_THRESHOLD || (n % SILENCE_EVERY === 0);
};
const clearFailCounter = (key) => failCounter.delete(key);

const readSyncignore = async (wsDir) => {
    let userRules = [];
    try {
        const txt = await readFile(path.join(wsDir, '.syncignore'), 'utf8');
        userRules = compileIgnore(txt);
    } catch { /* sin .syncignore */ }
    return [...BUILTIN_IGNORE_RULES, ...userRules];
};

// Caché de hashes por (path, mtimeMs, size). Si nada cambia (mtime ni size),
// reutilizamos el hash del último cómputo en vez de leer 22+ MB cada ciclo.
// Crítico para evitar el "ghost-push" de PDFs grandes: readFile() ocasionalmente
// devolvía buffers con sha256 inestable, dando localChanged=true sin razón.
const hashCache = new Map();

const walkLocal = async (wsDir) => {
    const out = new Map();
    const visit = async (dir, rel) => {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            const fullPath = path.join(dir, e.name);
            const relPath = rel ? `${rel}/${e.name}` : e.name;
            if (isHardSkipped(relPath)) continue;
            if (e.isDirectory()) {
                await visit(fullPath, relPath);
            } else if (e.isFile()) {
                try {
                    const st = await stat(fullPath);
                    const cacheKey = `${fullPath}`;
                    const cached = hashCache.get(cacheKey);
                    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
                        out.set(relPath, { hash: cached.hash, size: st.size, getBuf: () => readFile(fullPath) });
                        continue;
                    }
                    const buf = await readFile(fullPath);
                    const hash = sha256(buf);
                    hashCache.set(cacheKey, { mtimeMs: st.mtimeMs, size: buf.length, hash });
                    out.set(relPath, { buf, hash, size: buf.length, getBuf: async () => buf });
                } catch (err) {
                    verbose('walkLocal read fail', relPath, err.message);
                }
            }
        }
    };
    await visit(wsDir, '');
    return out;
};

const guessContentType = (name) => {
    const lower = name.toLowerCase();
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
    if (lower.endsWith('.json')) return 'application/json';
    if (lower.endsWith('.txt') || lower.endsWith('.log') || lower.endsWith('.st')) return 'text/plain';
    if (lower.endsWith('.html')) return 'text/html';
    if (lower.endsWith('.css')) return 'text/css';
    if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'application/javascript';
    return 'application/octet-stream';
};

const deleteRemote = async (token, repoPath) => {
    const headers = { ...authHeaders(token), 'Content-Type': 'application/json' };
    return fetchJson(`${HUB_URL}/api/sync/worker-delete`, {
        method: 'POST', headers,
        body: JSON.stringify({ repoPath })
    });
};

const pushFile = async (token, repoPath, info) => {
    const headers = { ...authHeaders(token), 'Content-Type': 'application/json' };
    const contentType = guessContentType(repoPath);
    const upload = await fetchJson(`${HUB_URL}/api/sync/worker-upload-url`, {
        method: 'POST', headers,
        body: JSON.stringify({ repoPath, contentType })
    });
    const buf = info.buf ?? (info.getBuf ? await info.getBuf() : null);
    if (!buf) throw new Error('no buffer');
    const putRes = await fetch(upload.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: buf
    });
    if (!putRes.ok) throw new Error(`MinIO PUT HTTP ${putRes.status}`);
    const commit = await fetchJson(`${HUB_URL}/api/sync/worker-commit`, {
        method: 'POST', headers,
        body: JSON.stringify({ repoPath, contentHash: info.hash, size: info.size, mimeType: contentType })
    });
    return commit;
};

// ── Plan + ejecución paralela por workspace ─────────────────────────────────

/**
 * Clasifica cada path en una operación. No hace I/O remota — solo compara
 * estado local, remoto y tracked. La ejecución posterior corre en paralelo
 * con `runPool(SYNC_CONCURRENCY)`.
 */
const buildPlan = (allPaths, localByPath, remoteByPath, state, isIgnored, incremental = false) => {
    const ops = [];
    for (const safe of allPaths) {
        if (isHardSkipped(safe)) { ops.push({ kind: 'skip', path: safe, reason: 'hard' }); continue; }

        const remote = remoteByPath.get(safe);
        const local = localByPath.get(safe);

        if (isIgnored(safe)) { ops.push({ kind: 'ignore', path: safe, remote, local }); continue; }

        const tracked = state[safe];
        const trackedLocal = tracked?.localHash ?? null;
        const trackedRemote = tracked?.remoteHash ?? null;

        const localChanged = !!local && local.hash !== trackedLocal;
        const remoteChanged = !!remote && remote.contentHash !== trackedRemote;
        const localDeleted = !local && !!trackedLocal;
        const remoteDeleted = !remote && !!trackedRemote;
        const isFresh = !tracked;

        if (!local && !remote) { ops.push({ kind: 'forget', path: safe }); continue; }

        // Dead-letter: path con blob 404 confirmado (doc huérfano). Sin local
        // (un edit local va por push) y mientras el hash remoto no cambie y no
        // venza la ventana de retry → skip, así no se re-pulea el 404 cada ciclo.
        // Al vencer la ventana o cambiar el hash (blob reparado) → pull de nuevo.
        if (tracked?.dead && remote && !local) {
            const sameHash = remote.contentHash === trackedRemote;
            const retryDue = (Date.now() - (tracked.deadAt || 0)) >= DEAD_RETRY_MS;
            if (sameHash && !retryDue) { ops.push({ kind: 'skip', path: safe, reason: 'dead-letter' }); continue; }
            ops.push({ kind: 'pull', path: safe, remote });
            continue;
        }

        // Server gana: cambio remoto (o archivo nuevo en NAS) → pull aunque haya cambio local.
        // Si ADEMÁS el local cambió (conflicto a 3 vías) marcamos conflict para
        // respaldar el local antes de sobrescribirlo (en vez de perderlo en silencio).
        if (remoteChanged || (isFresh && remote && !local)) {
            const conflict = !!(local && localChanged);
            ops.push({ kind: 'pull', path: safe, remote, conflict, local: conflict ? local : null });
            continue;
        }

        if (remoteDeleted && local && !incremental) {
            ops.push({ kind: 'del-local', path: safe });
            continue;
        }

        if (localChanged || (isFresh && local && !remote)) {
            ops.push({ kind: 'push', path: safe, local });
            continue;
        }

        if (localDeleted && remote) {
            ops.push({ kind: 'del-remote', path: safe });
            continue;
        }

        ops.push({ kind: 'noop', path: safe, local, remote });
    }
    return ops;
};

const executeOp = async (op, ctx) => {
    const { wsId, token, wsDir, state } = ctx;
    const safe = op.path;
    const t0 = Date.now();

    const measure = (kind, ok) => {
        const dt = Date.now() - t0;
        opDuration.observe({ op: kind }, dt);
        ctx.latencies.push(dt);
        filesProcessed.inc({ op: kind, result: ok ? 'ok' : 'fail' });
    };

    switch (op.kind) {
        case 'skip':
            ctx.counts.skipped++;
            return;
        case 'ignore': {
            if (op.remote) {
                try {
                    await deleteRemote(token, safe);
                    ctx.counts.purged++;
                    verbose('  ✗', safe, '(by .syncignore)');
                } catch (e) {
                    verbose('purge fail', safe, e.message);
                }
            }
            if (op.local) {
                try { await rm(path.join(wsDir, safe), { force: true }); } catch { /* noop */ }
            }
            delete state[safe];
            return;
        }
        case 'forget':
            delete state[safe];
            return;
        case 'pull': {
            const remote = op.remote;
            if (!remote.signedUrl) { ctx.counts.failed++; measure('pull', false); return; }
            try {
                const buf = await fetchBuf(remote.signedUrl);
                const fullPath = path.join(wsDir, safe);
                await mkdir(path.dirname(fullPath), { recursive: true });
                // Conflicto a 3 vías (local editado + remoto cambió): server gana,
                // pero respaldamos el local en .agora-conflicts/ (HARD_SKIP, no
                // sincroniza) para que el usuario no pierda su edición.
                if (op.conflict) {
                    try {
                        const bdir = path.join(wsDir, '.agora-conflicts');
                        await mkdir(bdir, { recursive: true });
                        await copyFile(fullPath, path.join(bdir, `${safe.replace(/\//g, '__')}.${Date.now()}`));
                        ctx.counts.conflicts = (ctx.counts.conflicts || 0) + 1;
                        log('  ⚠ conflicto', safe, '→ local respaldado en .agora-conflicts/');
                    } catch (be) { verbose('conflict backup fail', safe, be.message); }
                }
                await writeFile(fullPath, buf);
                const newHash = sha256(buf);
                state[safe] = { localHash: newHash, remoteHash: remote.contentHash };
                clearFailCounter(`pull:${wsId}:${safe}`);
                ctx.counts.downloaded++;
                bytesTransferred.inc({ direction: 'down' }, buf.length);
                measure('pull', true);
                verbose('  ↓', safe);
            } catch (e) {
                ctx.counts.failed++;
                measure('pull', false);
                // Dead-letter SOLO en 404/410 (blob confirmado ausente). NUNCA en
                // 5xx/timeout/red (transitorio) — esos deben reintentarse normal.
                if (DEAD_LETTER && (e.httpStatus === 404 || e.httpStatus === 410)) {
                    state[safe] = { localHash: null, remoteHash: remote.contentHash, dead: true, deadAt: Date.now() };
                }
                if (shouldFailLog(`pull:${wsId}:${safe}`)) log('  pull fail', safe, e.message);
            }
            return;
        }
        case 'del-local': {
            try {
                await rm(path.join(wsDir, safe), { force: true });
                delete state[safe];
                ctx.counts.deletedLocal++;
                measure('del_local', true);
                verbose('  ✗ local', safe);
            } catch (e) {
                ctx.counts.failed++;
                measure('del_local', false);
                if (shouldFailLog(`del-local:${wsId}:${safe}`)) log('  delete-local fail', safe, e.message);
            }
            return;
        }
        case 'push': {
            const local = op.local;
            try {
                const result = await pushFile(token, safe, local);
                state[safe] = { localHash: local.hash, remoteHash: local.hash };
                clearFailCounter(`push:${wsId}:${safe}`);
                ctx.counts.uploaded++;
                if (result.created) ctx.counts.created++;
                bytesTransferred.inc({ direction: 'up' }, local.size ?? 0);
                measure('push', true);
                verbose('  ↑', safe, result.created ? '(NEW)' : `v${result.version}`);
            } catch (e) {
                ctx.counts.failed++;
                measure('push', false);
                if (shouldFailLog(`push:${wsId}:${safe}`)) log('  push fail', safe, e.message);
            }
            return;
        }
        case 'del-remote': {
            try {
                await deleteRemote(token, safe);
                delete state[safe];
                ctx.counts.deletedRemote++;
                measure('del_remote', true);
                verbose('  ✗ remoto', safe);
            } catch (e) {
                ctx.counts.failed++;
                measure('del_remote', false);
                if (shouldFailLog(`del-remote:${wsId}:${safe}`)) log('  delete-remote fail', safe, e.message);
            }
            return;
        }
        case 'noop': {
            if (op.local && op.remote) {
                state[safe] = { localHash: op.local.hash, remoteHash: op.remote.contentHash };
            }
            ctx.counts.skipped++;
            return;
        }
    }
};

const syncOne = async (wsId) => {
    const cycleStart = Date.now();
    const wsDir = path.join(BASE_DIR, wsId);
    await mkdir(wsDir, { recursive: true });

    // Resolver el token real del worker (puede tener prefijo `personal:`).
    const token = await resolveWorkerToken(wsId);

    // worker-list pagina por `updatedAt asc` (los más nuevos quedan al final),
    // así que un workspace con > limit docs deja los archivos recién editados
    // en la web fuera de la primera página. Hay que seguir `nextCursor` hasta
    // agotar la lista, o el plan ve un remoto parcial y trata los docs no
    // vistos como borrados (del-local) → pérdida de datos y pull roto.
    //
    // `since=<unixMs>` le pide al servidor sólo los docs con updatedAt > since.
    // En el primer ciclo (sin valor previo) se envía since=0 equivalente a full
    // scan. Tras un ciclo exitoso se guarda el máximo updatedAt visto para que
    // los ciclos siguientes sólo lean lo nuevo — reducción drástica de Firestore
    // reads en workspaces estables.
    // del-local sólo es seguro en scan completo (since=0): ahí remoteByPath tiene
    // TODOS los docs, así que la ausencia de un path = borrado real en la web. En
    // incremental (since>0) worker-list trae sólo lo nuevo, por lo que la ausencia
    // NO implica borrado. Por eso forzamos un full-reconcile cada FULL_RECONCILE_EVERY
    // ciclos: sin esto un borrado en la web nunca se propaga al worker (sólo en el
    // primer ciclo post-arranque). La paginación incompleta sigue abortando antes de
    // buildPlan (más abajo), así que el full-scan nunca dispara del-local sobre remoto parcial.
    const reconcileN = reconcileCounter.get(wsId) ?? 0;
    reconcileCounter.set(wsId, reconcileN + 1);
    const fullReconcile = reconcileN % FULL_RECONCILE_EVERY === 0;
    const sinceMs = fullReconcile ? 0 : (lastSyncMs.get(wsId) ?? 0);
    const remoteByPath = new Map();
    let cursor = null;
    let pages = 0;
    let maxUpdatedAt = sinceMs; // acumula el máximo updatedAt de los items recibidos
    const MAX_PAGES = 1000; // 1000 × 2000 = 2M docs, tope de seguridad anti-loop.
    do {
        const url = new URL(`${HUB_URL}/api/sync/worker-list`);
        url.searchParams.set('workspaceId', token);
        url.searchParams.set('since', String(sinceMs));
        if (cursor) url.searchParams.set('cursor', cursor);
        verbose(`  worker-list fetch ${wsId} since=${sinceMs}${cursor ? ` cursor=${cursor.slice(0,8)}…` : ''}`);
        const data = await fetchJson(url.toString(), { headers: authHeaders(token) });
        if (!Array.isArray(data.items)) { log(wsId, 'respuesta inesperada'); return; }
        for (const i of data.items) {
            remoteByPath.set(i.repoPath, i);
            // `updatedAt` puede venir como número unix ms o como Firestore Timestamp
            // serializado como objeto `{ _seconds, _nanoseconds }` o string ISO.
            if (i.updatedAt) {
                let ts = 0;
                if (typeof i.updatedAt === 'number') ts = i.updatedAt;
                else if (typeof i.updatedAt === 'string') ts = new Date(i.updatedAt).getTime();
                else if (i.updatedAt._seconds) ts = i.updatedAt._seconds * 1000;
                if (ts > maxUpdatedAt) maxUpdatedAt = ts;
            }
        }
        cursor = typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null;
    } while (cursor && ++pages < MAX_PAGES);
    if (cursor) {
        // No agotamos la paginación: el remoto está incompleto. Abortar el ciclo
        // ANTES de buildPlan para no disparar del-local sobre los docs no vistos.
        log(wsId, `worker-list excedió ${MAX_PAGES} páginas — abortando ciclo (remoto incompleto)`);
        return;
    }
    // Actualizar lastSyncMs para el próximo ciclo. Si no recibimos ningún item
    // (workspace sin cambios desde `sinceMs`) usamos Date.now() para avanzar la
    // ventana igualmente.
    lastSyncMs.set(wsId, maxUpdatedAt > sinceMs ? maxUpdatedAt : Date.now());

    const localByPath = await walkLocal(wsDir);
    const rawState = await readState(wsDir);
    // El state legacy era `{ path: hashString }`; lo migramos sobre la marcha al
    // formato dual `{ path: { localHash, remoteHash } }` la primera vez.
    const state = {};
    for (const [k, v] of Object.entries(rawState)) {
        state[k] = typeof v === 'string' ? { localHash: v, remoteHash: v } : v;
    }
    // .syncignore se aplica DESPUÉS del walk para que el archivo `.syncignore`
    // mismo se sincronice (jamás se ignora a sí mismo).
    const ignoreRules = await readSyncignore(wsDir);
    const isIgnored = (relPath) => isWorkspacePathIgnored(ignoreRules, relPath);

    // Conjunto canónico de paths a procesar: union(local ∪ remote ∪ tracked).
    const allPaths = new Set([
        ...localByPath.keys(),
        ...remoteByPath.keys(),
        ...Object.keys(state)
    ]);

    const ops = buildPlan(allPaths, localByPath, remoteByPath, state, isIgnored, sinceMs > 0);
    queueDepth.set({ wsId }, ops.length);

    const ctx = {
        wsId, token, wsDir, state,
        counts: { downloaded: 0, uploaded: 0, skipped: 0, failed: 0, created: 0, purged: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0 },
        latencies: []
    };

    await runPool(ops, (op) => executeOp(op, ctx), SYNC_CONCURRENCY);

    await writeState(wsDir, state);

    const { downloaded, uploaded, skipped, failed, created, purged, deletedLocal, deletedRemote, conflicts } = ctx.counts;
    const cycleDurationMs = Date.now() - cycleStart;
    lastCycleTs.set({ wsId }, Math.floor(Date.now() / 1000));
    lastCycleDuration.set({ wsId }, cycleDurationMs);
    cyclesTotal.inc({ result: failed > 0 ? 'partial' : 'ok' });

    const cycleEvt = {
        evt: 'sync-cycle',
        ts: new Date().toISOString(),
        wsId,
        downloaded, uploaded, skipped, failed, created, purged,
        deletedLocal, deletedRemote, conflicts,
        queueDepth: ops.length,
        concurrency: SYNC_CONCURRENCY,
        cycleDurationMs,
        p50Ms: percentile(ctx.latencies, 50),
        p95Ms: percentile(ctx.latencies, 95)
    };

    if (downloaded || uploaded || failed || purged || deletedLocal || deletedRemote || conflicts) {
        const delPart = (deletedLocal || deletedRemote) ? ` ✗L${deletedLocal} ✗R${deletedRemote}` : '';
        log(`${wsId} → ↓${downloaded} ↑${uploaded}${created ? ` (${created} nuevos)` : ''}${purged ? ` purg:${purged}` : ''}${delPart} skip:${skipped} fail:${failed} (${cycleDurationMs}ms)`);
        console.log(JSON.stringify(cycleEvt));
    } else {
        verbose(`${wsId} → al día (${cycleDurationMs}ms)`);
        if (VERBOSE) console.log(JSON.stringify(cycleEvt));
    }
};

const runConcurrent = async (items, fn, limit) => {
    const results = await runPool(items, fn, limit);
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r && !r.ok) log('worker', items[i], 'error:', r.error.message);
    }
};

const main = async () => {
    log(`agora-host-sync iniciado. Hub=${HUB_URL} POLL=${POLL_MS}ms CONCURRENCY=${CONCURRENCY} SYNC_CONCURRENCY=${SYNC_CONCURRENCY}`);
    startMetricsServer();
    while (true) {
        try {
            const revived = await reviveExitedWorkers();
            if (revived > 0) await new Promise(r => setTimeout(r, 3000));
            const tokens = await listWorkers();
            workersActive.set({}, tokens.length);
            verbose(`workers activos: ${tokens.length}`);
            await runConcurrent(tokens, syncOne, CONCURRENCY);
        } catch (e) {
            log('main loop error:', e.message);
        }
        await new Promise(r => setTimeout(r, POLL_MS));
    }
};

main().catch((e) => { console.error(e); process.exit(1); });
