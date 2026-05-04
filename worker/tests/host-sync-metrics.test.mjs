import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsRegistry, percentile } from '../../worker-host-sync/metrics.mjs';

test('counter expone formato Prometheus válido con labels', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('agora_test_total', 'help text');
    c.inc({ op: 'pull', result: 'ok' }, 3);
    c.inc({ op: 'pull', result: 'ok' });
    c.inc({ op: 'push', result: 'fail' });
    const out = reg.render();
    assert.match(out, /# HELP agora_test_total help text/);
    assert.match(out, /# TYPE agora_test_total counter/);
    assert.match(out, /agora_test_total\{op="pull",result="ok"\} 4/);
    assert.match(out, /agora_test_total\{op="push",result="fail"\} 1/);
});

test('gauge sobrescribe el valor en lugar de acumular', () => {
    const reg = new MetricsRegistry();
    const g = reg.gauge('agora_test_gauge');
    g.set({ wsId: 'ws1' }, 5);
    g.set({ wsId: 'ws1' }, 12);
    const out = reg.render();
    assert.match(out, /agora_test_gauge\{wsId="ws1"\} 12/);
    assert.doesNotMatch(out, /agora_test_gauge\{wsId="ws1"\} 5\b/);
});

test('histogram cuenta buckets cumulativos correctamente', () => {
    const reg = new MetricsRegistry();
    const h = reg.histogram('agora_test_hist', '', [10, 100, 1000]);
    h.observe({ op: 'pull' }, 5);
    h.observe({ op: 'pull' }, 50);
    h.observe({ op: 'pull' }, 500);
    h.observe({ op: 'pull' }, 5000);
    const out = reg.render();
    // 5 ≤ 10, 50 ≤ 100, 500 ≤ 1000 ⇒ le=10:1, le=100:2, le=1000:3, le=+Inf:4
    assert.match(out, /agora_test_hist_bucket\{op="pull",le="10"\} 1/);
    assert.match(out, /agora_test_hist_bucket\{op="pull",le="100"\} 2/);
    assert.match(out, /agora_test_hist_bucket\{op="pull",le="1000"\} 3/);
    assert.match(out, /agora_test_hist_bucket\{op="pull",le="\+Inf"\} 4/);
    assert.match(out, /agora_test_hist_count\{op="pull"\} 4/);
    assert.match(out, /agora_test_hist_sum\{op="pull"\} 5555/);
});

test('percentile calcula p50 y p95 razonables', () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100];
    assert.ok(percentile(samples, 50) >= 5 && percentile(samples, 50) <= 7);
    assert.equal(percentile(samples, 95), 100);
    assert.equal(percentile([], 50), null);
});

test('label values con caracteres especiales se escapan', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('agora_test_esc');
    c.inc({ wsId: 'a"b\nc\\d' });
    const out = reg.render();
    assert.match(out, /a\\"b\\nc\\\\d/);
});
