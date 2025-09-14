// Node runtime tracker
import { createHelia } from 'helia'
import { unixfs } from '@helia/unixfs'
import { createLibp2p } from 'libp2p'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { webSockets } from '@libp2p/websockets'
import { tcp } from '@libp2p/tcp'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { ROOM_TOPIC } from '../src/constants.js'

function dec(buf) { return JSON.parse(new TextDecoder().decode(buf)) }
function enc(obj) { return new TextEncoder().encode(JSON.stringify(obj)) }

async function main() {
  const libp2p = await createLibp2p({
    addresses: { listen: ['/ip4/0.0.0.0/tcp/9010/ws', '/ip4/0.0.0.0/tcp/9011'] },
    transports: [webSockets(), tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      relay: circuitRelayServer(),
      pubsub: gossipsub()
    }
  })
  const helia = await createHelia({ libp2p })
  const fs = unixfs(helia)

  console.log('[tracker] peerId', libp2p.peerId.toString())
  console.log('[tracker] addrs', libp2p.getMultiaddrs().map(a => a.toString()))

  const rooms = new Set()

  libp2p.services.pubsub.addEventListener('message', async (evt) => {
    const m = dec(evt.detail.data)
    if (!m?.type || !m?.roomId) return
    const topic = ROOM_TOPIC(m.roomId)
    if (!rooms.has(m.roomId)) {
      rooms.add(m.roomId)
      libp2p.services.pubsub.subscribe(topic)
      console.log('[tracker] observing room', m.roomId)
    }
    if (m.type === 'REQUEST' && Array.isArray(m.fileCids)) {
      console.log('[tracker] pin request', m.fileCids.length, 'cids')
      for (const cid of m.fileCids) {
        try {
          for await (const _ of helia.pin.add(cid)) {}
          console.log('[tracker] pinned', cid)
        } catch (err) {
          console.warn('[tracker] pin fail', cid, err?.message)
        }
      }
      await libp2p.services.pubsub.publish(topic, enc({ type: 'ACK', roomId: m.roomId, tracker: libp2p.peerId.toString() }))
    }
  })

  const wildcard = ROOM_TOPIC('*')
  libp2p.services.pubsub.subscribe(wildcard)
}

main().catch(console.error)

