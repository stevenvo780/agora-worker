import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAgentCommand } from '../agent-command-policy.mjs';

test('permite comandos simples y pipelines con binarios autorizados', () => {
  assert.doesNotThrow(() => validateAgentCommand('pwd'));
  assert.doesNotThrow(() => validateAgentCommand('cat README.md | grep Agora | head -5'));
  assert.doesNotThrow(() => validateAgentCommand('NODE_ENV=test npm run test'));
});

test('rechaza binarios fuera de whitelist y shells privilegiadas', () => {
  assert.throws(() => validateAgentCommand('ruby -e "puts 1"'), /whitelist/);
  assert.throws(() => validateAgentCommand('sudo ls'), /privileged/);
  assert.throws(() => validateAgentCommand('python3 ok.py && docker ps'), /whitelist/);
});

test('bloquea rm contra root/home y comandos malformados', () => {
  assert.throws(() => validateAgentCommand('rm /'), /root\/home/);
  assert.throws(() => validateAgentCommand(''), /command required/);
  assert.throws(() => validateAgentCommand('echo ok\0'), /null bytes/);
});

test('respeta límite de longitud configurable', () => {
  assert.throws(() => validateAgentCommand('echo 123456789', { maxLength: 5 }), /too long/);
});