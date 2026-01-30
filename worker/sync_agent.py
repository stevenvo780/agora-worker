import time
import os
import sys
import logging
import hashlib
import base64
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import firebase_admin
from firebase_admin import credentials, storage, firestore

# Configuration
# Env vars provided by the Docker container
WORKER_TOKEN = os.getenv("WORKER_TOKEN", "unknown-worker")
BUCKET_NAME = os.getenv("FIREBASE_BUCKET", "udea-filosofia.firebasestorage.app") # Default or from env
SYNC_DIR = Path("/workspace")
POLL_INTERVAL = 10
CLOCK_SKEW_SECONDS = 2
DOWNLOAD_GRACE_SECONDS = 3

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s')
logger = logging.getLogger("SyncAgent")

# Initialize Firebase
app_firebase = None
try:
    # Check for mounted credentials
    cred_path = "/app/serviceAccountKey.json"
    if os.path.exists(cred_path):
        cred = credentials.Certificate(cred_path)
        app_firebase = firebase_admin.initialize_app(cred, {'storageBucket': BUCKET_NAME})
    else:
        # Fallback to default (ADC)
        app_firebase = firebase_admin.initialize_app(None, {'storageBucket': BUCKET_NAME})
    
    bucket = storage.bucket()
    db = firestore.client()
    logger.info(f"✅ Connected to Firebase Storage: {BUCKET_NAME}")
except Exception as e:
    logger.error(f"❌ Failed to initialize Firebase: {e}")
    sys.exit(1)

class SyncManager:
    def __init__(self):
        self.ignore_list = ['.git', '.DS_Store', 'node_modules', '.next']
        self._is_updating = False
        self._recent_downloads = {}
        # Map: local_path_prefix -> remote_storage_prefix
        # Default: personal workspace
        self.mounts = {
            SYNC_DIR: f"users/{WORKER_TOKEN}"
        }
        self.load_workspace_mounts()

    def load_workspace_mounts(self):
        """Discovers shared workspaces and adds them as subfolders in /workspace"""
        try:
            # 1. Find workspaces where I am a member
            # Note: Firestore 'in' query limited to 10, 'array-contains' is safe for 1 item
            docs = db.collection('workspaces').where('members', 'array_contains', WORKER_TOKEN).stream()
            
            for doc in docs:
                data = doc.to_dict()
                ws_name = data.get('name', doc.id).strip().replace('/', '_') # Sanitize
                ws_id = doc.id
                
                # Check for collision with normal files, maybe use a "Shared" folder?
                # For now, mount at /workspace/{WorkspaceName}
                mount_point = SYNC_DIR / ws_name
                remote_prefix = f"workspaces/{ws_id}"
                
                self.mounts[mount_point] = remote_prefix
                
                if not mount_point.exists():
                    try:
                        mount_point.mkdir(exist_ok=True)
                        logger.info(f"📂 Mounted Shared Workspace: {ws_name} -> {remote_prefix}")
                    except Exception as e:
                        logger.error(f"Failed to mount {ws_name}: {e}")
                else:
                    logger.info(f"📂 Detected Shared Workspace: {ws_name}")

        except Exception as e:
            logger.error(f"Error loading workspaces: {e}")

    def get_remote_path(self, local_path):
        """Maps local path to remote based on mounts"""
        # Find the most specific mount point
        best_mount = None
        best_len = 0
        
        for mount_point, remote_prefix in self.mounts.items():
            try:
                # Check if local_path is inside mount_point
                if local_path == mount_point or mount_point in local_path.parents:
                    if len(str(mount_point)) > best_len:
                        best_mount = mount_point
                        best_len = len(str(mount_point))
            except:
                pass
        
        if not best_mount: return None

        rel = local_path.relative_to(best_mount)
        remote = self.mounts[best_mount]
        return f"{remote}/{rel}"

    def _is_ignored(self, local_path):
        try:
            rel = local_path.relative_to(SYNC_DIR)
        except ValueError:
            return True

        for part in rel.parts:
            if part in self.ignore_list:
                return True
            if part.startswith('.'):
                return True
        return False

    def _local_md5_b64(self, local_path):
        digest = hashlib.md5()
        with open(local_path, 'rb') as handle:
            for chunk in iter(lambda: handle.read(8192), b''):
                digest.update(chunk)
        return base64.b64encode(digest.digest()).decode('utf-8')

    def _cleanup_recent_downloads(self):
        now = time.time()
        stale = [path for path, ts in self._recent_downloads.items() if now - ts > DOWNLOAD_GRACE_SECONDS]
        for path in stale:
            self._recent_downloads.pop(path, None)

    def get_local_path(self, remote_blob_name):
        """Maps remote path to local based on mounts"""
        # Iterate mounts to find which one matches this blob prefix
        for mount_point, remote_prefix in self.mounts.items():
            if remote_blob_name.startswith(f"{remote_prefix}/"):
                rel = remote_blob_name[len(remote_prefix)+1:]
                return mount_point / rel
        return None

    def update_firestore(self, blob_path, local_path):
        """Syncs content back to Firestore for UI visibility"""
        try: 
            # Check if text file
            if local_path.suffix.lower() not in ['.md', '.txt', '.js', '.ts', '.tsx', '.json', '.css', '.html']:
                return

            content = local_path.read_text(encoding='utf-8', errors='ignore')
            
            # Find document with this storagePath
            docs = db.collection('documents').where('storagePath', '==', blob_path).limit(1).stream()
            doc_found = False
            for doc in docs:
                doc.reference.update({
                    'content': content,
                    'updatedAt': firestore.firestore.SERVER_TIMESTAMP
                })
                logger.info(f"🔄 Updated Firestore Doc: {doc.id}")
                doc_found = True
            
            # Optional: Create if not exists? (Maybe too aggressive for now, UI should create)
        except Exception as e:
            logger.error(f"Firestore Sync Error: {e}")

    def upload_file(self, local_path):
        if self._is_updating: return
        if self._is_ignored(local_path): return
        if not local_path.exists() or not local_path.is_file():
            return
        self._cleanup_recent_downloads()
        if str(local_path) in self._recent_downloads:
            return
        try:
            blob_path = self.get_remote_path(local_path)
            if not blob_path: return

            remote_blob = bucket.get_blob(blob_path)
            if remote_blob and remote_blob.md5_hash:
                local_md5 = self._local_md5_b64(local_path)
                if remote_blob.md5_hash == local_md5:
                    return

            blob = bucket.blob(blob_path)
            blob.upload_from_filename(str(local_path))
            logger.info(f"⬆️  Uploaded: {local_path.name}")
            
            # Trigger Firestore update
            self.update_firestore(blob_path, local_path)
            
        except Exception as e:
            logger.error(f"Error uploading {local_path}: {e}")

    def download_file(self, blob):
        self._is_updating = True
        try:
            local_path = self.get_local_path(blob.name)
            if not local_path: return
            if self._is_ignored(local_path): return

            local_path.parent.mkdir(parents=True, exist_ok=True)
            blob.download_to_filename(str(local_path))
            if blob.updated:
                updated_ts = blob.updated.timestamp()
                os.utime(local_path, (updated_ts, updated_ts))
            logger.info(f"⬇️  Downloaded: {local_path.name}")
            self._recent_downloads[str(local_path)] = time.time()
        except Exception as e:
            logger.error(f"Error downloading {blob.name}: {e}")
        finally:
            time.sleep(1) # Debounce
            self._is_updating = False

    def sync_cycle(self):
        """Polls for remote changes across all mounts"""
        try:
            for mount_point, prefix in self.mounts.items():
                blobs = bucket.list_blobs(prefix=f"{prefix}/")
                for blob in blobs:
                    if blob.name.endswith('/'): continue
                    
                    local_path = self.get_local_path(blob.name)
                    if not local_path: continue
                    if self._is_ignored(local_path): continue

                    if not local_path.exists():
                        self.download_file(blob)
                        continue

                    local_stat = local_path.stat()
                    local_mtime = local_stat.st_mtime
                    remote_updated = blob.updated.timestamp() if blob.updated else None

                    if remote_updated is None:
                        self.download_file(blob)
                        continue

                    if remote_updated > local_mtime + CLOCK_SKEW_SECONDS:
                        self.download_file(blob)
                        continue
                    if local_mtime > remote_updated + CLOCK_SKEW_SECONDS:
                        self.upload_file(local_path)
                        continue

                    if blob.md5_hash:
                        local_md5 = self._local_md5_b64(local_path)
                        if blob.md5_hash == local_md5:
                            continue

                    self.download_file(blob)
        except Exception as e:
            logger.error(f"Sync cycle error: {e}")

class LocalHandler(FileSystemEventHandler):
    def __init__(self, manager):
        self.manager = manager

    def on_modified(self, event):
        if event.is_directory: return
        self._process(Path(event.src_path))

    def on_created(self, event):
        if event.is_directory: return
        self._process(Path(event.src_path))

    def _process(self, path):
        if path.name.startswith('.'): return
        try:
            # Ensure path is within SYNC_DIR
            path.relative_to(SYNC_DIR) 
            if self.manager._is_ignored(path): return
            logger.info(f"📝 Local change: {path.name}")
            self.manager.upload_file(path)
        except ValueError:
            pass

def run():
    if not SYNC_DIR.exists():
        logger.error(f"Sync directory {SYNC_DIR} does not exist!")
        return

    manager = SyncManager()
    observer = Observer()
    observer.schedule(LocalHandler(manager), str(SYNC_DIR), recursive=True)
    observer.start()
    logger.info(f"👀 Watching {SYNC_DIR}")

    try:
        while True:
            manager.sync_cycle()
            time.sleep(POLL_INTERVAL)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()

if __name__ == "__main__":
    run()
