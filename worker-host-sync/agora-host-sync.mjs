#!/usr/bin/env node
/**
 * agora-host-sync — daemon en el host del worker que mantiene el directorio
 * `/home/stev/edu-worker/workspaces/<wsId>/` (montado como `/workspace` en el
 * contenedor) espejado con la workspace en MinIO + Firestore.
 *
 * Bidireccional. Pull cada 5s vía /api/sync/worker-list, push cuando detecta
 * diffs locales. Auth HMAC con WORKER_SECRET. Conflicto a 3 vías → gana el
 * server (source of truth).
 */
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, writeFile, readFile, stat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const HUB_URL = process.env.AGORA_HUB_URL ?? 'https://agora.elenxos.com';
const WORKER_SECRET = process.env.WORKER_SECRET;
const BASE_DIR = process.env.BASE_DIR ?? '/home/stev/edu-worker/workspaces';
const POLL_MS = Number.parseInt(process.env.POLL_MS ?? '5000', 10);
const VERBOSE = process.env.VERBOSE === '1';
// Internos al daemon o al runtime del worker — nunca tocar (en ambas direcciones).
// `.syncignore` y `.gitignore` SÍ se sincronizan: el user los edita desde la web.
const HARD_SKIP = ['.git/', 'repos/', '.agora-host-sync.json', '.st-guide.md'];

// Reglas intrínsecas que se aplican aunque el `.syncignore` del workspace no
// las liste. Cubren archivos temporales de editores que NUNCA deben llegar
// al NAS (vim swap, lockfiles de LibreOffice, etc.). Siempre activas.
const BUILTIN_IGNORE_TEXT = [
    '*.swp', '*.swo', '*.swn',
    '*~',
    '.~lock.*', '.#*',
    '.DS_Store', 'Thumbs.db', 'desktop.ini'
].join('\n');

const compileIgnore = (txt) => {
    const lines = txt.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    return lines.map(line => {
        const negate = line.startsWith('!');
        const raw = negate ? line.slice(1) : line;
        const dirOnly = raw.endsWith('/');
        const pat = dirOnly ? raw.slice(0, -1) : raw;
        const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
        return { negate, dirOnly, regex: new RegExp(`(^|/)${escaped}(/|$)`) };
    });
};

const matchIgnore = (rules, path) => {
    let matched = false;
    for (const r of rules) {
        if (r.regex.test(path)) matched = !r.negate;
    }
    return matched;
};

const isHardSkipped = (relPath) => {
    if (!relPath) return false;
    return HARD_SKIP.some(p => relPath === p.replace(/\/$/, '') || relPath === p || relPath.startsWith(p));
};

if (!WORKER_SECRET) {
    console.error('agora-host-sync: WORKER_SECRET requerido');
    process.exit(1);
}

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const verbose = (...a) => { if (VERBOSE) log(...a); };

const sign = (workspaceId, ts) =>
    createHmac('sha256', WORKER_SECRET).update(`${workspaceId}:${ts}`).digest('hex');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const authHeaders = (wsId) => {
    const ts = Date.now();
    return {
        'X-Worker-Token': wsId,
        'X-Worker-Ts': String(ts),
        'X-Worker-Sig': sign(wsId, ts)
    };
};

const fetchJson = async (url, init = {}) => {
    const r = await fetch(url, init);
    if (!r.ok) throw new Error(`HTTP ${r.status} — ${(await r.text()).slice(0, 200)}`);
    return r.json();
};

const fetchBuf = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download HTTP ${r.status}`);
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

// Devuelve los nombres completos de contenedores `edu-worker-*` Exited.
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

const BUILTIN_IGNORE_RULES = compileIgnore(BUILTIN_IGNORE_TEXT);

// Circuit breaker: tras N fallos consecutivos del mismo path o workspace,
// dejar de intentar y solo loggear cada 30 ciclos. Evita inundar el log con
// 404s repetidos (blobs huérfanos) o 500s (workspaces que ya no existen en
// Firestore pero el contenedor sigue corriendo).
const FAIL_THRESHOLD = 3;
const SILENCE_EVERY = 30;
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
                    const buf = await readFile(fullPath);
                    out.set(relPath, { buf, hash: sha256(buf), size: buf.length });
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

const deleteRemote = async (wsId, repoPath) => {
    const headers = { ...authHeaders(wsId), 'Content-Type': 'application/json' };
    return fetchJson(`${HUB_URL}/api/sync/worker-delete`, {
        method: 'POST', headers,
        body: JSON.stringify({ repoPath })
    });
};

const pushFile = async (wsId, repoPath, info) => {
    const headers = { ...authHeaders(wsId), 'Content-Type': 'application/json' };
    const contentType = guessContentType(repoPath);
    const upload = await fetchJson(`${HUB_URL}/api/sync/worker-upload-url`, {
        method: 'POST', headers,
        body: JSON.stringify({ repoPath, contentType })
    });
    const putRes = await fetch(upload.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: info.buf
    });
    if (!putRes.ok) throw new Error(`MinIO PUT HTTP ${putRes.status}`);
    const commit = await fetchJson(`${HUB_URL}/api/sync/worker-commit`, {
        method: 'POST', headers,
        body: JSON.stringify({ repoPath, contentHash: info.hash, size: info.size, mimeType: contentType })
    });
    return commit;
};

const syncOne = async (wsId) => {
    const wsDir = path.join(BASE_DIR, wsId);
    await mkdir(wsDir, { recursive: true });

    const data = await fetchJson(
        `${HUB_URL}/api/sync/worker-list?workspaceId=${encodeURIComponent(wsId)}`,
        { headers: authHeaders(wsId) }
    );
    if (!Array.isArray(data.items)) { log(wsId, 'respuesta inesperada'); return; }
    const remoteByPath = new Map(data.items.map(i => [i.repoPath, i]));

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
    const isIgnored = (relPath) => relPath !== '.syncignore' && relPath !== '.gitignore' && matchIgnore(ignoreRules, relPath);

    let downloaded = 0, uploaded = 0, skipped = 0, failed = 0, created = 0, purged = 0;
    let deletedLocal = 0, deletedRemote = 0;

    // Conjunto canónico de paths a procesar: union(local ∪ remote ∪ tracked).
    const allPaths = new Set([
        ...localByPath.keys(),
        ...remoteByPath.keys(),
        ...Object.keys(state)
    ]);

    for (const safe of allPaths) {
        if (isHardSkipped(safe)) { skipped++; continue; }
        const remote = remoteByPath.get(safe);
        const local = localByPath.get(safe);

        // .syncignore — purga zombies del NAS y borra local si está.
        if (isIgnored(safe)) {
            if (remote) {
                try {
                    await deleteRemote(wsId, safe);
                    purged++;
                    verbose('  ✗', safe, '(by .syncignore)');
                } catch (e) {
                    verbose('purge fail', safe, e.message);
                }
            }
            if (local) {
                try { await rm(path.join(wsDir, safe), { force: true }); } catch { /* noop */ }
            }
            delete state[safe];
            continue;
        }

        const tracked = state[safe];
        const trackedLocal = tracked?.localHash ?? null;
        const trackedRemote = tracked?.remoteHash ?? null;

        const localChanged = !!local && local.hash !== trackedLocal;
        const remoteChanged = !!remote && remote.contentHash !== trackedRemote;
        const localDeleted = !local && !!trackedLocal;
        const remoteDeleted = !remote && !!trackedRemote;
        const isFresh = !tracked;

        // 1) Ambos lados borrados → limpia state.
        if (!local && !remote) { delete state[safe]; continue; }

        // 2) Cambio remoto (incluye archivo nuevo en NAS sin tracked) → pull,
        //    a menos que también haya cambio local (conflicto: server gana).
        if (remoteChanged || (isFresh && remote && !local)) {
            if (!remote.signedUrl) { failed++; continue; }
            try {
                const buf = await fetchBuf(remote.signedUrl);
                const fullPath = path.join(wsDir, safe);
                await mkdir(path.dirname(fullPath), { recursive: true });
                await writeFile(fullPath, buf);
                const newHash = sha256(buf);
                state[safe] = { localHash: newHash, remoteHash: remote.contentHash };
                clearFailCounter(`pull:${wsId}:${safe}`);
                downloaded++;
                verbose('  ↓', safe);
            } catch (e) {
                failed++;
                if (shouldFailLog(`pull:${wsId}:${safe}`)) log('  pull fail', safe, e.message);
            }
            continue;
        }

        // 3) Borrado remoto — propaga al worker.
        if (remoteDeleted && local) {
            try {
                await rm(path.join(wsDir, safe), { force: true });
                delete state[safe];
                deletedLocal++;
                verbose('  ✗ local', safe);
            } catch (e) {
                failed++;
                if (shouldFailLog(`del-local:${wsId}:${safe}`)) log('  delete-local fail', safe, e.message);
            }
            continue;
        }

        // 4) Cambio local (incluye archivo nuevo local sin tracked) → push.
        if (localChanged || (isFresh && local && !remote)) {
            try {
                const result = await pushFile(wsId, safe, local);
                state[safe] = { localHash: local.hash, remoteHash: local.hash };
                clearFailCounter(`push:${wsId}:${safe}`);
                uploaded++;
                if (result.created) created++;
                verbose('  ↑', safe, result.created ? '(NEW)' : `v${result.version}`);
            } catch (e) {
                failed++;
                if (shouldFailLog(`push:${wsId}:${safe}`)) log('  push fail', safe, e.message);
            }
            continue;
        }

        // 5) Borrado local — propaga al NAS.
        if (localDeleted && remote) {
            try {
                await deleteRemote(wsId, safe);
                delete state[safe];
                deletedRemote++;
                verbose('  ✗ remoto', safe);
            } catch (e) {
                failed++;
                if (shouldFailLog(`del-remote:${wsId}:${safe}`)) log('  delete-remote fail', safe, e.message);
            }
            continue;
        }

        // 6) Ningún cambio: refresca tracking si vale (cubre el caso de
        //    servidores con contentHash inconsistente — registramos lo que
        //    vemos sin re-descargar).
        if (local && remote) {
            state[safe] = { localHash: local.hash, remoteHash: remote.contentHash };
        }
        skipped++;
    }

    await writeState(wsDir, state);

    if (downloaded || uploaded || failed || purged || deletedLocal || deletedRemote) {
        const delPart = (deletedLocal || deletedRemote) ? ` ✗L${deletedLocal} ✗R${deletedRemote}` : '';
        log(`${wsId} → ↓${downloaded} ↑${uploaded}${created ? ` (${created} nuevos)` : ''}${purged ? ` purg:${purged}` : ''}${delPart} skip:${skipped} fail:${failed}`);
    } else {
        verbose(`${wsId} → al día`);
    }
};

const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY ?? '4', 10);

// Procesa los workspaces en paralelo con un límite de concurrencia, así un
// workspace gigante (miles de archivos) no bloquea la detección de cambios
// en los workspaces pequeños.
const runConcurrent = async (items, fn, limit) => {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            try { await fn(item); }
            catch (e) { log('worker', item, 'error:', e.message); }
        }
    });
    await Promise.all(workers);
};

const main = async () => {
    log(`agora-host-sync iniciado. Hub=${HUB_URL} POLL=${POLL_MS}ms CONCURRENCY=${CONCURRENCY}`);
    while (true) {
        try {
            const revived = await reviveExitedWorkers();
            if (revived > 0) await new Promise(r => setTimeout(r, 3000));
            const tokens = await listWorkers();
            verbose(`workers activos: ${tokens.length}`);
            await runConcurrent(tokens, syncOne, CONCURRENCY);
        } catch (e) {
            log('main loop error:', e.message);
        }
        await new Promise(r => setTimeout(r, POLL_MS));
    }
};

main().catch((e) => { console.error(e); process.exit(1); });
