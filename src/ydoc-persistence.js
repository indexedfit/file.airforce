// @ts-check
/**
 * Y.js persistence using OPFS (with IndexedDB fallback)
 * Stores Y.Doc updates in OPFS for fast, persistent storage
 * No dependency on y-indexeddb or y-* packages
 */

import * as Y from 'yjs';

/**
 * Check if OPFS is available
 */
async function hasOPFS() {
  try {
    return !!(navigator?.storage?.getDirectory);
  } catch {
    return false;
  }
}

/**
 * OPFS-based persistence
 */
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
    } catch (err) {
      console.warn('OPFS init failed:', err);
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
    } catch (err) {
      console.warn('OPFS save failed:', err);
      return false;
    }
  }

  async append(update) {
    try {
      // Load existing, merge using Y.js, save
      const existing = await this.load();
      let merged;
      if (existing && existing.length > 0) {
        merged = Y.mergeUpdates([existing, update]);
      } else {
        merged = update;
      }
      return await this.save(merged);
    } catch (err) {
      console.warn('OPFS append failed:', err);
      return false;
    }
  }
}

/**
 * IndexedDB-based persistence (fallback)
 */
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

  async append(update) {
    try {
      // Load existing, merge using Y.js, save
      const existing = await this.load();
      let merged;
      if (existing && existing.length > 0) {
        merged = Y.mergeUpdates([existing, update]);
      } else {
        merged = update;
      }
      return await this.save(merged);
    } catch (err) {
      console.warn('IndexedDB append failed:', err);
      return false;
    }
  }
}

/**
 * Unified persistence manager
 * Tries OPFS first, falls back to IndexedDB
 */
export class YDocPersistence {
  constructor(docName) {
    this.docName = docName;
    this.provider = null;
    this.type = null;
  }

  async init() {
    // Try OPFS first
    if (await hasOPFS()) {
      const opfs = new OPFSPersistence(this.docName);
      if (await opfs.init()) {
        this.provider = opfs;
        this.type = 'opfs';
        console.log(`📁 Y.js persistence: OPFS (${this.docName})`);
        return true;
      }
    }

    // Fall back to IndexedDB
    try {
      const idb = new IndexedDBPersistence(this.docName);
      await idb.init();
      this.provider = idb;
      this.type = 'indexeddb';
      console.log(`📁 Y.js persistence: IndexedDB (${this.docName})`);
      return true;
    } catch (err) {
      console.warn('No persistence available:', err);
      return false;
    }
  }

  async load() {
    return this.provider?.load();
  }

  async save(update) {
    return this.provider?.save(update);
  }

  async append(update) {
    return this.provider?.append(update);
  }

  /**
   * Bind to a Y.Doc to auto-persist updates
   * NOTE: Load should be done separately BEFORE calling this
   */
  bindDoc(ydoc) {
    // Save on every update - no debounce, just save the full state
    const saveHandler = (update, origin) => {
      // Don't persist updates we just loaded from storage
      if (origin === 'storage' || origin === 'network') return;

      // Save full state immediately (no debounce - we need this to persist on reload)
      const fullState = Y.encodeStateAsUpdate(ydoc);
      this.save(fullState).catch(err => {
        console.warn('Failed to persist Y.js update:', err);
      });
    };

    ydoc.on('update', saveHandler);

    return () => {
      ydoc.off('update', saveHandler);
    };
  }
}
