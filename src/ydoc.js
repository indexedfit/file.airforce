// @ts-check
import * as Y from 'yjs'
import { pushable } from 'it-pushable'
import { pipe } from 'it-pipe'
import { ROOM_TOPIC } from './constants.js'

/**
 * Y.js document manager - handles CRDT sync over libp2p gossipsub
 *
 * SYNC PROTOCOL (over pubsub topic wc/<roomId>):
 *
 * 1. Y_UPDATE: Incremental CRDT updates (efficient, real-time)
 *    - Broadcast when local doc changes
 *    - Applied to remote doc on receive
 *    - Marks peer as synced (prevents infinite retries)
 *
 * 2. SNAPSHOT_REQUEST: Request full state from peers
 *    - Sent after 1s delay on join (allows peer connections)
 *    - Retried every 5s until synced
 *
 * 3. SNAPSHOT: Full CRDT state response
 *    - Sent when receiving SNAPSHOT_REQUEST
 *    - Marks peer as synced
 *    - Responder sends their state back (bidirectional sync)
 *
 * SYNC STATE MACHINE:
 * - loading → syncing → synced
 * - Only Y_UPDATE or SNAPSHOT mark as synced
 * - Prevents retry loop when peers exchange updates
 *
 * PERSISTENCE:
 * - Loads from OPFS/IndexedDB BEFORE network activity (prevents race conditions)
 * - Auto-saves full state on every Y.js update
 */

import { supportsOPFS } from './opfs-utils.js'

// ===== Persistence (OPFS + IndexedDB fallback) =====

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
    if (supportsOPFS()) {
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
  // IMPORTANT: Only mark as 'synced' when receiving Y_UPDATE or SNAPSHOT
  // This prevents infinite SNAPSHOT_REQUEST retry loops
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

  // ===== HUB STREAM PROVIDER (Primary sync method) =====
  let hubOutgoing = null
  let hubConnected = false

  async function connectToHub() {
    try {
      // Try to find hub peer in connected peers (from TRACKERS)
      const peers = libp2p.getPeers()
      if (peers.length === 0) {
        console.log(`[${roomId.slice(0, 6)}] No peers connected, skipping hub stream`)
        return false
      }

      // Try dialing the first connected peer that supports the protocol
      const Y_SYNC_PROTOCOL = '/y-sync/1.0.0'

      for (const peerId of peers) {
        try {
          console.log(`[${roomId.slice(0, 6)}] Attempting hub stream to peer ${peerId.toString().slice(-16)}...`)
          const stream = await libp2p.dialProtocol(peerId, Y_SYNC_PROTOCOL, { signal: AbortSignal.timeout(5000) })

          // Create outgoing pushable
          const outgoing = pushable({ objectMode: false })
          hubOutgoing = outgoing

          // Pipe outgoing to stream sink
          pipe(outgoing, stream.sink)

          // Send JOIN_ROOM message
          outgoing.push(enc({ type: 'JOIN_ROOM', roomId }))

          hubConnected = true
          console.log(`[${roomId.slice(0, 6)}] Hub stream established with ${peerId.toString().slice(-16)}`)

          // Listen for messages from hub
          ;(async () => {
            try {
              for await (const chunk of stream.source) {
                const msg = dec(chunk.subarray())

                if (msg.type === 'SYNC_FULL_STATE' && msg.update) {
                  console.log(`[${roomId.slice(0, 6)}] Received SYNC_FULL_STATE from hub (${msg.update.length} bytes)`)
                  Y.applyUpdate(ydoc, new Uint8Array(msg.update), 'hub-stream')
                  syncState = 'synced'
                  const files = manifest.get('files') || []
                  console.log(`[${roomId.slice(0, 6)}] After hub sync: ${files.length} files`, files.map(f => f.name))
                }
                else if (msg.type === 'Y_UPDATE' && msg.update) {
                  console.log(`[${roomId.slice(0, 6)}] Received Y_UPDATE from hub (${msg.update.length} bytes)`)
                  Y.applyUpdate(ydoc, new Uint8Array(msg.update), 'hub-stream')
                  if (syncState !== 'synced') {
                    syncState = 'synced'
                  }
                }
              }
            } catch (err) {
              console.warn(`[${roomId.slice(0, 6)}] Hub stream closed:`, err.message)
            } finally {
              hubConnected = false
              hubOutgoing = null
              console.log(`[${roomId.slice(0, 6)}] Hub stream disconnected, falling back to gossipsub`)
            }
          })()

          return true
        } catch (err) {
          // This peer doesn't support the protocol, try next
          continue
        }
      }

      console.log(`[${roomId.slice(0, 6)}] No hub peers found with ${Y_SYNC_PROTOCOL}`)
      return false
    } catch (err) {
      console.warn(`[${roomId.slice(0, 6)}] Hub connection failed:`, err.message)
      return false
    }
  }

  // Try connecting to hub after a delay (let libp2p connect to bootstrap peers first)
  setTimeout(() => connectToHub(), 1000)

  // Broadcast updates to both hub stream and gossipsub
  const updateHandler = (update, origin) => {
    if (origin === 'network' || origin === 'storage' || origin === 'hub-stream') return

    // Send to hub stream if connected
    if (hubConnected && hubOutgoing) {
      try {
        hubOutgoing.push(enc({
          type: 'Y_UPDATE',
          update: Array.from(update),
          roomId
        }))
      } catch (err) {
        console.warn(`[${roomId.slice(0, 6)}] Hub stream send failed:`, err.message)
        hubConnected = false
        hubOutgoing = null
      }
    }

    // Always also broadcast to gossipsub (fallback + P2P mesh)
    const peers = libp2p.services?.pubsub?.getSubscribers(topic) || []
    console.log(`[${roomId.slice(0, 6)}] Broadcasting Y_UPDATE (${update.length} bytes) to hub:${hubConnected} + ${peers.length} gossipsub peers`)
    libp2p.services?.pubsub?.publish(topic, enc({
      type: 'Y_UPDATE',
      update: Array.from(update),
      roomId
    })).catch((err) => {
      // Ignore expected "no peers" errors during mesh formation
      if (!err.message?.includes('NoPeersSubscribedToTopic')) {
        console.warn(`[${roomId.slice(0, 6)}] Y_UPDATE publish failed:`, err)
      }
    })
  }

  // Listen for remote updates
  const messageHandler = (evt) => {
    if (evt.detail.topic !== topic) return
    try {
      const msg = dec(evt.detail.data)

      if (msg.type === 'Y_UPDATE') {
        // Real-time incremental update (efficient)
        const beforeFiles = (manifest.get('files') || []).length
        console.log(`[${roomId.slice(0, 6)}] Received Y_UPDATE (${msg.update.length} bytes) from peer`)
        Y.applyUpdate(ydoc, new Uint8Array(msg.update), 'network')
        const files = manifest.get('files') || []
        console.log(`[${roomId.slice(0, 6)}] After Y_UPDATE: ${beforeFiles} -> ${files.length} files`, files.map(f => f.name))

        // CRITICAL: Mark as synced when receiving Y_UPDATE from a peer
        // This prevents both peers from being stuck in "syncing" state
        // and endlessly retrying SNAPSHOT_REQUEST every 5s
        if (syncState !== 'synced' && msg.update.length > 0) {
          console.log(`[${roomId.slice(0, 6)}] Marking as synced after receiving Y_UPDATE`)
          syncState = 'synced'
        }
      }
      else if (msg.type === 'SNAPSHOT_REQUEST') {
        // Peer wants full state (new joiner or reconnect)
        const fullState = Y.encodeStateAsUpdate(ydoc)
        const files = manifest.get('files') || []
        const peers = libp2p.services?.pubsub?.getSubscribers(topic) || []
        console.log(`[${roomId.slice(0, 6)}] SNAPSHOT_REQUEST received -> sending ${fullState.length} bytes, ${files.length} files to ${peers.length} peers`)
        libp2p.services?.pubsub?.publish(topic, enc({
          type: 'SNAPSHOT',
          update: Array.from(fullState),
          roomId
        })).catch((err) => {
          if (!err.message?.includes('NoPeersSubscribedToTopic')) {
            console.warn(`[${roomId.slice(0, 6)}] SNAPSHOT publish failed:`, err)
          }
        })
      }
      else if (msg.type === 'SNAPSHOT') {
        // Full state from peer (initial sync or refresh catch-up)
        console.log(`[${roomId.slice(0, 6)}] Received SNAPSHOT (${msg.update.length} bytes)`)
        Y.applyUpdate(ydoc, new Uint8Array(msg.update), 'network')
        syncState = 'synced'
        const files = manifest.get('files') || []
        console.log(`[${roomId.slice(0, 6)}] After SNAPSHOT: ${files.length} files`, files.map(f => f.name))

        // Bidirectional sync: Send our state back to the responder
        // This ensures both peers have each other's state
        // Responder might have requested our snapshot while we requested theirs
        const ourState = Y.encodeStateAsUpdate(ydoc)
        console.log(`[${roomId.slice(0, 6)}] Sending our state back (${ourState.length} bytes)`)
        libp2p.services?.pubsub?.publish(topic, enc({
          type: 'Y_UPDATE',
          update: Array.from(ourState),
          roomId
        })).catch((err) => {
          if (!err.message?.includes('NoPeersSubscribedToTopic')) {
            console.warn(`[${roomId.slice(0, 6)}] Bidirectional Y_UPDATE failed:`, err)
          }
        })
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

  // Track when we started trying to sync (for timeout)
  const syncStartTime = Date.now()
  const MESH_TIMEOUT_MS = 10000 // 10s timeout for mesh formation

  // Request initial snapshot - always request to ensure bidirectional sync
  const requestSnapshot = () => {
    const files = manifest.get('files') || []
    const peers = libp2p.services?.pubsub?.getSubscribers(topic) || []
    const allPeers = libp2p.getPeers()?.length || 0
    const waitingTime = Date.now() - syncStartTime

    // Don't spam publish if no peers subscribed yet (gossipsub mesh not formed)
    // BUT: After timeout, try anyway (mesh check might be wrong, or relay issues)
    if (peers.length === 0 && allPeers > 0 && waitingTime < MESH_TIMEOUT_MS) {
      console.log(`[${roomId.slice(0, 6)}] Waiting for gossipsub mesh (${allPeers} peers connected, 0 subscribed to topic)`)
      return
    }

    // If we hit timeout, warn user but try publishing anyway
    if (peers.length === 0 && allPeers > 0 && waitingTime >= MESH_TIMEOUT_MS) {
      console.warn(`[${roomId.slice(0, 6)}] Gossipsub mesh timeout (${waitingTime}ms) - attempting publish anyway`)
    }

    console.log(`[${roomId.slice(0, 6)}] Requesting SNAPSHOT (have ${files.length} files, ${peers.length} room peers, ${allPeers} total peers)`)
    syncState = 'syncing'
    libp2p.services?.pubsub?.publish(topic, enc({
      type: 'SNAPSHOT_REQUEST',
      roomId
    })).catch((err) => {
      // Only warn if it's not the expected "no peers" error
      if (!err.message?.includes('NoPeersSubscribedToTopic')) {
        console.warn(`[${roomId.slice(0, 6)}] SNAPSHOT_REQUEST publish failed:`, err)
      }
    })
  }

  // Request snapshot after delay (let gossipsub mesh form - heartbeat is ~1s)
  // Initial delay of 2s gives gossipsub time for at least 1-2 heartbeats
  setTimeout(requestSnapshot, 2000)

  // Retry snapshot requests periodically until synced
  // Stops when syncState becomes 'synced' (after receiving Y_UPDATE or SNAPSHOT)
  // Without marking Y_UPDATE as synced, both peers would retry forever
  // Shorter interval (2s) since we now skip publish when mesh not ready
  const syncInterval = setInterval(() => {
    if (syncState !== 'synced') {
      const files = manifest.get('files') || []
      const peers = libp2p.services?.pubsub?.getSubscribers(topic) || []
      if (peers.length > 0) {
        console.log(`[${roomId.slice(0, 6)}] Still not synced (${syncState}), have ${files.length} files, ${peers.length} room peers - retrying...`)
      }
      requestSnapshot()
    }
  }, 2000)

  // Cleanup
  const destroy = () => {
    clearInterval(syncInterval)
    ydoc.off('update', updateHandler)
    if (persistenceUnbind) persistenceUnbind()

    // Close hub stream
    if (hubOutgoing) {
      try {
        hubOutgoing.end()
      } catch {}
      hubOutgoing = null
      hubConnected = false
    }

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
