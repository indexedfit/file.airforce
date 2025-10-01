// @ts-check
import { createYDoc, updateManifest, addChatMsg } from './ydoc.js'
import { ROOM_TOPIC } from './constants.js'

/**
 * Simplified room manager using Y.js for state sync
 * Y.js handles all manifest + chat synchronization via CRDTs
 * This file only handles lightweight file request signaling
 */

const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj))
const dec = (buf) => JSON.parse(new TextDecoder().decode(buf))

/**
 * @typedef {Object} FileEntry
 * @property {string} name
 * @property {number=} size
 * @property {string} cid
 */

export function createRoomManager(helia, fs) {
  const libp2p = helia?.libp2p

  // roomId -> Y.Doc (or Promise<Y.Doc>)
  const ydocs = new Map()

  // roomId -> Set<fn> for custom message handlers (file requests, etc)
  const handlers = new Map()

  // Track which rooms we've joined to prevent duplicate joins
  const joinedRooms = new Set()

  /**
   * Get or create Y.Doc for a room
   * Returns a promise that resolves to the Y.Doc
   */
  async function getYDoc(roomId) {
    if (!ydocs.has(roomId)) {
      const ydocPromise = createYDoc(roomId, libp2p)
      ydocs.set(roomId, ydocPromise)
      const ydoc = await ydocPromise
      ydocs.set(roomId, ydoc) // Replace promise with actual doc
      return ydoc
    }
    const existing = ydocs.get(roomId)
    // Handle case where it's still a promise
    if (existing instanceof Promise) {
      return await existing
    }
    return existing
  }

  /**
   * Subscribe to non-CRDT messages (file requests, etc)
   */
  function subscribe(roomId, handler) {
    const topic = ROOM_TOPIC(roomId)

    let set = handlers.get(roomId)
    if (!set) {
      set = new Set()
      handlers.set(roomId, set)
    }
    set.add(handler)

    const messageHandler = (evt) => {
      if (evt.detail.topic !== topic) return
      try {
        const msg = dec(evt.detail.data)
        // Let Y.js messages be handled by ydoc
        if (msg.type?.startsWith('Y_') || msg.type?.startsWith('SYNC_')) return
        // Call custom handlers for everything else
        for (const fn of set) fn(msg)
      } catch {}
    }

    // Subscribe to topic if not already
    try {
      libp2p.services?.pubsub?.subscribe(topic)
      libp2p.services?.pubsub?.addEventListener('message', messageHandler)
    } catch {}

    return () => {
      set.delete(handler)
      if (set.size === 0) {
        handlers.delete(roomId)
        try {
          libp2p.services?.pubsub?.removeEventListener('message', messageHandler)
          libp2p.services?.pubsub?.unsubscribe(topic)
        } catch {}
      }
    }
  }

  /**
   * Simple publish helper
   */
  async function publish(roomId, msg) {
    const topic = ROOM_TOPIC(roomId)
    try {
      await libp2p.services?.pubsub?.publish(topic, enc({ ...msg, roomId }))
    } catch (err) {
      console.warn('Publish failed:', err)
    }
  }

  /**
   * Request files from peers (hint for bitswap)
   */
  async function requestFiles(roomId, fileCids) {
    await publish(roomId, {
      type: 'FILE_REQUEST',
      cids: fileCids,
      from: libp2p.peerId.toString()
    })
  }

  /**
   * Send chat message via Y.js
   */
  async function sendChat(roomId, text, msgId) {
    const ydoc = await getYDoc(roomId)
    const from = libp2p?.peerId?.toString?.() || 'anon'

    addChatMsg(ydoc.chat, {
      text,
      from,
      ts: Date.now(),
      msgId: msgId || crypto.randomUUID()
    })
  }

  /**
   * Update manifest via Y.js
   */
  async function setManifest(roomId, manifest) {
    const ydoc = await getYDoc(roomId)
    updateManifest(ydoc.manifest, manifest)
  }

  /**
   * Get current manifest from Y.js
   */
  async function getManifest(roomId) {
    const ydoc = await getYDoc(roomId)
    const files = ydoc.manifest.get('files') || []
    return {
      files: files.map(f => ({ ...f })),
      updatedAt: ydoc.manifest.get('updatedAt') || Date.now()
    }
  }

  /**
   * Unified join method - handles both host and joiner cases
   * @param {string} roomId
   * @param {Object=} options
   * @param {any=} options.manifest - Initial manifest (host only)
   * @param {Function=} options.onManifestUpdate - Callback when manifest changes
   * @param {Function=} options.onNewFiles - Callback when new files appear
   */
  async function join(roomId, options = {}) {
    const { manifest, onManifestUpdate, onNewFiles } = options
    const ydoc = await getYDoc(roomId)

    // If we've already joined, just return (but allow re-attaching observers)
    const alreadyJoined = joinedRooms.has(roomId)
    if (alreadyJoined) {
      console.log(`[Room ${roomId.slice(0,6)}] Already joined, re-attaching observers only`)
    } else {
      console.log(`[Room ${roomId.slice(0,6)}] Joining...`)
      joinedRooms.add(roomId)
    }

    // If we have a manifest, we're the host - set it (only on first join)
    if (manifest && !alreadyJoined) {
      console.log(`[Room ${roomId.slice(0,6)}] Setting initial manifest (${manifest.files.length} files)`)
      updateManifest(ydoc.manifest, manifest)
    }

    // Watch for manifest changes (can be attached multiple times if needed)
    if (onManifestUpdate) {
      const observer = () => {
        const files = ydoc.manifest.get('files') || []
        console.log(`[Room ${roomId.slice(0,6)}] Manifest changed: ${files.length} files`)
        onManifestUpdate({
          files: files.map(f => ({ ...f })),
          updatedAt: ydoc.manifest.get('updatedAt') || Date.now()
        })
      }
      ydoc.manifest.observe(observer)
      // Trigger initial callback if there's already data
      observer()
    }

    // Watch for new files (auto-pin)
    if (onNewFiles) {
      let prevFiles = new Set((ydoc.manifest.get('files') || []).map(f => f.cid))
      const observer = () => {
        const files = ydoc.manifest.get('files') || []
        const currentFiles = new Set(files.map(f => f.cid))
        const newCids = [...currentFiles].filter(cid => !prevFiles.has(cid))
        if (newCids.length > 0) {
          console.log(`[Room ${roomId.slice(0,6)}] New files detected: ${newCids.length}`)
          onNewFiles(newCids)
          prevFiles = currentFiles
        }
      }
      ydoc.manifest.observe(observer)
    }

    // Handle file requests (for all peers) - only on first join
    if (!alreadyJoined) {
      subscribe(roomId, async (msg) => {
        if (msg.type === 'FILE_REQUEST') {
          console.log(`[Room ${roomId.slice(0,6)}] File request for ${msg.cids?.length} CIDs`)
          for (const cid of msg.cids || []) {
            try {
              for await (const _ of helia.pin.add(cid)) {}
            } catch {}
          }
        }
      })
    }

    return ydoc
  }

  /**
   * Destroy a room's Y.Doc
   */
  function destroyRoom(roomId) {
    const ydoc = ydocs.get(roomId)
    if (ydoc && typeof ydoc.destroy === 'function') {
      ydoc.destroy()
    }
    ydocs.delete(roomId)
    handlers.delete(roomId)
    joinedRooms.delete(roomId)
  }

  return {
    getYDoc,
    subscribe,
    publish,
    requestFiles,
    sendChat,
    setManifest,
    getManifest,
    join,
    destroyRoom
  }
}
