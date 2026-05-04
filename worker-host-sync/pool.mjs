/**
 * Pool de concurrencia minimalista. Sin deps externas — el daemon vive en
 * un solo subdir deployado con `cp`, queremos seguir igual.
 *
 * Garantías:
 *  - máximo `limit` tasks ejecutándose en paralelo.
 *  - una task que lanza no aborta las demás (cada una se atrapa).
 *  - resultado en el mismo orden que `items`: `{ ok: true, value }` o `{ ok: false, error }`.
 *  - FIFO por construcción (consumimos por índice creciente).
 */
export const runPool = async (items, fn, limit) => {
    if (!Array.isArray(items)) throw new TypeError('runPool: items must be array');
    const total = items.length;
    if (total === 0) return [];
    const results = new Array(total);
    const cap = Math.max(1, Math.min(Number(limit) || 1, total));
    let nextIndex = 0;

    const worker = async () => {
        while (true) {
            const idx = nextIndex++;
            if (idx >= total) return;
            const item = items[idx];
            try {
                const value = await fn(item, idx);
                results[idx] = { ok: true, value };
            } catch (error) {
                results[idx] = { ok: false, error };
            }
        }
    };

    const workers = Array.from({ length: cap }, () => worker());
    await Promise.all(workers);
    return results;
};
