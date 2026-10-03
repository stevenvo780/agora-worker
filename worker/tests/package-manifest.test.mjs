import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function assertLocalSource(relativePath, label) {
  const source = path.resolve(root, relativePath);
  assert.ok(existsSync(source), `${label}: falta ${relativePath} en el checkout`);
  if (statSync(source).isDirectory()) {
    assert.ok(existsSync(path.join(source, 'package.json')), `${label}: falta package.json en ${relativePath}`);
  }
}

test('package.json y package-lock.json declaran las mismas dependencias directas', () => {
  for (const field of dependencyFields) {
    assert.deepEqual(lock.packages[''][field] ?? {}, pkg[field] ?? {}, field);
  }
});

test('las dependencias file: y los enlaces del lockfile tienen su fuente local', () => {
  for (const field of dependencyFields) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (spec.startsWith('file:')) assertLocalSource(spec.slice(5), `${field}.${name}`);
    }
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (entry.link) assertLocalSource(entry.resolved, `package-lock.json:${name}`);
  }
});
