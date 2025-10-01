// @ts-check
import * as Y from 'yjs'
import { ROOM_TOPIC } from './constants.js'
import { YDocPersistence } from './ydoc-persistence.js'

/**
 * Y.js document manager - handles CRDT sync over libp2p gossipsub
 * No y-webrtc or y-libp2p-connector - we use our existing libp2p mesh
 */

const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj))
const dec = (buf) => JSON.parse(new TextDecoder().decode(buf))

const DEBUG = true

function log(roomId, ...args) {
  if (DEBUG) console.log(`[Y.js ${roomId.slice(0, 6)}]`, ...args)
}

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

  log(roomId, 'Creating Y.Doc')

  // Initialize persistence FIRST (before any network activity)
  const persistence = new YDocPersistence(roomId)
  let persistenceUnbind = null

  try {
    await persistence.init()
    log(roomId, `Persistence ready (${persistence.type})`)

    // Load existing state from storage
    const data = await persistence.load()
    if (data && data.length > 0) {
      Y.applyUpdate(ydoc, data, 'storage')
      const files = manifest.get('files') || []
      const msgs = chat.length
      log(roomId, `Loaded state: ${files.length} files, ${msgs} chat messages`)
    } else {
      log(roomId, 'No persisted state found')
    }

    // Start auto-saving
    persistenceUnbind = persistence.bindDoc(ydoc)
  } catch (err) {
    console.warn('Persistence init failed:', err)
  }

  // Track sync state
  let synced = false
  let syncRequested = false

  // Broadcast updates to gossipsub
  const updateHandler = (update, origin) => {
    // Don't rebroadcast updates we received from the network
    if (origin === 'network' || origin === 'storage') return

    log(roomId, `Broadcasting update (${update.length} bytes)`)

    try {
      libp2p.services?.pubsub?.publish(topic, enc({
        type: 'Y_UPDATE',
        update: Array.from(update),
        roomId
      })).catch(err => {
        // Ignore "no peers" errors - normal when you're the only one in the room
        if (err.message?.includes('NoPeersSubscribedToTopic')) {
          log(roomId, 'No peers yet, update saved locally')
        } else {
          console.warn('Failed to publish Y.js update:', err)
        }
      })
    } catch (err) {
      // Synchronous errors
      if (err.message?.includes('NoPeersSubscribedToTopic')) {
        log(roomId, 'No peers yet, update saved locally')
      } else {
        console.warn('Failed to publish Y.js update:', err)
      }
    }
  }

  // Listen for remote updates
  const messageHandler = (evt) => {
    if (evt.detail.topic !== topic) return

    try {
      const msg = dec(evt.detail.data)

      if (msg.type === 'Y_UPDATE') {
        log(roomId, `Received Y_UPDATE (${msg.update.length} bytes)`)
        Y.applyUpdate(ydoc, new Uint8Array(msg.update), 'network')
        synced = true
      }
      else if (msg.type === 'SYNC_REQUEST') {
        log(roomId, 'Received SYNC_REQUEST, sending full state')
        const stateVector = new Uint8Array(msg.stateVector)
        const diff = Y.encodeStateAsUpdate(ydoc, stateVector)

        const files = manifest.get('files') || []
        log(roomId, `Responding with state: ${files.length} files, ${diff.length} bytes`)

        libp2p.services?.pubsub?.publish(topic, enc({
          type: 'SYNC_RESPONSE',
          update: Array.from(diff),
          roomId
        })).catch(err => {
          if (!err.message?.includes('NoPeersSubscribedToTopic')) {
            console.warn('Failed to send SYNC_RESPONSE:', err)
          }
        })
      }
      else if (msg.type === 'SYNC_RESPONSE') {
        log(roomId, `Received SYNC_RESPONSE (${msg.update.length} bytes)`)
        Y.applyUpdate(ydoc, new Uint8Array(msg.update), 'network')
        synced = true

        const files = manifest.get('files') || []
        const msgs = chat.length
        log(roomId, `After sync: ${files.length} files, ${msgs} chat messages`)
      }
    } catch (err) {
      console.warn('Failed to handle Y.js message:', err)
    }
  }

  // Subscribe to topic
  try {
    libp2p.services?.pubsub?.subscribe(topic)
    libp2p.services?.pubsub?.addEventListener('message', messageHandler)
    log(roomId, 'Subscribed to pubsub topic')
  } catch (err) {
    console.warn('Failed to subscribe to topic:', err)
  }

  // Start broadcasting local updates
  ydoc.on('update', updateHandler)

  // Request initial sync after a delay (allow time for peers to appear)
  setTimeout(() => {
    if (!synced && !syncRequested) {
      syncRequested = true
      try {
        const stateVector = Y.encodeStateVector(ydoc)
        log(roomId, 'Requesting sync from peers')
        libp2p.services?.pubsub?.publish(topic, enc({
          type: 'SYNC_REQUEST',
          stateVector: Array.from(stateVector),
          roomId
        })).catch(err => {
          if (!err.message?.includes('NoPeersSubscribedToTopic')) {
            console.warn('Failed to request sync:', err)
          }
        })
      } catch (err) {
        if (!err.message?.includes('NoPeersSubscribedToTopic')) {
          console.warn('Failed to request sync:', err)
        }
      }
    }
  }, 1000)

  // Periodic sync requests if not synced (for late joiners)
  const syncInterval = setInterval(() => {
    const files = manifest.get('files') || []
    if (!synced && files.length === 0) {
      try {
        const stateVector = Y.encodeStateVector(ydoc)
        log(roomId, 'Retrying sync request')
        libp2p.services?.pubsub?.publish(topic, enc({
          type: 'SYNC_REQUEST',
          stateVector: Array.from(stateVector),
          roomId
        })).catch(() => {}) // Silently fail for retries
      } catch {}
    }
  }, 3000)

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
    log(roomId, 'Destroyed')
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
