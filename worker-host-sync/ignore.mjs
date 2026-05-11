/**
 * Reglas de ignore para agora-host-sync. Compatible con `.gitignore`-style:
 *  - patrones glob (`*.tmp`, `dir/*.log`)
 *  - directorio sólo (`build/`)
 *  - negación (`!keepme.txt`)
 *  - comentarios (`# ...`)
 *
 * `.syncignore` y `.gitignore` mismos NUNCA se ignoran (el user los edita
 * desde la web y deben sincronizarse).
 */

// Internos al daemon o al runtime — nunca tocar (en ambas direcciones).
// `.scratch/` y prefijo `tmp-` son convención del agente IA y del usuario para
// archivos efímeros que no deben adoptarse al NAS ni borrarse del FS (el
// daemon antes los detectaba como huérfanos y los purgaba ~10s después; Bug I-2).
export const HARD_SKIP = [
    '.git/',
    'repos/',
    '.agora-host-sync.json',
    '.st-guide.md',
    '.scratch/',
    '.agent-tmp/'
];

// Reglas intrínsecas siempre activas. Cubren temporales de editores que
// nunca deben llegar al NAS, además de prefijos `tmp-*` usados por el agente
// IA y por el usuario para scratch files (Bug I-2 fallback B).
const BUILTIN_IGNORE_TEXT = [
    '*.swp', '*.swo', '*.swn',
    '*~',
    '.~lock.*', '.#*',
    '.DS_Store', 'Thumbs.db', 'desktop.ini',
    'tmp-*',
    '*.tmp'
].join('\n');

export const compileIgnore = (txt) => {
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

export const matchIgnore = (rules, p) => {
    let matched = false;
    for (const r of rules) {
        if (r.regex.test(p)) matched = !r.negate;
    }
    return matched;
};

export const isHardSkipped = (relPath) => {
    if (!relPath) return false;
    return HARD_SKIP.some(p => relPath === p.replace(/\/$/, '') || relPath === p || relPath.startsWith(p));
};

export const BUILTIN_IGNORE_RULES = compileIgnore(BUILTIN_IGNORE_TEXT);

/**
 * `.syncignore` y `.gitignore` SIEMPRE se sincronizan — el user los edita
 * desde la web. Use esto en lugar de `matchIgnore(rules, path)` directo.
 */
export const isWorkspacePathIgnored = (rules, relPath) =>
  relPath !== '.syncignore' && relPath !== '.gitignore' && matchIgnore(rules, relPath);
