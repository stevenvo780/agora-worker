import fs from 'fs';
import path from 'path';
import { io } from "socket.io-client";
import pty from 'node-pty';

const NEXUS_URL = process.env.NEXUS_URL || "http://localhost:3010";
const WORKER_TOKEN = process.env.WORKER_TOKEN || "dev-user-123";
const WORKSPACE_DIR_PREFIX = process.env.WORKSPACE_DIR_PREFIX || "_ws";
const WORKSPACE_ID = process.env.WORKSPACE_ID || ""; // If set, this worker is DEDICATED to this workspace
const SAFE_WORKSPACE_ID = /^[a-zA-Z0-9_-]+$/;

console.log(`🔌 Connecting to Nexus at ${NEXUS_URL} with token ${WORKER_TOKEN} [Scope: ${WORKSPACE_ID || 'personal'}]...`);

const socket = io(NEXUS_URL, {
  auth: {
    type: "worker",
    workerToken: WORKER_TOKEN,
    workspaceId: WORKSPACE_ID || 'personal'
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

    // LOGIC: Determine Working Directory
    let workdir = DEFAULT_WORKDIR;

    // Case 1: Active Dedicated Mode (Env WORKSPACE_ID is set)
    if (WORKSPACE_ID) {
        // If this worker is dedicated to specific workspace X,
        // and request is for workspace X, proceed at root.
        // If request is for Y, we shouldn't have received this event (Hub filtering),
        // but just in case, we stick to root because we only see ONE workspace.
        workdir = DEFAULT_WORKDIR; 
        console.log(`🔒 Dedicated Worker (${WORKSPACE_ID}): Force Root Dir`);
    } 
    // Case 2: Personal Mixed Mode (Legacy/Default)
    else if (workspaceId && workspaceId !== "personal") {
        if (SAFE_WORKSPACE_ID.test(workspaceId)) {
            workdir = path.join(DEFAULT_WORKDIR, WORKSPACE_DIR_PREFIX, workspaceId);
        } else {
            console.warn("WorkspaceId invalido, usando /workspace");
        }
    }

    if (!fs.existsSync(workdir)) {
        try {
            fs.mkdirSync(workdir, { recursive: true });
        } catch (e) {
            console.error("Failed to create workspace dir:", e);
        }
    }

    if (workspaceId) {
        console.log(`📂 Workspace: ${workspaceName || workspaceId} -> ${workdir}`);
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
socket.on("end-session", (data) => {
    const { sessionId } = data;
    const ptyProcess = sessions.get(sessionId);

    if (ptyProcess) {
        ptyProcess.kill();
        sessions.delete(sessionId);
    }
});

// Cleanup on disconnect
socket.on("disconnect", () => {
    console.log("🔌 Disconnected from Hub, cleaning up sessions...");
    for (const ptyProcess of sessions.values()) {
        ptyProcess.kill();
    }
    sessions.clear();
});
