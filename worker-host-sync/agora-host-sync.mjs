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
import { mkdir, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';

const HUB_URL = process.env.AGORA_HUB_URL ?? 'https://agora.elenxos.com';
const WORKER_SECRET = process.env.WORKER_SECRET;
const BASE_DIR = process.env.BASE_DIR ?? '/home/stev/edu-worker/workspaces';
const POLL_MS = Number.parseInt(process.env.POLL_MS ?? '5000', 10);
const VERBOSE = process.env.VERBOSE === '1';
// Archivos creados por el entrypoint o internos al daemon — no sincronizar.
const SKIP_PREFIXES = ['.git/', 'repos/', '.agora-host-sync.json', '.syncignore', '.st-guide.md'];
const SKIP_EXACT = new Set(['.git', 'repos', '.agora-host-sync.json', '.syncignore', '.st-guide.md']);

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

const isSkipped = (relPath) => {
    if (SKIP_EXACT.has(relPath)) return true;
    return SKIP_PREFIXES.some(p => relPath === p || relPath.startsWith(p));
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
            if (isSkipped(relPath)) continue;
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
    const state = await readState(wsDir);
    let downloaded = 0, uploaded = 0, skipped = 0, failed = 0, created = 0;

    for (const [repoPath, item] of remoteByPath) {
        const safe = repoPath.replace(/^\/+/, '');
        if (isSkipped(safe)) { skipped++; continue; }
        const local = localByPath.get(safe);
        const tracked = state[safe];

        if (local && local.hash === item.contentHash) {
            state[safe] = item.contentHash;
            skipped++;
            continue;
        }
        // Local cambió pero remoto sigue igual → lo gestiona la fase de push.
        if (local && tracked && local.hash !== tracked && item.contentHash === tracked) {
            continue;
        }
        if (!item.signedUrl) { failed++; continue; }
        try {
            const buf = await fetchBuf(item.signedUrl);
            const localPath = path.join(wsDir, safe);
            await mkdir(path.dirname(localPath), { recursive: true });
            await writeFile(localPath, buf);
            state[safe] = sha256(buf);
            localByPath.set(safe, { buf, hash: state[safe], size: buf.length });
            downloaded++;
            verbose('  ↓', safe);
        } catch (e) {
            failed++;
            log('  pull fail', safe, e.message);
        }
    }

    for (const [repoPath, info] of localByPath) {
        if (isSkipped(repoPath)) continue;
        const tracked = state[repoPath];
        const remote = remoteByPath.get(repoPath);
        if (remote && remote.contentHash === info.hash) { state[repoPath] = info.hash; continue; }
        if (tracked && tracked === info.hash) continue;
        try {
            const result = await pushFile(wsId, repoPath, info);
            state[repoPath] = info.hash;
            uploaded++;
            if (result.created) created++;
            verbose('  ↑', repoPath, result.created ? '(NEW)' : `v${result.version}`);
        } catch (e) {
            failed++;
            log('  push fail', repoPath, e.message);
        }
    }

    for (const k of Object.keys(state)) {
        if (!remoteByPath.has(k) && !localByPath.has(k)) delete state[k];
    }
    await writeState(wsDir, state);

    if (downloaded || uploaded || failed) {
        log(`${wsId} → ↓${downloaded} ↑${uploaded}${created ? ` (${created} nuevos)` : ''} skip:${skipped} fail:${failed}`);
    } else {
        verbose(`${wsId} → al día`);
    }
};

const main = async () => {
    log(`agora-host-sync iniciado. Hub=${HUB_URL} POLL=${POLL_MS}ms`);
    while (true) {
        try {
            const revived = await reviveExitedWorkers();
            if (revived > 0) await new Promise(r => setTimeout(r, 3000));
            const tokens = await listWorkers();
            verbose(`workers activos: ${tokens.length}`);
            for (const tok of tokens) {
                try { await syncOne(tok); }
                catch (e) { log('worker', tok, 'error:', e.message); }
            }
        } catch (e) {
            log('main loop error:', e.message);
        }
        await new Promise(r => setTimeout(r, POLL_MS));
    }
};

main().catch((e) => { console.error(e); process.exit(1); });
