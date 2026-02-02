import fs from "fs";
import path from "path";
import crypto from "crypto";
import chokidar from "chokidar";
import admin from "firebase-admin";
import { io } from "socket.io-client";

const WORKER_TOKEN = process.env.WORKER_TOKEN || "";
const NEXUS_URL = process.env.NEXUS_URL || "http://localhost:3010";
const BUCKET_NAME = process.env.FIREBASE_BUCKET || "udea-filosofia.firebasestorage.app";
const SYNC_DIR = "/workspace";
const POLL_INTERVAL_MS = (() => {
  const raw = process.env.SYNC_POLL_MS;
  const parsed = raw ? Number(raw) : 30000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
})();
const CLOCK_SKEW_MS = 2000;
const DOWNLOAD_GRACE_MS = 3000;

function parseToken(token) {
  if (token.startsWith('personal:')) {
    return {
      workspaceId: token,
      workspaceType: 'personal',
      userId: token.substring('personal:'.length),
      storagePath: `users/${token.substring('personal:'.length)}`
    };
  }
  return {
    workspaceId: token,
    workspaceType: 'shared',
    userId: null,
    storagePath: `workspaces/${token}`
  };
}

const tokenInfo = parseToken(WORKER_TOKEN);

if (!WORKER_TOKEN) {
  console.error("❌ WORKER_TOKEN is required. Set it in environment variables.");
  console.error("   For personal workspace: WORKER_TOKEN=personal:<userId>");
  console.error("   For shared workspace: WORKER_TOKEN=<workspaceId>");
  process.exit(1);
}

const IGNORE_LIST = new Set([".git", ".DS_Store", "node_modules", ".next"]);
const TEXT_EXTS = new Set([
  ".md",
  ".txt",
  ".js",
  ".ts",
  ".tsx",
  ".json",
  ".css",
  ".html",
]);

function log(message) {
  const ts = new Date().toISOString();
  console.log(`${ts} - ${message}`);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getServiceAccount() {
  const env = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (env) {
    try {
      return JSON.parse(env);
    } catch (_err) {
      try {
        return JSON.parse(env.replace(/\\n/g, "\n"));
      } catch (err) {
        log(`No se pudo parsear FIREBASE_SERVICE_ACCOUNT: ${err.message}`);
      }
    }
  }

  // Check GOOGLE_APPLICATION_CREDENTIALS env var first
  const envCredPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envCredPath && fs.existsSync(envCredPath)) {
    try {
      return readJsonFile(envCredPath);
    } catch (err) {
      log(`No se pudo leer ${envCredPath}: ${err.message}`);
    }
  }

  // Fallback to default path
  const credPath = "/app/serviceAccountKey.json";
  if (fs.existsSync(credPath)) {
    try {
      return readJsonFile(credPath);
    } catch (err) {
      log(`No se pudo leer ${credPath}: ${err.message}`);
    }
  }
  return null;
}

function ensureFirebase() {
  if (admin.apps.length) {
    return admin.app();
  }
  const serviceAccount = getServiceAccount();
  if (serviceAccount) {
    return admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: BUCKET_NAME,
    });
  }
  return admin.initializeApp({ storageBucket: BUCKET_NAME });
}

function toPosixPath(localPath) {
  return localPath.split(path.sep).join(path.posix.sep);
}

function isIgnoredPath(filePath) {
  let rel;
  try {
    rel = path.relative(SYNC_DIR, filePath);
  } catch (_err) {
    return true;
  }
  if (!rel || rel.startsWith("..")) return true;

  const parts = rel.split(path.sep);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith(".")) return true;
    if (IGNORE_LIST.has(part)) return true;
  }
  return false;
}

function md5Base64(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("base64")));
  });
}

class SyncManager {
  constructor(bucket, db, socket) {
    this.bucket = bucket;
    this.db = db;
    this.socket = socket;
    this.mounts = [];
    this.recentDownloads = new Map();
    this.inFlight = new Set();
    this.downloadsInFlight = new Set();
    this.cycleInProgress = false;

    this.mounts.push({
      local: SYNC_DIR,
      remote: tokenInfo.storagePath,
    });
    
    if (tokenInfo.workspaceType === 'personal') {
      log(`🔹 Modo Personal: Sincronizando ${tokenInfo.storagePath} para usuario ${tokenInfo.userId}`);
    } else {
      log(`🔹 Modo Workspace: Sincronizando ${tokenInfo.storagePath}`);
    }
  }

  // Notificar al Hub que hubo un cambio de documentos
  notifyFileChange(action, fileName, docId = null) {
    if (this.socket && this.socket.connected) {
      this.socket.emit('doc-change', {
        workspaceId: tokenInfo.workspaceId,
        action, // 'created', 'updated', 'deleted'
        docId,
        data: {
          name: fileName
        }
      });
      log(`📡 Notificado: ${action} ${fileName}`);
    }
  }

  setupWorkspaceListener() {
    log(`ℹ️ Worker dedicado a ${tokenInfo.workspaceId} - No hay listener dinámico`);
  }

  async loadWorkspaceMounts() {
    log(`ℹ️ Mount configurado: ${SYNC_DIR} -> ${tokenInfo.storagePath}`);
  }

  getRemotePath(localPath) {
    let best = null;
    for (const mount of this.mounts) {
      const rel = path.relative(mount.local, localPath);
      if (!rel || rel.startsWith("..")) continue;
      if (!best || mount.local.length > best.local.length) {
        best = { ...mount, rel };
      }
    }
    if (!best) return null;
    const relPosix = toPosixPath(best.rel);
    return `${best.remote}/${relPosix}`;
  }

  getLocalPath(remotePath) {
    for (const mount of this.mounts) {
      if (remotePath.startsWith(`${mount.remote}/`)) {
        const rel = remotePath.slice(mount.remote.length + 1);
        return path.join(mount.local, rel.split("/").join(path.sep));
      }
    }
    return null;
  }

  cleanupRecentDownloads() {
    const now = Date.now();
    for (const [filePath, ts] of this.recentDownloads.entries()) {
      if (now - ts > DOWNLOAD_GRACE_MS) {
        this.recentDownloads.delete(filePath);
      }
    }
  }

  async updateFirestore(remotePath, localPath) {
    try {
      if (!TEXT_EXTS.has(path.extname(localPath).toLowerCase())) {
        // Para archivos no-texto, solo notificar el cambio
        this.notifyFileChange('updated', path.basename(localPath));
        return;
      }
      const content = fs.readFileSync(localPath, "utf8");
      const snapshot = await this.db
        .collection("documents")
        .where("storagePath", "==", remotePath)
        .limit(1)
        .get();
      
      if (snapshot.empty) {
        // Crear nuevo documento en Firestore si no existe
        const fileName = path.basename(localPath);
        const docData = {
          name: fileName.replace(/\.[^/.]+$/, ""), // nombre sin extensión
          content,
          storagePath: remotePath,
          workspaceId: tokenInfo.workspaceId,
          ownerId: tokenInfo.userId || tokenInfo.workspaceId,
          folder: "No estructurado",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        const newDoc = await this.db.collection("documents").add(docData);
        log(`Firestore documento creado: ${newDoc.id} (${fileName})`);
        this.notifyFileChange('created', fileName, newDoc.id);
      } else {
        snapshot.forEach((doc) => {
          doc.ref.update({
            content,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          log(`Firestore actualizado: ${doc.id}`);
          this.notifyFileChange('updated', path.basename(localPath), doc.id);
        });
      }
    } catch (err) {
      log(`Error sincronizando Firestore: ${err.message}`);
    }
  }

  async uploadFile(localPath) {
    if (this.inFlight.has(localPath)) return;
    if (isIgnoredPath(localPath)) return;
    if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) return;
    this.cleanupRecentDownloads();
    if (this.recentDownloads.has(localPath)) return;

    const remotePath = this.getRemotePath(localPath);
    if (!remotePath) return;

    this.inFlight.add(localPath);
    try {
      const file = this.bucket.file(remotePath);
      let metadata = null;
      try {
        [metadata] = await file.getMetadata();
      } catch (err) {
        if (err.code !== 404) throw err;
      }

      if (metadata && metadata.md5Hash) {
        const localMd5 = await md5Base64(localPath);
        if (metadata.md5Hash === localMd5) {
          return;
        }
      }

      await this.bucket.upload(localPath, { destination: remotePath });
      log(`Subido: ${path.basename(localPath)}`);
      await this.updateFirestore(remotePath, localPath);
    } catch (err) {
      log(`Error subiendo ${localPath}: ${err.message}`);
    } finally {
      this.inFlight.delete(localPath);
    }
  }

  async downloadFile(file) {
    if (this.downloadsInFlight.has(file.name)) return;
    this.downloadsInFlight.add(file.name);
    try {
      const localPath = this.getLocalPath(file.name);
      if (!localPath) return;
      if (isIgnoredPath(localPath)) return;

      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      await file.download({ destination: localPath });

      const updated = file.metadata?.updated;
      if (updated) {
        const ts = new Date(updated).getTime() / 1000;
        fs.utimesSync(localPath, ts, ts);
      }

      log(`Descargado: ${path.basename(localPath)}`);
      this.recentDownloads.set(localPath, Date.now());
    } catch (err) {
      log(`Error descargando ${file.name}: ${err.message}`);
    } finally {
      this.downloadsInFlight.delete(file.name);
    }
  }

  // Recursively scan local directory for files
  scanLocalFiles(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (isIgnoredPath(fullPath)) continue;
      if (entry.isDirectory()) {
        this.scanLocalFiles(fullPath, fileList);
      } else if (entry.isFile()) {
        fileList.push(fullPath);
      }
    }
    return fileList;
  }

  async syncCycle() {
    if (this.cycleInProgress) return;
    this.cycleInProgress = true;
    try {
      for (const mount of this.mounts) {
        // Get remote files
        const [remoteFiles] = await this.bucket.getFiles({
          prefix: `${mount.remote}/`,
        });

        // Build a set of remote paths for quick lookup
        const remotePathSet = new Set();
        for (const file of remoteFiles) {
          if (!file.name.endsWith("/")) {
            remotePathSet.add(file.name);
          }
        }

        // PART 1: Scan local files and upload any that don't exist in remote
        const localFiles = this.scanLocalFiles(mount.local);
        for (const localPath of localFiles) {
          const remotePath = this.getRemotePath(localPath);
          if (!remotePath) continue;
          
          if (!remotePathSet.has(remotePath)) {
            // File exists locally but not in Firebase - upload it
            await this.uploadFile(localPath);
          }
        }

        // PART 2: Process remote files (download new ones, sync existing)
        for (const file of remoteFiles) {
          if (file.name.endsWith("/")) continue;

          const localPath = this.getLocalPath(file.name);
          if (!localPath) continue;
          if (isIgnoredPath(localPath)) continue;

          if (!fs.existsSync(localPath)) {
            await this.downloadFile(file);
            continue;
          }

          const localStat = fs.statSync(localPath);
          const localMtimeMs = localStat.mtimeMs;
          const updatedStr = file.metadata?.updated || null;
          const remoteUpdatedMs = updatedStr ? new Date(updatedStr).getTime() : 0;

          if (!remoteUpdatedMs) {
            await this.downloadFile(file);
            continue;
          }

          if (remoteUpdatedMs > localMtimeMs + CLOCK_SKEW_MS) {
            await this.downloadFile(file);
            continue;
          }
          if (localMtimeMs > remoteUpdatedMs + CLOCK_SKEW_MS) {
            await this.uploadFile(localPath);
            continue;
          }

          if (file.metadata?.md5Hash) {
            const localMd5 = await md5Base64(localPath);
            if (file.metadata.md5Hash === localMd5) {
              continue;
            }
          }

          await this.downloadFile(file);
        }
      }
    } catch (err) {
      log(`Error en sync cycle: ${err.message}`);
    } finally {
      this.cycleInProgress = false;
    }
  }
}

async function run() {
  if (!fs.existsSync(SYNC_DIR)) {
    log(`Directorio no existe: ${SYNC_DIR}`);
    return;
  }

  // Conectar al Hub para notificar cambios de archivos
  const socket = io(NEXUS_URL, {
    auth: {
      type: "sync-agent",
      workerToken: WORKER_TOKEN
    },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
  });

  socket.on("connect", () => {
    log(`📡 Conectado al Hub para notificaciones (Socket ID: ${socket.id})`);
  });

  socket.on("connect_error", (err) => {
    log(`⚠️ Error conectando al Hub: ${err.message}`);
  });

  ensureFirebase();
  const bucket = admin.storage().bucket();
  const db = admin.firestore();

  log(`Conectado a Firebase Storage: ${BUCKET_NAME}`);

  const manager = new SyncManager(bucket, db, socket);
  await manager.loadWorkspaceMounts();

  const watcher = chokidar.watch(SYNC_DIR, {
    ignoreInitial: true,
    ignored: (filePath) => isIgnoredPath(filePath),
    usePolling: true,
    interval: 5000,
    binaryInterval: 10000,
  });

  watcher.on("add", (filePath) => manager.uploadFile(filePath));
  watcher.on("change", (filePath) => manager.uploadFile(filePath));

  log(`Escuchando cambios en ${SYNC_DIR}`);

  setInterval(() => {
    manager.syncCycle();
  }, POLL_INTERVAL_MS);
}

run().catch((err) => {
  log(`Fallo fatal: ${err.message}`);
  process.exit(1);
});
