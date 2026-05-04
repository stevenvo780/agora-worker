import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSignedToken, parseToken } from '../worker-token.mjs';

function decodeToken(token) {
  const [payloadB64, signature] = token.split('.');
  return {
    payload: JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8')),
    signature
  };
}

test('parseToken detecta workspaces personales y shared', () => {
  assert.deepEqual(parseToken('personal:user-1'), {
    workspaceId: 'personal:user-1',
    workspaceType: 'personal',
    userId: 'user-1'
  });
  assert.deepEqual(parseToken('workspace-1'), {
    workspaceId: 'workspace-1',
    workspaceType: 'shared',
    userId: null
  });
});

test('generateSignedToken produce payload compatible con Hub', () => {
  const token = generateSignedToken('personal:user-1', 'worker-secret', 1_700_000_000_000);
  const decoded = decodeToken(token);

  assert.deepEqual(decoded.payload, {
    workspaceId: 'personal:user-1',
    workspaceType: 'personal',
    ownerId: 'user-1',
    timestamp: 1_700_000_000_000
  });
  assert.match(decoded.signature, /^[a-f0-9]{64}$/);
});

test('generateSignedToken cambia si cambia el secret', () => {
  const a = generateSignedToken('workspace-1', 'secret-a', 1_700_000_000_000);
  const b = generateSignedToken('workspace-1', 'secret-b', 1_700_000_000_000);
  assert.notEqual(a.split('.')[1], b.split('.')[1]);
});