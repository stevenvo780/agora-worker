#!/usr/bin/env node
/**
 * Pide al backend las credenciales git del workspace (auth HMAC worker, mismo
 * esquema que el daemon de sync) y las escribe en /tmp/agora-git-creds.env para
 * que el entrypoint configure el remote Forgejo on-demand.
 *
 * No es fatal: si algo falla, el worker arranca igual (sólo no queda git listo).
 */
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';

const OUT = '/tmp/agora-git-creds.env';
const token = process.env.WORKER_TOKEN;
const secret = process.env.WORKER_SYNC_SECRET || process.env.WORKER_SECRET;
const backend = (process.env.AGORA_BACKEND_URL || '').replace(/\/$/, '');

if (!token || !secret || !backend) process.exit(0);

const userId = token.startsWith('personal:') ? token.slice('personal:'.length) : null;
const ts = Date.now();
const uidPart = userId ? `:${userId}` : '';
const sig = crypto.createHmac('sha256', secret).update(`${token}:${ts}${uidPart}`).digest('hex');

const headers = {
  'X-Worker-Token': token,
  'X-Worker-Ts': String(ts),
  'X-Worker-Sig': sig,
  Accept: 'application/json'
};
if (userId) headers['X-Worker-Uid'] = userId;

try {
  const res = await fetch(`${backend}/api/sync/worker-git-info`, { headers });
  if (!res.ok) {
    console.error(`[git-creds] HTTP ${res.status}`);
    process.exit(0);
  }
  const body = await res.json();
  if (!body || !body.cloneUrl || !body.gitUser || !body.gitToken) process.exit(0);
  // cloneUrl es una URL https limpia, gitUser alnum-dash, gitToken hex sha1:
  // valores seguros para env-file sin comillas ni escaping.
  const lines = [
    `AGORA_WORKSPACE_REPO=${body.cloneUrl}`,
    `AGORA_GIT_USER=${body.gitUser}`,
    `AGORA_GIT_TOKEN=${body.gitToken}`,
    `AGORA_GIT_EMAIL=${body.gitUser}@noreply.agora.local`
  ];
  writeFileSync(OUT, lines.join('\n') + '\n', { mode: 0o600 });
} catch (e) {
  console.error('[git-creds]', e?.message || String(e));
}
process.exit(0);
