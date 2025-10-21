// @ts-check
import { createYDoc, updateManifest, addChatMsg, getChatMessages } from './ydoc.js'
import { ROOM_TOPIC } from './constants.js'

/**
 * Simplified room manager using Y.js for state sync
 * Y.js handles all manifest + chat synchronization via CRDTs
 */

const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj))
const dec = (buf) => JSON.parse(new TextDecoder().decode(buf))

export function createRoomManager(helia, fs) {
  const libp2p = helia?.libp2p

  const ydocs = new Map()
  const handlers = new Map()
  const joinedRooms = new Set()
  const observerCleanups = new Map()

  async function getYDoc(roomId) {
    if (!ydocs.has(roomId)) {
      const ydocPromise = createYDoc(roomId, libp2p)
      ydocs.set(roomId, ydocPromise)
      const ydoc = await ydocPromise
      ydocs.set(roomId, ydoc)
      return ydoc
    }
    const existing = ydocs.get(roomId)
    if (existing instanceof Promise) return await existing
    return existing
  }

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
        if (msg.type?.startsWith('Y_') || msg.type?.startsWith('SYNC_')) return
        for (const fn of set) fn(msg)
      } catch {}
    }

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

  async function publish(roomId, msg) {
    const topic = ROOM_TOPIC(roomId)
    try {
      await libp2p.services?.pubsub?.publish(topic, enc({ ...msg, roomId }))
    } catch (err) {
      console.warn('Publish failed:', err)
    }
  }

  async function sendChat(roomId, text) {
    const ydoc = await getYDoc(roomId)
    const from = libp2p?.peerId?.toString?.() || 'anon'
    addChatMsg(ydoc.chat, {
      text,
      from,
      ts: Date.now(),
      msgId: crypto.randomUUID()
    })
  }

  async function setManifest(roomId, manifest) {
    const ydoc = await getYDoc(roomId)
    updateManifest(ydoc.manifest, manifest)
  }

  async function getManifest(roomId) {
    const ydoc = await getYDoc(roomId)
    const files = ydoc.manifest.get('files') || []
    return {
      files: files.map(f => ({ ...f })),
      updatedAt: ydoc.manifest.get('updatedAt') || Date.now()
    }
  }

  async function join(roomId, options = {}) {
    const { isHost } = options
    const ydoc = await getYDoc(roomId)

    if (observerCleanups.has(roomId)) {
      const cleanups = observerCleanups.get(roomId)
      cleanups.forEach(fn => fn())
      observerCleanups.delete(roomId)
    }

    const alreadyJoined = joinedRooms.has(roomId)
    if (!alreadyJoined) {
      joinedRooms.add(roomId)
    }

    return ydoc
  }

  async function onManifest(roomId, callback) {
    const ydoc = await getYDoc(roomId)
    const observer = () => {
      const files = ydoc.manifest.get('files') || []
      callback({
        files: files.map(f => ({ ...f })),
        updatedAt: ydoc.manifest.get('updatedAt') || Date.now()
      })
    }
    ydoc.manifest.observe(observer)
    observer() // Trigger initial
    return () => ydoc.manifest.unobserve(observer)
  }

  async function onChat(roomId, callback) {
    const ydoc = await getYDoc(roomId)
    const observer = () => {
      const messages = getChatMessages(ydoc.chat)
      callback(messages)
    }
    ydoc.chat.observe(observer)
    observer() // Trigger initial
    return () => ydoc.chat.unobserve(observer)
  }

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
    sendChat,
    setManifest,
    getManifest,
    join,
    onManifest,
    onChat,
    destroyRoom
  }
}
