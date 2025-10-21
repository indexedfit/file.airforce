// @ts-check
import * as Y from 'yjs'
import { ROOM_TOPIC } from './constants.js'
import { supportsOPFS } from './opfs-utils.js'

// ===== Persistence (OPFS + IndexedDB fallback) =====

class OPFSPersistence {
  constructor(docName) {
    this.docName = docName
    this.dir = null
    this.file = null
  }

  async init() {
    try {
      const root = await navigator.storage.getDirectory()
      this.dir = await root.getDirectoryHandle('ydocs', { create: true })
      this.file = await this.dir.getFileHandle(`${this.docName}.yjs`, { create: true })
      return true
    } catch {
      return false
    }
  }

  async load() {
    try {
      const handle = await this.dir.getFileHandle(`${this.docName}.yjs`)
      const file = await handle.getFile()
      const buffer = await file.arrayBuffer()
      return new Uint8Array(buffer)
    } catch {
      return null
    }
  }

  async save(update) {
    try {
      const writable = await this.file.createWritable()
      await writable.write(update)
      await writable.close()
      return true
    } catch {
      return false
    }
  }
}

class IndexedDBPersistence {
  constructor(docName) {
    this.docName = docName
    this.dbName = 'ydocs'
    this.storeName = 'updates'
    this.db = null
  }

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1)
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        this.db = req.result
        resolve(true)
      }
      req.onupgradeneeded = (e) => {
        const db = e.target.result
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName)
        }
      }
    })
  }

  async load() {
    return new Promise((resolve) => {
      const tx = this.db.transaction(this.storeName, 'readonly')
      const store = tx.objectStore(this.storeName)
      const req = store.get(this.docName)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => resolve(null)
    })
  }

  async save(update) {
    return new Promise((resolve) => {
      const tx = this.db.transaction(this.storeName, 'readwrite')
      const store = tx.objectStore(this.storeName)
      const req = store.put(update, this.docName)
      req.onsuccess = () => resolve(true)
      req.onerror = () => resolve(false)
    })
  }
}

class YDocPersistence {
  constructor(docName) {
    this.docName = docName
    this.provider = null
    this.type = null
  }

  async init() {
    if (supportsOPFS()) {
      const opfs = new OPFSPersistence(this.docName)
      if (await opfs.init()) {
        this.provider = opfs
        this.type = 'opfs'
        return true
      }
    }
    try {
      const idb = new IndexedDBPersistence(this.docName)
      await idb.init()
      this.provider = idb
      this.type = 'indexeddb'
      return true
    } catch {
      return false
    }
  }

  async load() {
    return this.provider?.load()
  }

  async save(update) {
    return this.provider?.save(update)
  }

  bindDoc(ydoc) {
    const saveHandler = (update, origin) => {
      if (origin === 'storage') return
      const fullState = Y.encodeStateAsUpdate(ydoc)
      this.save(fullState).catch(() => {})
    }
    ydoc.on('update', saveHandler)
    return () => ydoc.off('update', saveHandler)
  }
}

const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj))
const dec = (buf) => JSON.parse(new TextDecoder().decode(buf))

/**
 * Creates Y.js document for a room with gossipsub sync
 */
export async function createYDoc(roomId, libp2p) {
  const ydoc = new Y.Doc()
  const topic = ROOM_TOPIC(roomId)
  const manifest = ydoc.getMap('manifest')
  const chat = ydoc.getArray('chat')

  let synced = false

  // ===== PERSISTENCE (loads first) =====
  const persistence = new YDocPersistence(roomId)
  let persistenceUnbind = null

  try {
    await persistence.init()
    const data = await persistence.load()
    if (data && data.length > 0) {
      Y.applyUpdate(ydoc, data, 'storage')
      const files = manifest.get('files') || []
      console.log(`[${roomId.slice(0, 6)}] Loaded ${files.length} files from storage`)
    }
    persistenceUnbind = persistence.bindDoc(ydoc)
  } catch (err) {
    console.warn('Persistence init failed:', err)
  }

  // ===== GOSSIPSUB SYNC =====
  // Broadcast local updates
  const updateHandler = (update, origin) => {
    if (origin === 'network' || origin === 'storage') return

    libp2p.services?.pubsub?.publish(topic, enc({
      type: 'Y_UPDATE',
      update: Array.from(update),
      roomId
    })).catch(() => {})
  }

  // Receive remote updates
  const messageHandler = (evt) => {
    if (evt.detail.topic !== topic) return
    try {
      const msg = dec(evt.detail.data)

      if (msg.type === 'Y_UPDATE' && msg.update) {
        Y.applyUpdate(ydoc, new Uint8Array(msg.update), 'network')
        if (!synced) synced = true
      }
      else if (msg.type === 'SNAPSHOT' && msg.update) {
        Y.applyUpdate(ydoc, new Uint8Array(msg.update), 'network')
        synced = true
        const files = manifest.get('files') || []
        console.log(`[${roomId.slice(0, 6)}] SNAPSHOT: ${files.length} files`)
      }
      else if (msg.type === 'SNAPSHOT_REQUEST') {
        const fullState = Y.encodeStateAsUpdate(ydoc)
        libp2p.services?.pubsub?.publish(topic, enc({
          type: 'SNAPSHOT',
          update: Array.from(fullState),
          roomId
        })).catch(() => {})
      }
    } catch (err) {
      console.warn(`[${roomId.slice(0, 6)}] Message error:`, err)
    }
  }

  // Subscribe to topic
  try {
    libp2p.services?.pubsub?.subscribe(topic)
    libp2p.services?.pubsub?.addEventListener('message', messageHandler)
  } catch (err) {
    console.warn('Subscribe failed:', err)
  }

  // Notify hubs when connected (event-driven, no retries needed)
  let hubsNotified = new Set()

  const notifyHub = async (hubPeerId) => {
    if (hubsNotified.has(hubPeerId.toString())) return

    try {
      const stream = await libp2p.dialProtocol(hubPeerId, '/room-notify/1.0.0', {
        signal: AbortSignal.timeout(5000)
      })

      await stream.sink([enc({ roomId })])
      await stream.close()

      console.log(`[${roomId.slice(0, 6)}] ✓ Notified hub`)
      hubsNotified.add(hubPeerId.toString())

      // Send SNAPSHOT after gossipsub mesh forms
      setTimeout(() => {
        const fullState = Y.encodeStateAsUpdate(ydoc)
        const files = manifest.get('files') || []
        libp2p.services?.pubsub?.publish(topic, enc({
          type: 'SNAPSHOT',
          update: Array.from(fullState),
          roomId
        })).catch(() => {})
        console.log(`[${roomId.slice(0, 6)}] Sent SNAPSHOT (${files.length} files)`)
      }, 3000)
    } catch (err) {
      console.log(`[${roomId.slice(0, 6)}] Hub notify failed: ${err.message}`)
    }
  }

  // Notify hubs on peer:connect events
  const hubConnectHandler = async (evt) => {
    const { TRACKERS } = await import('./constants.js')
    const remotePeer = evt.detail.toString()

    // Check if this peer is a hub
    const isHub = TRACKERS.some(addr => addr.includes(remotePeer))
    if (isHub) {
      notifyHub(evt.detail)
    }
  }

  libp2p.addEventListener('peer:connect', hubConnectHandler)

  // Notify already-connected hubs immediately
  ;(async () => {
    const { TRACKERS } = await import('./constants.js')
    const { peerIdFromString } = await import('@libp2p/peer-id')

    for (const multiaddr of TRACKERS) {
      try {
        const parts = multiaddr.split('/p2p/')
        if (parts.length < 2) continue

        const hubPeerIdStr = parts[parts.length - 1]
        const hubPeerId = peerIdFromString(hubPeerIdStr)

        // Check if already connected
        const conns = libp2p.getConnections(hubPeerId)
        if (conns.length > 0) {
          notifyHub(hubPeerId)
        }
      } catch {}
    }
  })()

  ydoc.on('update', updateHandler)

  // Request snapshot after delay
  const requestSnapshot = () => {
    const peers = libp2p.services?.pubsub?.getSubscribers(topic) || []
    if (peers.length === 0) return

    libp2p.services?.pubsub?.publish(topic, enc({
      type: 'SNAPSHOT_REQUEST',
      roomId
    })).catch(() => {})
  }

  setTimeout(requestSnapshot, 3000)

  // Retry until synced
  const syncInterval = setInterval(() => {
    if (synced) {
      clearInterval(syncInterval)
      return
    }
    const peers = libp2p.services?.pubsub?.getSubscribers(topic) || []
    if (peers.length > 0) {
      requestSnapshot()
    }
  }, 5000)

  // Cleanup
  const destroy = () => {
    clearInterval(syncInterval)
    libp2p.removeEventListener('peer:connect', hubConnectHandler)
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
 * Update manifest Y.Map from plain object
 */
export function updateManifest(manifestMap, manifest) {
  manifestMap.set('files', manifest.files || [])
  manifestMap.set('updatedAt', manifest.updatedAt || Date.now())
}

/**
 * Add chat message to Y.Array
 */
export function addChatMsg(chatArray, message) {
  chatArray.push([message])
}

/**
 * Get all chat messages from Y.Array
 */
export function getChatMessages(chatArray) {
  return chatArray.toArray()
}
