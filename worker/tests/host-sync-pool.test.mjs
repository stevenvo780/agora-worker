import test from 'node:test';
import assert from 'node:assert/strict';
import { runPool } from '../../worker-host-sync/pool.mjs';

test('runPool ejecuta todas las tasks y retorna resultados en orden', async () => {
    const items = [10, 20, 30, 40, 50];
    const results = await runPool(items, async (n) => n * 2, 3);
    assert.equal(results.length, 5);
    assert.deepEqual(results.map(r => r.value), [20, 40, 60, 80, 100]);
    assert.ok(results.every(r => r.ok));
});

test('runPool respeta el límite de concurrencia', async () => {
    const limit = 3;
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runPool(items, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
    }, limit);
    assert.ok(peak <= limit, `peak ${peak} > limit ${limit}`);
    assert.ok(peak > 1, 'pool no paralelizó');
});

test('runPool no aborta cuando una task falla', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runPool(items, async (n) => {
        if (n === 3) throw new Error('boom');
        return n;
    }, 2);
    assert.equal(results.length, 5);
    assert.equal(results[2].ok, false);
    assert.match(results[2].error.message, /boom/);
    assert.ok(results.filter(r => r.ok).length === 4);
});

test('runPool con array vacío retorna []', async () => {
    const results = await runPool([], async () => 1, 4);
    assert.deepEqual(results, []);
});

test('runPool tolera duplicados (mismo item, distintas tasks)', async () => {
    const items = ['a', 'a', 'a'];
    const seen = [];
    const results = await runPool(items, async (it, idx) => { seen.push(idx); return it; }, 2);
    assert.equal(results.length, 3);
    assert.deepEqual(seen.sort(), [0, 1, 2]);
});
