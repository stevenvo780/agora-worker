import fs from 'fs';
import { io } from "socket.io-client";
import pty from 'node-pty';

const NEXUS_URL = process.env.NEXUS_URL || "http://localhost:3010";
const WORKER_TOKEN = process.env.WORKER_TOKEN || "dev-user-123";

console.log(`🔌 Connecting to Nexus at ${NEXUS_URL} with token ${WORKER_TOKEN}...`);

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
socket.on("session-created", (data) => {
    const { id: sessionId } = data;
    console.log(`📟 Creating PTY for session ${sessionId}`);

    // Spawn a real bash shell with PTY
    const shell = process.env.SHELL || '/bin/bash';
    const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: DEFAULT_WORKDIR,
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
