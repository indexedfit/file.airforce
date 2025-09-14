import { ROOM_TOPIC } from './constants.js'
import { saveRoom, updateRoomLastSeen } from './store.js'

function enc(obj) { return new TextEncoder().encode(JSON.stringify(obj)) }
function dec(buf) { return JSON.parse(new TextDecoder().decode(buf)) }

export function createRoomManager(helia, fs) {
  const libp2p = helia?.libp2p

  // Fallback pubsub for fake/dev mode (BroadcastChannel per topic)
  const bcMap = new Map() // topic -> BroadcastChannel

  // roomId -> { handler: fn, count: number }
  const topicHandlers = new Map()
  // roomId -> Set<fn>
  const subs = new Map()

  async function publish(roomId, msg) {
    const topic = ROOM_TOPIC(roomId)
    if (libp2p?.services?.pubsub) {
      await libp2p.services.pubsub.publish(topic, enc(msg))
    } else {
      let bc = bcMap.get(topic)
      if (!bc) { bc = new BroadcastChannel(topic); bcMap.set(topic, bc) }
      bc.postMessage(enc(msg))
    }
  }

  function ensureTopicListener(roomId) {
    if (topicHandlers.has(roomId)) return
    const topic = ROOM_TOPIC(roomId)
    if (libp2p?.services?.pubsub) {
      const handler = (evt) => {
        if (evt.detail.topic !== topic) return
        const fns = subs.get(roomId); if (!fns?.size) return
        try {
          const m = dec(evt.detail.data)
          for (const fn of fns) fn(m, evt.detail)
        } catch {}
      }
      libp2p.services.pubsub.subscribe(topic)
      libp2p.services.pubsub.addEventListener('message', handler)
      topicHandlers.set(roomId, { handler, count: 0 })
    } else {
      let bc = bcMap.get(topic)
      if (!bc) { bc = new BroadcastChannel(topic); bcMap.set(topic, bc) }
      const handler = (ev) => {
        const fns = subs.get(roomId); if (!fns?.size) return
        try {
          const m = dec(ev.data)
          for (const fn of fns) fn(m, { from: 'local' })
        } catch {}
      }
      bc.addEventListener('message', handler)
      topicHandlers.set(roomId, { handler, count: 0 })
    }
  }

  function subscribe(roomId, onMessage) {
    ensureTopicListener(roomId)
    let set = subs.get(roomId)
    if (!set) { set = new Set(); subs.set(roomId, set) }
    set.add(onMessage)
    const t = topicHandlers.get(roomId)
    if (t) t.count++
    return () => unsubscribe(roomId, onMessage)
  }

  function unsubscribe(roomId, fn) {
    const topic = ROOM_TOPIC(roomId)
    const set = subs.get(roomId)
    if (set) {
      if (fn) set.delete(fn); else set.clear()
      if (set.size === 0) {
        subs.delete(roomId)
        const th = topicHandlers.get(roomId)
        if (th) {
          if (libp2p?.services?.pubsub) {
            libp2p.services.pubsub.removeEventListener('message', th.handler)
            libp2p.services.pubsub.unsubscribe(topic)
          } else {
            const bc = bcMap.get(topic); bc?.removeEventListener('message', th.handler)
          }
          topicHandlers.delete(roomId)
        }
      }
    }
  }

  async function sendHello(roomId) {
    await publish(roomId, { type: 'HELLO', roomId, from: libp2p.peerId.toString() })
  }

  async function sendManifest(roomId, manifest) {
    await publish(roomId, { type: 'MANIFEST', roomId, manifest })
  }

  async function requestFiles(roomId, fileCids) {
    await publish(roomId, { type: 'REQUEST', roomId, fileCids, from: libp2p.peerId.toString() })
  }

  async function sendAck(roomId, info) {
    await publish(roomId, { type: 'ACK', roomId, info })
  }

  async function sendChat(roomId, text) {
    const from = libp2p?.peerId?.toString?.() || 'anon'
    await publish(roomId, { type: 'CHAT', roomId, text, from, ts: Date.now() })
  }

  function attachHost(room) {
    const { id: roomId, manifest } = room
    subscribe(roomId, async (msg) => {
      updateRoomLastSeen(roomId)
      switch (msg.type) {
        case 'HELLO':
          await sendManifest(roomId, manifest)
          break
        case 'REQUEST':
          for (const cidStr of msg.fileCids) {
            try { for await (const _ of helia.pin.add(cidStr)) {} } catch {}
          }
          await sendAck(roomId, { ok: true, pinned: msg.fileCids.length })
          break
        case 'MANIFEST':
          // peers may rehost and announce updates; persist
          if (msg.manifest) saveRoom({ id: roomId, manifest: msg.manifest })
          break
      }
    })
  }

  function attachJoin(roomId, onManifest) {
    subscribe(roomId, async (msg) => {
      updateRoomLastSeen(roomId)
      if (msg.type === 'MANIFEST' && msg.manifest) {
        // persist and bubble to UI
        saveRoom({ id: roomId, manifest: msg.manifest })
        onManifest(msg.manifest)
      }
    })
    sendHello(roomId).catch(() => {})
  }

  return {
    publish, subscribe, unsubscribe,
    sendHello, sendManifest, requestFiles, sendAck, sendChat,
    attachHost, attachJoin
  }
}
