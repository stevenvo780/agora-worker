import fs from 'fs';
import path from 'path';
import { io } from "socket.io-client";
import pty from 'node-pty';

const NEXUS_URL = process.env.NEXUS_URL || "http://localhost:3010";

// =====================================================
// NEW TOKEN FORMAT: 
// - "personal:{userId}" for personal workspaces
// - "{workspaceId}" for shared workspaces
// =====================================================
const WORKER_TOKEN = process.env.WORKER_TOKEN || "";
const SAFE_WORKSPACE_ID = /^[a-zA-Z0-9_:-]+$/;

// Parse the token to understand workspace type
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

const tokenInfo = parseToken(WORKER_TOKEN);
console.log(`🔌 Worker Configuration:`);
console.log(`   Hub URL: ${NEXUS_URL}`);
console.log(`   Token: ${WORKER_TOKEN}`);
console.log(`   Type: ${tokenInfo.workspaceType}`);
console.log(`   Workspace ID: ${tokenInfo.workspaceId}`);

if (!WORKER_TOKEN) {
  console.error("❌ WORKER_TOKEN is required. Set it in environment variables.");
  console.error("   For personal workspace: WORKER_TOKEN=personal:<userId>");
  console.error("   For shared workspace: WORKER_TOKEN=<workspaceId>");
  process.exit(1);
}

const socket = io(NEXUS_URL, {
  auth: {
    type: "worker",
    workerToken: WORKER_TOKEN
  }
});

socket.on("connect", () => {
  console.log("✅ Connected to Hub!");
});

socket.on("connect_error", (err) => {
  console.error("❌ Connection Error:", err.message);
});

// Map sessionId -> pty process
const sessions = new Map();

// Default workspace directory
const DEFAULT_WORKDIR = "/workspace";

// Ensure workspace exists
if (!fs.existsSync(DEFAULT_WORKDIR)) {
    try {
        fs.mkdirSync(DEFAULT_WORKDIR, { recursive: true });
    } catch (e) {
        console.error("Failed to create workspace:", e);
    }
}

// When hub tells us a session was created, spawn PTY
socket.on("session-created", (data = {}) => {
    const { id: sessionId, workspaceId, workspaceName } = data;
    console.log(`📟 Creating PTY for session ${sessionId}`);

    // =====================================================
    // WORKDIR LOGIC:
    // This worker is DEDICATED to a single workspace (via WORKER_TOKEN)
    // Always use /workspace as root - the sync_agent handles the correct files
    // =====================================================
    const workdir = DEFAULT_WORKDIR;
    console.log(`📂 Workspace: ${workspaceName || WORKER_TOKEN} -> ${workdir}`);

    if (!fs.existsSync(workdir)) {
        try {
            fs.mkdirSync(workdir, { recursive: true });
        } catch (e) {
            console.error("Failed to create workspace dir:", e);
        }
    }

    // Spawn a real bash shell with PTY
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

    // Forward PTY output to client
    ptyProcess.onData((data) => {
        socket.emit("output", { sessionId, data });
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
        console.log(`📟 PTY for session ${sessionId} exited with code ${exitCode}`);
        sessions.delete(sessionId);
        socket.emit("session-ended", { sessionId, reason: `Shell exited (code ${exitCode})` });
    });
});

// Receive input from client
socket.on("execute", (data) => {
    const { sessionId, command } = data;
    const ptyProcess = sessions.get(sessionId);

    if (ptyProcess) {
        // Write raw input to PTY (bash handles Tab, Ctrl+C, etc.)
        ptyProcess.write(command);
    }
});

// Handle terminal resize
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

// Handle session end
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


// Cleanup on disconnect
socket.on("disconnect", () => {
    console.log("🔌 Disconnected from Hub, cleaning up sessions...");
    for (const ptyProcess of sessions.values()) {
        ptyProcess.kill();
    }
    sessions.clear();
});
