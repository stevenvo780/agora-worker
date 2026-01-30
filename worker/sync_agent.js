import fs from "fs";
import path from "path";
import crypto from "crypto";
import chokidar from "chokidar";
import admin from "firebase-admin";

const WORKER_TOKEN = process.env.WORKER_TOKEN || "unknown-worker";
const WORKSPACE_ID = process.env.WORKSPACE_ID || ""; // Dedicated Mode
const BUCKET_NAME =
  process.env.FIREBASE_BUCKET || "udea-filosofia.firebasestorage.app";
const WORKSPACE_DIR_PREFIX = process.env.WORKSPACE_DIR_PREFIX || "_ws";
const SYNC_DIR = "/workspace";
const POLL_INTERVAL_MS = 10000;
const CLOCK_SKEW_MS = 2000;
const DOWNLOAD_GRACE_MS = 3000;

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
  constructor(bucket, db) {
    this.bucket = bucket;
    this.db = db;
    this.mounts = [];
    this.recentDownloads = new Map();
    this.inFlight = new Set();
    this.downloadsInFlight = new Set();
    this.cycleInProgress = false;

    // MOUNT CONFIGURATION
    if (WORKSPACE_ID) {
        // Mode 1: Dedicated Workspace Worker
        // Only mounts the specific workspace at the root.
        this.mounts.push({
            local: SYNC_DIR,
            remote: `workspaces/${WORKSPACE_ID}`,
        });
        log(`🔹 Modo Dedicado Activado: Sincronizando workspaces/${WORKSPACE_ID} en raíz.`);
    } else {
        // Mode 2: Personal Worker (Legacy)
        // Mounts Personal user root + listens for shared workspaces in subfolders
        this.mounts.push({
            local: SYNC_DIR,
            remote: `users/${WORKER_TOKEN}`,
        });
        log(`🔸 Modo Personal Activado: Sincronizando users/${WORKER_TOKEN} en raíz.`);
    }
  }

  setupWorkspaceListener() {
    // If strict Dedicated Mode is ON, we do NOT switch contexts or add dynamic mounts
    if (WORKSPACE_ID) return;

    try {
      this.db
        .collection("workspaces")
        .where("members", "array-contains", WORKER_TOKEN)
        .onSnapshot((snapshot) => {
          snapshot.forEach((doc) => {
            const data = doc.data() || {};
            const workspaceName = String(data.name || doc.id).trim() || doc.id;
            const mountPoint = path.join(SYNC_DIR, WORKSPACE_DIR_PREFIX, doc.id);
            const remotePrefix = `workspaces/${doc.id}`;

            // Check if already mounted
            const exists = this.mounts.some(m => m.local === mountPoint);
            if (!exists) {
                this.mounts.push({ local: mountPoint, remote: remotePrefix });

                if (!fs.existsSync(mountPoint)) {
                  fs.mkdirSync(mountPoint, { recursive: true });
                  log(`Montado workspace (Live): ${workspaceName} -> ${remotePrefix}`);
                } else {
                  log(`Workspace detectado (Live): ${workspaceName}`);
                }
            }
          });
          
          // Optional: Handle removals if user is removed from workspace (complex due to local files cleanup)
        }, (err) => {
            log(`Error escuchando workspaces: ${err.message}`);
        });
    } catch (err) {
      log(`Error configurando listener de workspaces: ${err.message}`);
    }
  }

  async loadWorkspaceMounts() {
      // Keep initial load just in case, but rely on listener mostly
      this.setupWorkspaceListener();
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
        return;
      }
      const content = fs.readFileSync(localPath, "utf8");
      const snapshot = await this.db
        .collection("documents")
        .where("storagePath", "==", remotePath)
        .limit(1)
        .get();
      snapshot.forEach((doc) => {
        doc.ref.update({
          content,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        log(`Firestore actualizado: ${doc.id}`);
      });
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

    // CRITICAL FIX: Ignore files inside _ws dir if trying to upload via Root Mount
    // This allows dedicated mounts to handle them, preventing double uploads to personal space
    if (localPath.includes(`${path.sep}${WORKSPACE_DIR_PREFIX}${path.sep}`)) {
        // Just rely on getRemotePath picking the specific mount because mount points are sorted/checked
        // The issue is if a specific mount DOES NOT EXIST yet, it might default to root.
        // We ensure mounts are live-loaded now.
    }

    const remotePath = this.getRemotePath(localPath);
    if (!remotePath) return;

    // Double check: if remotePath is going to Personal Space (users/...) BUT it is a workspace file
    // abort to avoid pollution.
    if (remotePath.startsWith(`users/${WORKER_TOKEN}`) && localPath.includes(`${path.sep}${WORKSPACE_DIR_PREFIX}${path.sep}`)) {
        log(`Skipping upload of workspace file to personal storage: ${localPath}`);
        return;
    }

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

      await file.upload(localPath);
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

  async syncCycle() {
    if (this.cycleInProgress) return;
    this.cycleInProgress = true;
    try {
      for (const mount of this.mounts) {
        const [files] = await this.bucket.getFiles({
          prefix: `${mount.remote}/`,
        });

        for (const file of files) {
          if (file.name.endsWith("/")) continue;
          
          // CRITICAL FIX: Prevent root mount (Personal) from processing Workspace files
          // If current mount is the ROOT one (users/TOKEN), ignore any remote file 
          // that technically maps to "users/TOKEN/_ws/..." because that would conflict
          // with the dedicated workspace mount "workspaces/ID/...".
          // This prevents downloading polluted files from ROOT to Workspace folders.
          if (mount.local === SYNC_DIR && file.name.includes(`/${WORKSPACE_DIR_PREFIX}/`)) {
             continue;
          }

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

  ensureFirebase();
  const bucket = admin.storage().bucket();
  const db = admin.firestore();

  log(`Conectado a Firebase Storage: ${BUCKET_NAME}`);

  const manager = new SyncManager(bucket, db);
  await manager.loadWorkspaceMounts();

  const watcher = chokidar.watch(SYNC_DIR, {
    ignoreInitial: true,
    ignored: (filePath) => isIgnoredPath(filePath),
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
