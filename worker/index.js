import fs from 'fs';
import { io } from "socket.io-client";
import pty from 'node-pty';
import crypto from 'crypto';

const NEXUS_URL = process.env.NEXUS_URL || "http://localhost:3010";

// WORKER_TOKEN is now treated as the Workspace Identifier (Identity)
const WORKER_ID = process.env.WORKER_TOKEN || "";
const WORKER_SECRET = process.env.WORKER_SECRET || "";
const SAFE_WORKSPACE_ID = /^[a-zA-Z0-9_:-]+$/;

if (WORKER_ID && !SAFE_WORKSPACE_ID.test(WORKER_ID)) {
  console.error("❌ WORKER_TOKEN (ID) contains invalid characters.");
  process.exit(1);
}

function parseToken(token) {
  if (token.startsWith('personal:')) {
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

const tokenInfo = parseToken(WORKER_ID);

console.log(`🔌 Worker Configuration:`);
console.log(`   Hub URL: ${NEXUS_URL}`);
console.log(`   Identity: ${tokenInfo.workspaceId.substring(0, 5)}... (Obfuscated)`);
console.log(`   Type: ${tokenInfo.workspaceType}`);

if (!WORKER_ID) {
  console.error("❌ WORKER_TOKEN is required.");
  process.exit(1);
}

if (!WORKER_SECRET) {
  console.error("❌ WORKER_SECRET is required for signing authentication tokens.");
  process.exit(1);
}

function generateSignedToken(id, secret) {
  const info = parseToken(id);
  const payload = JSON.stringify({
    workspaceId: info.workspaceId,
    workspaceType: info.workspaceType,
    ownerId: info.userId,
    timestamp: Date.now()
  });
  const payloadB64 = Buffer.from(payload).toString('base64');
  const signature = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
  return `${payloadB64}.${signature}`;
}

const signedToken = generateSignedToken(WORKER_ID, WORKER_SECRET);

const socket = io(NEXUS_URL, {
  auth: {
    type: "worker",
    workerToken: signedToken
  },
  transports: ['websocket'],  // Solo websocket, evita duplicados de polling
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: Infinity
});

socket.on("connect", () => {
  console.log(`✅ Connected to Hub! (Socket ID: ${socket.id})`);
});

socket.on("connect_error", (err) => {
  console.error("❌ Connection Error:", err.message);
});

socket.on("disconnect", (reason) => {
  console.log(`🔌 Disconnected from Hub: ${reason}`);
});

socket.on("reconnect", (attemptNumber) => {
  console.log(`🔄 Reconnected to Hub after ${attemptNumber} attempts`);
});

socket.on("reconnect_attempt", (attemptNumber) => {
  console.log(`🔄 Reconnection attempt #${attemptNumber}...`);
});

const sessions = new Map();

const DEFAULT_WORKDIR = "/workspace";

if (!fs.existsSync(DEFAULT_WORKDIR)) {
    try {
        fs.mkdirSync(DEFAULT_WORKDIR, { recursive: true });
    } catch (e) {
        console.error("Failed to create workspace:", e);
    }
}

socket.on("session-created", (data = {}) => {
    const { id: sessionId, workspaceId, workspaceName } = data;
    console.log(`📟 Creating PTY for session ${sessionId}`);

    if (workspaceId && workspaceId !== tokenInfo.workspaceId) {
        console.warn(`⚠️ Ignoring session ${sessionId} for workspace ${workspaceId} (expected ${tokenInfo.workspaceId})`);
        return;
    }

    const workdir = DEFAULT_WORKDIR;
    console.log(`📂 Workspace: ${workspaceName || WORKER_ID} -> ${workdir}`);

    if (!fs.existsSync(workdir)) {
        try {
            fs.mkdirSync(workdir, { recursive: true });
        } catch (e) {
            console.error("Failed to create workspace dir:", e);
        }
    }

    const shell = process.env.SHELL || '/bin/bash';
    const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: workdir,
        env: {
            ...process.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            FORCE_COLOR: '1'
        }
    });

    sessions.set(sessionId, ptyProcess);

    ptyProcess.onData((data) => {
        socket.emit("output", { sessionId, data });
    });

    ptyProcess.onExit(({ exitCode }) => {
        console.log(`📟 PTY for session ${sessionId} exited with code ${exitCode}`);
        sessions.delete(sessionId);
        socket.emit("session-ended", { sessionId, reason: `Shell exited (code ${exitCode})` });
    });
});

socket.on("execute", (data) => {
    const { sessionId, command } = data;
    const ptyProcess = sessions.get(sessionId);

    if (ptyProcess) {
        ptyProcess.write(command);
    }
});

socket.on("resize", (data) => {
    const { sessionId, cols, rows } = data;
    const ptyProcess = sessions.get(sessionId);

    if (ptyProcess && cols > 0 && rows > 0) {
        try {
            ptyProcess.resize(cols, rows);
        } catch (e) {
            console.error("Resize error:", e);
        }
    }
});

const killSession = (data) => {
    const { sessionId } = data;
    const ptyProcess = sessions.get(sessionId);

    if (ptyProcess) {
        console.log(`💀 Killing session ${sessionId}`);
        ptyProcess.kill();
        sessions.delete(sessionId);
    }
};

socket.on("end-session", killSession);
socket.on("kill-session", killSession);


socket.on("disconnect", () => {
    console.log("🔌 Disconnected from Hub, cleaning up sessions...");
    for (const ptyProcess of sessions.values()) {
        ptyProcess.kill();
    }
    sessions.clear();
});
