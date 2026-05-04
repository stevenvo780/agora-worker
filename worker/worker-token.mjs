import crypto from 'crypto';

export function parseToken(token) {
  if (String(token || '').startsWith('personal:')) {
    return {
      workspaceId: token,
      workspaceType: 'personal',
      userId: token.substring('personal:'.length)
    };
  }
  return {
    workspaceId: token,
    workspaceType: 'shared',
    userId: null
  };
}

export function generateSignedToken(id, secret, nowMs = Date.now()) {
  const info = parseToken(id);
  const payload = JSON.stringify({
    workspaceId: info.workspaceId,
    workspaceType: info.workspaceType,
    ownerId: info.userId,
    timestamp: nowMs
  });
  const payloadB64 = Buffer.from(payload).toString('base64');
  const signature = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
  return `${payloadB64}.${signature}`;
}