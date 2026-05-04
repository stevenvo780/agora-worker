export const ALLOWED_AGENT_BINARIES = new Set([
  'ls', 'pwd', 'cat', 'echo', 'head', 'tail', 'wc', 'grep', 'find', 'sort', 'uniq',
  'cut', 'awk', 'sed', 'tr', 'tee', 'diff', 'stat', 'file', 'date',
  'mkdir', 'touch', 'cp', 'mv', 'rm', 'ln',
  'git',
  'node', 'npm', 'pnpm', 'npx', 'yarn',
  'python', 'python3', 'pip', 'pip3',
  'curl', 'wget',
  'tree', 'jq', 'tsc', 'eslint', 'prettier',
  'true', 'false'
]);

const ALWAYS_FORBIDDEN_RE = /\b(sudo|su|passwd|mkfs|fdisk|parted|mount|umount|shutdown|reboot|poweroff|chown|chmod\s+[+]?[rwx]*[s])\b/;

function tokenize(segment) {
  return String(segment || '').trim().split(/\s+/).filter(Boolean);
}

export function validateAgentCommand(command, options = {}) {
  const maxLength = Number(options.maxLength || 2000);
  const cmd = String(command || '');
  if (!cmd.trim()) throw new Error('command required');
  if (cmd.length > maxLength) throw new Error('command too long');
  if (cmd.includes('\0')) throw new Error('command contains null bytes');
  if (ALWAYS_FORBIDDEN_RE.test(cmd)) {
    throw new Error('privileged or destructive system commands are not allowed');
  }

  const segments = cmd.split(/(?:\|\||&&|;|\|)/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) throw new Error('command required');

  for (const segment of segments) {
    const tokens = tokenize(segment);
    const head = tokens[0];
    if (!head) continue;
    const realHead = /^[A-Z_][A-Z0-9_]*=/.test(head) ? tokens[1] : head;
    if (!realHead) throw new Error(`empty segment: ${segment}`);
    const binary = realHead.split('/').pop();
    if (!binary || !ALLOWED_AGENT_BINARIES.has(binary)) {
      throw new Error(`binary "${binary}" no está en la whitelist del agente`);
    }
    if (binary === 'rm' && tokens.some((token) => token === '/' || token === '~' || token === '$HOME' || token === '/*')) {
      throw new Error('rm sobre root/home está bloqueado');
    }
  }
}