/**
 * Registry minimalista compatible con Prometheus text format.
 * Sin deps — emitimos texto a mano. Suficiente para counters, gauges
 * e histograms con buckets fijos. Lo expone el daemon en :9090/metrics.
 *
 * Format: https://prometheus.io/docs/instrumenting/exposition_formats/
 */

const escapeLabelValue = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

const labelKey = (labels) => {
    if (!labels) return '';
    const keys = Object.keys(labels).sort();
    return keys.map(k => `${k}="${escapeLabelValue(labels[k])}"`).join(',');
};

const renderLabels = (key) => key ? `{${key}}` : '';

class Counter {
    constructor(name, help) {
        this.name = name;
        this.help = help;
        this.values = new Map(); // labelKey -> { labels, value }
    }
    inc(labels = {}, by = 1) {
        const key = labelKey(labels);
        const cur = this.values.get(key);
        if (cur) cur.value += by;
        else this.values.set(key, { labels: { ...labels }, value: by });
    }
    render() {
        const lines = [];
        if (this.help) lines.push(`# HELP ${this.name} ${this.help}`);
        lines.push(`# TYPE ${this.name} counter`);
        for (const [key, { value }] of this.values) {
            lines.push(`${this.name}${renderLabels(key)} ${value}`);
        }
        return lines;
    }
}

class Gauge {
    constructor(name, help) {
        this.name = name;
        this.help = help;
        this.values = new Map();
    }
    set(labels, value) {
        const key = labelKey(labels);
        this.values.set(key, { labels: { ...labels }, value });
    }
    render() {
        const lines = [];
        if (this.help) lines.push(`# HELP ${this.name} ${this.help}`);
        lines.push(`# TYPE ${this.name} gauge`);
        for (const [key, { value }] of this.values) {
            lines.push(`${this.name}${renderLabels(key)} ${value}`);
        }
        return lines;
    }
}

class Histogram {
    constructor(name, help, buckets) {
        this.name = name;
        this.help = help;
        this.buckets = buckets.slice().sort((a, b) => a - b);
        this.series = new Map(); // labelKey -> { labels, counts: number[], sum, count }
    }
    observe(labels, value) {
        const key = labelKey(labels);
        let s = this.series.get(key);
        if (!s) {
            s = { labels: { ...labels }, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
            this.series.set(key, s);
        }
        for (let i = 0; i < this.buckets.length; i++) {
            if (value <= this.buckets[i]) s.counts[i]++;
        }
        s.sum += value;
        s.count++;
    }
    render() {
        const lines = [];
        if (this.help) lines.push(`# HELP ${this.name} ${this.help}`);
        lines.push(`# TYPE ${this.name} histogram`);
        for (const [, s] of this.series) {
            const baseLabelEntries = Object.entries(s.labels);
            for (let i = 0; i < this.buckets.length; i++) {
                const labelStr = [
                    ...baseLabelEntries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`),
                    `le="${this.buckets[i]}"`
                ].join(',');
                lines.push(`${this.name}_bucket{${labelStr}} ${s.counts[i]}`);
            }
            const infLabel = [
                ...baseLabelEntries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`),
                `le="+Inf"`
            ].join(',');
            lines.push(`${this.name}_bucket{${infLabel}} ${s.count}`);
            const baseLabelKey = labelKey(s.labels);
            lines.push(`${this.name}_sum${renderLabels(baseLabelKey)} ${s.sum}`);
            lines.push(`${this.name}_count${renderLabels(baseLabelKey)} ${s.count}`);
        }
        return lines;
    }
}

export class MetricsRegistry {
    constructor() {
        this.metrics = new Map();
    }
    counter(name, help) {
        let m = this.metrics.get(name);
        if (!m) { m = new Counter(name, help); this.metrics.set(name, m); }
        return m;
    }
    gauge(name, help) {
        let m = this.metrics.get(name);
        if (!m) { m = new Gauge(name, help); this.metrics.set(name, m); }
        return m;
    }
    histogram(name, help, buckets) {
        let m = this.metrics.get(name);
        if (!m) { m = new Histogram(name, help, buckets); this.metrics.set(name, m); }
        return m;
    }
    render() {
        const lines = [];
        for (const m of this.metrics.values()) lines.push(...m.render());
        return lines.join('\n') + '\n';
    }
}

/**
 * Calcula percentil aproximado a partir de un array de muestras (ms).
 * Para el log JSON por ciclo. No persistente entre ciclos.
 */
export const percentile = (samples, p) => {
    if (samples.length === 0) return null;
    const sorted = samples.slice().sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
    return sorted[idx];
};
