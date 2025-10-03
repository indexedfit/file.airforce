// @ts-check
import * as Y from 'yjs'
import { ROOM_TOPIC } from './constants.js'

/**
 * Y.js document manager - handles CRDT sync over libp2p gossipsub
 * No y-webrtc or y-libp2p-connector - we use our existing libp2p mesh
 */

// ===== Persistence (OPFS + IndexedDB fallback) =====

async function hasOPFS() {
  try {
    return !!(navigator?.storage?.getDirectory);
  } catch {
    return false;
  }
}

class OPFSPersistence {
  constructor(docName) {
    this.docName = docName;
    this.dir = null;
    this.file = null;
  }

  async init() {
    try {
      const root = await navigator.storage.getDirectory();
      this.dir = await root.getDirectoryHandle('ydocs', { create: true });
      this.file = await this.dir.getFileHandle(`${this.docName}.yjs`, { create: true });
      return true;
    } catch {
      return false;
    }
  }

  async load() {
    try {
      const handle = await this.dir.getFileHandle(`${this.docName}.yjs`);
      const file = await handle.getFile();
      const buffer = await file.arrayBuffer();
      return new Uint8Array(buffer);
    } catch {
      return null;
    }
  }

  async save(update) {
    try {
      const writable = await this.file.createWritable();
      await writable.write(update);
      await writable.close();
      return true;
    } catch {
      return false;
    }
  }
}

class IndexedDBPersistence {
  constructor(docName) {
    this.docName = docName;
    this.dbName = 'ydocs';
    this.storeName = 'updates';
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        this.db = req.result;
        resolve(true);
      };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
    });
  }

  async load() {
    return new Promise((resolve) => {
      const tx = this.db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.get(this.docName);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async save(update) {
    return new Promise((resolve) => {
      const tx = this.db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.put(update, this.docName);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  }
}

class YDocPersistence {
  constructor(docName) {
    this.docName = docName;
    this.provider = null;
    this.type = null;
  }

  async init() {
    if (await hasOPFS()) {
      const opfs = new OPFSPersistence(this.docName);
      if (await opfs.init()) {
        this.provider = opfs;
        this.type = 'opfs';
        return true;
      }
    }
    try {
      const idb = new IndexedDBPersistence(this.docName);
      await idb.init();
      this.provider = idb;
      this.type = 'indexeddb';
      return true;
    } catch {
      return false;
    }
  }

  async load() {
    return this.provider?.load();
  }

  async save(update) {
    return this.provider?.save(update);
  }

  bindDoc(ydoc) {
    const saveHandler = (update, origin) => {
      if (origin === 'storage') return;
      const fullState = Y.encodeStateAsUpdate(ydoc);
      this.save(fullState).catch(() => {});
    };
    ydoc.on('update', saveHandler);
    return () => ydoc.off('update', saveHandler);
  }
}

const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj))
const dec = (buf) => JSON.parse(new TextDecoder().decode(buf))

/**
 * Creates a Y.js document manager for a room
 * IMPORTANT: Now async - must await to ensure persistence loads first
 * @param {string} roomId
 * @param {import('libp2p').Libp2p} libp2p
 * @returns {Promise<Y.Doc & { manifest: Y.Map, chat: Y.Array, destroy: () => void, ready: boolean }>}
 */
export async function createYDoc(roomId, libp2p) {
  const ydoc = new Y.Doc()
  const topic = ROOM_TOPIC(roomId)

  // CRDT containers
  const manifest = ydoc.getMap('manifest')
  const chat = ydoc.getArray('chat')


  // Track sync state: 'loading' -> 'syncing' -> 'synced'
  let syncState = 'loading'

  // Initialize persistence FIRST (before any network activity)
  const persistence = new YDocPersistence(roomId)
  let persistenceUnbind = null

  try {
    await persistence.init()

    // Load existing state from storage
    const data = await persistence.load()
    if (data && data.length > 0) {
      Y.applyUpdate(ydoc, data, 'storage')
      const files = manifest.get('files') || []
      console.log(`[${roomId.slice(0, 6)}] Loaded ${files.length} files from local storage (${data.length} bytes)`)
    } else {
      console.log(`[${roomId.slice(0, 6)}] No local storage found, starting fresh`)
    }

    // Start auto-saving
    persistenceUnbind = persistence.bindDoc(ydoc)
  } catch (err) {
    console.warn('Persistence init failed:', err)
  }

  // Broadcast updates to gossipsub
  const updateHandler = (update, origin) => {
    if (origin === 'network' || origin === 'storage') return
    console.log(`[${roomId.slice(0, 6)}] Broadcasting Y_UPDATE (${update.length} bytes)`)
    libp2p.services?.pubsub?.publish(topic, enc({
      type: 'Y_UPDATE',
      update: Array.from(update),
      roomId
    })).catch(() => {})
  }

  // Listen for remote updates
  const messageHandler = (evt) => {
    if (evt.detail.topic !== topic) return
    try {
      const msg = dec(evt.detail.data)

      if (msg.type === 'Y_UPDATE') {
        // Real-time incremental update (efficient)
        console.log(`[${roomId.slice(0, 6)}] Received Y_UPDATE (${msg.update.length} bytes)`)
        Y.applyUpdate(ydoc, new Uint8Array(msg.update), 'network')
        const files = manifest.get('files') || []
        console.log(`[${roomId.slice(0, 6)}] After Y_UPDATE: ${files.length} files:`, files.map(f => f.name))
      }
      else if (msg.type === 'SNAPSHOT_REQUEST') {
        // Peer wants full state (new joiner or reconnect)
        const fullState = Y.encodeStateAsUpdate(ydoc)
        const files = manifest.get('files') || []
        console.log(`[${roomId.slice(0, 6)}] SNAPSHOT_REQUEST -> sending full state: ${fullState.length} bytes, ${files.length} files`)
        libp2p.services?.pubsub?.publish(topic, enc({
          type: 'SNAPSHOT',
          update: Array.from(fullState),
          roomId
        })).catch(() => {})
      }
      else if (msg.type === 'SNAPSHOT') {
        // Full state from peer (initial sync or refresh catch-up)
        console.log(`[${roomId.slice(0, 6)}] Received SNAPSHOT (${msg.update.length} bytes)`)
        Y.applyUpdate(ydoc, new Uint8Array(msg.update), 'network')
        syncState = 'synced'
        const files = manifest.get('files') || []
        console.log(`[${roomId.slice(0, 6)}] After SNAPSHOT: ${files.length} files`, files.map(f => f.name))

        // Send our state back to ensure bidirectional sync
        const ourState = Y.encodeStateAsUpdate(ydoc)
        console.log(`[${roomId.slice(0, 6)}] Sending our state back (${ourState.length} bytes)`)
        libp2p.services?.pubsub?.publish(topic, enc({
          type: 'Y_UPDATE',
          update: Array.from(ourState),
          roomId
        })).catch(() => {})
      }
    } catch (err) {
      console.warn(`[${roomId.slice(0, 6)}] Failed to handle message:`, err)
    }
  }

  // Subscribe to topic
  try {
    libp2p.services?.pubsub?.subscribe(topic)
    libp2p.services?.pubsub?.addEventListener('message', messageHandler)
  } catch (err) {
    console.warn('Failed to subscribe:', err)
  }

  ydoc.on('update', updateHandler)

  // Request initial snapshot - always request to ensure bidirectional sync
  const requestSnapshot = () => {
    const files = manifest.get('files') || []
    console.log(`[${roomId.slice(0, 6)}] Requesting SNAPSHOT (currently have ${files.length} files)`)
    syncState = 'syncing'
    libp2p.services?.pubsub?.publish(topic, enc({
      type: 'SNAPSHOT_REQUEST',
      roomId
    })).catch(() => {})
  }

  // Request snapshot after delay (let peers connect)
  setTimeout(requestSnapshot, 1000)

  // Retry snapshot requests periodically until we get one
  const syncInterval = setInterval(() => {
    if (syncState !== 'synced') {
      console.log(`[${roomId.slice(0, 6)}] Still not synced (${syncState}), retrying SNAPSHOT_REQUEST...`)
      requestSnapshot()
    }
  }, 5000)

  // Cleanup
  const destroy = () => {
    clearInterval(syncInterval)
    ydoc.off('update', updateHandler)
    if (persistenceUnbind) persistenceUnbind()
    try {
      libp2p.services?.pubsub?.removeEventListener('message', messageHandler)
      libp2p.services?.pubsub?.unsubscribe(topic)
    } catch {}
    ydoc.destroy()
  }

  return Object.assign(ydoc, { manifest, chat, destroy, ready: true })
}

/**
 * Helper to convert manifest Y.Map to plain object
 * @param {Y.Map} manifestMap
 */
export function manifestToJSON(manifestMap) {
  const files = manifestMap.get('files') || []
  return {
    files: files.map(f => ({
      name: f.name,
      size: f.size,
      cid: f.cid
    })),
    updatedAt: manifestMap.get('updatedAt') || Date.now()
  }
}

/**
 * Helper to update manifest Y.Map from plain object
 * @param {Y.Map} manifestMap
 * @param {any} manifest
 */
export function updateManifest(manifestMap, manifest) {
  manifestMap.set('files', manifest.files || [])
  manifestMap.set('updatedAt', manifest.updatedAt || Date.now())
}

/**
 * Helper to add chat message to Y.Array
 * @param {Y.Array} chatArray
 * @param {any} message
 */
export function addChatMsg(chatArray, message) {
  chatArray.push([message])
}

/**
 * Helper to get all chat messages from Y.Array
 * @param {Y.Array} chatArray
 */
export function getChatMessages(chatArray) {
  return chatArray.toArray()
}
