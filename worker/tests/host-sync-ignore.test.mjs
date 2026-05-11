/**
 * Test del módulo ignore.mjs del daemon agora-host-sync.
 *
 * Bug I-2 (fallback B): paths efímeros usados por el agente IA y el usuario
 * (.scratch/, .agent-tmp/, tmp-*) NO deben ser eliminados por el daemon
 * cuando no están en MinIO/Firestore. Antes, el agente creaba un archivo via
 * run_worker_command (`echo > /workspace/notes.txt`) y ~10s después el daemon
 * lo purgaba por considerarlo huérfano. Solución: convención de prefijos
 * efímeros documentada + ignore rules hard-skip / builtin.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    HARD_SKIP,
    BUILTIN_IGNORE_RULES,
    isHardSkipped,
    isWorkspacePathIgnored,
    matchIgnore,
    compileIgnore
} from '../../worker-host-sync/ignore.mjs';

test('Bug I-2: HARD_SKIP incluye .scratch/ y .agent-tmp/', () => {
    assert.ok(HARD_SKIP.includes('.scratch/'), '.scratch/ debe estar en HARD_SKIP');
    assert.ok(HARD_SKIP.includes('.agent-tmp/'), '.agent-tmp/ debe estar en HARD_SKIP');
});

test('Bug I-2: archivos bajo .scratch/ son hard-skipped', () => {
    assert.equal(isHardSkipped('.scratch/notes.txt'), true);
    assert.equal(isHardSkipped('.scratch/sub/nested.md'), true);
    assert.equal(isHardSkipped('.scratch'), true);
});

test('Bug I-2: archivos bajo .agent-tmp/ son hard-skipped', () => {
    assert.equal(isHardSkipped('.agent-tmp/foo.txt'), true);
    assert.equal(isHardSkipped('.agent-tmp/build/x.log'), true);
});

test('Bug I-2: BUILTIN ignora prefijo tmp-* en root', () => {
    assert.equal(matchIgnore(BUILTIN_IGNORE_RULES, 'tmp-notes.md'), true);
    assert.equal(matchIgnore(BUILTIN_IGNORE_RULES, 'tmp-build.log'), true);
});

test('Bug I-2: BUILTIN ignora prefijo tmp-* en subdirs', () => {
    assert.equal(matchIgnore(BUILTIN_IGNORE_RULES, 'sub/tmp-foo.txt'), true);
});

test('Bug I-2: BUILTIN ignora *.tmp', () => {
    assert.equal(matchIgnore(BUILTIN_IGNORE_RULES, 'foo.tmp'), true);
    assert.equal(matchIgnore(BUILTIN_IGNORE_RULES, 'sub/bar.tmp'), true);
});

test('Bug I-2: archivos normales NO son ignorados (sanity)', () => {
    assert.equal(isHardSkipped('notes.md'), false);
    assert.equal(isHardSkipped('docs/algo.md'), false);
    assert.equal(matchIgnore(BUILTIN_IGNORE_RULES, 'notes.md'), false);
    assert.equal(matchIgnore(BUILTIN_IGNORE_RULES, 'algo-tmp.md'), false, 'sufijo -tmp no debe matchear');
});

test('Bug I-2: .syncignore y .gitignore SIEMPRE sincronizan (no ignorables)', () => {
    const rules = [
        ...BUILTIN_IGNORE_RULES,
        ...compileIgnore('*.log\n.syncignore\n.gitignore')
    ];
    // Aunque haya regla explícita, isWorkspacePathIgnored los protege.
    assert.equal(isWorkspacePathIgnored(rules, '.syncignore'), false);
    assert.equal(isWorkspacePathIgnored(rules, '.gitignore'), false);
});

test('Bug I-2: temporales de editor siguen ignorados (regresión)', () => {
    assert.equal(matchIgnore(BUILTIN_IGNORE_RULES, 'foo.swp'), true);
    assert.equal(matchIgnore(BUILTIN_IGNORE_RULES, 'foo~'), true);
    assert.equal(matchIgnore(BUILTIN_IGNORE_RULES, '.DS_Store'), true);
});
