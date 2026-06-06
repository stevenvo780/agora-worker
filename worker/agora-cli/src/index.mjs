#!/usr/bin/env node
/**
 * agora — CLI para trabajar workspaces de Agora fuera del editor web.
 *
 * Comandos:
 *   agora login                  Guarda tu Firebase ID token + base URL en ~/.agora/config.json.
 *   agora workspaces             Lista tus workspaces.
 *   agora clone <wsId> [dir]     Clona el repo Forgejo del workspace en `dir` (default: ./<wsId>).
 *   agora pull [dir]             git pull --rebase del workspace.
 *   agora push [dir] [-m MSG]    Commitea cambios pendientes y hace push.
 *   agora watch [dir]            Loop: pull cada 30s + push automático en cambios locales.
 *   agora init <dir>             Marca un dir existente como workspace local (apunta al remote del workspace activo).
 *   agora logout                 Borra credenciales locales.
 *
 * No bundlea Forgejo URL: el `agora login` la deriva del backend (`AGORA_API_URL`).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';

const CONFIG_DIR = path.join(os.homedir(), '.agora');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const log = (...a) => console.log(...a);
const errExit = (msg, code = 1) => { console.error('agora:', msg); process.exit(code); };

const readConfig = async () => {
  try {
    const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
};
const writeConfig = async (cfg) => {
  await fsp.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
};

const apiCall = async (cfg, path, init = {}) => {
  if (!cfg.apiUrl) throw new Error('No estás autenticado. Corre `agora login` primero.');
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.token}`,
      ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
};

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)));
  child.on('error', reject);
});

const capture = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${cmd} exited with ${code}`)));
  child.on('error', reject);
});

const cmdLogin = async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const DEFAULT_API_URL = process.env.AGORA_API_URL || 'https://agora.elenxos.com';
    const apiUrlIn = await rl.question(`URL del API de Agora [${DEFAULT_API_URL}]: `);
    const apiUrl = (apiUrlIn.trim() || DEFAULT_API_URL).replace(/\/$/, '');
    if (!apiUrl) errExit('apiUrl requerida');

    log(`\nAbre en tu navegador: ${apiUrl}/login?cli=1`);
    log('Pega aquí el ID token de Firebase (DevTools → Application → IndexedDB → firebase-installations o copia desde el perfil):');
    const token = (await rl.question('ID token: ')).trim();
    if (!token) errExit('token requerido');

    const cfg = { apiUrl, token, savedAt: new Date().toISOString() };
    // Test
    try {
      const me = await apiCall(cfg, '/api/users/me');
      cfg.uid = me?.uid ?? me?.id ?? null;
      cfg.email = me?.email ?? null;
    } catch (e) {
      errExit(`Login falló: ${e.message}`);
    }
    await writeConfig(cfg);
    log(`✅ Login OK — ${cfg.email ?? cfg.uid ?? 'autenticado'}\nConfig guardada en ${CONFIG_PATH}`);
  } finally { rl.close(); }
};

const cmdLogout = async () => {
  try { await fsp.unlink(CONFIG_PATH); } catch { /* noop */ }
  log('✅ Logout');
};

const cmdWorkspaces = async () => {
  const cfg = await readConfig();
  const ws = await apiCall(cfg, '/api/workspaces');
  if (!Array.isArray(ws)) { console.log(JSON.stringify(ws, null, 2)); return; }
  for (const w of ws) {
    const id = w.id ?? w.workspaceId ?? '?';
    const name = w.name ?? '(sin nombre)';
    const type = w.type ?? '?';
    log(`${id}\t${type}\t${name}`);
  }
};

const cmdStatus = async (dir) => {
  const cfg = await readConfig();
  log(`API: ${cfg.apiUrl || '(sin login)'}`);
  log(`Usuario: ${cfg.email || cfg.uid || '(sin login)'}`);

  const target = path.resolve(dir || '.');
  log(`Directorio: ${target}`);
  try {
    const workspaceId = (await capture('git', ['-C', target, 'config', '--get', 'agora.workspaceId'])).trim();
    const apiUrl = (await capture('git', ['-C', target, 'config', '--get', 'agora.apiUrl']).catch(() => '')).trim();
    log(`Workspace: ${workspaceId || '(no configurado)'}`);
    if (apiUrl) log(`Workspace API: ${apiUrl}`);
    await run('git', ['-C', target, 'status', '--short', '--branch']);
  } catch {
    log('Workspace: (este directorio no parece un workspace Agora inicializado)');
  }
};

const ensureRepoUrl = async (cfg, workspaceId) => {
  let info = await apiCall(cfg, `/api/workspaces/${encodeURIComponent(workspaceId)}/git-info`);
  if (!info.provisioned) {
    log('  Repo no existe aún. Provisionando…');
    const out = await apiCall(cfg, `/api/workspaces/${encodeURIComponent(workspaceId)}/provision-git`, { method: 'POST' });
    info = {
      cloneUrl: out.repo.cloneUrl,
      sshUrl: out.repo.sshUrl,
      htmlUrl: out.repo.htmlUrl,
      repoFullName: out.repo.fullName,
      forgejoLogin: out.forgejoLogin,
      token: out.token
    };
    if (out.token) {
      log('  ⚠️  Token inicial (guárdalo, solo se muestra esta vez):');
      log(`     ${out.token}`);
    }
  }
  return info;
};

const cmdClone = async (workspaceId, dir) => {
  if (!workspaceId) errExit('Uso: agora clone <workspaceId> [dir]');
  const cfg = await readConfig();
  const info = await ensureRepoUrl(cfg, workspaceId);
  const target = path.resolve(dir || workspaceId);
  log(`📥 Clonando ${info.repoFullName} en ${target}…`);
  await run('git', ['clone', info.cloneUrl, target]);
  await run('git', ['-C', target, 'config', 'agora.workspaceId', workspaceId]);
  await run('git', ['-C', target, 'config', 'agora.apiUrl', cfg.apiUrl]);
  log('✅ Listo. Edita con tu IDE preferido. Usa `agora push` para guardar cambios.');
};

const cmdInit = async (dir) => {
  if (!dir) errExit('Uso: agora init <dir>');
  const target = path.resolve(dir);
  await fsp.mkdir(target, { recursive: true });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const wsId = (await rl.question('workspaceId al que apuntar este dir: ')).trim();
    if (!wsId) errExit('workspaceId requerido');
    const cfg = await readConfig();
    const info = await ensureRepoUrl(cfg, wsId);
    if (!fs.existsSync(path.join(target, '.git'))) {
      await run('git', ['-C', target, 'init', '-b', 'main']);
    }
    // Forzar la URL: si remote ya existe con otra URL, set-url la actualiza.
    try {
      await run('git', ['-C', target, 'remote', 'add', 'origin', info.cloneUrl]);
    } catch {
      await run('git', ['-C', target, 'remote', 'set-url', 'origin', info.cloneUrl]);
    }
    await run('git', ['-C', target, 'config', 'agora.workspaceId', wsId]);
    log(`✅ ${target} apunta a ${info.repoFullName}`);
    log(`   Próximo paso: agora pull ${target}`);
  } finally { rl.close(); }
};

const cmdPull = async (dir) => {
  await run('git', ['-C', path.resolve(dir || '.'), 'pull', '--rebase', '--autostash']);
};

const parseMessage = (args) => {
  const idx = args.indexOf('-m');
  if (idx < 0 || idx === args.length - 1) return null;
  return args[idx + 1];
};

const cmdPush = async (dir, args) => {
  const target = path.resolve(dir || '.');
  const msg = parseMessage(args) || `Update ${new Date().toISOString()}`;
  await run('git', ['-C', target, 'add', '-A']);
  const hasChanges = await new Promise((resolve, reject) => {
    const c = spawn('git', ['-C', target, 'diff', '--cached', '--quiet']);
    c.on('error', reject);
    c.on('exit', (code) => resolve(code !== 0));
  });
  if (!hasChanges) { log('No hay cambios.'); return; }
  await run('git', ['-C', target, 'commit', '-m', msg]);
  await run('git', ['-C', target, 'push']);
};

const cmdWatch = async (dir) => {
  const target = path.resolve(dir || '.');
  log(`👀 Watching ${target}. Pull/push automático cada 30s. Ctrl+C para salir.`);
  const tick = async () => {
    try { await run('git', ['-C', target, 'pull', '--rebase', '--autostash', '--quiet']); } catch { /* noop */ }
    try {
      const porcelain = await capture('git', ['-C', target, 'status', '--porcelain']);
      if (porcelain.trim()) {
        await run('git', ['-C', target, 'add', '-u']);
        await run('git', ['-C', target, 'commit', '-m', `agora-watch ${new Date().toISOString()}`]).catch(() => undefined);
        await run('git', ['-C', target, 'push']).catch(() => undefined);
      }
    } catch { /* noop */ }
  };
  setInterval(tick, 30_000);
  await new Promise(() => undefined); // run forever
};

const help = () => {
  console.log(`agora — CLI Agora workspaces

Uso:
  agora login                       Login con Firebase ID token.
  agora logout                      Borra credenciales locales.
  agora status [dir]                Muestra login y estado git del workspace.
  agora workspaces                  Lista tus workspaces.
  agora clone <wsId> [dir]          Clona el repo del workspace.
  agora init <dir>                  Convierte un dir existente en workspace.
  agora pull [dir]                  git pull --rebase.
  agora push [dir] [-m MSG]         Commit + push.
  agora watch [dir]                 Sync automático (pull + push 30s).

Config: ${CONFIG_PATH}
`);
};

const main = async () => {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case 'login': return cmdLogin();
    case 'logout': return cmdLogout();
    case 'status': return cmdStatus(args[0]);
    case 'workspaces': case 'ls': return cmdWorkspaces();
    case 'clone': return cmdClone(args[0], args[1]);
    case 'init': return cmdInit(args[0]);
    case 'pull': return cmdPull(args[0]);
    case 'push': return cmdPush(args[0]?.startsWith('-') ? '.' : args[0], args);
    case 'watch': return cmdWatch(args[0]);
    case 'help': case '--help': case '-h': case undefined:
      return help();
    default: errExit(`Comando desconocido: ${cmd}. Usa 'agora help'.`);
  }
};

main().catch((e) => errExit(e?.message ?? String(e)));
