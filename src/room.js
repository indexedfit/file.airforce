import { ROOM_TOPIC } from './constants.js'
import { updateRoomLastSeen } from './store.js'

function enc(obj) { return new TextEncoder().encode(JSON.stringify(obj)) }
function dec(buf) { return JSON.parse(new TextDecoder().decode(buf)) }

export function createRoomManager(helia, fs) {
  const { libp2p } = helia
  const subs = new Map()

  async function publish(roomId, msg) {
    await libp2p.services.pubsub.publish(ROOM_TOPIC(roomId), enc(msg))
  }

  function subscribe(roomId, onMessage) {
    const topic = ROOM_TOPIC(roomId)
    const handler = (evt) => {
      if (evt.detail.topic !== topic) return
      try {
        const m = dec(evt.detail.data)
        onMessage(m, evt.detail)
      } catch {}
    }
    libp2p.services.pubsub.subscribe(topic)
    libp2p.services.pubsub.addEventListener('message', handler)
    subs.set(roomId, handler)
  }

  function unsubscribe(roomId) {
    const topic = ROOM_TOPIC(roomId)
    const handler = subs.get(roomId)
    if (handler) {
      libp2p.services.pubsub.removeEventListener('message', handler)
      libp2p.services.pubsub.unsubscribe(topic)
      subs.delete(roomId)
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
      }
    })
  }

  function attachJoin(roomId, onManifest) {
    subscribe(roomId, async (msg) => {
      updateRoomLastSeen(roomId)
      if (msg.type === 'MANIFEST' && msg.manifest) {
        onManifest(msg.manifest)
      }
    })
    sendHello(roomId).catch(() => {})
  }

  return {
    publish, subscribe, unsubscribe,
    sendHello, sendManifest, requestFiles, sendAck,
    attachHost, attachJoin
  }
}

