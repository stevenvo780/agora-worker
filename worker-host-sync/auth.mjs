/**
 * HMAC auth para agora-host-sync. Match exacto de
 * src/lib/worker-auth.ts del Hub: si esto se desfasa, los workers
 * empiezan a recibir 401 en silencio.
 */
import { createHmac } from 'node:crypto';

export const sign = (workerSecret, workspaceId, ts, userId) =>
    createHmac('sha256', workerSecret)
        .update(`${workspaceId}:${ts}${userId ? `:${userId}` : ''}`)
        .digest('hex');

export const buildAuthHeaders = (workerSecret, wsId, userId = null) => {
    const ts = Date.now();
    let uid = userId;
    if (!uid && wsId.startsWith('personal:')) uid = wsId.slice('personal:'.length);
    const headers = {
        'X-Worker-Token': wsId,
        'X-Worker-Ts': String(ts),
        'X-Worker-Sig': sign(workerSecret, wsId, ts, uid)
    };
    if (uid) headers['X-Worker-Uid'] = uid;
    return headers;
};
