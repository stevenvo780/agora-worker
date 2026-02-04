import fs from "fs";
import path from "path";
import crypto from "crypto";
import chokidar from "chokidar";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithCustomToken } from "firebase/auth";
import { 
  getFirestore, collection, query, where, onSnapshot, 
  getDocs, addDoc, updateDoc, deleteDoc, 
  serverTimestamp 
} from "firebase/firestore";
import { 
  getStorage, ref, uploadBytes, 
  getMetadata, deleteObject, getBytes, listAll 
} from "firebase/storage";
import { io } from "socket.io-client";

const WORKER_TOKEN = process.env.WORKER_TOKEN || "";
const NEXUS_URL = process.env.NEXUS_URL || "http://localhost:3010";
// Configuración de Firebase debe venir por variable de entorno JSON
const FIREBASE_CONFIG = process.env.FIREBASE_CONFIG 
  ? JSON.parse(process.env.FIREBASE_CONFIG) 
  : { storageBucket: process.env.FIREBASE_BUCKET || "udea-filosofia.firebasestorage.app" };

const SYNC_DIR = "/workspace";
const POLL_INTERVAL_MS = (() => {
  const raw = process.env.SYNC_POLL_MS;
  const parsed = raw ? Number(raw) : 30000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
})();
const CLOCK_SKEW_MS = 2000;
const DOWNLOAD_GRACE_MS = 15000; // Aumentado a 15s para dar margen al polling de Chokidar (5s) + latencia

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


// Inicialización de Firebase Client SDK
const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);


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
    this.isShuttingDown = false; // Flag de apagado

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
    let q;
    const docsRef = collection(this.db, "documents");
    if (tokenInfo.workspaceType === 'personal') {
      q = query(docsRef, where("ownerId", "==", tokenInfo.userId));
    } else {
      q = query(docsRef, where("workspaceId", "==", tokenInfo.workspaceId));
    }

    this.firestoreUnsubscribe = onSnapshot(q,
      (snapshot) => {
        // Ignorar el snapshot inicial - el syncCycle se encargará de la sincronización inicial
        if (isInitialSnapshot) {
          isInitialSnapshot = false;
          log(`📋 Snapshot inicial ignorado (${snapshot.size} documentos)`);
          return;
        }
        
        snapshot.docChanges().forEach(async (change) => {
          const docSnap = change.doc;
          const data = docSnap.data();
          
          if (!data.storagePath) return;
          
          const localPath = this.getLocalPath(data.storagePath);
          if (!localPath) return;
          
          // Evitar procesar cambios que nosotros mismos causamos
          if (this.isRecentLocalChange(localPath)) {
            log(`⏭️ Ignorando cambio propio: ${data.name || docSnap.id}`);
            return;
          }

          if (change.type === 'added' || change.type === 'modified') {
            // Descargar/actualizar archivo desde Firebase
            log(`📨 Firestore: ${change.type} ${data.name || docSnap.id}`);
            await this.syncDocumentToLocal(data, localPath);
          } else if (change.type === 'removed') {
            // Borrar archivo local cuando se borra de Firebase
            log(`📨 Firestore: removed ${data.name || docSnap.id}`);
            await this.deleteLocalFile(localPath, data.name || docSnap.id);
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
        const fileRef = ref(this.storage, docData.storagePath);
        try {
          const buffer = await getBytes(fileRef);
          fs.mkdirSync(path.dirname(localPath), { recursive: true });
          fs.writeFileSync(localPath, Buffer.from(buffer));
          this.recentDownloads.set(localPath, Date.now());
          log(`📥 Descargado desde Storage: ${docData.name || path.basename(localPath)}`);
        } catch (err) {
          if (err.code !== 'storage/object-not-found') {
             throw err;
          }
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
      const fileRef = ref(this.storage, storagePath);
      await deleteObject(fileRef);
      log(`🗑️ Archivo eliminado de Storage: ${fileName}`);
    } catch (err) {
      if (err.code !== 'storage/object-not-found') {
        log(`❌ Error eliminando de Storage: ${err.message}`);
      }
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
      
      const q = query(
        collection(this.db, "documents"), 
        where("storagePath", "==", remotePath)
      );
      const snapshot = await getDocs(q);
      
      if (snapshot.empty) {
        // Crear nuevo documento en Firestore si no existe
        const fileName = path.basename(localPath);
        
        // Calcular el folder basado en la estructura de directorios
        const relPath = path.relative(SYNC_DIR, localPath);
        const dirPath = path.dirname(relPath);
        // Si está en la raíz, usar "No estructurado", sino usar el path de directorio
        const folder = (dirPath === '.' || dirPath === '') ? 'No estructurado' : dirPath.split(path.sep).join('/');
        
        const docData = {
          name: fileName.replace(/\.[^/.]+$/, ""), // nombre sin extensión
          content,
          storagePath: remotePath,
          workspaceId: tokenInfo.workspaceId,
          ownerId: tokenInfo.userId || tokenInfo.workspaceId,
          folder: folder,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        const newDoc = await addDoc(collection(this.db, "documents"), docData);
        log(`Firestore documento creado: ${newDoc.id} (${fileName}) en carpeta: ${folder}`);
        this.notifyFileChange('created', fileName, newDoc.id);
      } else {
        snapshot.forEach(async (docSnap) => {
          await updateDoc(docSnap.ref, {
            content,
            updatedAt: serverTimestamp(),
          });
          log(`Firestore actualizado: ${docSnap.id}`);
          this.notifyFileChange('updated', path.basename(localPath), docSnap.id);
        });
      }
    } catch (err) {
      log(`Error sincronizando Firestore: ${err.message}`);
    }
  }

  async uploadFile(localPath) {
    if (this.isShuttingDown) return;
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
      const fileRef = ref(this.storage, remotePath);
      let metadata = null;
      try {
        metadata = await getMetadata(fileRef);
      } catch (err) {
        if (err.code !== 'storage/object-not-found') throw err;
      }

      if (metadata && metadata.md5Hash) {
        const localMd5 = await md5Base64(localPath);
        if (metadata.md5Hash === localMd5) {
          return;
        }
      }

      const content = fs.readFileSync(localPath);
      await uploadBytes(fileRef, content);
      log(`Subido: ${path.basename(localPath)}`);
      await this.updateFirestore(remotePath, localPath);
    } catch (err) {
      log(`Error subiendo ${localPath}: ${err.message}`);
    } finally {
      this.inFlight.delete(localPath);
    }
  }

  async downloadFile(fileRef) {
    if (this.isShuttingDown) return;
    if (this.downloadsInFlight.has(fileRef.fullPath)) return;
    this.downloadsInFlight.add(fileRef.fullPath);
    try {
      const localPath = this.getLocalPath(fileRef.fullPath);
      if (!localPath) return;
      if (isIgnoredPath(localPath)) return;

      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      const buffer = await getBytes(fileRef);
      fs.writeFileSync(localPath, Buffer.from(buffer));

      try {
        const metadata = await getMetadata(fileRef);
        const updated = metadata.updated;
        if (updated) {
          const ts = new Date(updated).getTime() / 1000;
          fs.utimesSync(localPath, ts, ts);
        }
      } catch (e) {
        // Ignore metadata error
      }

      log(`Descargado: ${path.basename(localPath)}`);
      this.recentDownloads.set(localPath, Date.now());
      this.trackLocalFile(localPath); // Registrar que este archivo existe localmente
    } catch (err) {
      log(`Error descargando ${fileRef.fullPath}: ${err.message}`);
    } finally {
      this.downloadsInFlight.delete(fileRef.fullPath);
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

  async listRemoteFilesRecursive(folderRef, files = []) {
      const res = await listAll(folderRef);
      for (const itemRef of res.items) {
          files.push(itemRef);
      }
      for (const prefixRef of res.prefixes) {
          await this.listRemoteFilesRecursive(prefixRef, files);
      }
      return files;
  }

  async handleLocalDelete(filePath) {
      const remotePath = this.getRemotePath(filePath);
      if (!remotePath) return;
      
      log(`🗑️ Archivo local eliminado: ${path.basename(filePath)}`);
      
      try {
        const q = query(
          collection(this.db, "documents"),
          where("storagePath", "==", remotePath)
        );
        const snapshot = await getDocs(q);
        
        if (!snapshot.empty) {
          const docSnap = snapshot.docs[0];
          await deleteDoc(docSnap.ref);
          log(`🗑️ Documento Firestore eliminado: ${docSnap.id}`);
          this.notifyFileChange('deleted', path.basename(filePath), docSnap.id);
        }
        
        await this.deleteFromStorage(remotePath, path.basename(filePath));
      } catch (err) {
        log(`❌ Error propagando borrado: ${err.message}`);
      }
  }

  async syncCycle() {
    if (this.cycleInProgress || this.isShuttingDown) return;
    this.cycleInProgress = true;
    log(`🔄 Iniciando ciclo de sincronización...`);
    try {
      for (const mount of this.mounts) {
        log(`📂 Procesando mount: ${mount.local} -> ${mount.remote}`);
        
        // List remote files recursively
        const mountRef = ref(this.storage, mount.remote);
        const remoteFiles = await this.listRemoteFilesRecursive(mountRef);

        // Build a set of remote paths for quick lookup
        const remotePathSet = new Set();
        for (const fileRef of remoteFiles) {
           remotePathSet.add(fileRef.fullPath);
        }

        // Firestore Docs
        let q;
        if (tokenInfo.workspaceType === 'personal') {
           q = query(collection(this.db, 'documents'), where('ownerId', '==', tokenInfo.userId));
        } else {
           q = query(collection(this.db, 'documents'), where("workspaceId", "==", tokenInfo.workspaceId));
        }
        
        const firestoreDocs = await getDocs(q);
        const firestorePathSet = new Set();
        firestoreDocs.forEach(docSnap => {
            const data = docSnap.data();
            if (data.storagePath) firestorePathSet.add(data.storagePath);
        });

        // PART 1: Scan local files
        const localFiles = this.scanLocalFiles(mount.local);
        
        for (const localPath of localFiles) {
          const remotePath = this.getRemotePath(localPath);
          if (!remotePath) continue;
          
          const ext = path.extname(localPath).toLowerCase();
          const isTextFile = TEXT_EXTS.has(ext);
          const existsInFirestore = firestorePathSet.has(remotePath);
          const existsInStorage = remotePathSet.has(remotePath);
          
          if (isTextFile) {
            if (!existsInFirestore && existsInStorage) {
              log(`⚠️ Conflicto detectado (Falta en Firestore): ${path.basename(localPath)}`);
              await this.updateFirestore(remotePath, localPath);
              continue;
            }
            if (!existsInFirestore && !existsInStorage) {
              await this.uploadFile(localPath);
              continue;
            }
            if (existsInFirestore && !existsInStorage) {
              await this.uploadFile(localPath);
            }
          } else {
            if (!existsInStorage) {
              await this.uploadFile(localPath);
            }
          }
        }

        // PART 2: Process remote files
        for (const fileRef of remoteFiles) {
          // Verify if exists in Firestore
          // Note: fileRef.fullPath is the path
          const ext = path.extname(fileRef.name).toLowerCase();
          
          // Check ignoring logic for path? getLocalPath handles it
          const localPath = this.getLocalPath(fileRef.fullPath);
          if (!localPath || isIgnoredPath(localPath)) continue;

          if (TEXT_EXTS.has(ext) && !firestorePathSet.has(fileRef.fullPath)) {
            log(`🧹 Archivo huérfano en Storage: ${path.basename(localPath)}`);
            try {
              await deleteObject(fileRef);
            } catch (err) {
              log(`⚠️ Error eliminando huérfano: ${err.message}`);
            }
            continue;
          }

          const localExists = fs.existsSync(localPath);
          
          if (!localExists) {
            if (this.initialSyncDone && this.wasKnownLocally(localPath)) {
              // Deleted locally, propagate delete
              log(`🗑️ Detectado borrado local: ${path.basename(localPath)}`);
              this.untrackLocalFile(localPath);
              await this.handleLocalDelete(localPath);
              continue;
            }
            await this.downloadFile(fileRef);
            continue;
          }
          
          this.trackLocalFile(localPath);

          const localStat = fs.statSync(localPath);
          const localMtimeMs = localStat.mtimeMs;
          
          let remoteUpdatedMs = 0;
          try {
             const metadata = await getMetadata(fileRef);
             const updatedStr = metadata.updated;
             remoteUpdatedMs = updatedStr ? new Date(updatedStr).getTime() : 0;
          } catch(e) {
            // Ignore metadata error
          }

          if (!remoteUpdatedMs) {
            await this.downloadFile(fileRef);
            continue;
          }

          if (remoteUpdatedMs > localMtimeMs + CLOCK_SKEW_MS) {
            await this.downloadFile(fileRef);
            continue;
          }
          if (localMtimeMs > remoteUpdatedMs + CLOCK_SKEW_MS) {
            await this.uploadFile(localPath);
            continue;
          }
          // MD5 check? Client SDK doesn't expose MD5 easily in metadata response sometimes, or it's base64.
          // Let's skip MD5 for now or check if it exists in metadata object.
          // metadata.md5Hash exists.
        }
        
        if (!this.initialSyncDone) {
          this.initialSyncDone = true;
          log(`✅ Sincronización inicial completada`);
        }
      }
    } catch (err) {
      log(`❌ Error en sync cycle: ${err.message}`);
      console.error(err.stack);
    } finally {
      log(`✅ Ciclo de sincronización completado`);
      this.cycleInProgress = false;
    }
  }

  async shutdown() {
    this.isShuttingDown = true;
    log('🛑 Iniciando apagado seguro...');
    if (this.firestoreUnsubscribe) {
        this.firestoreUnsubscribe();
    }
    if (this.socket) {
        this.socket.disconnect();
    }
  }
}

async function run() {
  if (!fs.existsSync(SYNC_DIR)) {
    log(`Directorio no existe: ${SYNC_DIR}`);
    return;
  }

  const socket = io(NEXUS_URL, {
    auth: {
      type: "sync-agent",
      workerToken: WORKER_TOKEN
    },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000
  });

  socket.on("connect", () => {
    log(`📡 Conectado al Hub (Socket ID: ${socket.id})`);
  });

  socket.on("connect_error", (err) => {
    log(`⚠️ Error conectando al Hub: ${err.message}`);
  });

  socket.on('firebase-custom-token', async ({ token }) => {
    try {
      await signInWithCustomToken(auth, token);
      log(`🔐 Autenticado con Firebase Custom Token`);
      
      const manager = new SyncManager(storage, db, socket);
      await manager.loadWorkspaceMounts();
      manager.setupFirestoreListener();
      
      socket.on("remote-doc-change", async (data) => {
        log(`📨 Evento remoto recibido: ${data.action} ${data.docId || ''}`);
      });

      const watcher = chokidar.watch(SYNC_DIR, {
        ignoreInitial: true,
        ignored: (filePath) => isIgnoredPath(filePath),
        usePolling: true,
        interval: 5000,
        binaryInterval: 10000,
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }
      });

      watcher.on("add", (fp) => manager.uploadFile(fp));
      watcher.on("change", (fp) => manager.uploadFile(fp));
      watcher.on("unlink", (fp) => manager.handleLocalDelete(fp));

      log(`Escuchando cambios en ${SYNC_DIR}`);

      await manager.syncCycle();

      const intervalId = setInterval(() => {
        manager.syncCycle();
      }, POLL_INTERVAL_MS);

      const handleSignal = async (signal) => {
        log(`\n🛑 Recibida señal ${signal}`);
        clearInterval(intervalId);
        await watcher.close();
        await manager.shutdown();
        process.exit(0);
      };

      process.on('SIGTERM', () => handleSignal('SIGTERM'));
      process.on('SIGINT', () => handleSignal('SIGINT'));

    } catch(e) {
      log(`❌ Error fatal iniciando sync: ${e.message}`);
    }
  });
}

run().catch((err) => {
  log(`Fallo fatal: ${err.message}`);
  process.exit(1);
});
