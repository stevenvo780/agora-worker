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
    this.recentLocalChanges = new Map(); // Para evitar loops: local -> firebase -> local
    this.inFlight = new Set();
    this.downloadsInFlight = new Set();
    this.cycleInProgress = false;
    this.firestoreUnsubscribe = null;
    this.knownLocalFiles = new Set(); // Archivos que sabemos que existen localmente
    this.initialSyncDone = false; // Indica si ya se hizo el sync inicial

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

  // Registrar que conocemos un archivo local
  trackLocalFile(localPath) {
    this.knownLocalFiles.add(localPath);
  }

  // Verificar si un archivo estaba conocido localmente (fue borrado intencionalmente)
  wasKnownLocally(localPath) {
    return this.knownLocalFiles.has(localPath);
  }

  // Eliminar del tracking cuando se borra
  untrackLocalFile(localPath) {
    this.knownLocalFiles.delete(localPath);
  }

  // Marcar que un cambio local está en progreso (evita loops)
  markLocalChange(localPath) {
    this.recentLocalChanges.set(localPath, Date.now());
  }

  // Limpiar cambios locales antiguos
  cleanupLocalChanges() {
    const now = Date.now();
    for (const [filePath, ts] of this.recentLocalChanges.entries()) {
      if (now - ts > 5000) { // 5 segundos de gracia
        this.recentLocalChanges.delete(filePath);
      }
    }
  }

  // Verificar si un cambio viene de una acción local reciente
  isRecentLocalChange(localPath) {
    this.cleanupLocalChanges();
    return this.recentLocalChanges.has(localPath);
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

  // Listener de Firestore para sincronización bidireccional en tiempo real
  setupFirestoreListener() {
    log(`🔔 Configurando listener de Firestore para ${tokenInfo.workspaceId}...`);
    
    // Flag para ignorar el snapshot inicial (todos los docs aparecen como 'added')
    let isInitialSnapshot = true;
    
    // Query para documentos de este workspace
    let query;
    if (tokenInfo.workspaceType === 'personal') {
      query = this.db.collection("documents")
        .where("ownerId", "==", tokenInfo.userId);
    } else {
      query = this.db.collection("documents")
        .where("workspaceId", "==", tokenInfo.workspaceId);
    }

    this.firestoreUnsubscribe = query.onSnapshot(
      (snapshot) => {
        // Ignorar el snapshot inicial - el syncCycle se encargará de la sincronización inicial
        if (isInitialSnapshot) {
          isInitialSnapshot = false;
          log(`📋 Snapshot inicial ignorado (${snapshot.size} documentos)`);
          return;
        }
        
        snapshot.docChanges().forEach(async (change) => {
          const doc = change.doc;
          const data = doc.data();
          
          if (!data.storagePath) return;
          
          const localPath = this.getLocalPath(data.storagePath);
          if (!localPath) return;
          
          // Evitar procesar cambios que nosotros mismos causamos
          if (this.isRecentLocalChange(localPath)) {
            log(`⏭️ Ignorando cambio propio: ${data.name || doc.id}`);
            return;
          }

          if (change.type === 'added' || change.type === 'modified') {
            // Descargar/actualizar archivo desde Firebase
            log(`📨 Firestore: ${change.type} ${data.name || doc.id}`);
            await this.syncDocumentToLocal(data, localPath);
          } else if (change.type === 'removed') {
            // Borrar archivo local cuando se borra de Firebase
            log(`📨 Firestore: removed ${data.name || doc.id}`);
            await this.deleteLocalFile(localPath, data.name || doc.id);
          }
        });
      },
      (error) => {
        log(`❌ Error en listener de Firestore: ${error.message}`);
      }
    );

    log(`✅ Listener de Firestore activo`);
  }

  // Sincronizar un documento de Firestore al archivo local
  async syncDocumentToLocal(docData, localPath) {
    try {
      // Para archivos de texto, usar el contenido de Firestore
      const ext = path.extname(localPath).toLowerCase();
      if (TEXT_EXTS.has(ext) && docData.content !== undefined) {
        // Verificar si el contenido local es diferente
        if (fs.existsSync(localPath)) {
          const localContent = fs.readFileSync(localPath, 'utf8');
          if (localContent === docData.content) {
            return; // Sin cambios
          }
        }
        
        // Crear directorio si no existe
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        
        // Escribir contenido
        fs.writeFileSync(localPath, docData.content, 'utf8');
        this.recentDownloads.set(localPath, Date.now());
        log(`📥 Sincronizado desde Firestore: ${docData.name || path.basename(localPath)}`);
      } else {
        // Para archivos binarios, descargar de Storage
        const file = this.bucket.file(docData.storagePath);
        const [exists] = await file.exists();
        if (exists) {
          fs.mkdirSync(path.dirname(localPath), { recursive: true });
          await file.download({ destination: localPath });
          this.recentDownloads.set(localPath, Date.now());
          log(`📥 Descargado desde Storage: ${docData.name || path.basename(localPath)}`);
        }
      }
    } catch (err) {
      log(`❌ Error sincronizando documento a local: ${err.message}`);
    }
  }

  // Borrar archivo local cuando se elimina de Firebase
  async deleteLocalFile(localPath, fileName) {
    try {
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
        log(`🗑️ Archivo local eliminado: ${fileName}`);
        
        // Limpiar directorio padre si está vacío
        const parentDir = path.dirname(localPath);
        if (parentDir !== SYNC_DIR) {
          try {
            const files = fs.readdirSync(parentDir);
            if (files.length === 0) {
              fs.rmdirSync(parentDir);
              log(`🗑️ Directorio vacío eliminado: ${path.basename(parentDir)}`);
            }
          } catch (_err) {
            // Ignorar errores al limpiar directorios
          }
        }
      }
    } catch (err) {
      log(`❌ Error eliminando archivo local: ${err.message}`);
    }
  }

  // También borrar archivo de Storage cuando se elimina de Firestore
  async deleteFromStorage(storagePath, fileName) {
    try {
      const file = this.bucket.file(storagePath);
      const [exists] = await file.exists();
      if (exists) {
        await file.delete();
        log(`🗑️ Archivo eliminado de Storage: ${fileName}`);
      }
    } catch (err) {
      log(`❌ Error eliminando de Storage: ${err.message}`);
    }
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

    // Marcar como cambio local para evitar que el listener lo procese de vuelta
    this.markLocalChange(localPath);

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
      this.trackLocalFile(localPath); // Registrar que este archivo existe localmente
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
    log(`🔄 Iniciando ciclo de sincronización...`);
    try {
      for (const mount of this.mounts) {
        log(`📂 Procesando mount: ${mount.local} -> ${mount.remote}`);
        // Get remote files from Storage
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

        // También obtener documentos de Firestore para detectar borrados
        let firestoreDocsQuery;
        if (tokenInfo.workspaceType === 'personal') {
          firestoreDocsQuery = this.db.collection("documents")
            .where("ownerId", "==", tokenInfo.userId);
        } else {
          firestoreDocsQuery = this.db.collection("documents")
            .where("workspaceId", "==", tokenInfo.workspaceId);
        }
        const firestoreDocs = await firestoreDocsQuery.get();
        const firestorePathSet = new Set();
        firestoreDocs.forEach(doc => {
          const data = doc.data();
          if (data.storagePath) {
            firestorePathSet.add(data.storagePath);
          }
        });

        // PART 1: Scan local files
        const localFiles = this.scanLocalFiles(mount.local);
        const localPathSet = new Set(localFiles);
        
        for (const localPath of localFiles) {
          const remotePath = this.getRemotePath(localPath);
          if (!remotePath) continue;
          
          const ext = path.extname(localPath).toLowerCase();
          const isTextFile = TEXT_EXTS.has(ext);
          const existsInFirestore = firestorePathSet.has(remotePath);
          const existsInStorage = remotePathSet.has(remotePath);
          
          // Para archivos de TEXTO:
          // - Firestore es la fuente de verdad
          // - Si no existe en Firestore, borrarlo localmente (fue eliminado desde UI)
          // - Solo subir si es un archivo NUEVO (no existe en Firestore ni en Storage)
          if (isTextFile) {
            if (!existsInFirestore && existsInStorage) {
              // Archivo fue borrado de Firestore pero aún existe en Storage
              // Borrar localmente, PART 2 limpiará Storage
              log(`🗑️ Borrando archivo local (borrado de Firestore): ${path.basename(localPath)}`);
              await this.deleteLocalFile(localPath, path.basename(localPath));
              continue;
            }
            
            if (!existsInFirestore && !existsInStorage) {
              // Archivo nuevo creado localmente - subirlo
              await this.uploadFile(localPath);
              continue;
            }
            
            // Si existe en Firestore, sincronizar normalmente
            if (existsInFirestore && !existsInStorage) {
              await this.uploadFile(localPath);
            }
          } else {
            // Para archivos NO de texto (binarios), subir si no existe en Storage
            if (!existsInStorage) {
              await this.uploadFile(localPath);
            }
          }
        }

        // PART 2: Process remote files (download new ones, sync existing)
        // IMPORTANTE: Solo descargar archivos que existen en Firestore
        // Si un archivo existe en Storage pero no en Firestore, NO descargarlo
        for (const file of remoteFiles) {
          if (file.name.endsWith("/")) continue;

          const localPath = this.getLocalPath(file.name);
          if (!localPath) continue;
          if (isIgnoredPath(localPath)) continue;

          // Verificar si el archivo existe en Firestore antes de descargarlo
          const ext = path.extname(localPath).toLowerCase();
          if (TEXT_EXTS.has(ext) && !firestorePathSet.has(file.name)) {
            // El archivo existe en Storage pero NO en Firestore
            // No descargarlo - probablemente fue borrado desde la UI
            // También borrarlo de Storage para limpiar
            log(`🧹 Archivo huérfano en Storage (no en Firestore): ${path.basename(localPath)}`);
            try {
              await file.delete();
              log(`🗑️ Eliminado de Storage: ${file.name}`);
            } catch (err) {
              log(`⚠️ Error eliminando de Storage: ${err.message}`);
            }
            continue;
          }

          const localExists = fs.existsSync(localPath);
          
          if (!localExists) {
            // El archivo no existe localmente
            // ¿Fue borrado intencionalmente desde el worker?
            if (this.initialSyncDone && this.wasKnownLocally(localPath)) {
              // Sí, el archivo existía antes y ahora no está
              // Propagar el borrado a Firebase
              log(`🗑️ Detectado borrado local de: ${path.basename(localPath)}`);
              this.untrackLocalFile(localPath);
              
              // Buscar y borrar el documento de Firestore
              const snapshot = await this.db
                .collection("documents")
                .where("storagePath", "==", file.name)
                .limit(1)
                .get();
              
              if (!snapshot.empty) {
                const doc = snapshot.docs[0];
                await doc.ref.delete();
                log(`🗑️ Documento Firestore eliminado: ${doc.id}`);
                this.notifyFileChange('deleted', path.basename(localPath), doc.id);
              }
              
              // Borrar del Storage
              try {
                await file.delete();
                log(`🗑️ Archivo Storage eliminado: ${file.name}`);
              } catch (err) {
                log(`⚠️ Error eliminando de Storage: ${err.message}`);
              }
              continue;
            }
            
            // Es un archivo nuevo que aún no se ha descargado
            await this.downloadFile(file);
            continue;
          }
          
          // El archivo existe localmente, registrarlo si no lo hemos hecho
          this.trackLocalFile(localPath);

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
        
        // Marcar que el sync inicial ha terminado
        if (!this.initialSyncDone) {
          this.initialSyncDone = true;
          log(`✅ Sincronización inicial completada - borrados locales ahora se propagarán`);
        }

        // PART 3 eliminada - la limpieza de huérfanos ahora se hace en PART 2
        // El listener de Firestore se encarga de borrar archivos locales cuando se borran de Firestore
      }
    } catch (err) {
      log(`❌ Error en sync cycle: ${err.message}`);
      console.error(err.stack);
    } finally {
      log(`✅ Ciclo de sincronización completado`);
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

  // Configurar listener de Firestore para sincronización bidireccional en tiempo real
  manager.setupFirestoreListener();

  // Escuchar eventos del Hub para sincronización inmediata
  socket.on("remote-doc-change", async (data) => {
    log(`📨 Evento remoto recibido: ${data.action} ${data.docId || ''}`);
    // Forzar un ciclo de sincronización inmediato
    await manager.syncCycle();
  });

  const watcher = chokidar.watch(SYNC_DIR, {
    ignoreInitial: true,
    ignored: (filePath) => isIgnoredPath(filePath),
    usePolling: true,
    interval: 5000,
    binaryInterval: 10000,
  });

  watcher.on("add", (filePath) => manager.uploadFile(filePath));
  watcher.on("change", (filePath) => manager.uploadFile(filePath));
  
  // Detectar borrados locales y propagarlos a Firebase
  watcher.on("unlink", async (filePath) => {
    const remotePath = manager.getRemotePath(filePath);
    if (!remotePath) return;
    
    log(`🗑️ Archivo local eliminado: ${path.basename(filePath)}`);
    
    try {
      // Buscar y borrar el documento de Firestore
      const snapshot = await db
        .collection("documents")
        .where("storagePath", "==", remotePath)
        .limit(1)
        .get();
      
      if (!snapshot.empty) {
        const doc = snapshot.docs[0];
        await doc.ref.delete();
        log(`🗑️ Documento Firestore eliminado: ${doc.id}`);
        manager.notifyFileChange('deleted', path.basename(filePath), doc.id);
      }
      
      // Borrar del Storage
      const file = bucket.file(remotePath);
      const [exists] = await file.exists();
      if (exists) {
        await file.delete();
        log(`🗑️ Archivo Storage eliminado: ${remotePath}`);
      }
    } catch (err) {
      log(`❌ Error propagando borrado: ${err.message}`);
    }
  });

  log(`Escuchando cambios en ${SYNC_DIR}`);
  log(`🔄 Sincronización bidireccional activa`);

  // Ejecutar sync cycle inicial
  await manager.syncCycle();

  setInterval(() => {
    manager.syncCycle();
  }, POLL_INTERVAL_MS);
}

run().catch((err) => {
  log(`Fallo fatal: ${err.message}`);
  process.exit(1);
});
