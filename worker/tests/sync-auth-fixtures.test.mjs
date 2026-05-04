import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildAuthHeaders, sign } from '../../worker-host-sync/auth.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturePath = path.join(root, 'packages/agora-contracts/fixtures/worker-hmac.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));

test('host-sync HMAC coincide con fixtures compartidas de contratos', () => {
  const sync = fixture.syncHttp;
  assert.equal(sign(sync.secret, sync.workspaceId, sync.timestamp), sync.sharedSignature);
  assert.deepEqual(buildAuthHeaders(sync.secret, sync.workspaceId, null, sync.timestamp), sync.headers);
});

test('host-sync HMAC incluye owner en workspace personal', () => {
  const sync = fixture.syncHttp;
  assert.equal(
    sign(sync.secret, sync.personalWorkspaceId, sync.timestamp, sync.userId),
    sync.personalSignature
  );
});
